// The rating engine. This is the whole of submetrics.py + engine.py's league maths,
// ported straight across - no spreadsheet formulas, no mirror rows, no column offsets.
//
// Two levels, same as before:
//   1. each COMPONENT is a weighted blend of named sub-metrics, weighted PER POSITION
//      (a rushing-efficiency stat is dead weight on a receiver, so it weighs 0 there)
//   2. the components are weighted against each other
//
// Everything a user can change lives in one `settings` object, so it saves, loads and
// exports as a single file.

export const DEFAULT_SETTINGS = (data) => ({
  league: 0,
  tilt: 0.5,          // 0 = pure value, 1 = trust the rating
  need: 8,            // draft-score bonus for a position you still need
  style: 50,          // 0 = safest floor, 100 = highest ceiling
  rookie: true,       // pay up for rookies you trust
  rookieMax: 10,
  styleBudget: 15,    // rating weight split between Floor and Ceiling
  posx: {},           // per-position thumb on the scale, defaults to 1
  comp: Object.fromEntries(data.components.map((c) => [c.key, c.weight])),
  sub: Object.fromEntries(
    data.components.flatMap((c) =>
      c.subs.map((s) => [s.key, { on: s.on, w: { ...s.w } }]))),
});

// Floor and Ceiling are two ends of one dial - the style slider splits a fixed budget
// between them rather than being typed independently.
export function componentWeights(st) {
  const w = { ...st.comp };
  w.floor = Math.round((st.styleBudget * (100 - st.style)) / 100);
  w.ceiling = Math.round((st.styleBudget * st.style) / 100);
  return w;
}

const RATE_POS = ['QB', 'RB', 'WR', 'TE'];
const ratePos = (pos) => (RATE_POS.includes(pos) ? pos : 'RB');

// A player's score for one component: his sub-metric percentiles, weighted by the
// weights for HIS position, ignoring stats switched off or weighted 0 there.
export function componentScore(p, comp, st) {
  const q = ratePos(p.pos);
  let num = 0;
  let den = 0;
  for (const s of comp.subs) {
    const cfg = st.sub[s.key];
    if (!cfg || !cfg.on) continue;
    const w = cfg.w[q] || 0;
    const v = p.sub[s.key];
    if (!w || v == null) continue;
    num += v * w;
    den += w;
  }
  return den ? num / den : 50;
}

// ---------------------------------------------------------------- league maths
export function projectedPoints(p, league) {
  // Kickers and defences are scored by their own league-specific rules rather than by a
  // stat line, so their points come across already computed.
  if (p.ppts != null) return p.ppts[league.name] ?? 0;
  let t = 0;
  for (const [k, v] of Object.entries(league.scoring)) t += v * (p.proj[k] || 0);
  return t;
}

export function inLeague(p, league) {
  // A league with no K or DEF slot simply has no kickers or defences in it.
  if (p.pos === 'K' || p.pos === 'DEF') return (league.starters[p.pos] || 0) > 0;
  return true;
}

// Replacement level: the best player at this position you could still get for free after
// every team has filled its starting slots, flex included.
export function replacementLevels(players, league) {
  const flexShare = { RB: 0.40, WR: 0.55, TE: 0.05 };
  const flex = league.starters.FLEX || 0;
  const out = {};
  for (const pos of Object.keys(league.starters)) {
    if (pos === 'FLEX') continue;
    const pool = players
      .filter((p) => p.pos === pos && inLeague(p, league))
      .map((p) => projectedPoints(p, league))
      .sort((a, b) => b - a);
    if (!pool.length) { out[pos] = 0; continue; }
    const n = Math.max(1, Math.round(
      league.teams * (league.starters[pos] + (flexShare[pos] || 0) * flex)));
    // smoothed across three ranks so one odd projection cannot set the baseline
    const win = pool.slice(Math.max(0, n - 2), Math.min(pool.length, n + 1));
    out[pos] = win.reduce((a, b) => a + b, 0) / win.length;
  }
  return out;
}

// Any account can open this page, so nobody else's leagues are assumed. Until you import
// from Sleeper you get one neutral league, and importing replaces it with your own.
export const SAMPLE_LEAGUE = {
  name: 'Standard 12-team PPR',
  teams: 12,
  rounds: 15,
  sample: true,
  starters: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1 },
  bench: 6,
  scoring: {
    pass_yd: 0.04, pass_td: 4, pass_int: -1, pass_2pt: 2,
    rush_yd: 0.1, rush_td: 6, rush_2pt: 2,
    rec: 1, rec_yd: 0.1, rec_td: 6, rec_2pt: 2, fum_lost: -2,
  },
};

// The expensive half: a player's component scores depend only on which stats are switched
// on and their per-position weights. Dragging Safe/Upside or Trust-my-ratings does not
// touch them, so they are computed once and reused - without this, every pixel of slider
// movement re-blended 50 stats across 259 players and the sliders stuttered.
export function subScores(data, st) {
  const out = new Map();
  for (const p of data.players) {
    const s = {};
    for (const c of data.components) {
      s[c.key] = c.key === 'projection' ? null : componentScore(p, c, st);
    }
    out.set(p.id, s);
  }
  return out;
}

// ---------------------------------------------------------------- the board
export function buildBoard(data, st, cache) {
  const league = data.leagues[st.league];
  const comps = data.components;
  const cw = componentWeights(st);
  const cwTotal = Object.values(cw).reduce((a, b) => a + b, 0) || 1;
  const repl = replacementLevels(data.players, league);

  const rows = data.players
    .filter((p) => inLeague(p, league))
    .map((p) => {
      const pts = projectedPoints(p, league);
      const vor = pts - (repl[p.pos] || 0);
      const cached = cache?.get(p.id);
      const scores = cached ? { ...cached } : (() => {
        const s = {};
        for (const c of comps) {
          s[c.key] = c.key === 'projection' ? null : componentScore(p, c, st);
        }
        return s;
      })();
      return { p, pts, vor, scores };
    });

  // Projection is a percentile of projected points within position, so it needs the
  // whole pool before it can be filled in.
  const byPos = {};
  for (const r of rows) (byPos[r.p.pos] ||= []).push(r);
  for (const list of Object.values(byPos)) {
    const sorted = [...list].sort((a, b) => a.pts - b.pts);
    const n = sorted.length;
    sorted.forEach((r, i) => { r.scores.projection = n > 1 ? (i / (n - 1)) * 100 : 50; });
  }

  // VOR on a 0-100 scale above replacement. Below replacement it keeps an ORDERED band
  // down to -25 - clamping at 0 once put 142 of 259 players on the same score.
  const mx = Math.max(...rows.map((r) => r.vor), 1);
  const mn = Math.min(...rows.map((r) => r.vor), -1);

  // What you already have, so the board can nudge you toward what you still need.
  const have = {};
  for (const q of st.mine || []) have[q] = (have[q] || 0) + 1;
  const pool = (have.RB || 0) + (have.WR || 0) + (have.TE || 0);
  const req = (league.starters.RB || 0) + (league.starters.WR || 0)
    + (league.starters.TE || 0) + (league.starters.FLEX || 0);
  const needFor = (pos) => {
    const want = league.starters[pos] || 0;
    if (!want) return 0;
    if ((have[pos] || 0) < want) return st.need;
    // starters filled: still worth something while a flex slot is open, then a penalty
    if (['RB', 'WR', 'TE'].includes(pos)) return pool < req ? st.need / 2 : -st.need / 2;
    return -st.need / 2;
  };

  for (const r of rows) {
    r.vorPct = r.vor > 0 ? (r.vor / mx) * 100 : (r.vor / Math.abs(mn)) * 25;
    r.rating = Object.entries(cw)
      .reduce((a, [k, w]) => a + (r.scores[k] ?? 50) * w, 0) / cwTotal;
    r.need = needFor(r.p.pos);
    const posx = st.posx[r.p.pos] ?? 1;
    // The rating is ADDED, not multiplied: multiplying erases it when VOR is 0 and
    // inverts it when VOR is negative.
    let s = (r.vorPct + st.tilt * 40 * ((r.rating - 50) / 50)) * posx + r.need;
    if (st.rookie && r.p.rookie) {
      const c = r.p.m.rookie_conf || '';
      const conf = c.startsWith('HIGH') ? 1 : c.startsWith('MED') ? 0.6 : 0.3;
      s += st.rookieMax * conf;
    }
    r.score = s;
  }

  rows.sort((a, b) => b.score - a.score);
  rows.forEach((r, i) => { r.rank = i + 1; });

  const adpOrder = [...rows].sort((a, b) => a.p.adp - b.p.adp);
  adpOrder.forEach((r, i) => { r.adpRank = i + 1; });

  return { rows, repl, league, weights: cw };
}

// A plain-English read of what the current weights mean, for the ratings editor.
export function priorityOrder(data, st) {
  const cw = componentWeights(st);
  return data.components
    .map((c) => ({ label: c.label, w: cw[c.key] || 0 }))
    .filter((c) => c.w > 0)
    .sort((a, b) => b.w - a.w);
}
