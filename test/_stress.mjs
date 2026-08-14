// Throwaway hunt harness. Runs the simulator over far more configurations than the smoke
// suite does, looking for a shape of league that makes it stall, cheat or produce an
// illegal roster. Not part of the suite; anything it finds gets a permanent test written
// for it in smoke.mjs.
import { readFileSync } from 'node:fs';

const DIR = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, '');
const e = await import(`file://${DIR}/engine.js`);
const mk = await import(`file://${DIR}/mock.js`);
const players = JSON.parse(readFileSync(`${DIR}/data/players.json`, 'utf8'));

const bad = [];
const note = (m) => bad.push(m);

function check(tag, lg, slot, run) {
  const T = mk.teamsOf(lg);
  const R = e.roundsOf(lg);
  const total = T * R;
  if (!run.done) note(`${tag}: STALLED at ${run.log.length}/${total}`);
  if (new Set(run.log.map((x) => x.id)).size !== run.log.length) note(`${tag}: duplicate pick`);
  if (!run.log.every((x, i) => x.n === i + 1)) note(`${tag}: pick numbers have gaps`);
  for (const x of run.log) {
    if (mk.pickTeam(x.n, T) !== x.team) note(`${tag}: pick ${x.n} logged to team ${x.team}`);
  }
  const mine = run.log.filter((x) => x.team === slot).map((x) => x.n);
  const want = e.myPicks(T, slot, R);
  if (JSON.stringify(mine) !== JSON.stringify(want)) note(`${tag}: my picks ${mine} != ${want}`);
  const caps = mk.capsOf(lg);
  for (const [t, roster] of Object.entries(run.rosters)) {
    if (run.done && roster.length !== R) note(`${tag}: team ${t} has ${roster.length}/${R}`);
    const n = mk.needsOf(roster, lg);
    if (run.done && n.total > 0) note(`${tag}: team ${t} cannot start a lineup (${JSON.stringify(n.short)} flex ${n.flex})`);
    for (const [pos, c] of Object.entries(caps)) {
      const got = roster.filter((p) => p.pos === pos).length;
      if (got > c) note(`${tag}: team ${t} has ${got} ${pos} over cap ${c}`);
    }
  }
}

// a human who takes the best man who fills something he still needs
const human = (lg, R) => (avail, roster) => {
  const need = mk.needsOf(roster, lg);
  const must = need.total >= R - roster.length;
  return avail.find((p) => !must || (need.short[p.pos] || 0) > 0
    || (need.flex > 0 && ['RB', 'WR', 'TE'].includes(p.pos))) || avail[0];
};

const base = e.SAMPLE_LEAGUE;
const pool = players.players.filter((p) => e.inLeague(p, base));
console.log(`pool ${pool.length}, sample league ${JSON.stringify(base.starters)} rounds ${e.roundsOf(base)}`);

// ---------------------------------------------------------------- 1. every slot x discipline
let runs = 0;
const t0 = Date.now();
for (let slot = 1; slot <= base.teams; slot += 1) {
  for (const disc of [0, 20, 40, 60, 80, 100]) {
    for (const seed of [1, 2, 3]) {
      const run = mk.simulate({ players: pool, league: base, slot, disc, seed,
        choose: human(base, e.roundsOf(base)) });
      check(`slot${slot} disc${disc} seed${seed}`, base, slot, run);
      runs += 1;
    }
  }
}
console.log(`${runs} full drafts in ${Date.now() - t0}ms (${((Date.now() - t0) / runs).toFixed(1)}ms each)`);

// ---------------------------------------------------------------- 2. odd league shapes
const shapes = [
  ['4 teams', { ...base, teams: 4 }],
  ['14 teams', { ...base, teams: 14 }],
  ['no teams field', { ...base, teams: undefined }],
  ['superflex', { ...base, starters: { ...base.starters, QB: 2 } }],
  ['no kicker or defence', { ...base, starters: (() => { const s = { ...base.starters }; delete s.K; delete s.DEF; return s; })() }],
  ['3 flex', { ...base, starters: { ...base.starters, FLEX: 3 } }],
  ['tiny bench', { ...base, bench: 0 }],
  ['huge bench', { ...base, bench: 12 }],
  ['2 TE', { ...base, starters: { ...base.starters, TE: 2 } }],
];
for (const [name, lg] of shapes) {
  const T = mk.teamsOf(lg);
  const R = e.roundsOf(lg);
  for (const slot of [1, Math.ceil(T / 2), T]) {
    const run = mk.simulate({ players: pool, league: lg, slot, disc: 40, seed: 7, choose: human(lg, R) });
    check(`${name} slot${slot}`, lg, slot, run);
  }
  console.log(`${name}: ${T} teams x ${R} rounds = ${T * R} picks`);
}

// ---------------------------------------------------------------- 3. starved pools
for (const size of [400, 200, 190, 181, 180, 179, 120]) {
  const small = pool.slice(0, size);
  const run = mk.simulate({ players: small, league: base, slot: 6, disc: 40, seed: 3,
    choose: human(base, e.roundsOf(base)) });
  const total = base.teams * e.roundsOf(base);
  console.log(`pool ${size} -> ${run.log.length}/${total} picks, done=${run.done}`);
  if (size >= total && !run.done) note(`pool ${size}: stalled with enough players`);
  if (new Set(run.log.map((x) => x.id)).size !== run.log.length) note(`pool ${size}: duplicate`);
}

// a pool with no kickers at all, in a league that starts one
{
  const noK = pool.filter((p) => p.pos !== 'K');
  const run = mk.simulate({ players: noK, league: base, slot: 2, disc: 40, seed: 4,
    choose: human(base, e.roundsOf(base)) });
  console.log(`no kickers in the pool -> ${run.log.length} picks, done=${run.done}`);
  if (!run.done) note('a pool with no kickers stalls the draft');
}

// every player missing an ADP
{
  const noAdp = pool.map((p) => ({ ...p, adp: null }));
  const run = mk.simulate({ players: noAdp, league: base, slot: 5, disc: 40, seed: 6,
    choose: human(base, e.roundsOf(base)) });
  console.log(`no ADP anywhere -> ${run.log.length} picks, done=${run.done}`);
  check('no adp', base, 5, run);
}

// ---------------------------------------------------------------- 4. what the room does
const shape = (disc) => {
  const run = mk.simulate({ players: pool, league: base, slot: 1, disc, seed: 9, choose: (a) => a[0] });
  const ai = run.log.filter((x) => x.team !== 1 && x.adp);
  const off = ai.map((x) => Math.abs(x.n - x.adp));
  const mean = off.reduce((a, b) => a + b, 0) / off.length;
  const r1 = run.log.slice(0, base.teams).map((x) => x.pos).join(' ');
  const last = run.log.slice(-base.teams).map((x) => x.pos).join(' ');
  return { disc, mean: mean.toFixed(1), worst: Math.max(...off), r1, last };
};
for (const d of [0, 25, 50, 75, 100]) {
  const s = shape(d);
  console.log(`disc ${String(d).padStart(3)}  avg ${s.mean} picks off ADP, worst ${s.worst}`);
  console.log(`   round 1: ${s.r1}`);
  console.log(`   last rd: ${s.last}`);
}

// when do kickers and defences actually go?
{
  const run = mk.simulate({ players: pool, league: base, slot: 1, disc: 40, seed: 9, choose: (a) => a[0] });
  const R = e.roundsOf(base);
  for (const pos of ['K', 'DEF', 'QB', 'TE']) {
    const rds = run.log.filter((x) => x.pos === pos).map((x) => mk.roundOf(x.n, base.teams));
    console.log(`${pos}: ${rds.length} taken, rounds ${Math.min(...rds)}-${Math.max(...rds)}`);
    if (pos === 'K' && Math.min(...rds) < R - 3) note(`a kicker went in round ${Math.min(...rds)} of ${R}`);
  }
}

// ---------------------------------------------------------------- 5. resumability
// the app runs the simulator in slices, handing back at every one of the user's picks.
// Doing it that way must land in exactly the same place as one uninterrupted run.
{
  const R = e.roundsOf(base);
  const slot = 8;
  const one = mk.simulate({ players: pool, league: base, slot, disc: 40, seed: 13, choose: human(base, R) });
  const log = [];
  for (let i = 0; i < 200; i += 1) {
    const part = mk.simulate({ players: pool, league: base, slot, disc: 40, seed: 13, log });
    if (part.done) break;
    const n = log.length + 1;
    if (mk.pickTeam(n, base.teams) !== slot) { note('sliced run handed back on someone else\'s pick'); break; }
    const avail = [...pool].sort((a, b) => (a.adp || 999) - (b.adp || 999)).filter((p) => !log.some((x) => x.id === p.id));
    const pick = human(base, R)(avail, part.rosters[slot]);
    log.push({ n, team: slot, id: pick.id, pos: pick.pos, adp: pick.adp ?? null });
  }
  const same = JSON.stringify(one.log.map((x) => x.id)) === JSON.stringify(log.map((x) => x.id));
  console.log(`sliced run matches one shot: ${same} (${log.length} picks)`);
  if (!same) note('running the draft in slices gives a different draft');
}

console.log(`\n${bad.length} problems`);
for (const b of [...new Set(bad)]) console.log('  !', b);
