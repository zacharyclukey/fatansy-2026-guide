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
  anchor: ANCHOR_DEFAULT,   // how much the room counts. See ANCHOR_CASES.
  // Your three preferences, each -100 (hard left) to +100 (hard right), 0 = no opinion.
  // They break ties between players you would be roughly equally happy with. They are
  // not a forecast and the app says so.
  fit: { td: 0, asc: 0, dur: 0, pen: 0 },
  fitExtra: {},       // extra scoring keys you have added to a point-based axis
  fitOn: true,
  // How much time you assume players miss. See DUR_ANCHORS. Defaults to the middle stop,
  // which is what the app silently assumed before the dial existed, so nobody's board
  // moves on the day this shipped.
  durAnchor: DUR_DEFAULT,
  need: 8,            // draft-score bonus for a position you still need
  style: 50,          // 0 = safest floor, 100 = highest ceiling
  rookie: true,       // pay up for rookies you trust
  // Was 10, which is the whole of the need bonus. It could afford to be that big when the
  // rookie rating was invented nonsense and this was the only thing pricing a rookie at
  // all. Now that draft capital is 30% of his actual rating, +10 on top is the same fact
  // counted twice - it put a quarterback projected 84 points below replacement at pick 80.
  //
  // Then 4, by taste. Now 3, by measurement: with the anchor in, this is the value that
  // lands men with no prior season where the room actually takes them. Measured on both
  // real leagues at the default anchor, as an average gap in places between board rank and
  // ADP rank (+ = the board is keener than the room):
  //     rookieMax 0   -4.3 / -4.6      removed entirely, the board is now too harsh
  //     rookieMax 2   -0.6 / -0.4
  //     rookieMax 3   +1.2 / +1.2      <- here
  //     rookieMax 4   +2.8 / +3.1      the old value
  // So it still earns its place, at a size that is now fitted to something rather than
  // chosen. See ANCHOR_CASES for why the anchor does not simply absorb it: the anchor is
  // per-player and only pulls a man toward where HE is drafted, which leaves an
  // across-the-board level that this sets.
  rookieMax: 3,
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

// A percentile is a poor description of a stat with two values in it. In this league a
// receiver either lost a fumble or did not, which is 2 points across a whole season
// against a 250-point projection - and the tie structure meant the clean majority
// collapsed into one block that never reached the top decile while the fined minority got
// branded. Thirty-four men were told they give points back and three were told they were
// clean, off a difference of two points.
//
// So the mistake tag is gated on the SIZE of the fine, not on rank. Below this it is
// rounding and there is nothing worth saying. Quarterbacks are the only position with
// real exposure here, which is the correct answer rather than a special case.
export const PEN_MATERIAL = 6;         // points across a season
export const PEN_SHARE = 0.02;         // and at least this much of his projection

export function penMaterial(p, league, st, pts) {
  const fine = riskPoints(p, league, st);
  const total = pts || projectedPoints(p, league);
  return fine >= PEN_MATERIAL && total > 0 && fine / total >= PEN_SHARE;
}

// The worst fine anyone at this position is exposed to. "Clean" is only worth printing
// where being fined was a real possibility - telling a receiver he is clean in a league
// that could only ever have cost him two points is as empty as the other direction.
export function penCeiling(players, league, st) {
  const out = {};
  for (const p of players) {
    if (!RATE_POS.includes(p.pos)) continue;
    const fine = riskPoints(p, league, st);
    if (fine > (out[p.pos] || 0)) out[p.pos] = fine;
  }
  return out;
}

export function fitTags(r, st, league, games, penTop, repl) {
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
    // Mistakes only get a label when the points involved are worth a sentence. Both ends:
    // calling a man "clean" is equally empty in a league where nobody loses anything.
    if (a.key === 'pen') {
      const isClean = pick === (FIT_TAGS.pen || [])[0];
      // clean: the position has to have had something to lose. fined: HE has to have lost it.
      // Clean has to mean "a starter who does not give points back". Without the
      // replacement check it meant "a man who does not play": the three cleanest
      // quarterbacks in the pool were backups projected for almost nothing, who throw no
      // interceptions for the same reason they throw no touchdowns.
      const worth = isClean
        ? (penTop?.[r.p.pos] || 0) >= PEN_MATERIAL && r.pts > (repl?.[r.p.pos] ?? 0)
        : penMaterial(r.p, league, st, r.pts);
      if (!worth) continue;
    }
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
        : a.key === 'pen'
          ? `${Math.round(riskPoints(r.p, league, st))} points fined over a season`
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
// rather than a fixed haircut. Nobody can tell you which setting is true. What the app can
// do is show you the number each assumption produces and let you pick the one you are
// willing to be wrong about.
export const FULL_GAMES = 17;
export const DRAFTABLE = 36;

// The dial, in four stops, written out for the first time. It was described in this
// comment for weeks and never actually existed: `availableShare` quietly hardcoded the
// middle one, so the "assumption you have set" that the explanations kept referring to was
// not settable. It is now.
//
// The stops are not four severities of the same question. `typical` and `own` are
// genuinely DIFFERENT questions - one asks what an average draftable man plays, the other
// asks what THIS man played - and for a durable player they point opposite ways. Only the
// two ends are ordered: `full` is the most optimistic reading available and `cautious` the
// least, because it refuses to give anybody the benefit of the doubt in either direction.
//
// Every stop is computed off the shipped data. None of them is a fitted number and none
// forecasts: this is a question about what YOU are willing to assume, and the app's whole
// job is to price the consequences of your answer rather than to answer for you.
export const DUR_ANCHORS = [
  { key: 'full', short: 'Nobody gets hurt',
    label: 'Assume everyone plays all 17 games',
    blurb: 'Take every projection exactly as it is published. This is the most optimistic '
      + 'reading there is, and it is the one the raw numbers already make.' },
  { key: 'typical', short: 'An average amount of time missed',
    label: 'Assume everyone misses what a typical player misses',
    blurb: 'The average draftable player over the last six years, measured off this data '
      + 'file rather than assumed.' },
  { key: 'own', short: 'As much time as he missed last year',
    label: 'Assume everyone misses what he himself missed',
    blurb: 'Games played repeat year to year, but only weakly (0.27 at back, 0.29 at '
      + 'receiver, 0.31 at tight end, 0.56 at quarterback). A lean, not a law. A man with '
      + 'no last season counts as average rather than as a risk.' },
  { key: 'cautious', short: 'The gloomiest of the two',
    label: 'Assume the worse of those two, for everybody',
    blurb: 'Nobody gets the benefit of the doubt: a player who has missed time is assumed '
      + 'to keep missing it, and one who has not is still only assumed to be average.' },
];
export const DUR_DEFAULT = 'typical';
export const durAnchor = (key) => DUR_ANCHORS.find((x) => x.key === key)
  || DUR_ANCHORS.find((x) => x.key === DUR_DEFAULT);

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

// How many games ONE man is assumed to play, under the stop you have the dial set to.
// This is the only place the four anchors turn into a number, so everything downstream -
// the handcuff price, the pooled availability, the words on the card - moves together and
// cannot disagree with itself.
export function expectedGames(p, games, anchor = DUR_DEFAULT) {
  // A kicker cannot pull a hamstring in any way this data would record, and a defence
  // cannot get hurt at all. They have no availability signal, so no anchor may invent one
  // for them - the same call injuryGap already makes, for the same reason.
  if (!RATE_POS.includes(p.pos)) return FULL_GAMES;
  const typical = games?.league ?? FULL_GAMES;
  const own = ownGames(p, games);
  const clamp = (g) => Math.max(0, Math.min(FULL_GAMES, g));
  if (anchor === 'full') return FULL_GAMES;
  if (anchor === 'own') return clamp(own);
  if (anchor === 'cautious') return clamp(Math.min(own, typical));
  return clamp(typical);
}

// The same question asked of the POOL rather than of a man: across draftable players, what
// share of a season is one of them available for? This is what decides how often the men
// ahead of somebody on YOUR bench are all unavailable at once, which is a different
// population from any single starter and so deserves its own number.
//
// Averaged over the real pool rather than reasoned about, because for `cautious` there is
// no closed form - it is the mean of a per-man minimum - and guessing at it would be
// exactly the invented constant the rest of this file refuses to carry.
export function poolAvailable(players, games, anchor = DUR_DEFAULT) {
  if (anchor === 'full') return 1;
  const list = (players || []).filter((p) => RATE_POS.includes(p.pos)
    && p.m && p.m.has2025 && p.m.games_2025 != null);
  if (!list.length) return availableShare(games, anchor);
  const mean = list.reduce((a, p) => a + expectedGames(p, games, anchor), 0) / list.length;
  return Math.max(0.05, Math.min(1, mean / FULL_GAMES));
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
//
// KEPT, after the ADP anchor arrived and this was retested to see whether the anchor had
// made it redundant. It has not. With it removed (depth 1) and the anchor at its default,
// the top three kickers and defences come out 4 places behind the room in one league and
// 17.7 places AHEAD of it in the other, and a defence climbs into the top 100. The anchor
// pulls a man toward where HE is drafted; it cannot express "the whole position is
// streamable", because that is a claim about the waiver wire and not about any player.
//
// It is also the one number here still set by judgement rather than fitted to anything.
// 0.5 says a top-six defence is free on waivers in any given week. That is a strategy
// claim, it is widely held, and nothing in this repo's data can test it - the data has no
// waiver wire in it. Said plainly so nobody mistakes it for a measurement.
export const STREAM_DEPTH = 0.5;

// ---------------------------------------------------------------- the ADP anchor
//
// VOR is a pure projection statement. It is very good at "how many points above an
// ordinary starter", and it knows NOTHING about what a draft looks like. Every place the
// board has misbehaved has been the same failure wearing a different hat:
//
//   - kickers and defences, whose replacement level is a number WE INVENTED. Nobody holds
//     a backup, so there is no honest "last man drafted" to measure against, and whatever
//     we pick instead decides their whole value.
//   - men with no prior season, whose VOR rests on a projection that has never been
//     checked against anything they have actually done.
//
// Each was patched separately - STREAM_DEPTH, rookieMax, and, by accident, the old `tilt`
// multiplier. Tilt did not suppress kickers because the grade understood kickers; kickers
// got no tilt at all. It suppressed them by INFLATING everybody else, and it penalised
// men with no season only because they happen to grade low. A coincidence doing the work
// of a mechanism, invisible on screen, drifting on every data refresh. It is gone.
//
// The honest fix is to let the room have a vote, because the room has priced these men for
// twenty years. But a FLAT blend is a blunt instrument, because there are two kinds of
// disagreement with the market and they deserve opposite treatment:
//
//   - disagreements where WE are right. Zach's leagues pay for first downs and 40-yard
//     catches; ADP is built on default scoring. That gap is the entire point of having a
//     board, and it must survive.
//   - disagreements where WE are wrong. An invented replacement level. An unvalidated
//     rookie projection.
//
// A flat weight doses both the same and quietly sells the edge to fix the bugs. So the
// weight is set by CONFIDENCE, per player, with the three cases written out here rather
// than buried in four separate constants - four buried constants are what caused this.
export const ANCHOR_CASES = {
  // Heavy. There is no defensible replacement level here, so the market is simply better
  // informed than we are.
  stream: 1,
  // Moderate. The projection is a real forecast, it is just an unchecked one.
  noSeason: 0.5,
  // Light. This is where the scoring quirks live and where the board has earned the right
  // to disagree. Not zero: the market still knows about camp, holdouts and depth charts
  // that no projection has caught up with.
  known: 0.1,
};
// The control that scales all three, and the default is set by a rule rather than a taste.
//
// The yardstick is where the room actually drafts these men: the first defence goes 113th
// and the first kicker 126th. Measured across all three real leagues plus the neutral
// sample league, agreement with that yardstick improves at EVERY step of the dial, right
// up to 1.0 - which is only to say that for kickers and defences our model is worth
// nothing and copying the market is strictly better. Left alone, that argument takes the
// dial to the top.
//
// What stops it is the second cost. Steal and reach are measured by comparing the board
// WITH ADP, so the more ADP is inside the board the more that comparison talks to itself;
// past about 30% of the board's weight, "steal" stops meaning anything. So: take the
// highest dial whose board-wide effective weight stays at or under 25% - a clear margin
// under 30%. That is 0.7 (23%); 0.8 would be 26%, over the line.
//
// At 0.7 the first defence lands 106th / 130th / 102nd against a market that takes one
// 113th, and the first kicker 142nd / 145th / 152nd against 126th. With the anchor off
// those were 92nd / 162nd / 95th and 177th / 191st / 202nd - a board that could not decide
// whether a defence was a 9th-rounder or undraftable, depending on which league you opened.
export const ANCHOR_DEFAULT = 0.7;
// Where the steal/reach comparison stops being worth much, as a share of the whole board
// rather than as a dial position - a dial of 0.7 only reaches 23% of the board because
// most of the board is established skill players, who barely feel it. Warned about on
// screen, using the real figure for the pool in front of you.
export const STEAL_DILUTION = 0.3;
// Taken from the MIX of the pool times the dial, rather than by averaging the weight
// already on the rows. The mix - how much of this pool is kickers, rookies and settled
// players - does not depend on the dial, so this answers for the setting being asked
// about instead of for the board still on screen. The readout is written before the
// rebuild finishes, so averaging the live rows was always one drag behind, and the warning
// never appeared at the setting that earned it.
export const anchorReach = (rows, st = {}) => (rows.length
  ? (st.anchor ?? ANCHOR_DEFAULT)
    * (rows.reduce((a, r) => a + ANCHOR_CASES[r.anchorCase ?? anchorCase(r.p)], 0) / rows.length)
  : 0);

// Which of the three cases a man falls into. One function, so the board, the tests and
// the explanation all read the same rule.
export function anchorCase(p) {
  if (STREAMED.includes(p.pos)) return 'stream';
  if (noSeason(p)) return 'noSeason';
  return 'known';
}
// An extra nudge for rookies, ON TOP of a grade that already counts where he was drafted.
// Deliberately small for that reason, and see the note on rookieMax in DEFAULT_SETTINGS.
export function rookieBonus(p, st = {}) {
  const c = p.m?.rookie_conf || '';
  const conf = c.startsWith('HIGH') ? 1 : c.startsWith('MED') ? 0.6 : 0.3;
  return (st.rookieMax ?? 0) * conf;
}

export function anchorWeight(p, st = {}) {
  const dial = st.anchor ?? ANCHOR_DEFAULT;
  return Math.max(0, Math.min(1, dial)) * ANCHOR_CASES[anchorCase(p)];
}

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

// What you could add for FREE at each position, in projected points.
//
// Replacement level above answers "who would I have to start instead" on draft day. For a
// man who is already past your starting slots that is the wrong counterfactual, and Zach
// named the right one: if you do not roster a second tight end, you do not field an empty
// tight end slot in week 8 - you add one off waivers. So what a bench body is really worth
// is what he beats a free add by, and that differs enormously by position.
//
// The trap here would be a hand-tuned depth per position, which is the kind of constant
// this project has deleted twice. It is not needed, because ADP already measures the thing:
// it says exactly how deep the room drafts each position. In a 12-team league the market
// takes about fourteen quarterbacks and fourteen tight ends - barely more than the twelve
// that start, because everybody already knows they are replaceable - and sixty-odd backs
// and seventy-odd receivers. So the best UNDRAFTED man is nearly as good as a startable
// tight end and nothing like a startable back. That is the whole of Zach's argument, and
// it falls out of the market rather than out of an opinion.
//
// It is deliberately optimistic about the wire: the best man nobody drafted is gone by
// week two in a real league. An optimistic waiver level makes every bench player look
// WORSE, so the bias runs against the change this was written for rather than flattering
// it - which is the direction to be wrong in.
export function waiverLevels(players, league, ptsOf = projectedPoints) {
  const spots = (league.teams || 12) * roundsOf(league);
  const shares = flexShares(players, league);
  const slots = startableSlots(league, shares);
  const out = {};
  for (const pos of Object.keys(league.starters || {})) {
    if (pos === 'FLEX') continue;
    const here = players.filter((p) => p.pos === pos && inLeague(p, league));
    const list = here.map((p) => ptsOf(p, league)).sort((a, b) => b - a);
    if (!list.length) { out[pos] = 0; continue; }
    // How many the room actually drafts. Positions with no ADP in the file at all (some
    // files carry none for defences) fall back to "everyone starts one and nobody keeps a
    // spare", which is the same claim STREAM_DEPTH already makes about them out loud.
    const taken = here.filter((p) => p.adp && p.adp <= spots).length;
    const floorN = Math.ceil((slots[pos] ?? 1) * (league.teams || 12));
    const n = Math.min(list.length - 1, Math.max(floorN, taken));
    // smoothed across three ranks, so one odd projection cannot set the baseline
    const win = list.slice(n, Math.min(list.length, n + 3));
    out[pos] = win.length ? win.reduce((a, b) => a + b, 0) / win.length : list[list.length - 1];
  }
  return out;
}

// Only the POSITIVE half of the surplus is discounted by how often he actually reaches your
// lineup, and this asymmetry is load-bearing rather than tidy. Discounting both halves was
// tried: it multiplies a NEGATIVE surplus by a fraction, so a receiver 28 points below the
// bar who plays 61% of weeks scored -17 where playing every week would have scored -28.
// Being less available made him better, and the plan took a tight end at five bench picks
// in a row. Above the bar the surplus is an option and scales with the chance of exercising
// it; below the bar it is a plain statement of how far short of a free add he is, which
// availability cannot improve.
export function benchOverWaiver(pts, waiver, chance) {
  const surplus = pts - (waiver || 0);
  return surplus >= 0 ? chance * surplus : surplus;
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

  // ---- what actually reaches your lineup ------------------------------------------
  // VOR prices a man against the one you would otherwise START. That is the right question
  // right up until your slots at his position are full, and then it quietly becomes the
  // wrong one - which is how a fourth tight end came to outrank a handcuff, and how the
  // practice room came to draft four of them. From here the board asks the honest version
  // of the question instead: how much of him ends up in your lineup, and what job is he
  // doing when he gets there. See the long note above benchWorth.
  //
  // This is the only roster-aware number on the board and it changes as you draft, exactly
  // like the need bonus below it. It does NOT touch `pts`: the projection on screen is
  // still the projection, which is the rule everything else here obeys.
  const inLeaguePlayers = data.players.filter((p) => inLeague(p, league));
  const shares = flexShares(inLeaguePlayers, league);
  const slots = startableSlots(league, shares);
  // The availability assumption you have set, reaching the two places it belongs: the pool
  // (how often the men ahead of somebody on your bench are all out at once) and each
  // individual starter (how long his backup's job is open). Same dial, two populations.
  const anchor = st.durAnchor || DUR_DEFAULT;
  const avail = poolAvailable(inLeaguePlayers, pg, anchor);
  // What a free add is worth at each position - the bar every bench body is measured
  // against. See waiverLevels.
  const waiver = waiverLevels(inLeaguePlayers, league);
  const byId = new Map(inLeaguePlayers.map((p) => [p.id, p]));
  const chart = new Map();
  for (const [id, hc] of depthChart(inLeaguePlayers, league)) {
    // Deliberately still the STARTER bar, not the waiver bar, and this was tried the other
    // way and reverted. Pricing the job over a free add lowers the bar (QB 296 -> 246) and
    // therefore RAISES what insuring a quarterback appears to buy, which put backup
    // quarterbacks into the top five handcuffs - the exact inversion the handcuff pricing
    // was written to prevent.
    //
    // The reason it inverts is a separate weakness worth naming: jobGain credits the heir
    // with hc.leadPts, the LEAD man's points, as though a backup inherits an elite starter's
    // production rather than his snaps. The high bar was quietly cancelling that error out.
    // Fixing the bar without fixing the credit just exposes it, so both stay as they were
    // until the credit itself is dealt with. The waiver bar below is about bench bodies,
    // which is what was actually asked for.
    chart.set(id, handcuffValue(hc, repl, pg, byId.get(hc.leadId), anchor));
  }
  const mineIds = new Set(st.mineIds || []);
  const queue = {};                     // how many of each position you already own
  for (const q of st.mine || []) queue[q] = (queue[q] || 0) + 1;

  const rows = inLeaguePlayers
    .map((p) => {
      const pts = projectedPoints(p, league);
      p._games = ownGames(p, pg);
      const hc = chart.get(p.id) || null;
      // Kickers and defences are asked the same question as everybody else, and they should
      // be. A kicker with an empty kicker slot is certain to be in your lineup, so the
      // question costs him nothing; a SECOND kicker plays 17% of the season, and without
      // asking, he came out as the best thing on the board once every other position had
      // been honestly discounted. When a kicker goes is a matter of timing and is handled
      // by the need bonus below, which holds him back until the picks run out.
      const bw = benchWorth(pts, (queue[p.pos] || 0) + 1, slots[p.pos] ?? 1, avail,
        hc, !!hc && mineIds.has(hc.leadId));
      const lineup = bw.worth;
      const vor = pts - (repl[p.pos] || 0);
      // WHICH BAR HE IS MEASURED AGAINST, and this took three wrong answers to get right.
      //
      // Replacement level asks "who would I have to START instead". That is the right
      // question for a man walking into your lineup and the wrong one for a bench body,
      // twice over. Using his own position's bar punished a handcuff for backs having a
      // high replacement level and rewarded a fourth tight end for tight ends having a low
      // one - neither fact being about either man. Weighting the bar by his chance of
      // playing looked more principled and was worse: it multiplies a NEGATIVE surplus by a
      // fraction, so a receiver 28 points below replacement who plays 61% of weeks scored
      // -17 while playing every week would have scored -28. Being less available made him
      // better. It handed the plan a tight end at five bench picks in a row.
      //
      // The fourth answer, and the one Zach asked for: once your slots at his position are
      // full, the alternative to rostering him is not an empty slot, it is a FREE ADD at his
      // own position. So the bar is the waiver level there.
      //
      // This supersedes the one-shared-bar reading above rather than contradicting it. That
      // reading was right that bench slots are fungible and every candidate competes for the
      // same slot - but the thing that makes them comparable in it is how much each beats
      // the free alternative to himself, and those alternatives are wildly unequal. A second
      // tight end is competing with a tight end who is nearly as good and costs nothing; a
      // fourth back is competing with a free back who is far worse. One shared bar took the
      // flex positions' replacement levels, which sit within three points of each other
      // (RB 125, WR 128, TE 127), and so said the two situations were identical. They are
      // not, and the difference is the whole reason late tight ends kept winning picks.
      // Kickers and defences are held over a free add ALWAYS, empty slot or not, because
      // that is the one case where the alternative never stops being the wire - you only
      // ever start one and a usable one is free every week. Everyone else gets the free-add
      // bar only once their slots are full.
      //
      // Their bar is the HARSHER of the two, and that is not belt-and-braces. The ADP waiver
      // level is "the best man nobody drafted", around the 14th defence, which is the right
      // reading for a position you hold one of all season. It is the wrong reading for one
      // you rotate weekly: if a top-six defence is free in any given week then the thing you
      // are really choosing against is the sixth, not the fourteenth. STREAM_DEPTH says that
      // and the ADP count cannot, so taking the max keeps it. Swapping to the softer bar
      // would make kickers and defences look BETTER, which is how this exact bug shipped
      // once before.
      const streamed = STREAMED.includes(p.pos);
      const fillsSlot = (queue[p.pos] || 0) < (slots[p.pos] ?? 1);
      const freeAdd = streamed
        ? Math.max(repl[p.pos] || 0, waiver[p.pos] || 0)
        : (waiver[p.pos] || 0);
      const plainVor = (fillsSlot && !streamed) ? lineup - (repl[p.pos] || 0)
        : benchOverWaiver(pts, freeAdd, bw.chance);
      // And the one case that shared bar cannot price. A handcuff's gross worth is small
      // because he is projected low by definition, so subtracting a starting back's
      // replacement level from it buries him beneath men who will never reach your lineup -
      // the exact fault this whole section was written to fix, reappearing one step later.
      // His `gain` is already net of what you would otherwise have started, so it is
      // compared against the bar rather than run through it. Whichever reading is kinder to
      // him wins, because both are true statements about the same player and the board
      // should take the better of them rather than the first one written.
      //
      // The guard is not tidiness. Written as a plain Math.max against zero it also floored
      // everybody ELSE at zero, and below replacement this board deliberately keeps an
      // ordered band rather than a floor - clamping there once put 142 of 259 players on the
      // same score. The simulator caught it immediately: with the band flattened the room
      // could no longer tell one bench receiver from another and reached 49 picks early for
      // one. Only a man with something to inherit is allowed near this.
      const benchVor = bw.gain > 0 ? Math.max(plainVor, bw.gain) : plainVor;
      const cached = cache?.get(p.id);
      const scores = cached ? { ...cached } : (() => {
        const s = {};
        for (const c of comps) {
          s[c.key] = c.key === 'projection' ? null : componentScore(p, c, st);
        }
        return s;
      })();
      scores.floorish = floorScore(scores);   // display only, never weighted
      return { p, pts, vor, benchVor, scores, hc, lineup, hcGain: bw.gain || 0,
        mineLead: !!hc && mineIds.has(hc.leadId) };
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
  //
  const mx = Math.max(...rows.map((r) => r.vor), 1);
  const mn = Math.min(...rows.map((r) => r.vor), -1);
  for (const r of rows) {
    r.vorPct = r.vor > 0 ? (r.vor / mx) * 100 : (Math.max(r.vor, mn) / Math.abs(mn)) * 25;
  }


  // What you already have, so the board can nudge you toward what you still need.
  const have = queue;
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
    // Starters filled. There used to be a second rule here - half a bonus while a flex slot
    // stood open, a half penalty after - and it was a crude stand-in for the question the
    // VOR above now answers properly. Keeping both would charge a surplus tight end twice
    // for the same fact, once in points and once in bonus. The bonus is only ever "fill
    // your named slots first" now; how much a spare body is worth is priced, not nudged.
    return -st.need / 2;
  };

  for (const r of rows) {
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
    // The grade does NOT vote. It used to, through a `tilt` multiplier worth up to +/-20
    // points of score, and that was wrong twice over. Measured across five seasons the
    // grade showed ZERO lift over the projections on its own; and its one genuinely
    // predictive ingredient - the projection percentile - is already the whole of VOR, so
    // tilting double-counted the half that works and added the half that does not. The
    // grade still computes, still draws its bars on the player card, and still answers
    // "is he good for a tight end". It just does not get to move where he is drafted.
    //
    // Fit is ADDED, not multiplied: multiplying erases a preference when VOR is 0 and
    // inverts it when VOR is negative. It is capped at FIT_BAND points so it can only ever
    // reorder players the value numbers were close to indifferent about. That cap is the
    // honest part - nothing here beat the projections in five years of testing, so it does
    // not get to outvote them. An unrated man gets no Fit at all: leaning on a number
    // built from absent data is inventing an opinion and then acting on it.
    const lean = r.rated ? FIT_BAND * ((r.fit - 50) / 50) : 0;
    // The score BEFORE the room gets a vote. Everything the board knows on its own ends
    // here, and the anchor below is a shift applied to it.
    r.preScore = (r.vorPct + lean) * posx + r.need
      + (st.rookie && r.p.rookie ? rookieBonus(r.p, st) : 0);

    // The same score, asked the roster-aware question: how much of him reaches YOUR
    // lineup, and what job is he doing when he gets there. See the note above benchWorth.
    //
    // It is a SECOND number rather than a replacement for the first, and deliberately so.
    // The board you read is a ruler - it says what a man is worth, full stop, and it must
    // not move under you because you made a pick. Putting the discount straight into `vor`
    // was tried and measured: with seven starting slots filled, most of the board fell
    // below a kicker you are obliged to start, and 43 kickers and defences climbed into the
    // top hundred. True in a narrow sense, useless on a screen. So the ruler stays raw and
    // the ADVICE - planDraft, and therefore the recommendation panel and the auto-drafter -
    // reads this one, which is the only place the question "what should I do with THIS
    // pick, holding THIS roster" is actually being asked.
    // ONE slope, all the way down, unlike the raw scale above. The raw board squashes
    // everything below replacement into a 25-point band, which is right for a ruler nobody
    // reads the bottom of and fatal here: on the bench EVERY man is below replacement, so
    // the squash made a point of value worth a fifth of what it is worth up top while
    // leaving your ratings at full size. Measured: a receiver worth 84 points to the lineup
    // came out below one worth 66, on ratings alone. A point is a point on this scale.
    const bPct = (r.benchVor / mx) * 100;
    // Your ratings and preferences are an opinion about how good he is PER GAME, so they
    // count in proportion to the games he plays for you. Left at full size they decided the
    // whole bench: down in the discounted band the value differences are a point or two
    // while a lean is worth twenty, and the plan put a receiver with a lineup value of 66
    // ahead of one worth 84 purely on the ratings. Same size as the thing it is adjusting.
    const share = r.pts > 0 ? Math.max(0, Math.min(1, r.lineup / r.pts)) : 1;
    r.preBench = (bPct + lean * share) * posx + r.need
      + (st.rookie && r.p.rookie ? rookieBonus(r.p, st) : 0);
  }

  // ---- the room's vote ------------------------------------------------------------
  //
  // Anchoring only means anything if both sides are measured on the SAME ruler, and the
  // first cut of this got that wrong: it blended ADP into `vorPct` and then added the need
  // bonus afterwards, so a defence carrying a -4 need penalty was compared against a scale
  // that knew nothing about need. He came out 50 places below where the anchor was
  // supposedly pulling him, and the control appeared to push kickers DOWN while claiming
  // to defer to a room that drafts them higher.
  //
  // So the scale is the board's own finished pre-anchor score, and the map is by rank:
  // the man the room takes 113th is worth whatever OUR 113th-best man is worth. A player
  // the room agrees with then scores identically either way and does not move at all,
  // which is the only thing "anchor" can honestly mean. It also sidesteps the shape
  // problem - a raw ADP percentile is uniform while board scores are heaped up at the
  // bottom, and blending those directly would rewrite the shape of the board rather than
  // anybody's place on it.
  const scale = rows.map((r) => r.preScore).sort((a, b) => b - a);
  [...rows].sort((a, b) => (a.p.adp ?? 9e9) - (b.p.adp ?? 9e9))
    .forEach((r, i) => { r.adpScore = scale[i]; });
  for (const r of rows) {
    r.anchorW = anchorWeight(r.p, st);
    r.anchorCase = anchorCase(r.p);
    // Kept as a SHIFT rather than folded into a blend, because the same correction has to
    // reach two numbers: the board, where it is exactly (1-w)*ours + w*theirs, and the
    // roster-aware bench score below, which runs on its own slope. Applying the same
    // points of correction to both is what stops the recommendation panel disagreeing with
    // the board it is reading - which is the bug this whole change exists to close. It is
    // deliberately NOT scaled by playing time down there: it is not an opinion about how
    // good he is per game, it is a correction to a value estimate we do not trust.
    r.anchorAdj = r.anchorW * (r.adpScore - r.preScore);
    r.score = r.preScore + r.anchorAdj;
    r.benchScore = r.preBench + r.anchorAdj;
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

  const penTop = penCeiling(data.players, league, st);
  for (const r of rows) r.tags = fitTags(r, st, league, pg, penTop, repl);

  markTiers(rows);

  const adpOrder = [...rows].sort((a, b) => a.p.adp - b.p.adp);
  adpOrder.forEach((r, i) => { r.adpRank = i + 1; });

  valueWindow(rows);
  // Last, because it needs the window, the ADP rank and the pick on the clock. It is the
  // one label that changes as the draft moves - a man who is a reach at pick 4 is a steal
  // at pick 40 without anything about him having changed.
  for (const r of rows) r.kind = pickType(r, st.atPick);

  // RB1 means the best running back on the board. Everyone uses it that way, so it is
  // read off board order - the same order the rows are in. It is NOT the grade ranking
  // below: Jahmyr Gibbs is the first back on the board and the second by grade, and
  // showing "RB2" beside "#1 on your board" reads as a contradiction rather than as two
  // different questions.
  const seenPos = {};
  for (const r of rows) {
    seenPos[r.p.pos] = (seenPos[r.p.pos] || 0) + 1;
    r.posRank = seenPos[r.p.pos];
  }

  // where the grade alone would have put him, so the detail panel can show the gap
  // between "good for his position" and "worth this pick"
  const byPos2 = {};
  for (const r of rows) (byPos2[r.p.pos] ||= []).push(r);
  for (const list of Object.values(byPos2)) {
    list.sort((a, b) => b.rating - a.rating);
    list.forEach((r, i) => { r.posRated = i + 1; r.posCount = list.length; });
  }

  // `games` goes out with the board because the availability assumption is a thing the
  // screen has to be able to show three ways - full season, what his position usually
  // plays, what HE has played - and recomputing it outside here would be a second copy of
  // the same sum drifting away from this one.
  // `shares` and `waiver` travel with the board because everything downstream that reasons
  // about roster shape needs them and nothing downstream can cheaply recompute them.
  // capsOf(league) without shares hands a whole flex slot's worth of rope to EVERY
  // flex-eligible position, so tight ends came out capped at three in a one-tight-end
  // league instead of two - which is most of why the room kept stacking them.
  return { rows, repl, league, weights: cw, games: pg, shares, waiver };
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

// ---------------------------------------------------------------- the bench
// WHY THIS EXISTS. Score is Value Over Replacement, and VOR is a STARTER'S idea: it prices
// a man against whoever you would otherwise have to start. Once your slots at a position
// are full that framing quietly stops meaning anything, and nothing in the app knew it. A
// fourth tight end can only ever reach your lineup if the first three are all unavailable
// on the same Sunday, and yet the board handed him his full VOR - which, late in a draft,
// is a bigger number than a handcuff's, because a handcuff is projected low BY DEFINITION.
// So the room drafted four tight ends and the recommendation would have told Zach to do
// the same.
//
// The fix is not four new knobs for handcuffs, fliers and rookies. It is one question,
// asked of every bench pick:
//
//     HOW OFTEN WILL HE ACTUALLY BE IN YOUR LINEUP, AND WHAT JOB WILL HE BE DOING?
//
// Both halves come from the ONE thing five years of measurement said was real: players
// miss games, and the entire gap between a projection and a season is games missed. See
// `injuryGap` above and the note on it. Nothing here forecasts a breakout, because boom
// rate does not repeat year to year (measured 0.03-0.12) and pretending otherwise would be
// inventing the same fiction the ratings editor was deleted for.

// Chance a draftable player is available in a given week, measured off the current data
// file rather than assumed. Six years of Sleeper data put draftable men at 13.0 of 17
// games (share 0.24); 2025 alone was healthier at 14.2 (share 0.17). Pooled across
// positions on purpose - the positional durability gap was tested over six seasons and is
// not real, so splitting it would be fitting noise.
// The `anchor` argument is what makes the dial reach this far. At the optimistic stop
// everybody is available every week, so a second tight end is worth nothing at all and the
// board should say so; at the cautious stop the bench starts earning its place.
export function availableShare(games, anchor = DUR_DEFAULT) {
  if (anchor === 'full') return 1;
  const g = Math.max(1, Math.min(FULL_GAMES, games?.league ?? FULL_GAMES - 3));
  return g / FULL_GAMES;
}

// HALF ONE: how often is the j-th man you own at a position actually in your lineup?
//
// You have `s` startable slots there and he is `j`-th in line. He plays in any week when
// fewer than `s` of the men ahead of him are available, so this is a binomial tail and not
// a knob. With s = 1 (tight end) the second man plays 17% of the season, the third 3% and
// the fourth 0.5% - which is the whole answer to "why four tight ends".
//
// `s` is fractional because a flex slot is a fraction of a position; see flexShares.
export function lineupChance(j, s, a) {
  const ahead = Math.max(0, Math.round(j) - 1);
  // P(at most ceil(s)-1 of the men ahead are available), interpolated across the
  // fractional part of s so that a third of a flex slot is worth a third of a slot.
  //
  // There was an `if (ahead < s) return 1` shortcut here and it was the whole bug in
  // miniature. In an 18-team league tight ends win 19% of the flex spots, so s = 1.39, so
  // a SECOND tight end came back "always in your lineup" - and every tight end after him
  // escaped the pricing too, because the room only asked this question of men who were not
  // filling a slot. Measured: it left 35% of rosters three deep at tight end. A fractional
  // slot has to be worth a fraction, including for the man standing in it.
  const lo = Math.floor(s);
  const frac = s - lo;
  const cdf = (k) => {                           // P(Binomial(ahead, a) <= k)
    // a = 1 is a real setting now, not a theoretical edge: the optimistic stop on the
    // durability dial says nobody ever misses a game. The recurrence below multiplies by
    // a/(1-a), so at a = 1 it divided by zero and put NaN into benchVor, which then
    // travelled all the way to a player's rank. With everyone ahead of him always
    // available the answer needs no arithmetic - he plays only if there are fewer men
    // ahead of him than there are slots.
    if (a >= 1) return ahead <= k ? 1 : 0;
    let sum = 0;
    let term = (1 - a) ** ahead;                 // P(exactly 0 available)
    for (let i = 0; i <= k && i <= ahead; i += 1) {
      sum += term;
      term *= ((ahead - i) / (i + 1)) * (a / (1 - a));
    }
    return Math.max(0, Math.min(1, sum));
  };
  const at = cdf(lo - 1);
  return frac > 0 ? at + frac * (cdf(lo) - at) : at;
}

// How many startable slots a position really has, counting its share of the flex.
//
// Derived, never hardcoded. flexFill already works out who actually wins the flex spots
// league-wide once every dedicated slot is filled, and in these PPR leagues the answer is
// blunt: the flex goes 87% to receivers, 13% to backs and 0% to tight ends. So a tight end
// has ONE startable slot, and the old rule - which handed the full flex allowance to every
// flex-eligible position at once, as if you might start two tight ends in two flex spots -
// was granting the same slot away three times over. A TE-premium league would move these
// numbers on its own, which is the point of deriving them.
export function flexShares(players, league, ptsOf = projectedPoints) {
  const flex = (league.starters?.FLEX || 0) * (league.teams || 12);
  const out = { RB: 0, WR: 0, TE: 0 };
  if (!flex) return out;
  const { used } = flexFill(players, league, ptsOf);
  for (const pos of Object.keys(out)) {
    out[pos] = Math.max(0, ((used[pos] || 0) - (league.starters?.[pos] || 0)
      * (league.teams || 12)) / flex);
  }
  return out;
}

export function startableSlots(league, shares) {
  const want = league.starters || {};
  const out = {};
  for (const [pos, n] of Object.entries(want)) {
    if (pos === 'FLEX') continue;
    out[pos] = n + (want.FLEX || 0) * (shares?.[pos] || 0);
  }
  return out;
}

// HALF TWO: what job would he be doing?
//
// There is no depth-chart feed in the data file and there does not need to be one: the
// projections ARE the depth chart. A backup is projected low precisely because he is
// behind somebody, so within one team and one position the best projection has the job and
// the next man down is the one who inherits it. Isiah Pacheco is projected 54 points
// because Jahmyr Gibbs is projected 331; that is the fact, stated twice.
//
// The gap has to be wide before this means anything. Two backs splitting a committee are
// not a starter and a handcuff, and treating them as one would hand a lift to half the
// league.
export const HANDCUFF_GAP = 2.2;      // the lead man must be worth this many times the next
export const HANDCUFF_MIN = 40;       // and the job itself has to be worth having

// How many men at a position hold a real job on ONE NFL team. A club fields one starting
// quarterback, one feature back and one tight end who matters. This is a fact about
// football rather than a number fitted to anything, and the man who INHERITS is the first
// one below the jobs that already exist.
//
// RECEIVERS ARE DELIBERATELY ABSENT, and this is the correction rather than an oversight.
// The entry used to read WR: 3, on the reasoning that a club starts three receivers and so
// the fourth is the man in line. Run against the real file that produced eleven "handcuffs"
// and not one of them was one: it paired Brandon Aiyuk with De'Zhaun Stribling, Marquez
// Valdes-Scantling with Ryan Flournoy, Bo Melton with Matthew Golden. What the rule had
// found was simply each club's fourth-best receiver, which is not a fact about anybody.
//
// The reason it cannot work at receiver is the reason it works at running back. When a
// feature back goes down his carries do not evaporate, they go to ONE man, and that man is
// knowable in advance. When a receiver goes down his targets are spread across everybody
// left on the field, and the fourth man inherits some fraction of them alongside the first
// and second. There is no single heir, so naming one would be inventing him. Backs are
// where this idea is real; tight ends and quarterbacks have the same one-man job and are
// kept for that reason.
export const ROOM_JOBS = { QB: 1, RB: 1, TE: 1 };

export function depthChart(players, league, ptsOf = projectedPoints) {
  const rooms = new Map();
  for (const p of players) {
    if (!ROOM_JOBS[p.pos]) continue;                     // nobody handcuffs a kicker
    const key = `${p.team}|${p.pos}`;
    if (!rooms.has(key)) rooms.set(key, []);
    rooms.get(key).push(p);
  }
  const out = new Map();
  for (const list of rooms.values()) {
    const scored = list.map((p) => ({ p, pts: ptsOf(p, league) }))
      .sort((a, b) => b.pts - a.pts);
    const jobs = ROOM_JOBS[scored[0].p.pos];
    const lead = scored[jobs - 1];                       // the last man with a real job
    const next = scored[jobs];                           // and the man behind him
    if (!lead || !next || lead.pts < HANDCUFF_MIN) continue;
    if (next.pts * HANDCUFF_GAP > lead.pts) continue;    // a committee, not a handcuff
    out.set(next.p.id, { leadId: lead.p.id, leadName: lead.p.name, pos: lead.p.pos,
      team: lead.p.team, leadPts: lead.pts, ownPts: next.pts });
  }
  return out;
}

// WHAT THE INHERITANCE IS WORTH, which is the whole reason this section exists.
//
// Two facts have to meet here and neither is a forecast.
//
// FIRST, HOW LONG THE JOB IS OPEN. That is not a property of the backup at all - it is the
// availability you have assumed for the man in front of him, read straight off the dial. At
// `full` the job never opens and the handcuff is worth exactly nothing; at `cautious`,
// behind somebody who missed six games last year, it is open a third of the year. This is
// the one draft move that turns the strongest thing five years of testing found - every
// projection overshoots, and the entire gap is games missed - into an actual pick, and it
// needs no forecasting to do it. It needs only your answer to a question the app has now
// stopped pretending it can answer for you.
//
// SECOND, WHAT THE JOB IS WORTH WHILE HE HOLDS IT - and the honest answer is NOT the lead
// man's points. If your starter misses a week you do not score zero in his place, you start
// whoever is on waivers. So what owning the heir actually buys you is the lead's points
// MINUS a replacement's, which is the same VOR the rest of this board is denominated in.
//
// That subtraction is not bookkeeping, it is the entire difference between a real handcuff
// and a fake one, and leaving it out produced a board that was visibly wrong. Priced on
// gross points, backup quarterbacks swept the top of the handcuff list: Kyle Allen came out
// worth more than Isiah Pacheco, because Josh Allen's 362 points is a bigger number than
// Jahmyr Gibbs's 331. Over replacement the ordering inverts and reads like football.
// Replacement at quarterback is 296 of Allen's 362, so four fifths of an elite quarterback
// is sitting on the waiver wire and insuring him buys you 66 points of nothing much. At
// running back replacement is 169 of Gibbs's 331, so half of him cannot be replaced at all.
// THAT asymmetry is why backs are the position where handcuffing pays, and it falls out of
// the league's own replacement levels rather than being asserted about positions.
// `bar` is what you could get for nothing at that position - the waiver level, not the
// draft-day replacement level. When your starter goes down mid-season you do not have to
// start the last draftable man at his position, you add whoever is free.
export function handcuffValue(hc, bar, games, leadPlayer, anchor = DUR_DEFAULT) {
  if (!hc) return null;
  const leadGames = leadPlayer ? expectedGames(leadPlayer, games, anchor) : FULL_GAMES;
  const share = Math.max(0, Math.min(1, 1 - leadGames / FULL_GAMES));
  // What the job is worth over the man you would otherwise have had to start.
  const jobGain = Math.max(0, hc.leadPts - (bar?.[hc.pos] || 0));
  return { ...hc, leadGames, share, jobGain,
    weeks: Math.round(share * FULL_GAMES),
    gain: share * jobGain };
}

// What a bench pick is worth to a particular roster, in projected points.
//
// `j` is where he would sit in your queue at his position (1 = your first). `hc` is his
// depth-chart entry if he has one, and `ownLead` says whether the man he is behind is on
// YOUR roster - which is the difference Zach asked about, and it is a real one rather than
// a preference:
//
//   - Behind YOUR starter, the two halves are the same event. Gibbs going down is what
//     both opens your lineup slot and hands Pacheco the job, so you do not multiply two
//     chances together - you pay for one. That is what "insurance" means, and it is why a
//     handcuff for a man you own is worth more than the same player would be to anyone
//     else.
//   - Behind SOMEBODY ELSE'S starter, the two are independent: their man has to go down
//     AND your own depth has to have failed. A lottery ticket on another manager's bad
//     luck, worth something, worth less. Multiplying is exactly that discount, and nobody
//     had to choose its size.
//   - A fourth tight end is behind nobody and blocked by his own position: 0.5% of a
//     season, times a tight end's job. He falls to the bottom on the same arithmetic that
//     lifts the handcuff, which is the test of whether this is one idea or three.
// Returns BOTH numbers, because both are needed and they are not the same question.
// `worth` is the points he puts in your lineup across a season. `chance` is the share of
// the season he is in it - which is what he displaces a replacement-level starter FOR, and
// therefore the right weight on the bar he is measured against. Without it a handcuff was
// charged the full price of a starting running back for a job he holds three weeks a year,
// and finished below a fourth tight end again.
// Returns THREE numbers now, because the third is the one that makes a handcuff a handcuff.
// `worth` is the gross points he puts in your lineup across a season and `chance` the share
// of the season he is in it - both unchanged, both still measured in whole points, because
// the board subtracts a replacement bar from `worth` further down and the two have to be in
// the same currency.
//
// `gain` is the new one and it is already NET of that bar: it is what owning him wins you
// over the man you would otherwise have started, and it exists because for a handcuff the
// ordinary sum gets the answer wrong. A handcuff is projected low BY DEFINITION, so his
// gross worth is small and subtracting a starting back's replacement level from it buries
// him under men who will never see your lineup. See handcuffValue above.
//
// `a` (the pool) and `hc.share` (this particular starter) are deliberately different
// numbers. How often the men ahead of him on YOUR bench are all out at once is a question
// about a pool of players; how long his job is open is a question about ONE man and comes
// off the dial. Using the pooled figure for both was why the value did not move when the
// assumption changed.
export function benchWorth(pts, j, slots, a, hc, ownLead) {
  const mine = lineupChance(j, slots, a);
  const plain = { worth: pts * mine, chance: mine, gain: 0 };
  if (!hc) return plain;
  const share = hc.share ?? (1 - a);          // share of the season the man ahead misses
  if (ownLead) {
    // One event, priced once: he is not competing with your own depth for the slot,
    // because the thing that empties the slot is the same thing that gives him the job.
    // That is what "insurance" means, and it is why a handcuff for a man you own is worth
    // more than the same player would be to anybody else.
    const worth = share * hc.leadPts;
    return worth > plain.worth
      ? { worth, chance: share, gain: hc.gain ?? 0 }
      : { ...plain, gain: hc.gain ?? 0 };
  }
  // Behind SOMEBODY ELSE'S starter the two events are independent: their man has to go
  // down AND your own depth has to have failed before any of it reaches your lineup. A
  // lottery ticket on another manager's bad luck - worth something, worth less. Multiplying
  // is exactly that discount, and nobody had to choose its size.
  const job = pts + share * Math.max(0, hc.leadPts - pts);
  return { worth: mine * job, chance: mine, gain: (hc.gain ?? 0) * mine };
}

// ---------------------------------------------------------------- saying why
// The board has always been willing to tell you WHAT it thinks - Steal, Safe, Swing,
// Reach, a range of picks, a number - and never once willing to say why. That is fine for
// someone who built it and useless for anyone else, so every call now comes with a
// sentence.
//
// The hard part is not the writing, it is the honesty. Five years of held-out testing
// said the projection is the whole edge (+0.25 over last year's points at every position)
// and that no arrangement of historical stats added anything to it - lift of +0.007,
// -0.001, +0.002, +0.015. Those stats were removed from the score for that reason. So the
// explanation is not allowed to reach for them either. "Elite red-zone work" would be a
// lovely sentence and it would be putting back, in prose, the exact fiction that was just
// deleted from the maths.
//
// What is actually allowed in here, because it is actually what moves the number:
//   - the projection
//   - how far that sits above an ordinary man at his position (which is where positional
//     thinness lives - a thin position IS a big gap to the next man)
//   - where a tier ends
//   - the distance between your board and where the room drafts him
//   - the availability assumption you currently have set
//   - your preference sliders, and the fact that they only ever break ties
//
// And the cut-offs get hedged. The 2.5-point band, the 4-pick slack, the 24-pick reach
// range, the 45-player cap: every one of those was chosen to make the screen readable,
// none was fitted to an outcome. The prose says "about" and "roughly" because that is
// what they are. Nothing here forecasts.

const POS_NOUN = { QB: 'quarterback', RB: 'running back', WR: 'receiver', TE: 'tight end',
  K: 'kicker', DEF: 'defence' };
export const posWord = (pos) => POS_NOUN[pos] || pos;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// The sliders currently doing something, named in the words the ratings page uses. This
// exists so the card can answer "why is HE here and not where he was yesterday" - which is
// nearly always "because you moved something", and the app should say so rather than let
// it look like the numbers changed underneath.
export function activePrefs(r, st = {}, league = null) {
  const out = [];
  const leans = st.fit || {};
  const dial = st.anchor ?? ANCHOR_DEFAULT;

  // Availability is called out whether or not it is set, because "set to the middle" is
  // itself an assumption about him and the person should know it is being made.
  const dur = leans.dur || 0;
  if (!r.rated) {
    // no games history worth the name for a kicker, none at all for a defence
  } else if (dur > 0) {
    out.push(`you have asked for availability (${dur} of 100), so missed time nudges him down`);
  } else if (dur < 0) {
    out.push(`you have told the board to ignore availability (${dur} of 100), so missed `
      + 'time is not held against him');
  } else {
    out.push('your availability setting is at the middle, so games he missed are not '
      + 'moving him either way');
  }

  for (const a of FIT_AXES) {
    if (a.key === 'dur') continue;
    if (a.needsPenalties && league && !hasPenalties(league)) continue;
    const v = leans[a.key] || 0;
    if (!v) continue;
    out.push(`you leaned "${a.label}" towards ${v > 0 ? a.right : a.left}`);
  }

  // How much the room counts, said in the terms that apply to HIM. A receiver barely feels
  // it and a defence is mostly the room, and if the card did not say which, the same
  // sentence would be misleading for one of them.
  const w = anchorWeight(r.p, st);
  if (w >= 0.5) {
    out.push(`you have the room counting for ${Math.round(w * 100)}% of his score, and for `
      + `a ${posWord(r.p.pos)} that is most of it — where the room takes him is better `
      + 'evidence than anything the board can work out on its own');
  } else if (w >= 0.15) {
    out.push(`the room counts for ${Math.round(w * 100)}% of his score, because he has no `
      + 'season behind him and the projection has never been checked against anything');
  } else if (dial > 0 && w > 0) {
    out.push(`the room counts for only ${Math.round(w * 100)}% of his score — this is where `
      + 'your scoring rules are allowed to disagree with everybody else');
  } else if (dial <= 0) {
    out.push('you have turned the room off entirely, so this is your projections alone');
  }

  const px = st.posx?.[r.p.pos];
  if (px && px !== 1) {
    out.push(`you put a thumb on ${posWord(r.p.pos)}s (×${(+px).toFixed(2).replace(/0$/, '')})`);
  }
  if (r.star) out.push('you starred him, which moves him past anyone he was close to');
  if (r.fade) out.push('you faded him, which moves him behind anyone he was close to');
  return out;
}

// Why he sits at this rank. Projection first, because it is the whole case; then the gap
// to an ordinary man at his position, because that gap IS what "the position is thin"
// means; then the tier edge, if he is standing on one.
// A gap this small means the next man at his position is level with him for practical
// purposes - ten points is about half a point a game across a season. It is a guess at
// where "the same player" begins and nothing was fitted to it, so the sentence it drives
// says "barely" and "about the same", never a threshold.
const LEVEL_GAP = 10;

export function explainRank(r, ctx = {}) {
  const pos = posWord(r.p.pos);
  const pts = Math.round(r.pts);
  const gap = Math.round(Math.abs(r.vor));

  if (!r.rated) {
    return `#${r.rank}, and that is the projection on its own — ${pts} points. There is `
      + `nothing about a ${pos} worth grading, so the board does not pretend to have an `
      + `opinion on him. Because anyone can pick a decent one up during the season, the `
      + `${pos} he is measured against is a good one rather than the last one drafted, `
      + `which is why the board takes ${pos}s later than the room does.`;
  }

  const lead = r.vor >= 0
    ? `#${r.rank} because the 2026 projection has him at ${pts} points, about ${gap} more `
      + `than an ordinary ${pos} you could still get later.`
    : `#${r.rank} because the 2026 projection has him at ${pts} points — about ${gap} `
      + `short of an ordinary ${pos} you could still get later, which is why he sits `
      + 'this low.';

  // The old version of this always claimed the position was thin, including for a man
  // whose gap was one point - a sentence that argued against the number printed beside it.
  // Thin and deep are both worth saying; the wrong one is not.
  let thin;
  if (r.lastOfTier) {
    thin = ` He is the last ${pos} at this level: after him the next one is a real step `
      + 'down, so the position is thin right here.';
  } else if (r.vor >= 0 && gap <= LEVEL_GAP) {
    thin = ` That gap is small, which is the useful part: the next ${pos} is barely behind `
      + 'him, so the position is deep here and waiting costs you very little.';
  } else if (r.vor >= 0) {
    thin = ` That gap is what "the position is thin" means — the further the next ${pos} `
      + 'is behind him, the more the same projection is worth to you.';
  } else {
    thin = ` A ${pos} you could get later is projected to score more, so the position is `
      + 'deep enough that this one is not worth a pick yet.';
  }

  // r.equals is capped at the window width, so on an open-ended row the number IS the cap
  // and printing it would dress a readability limit up as a count of players.
  let equals = '';
  if (r.openEnded) {
    equals = ' Dozens of players below him are close enough on your board that you would '
      + 'be roughly as happy with any of them, which is why his range has no real end.';
  } else if (r.equals >= 4) {
    equals = ` About ${r.equals} other players are close enough on your board that you `
      + 'would be roughly as happy with any of them.';
  }

  return lead + thin + equals;
}

// Why the label says what it says. One or two sentences, and it always names the label it
// is explaining so the sentence can be read on its own.
// Before anyone has picked there is no clock, and pickType falls back to judging a man
// against where the room takes him. The words have to fall back with it. Saying "the draft
// is already at 21" to somebody who has opened the app the night before is simply untrue,
// and it is the kind of untrue that makes a person distrust everything else on the screen.
// So: when the clock is running, talk about the pick on the clock; when it is not, say out
// loud that this is the going rate rather than a live pick.
function clockWords(r, atPick) {
  const started = !!atPick;
  const at = atPick || r.adpRank;
  return {
    at,
    started,
    // "the draft is at pick 24" vs "the room usually takes him around pick 21"
    now: started ? `the draft is at pick ${at}` : `the room usually takes him around pick ${at}`,
    // A sentence subject, not a fragment to be dropped in mid-clause. Bolting "where the
    // room takes him, around pick 2" onto "X sits inside the range" produced a sentence
    // that did not parse, which is exactly the sort of thing that makes a person stop
    // reading the explanations at all.
    // lower case: every use of this follows "Safe: " or "Swing: ".
    sits: started
      ? `pick ${at} sits`
      : `the room takes him around pick ${at}, which sits`,
  };
}

export function explainLabel(r, atPick, ctx = {}) {
  const { now, sits, started } = clockWords(r, atPick);
  const pos = posWord(r.p.pos);
  const from = r.worthFrom;
  const to = r.worthTo;

  // "Fair value" was the one bit of jargon left in here and it was never defined. The
  // column beside it is headed Worth, so the words now match the column: worth taking.
  if (r.kind === 'steal') {
    return `Steal: your board stops calling him worth taking at around pick ${to}, and `
      + `${now}. He has fallen past his price — nothing about him has changed, only what `
      + 'it costs to have him.';
  }
  if (r.kind === 'reach') {
    return `Reach: your board does not have him worth taking until about pick ${from}, `
      + `and ${now}. Taking him this early costs you men your own board rates higher.`;
  }
  if (r.kind === 'safe') {
    if (!r.rated) {
      return `Safe: ${sits} inside the range where your board has him worth taking. There `
        + `is nothing measured about a ${pos} to say more than that, and a player with `
        + 'nothing measured is given the steady label rather than the exciting one.';
    }
    return `Safe: ${sits} inside the range where your board has him worth taking, and the `
      + 'projection expects his points to arrive more evenly week to week than they do '
      + `for most ${pos}s.`;
  }
  if (r.kind === 'swing') {
    return `Swing: ${sits} inside the range where your board has him worth taking, but `
      + `more of his projected points come in lumps than for most ${pos}s — and lumps are `
      + 'where the big weeks and the empty ones both come from.';
  }
  return `Not yet: your board does not have him worth taking until about pick ${from}, and `
    + `${started ? `${now}` : `the room is not close either — it takes him around pick ${
      r.adpRank}`}. That is too far off to call it a reach, so the board says nothing `
    + 'rather than guess.';
}

// What would move it. Almost always "wait", and the number of picks is worth printing
// because "wait a bit" is not advice.
export function explainChange(r, atPick) {
  const { at } = clockWords(r, atPick);
  const stealAt = r.worthTo + SLACK;
  const wait = (n) => plural(Math.max(1, n), 'pick', 'picks');

  // Every pick number quoted here is now an edge of the window the Worth column prints, so
  // the sentence and the column agree. They used to differ by the slack: the advice said
  // "wait 1 pick and he is fair value" beside a column reading 28-28 at pick 24, because
  // it was counting to the point where he stops being LABELLED a reach rather than to the
  // point where the board wants him. Both are real, but only one matches the column, and
  // a sentence that argues with the number next to it is worse than no sentence.
  const noSteal = ' His worth-taking range runs on past dozens of players, so he never '
    + 'turns into a Steal however far he falls — that width is a limit set to keep the '
    + 'board readable, not a fact about him.';

  if (r.kind === 'steal') return 'He stays a Steal for as long as nobody takes him.';

  if (r.kind === 'reach') {
    const a = `Wait roughly ${wait(r.worthFrom - at)} — until about pick ${r.worthFrom} — `
      + 'and your board has him worth taking.';
    return r.openEnded ? a + noSteal
      : `${a} If he lasts to around pick ${stealAt}, he is a Steal.`;
  }
  if (r.kind === 'safe' || r.kind === 'swing') {
    if (r.openEnded) return `He is worth taking now.${noSteal}`;
    return `If he is still sitting there at around pick ${stealAt} — roughly `
      + `${wait(stealAt - at)} from now — the same man becomes a Steal.`;
  }
  // The open-ended branch used to return INSTEAD of this, so the one row that most needed
  // "wait until pick N" was the only row that never got it.
  return `He comes into range at around pick ${r.worthFrom}, roughly `
    + `${wait(r.worthFrom - at)} away.${r.openEnded ? noSteal : ''}`;
}

// The tooltip version. A hover is read in a second or it is not read at all, and the card
// sentences above run to 400 characters, which is a paragraph. This is not a truncation of
// them - a half-sentence cut off mid-clause is worse than a short one - it is the same
// call written short: what the label says, and the one thing that would change it.
export function explainShort(r, atPick) {
  const { at, started } = clockWords(r, atPick);
  const pos = posWord(r.p.pos);
  // Matches exactly what the Worth column prints, including its single-number case.
  const range = r.openEnded ? `${r.worthFrom}+`
    : r.worthFrom === r.worthTo ? `just pick ${r.worthFrom}`
      : `${r.worthFrom}–${r.worthTo}`;
  const nowShort = started ? `the draft is at ${at}` : `the room takes him around ${at}`;

  if (r.kind === 'steal') {
    return `Steal — your board had him worth taking only to about pick ${r.worthTo}, and `
      + `${nowShort}. He has fallen past his price.`;
  }
  if (r.kind === 'reach') {
    return `Reach — not worth taking until about pick ${r.worthFrom}, and ${nowShort}. `
      + `Wait roughly ${plural(Math.max(1, r.worthFrom - at), 'pick', 'picks')} and he `
      + 'is worth taking.';
  }
  if (r.kind === 'safe') {
    return `Safe — worth taking now (his range is ${range}). ${r.rated
      ? `Steadier week to week than most ${pos}s.`
      : `Nothing measured about a ${pos}, so he gets the steady label, not the exciting one.`}`;
  }
  if (r.kind === 'swing') {
    return `Swing — worth taking now (his range is ${range}), but more of his points come `
      + 'in lumps than most.';
  }
  return `Not yet — he comes into range at around pick ${r.worthFrom}, too far off to call `
    + 'it a reach.';
}

// A Reach has a price and it is not abstract: it is the men you walk past. Naming the
// best one turns "your board rates others higher" into something you can disagree with.
export function explainCost(r, ctx = {}) {
  const rows = ctx.rows || [];
  const drafted = ctx.drafted || new Set();
  const above = rows.filter((x) => x.rank < r.rank && x.p.id !== r.p.id && !drafted.has(x.p.id));
  if (!above.length) return '';
  const best = above[0];
  return `You would be passing ${plural(above.length, 'player', 'players')} your board `
    + `rates higher — ${best.p.name} (${best.p.pos}) first among them.`;
}

// The bit that keeps this honest. Every number in the sentences above leans on a cut-off
// somebody chose, and the person reading deserves to know which ones were measured and
// which were picked to make the screen legible.
export const EXPLAIN_CAVEAT = 'The cut-offs behind all of this — how close two players '
  + 'have to be before they count as the same pick, how many picks early counts as early, '
  + 'how wide a range is too wide to mean anything — were chosen to keep the board '
  + 'readable. They were not measured against any result, so treat the edges as fuzzy.';

// Everything a card or a tooltip needs, in one call. Never throws: a row with half its
// fields missing still gets sentences, because a blank explanation is worse than a vague
// one and this runs on every visible row.
export function explain(r, atPick, ctx = {}) {
  const name = { steal: 'Steal', safe: 'Safe', swing: 'Swing', reach: 'Reach' };
  const label = name[r.kind] || 'Not yet';
  const rank = explainRank(r, ctx);
  const why = explainLabel(r, atPick, ctx);
  const change = explainChange(r, atPick);
  const cost = r.kind === 'reach' ? explainCost(r, ctx) : '';
  const prefs = activePrefs(r, ctx.st || {}, ctx.league || null);
  return {
    label,
    rank,
    why,
    change,
    cost,
    prefs,
    // one line, because a preference that could move a man twenty places would be
    // overruling the only thing that measured
    prefLine: prefs.length
      ? `Your settings in play: ${prefs.join('; ')}. Preferences only break ties — a few `
        + 'places at most, never past the projection.'
      : '',
    caveat: EXPLAIN_CAVEAT,
    // Short enough for a tooltip to actually be read. This used to be `why` and `change`
    // glued together, which ran to 412 characters on an open-ended row - nobody reads a
    // paragraph on hover, so the honest fix is a shorter sentence rather than a smaller
    // font. The full versions are still on the card, one click away.
    tipLabel: explainShort(r, atPick),
    tipRank: `${explainRank(r, ctx).split('. ')[0]}.`,
    // The Worth column prints a range of picks and used to hover the RANK explanation,
    // which talked about points and never mentioned the two numbers under the cursor.
    // This one explains the thing it is attached to.
    // A one-pick window is common at the top of the board and "anywhere between picks 1
    // and 1" is not a sentence. It also means something worth saying plainly: nobody is
    // close to him, so there is no waiting.
    tipWorth: r.openEnded
      ? `Worth taking from about pick ${r.worthFrom} onwards. Dozens below him are close `
        + 'enough to be a coin flip, so the range has no real end and is cut off to keep '
        + 'the board readable.'
      : r.worthFrom === r.worthTo
        ? `Worth taking right at pick ${r.worthFrom}. Nobody else on your board is close `
          + 'enough to him to be a coin flip, so the window is a single pick wide.'
        : `Worth taking anywhere between picks ${r.worthFrom} and ${r.worthTo} — across `
          + 'that run your board rates the players closely enough to be a coin flip, so '
          + 'there is no hurry inside it.',
  };
}

// ---------------------------------------------------------------- planning the draft
// Everything above this line looks two picks ahead. That is not far enough, and here is
// the draft that proved it.
//
// Twelve teams, first slot, on the clock at 25 holding Bijan Robinson and Nico Collins.
// Picks left: 48, 49, 72. The board:
//
//     QB   60.9  ->  33.4                  one elite quarterback, then a cliff
//     WR   66.8  ->  57.8  55.7  54.9      a gentle slope, plenty left
//     odds either of the top two lasts to 48: nil
//
// The two-pick rule scored it as (man now) + (best man who survives to 48). Both the
// quarterback and the receiver vanish before 48, so that second term is the SAME in both
// branches - some receiver around 50, because receivers are deep - and it cancels. What
// is left is 66.8 against 60.9, and the panel said take the receiver.
//
// Which is wrong by about seventeen points. Take the receiver and the quarterback you
// eventually start is worth 33.4: twenty-seven points surrendered. Take the quarterback
// and the receiver you eventually start is worth about 56 instead of 66.8: eleven. The
// two-pick horizon cannot see it because the loss does not land at pick 48. It lands at
// whichever pick you finally take a quarterback, and that might be pick 72.
//
// Note what does NOT fix it. The position-level rule this replaced would have got this
// case right and the turn case wrong; the player-level rule got the turn right and this
// wrong. The horizon was the problem both times, not the unit of account.
//
// So: plan every remaining pick and every unfilled starting slot. For each man you could
// take now, roll the rest of your draft forward and total the roster you end up with.
// Take whoever leaves you the best roster. The quarterback cliff now shows up wherever it
// actually falls, because the plan has to fill that slot somewhere.

// FLEX is not a position, it is a slot three positions can fill.
export const FLEX_FILL = { RB: true, WR: true, TE: true };

// How many of your later picks the plan looks at. Four covers the case above (48, 49, 72)
// with one to spare. Past that the availability curve is guesswork - a man's odds of
// lasting fifty picks are a number the model should not be asked for - and the search
// grows by a factor of five per pick for no gain.
export const PLAN_HORIZON = 4;

// The starting slots you have not filled yet. Surplus bodies at a flex-eligible position
// roll into FLEX, so a team with three receivers and two receiver slots has its FLEX
// already covered and the plan will not spend another pick there.
export function openSlots(league, have = {}) {
  const want = league?.starters || {};
  const out = [];
  const last = [];
  let spare = 0;
  for (const [pos, n] of Object.entries(want)) {
    if (pos === 'FLEX') continue;
    const got = have[pos] || 0;
    // kickers and defences go on the end. The order matters: whatever is still open when
    // the plan runs out of picks is filled in this order from what is left on the shelf,
    // and a flex spot deserves the better leftovers.
    const to = STREAMED.includes(pos) ? last : out;
    for (let i = got; i < n; i += 1) to.push(pos);
    if (FLEX_FILL[pos]) spare += Math.max(0, got - n);
  }
  for (let i = spare; i < (want.FLEX || 0); i += 1) out.push('FLEX');
  return out.concat(last);
}

const slotTakes = (slot, pos) => (slot === 'ANY' ? true
  : slot === 'FLEX' ? !!FLEX_FILL[pos] : slot === pos);

// Roll the whole draft forward and total the roster each opening move leaves you with.
//
// `rows` arrives sorted best-first. `drafted` is everyone off the board. `have` is what
// you already own, by position. Returns every candidate scored, best first.
export function planDraft(rows, clock, drafted, league, have = {}, opts = {}) {
  if (!clock?.picks?.length) return null;
  // the pick being decided: this one if you are on the clock, otherwise your next
  const at = clock.onClock ? clock.currentPick : (clock.next ?? clock.currentPick);
  const later = clock.picks.filter((p) => p > at).slice(0, opts.horizon ?? PLAN_HORIZON);
  const live = rows.filter((r) => !drafted.has(r.p.id));
  if (!live.length) return null;

  // THE NUMBER THIS WHOLE FUNCTION RANKS BY. `benchScore` is the board score asked the
  // roster-aware question - how much of this man reaches YOUR lineup, and what job is he
  // doing when he gets there - and it is the reason the plan no longer recommends a fourth
  // tight end over a handcuff. See the note above benchWorth in this file. It falls back to
  // `score` so the hand-built rows in the tests, which have no bench pricing, still work.
  const val = (r) => (r.benchScore ?? r.score);

  // Once every starting slot is filled you are drafting a bench, where there is no slot to
  // reason about and the answer is simply the best man left. Modelled as one endless ANY
  // slot so the same rollout code covers it.
  let slots = openSlots(league, have);
  const bench = !slots.length;
  if (bench) slots = ['ANY'];

  // And you are ALREADY drafting a bench when the only starting slots left are the kicker
  // and the defence, because the app will not spend this pick on either of them - see the
  // rule in autoPick, which has always been "a kicker and a defence go last, always".
  //
  // Without this the panel had nothing else to offer. `wanted` is built from the open
  // slots, so from the moment the last real starter was filled the ONLY men the plan would
  // consider were kickers and defences: the advice panel said "Take DEF LAR Defense" on six
  // consecutive picks of a fifteen-round draft while the auto-drafter, following the rule,
  // quietly took receivers instead. The app was giving advice it would not take itself, and
  // the cost view - which grades a pick against the best the plan could see - then read the
  // difference back as a hundred-point mistake on every bench pick.
  //
  // Charging the kicker is not skipped, only deferred: the streamed slots stay in the list
  // and the tail pays for them at the far end, which is where they will really be filled.
  // The ANY slot goes on the END, not the front. `slots.findIndex(slotTakes)` decides which
  // slot a candidate is filling, and ANY matches everybody - put it first and a defence
  // fills the ANY slot while the plan still schedules a second defence for the DEF slot,
  // which prices him twice and hands him the recommendation all over again.
  // Counted BEFORE the ANY slot is added, because this is "how many starting slots are
  // still empty" and a bench spot is not one. Adding ANY first made the count one too high
  // and quietly turned the streamed rule off for the last pick but one.
  const leftToPick = clock.picks.filter((p) => p >= at).length;
  const openCount = slots.length;
  if (!bench && leftToPick > openCount && slots.every((s) => STREAMED.includes(s))) {
    slots = [...slots, 'ANY'];
  }

  // one bucket per position, best first, so the rollout never re-filters the whole board.
  // 25 deep is plenty: the expectation walk below multiplies by the chance everyone above
  // has gone, which is under a thousandth long before the twenty-fifth man.
  const byPos = new Map();
  for (const r of live) {
    if (!byPos.has(r.p.pos)) byPos.set(r.p.pos, []);
    const b = byPos.get(r.p.pos);
    if (b.length < 25) b.push(r);
  }
  const posFor = (slot) => (slot === 'ANY' ? [...byPos.keys()]
    : slot === 'FLEX' ? Object.keys(FLEX_FILL) : [slot]);

  // Sorted once per kind of slot, not once per node of the search. The rollout asks this
  // question thousands of times and the answer only ever differs by the handful of men the
  // plan has already spent, so re-sorting a hundred players inside the loop was the one
  // thing here that could actually be felt.
  const sorted = new Map();
  const eligible = (slot, used) => {
    if (!sorted.has(slot)) {
      const all = posFor(slot).flatMap((pos) => byPos.get(pos) || []);
      sorted.set(slot, all.sort((a, b) => val(b) - val(a)));
    }
    const list = sorted.get(slot);
    return used.size ? list.filter((r) => !used.has(r.p.id)) : list;
  };

  // What you should EXPECT to get at this slot at this pick. Not "the best man with
  // better-than-even odds" - that reports zero cost whenever your next pick is close, and
  // a 55% chance of keeping the best player is not no cost. Walk down by score and weight
  // each man by the chance he lasts AND everyone above him has gone.
  // Where the odds come from. Always ADP in the app; the tests hand in fixed numbers so
  // the six known-answer cases are settled by arithmetic rather than by an ADP curve.
  const odds = opts.odds || ((r, atPick) => availability(r.p.adp, atPick, clock.currentPick) ?? 0.5);
  const expect = (list, atPick) => {
    let value = 0;
    let allGone = 1;
    let take = null;
    for (const r of list) {
      const p = atPick <= clock.currentPick ? 1 : odds(r, atPick);
      if (!take && p >= 0.5) take = r;
      value += val(r) * p * allGone;
      allGone *= 1 - p;
      if (allGone < 0.001) break;
    }
    // whatever chance is left that they all went, priced at the worst man on the shelf
    value += (list.length ? val(list[list.length - 1]) : 0) * allGone;
    return { value, take: take || list[0] || null };
  };

  // A slot you never plan is a slot you never pay for, and a fixed horizon hands every
  // branch that loophole: with seven openings and four picks, the branch that has left
  // quarterback unfilled can simply not schedule it and look free. So whatever is still
  // open when the horizon runs out is charged here, at the last pick the plan can see.
  //
  // The tail flatters everyone a little - you would really be filling those slots at pick
  // 120, not 73 - but it flatters every branch the same way, and the number that decides
  // anything is the difference. Charging quarterback 33 and receiver 50 is the point;
  // whether both are two points generous is not.
  const tail = (used, left) => {
    const atPick = later[later.length - 1] ?? clock.currentPick;
    const mine = new Set(used);
    let value = 0;
    // in the order openSlots builds them, which already runs the real positions before
    // FLEX and the streamed ones last. Not optimised - it is a tail, and every branch pays
    // it the same way.
    for (const slot of left) {
      const list = eligible(slot, mine);
      if (!list.length) continue;
      const e = expect(list, atPick);
      value += e.value;
      if (e.take) mine.add(e.take.p.id);
    }
    return value;
  };

  // Exhaustive over which slot each later pick fills, greedy within a slot (the pick you
  // are most likely to actually make comes off the board for the picks after it).
  //
  // Two things keep it small. Duplicate slots are one choice, not two - filling either of
  // your open receiver spots is the same move. And kickers and defences are never
  // scheduled while a real slot is open, which is not a heuristic about value so much as
  // an admission that no plan worth printing spends pick 25 on a kicker; they are still
  // charged in the tail, so skipping them is not the same as forgetting them. That takes a
  // five-position league from 840 branches per candidate to 120.
  //
  // The budget is per candidate and generous. It was shared, once, which meant the last
  // men on the list were scored with whatever search was left over - so a candidate's
  // total depended on his position in the queue. That is not a tie-break, it is a bug, and
  // it was quietly rating the best quarterback on the board 79 points below the field.
  const budget = { n: 0 };
  const roll = (i, used, left) => {
    if (i >= later.length || !left.length || budget.n <= 0) {
      return { value: bench ? 0 : tail(used, left), steps: [] };
    }
    let best = null;
    const seen = new Set();
    const real = left.some((s) => !STREAMED.includes(s));
    for (let k = 0; k < left.length; k += 1) {
      const slot = left[k];
      if (seen.has(slot)) continue;             // two open WR slots are the same choice
      if (real && STREAMED.includes(slot)) continue;
      seen.add(slot);
      budget.n -= 1;
      const list = eligible(slot, used);
      if (!list.length) continue;
      const { value, take } = expect(list, later[i]);
      const used2 = new Set(used);
      if (take) used2.add(take.p.id);
      const rest = roll(i + 1, used2, bench ? left : left.filter((_, j) => j !== k));
      const total = value + rest.value;
      if (!best || total > best.value) {
        best = { value: total, steps: [{ pick: later[i], slot, value, take }, ...rest.steps] };
      }
    }
    return best || { value: bench ? 0 : tail(used, left), steps: [] };
  };

  // Who is worth considering now: the best few overall who fill a slot you still need,
  // plus the best man at EVERY position that needs a starter. That second half is the
  // whole point - the case above turns on an elite quarterback who sat below ten better
  // players, so any candidate list cut purely by score would never have seen him.
  const wanted = new Set(slots.flatMap(posFor));
  let cands = live.filter((r) => wanted.has(r.p.pos)).slice(0, opts.candidates ?? 10);
  for (const pos of wanted) {
    const b = (byPos.get(pos) || [])[0];
    if (b && !cands.includes(b)) cands.push(b);
  }
  // A kicker and a defence go last, always. This is not a new rule - autoPick has enforced
  // it since the day it was written, because a starting kicker really is worth more than
  // the sixtieth receiver and he is also still going to be there in round fifteen.
  //
  // It is enforced HERE now, where the advice is made, rather than only there, where the
  // pick is made. The two disagreed, and the disagreement was not small: from the moment
  // the last real starting slot was filled, `wanted` contained nothing but K and DEF, so
  // the panel told Zach to "Take DEF LAR Defense" on six consecutive picks of a fifteen-
  // round draft while the auto-drafter, following the rule, quietly took receivers. The
  // app was giving advice it would not take itself. Everything downstream inherited it:
  // autoPick fell through to raw board order because the man it was handed was illegal,
  // and the cost view then read the gap between the two back as a mistake by Zach.
  //
  // The test is autoPick's own: once your remaining picks are down to the slots you still
  // have to fill, they go on the table. Not before.
  if (openCount < leftToPick) {
    const real = cands.filter((r) => !STREAMED.includes(r.p.pos));
    if (real.length) cands = real;         // never leave the plan with nothing to say
  }
  // The other rule autoPick enforces and the plan did not know about: nobody carries five
  // tight ends. Left out, the plan named a third quarterback on the last skill pick of
  // every draft, autoPick refused him, and the pick fell through to raw board order - which
  // is the same self-disagreement as the kicker one, one pick further down.
  if (opts.caps) {
    const under = cands.filter((r) => (have[r.p.pos] || 0) < (opts.caps[r.p.pos] ?? 99));
    if (under.length) cands = under;
  }
  // `must` names men who have to be priced whatever the shortlist thinks of them. Only one
  // caller wants this: the cost view, which has to know what the plan made of the man you
  // ACTUALLY took, and you are perfectly free to take somebody the shortlist never saw.
  // Without it the panel could only report on picks it already approved of.
  for (const id of opts.must || []) {
    const r = live.find((x) => x.p.id === id);
    if (r && !cands.includes(r)) cands.push(r);
  }
  if (!cands.length) return null;

  let exact = true;
  const plan = cands.map((r) => {
    const idx = slots.findIndex((s) => slotTakes(s, r.p.pos));
    const rest = bench ? slots : slots.filter((_, j) => j !== idx);
    budget.n = opts.budget ?? 20000;            // every candidate gets the same search
    const out = roll(0, new Set([r.p.id]), rest);
    if (budget.n <= 0) exact = false;
    // What this branch ends up paying for each POSITION, so the panel can say "wait on
    // quarterback and you get 33" using the branch that actually waits on quarterback -
    // rather than a separate sum computed somewhere else, which is what had the panel
    // arguing against its own pick.
    //
    // Keyed by the position of the man taken, NOT by the slot label. Keying by slot said a
    // branch containing "flex at 31, and the flex takes a receiver" had no receiver in it
    // at all, so the receiver got priced at the far end of the plan instead of at 31. That
    // is how the panel came to report a 46-point cost of waiting on receivers beside a
    // pill saying it cost 1.
    const fill = {};
    for (const s of out.steps) {
      const pos = s.take?.p.pos;
      if (pos && fill[pos] == null) fill[pos] = s.value;
    }
    return { row: r, now: val(r), later: out.value, total: val(r) + out.value,
      steps: out.steps, fill };
  }).sort((a, b) => b.total - a.total);

  // Once every slot is filled the rollout stops discriminating: with one endless ANY slot,
  // every branch schedules from the same list and `later` comes out near-identical, so the
  // whole decision collapses onto the candidate's own value and the question "will he still
  // be here in thirty picks" disappears. Measured: the app started taking bench men 12+
  // picks ahead of the market on 41% of its picks, against 31% before.
  //
  // So on the bench, among the men who are too close to call - the same STAR_BAND the app
  // already uses to mean "the numbers are indifferent here" - take the one least likely to
  // last. That is the app's own cost-of-waiting argument, applied in the one place the
  // rollout cannot see it. It never overrules a real difference in value.
  if (bench && plan.length > 1 && later.length) {
    const band = plan.filter((c) => c.total >= plan[0].total - STAR_BAND);
    if (band.length > 1) {
      band.sort((a, b) => odds(a.row, later[0]) - odds(b.row, later[0]));
      const first = plan.indexOf(band[0]);
      if (first > 0) plan.unshift(...plan.splice(first, 1));
    }
  }

  // What the recommendation actually cost each alternative, over the whole draft. This is
  // the number the panel shows, because it is the number the decision used.
  const top = plan[0];
  const byPosPlan = new Map();
  for (const c of plan) {
    const cur = byPosPlan.get(c.row.p.pos);
    if (!cur || c.total > cur.total) byPosPlan.set(c.row.p.pos, c);
  }
  const cost = [...byPosPlan.entries()]
    .map(([pos, c]) => ({ pos, best: c.row, total: c.total, loss: top.total - c.total }))
    .sort((a, b) => a.loss - b.loss);

  // ONE cost of waiting per position, and every readout in the app uses this one. What you
  // pay at a position if you do not open with it, read out of the best plan that opens
  // with something else - which is the branch that genuinely waits. The board reading used
  // to compute its own version of this at your next pick only; two numbers for the same
  // English phrase, sitting one above the other on screen, disagreeing.

  // What each position is worth now versus what it is worth if you leave it to the end of
  // the plan. Priced at the LAST pick the plan can see, not the next one, because that is
  // where an unfilled slot actually lands: the quarterback you gave up is not the one
  // sitting there twenty picks from now, it is the one left when you finally need a
  // quarterback. Pricing it at the next pick is what made the panel report "nothing falls
  // off a cliff" directly above a pick made entirely because something did.
  const drop = {};
  for (const pos of wanted) {
    const b = (byPos.get(pos) || [])[0];
    if (!b || !later.length) continue;
    drop[pos] = { now: val(b),
      later: expect(eligible(pos, new Set()), later[later.length - 1]).value };
  }
  for (const c of cost) {
    // the best plan that does NOT open at this position is the one that has to wait for it
    const other = plan.find((x) => x.row.p.pos !== c.pos);
    c.now = val(c.best);
    c.wait = other?.fill?.[c.pos] ?? drop[c.pos]?.later ?? val(c.best);
    c.gap = Math.max(0, c.now - c.wait);
    // where that plan actually covers it, so the panel can say "you still get one at 31"
    c.at = other?.steps.find((s) => s.take?.p.pos === c.pos)?.pick ?? null;
  }

  return { plan, top, cost, drop, slots, later, at, bench, exact };
}

// ---------------------------------------------------------------- what a pick cost
//
// This panel used to score every pick by distance from ADP, and that is how it came to
// call the app's own recommendation a mistake. The board takes a man early precisely
// BECAUSE it rates him above the market; the panel then read the same fact back as the
// fault. One number, counted twice, once as the reason and once as the crime.
//
// Distance from ADP cannot tell the two apart, because it is not measuring anything about
// your draft. Taking a man twenty picks before the room takes him costs you NOTHING if
// nobody else you wanted was going to disappear in the meantime. It costs you a great deal
// if somebody was. That difference is opportunity, and it is what this measures instead:
//
//   1. How far below the top of your own board you went. Zero if you took the top of it,
//      whatever the market thought. This is points left on the table.
//   2. Whether the man you took would probably have kept until your next pick, and whether
//      somebody better would NOT have. That, and only that, earns the word reach: a pick
//      spent on a man who was not going anywhere, while a man who was went to somebody else.
//
// Both readings are in the plan's own currency - the total roster the rollout expects each
// opening move to leave you with - so the panel and the recommendation cannot disagree.
// Follow the app's advice and the gap is zero by construction, which is the property the
// old version could not have: it was grading against a different number entirely.
//
// ADP stays on screen. It is information about the room, and a disagreement with the room
// is something to judge for yourself, not a verdict handed down.

// "Probably". Not a new dial: `expect` above already draws the line at even odds when it
// decides which man you should expect to still be there, and this is the same question
// asked about one player, so it gets the same answer.
export const PROBABLE = 0.5;

const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

// A record of one pick, taken at the moment it was made, because that is the only moment
// the alternatives exist. Ten seconds later half of them are off the board and the
// question "who else could you have had" has no answer.
//
// `res` is a planDraft result that priced the man taken - pass his id in opts.must.
//
// `opts.skipStreamed` drops kickers and defences from the list of men you are held against.
// This is not the panel being kind. The app has one hard rule about them, stated in autoPick
// and never broken - "a kicker and a defence go last, always", because they are not going
// anywhere - and it would be dishonest to mark a pick down against an alternative the app
// itself refuses to make. It matters because the plan prices a deep bench receiver at MINUS
// seventy (he almost never reaches your lineup) and a starting defence at plus eight, so
// without this every bench pick in the draft reads as an eighty-point disaster.
export function pickShot(res, id, clock, opts = {}) {
  if (!res?.plan?.length) return null;
  const me = res.plan.find((c) => c.row.p.id === id);
  if (!me) return null;
  // the man taken is always in the pool, whoever he is - you cannot grade a pick without him
  const pool = res.plan.filter((c) => c.row.p.id === id
    || !(opts.skipStreamed && STREAMED.includes(c.row.p.pos)));
  const now = clock?.currentPick ?? null;
  const next = clock?.target ?? null;
  const keepOf = (row) => (next ? availability(row.p.adp, next, now) : null);
  const cut = (c) => ({ id: c.row.p.id, name: c.row.p.name, pos: c.row.p.pos,
    rank: c.row.rank ?? null, score: r1(c.row.score), total: r1(c.total) });

  // The best man you also wanted who probably would NOT have been there next time. Read
  // off the plan, so "wanted" means the app wanted him too, not merely that he was famous.
  let lost = null;
  for (const c of pool) {
    if (c.total <= me.total) continue;
    const p = keepOf(c.row);
    if (p == null || p >= PROBABLE) continue;
    if (!lost || c.total > lost.total) lost = c;
  }
  const top = pool[0];                       // pool keeps planDraft's order, best first
  return {
    at: now,
    next,
    me: cut(me),
    adp: me.row.p.adp ?? null,
    keep: r1((keepOf(me.row) ?? 0) * 100),
    hasKeep: keepOf(me.row) != null,
    // null means you took the top of your own board, and the gap is zero by construction
    top: top.row.p.id === id ? null : cut(top),
    lost: lost ? { ...cut(lost), keep: r1((keepOf(lost.row) ?? 0) * 100) } : null,
    gap: r1(Math.max(0, top.total - me.total)),
  };
}

// The verdict, in five cases and no jargon. Written to be read by someone who does not
// know what ADP stands for and should not have to.
//
// The indifference band is STAR_BAND, which is the size the engine already uses to mean
// "these two are too close to call" - on these very numbers, a few lines up in planDraft.
// Nothing here is tuned to make a pick look good.
export function pickCost(shot) {
  if (!shot) {
    return { kind: 'unknown', points: 0, head: 'Not recorded',
      why: 'This pick was made before the app started keeping track of what else was on '
        + 'the board, so there is nothing honest to say about it.' };
  }
  const { me, top, lost, next } = shot;
  const gap = shot.gap || 0;
  const pts = Math.round(gap);
  const keep = Math.round(shot.keep ?? 0);

  if (!top) {
    return { kind: 'top', points: 0, head: 'Nothing better was there',
      why: 'He was the top of your own board when you took him, so this pick left nothing '
        + 'behind.' };
  }
  if (gap < STAR_BAND) {
    return { kind: 'fine', points: 0, head: 'As good as anything left',
      why: `Your board put him level with ${top.name} — ${pts} point${pts === 1 ? '' : 's'} `
        + `apart out of a whole roster, which is a coin flip. Nothing was lost here.` };
  }
  if (shot.hasKeep && shot.keep >= PROBABLE * 100 && lost) {
    const cost = Math.round(Math.max(0, lost.total - me.total));
    return { kind: 'wasted', points: pts,
      head: 'This one cost you a player',
      why: `${me.name} would most likely still have been sitting there at your next pick `
        + `(about ${keep} in 100). ${lost.name} would not (${Math.round(lost.keep)} in 100) — `
        + `and your board rated ${lost.name} ${cost} point${cost === 1 ? '' : 's'} higher. `
        + `Taking ${me.name} first got you a man you were going to get anyway and lost you `
        + `one you were not.` };
  }
  if (shot.hasKeep && shot.keep < PROBABLE * 100) {
    return { kind: 'paid', points: pts,
      head: 'You paid to make sure of him',
      why: `Your board had ${top.name} ${pts} point${pts === 1 ? '' : 's'} ahead, so this `
        + `was ${pts} given up. But ${me.name} was about to go — only about ${keep} in 100 `
        + `that he lasted to pick ${next} — so it was him now or not at all.` };
  }
  return { kind: 'left', points: pts,
    head: `${pts} point${pts === 1 ? '' : 's'} left on the table`,
    why: `${top.name} was the better man on your board and nobody you wanted was about to `
      + `disappear, so there was no hurry. Not a disaster, and not a reach either — just `
      + `${pts} you did not have to give up.` };
}

// What the room made of the same pick. Information, not a verdict - which is the whole
// point of moving it out of the scoring. Deliberately says nothing about right or wrong.
export function marketNote(shot) {
  if (!shot?.adp || !shot.at) return '';
  const g = Math.round(shot.at - shot.adp);
  if (g >= 12) return `The rest of the world usually takes him ${g} picks earlier — he slid to you.`;
  if (g <= -12) return `The rest of the world usually waits ${-g} more picks for him. You rated him higher than they do.`;
  return 'About where everyone else takes him.';
}

// A plain-English read of what the current weights mean, for the ratings editor.
export function priorityOrder(data, st) {
  const cw = componentWeights(st);
  return data.components
    .map((c) => ({ label: c.label, w: cw[c.key] || 0 }))
    .filter((c) => c.w > 0)
    .sort((a, b) => b.w - a.w);
}
