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
  // Was 10, which is the whole of the need bonus. It could afford to be that big when the
  // rookie rating was invented nonsense and this was the only thing pricing a rookie at
  // all. Now that draft capital is 30% of his actual rating, +10 on top is the same fact
  // counted twice - it put a quarterback projected 84 points below replacement at pick 80.
  // It stays as a taste knob, at a size a taste knob should be.
  rookieMax: 4,
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
  { key: 'dur', label: 'Availability', left: 'Ignore it', right: 'Demand it',
    hint: 'The points between his projection and what he would have scored at the rate he '
        + 'has actually been on the field. Games played do repeat year to year, but only '
        + 'weakly at the skill positions - measured 0.27 at back, 0.29 at receiver, 0.31 '
        + 'at tight end, and 0.56 at quarterback. So it is a lean, not a law.',
    uses: ['His projected points for a full season',
      'Games he was available for last season, out of 17',
      'Some of this is durability and some is simply having the job - a starter gets more '
      + 'chances to play than a backup, and the two cannot be separated'] },
  { key: 'pen', label: 'Avoid mistakes', left: 'Do not care', right: 'Avoid them',
    hint: 'Fumbles and interceptions, priced at what YOUR league actually fines them.',
    needsPenalties: true, open: true },
];

// Each preference also produces a LABEL on the player card, which is the part a person
// actually reads. The trait itself is a fact and never moves; what the slider changes is
// how readily the label is applied. Indifferent, and only the extremes get named. Care a
// lot, and a third of the position gets named. Nobody is being told a player is bad -
// they are being told which of their own stated preferences he does and does not match.
export const FIT_TAGS = {
  td: [['Big-play scorer', 'a lot of his points arrive in lumps'],
    ['Steady scorer', 'his points come in most weeks rather than in bursts']],
  asc: [['Being asked to jump', 'the projection wants much more than he has ever done'],
    ['Proven', 'the projection is roughly what he has already produced']],
  dur: [['Ever-present', 'he has been available'],
    ['Injury risk', 'he has missed real time']],
  pen: [['Clean', 'he rarely gives points back'],
    ['Gives points back', 'fumbles and interceptions cost you in this league']],
};

// How far from the middle a player has to be before the label is worth printing. An
// untouched slider only names the outliers; a slider you have pushed names more.
// Only the outliers, unless you have said you care. At rest this names about one player
// in ten at each end; pushed hard it names about one in four. An earlier cut of 22 put a
// label on 48 of the top 60, which is not information, it is wallpaper.
export const TAG_MAX = 2;         // two labels on a card. A third is never read.

export function tagCut(lean) {
  const care = Math.abs(lean || 0) / 100;
  return 10 + 15 * care;
}

export function fitTags(r, st, league, games) {
  // A kicker has no touchdown share worth speaking of and a defence does not miss games.
  // Every trait they have is a placeholder, so labelling them would be inventing an
  // opinion out of absent data - the same mistake the 0-100 rating made before it was
  // taken away from them.
  if (!r.rated) return [];
  const leans = st.fit || {};
  const out = [];
  for (const a of FIT_AXES) {
    if (a.needsPenalties && !hasPenalties(league)) continue;
    const pct = r.traits?.[a.key];
    if (pct == null) continue;
    const cut = tagCut(leans[a.key]);
    const [hi, lo] = FIT_TAGS[a.key] || [];
    let pick = null;
    if (pct >= 100 - cut) pick = hi;
    else if (pct <= cut) pick = lo;
    if (!pick) continue;
    const wanted = (leans[a.key] || 0) > 0 ? pct >= 50 : (leans[a.key] || 0) < 0 ? pct < 50 : null;
    out.push({
      axis: a.key,
      tag: pick[0],
      why: pick[1],
      // distance from the middle, so the loudest two can be kept and the rest dropped
      force: Math.abs(pct - 50),
      // does this match what the user said they wanted, or cut against it?
      match: wanted,
      // availability is the one we can price, so it says the number rather than an adjective
      detail: a.key === 'dur' && games
        ? `${Math.round(injuryGap(r.p, league, games))} points behind a full season`
        : null,
    });
  }
  return out.sort((x, y) => y.force - x.force).slice(0, TAG_MAX);
}

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

// ---------------------------------------------------------------- durability
// The one correction the data actually demands. Measured over 2020-2025: every
// projection overshoots its season total at every position, and the whole gap is games
// missed - per-game accuracy is fine. Projections quietly assume a full year.
//
// But WHICH assumption is right for a given man is genuinely unknown, so this is a dial
// rather than a fixed haircut:
//
//   risk-accepting  -> assume he plays the full season, like the raw projection does
//   middle          -> assume he plays what his position typically plays
//   injury-averse   -> assume he plays what HE has played
//
// Nobody can tell you which is true. What the app can do is show you the number each
// assumption produces and let you pick the one you are willing to be wrong about.
export const FULL_GAMES = 17;
export const DRAFTABLE = 36;

export function positionGames(players, depth = DRAFTABLE) {
  const byPos = {};
  for (const p of players) {
    if (!p.m || !p.m.has2025 || p.m.games_2025 == null) continue;
    if (!RATE_POS.includes(p.pos)) continue;      // kickers and defences do not miss time
    (byPos[p.pos] ||= []).push(p);
  }
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : FULL_GAMES);
  const perPos = {};
  const all = [];
  for (const [pos, list] of Object.entries(byPos)) {
    const top = list.sort((a, b) => (a.adp || 999) - (b.adp || 999)).slice(0, depth)
      .map((p) => Math.max(0, Math.min(FULL_GAMES, p.m.games_2025)));
    perPos[pos] = mean(top);
    all.push(...top);
  }
  return { league: mean(all), pos: perPos };
}

// How many games he has actually given you. Falls back to the group when unknown, so a
// rookie is neither rewarded nor punished for having no record.
export function ownGames(p, games) {
  if (p.m && p.m.has2025 && p.m.games_2025 != null) {
    return Math.max(0, Math.min(FULL_GAMES, p.m.games_2025));
  }
  return games.pos?.[p.pos] ?? games.league ?? FULL_GAMES;
}

// THE POINTS AT RISK. Not a new projection - the distance between the projection as
// published (which quietly assumes a full season) and the same projection at the rate he
// has actually been available. A large gap is what "injury risk" means, stated in the
// currency of the league rather than as an adjective.
//
// This is the honest form of the finding: every projection overshoots and the whole gap
// is games missed. It is shown, it is labelled, and it nudges the order by a few points
// at most. It does not pretend to know he will miss time again.
export function injuryGap(p, league, games) {
  // A kicker has no games history worth the name and a defence cannot get hurt. Falling
  // back to the league average for them produced a gap proportional to their projected
  // points, which spread their availability trait across the whole range and let a kicker
  // come out as a boom-or-bust Swing. They have no availability signal; say zero.
  if (!RATE_POS.includes(p.pos)) return 0;
  const full = projectedPoints(p, league);
  if (full <= 0) return 0;
  return full * (1 - ownGames(p, games) / FULL_GAMES);
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

// ---------------------------------------------------------------- no NFL season yet
// A rookie has no 2025 stats, so every stat percentile the data file carries for him is
// invented. It was invented in a particular and damaging way: the pipeline worked out ONE
// rookie score and copied it into all forty-odd history sub-metrics, so a man who has
// never played a snap read 94 for rushing efficiency, 94 for red-zone conversion and 94
// for reliability. The rating, being the average of forty copies of one number, came out
// 81 - higher than a proven WR1 - for a quarterback projected 84 points BELOW replacement.
// He then went at pick 96 against an ADP of 170, and every other unexplained reach on the
// board was another player who had never played.
//
// So: a man with no season is rated on the three things that are actually knowable about
// him, and on nothing else. Everything invented is thrown away and says "no data" instead.
const SKILL = new Set(['QB', 'RB', 'WR', 'TE']);

// Kickers and defences have no stat line either, but they are not rookies and their own
// (poor) rating is doing useful work holding them down the board. Left alone deliberately.
export const noSeason = (p) => SKILL.has(p.pos) && !(p.a?.gp);

// Components built out of 2025 stats. For a man with no 2025 these have no answer, and
// saying so is the whole point - componentScore already returns 50 for "nothing to go on".
export const HISTORY_COMPS = new Set(['volume', 'efficiency', 'redzone', 'explosive',
  'production', 'reliability']);

// Where he went in the NFL draft, as an expectation of opportunity rather than of talent.
// Same steps the pipeline uses: top-ten picks play immediately, the rest of round one gets
// every chance, day two gets a real look, day three has to earn it. Undrafted is not zero,
// it is unproven.
export function capitalScore(pick) {
  if (!pick) return 25;
  if (pick <= 10) return 100;
  if (pick <= 32) return 85;
  if (pick <= 64) return 65;
  if (pick <= 100) return 45;
  return 25;
}

// Projection first, then draft capital, then his spot on the depth chart.
//
// In that order on purpose. Five years of testing said the projection is the strongest
// signal there is and that nothing else we tried added to it, so the two things a rookie
// has instead of a season get to shade the projection rather than outvote it. The
// projection percentile is computed per league, so a rookie in a league that pays for
// receptions is rated on what he is worth in THAT league.
export const ROOKIE_MIX = { proj: 0.45, capital: 0.3, role: 0.15, team: 0.1 };

export function rookieRating(p, projPct) {
  const m = p.m || {};
  const role = Math.max(0, Math.min(100, m.role_pct ?? 0));      // share of his team's work
  const team = Math.max(0, Math.min(100, (m.team_off ?? 0) / 14));
  return ROOKIE_MIX.proj * (projPct ?? 50)
    + ROOKIE_MIX.capital * capitalScore(m.draft_pick)
    + ROOKIE_MIX.role * role
    + ROOKIE_MIX.team * team;
}

// A player's score for one component: his sub-metric percentiles, weighted by the
// weights for HIS position, ignoring stats switched off or weighted 0 there.
export function componentScore(p, comp, st) {
  const q = ratePos(p.pos);
  // Nothing to go on, so no answer - not a number borrowed from somewhere else.
  const blank = noSeason(p);
  if (blank && HISTORY_COMPS.has(comp.key)) return null;
  // A few history stats live inside components that are otherwise about 2026 - games
  // started sits with his role, for instance. They carry the same copied number, and it
  // is recognisable BECAUSE it is the same number, so it can be dropped by name.
  const copied = blank ? (p.m?.rookie_score ?? null) : null;
  let num = 0;
  let den = 0;
  for (const s of comp.subs) {
    const cfg = st.sub[s.key];
    if (!cfg || !cfg.on) continue;
    const w = cfg.w[q] || 0;
    const v = p.sub[s.key];
    if (!w || v == null || (copied != null && v === copied)) continue;
    num += v * w;
    den += w;
  }
  return den ? num / den : 50;
}

// ---------------------------------------------------------------- league maths
export function projectedPoints(p, league) {
  // Kickers and defences are scored by their own league-specific rules rather than by a
  // stat line, so their points come across already computed, keyed by league NAME.
  if (p.ppts != null) {
    const exact = p.ppts[league.name];
    if (exact != null) return exact;
    // A league whose name is not in the data file - the built-in sample, or the league of
    // anyone who is not the person the file was built for - used to put every kicker and
    // defence on zero. That does not merely under-rate them, it ties all sixty-six of them
    // on the same score and then orders them by nothing at all, so the "best" kicker on
    // the sample board was whoever happened to sort first. Averaging what we do have is an
    // approximation of his points, but it gets the order right, which is the part that
    // decides anything.
    const vals = Object.values(p.ppts);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  }
  let t = 0;
  for (const [k, v] of Object.entries(league.scoring)) t += v * (p.proj[k] || 0);
  return t;
}

// How many rounds this draft runs. A league imported before its draft exists does not say,
// so fall back to the roster size and then to a standard fifteen.
export function roundsOf(league) {
  if (league.rounds) return league.rounds;
  const start = Object.values(league.starters || {}).reduce((a, b) => a + b, 0);
  return (start + (league.bench || 0)) || 15;
}

// How close to the end a kicker or a defence starts counting as something you need. They
// are always there, so wanting one in round 4 is not a need, it is a mistake.
export const LATE = 3;

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
export function flexFill(players, league, ptsOf = projectedPoints) {
  const flexSlots = (league.starters.FLEX || 0) * league.teams;
  const eligible = ['RB', 'WR', 'TE'].filter((p) => league.starters[p] != null || flexSlots);
  const pool = {};
  for (const pos of eligible) {
    pool[pos] = players
      .filter((p) => p.pos === pos && inLeague(p, league))
      .map((p) => ({ p, pts: ptsOf(p, league) }))
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

// Positions nobody holds a backup for, because the waiver wire always has one.
export const STREAMED = ['K', 'DEF'];
// Where the real alternative sits, as a fraction of the last starter's rank. It is
// SHALLOWER, not deeper: if you can pull a top-ten defence off waivers in any given week,
// the man you are really choosing against is near the top of the position, not the last
// one drafted. 0.5 puts him around 6th of 32 in a 12-team league, which collapses the
// apparent value of drafting one early - correctly, because nobody should.
export const STREAM_DEPTH = 0.5;

export function replacementLevels(players, league, ptsOf = projectedPoints) {
  const out = {};
  const { used, pool } = flexFill(players, league, ptsOf);

  for (const pos of Object.keys(league.starters)) {
    if (pos === 'FLEX') continue;
    const list = pool[pos] ? pool[pos].map((x) => x.pts) : players
      .filter((p) => p.pos === pos && inLeague(p, league))
      .map((p) => ptsOf(p, league))
      .sort((a, b) => b - a);
    if (!list.length) { out[pos] = 0; continue; }
    // Flex-eligible positions use the derived count. Kickers and defences are different:
    // every manager streams them off waivers week to week, so the man you would really be
    // starting instead is not the last drafted one - he is whoever is free. Setting their
    // replacement level deeper reflects that, and collapses the phantom value that had
    // the best defence sitting 11 picks ahead of where the room takes it.
    const base = used[pos] ?? (league.starters[pos] || 0) * league.teams;
    const n = Math.max(1, Math.round(base * (STREAMED.includes(pos) ? STREAM_DEPTH : 1)));
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

// The menu of "stats the rating is not using" lived here: RAW_FIELDS, which named every
// 2025 field in the data file and the built-in stat each one duplicated, and unusedStats,
// which turned the two into a list you could add from. Both existed only to feed the
// fifty-stat weight editor on the ratings page. That page is now four sliders, there is no
// screen that adds a stat, and nothing imported either function - so they were 90 lines of
// engine that ran for nobody.
//
// applyCustomStats below STAYS, and is still called on load. A profile saved by the old
// version can carry customs, and they have to keep working; it needs only the field name
// off the saved record, never the catalogue.

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
  // One number, used for the board, the replacement level and the flex fill alike. If
  // the durability assumption only moved the player and not the baseline he is measured
  // against, it would be comparing a discounted man with an undiscounted replacement.
  // The board shows the projection, full stop. An earlier build rescaled it by an
  // assumed number of games, which reordered everything - one man fell 105 places on a
  // single four-game season. That is a far harsher claim than anyone would make out loud,
  // and it meant the number on screen was no longer the projection. Availability is now a
  // PREFERENCE like the others: capped, visible, and it never edits the forecast.
  const pg = positionGames(data.players);
  const repl = replacementLevels(data.players, league);

  const rows = data.players
    .filter((p) => inLeague(p, league))
    .map((p) => {
      const pts = projectedPoints(p, league);
      p._games = ownGames(p, pg);
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
      ['asc', (r) => ascent(r.p)],
      ['dur', (r) => -injuryGap(r.p, league, pg)],
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
  //
  // And a slider the ratings page REFUSES TO SHOW must not keep voting either. "Avoid
  // mistakes" is hidden in a league that fines nothing, because in that league it has no
  // answer: every player ties on zero penalty points, so the axis adds nothing to the sum
  // while still counting towards the divisor - quietly weakening every preference you did
  // set. Measured on the real pool: a hidden slider left at 90 moved Fit by up to 20
  // points and one player by 46 places. Switch leagues and your board changed for a reason
  // that was not on the screen.
  const leans = st.fit || {};
  const usable = FIT_AXES.filter((a) => !a.needsPenalties || hasPenalties(league));
  const live = usable.map((a) => a.key).filter((k) => (leans[k] || 0) !== 0);
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
  // Picks you have left. Only used to decide when a kicker becomes a need.
  const left = roundsOf(league) - (st.mine || []).length;
  const needFor = (pos) => {
    const want = league.starters[pos] || 0;
    if (!want) return 0;
    if ((have[pos] || 0) < want) {
      // The bug this fixes was ugly and it was on the live board, not just in the
      // simulator. Once your starters were full every other position took -need/2 while an
      // empty kicker slot still paid +need - a swing of one and a half need bonuses - and
      // ranks 68 to 80 came out a solid block of kickers and defences. The board was
      // telling you to take six of them before your next receiver.
      //
      // A kicker is not a need in round four. He is there in round four, he is there in
      // round fifteen, and waiting on him costs nothing - which is exactly what the cost
      // of waiting panel already says about him. So the bonus arrives when the picks run
      // out and not before.
      // It has to be the same penalty everyone else gets, not zero. Zero still moved them
      // up: with every real position on -need/2 and a kicker on nothing, filling your
      // starters lifted fourteen kickers and defences into the top hundred without a
      // single thing about them having changed.
      if (['K', 'DEF'].includes(pos) && left > LATE) return -st.need / 2;
      return st.need;
    }
    // starters filled: still worth something while a flex slot is open, then a penalty
    if (['RB', 'WR', 'TE'].includes(pos)) return pool < req ? st.need / 2 : -st.need / 2;
    return -st.need / 2;
  };

  for (const r of rows) {
    r.vorPct = r.vor > 0 ? (r.vor / mx) * 100 : (r.vor / Math.abs(mn)) * 25;
    // Kickers and defences have no stats we rate, so every component sits at a flat 50
    // and only the projection percentile moves. That is not a rating - it is "he is the
    // 3rd best defence" dressed up on the same 0-100 scale a receiver uses, which made
    // the best defence read 56 and look like a real opinion. There isn't one, so say so.
    r.rated = (data.ratePos || RATE_POS).includes(r.p.pos);
    // And a man with no season does not get an average of the stats he has not got. He
    // gets the rookie rating - his projection, where he was drafted, and how much of his
    // team's work he has been handed - which is all there honestly is.
    r.rating = !r.rated ? null
      : noSeason(r.p) ? rookieRating(r.p, r.scores.projection)
        : Object.entries(cw).reduce((a, [k, w]) => a + (r.scores[k] ?? 50) * w, 0) / cwTotal;
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
    // An unrated man gets pure value. Tilting him by a number built from absent data
    // would be inventing an opinion and then acting on it.
    const lean = r.rated
      ? st.tilt * 40 * ((r.rating - 50) / 50) + FIT_BAND * ((r.fit - 50) / 50)
      : 0;
    let s = (r.vorPct + lean) * posx + r.need;
    // An extra nudge for rookies, ON TOP of a rating that already counts where he was
    // drafted. Deliberately small for that reason.
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

  for (const r of rows) r.tags = fitTags(r, st, league, pg);

  markTiers(rows);

  const adpOrder = [...rows].sort((a, b) => a.p.adp - b.p.adp);
  adpOrder.forEach((r, i) => { r.adpRank = i + 1; });

  valueWindow(rows);
  // Last, because it needs the window, the ADP rank and the pick on the clock. It is the
  // one label that changes as the draft moves - a man who is a reach at pick 4 is a steal
  // at pick 40 without anything about him having changed.
  for (const r of rows) r.kind = pickType(r, st.atPick);

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
// How far before his window a man can be and still count as a reach rather than as
// simply not in range yet. At pick 5, taking the 100th player is technically a reach, but
// labelling two hundred rows "Reach" tells you nothing.
// 24 is where the label mix on the visible board is most informative: measured over the
// 307-player pool at picks 1/12/24/40/60/90, shrinking it to 16 pushes half the screen to
// no verdict at all, and stretching it to 40 turns 94% of the screen into "Reach", which
// is true but says nothing. 24 sits at the peak of that trade-off. It is tuned for
// readability, not fitted to any outcome - nothing here forecasts.
export const REACH_RANGE = 24;
// Being one pick early is not a reach, it is a rounding error. Below this the honest
// answer is "about right", which is what Safe and Swing say.
// Raised from 3 to 4: at 3 only ~12% of the visible board was ever priced "about right",
// so the two labels that describe a player rather than a price almost never showed. 4
// widens that to ~14% without thinning out Steal, which 5 does (23 down to 13).
export const SLACK = 4;

export function pickType(r, atPick) {
  // Before the draft starts there is no clock, so judge him against where the room takes
  // him. Once picks are coming in, judge him against the pick actually on the clock -
  // which is what makes this move as the board empties.
  const at = atPick || r.adpRank;

  if (!r.openEnded && at - r.worthTo >= SLACK) return 'steal';  // fallen past his range
  const early = r.worthFrom - at;
  if (early >= SLACK) {
    return early <= REACH_RANGE ? 'reach' : null;          // else: simply not in range yet
  }

  // He is in his window, so the price is settled and the only question left is what kind
  // of player he is. This ALWAYS answers: a man who is correctly priced right now must
  // never render as a dash, because a dash reads as "no opinion" when the opinion is
  // "take him". The old test was two independent absolute cuts (td >= 62, dur >= 50) and
  // left a dead zone 25% of the pool wide that fell through to null.
  //
  // The cut now is where the two traits cross. Both are percentiles WITHIN position, so
  // "his points are lumpier than he is durable" is a statement about him against his own
  // peers, and the split point is a property of the data rather than a number picked out
  // of the air. Kickers and defences tie at 50/50 on both - there is no touchdown share
  // or games history for them - so they fall to Safe. That is the deliberate direction:
  // bust rate repeats year to year and boom rate does not, so an unmeasured player gets
  // the floor label, never the ceiling one.
  return (r.traits?.td ?? 50) > (r.traits?.dur ?? 50) ? 'swing' : 'safe';
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
// Score points inside which two players are a coin flip. Still a guess - it decides what
// "equally happy" means and there is no outcome to fit it against. Left at 2.5 because
// that keeps the median window across the top 60 at 3 picks wide; at 4 it becomes 8,
// which claims an indifference the scores do not support.
export const WINDOW_BAND = 2.5;
// Deep in the pool the scores flatten and a run of coin flips can be a hundred players
// long. That is true - pick 200 and pick 260 really are interchangeable - but a window
// that wide tells you nothing, and it would let a man 90 picks away read as a bargain.
// Past this the window is marked open-ended and shown as "180+" instead of pretending.
//
// Raised from 30 to 45. At 30, 131 of 307 players came out open-ended - and open-ended
// does not merely change how the Worth column prints, it switches OFF the steal test
// entirely (a truncated window cannot be sold as a bargain). So 43% of the pool could
// never be called a Steal no matter how far he fell, which is an artefact of the cap
// rather than anything about the player. 45 cuts that to 69 of 307. Going further to 60
// gets it to a handful, but a 60-pick window is most of the visible board and stops
// meaning anything.
export const WINDOW_MAX = 45;

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
// A plain-English read of what the current weights mean, for the ratings editor.
export function priorityOrder(data, st) {
  const cw = componentWeights(st);
  return data.components
    .map((c) => ({ label: c.label, w: cw[c.key] || 0 }))
    .filter((c) => c.w > 0)
    .sort((a, b) => b.w - a.w);
}
