// A full practice draft, run over and over, against every league in the data file.
//
// smoke.mjs runs ONE simulated draft, from one slot, at one discipline, in the sample
// league. That found the obvious breakage. This runs several hundred, from every slot, at
// every setting on the discipline slider, in the leagues Zach actually plays in - and in a
// few deliberately awkward ones - because the bugs that were left after the first pass were
// all shape-dependent: an 18-team league, a league with no kicker, a pool that runs dry.
//
// No jsdom. This is the model and the snake maths only, so it runs in under two seconds and
// can be pointed at a new data file the moment one lands.
//
//     node test/mock-stress.mjs
import { readFileSync } from 'node:fs';

const DIR = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, '');
const e = await import(`file://${DIR}/engine.js`);
const mk = await import(`file://${DIR}/mock.js`);
const data = JSON.parse(readFileSync(`${DIR}/data/players.json`, 'utf8'));

let pass = 0;
const fails = [];
const warnings = [];
const ok = (what, cond, detail) => {
  if (cond) pass += 1;
  else fails.push(`${what}${detail ? ` — ${detail}` : ''}`);
};

// A person drafting sensibly: best man available who fills something he still has to fill.
// Not clever, but it always ends legal, which is what lets the assertions below be strict.
const human = (lg, R) => (avail, roster) => {
  const need = mk.needsOf(roster, lg);
  const must = need.total >= R - roster.length;
  return avail.find((p) => !must || (need.short[p.pos] || 0) > 0
    || (need.flex > 0 && ['RB', 'WR', 'TE'].includes(p.pos))) || avail[0];
};

// Everything that must be true of any finished draft, whatever the league.
function audit(tag, lg, slot, r, problems) {
  const T = mk.teamsOf(lg);
  const R = e.roundsOf(lg);
  const add = (m) => problems.push(`${tag}: ${m}`);

  if (new Set(r.log.map((x) => x.id)).size !== r.log.length) add('somebody was drafted twice');
  if (!r.log.every((x, i) => x.n === i + 1)) add('the pick numbers have a gap in them');
  for (const x of r.log) {
    if (mk.pickTeam(x.n, T) !== x.team) add(`pick ${x.n} was logged against team ${x.team}`);
  }
  if (!r.done) return;                       // a short pool is audited separately

  const mine = r.log.filter((x) => x.team === slot).map((x) => x.n);
  if (JSON.stringify(mine) !== JSON.stringify(e.myPicks(T, slot, R))) {
    add(`my picks came out ${mine.join(',')}`);
  }
  const caps = mk.capsOf(lg);
  for (const [t, ro] of Object.entries(r.rosters)) {
    if (ro.length !== R) add(`team ${t} finished with ${ro.length} of ${R}`);
    if (ro.some((p) => !p)) add(`team ${t} has a hole in its roster`);
    // The caps and the need rule bind the SIMULATED teams. A person is allowed to draft
    // four quarterbacks if he wants to, so his own team is exempt from both.
    if (+t === slot) continue;
    const n = mk.needsOf(ro, lg);
    if (n.total > 0) add(`team ${t} cannot field a lineup (short ${JSON.stringify(n.short)}, flex ${n.flex})`);
    for (const [pos, c] of Object.entries(caps)) {
      const got = ro.filter((p) => p.pos === pos).length;
      if (got > c) add(`team ${t} carries ${got} ${pos} against a cap of ${c}`);
    }
  }
}

// ---------------------------------------------------------------- 1. the real leagues
for (const lg of data.leagues) {
  const T = mk.teamsOf(lg);
  const R = e.roundsOf(lg);
  const total = T * R;
  const pool = data.players.filter((p) => e.inLeague(p, lg));
  const problems = [];
  let short = 0;

  for (let slot = 1; slot <= T; slot += 1) {
    for (const disc of [0, 40, 100]) {
      for (const seed of [1, 2, 3]) {
        const r = mk.simulate({ players: pool, league: lg, slot, disc, seed, choose: human(lg, R) });
        audit(`${lg.name} slot${slot} disc${disc} seed${seed}`, lg, slot, r, problems);
        if (!r.done) short += 1;
      }
    }
  }
  ok(`${lg.name}: every practice draft holds together`, problems.length === 0,
    [...new Set(problems)].slice(0, 3).join(' | '));

  // A draft may only fail to finish for one reason: there was nobody left to draft.
  //
  // This is a WARNING rather than a failure, for the same reason it is a warning in
  // check_data.py: no change to the code can fix it. The pool is as deep as the pool is.
  // Failing here would leave the suite permanently red over something the suite cannot
  // reach, and a permanently red suite is one nobody reads.
  if (short) {
    const r = mk.simulate({ players: pool, league: lg, slot: 1, disc: 40, seed: 1, choose: human(lg, R) });
    ok(`${lg.name}: a draft that stops says the board ran out`, r.ranOut === true);
    warnings.push(`${lg.name} drafts ${total} players but only ${pool.length} are in its `
      + `pool. Every practice draft in it stops ${total - pool.length} picks short, and on `
      + 'the night the board will not be able to show you who your rivals took. This is not '
      + 'a code bug - the data file needs more players.');
  } else {
    ok(`${lg.name}: the pool is deep enough to finish`, true);
  }
}

// ---------------------------------------------------------------- 2. awkward shapes
{
  const base = data.leagues[0];
  const pool = data.players;
  const shapes = [
    ['4 teams', { ...base, teams: 4 }],
    ['no teams field at all', { ...base, teams: undefined }],
    ['superflex', { ...base, starters: { ...base.starters, QB: 2 } }],
    ['no kicker, no defence', { ...base, starters: (() => { const s = { ...base.starters }; delete s.K; delete s.DEF; return s; })() }],
    ['three flex', { ...base, starters: { ...base.starters, FLEX: 3 } }],
    ['two tight ends', { ...base, starters: { ...base.starters, TE: 2 } }],
    ['no bench', { ...base, rounds: undefined, bench: 0 }],
  ];
  const problems = [];
  for (const [name, lg] of shapes) {
    const T = mk.teamsOf(lg);
    const R = e.roundsOf(lg);
    const usable = pool.filter((p) => e.inLeague(p, lg));
    if (usable.length < T * R) continue;         // covered by the shallow-pool check above
    for (const slot of [1, T]) {
      const r = mk.simulate({ players: usable, league: lg, slot, disc: 40, seed: 7, choose: human(lg, R) });
      audit(`${name} slot${slot}`, lg, slot, r, problems);
      if (!r.done) problems.push(`${name} slot${slot}: stalled at ${r.log.length}/${T * R}`);
    }
  }
  ok('odd league shapes still draft', problems.length === 0,
    [...new Set(problems)].slice(0, 3).join(' | '));
}

// ---------------------------------------------------------------- 3. the snake, both ways
{
  for (const T of [4, 8, 10, 12, 14, 18]) {
    const R = 15;
    let agree = true;
    for (let slot = 1; slot <= T; slot += 1) {
      for (const n of e.myPicks(T, slot, R)) if (mk.pickTeam(n, T) !== slot) agree = false;
    }
    ok(`${T} teams: pickTeam and myPicks describe the same snake`, agree);
    const owners = {};
    for (let n = 1; n <= T * R; n += 1) owners[mk.pickTeam(n, T)] = (owners[mk.pickTeam(n, T)] || 0) + 1;
    ok(`${T} teams: everyone gets the same number of picks`,
      Object.keys(owners).length === T && Object.values(owners).every((v) => v === R));
  }
}

// ---------------------------------------------------------------- 4. picking in slices
// The app never runs a draft in one go: it stops at every one of your picks, waits for you,
// and starts again. That path is the one that runs on the night, so it has to land in
// exactly the same place as one uninterrupted run of the same seed.
{
  const lg = data.leagues[1];
  const T = mk.teamsOf(lg);
  const R = e.roundsOf(lg);
  const pool = data.players.filter((p) => e.inLeague(p, lg));
  const slot = 8;
  const oneGo = mk.simulate({ players: pool, league: lg, slot, disc: 40, seed: 13, choose: human(lg, R) });

  const log = [];
  const order = [...pool].sort((a, b) => (a.adp || 999) - (b.adp || 999));
  let handed = 0;
  for (let guard = 0; guard < 400; guard += 1) {
    const part = mk.simulate({ players: pool, league: lg, slot, disc: 40, seed: 13, log });
    if (part.done) break;
    const n = log.length + 1;
    if (mk.pickTeam(n, T) !== slot) { ok('a sliced run only ever hands back on your pick', false, `handed back on pick ${n}`); break; }
    handed += 1;
    const taken = new Set(log.map((x) => x.id));
    const pick = human(lg, R)(order.filter((p) => !taken.has(p.id)), part.rosters[slot]);
    log.push({ n, team: slot, id: pick.id, pos: pick.pos, adp: pick.adp ?? null });
  }
  ok('a sliced draft stops at every one of your picks and no others', handed === R, `${handed} of ${R}`);
  ok('drafting in slices gives the same draft as running it in one go',
    JSON.stringify(oneGo.log.map((x) => x.id)) === JSON.stringify(log.map((x) => x.id)));
}

// ---------------------------------------------------------------- 5. undo, and a stale log
{
  const lg = data.leagues[1];
  const R = e.roundsOf(lg);
  const pool = data.players.filter((p) => e.inLeague(p, lg));
  const full = mk.simulate({ players: pool, league: lg, slot: 3, disc: 40, seed: 1, choose: (a) => a[0] });

  // Rewind forty picks and play them again. The room must answer the way it did before,
  // or "what if I had taken the other man" compares two different drafts.
  const rewound = full.log.slice(0, 60);
  const replay = mk.simulate({ players: pool, league: lg, slot: 3, disc: 40, seed: 1,
    log: [...rewound], choose: (a) => a[0] });
  ok('taking picks back and playing them again gives the same room',
    JSON.stringify(replay.log.map((x) => x.id)) === JSON.stringify(full.log.map((x) => x.id)));

  // The data file is rebuilt underneath a saved mock every time it refreshes, so a resumed
  // log can name somebody who is no longer in the pool. That used to throw and blank the tab.
  const shrunk = pool.filter((p) => p.id !== rewound[5].id);
  let threw = null;
  let out = null;
  try {
    out = mk.simulate({ players: shrunk, league: lg, slot: 3, disc: 40, seed: 1,
      log: [...rewound], choose: (a) => a[0] });
  } catch (err) { threw = err.message; }
  ok('resuming a mock whose log names a player who is gone does not throw', !threw, threw);
  ok('and it recovers into a finished, self-consistent draft',
    !!out && out.done && out.dropped > 0 && !Object.values(out.rosters).flat().some((p) => !p));
}

// ---------------------------------------------------------------- 6. the room does what it says
{
  const lg = data.leagues[1];
  const T = mk.teamsOf(lg);
  const R = e.roundsOf(lg);
  const pool = data.players.filter((p) => e.inLeague(p, lg));
  const drift = (disc) => {
    const r = mk.simulate({ players: pool, league: lg, slot: 1, disc, seed: 5, choose: (a) => a[0] });
    // measure before the last two rounds: everybody is forced onto kickers by then, and a
    // kicker taken 40 picks 'early' is the rule biting, not the room reaching
    const early = r.log.filter((x) => x.team !== 1 && x.adp && x.n <= (R - 2) * T);
    return early.reduce((a, x) => a + Math.abs(x.n - x.adp), 0) / early.length;
  };
  const tight = drift(0);
  const loose = drift(100);
  ok('a disciplined room stays close to the rankings', tight < 4, `${tight.toFixed(1)} picks off`);
  ok('a loose room reaches further than a tight one', loose > tight + 2,
    `tight ${tight.toFixed(1)}, loose ${loose.toFixed(1)}`);

  // kickers and defences belong at the end, in every league that has them
  const r = mk.simulate({ players: pool, league: lg, slot: 1, disc: 40, seed: 5, choose: (a) => a[0] });
  for (const pos of ['K', 'DEF']) {
    const rds = r.log.filter((x) => x.pos === pos).map((x) => mk.roundOf(x.n, T));
    if (!rds.length) continue;
    ok(`no simulated team takes a ${pos} early`, Math.min(...rds) >= R - 5,
      `earliest was round ${Math.min(...rds)} of ${R}`);
  }
}

// ---------------------------------------------------------------- report
console.log(`${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log('  FAIL', f);
for (const w of warnings) console.log(`\n  *** ${w}`);
process.exit(fails.length ? 1 : 0);
