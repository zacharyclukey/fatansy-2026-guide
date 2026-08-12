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

export const STAR_BAND = 5;   // how close two players must be for a star to break the tie

export const DEFAULT_SETTINGS = (data) => ({
  league: 0,
  stars: [],          // players you rate above what the numbers say. Not league-specific.
  fades: [],          // and the ones you trust less than the numbers do.
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

// Safe <-> Upside moves weight between the components that describe a settled, dependable
// player and the one that describes room to grow.
//
// It used to inflate two components, Floor and Ceiling, that were built almost entirely
// from formulas copied out of the others - Floor was 100% copies. Sliding it was secretly
// re-weighting volume and role under a different name. Now it shifts the real weights.
export const STEADY = ['volume', 'role', 'reliability', 'production'];
export const RISKY = ['upside', 'explosive'];

export function componentWeights(st) {
  const w = { ...st.comp };
  // -1 at full safe, +1 at full upside
  const lean = ((st.style ?? 50) - 50) / 50;
  const shift = (st.styleBudget ?? 15) * lean;
  const give = (keys, amount) => {
    const total = keys.reduce((a, k) => a + (w[k] || 0), 0) || 1;
    for (const k of keys) w[k] = Math.max(0, Math.round((w[k] || 0) + amount * ((w[k] || 0) / total)));
  };
  give(STEADY, -shift);
  give(RISKY, shift);
  return w;
}

// A player's floor, for the risk label only. It is deliberately NOT a rating component:
// it is made of volume, role and reliability, and counting it again inside the rating is
// exactly the double-count that was there before.
export function floorScore(scores) {
  const parts = [scores.volume, scores.role, scores.reliability].filter((v) => v != null);
  return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 50;
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

// Replacement level: the best player at this position you could still get for free once
// every team has filled its starting slots, flex included.
//
// The flex split used to be a hardcoded RB 40 / WR 55 / TE 5, which was simply wrong. In a
// PPR league the twelve best players left over after everyone's starters are filled are
// ALL receivers - so receivers were being measured against a bar 5 slots too shallow and
// backs against one 5 slots too deep. Both errors pushed the same way and the board came
// out far too RB-heavy.
//
// So it is derived instead: fill each position's own slots, then let the best remaining
// flex-eligible players take the flex spots, and see who they actually are. That
// self-corrects for PPR, half-PPR, TE premium or any other scoring a league invents.
export function flexFill(players, league) {
  const flexSlots = (league.starters.FLEX || 0) * league.teams;
  const eligible = ['RB', 'WR', 'TE'].filter((p) => league.starters[p] != null || flexSlots);
  const pool = {};
  for (const pos of eligible) {
    pool[pos] = players
      .filter((p) => p.pos === pos && inLeague(p, league))
      .map((p) => ({ p, pts: projectedPoints(p, league) }))
      .sort((a, b) => b.pts - a.pts);
  }
  // everyone locked into a dedicated slot at his own position
  const used = {};
  for (const pos of eligible) used[pos] = (league.starters[pos] || 0) * league.teams;
  // then the flex spots go to the best of whoever is left, wherever they play
  const leftovers = eligible
    .flatMap((pos) => pool[pos].slice(used[pos]).map((x) => ({ ...x, pos })))
    .sort((a, b) => b.pts - a.pts)
    .slice(0, flexSlots);
  for (const x of leftovers) used[x.pos] += 1;
  return { used, pool };
}

export function replacementLevels(players, league) {
  const out = {};
  const { used, pool } = flexFill(players, league);

  for (const pos of Object.keys(league.starters)) {
    if (pos === 'FLEX') continue;
    const list = pool[pos] ? pool[pos].map((x) => x.pts) : players
      .filter((p) => p.pos === pos && inLeague(p, league))
      .map((p) => projectedPoints(p, league))
      .sort((a, b) => b - a);
    if (!list.length) { out[pos] = 0; continue; }
    // flex-eligible positions use the derived count; K and DEF just use their own slots
    const n = Math.max(1, used[pos] ?? (league.starters[pos] || 0) * league.teams);
    // smoothed across three ranks so one odd projection cannot set the baseline
    const win = list.slice(Math.max(0, n - 2), Math.min(list.length, n + 1));
    out[pos] = win.length ? win.reduce((a, b) => a + b, 0) / win.length : list[list.length - 1];
  }
  return out;
}

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

// Every 2025 field carried in the data file, whether or not the built-in rating uses it.
// Anything here can be switched on as a stat in any component - "available but unused"
// should mean one click, not a rebuild.
// Raw 2025 fields that can be brought in as a stat.
//
// The catch: almost every one of these ALREADY backs a built-in stat in some form, so a
// menu of "stats the rating is not using" that listed all of them was simply wrong. Each
// entry therefore names the built-in it duplicates. If that built-in exists, the right
// way to "add" the stat is to switch the built-in on, not to create a second copy of it.
//
// field, label, higher-is-better, per-game, component, the built-in it duplicates
export const RAW_FIELDS = [
  ['off_snp', 'Snaps', true, true, 'volume', 'snaps_pg'],
  ['rush_att', 'Carries', true, true, 'volume', 'carries_pg'],
  ['rec_tgt', 'Targets', true, true, 'volume', 'targets_pg'],
  ['rec', 'Receptions', true, true, 'volume', 'rec_pg'],
  ['rush_ypa', 'Yards per carry', true, false, 'efficiency', 'ypc'],
  ['rec_ypt', 'Yards per target', true, false, 'efficiency', 'yptgt'],
  ['rec_ypr', 'Yards per catch', true, false, 'efficiency', 'ypr'],
  ['rush_rz_att', 'Red-zone carries', true, true, 'redzone', 'rz_carries_pg'],
  ['rec_rz_tgt', 'Red-zone targets', true, true, 'redzone', 'rz_targets_pg'],
  ['anytime_tds', 'Touchdowns', true, true, 'redzone', 'td_pg'],
  ['bonus_rush_rec_yd_100', '100-yard games', true, false, 'explosive', 'hundred'],
  ['pts_ppr', 'Fantasy points', true, true, 'production', 'ppg'],
  ['pos_rank_ppr', 'Finish at his position', false, false, 'production', 'finish'],
  ['gp', 'Games played', true, false, 'reliability', 'games'],
  ['gs', 'Games started', true, false, 'reliability', 'starts'],
  ['rec_drop', 'Drops', false, true, 'reliability', 'drop_rate'],
  ['fum', 'Fumbles', false, true, 'reliability', 'fum_pg'],

  // these genuinely have no built-in equivalent
  ['rush_yd', 'Rushing yards', true, true, 'production', null],
  ['rec_yd', 'Receiving yards', true, true, 'production', null],
  ['rush_rec_yd', 'Yards from scrimmage', true, true, 'production', null],
  ['fum_lost', 'Fumbles lost', false, true, 'reliability', null],
  ['rec_40p', '40+ yard catches', true, true, 'explosive', null],
  ['rush_40p', '40+ yard runs', true, true, 'explosive', null],
];

// Everything the rating is genuinely NOT using right now: built-in stats that are switched
// off, plus raw fields with no built-in equivalent that have not already been added.
export function unusedStats(data, st) {
  const out = [];
  for (const c of data.components) {
    for (const sm of c.subs) {
      if (sm.custom) continue;
      if (!st.sub[sm.key]?.on) {
        out.push({ kind: 'builtin', key: sm.key, label: sm.label, comp: c.key, compLabel: c.label });
      }
    }
  }
  const added = new Set((st.customs || []).map((x) => x.field));
  for (const [field, label, hi, pg, comp, dupe] of RAW_FIELDS) {
    if (dupe || added.has(field)) continue;
    const cl = data.components.find((c) => c.key === comp)?.label || comp;
    out.push({ kind: 'raw', field, label, hi, pg, comp, compLabel: cl });
  }
  return out;
}

// Percentiles for a user-added stat, worked out the same way the built-in ones were:
// within position, so a back is only ever compared with other backs.
export function applyCustomStats(data, customs) {
  for (const p of data.players) {
    for (const k of Object.keys(p.sub)) if (k.startsWith('x_')) delete p.sub[k];
  }
  for (const c of customs) {
    const byPos = {};
    for (const p of data.players) {
      const raw = p.a?.[c.field];
      if (raw == null) continue;
      const v = c.pg ? raw / Math.max(p.a.gp || 1, 1) : raw;
      (byPos[p.pos] ||= []).push([p, v]);
    }
    for (const list of Object.values(byPos)) {
      list.sort((a, b) => (c.hi ? a[1] - b[1] : b[1] - a[1]));
      const n = list.length;
      list.forEach(([p], i) => { p.sub[c.key] = n > 1 ? (i / (n - 1)) * 100 : 50; });
    }
  }
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
      scores.floorish = floorScore(scores);   // display only, never weighted
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
    // tilt 0-1 behaves as before (up to +/-20 points of score). Above 1 the rating starts
    // to genuinely outrank value, which is what "I trust my own ratings" has to mean if it
    // is to mean anything - the board makes the trade-off explicit rather than capping it.
    let s = (r.vorPct + st.tilt * 40 * ((r.rating - 50) / 50)) * posx + r.need;
    if (st.rookie && r.p.rookie) {
      const c = r.p.m.rookie_conf || '';
      const conf = c.startsWith('HIGH') ? 1 : c.startsWith('MED') ? 0.6 : 0.3;
      s += st.rookieMax * conf;
    }
    r.score = s;
  }

  // A star or a fade is a preference, not an override. It moves a player past anyone
  // within STAR_BAND points of him and no further, so it only ever decides calls the
  // numbers were close to indifferent about. Nobody's score changes.
  const starred = new Set(st.stars || []);
  const faded = new Set(st.fades || []);
  for (const r of rows) {
    r.star = starred.has(r.p.id);
    r.fade = faded.has(r.p.id);
    r.sortKey = r.score + (r.star ? STAR_BAND : 0) - (r.fade ? STAR_BAND : 0);
  }
  rows.sort((a, b) => b.sortKey - a.sortKey);
  rows.forEach((r, i) => { r.rank = i + 1; });

  markTiers(rows);
  for (const r of rows) r.kind = pickType(r);

  const adpOrder = [...rows].sort((a, b) => a.p.adp - b.p.adp);
  adpOrder.forEach((r, i) => { r.adpRank = i + 1; });

  // where the grade alone would have put him, so the detail panel can show the gap
  // between "good for his position" and "worth this pick"
  const byPos2 = {};
  for (const r of rows) (byPos2[r.p.pos] ||= []).push(r);
  for (const list of Object.values(byPos2)) {
    list.sort((a, b) => b.rating - a.rating);
    list.forEach((r, i) => { r.posRated = i + 1; r.posCount = list.length; });
  }

  return { rows, repl, league, weights: cw };
}

// ---------------------------------------------------------------- draft clock
// Which overall picks belong to you in a snake draft, and therefore how long you have to
// wait. Slot 1 and slot 12 wait very different amounts, which is the whole reason
// "can I get him next time round?" is worth answering.
export function myPicks(teams, slot, rounds = 16) {
  const out = [];
  for (let r = 1; r <= rounds; r += 1) {
    out.push(r % 2 === 1 ? (r - 1) * teams + slot : (r - 1) * teams + (teams - slot + 1));
  }
  return out;
}

export function draftContext(league, slot, currentPick) {
  if (!slot || !league.teams) return null;
  const picks = myPicks(league.teams, slot, league.rounds || 16);
  const next = picks.find((p) => p >= currentPick) ?? null;
  const after = picks.find((p) => p > (next ?? currentPick)) ?? null;
  return {
    picks, currentPick, next, after,
    onClock: next === currentPick,
    // the gap that matters: if you are on the clock it is until your NEXT one
    gap: (next === currentPick ? after : next) - currentPick,
    target: next === currentPick ? after : next,
  };
}

// Chance a player is still on the board at a given pick, GIVEN he is still here now.
//
// Two things matter here and both were wrong first time round:
//
// 1. It has to be conditional. A player with an ADP of 3 who is somehow still there at
//    pick 26 has already done something the model called impossible. Asking "what were
//    the odds he lasts to 28" unconditionally answers ~0%, which is useless. Asking
//    "given he is here at 26, does he last two more" is the question you actually have.
// 2. A normal distribution has tails far too thin for this. Players slide much more
//    often than a bell curve allows, so a logistic is used instead - same shape in the
//    middle, far more forgiving at the edges.
//
// Sleeper gives a mean ADP and no spread, so the spread is modelled: sd = 2 + 0.18 x ADP.
// Early picks are predictable, late ones are not. It is an estimate and is labelled as one.
export function availability(adp, atPick, fromPick = 0) {
  if (!adp || !atPick) return null;
  const s = (2 + 0.18 * adp) / 1.81;           // logistic scale from the same sd
  const surv = (t) => 1 / (1 + Math.exp((t - adp) / s));
  const now = Math.max(fromPick, 0);
  const base = now > 0 ? surv(now) : 1;
  if (base <= 0) return 0;
  return Math.max(0, Math.min(1, surv(atPick) / base));
}

// How many comparable players are still there. If six similar guys remain you can wait on
// any of them; if he is alone in his tier, waiting means missing the tier.
export function poolAround(rows, r, drafted, band = 6) {
  return rows.filter((x) => !drafted.has(x.p.id)
    && x.p.id !== r.p.id && Math.abs(x.score - r.score) <= band).length;
}

// What KIND of pick is this, right now?
//
// Three numbers already exist for every player - his floor, his upside, and how his rank
// on your board compares with where the room takes him. Read together they say something
// the score alone does not: whether this is the boring correct pick, a swing, or a player
// the market simply values more than you do.
export function pickType(r) {
  const floor = r.scores.floorish ?? 50;
  const up = r.scores.upside ?? 50;
  const gap = r.adpRank - r.rank;          // + = your board likes him more than the room
  if (gap <= -20) return 'skip';           // he goes 20+ spots before you would take him
  if (floor >= 62 && up < 58) return 'safe';
  if (up >= 60 && floor < 58) return 'swing';
  return null;
}

// ---------------------------------------------------------------- tiers
// Where a position falls off a cliff.
//
// Walking down a position by score, most gaps are small and a few are large. A gap much
// bigger than that position's typical gap is a tier break: the last player above it is
// the last of his kind, and if you pass on him the next one is a real step down. That is
// the single most useful thing to know when deciding whether to reach.
export function markTiers(rows) {
  const byPos = {};
  for (const r of rows) {
    r.lastOfTier = false;
    r.tier = 1;
    (byPos[r.p.pos] ||= []).push(r);
  }
  for (const list of Object.values(byPos)) {
    list.sort((a, b) => b.score - a.score);
    if (list.length < 4) continue;
    const gaps = [];
    for (let i = 1; i < list.length; i += 1) gaps.push(list[i - 1].score - list[i].score);
    const sorted = [...gaps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || 0;
    // A break has to clear two bars: much larger than this position's normal step down,
    // AND large in absolute terms. Without the second test the flat tail of near-identical
    // players deep in the pool generates a "cliff" every few rows, which is just noise.
    const threshold = Math.max(median * 3, 4);
    let tier = 1;
    for (let i = 1; i < list.length; i += 1) {
      // below replacement everyone is interchangeable; cliffs there mean nothing
      if (gaps[i - 1] >= threshold && list[i - 1].score > 0) {
        list[i - 1].lastOfTier = true;
        tier += 1;
      }
      list[i].tier = tier;
    }
  }
  return rows;
}

// ---------------------------------------------------------------- what to do now
// "Who is best" is the wrong question on the clock. The right one is "which position
// costs me the most by waiting" - because the pick you skip is not lost, it is deferred
// to your next turn, and some positions survive that wait far better than others.
//
// For each position: the best man available now, versus the best you could still
// reasonably expect at your next pick. The gap between them is what waiting costs.
export function costOfWaiting(rows, clock, drafted, league, have = {}, opts = {}) {
  if (!clock?.target) return [];
  const need = opts.need ?? 8;
  const out = [];
  const positions = Object.keys(league.starters).filter((p) => p !== 'FLEX');

  for (const pos of positions) {
    const avail = rows.filter((r) => r.p.pos === pos && !drafted.has(r.p.id));
    if (!avail.length) continue;
    const best = avail[0];

    // the best man at this position with a real chance of lasting until your next pick
    const survivor = avail.find((r) => (availability(r.p.adp, clock.target, clock.currentPick) ?? 0) >= 0.5);
    const fallback = survivor ? survivor.score : (avail[avail.length - 1]?.score ?? 0);
    const cost = Math.max(0, best.score - fallback);

    // a position you have already filled is worth less to you than the raw gap suggests
    const want = league.starters[pos] || 0;
    const got = have[pos] || 0;
    const shortfall = Math.max(0, want - got);
    const urgency = shortfall > 0 ? 1 : 0.45;

    out.push({
      pos,
      best,
      survivor,
      cost,
      weighted: cost * urgency + (shortfall > 0 ? need / 2 : 0),
      shortfall,
      bestBackOdds: availability(best.p.adp, clock.target, clock.currentPick),
    });
  }
  return out.sort((a, b) => b.weighted - a.weighted);
}

// How much does each component actually change the board?
//
// Worth measuring rather than assuming. Rebuild the board with one component switched off
// and see how far players move. The answer is sobering: the components are percentiles
// within position and heavily correlated with each other (volume and production agree at
// r = 0.83), so removing any one of them barely disturbs the order - the others carry the
// same signal. Showing this stops you spending an evening on a slider that cannot move
// anything.
export function influence(data, st, cache) {
  const ref = buildBoard(data, st, cache);
  const base = new Map(ref.rows.map((r) => [r.p.id, r.rank]));
  const out = {};
  for (const c of data.components) {
    const alt = { ...st, comp: { ...st.comp, [c.key]: 0 } };
    const rows = buildBoard(data, alt, cache).rows;
    let sum = 0;
    let top = 0;
    for (const r of rows) {
      const was = base.get(r.p.id);
      if (was == null) continue;
      sum += Math.abs(r.rank - was);
      if (was <= 50 && r.rank > 50) top += 1;
    }
    out[c.key] = { mean: sum / rows.length, top50: top };
  }
  return out;
}

// A plain-English read of what the current weights mean, for the ratings editor.
export function priorityOrder(data, st) {
  const cw = componentWeights(st);
  return data.components
    .map((c) => ({ label: c.label, w: cw[c.key] || 0 }))
    .filter((c) => c.w > 0)
    .sort((a, b) => b.w - a.w);
}
