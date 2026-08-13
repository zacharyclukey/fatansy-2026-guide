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
  // Your three preferences, each -100 (hard left) to +100 (hard right), 0 = no opinion.
  // They break ties between players you would be roughly equally happy with. They are
  // not a forecast and the app says so.
  fit: { td: 0, asc: 0, dur: 0, pen: 0 },
  fitExtra: {},       // extra scoring keys you have added to a point-based axis
  fitOn: true,
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
// ---------------------------------------------------------------- fit
// Three preferences, not fifty stats. Each is computed from the projection itself rather
// than from a blend we invented, and each answers a question a person can actually hold
// an opinion about.
//
// Measured over 2020-2025 before any of this was written: the projections beat "last
// year's points" by about +0.25 at every position, no arrangement of historical stats
// added anything to them, bust rate repeats year to year (~0.50) while boom rate does
// not (~0.05). So Fit does not try to forecast. It sorts players you would be equally
// happy with into the order YOU would pick them, and nothing more.
export const FIT_BAND = 8;        // most Fit can move a score. Deliberately small.

export const FIT_AXES = [
  { key: 'td', label: 'Steady points vs big plays', left: 'Steady', right: 'Big plays',
    hint: 'How much of his projection arrives in lumps rather than as a steady drip. '
        + 'Lumps are where the big weeks and the empty ones both come from.',
    open: true },
  { key: 'asc', label: 'Proven vs ascending', left: 'Proven', right: 'Ascending',
    hint: 'How big a leap the 2026 projection is asking for, against what he actually did.',
    uses: ['Projected points per game this year', 'His points per game last year',
      'A man with no last season counts as a big ask'] },
  { key: 'dur', label: 'Punish injury risk', left: 'Ignore it', right: 'Punish it',
    hint: 'The only one of these with hard evidence behind it: every projection '
        + 'overshoots its season total, and the whole gap is games missed.',
    uses: ['Games he was available for last season, out of 17'] },
  { key: 'pen', label: 'Avoid mistakes', left: 'Do not care', right: 'Avoid them',
    hint: 'Fumbles and interceptions, priced at what YOUR league actually fines them.',
    needsPenalties: true, open: true },
];

// Plain-English names for the scoring keys a person might tick on or off. Anything not
// listed here is still usable, it just shows its raw Sleeper name.
export const KEY_NAMES = {
  rush_td: 'Rushing touchdowns', rec_td: 'Receiving touchdowns', pass_td: 'Passing touchdowns',
  rush_2pt: 'Two-point runs', rec_2pt: 'Two-point catches', pass_2pt: 'Two-point passes',
  rec_40p: '40+ yard catches', rush_40p: '40+ yard runs', pass_40p: '40+ yard passes',
  bonus_rush_yd_100: '100-yard rushing games', bonus_rec_yd_100: '100-yard receiving games',
  bonus_rush_rec_yd_100: '100-yard games', bonus_pass_yd_300: '300-yard passing games',
  bonus_pass_yd_400: '400-yard passing games',
  fum_lost: 'Fumbles lost', fum: 'Fumbles', pass_int: 'Interceptions thrown',
  rec_drop: 'Drops', rec_fd: 'Receiving first downs', rush_fd: 'Rushing first downs',
  pass_fd: 'Passing first downs', pass_cmp: 'Completions', rec: 'Receptions',
  rush_yd: 'Rushing yards', rec_yd: 'Receiving yards', pass_yd: 'Passing yards',
};
export const keyName = (k) => KEY_NAMES[k] || k;

// Which scoring keys each of the two point-based axes counts, given your league and any
// extras you have ticked on. Only keys the league actually scores are ever included -
// there is no point counting 40-yard catches in a league that does not pay for them.
export function axisKeys(axis, league, st = {}) {
  const sc = league.scoring || {};
  const extra = (st.fitExtra || {})[axis] || [];
  const base = axis === 'pen' ? COSTLY : LUMPY;
  return [...new Set([...base, ...extra])].filter((k) => (sc[k] || 0) !== 0);
}

// Everything else the league scores that this axis is not already counting, so the UI can
// offer them without ever offering something meaningless.
export function axisSpare(axis, league, st = {}) {
  const sc = league.scoring || {};
  const used = new Set(axisKeys(axis, league, st));
  const wrongWay = axis === 'pen' ? (v) => v >= 0 : (v) => v <= 0;
  return Object.keys(sc).filter((k) => !used.has(k) && !wrongWay(sc[k])).sort();
}

// Points that arrive in lumps, under YOUR league's rules.
//
// Base scoring is a steady drip: a yard is a yard. What actually moves a week is the
// lumpy stuff - a touchdown, a forty-yard catch, a two-point conversion - and which
// lumps exist depends entirely on the league. Your Highest Scorer league pays a point
// for a 40+ yard catch and a tenth for every first down; the other two pay neither. So
// the same receiver genuinely has a different ceiling in different leagues, and this is
// computed per league rather than assumed.
export const LUMPY = ['rush_td', 'rec_td', 'pass_td', 'rush_2pt', 'rec_2pt', 'pass_2pt',
  'rec_40p', 'rush_40p', 'pass_40p', 'bonus_rush_yd_100', 'bonus_rec_yd_100',
  'bonus_rush_rec_yd_100', 'bonus_pass_yd_300', 'bonus_pass_yd_400'];

// The other side of the coin: what the league takes off you, and who tends to give it up.
export const COSTLY = ['fum_lost', 'fum', 'pass_int', 'rec_drop'];

function pointsFrom(p, league, keys) {
  const pr = p.proj || {};
  const sc = league.scoring || {};
  return keys.reduce((a, k) => a + (pr[k] || 0) * (sc[k] || 0), 0);
}

// Share of his projection that comes in lumps rather than as a steady drip. High means a
// boom-or-bust week; low means he gets you his points whether or not he finds the endzone.
export function swingShare(p, league, st = {}) {
  const total = projectedPoints(p, league);
  if (total <= 0) return 0;
  return Math.max(0, Math.min(1, pointsFrom(p, league, axisKeys('td', league, st)) / total));
}

// Points this league fines him for, per season. Zero in a league with no penalties, which
// is why the slider that uses it hides itself when the league has none.
export function riskPoints(p, league, st = {}) {
  return -pointsFrom(p, league, axisKeys('pen', league, st));
}

// Does this league punish mistakes at all? Decides whether to show that preference.
export function hasPenalties(league) {
  const sc = league.scoring || {};
  return COSTLY.some((k) => (sc[k] || 0) < 0);
}

// How much better the projection expects him to be than he was. Rookies have no last
// year, so they sit at the optimistic end by definition rather than by accident.
export function ascent(p) {
  const m = p.m || {};
  const now = m.proj_ppg ?? 0;
  const before = m.last_ppg;
  if (before == null || !m.has2025) return 6;        // no history: treat as a big ask
  return now - before;
}

export function durability(p) {
  const m = p.m || {};
  if (!m.has2025) return 13;                          // unknown, so neither rewarded nor punished
  return Math.max(0, Math.min(17, m.games_2025 ?? 13));
}

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
  ['pass_att', 'Pass attempts', true, true, 'volume', 'pass_att_pg'],
  ['pass_yd', 'Passing yards', true, true, 'production', null],
  ['pass_td', 'Passing touchdowns', true, true, 'redzone', 'pass_td_pg'],
  ['pass_int', 'Interceptions thrown', false, true, 'reliability', 'int_pg'],
  ['pass_sack', 'Sacks taken', false, true, 'reliability', 'sack_rate'],
  ['pass_fd', 'Passing first downs', true, true, 'production', null],
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

  // Each Fit trait as a percentile within position, so "touchdown-heavy" means heavy for
  // a running back rather than heavy compared with a quarterback.
  for (const list of Object.values(byPos)) {
    for (const [key, get] of [['td', (r) => swingShare(r.p, league, st)],
      ['asc', (r) => ascent(r.p)], ['dur', (r) => durability(r.p)],
      ['pen', (r) => -riskPoints(r.p, league, st)]]) {
      const vals = list.map((r) => [r, get(r)]).sort((a, b) => a[1] - b[1]);
      const n = vals.length;
      // Ties share a percentile. Without this, thirty-two defences all on zero touchdown
      // share get spread from 0 to 100 by nothing but array order, and one of them comes
      // out "the most touchdown-dependent player in the league".
      let i = 0;
      while (i < n) {
        let j = i;
        while (j + 1 < n && vals[j + 1][1] === vals[i][1]) j += 1;
        const pct = n > 1 ? (((i + j) / 2) / (n - 1)) * 100 : 50;
        for (let k = i; k <= j; k += 1) {
          vals[k][0].traits ||= {};
          vals[k][0].traits[key] = pct;
        }
        i = j + 1;
      }
    }
  }

  // Fit is the average distance from neutral across the axes you actually moved. An
  // untouched slider contributes nothing rather than quietly voting for the middle.
  const leans = st.fit || {};
  const live = FIT_AXES.map((a) => a.key).filter((k) => (leans[k] || 0) !== 0);
  for (const r of rows) {
    if (!live.length || st.fitOn === false) { r.fit = 50; continue; }
    const sum = live.reduce(
      (acc, k) => acc + ((leans[k] / 100) * ((r.traits?.[k] ?? 50) - 50)), 0);
    r.fit = Math.max(0, Math.min(100, 50 + sum / live.length));
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
    // Fit is capped at FIT_BAND points so it can only ever reorder players the value
    // numbers were close to indifferent about. That cap is the honest part: nothing here
    // beat the projections in five years of testing, so it does not get to outvote them.
    let s = (r.vorPct + st.tilt * 40 * ((r.rating - 50) / 50)
      + FIT_BAND * ((r.fit - 50) / 50)) * posx + r.need;
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

  valueWindow(rows);

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
// Built from the two traits that survived testing rather than from the component blend
// that did not. "Swing" is a man whose points arrive in lumps this league pays big for;
// "Safe" is a steady scorer who was also available. Bust rate repeats year to year at
// about 0.50, which is why availability is allowed in here and boom rate is not.
export function pickType(r) {
  const gap = r.adpRank - r.rank;          // + = your board likes him more than the room
  if (gap <= -20) return 'skip';           // he goes 20+ spots before you would take him
  const lump = r.traits?.td ?? 50;
  const avail = r.traits?.dur ?? 50;
  if (lump >= 68) return 'swing';
  if (lump <= 40 && avail >= 55) return 'safe';
  return null;
}

// ---------------------------------------------------------------- value window
// Not a grade out of a hundred. A range of picks.
//
// A 0-100 rating never answered the question anyone actually asks, which is "should I
// take him HERE?". This does: he is worth taking from the pick where he becomes the best
// man on your board, through to the last pick where he is still the equal of anyone left
// in his tier. Inside a tier the players are interchangeable, so the window is wide and
// there is no hurry. At a tier edge it snaps shut and waiting costs you the tier.
//
// Then compare that window with where the room takes him. If his ADP sits past the end of
// your window he is a bargain; if it sits before the start, the room is paying more than
// you would and you should let someone else.
export const WINDOW_BAND = 2.5;   // score points inside which two players are a coin flip
// Deep in the pool the scores flatten and a run of coin flips can be a hundred players
// long. That is true - pick 200 and pick 260 really are interchangeable - but a window
// that wide tells you nothing, and it would let a man 90 picks away read as a bargain.
// Past this the window is marked open-ended and shown as "180+" instead of pretending.
export const WINDOW_MAX = 30;

export function valueWindow(rows, band = WINDOW_BAND, cap = WINDOW_MAX) {
  // rows arrive sorted best-first. Everyone within a hair of his score is a player you
  // would be equally happy with, so the window runs across that whole run - not across
  // his positional tier, which at the top of the board is often just him on his own.
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    let lo = i;
    let hi = i;
    while (lo > 0 && rows[lo - 1].score - r.score <= band) lo -= 1;
    while (hi < rows.length - 1 && r.score - rows[hi + 1].score <= band) hi += 1;

    // A tier cliff is a real drop, so the window never runs past one at his own position.
    for (let k = i; k < hi; k += 1) {
      if (rows[k].p.pos === r.p.pos && rows[k].lastOfTier) { hi = k; break; }
    }

    // Trim around HIM, not from the top of the run. Capping hi at lo+cap would throw the
    // player out of his own window whenever he sat in the middle of a long flat stretch.
    r.openEnded = hi - lo > cap;
    if (r.openEnded) {
      const half = Math.floor(cap / 2);
      lo = Math.max(lo, i - half);
      hi = Math.min(hi, lo + cap);
    }

    r.worthFrom = rows[lo].rank;
    r.worthTo = rows[hi].rank;
    r.equals = hi - lo;                      // how many others are a coin flip with him
    r.edge = r.adpRank - r.rank;             // + = the room lets him fall past your spot
    // Once the window is truncated both ends are guesses, so neither verdict is earned.
    // Deep in the pool the honest answer really is "it does not much matter".
    r.verdict = r.openEnded ? 'fair'
      : r.adpRank > r.worthTo ? 'bargain'
        : r.adpRank < r.worthFrom ? 'costly'
          : 'fair';
  }
  return rows;
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

    // What score should you EXPECT at this position when you next pick?
    //
    // The first version of this took the best man with better-than-even odds of lasting,
    // and if that was the best player available it reported a cost of zero. Which meant
    // the whole panel read 0.0 whenever your next pick was close - exactly when the
    // question matters. A 55% chance of keeping the best player is not "no cost".
    //
    // So it is a real expectation: walk down the position, and weight each player by the
    // chance he is still there AND everyone better has gone.
    let expected = 0;
    let allGone = 1;                       // probability everyone above is off the board
    for (const r of avail.slice(0, 40)) {
      const p = availability(r.p.adp, clock.target, clock.currentPick) ?? 0;
      expected += r.score * p * allGone;
      allGone *= 1 - p;
      if (allGone < 0.001) break;
    }
    // whatever probability is left over, assume the worst man considered
    expected += (avail[Math.min(39, avail.length - 1)]?.score ?? 0) * allGone;

    const cost = Math.max(0, best.score - expected);
    // named for the sentence in the UI: the best one with better-than-even odds
    const survivor = avail.find((r) => (availability(r.p.adp, clock.target, clock.currentPick) ?? 0) >= 0.5);

    const want = league.starters[pos] || 0;
    const got = have[pos] || 0;
    const shortfall = Math.max(0, want - got);
    const urgency = shortfall > 0 ? 1 : 0.45;

    out.push({
      pos,
      best,
      survivor,
      expected,
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
