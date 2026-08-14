// A practice draft against a simulated room.
//
// None of Zach's drafts have happened yet, so nothing in this app has ever run under real
// conditions. This lets a whole draft happen in a minute, on the real board, with the real
// league settings, so the interface gets used in anger before it matters.
//
// WHAT THIS IS NOT: a prediction. It does not know his family. It does not know who busts.
// Five years of measurement said the projections are the only strong signal there is and
// that individual beats are not foreseeable, so nothing in here pretends otherwise. All it
// models is the ONE thing a draft room reliably does - take players roughly in ADP order,
// with need and herd behaviour pulling on it - and it says so on screen.

import { myPicks, roundsOf } from './engine.js?v=202608140818';

// ---------------------------------------------------------------- randomness
// Seeded, so a mock can be replayed. The seed is mixed with the pick number rather than
// carried as a running stream, which means undo genuinely rewinds: take the pick back,
// make the same pick again, and the room answers the same way it did the first time. A
// running stream would re-roll every reply and make "what if I had taken the other man"
// impossible to compare.
export function mulberry32(a) {
  let t = a >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- snake maths
// Which team owns overall pick n. This is the same snake myPicks() walks, read the other
// way round, and the tests assert the two agree rather than trusting that they do.
export function pickTeam(n, teams) {
  const round = Math.ceil(n / teams);
  const idx = n - (round - 1) * teams;          // 1..teams, left to right
  return round % 2 === 1 ? idx : teams - idx + 1;
}

export const roundOf = (n, teams) => Math.ceil(n / teams);

// A league imported before its draft exists can be missing either of these. Falling back
// to a standard twelve-team, fifteen-round draft is far better than NaN picks.
export const teamsOf = (league) => league.teams || 12;

export const totalPicks = (league) => teamsOf(league) * roundsOf(league);

// ---------------------------------------------------------------- roster rules
const FLEXY = ['RB', 'WR', 'TE'];

// The most of one position anyone sensibly carries: his starting slots, plus the flex if
// he is eligible for it, plus a little bench. Without a cap the noise eventually hands
// somebody four kickers, which would be funny once and wrong every time after.
export function capsOf(league) {
  const s = league.starters || {};
  const flex = s.FLEX || 0;
  const bench = { QB: 1, RB: 4, WR: 4, TE: 1, K: 0, DEF: 0 };
  const out = {};
  for (const pos of Object.keys(s)) {
    if (pos === 'FLEX') continue;
    out[pos] = (s[pos] || 0) + (FLEXY.includes(pos) ? flex : 0) + (bench[pos] ?? 2);
  }
  return out;
}

// Starting slots this roster has not filled yet, flex counted separately because any of
// three positions can fill it.
//
// A roster can arrive with a hole in it - a saved mock naming a player who is no longer in
// the pool - and this is the function every other one leans on, so it refuses to throw over
// one missing man. See the note on simulate() about where the holes come from.
export function needsOf(roster, league) {
  const s = league.starters || {};
  const have = {};
  for (const p of roster) if (p && p.pos) have[p.pos] = (have[p.pos] || 0) + 1;
  const short = {};
  let spare = 0;
  for (const [pos, want] of Object.entries(s)) {
    if (pos === 'FLEX') continue;
    short[pos] = Math.max(0, want - (have[pos] || 0));
    if (FLEXY.includes(pos)) spare += Math.max(0, (have[pos] || 0) - want);
  }
  const flex = Math.max(0, (s.FLEX || 0) - spare);
  const total = Object.values(short).reduce((a, b) => a + b, 0) + flex;
  return { have, short, flex, total };
}

const wants = (pos, need) => (need.short[pos] || 0) > 0 || (need.flex > 0 && FLEXY.includes(pos));

// ---------------------------------------------------------------- the room
// One number, from 0 (goes by the book) to 100 (reaches and panics).
//
// tau is how far down the remaining board the room is willing to look. At tau = 0.6 the
// best man left by ADP goes about 80% of the time; at 6.6 the pick lands six or seven
// names down and players start going well before their ADP.
//
// The need and run bonuses are expressed as MULTIPLES of tau on purpose. That keeps their
// effect on the odds constant - need makes a position about 2.5x likelier, a run about
// 1.6x - no matter where the slider sits, so the slider changes exactly the one thing it
// says it changes and nothing else.
export function roomParams(disc = 40) {
  const d = Math.max(0, Math.min(100, disc));
  const tau = 0.6 + 0.06 * d;
  return { tau, need: 0.9 * tau, run: 0.45 * tau };
}

// Phrased as something a room DOES, so it reads correctly both as the slider's readout
// and in the sentence "you drafted against a room that ___".
export function roomWord(disc = 40) {
  if (disc <= 12) return 'sticks to the rankings';
  if (disc <= 33) return 'reaches a little';
  if (disc <= 62) return 'drafts like a typical room';
  if (disc <= 85) return 'reaches often';
  return 'panics — nobody waits for anybody';
}

// How many candidates to look at. Deeper than this cannot win a softmax at any sensible
// tau, and scanning 300 players 180 times is wasted work.
const WINDOW = 30;

// One pick by one simulated team.
//
// Weight each still-available player by how far down the ADP board he sits, then nudge for
// need and for a run at his position, then draw. That is the entire model.
export function aiPick(avail, roster, league, opts) {
  const { params, rnd, picksLeft, runPos } = opts;
  const caps = opts.caps || capsOf(league);
  const need = needsOf(roster, league);
  const have = need.have;

  // Room to be greedy, or down to the wire? Once a team has exactly as many picks left as
  // it has empty starting slots, it stops shopping and fills them. Real rooms do this too;
  // it is why kickers all go in the last two rounds.
  const forced = need.total >= picksLeft;

  const pool = [];
  for (const p of avail) {
    if ((have[p.pos] || 0) >= (caps[p.pos] ?? 99)) continue;
    if (forced && !wants(p.pos, need)) continue;
    pool.push(p);
    if (pool.length >= WINDOW) break;
  }
  // Nothing legal left under the caps - take the best man available and let the roster be
  // lopsided rather than returning nothing and stalling the draft.
  if (!pool.length) return avail[0] || null;

  const w = pool.map((p, i) => {
    let x = -i;
    if (wants(p.pos, need)) x += params.need;
    if (p.pos === runPos) x += params.run;
    return Math.exp(x / params.tau);
  });
  const sum = w.reduce((a, b) => a + b, 0);
  let r = rnd() * sum;
  for (let i = 0; i < pool.length; i += 1) {
    r -= w[i];
    if (r <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

// ---------------------------------------------------------------- picking for you
// The other half of the simulator: let the app make YOUR picks too.
//
// There is no second opinion in here. `prefer` is what the app's own recommendation panel
// would say - the player it names, and failing him the position it names - so the app
// drafts by following its own advice rather than by a rule written next to it. That also
// makes every practice draft a full run of the advice being read on the night.
//
// Passing it in is what gives this a CLOCK, and the clock is the whole point. Without it
// this walked the board from the top, which is how it spent pick 96 on a man the entire
// room agreed would still be there at 170. Board order says who is best; cost of waiting
// says who will not last. A drafter needs both.
//
// Everything that decides the order underneath - the projections, the need bonus, the four
// preferences, the strategy, the position lean, anyone starred or faded - has already been
// applied by buildBoard before these rows arrive. Nothing is re-decided here.
//
// Two rules stop it being silly, and they are the same two the pretend teams follow:
// never carry more of a position than anyone sensibly carries, and once your remaining
// picks equal your empty starting slots, fill them.
export function autoPick(rows, gone, roster, league, picksLeft, caps, prefer) {
  const need = needsOf(roster, league);
  const cap = caps || capsOf(league);
  const forced = need.total >= picksLeft;
  const ok = (p) => !gone.has(p.id)
    && (need.have[p.pos] || 0) < (cap[p.pos] ?? 99)
    // once your picks run out, only the slots you still have to fill
    && (!forced || wants(p.pos, need))
    // A kicker and a defence go last, always. Not because the board is wrong about them -
    // a starting kicker really is worth more than the sixtieth receiver - but because the
    // board has no sense of time and they are not going anywhere.
    && (forced || !['K', 'DEF'].includes(p.pos));

  if (prefer) {
    const named = rows.find((r) => (r.p || r).id === prefer.id && ok(r.p || r));
    if (named) return named.p || named;
    const atPos = rows.find((r) => (r.p || r).pos === prefer.pos && ok(r.p || r));
    if (atPos) return atPos.p || atPos;
  }
  for (const r of rows) {
    const p = r.p || r;
    if (ok(p)) return p;
  }
  // Caps have painted us into a corner - take the best man left rather than stalling.
  for (const r of rows) {
    const p = r.p || r;
    if (!gone.has(p.id)) return p;
  }
  return null;
}

// Two of the same position back to back and the next team feels it. Mild by design - a run
// is a real thing that happens in a draft room, but it is not a law of nature.
export function runPosOf(log) {
  const n = log.length;
  if (n < 2) return null;
  const a = log[n - 1].pos;
  return a && a === log[n - 2].pos ? a : null;
}

// ---------------------------------------------------------------- a whole draft
// Used by the tests to run a full draft headlessly, and by the app to fill in every pick
// that is not the user's. `choose` is called when it is the user's turn; if it is left out
// the run stops there and can be resumed.
export function simulate({ players, league, slot, disc = 40, seed = 1, log = [], choose }) {
  const teams = teamsOf(league);
  const rounds = roundsOf(league);
  const total = teams * rounds;
  const params = roomParams(disc);
  const caps = capsOf(league);
  // A mock in progress is saved and resumed, and the player pool is rebuilt underneath it
  // every time the data file is refreshed. So a saved log can name somebody who is no
  // longer in the pool. Rebuilding the rosters with a bare find() put `undefined` in a
  // roster and the next read of p.pos threw, which killed the whole tab - a practice draft
  // left open overnight came back as a blank page. Cut the log at the first man we cannot
  // account for and re-simulate from there: everything before him is real history, and the
  // draft that comes back is at least self-consistent.
  const byId = new Map(players.map((p) => [p.id, p]));
  const cut = log.findIndex((x) => !byId.has(x.id));
  const dropped = cut < 0 ? 0 : log.length - cut;
  if (cut >= 0) log.length = cut;

  const gone = new Set(log.map((x) => x.id));
  const rosters = {};
  for (let t = 1; t <= teams; t += 1) rosters[t] = [];
  for (const x of log) if (rosters[x.team]) rosters[x.team].push(byId.get(x.id));

  // one ADP-sorted copy, filtered per pick. Sorting 300 players 180 times is the kind of
  // thing that makes a simulator feel slow for no reason.
  const order = [...players].sort((a, b) => (a.adp || 999) - (b.adp || 999));

  while (log.length < total) {
    const n = log.length + 1;
    const team = pickTeam(n, teams);
    const avail = order.filter((p) => !gone.has(p.id));
    let pick;
    if (team === slot) {
      if (!choose) break;                    // hand back to the user
      pick = choose(avail, rosters[team], n);
      if (!pick) break;
    } else {
      pick = aiPick(avail, rosters[team], league, {
        params,
        caps,
        picksLeft: rounds - rosters[team].length,
        runPos: runPosOf(log),
        rnd: mulberry32(seed * 7919 + n),
      });
    }
    if (!pick) break;
    gone.add(pick.id);
    rosters[team].push(pick);
    log.push({ n, team, id: pick.id, pos: pick.pos, adp: pick.adp ?? null });
  }
  // Did we stop because the board emptied? An 18-team, 14-round draft is 252 picks, and a
  // league that starts no kicker and no defence has no kickers or defences in its pool - so
  // the pool has to be 252 deep in skill players alone or the draft cannot finish. It is
  // not a hypothetical: it is true of one of the leagues in this file today. Saying so out
  // loud beats handing back a draft that is quietly eleven picks short.
  const ranOut = !(log.length >= total) && players.length - gone.size === 0;
  return { log, rosters, done: log.length >= total, total, rounds, teams, dropped, ranOut };
}

// ---------------------------------------------------------------- reading it back
// What a pick cost against ADP. Positive means he fell to you.
export const vsAdp = (n, adp) => (adp ? n - adp : null);

// Is he someone the market expects to be drafted at all? The pool runs 300 deep and a
// fifteen-round draft is 180 picks, so plenty of players carry an ADP past the last pick.
// Measuring one of them against his ADP produces "258 picks early", which is arithmetically
// true and says nothing about the pick.
export const isRanked = (adp, total) => !!adp && adp <= total;

export function adpWord(n, adp, total) {
  if (!adp) return 'The room has no ranking for him.';
  if (!isRanked(adp, total)) {
    return 'Nobody expects him to be drafted at all — this deep, every pick is a guess.';
  }
  const g = Math.round(n - adp);
  if (g >= 12) return `A bargain — he went ${g} picks later than the room usually takes him.`;
  if (g >= 4) return `Good value — ${g} picks later than his usual spot.`;
  if (g > -4) return 'About the going rate.';
  if (g > -12) return `A small reach — ${-g} picks earlier than his usual spot.`;
  return `A reach — ${-g} picks earlier than the room usually takes him.`;
}

// The picks that belong to a slot, straight from the engine's own snake maths, so the
// simulator and the clock can never disagree about whose turn it is.
export const slotPicks = (league, slot) => myPicks(teamsOf(league), slot, roundsOf(league));
