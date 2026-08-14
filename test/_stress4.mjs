// Fourth hunt: run everything against Zach's ACTUAL leagues (FLEX 2, 15 and 16 rounds),
// not the FLEX 1 sample, and isolate whether the positional-run bonus does anything at all.
import { readFileSync } from 'node:fs';

const DIR = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, '');
const e = await import(`file://${DIR}/engine.js`);
const mk = await import(`file://${DIR}/mock.js`);
const data = JSON.parse(readFileSync(`${DIR}/data/players.json`, 'utf8'));

const bad = [];
const human = (lg, R) => (avail, roster) => {
  const need = mk.needsOf(roster, lg);
  const must = need.total >= R - roster.length;
  return avail.find((p) => !must || (need.short[p.pos] || 0) > 0
    || (need.flex > 0 && ['RB', 'WR', 'TE'].includes(p.pos))) || avail[0];
};

for (const lg of data.leagues) {
  const T = mk.teamsOf(lg);
  const R = e.roundsOf(lg);
  const total = T * R;
  const pool = data.players.filter((p) => e.inLeague(p, lg));
  console.log(`\n=== ${lg.name} — ${T} teams x ${R} rounds = ${total} picks, pool ${pool.length}`);
  console.log(`    starters ${JSON.stringify(lg.starters)} bench ${lg.bench}`);

  let runs = 0;
  const t0 = Date.now();
  for (let slot = 1; slot <= T; slot += 1) {
    for (const disc of [0, 40, 100]) {
      for (const seed of [1, 2, 3, 4]) {
        const r = mk.simulate({ players: pool, league: lg, slot, disc, seed, choose: human(lg, R) });
        const tag = `${lg.name} slot${slot} disc${disc} seed${seed}`;
        runs += 1;
        if (!r.done) bad.push(`${tag}: stalled at ${r.log.length}/${total}`);
        if (new Set(r.log.map((x) => x.id)).size !== r.log.length) bad.push(`${tag}: duplicate`);
        for (const x of r.log) if (mk.pickTeam(x.n, T) !== x.team) bad.push(`${tag}: pick ${x.n} on wrong team`);
        const mine = r.log.filter((x) => x.team === slot).map((x) => x.n);
        if (JSON.stringify(mine) !== JSON.stringify(e.myPicks(T, slot, R))) bad.push(`${tag}: my picks wrong`);
        // caps only bind the simulated teams; a human is allowed to draft four kickers
        const caps = mk.capsOf(lg);
        for (const [t, ro] of Object.entries(r.rosters)) {
          if (+t === slot) continue;
          if (ro.length !== R) bad.push(`${tag}: team ${t} has ${ro.length}/${R}`);
          const n = mk.needsOf(ro, lg);
          if (n.total > 0) bad.push(`${tag}: team ${t} cannot start (${JSON.stringify(n.short)} flex ${n.flex})`);
          for (const [pos, c] of Object.entries(caps)) {
            const got = ro.filter((p) => p.pos === pos).length;
            if (got > c) bad.push(`${tag}: team ${t} has ${got} ${pos} over cap ${c}`);
          }
        }
      }
    }
  }
  console.log(`    ${runs} full drafts in ${Date.now() - t0}ms`);

  // where do the positions actually go in HIS league
  const r = mk.simulate({ players: pool, league: lg, slot: 6, disc: 40, seed: 1, choose: human(lg, R) });
  for (const pos of ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']) {
    const rds = r.log.filter((x) => x.pos === pos).map((x) => mk.roundOf(x.n, T));
    if (!rds.length) { console.log(`    ${pos}: none taken`); continue; }
    console.log(`    ${pos}: ${String(rds.length).padStart(3)} taken, rounds ${Math.min(...rds)}-${Math.max(...rds)}`);
  }
  const mine = r.rosters[6];
  console.log(`    slot 6 came away with: ${mine.map((p) => p.pos).join(' ')}`);
  const byes = {};
  for (const p of mine) byes[p.bye] = (byes[p.bye] || 0) + 1;
  const worstWk = Object.entries(byes).sort((a, b) => b[1] - a[1])[0];
  console.log(`    worst bye week: ${worstWk[1]} of his ${mine.length} on bye in week ${worstWk[0]}`);
}

// ---------------------------------------------------------------- the run bonus, isolated
// roomParams ties the run bonus to tau, so the slider cannot separate them. Compare the
// model against itself with the bonus forced to zero, same seeds, same everything else.
console.log('\n=== does the positional-run bonus change anything ===');
{
  const lg = data.leagues[0];
  const T = mk.teamsOf(lg);
  const R = e.roundsOf(lg);
  const pool = data.players.filter((p) => e.inLeague(p, lg));
  const order = [...pool].sort((a, b) => (a.adp || 999) - (b.adp || 999));

  // re-implement the loop so the run bonus can be switched off, which simulate() will not do
  const go = (seed, useRun) => {
    const params = mk.roomParams(40);
    const caps = mk.capsOf(lg);
    const gone = new Set();
    const rosters = {};
    for (let t = 1; t <= T; t += 1) rosters[t] = [];
    const log = [];
    for (let n = 1; n <= T * R; n += 1) {
      const team = mk.pickTeam(n, T);
      const avail = order.filter((p) => !gone.has(p.id));
      const pick = mk.aiPick(avail, rosters[team], lg, {
        params, caps,
        picksLeft: R - rosters[team].length,
        runPos: useRun ? mk.runPosOf(log) : null,
        rnd: mk.mulberry32(seed * 7919 + n),
      });
      gone.add(pick.id);
      rosters[team].push(pick);
      log.push({ n, team, id: pick.id, pos: pick.pos });
    }
    return log;
  };

  const pairs = (log) => {
    let c = 0;
    for (let i = 1; i < log.length; i += 1) if (log[i].pos === log[i - 1].pos) c += 1;
    return c;
  };
  let on = 0; let off = 0; let differ = 0;
  const N = 25;
  for (let s = 1; s <= N; s += 1) {
    const a = go(s, true); const b = go(s, false);
    on += pairs(a.slice(0, 120)); off += pairs(b.slice(0, 120));
    if (a.map((x) => x.id).join() !== b.map((x) => x.id).join()) differ += 1;
  }
  console.log(`  back-to-back same-position pairs in the first 120 picks:`);
  console.log(`    run bonus ON : ${(on / N).toFixed(1)}`);
  console.log(`    run bonus OFF: ${(off / N).toFixed(1)}`);
  console.log(`  the two produced a different draft in ${differ}/${N} seeds`);
  if (Math.abs(on - off) / N < 0.5) {
    console.log('  ! the run bonus moves the count by less than half a pair - it is close to decoration');
  }
}
console.log(`\n${bad.length} problems`);
for (const b of [...new Set(bad)].slice(0, 20)) console.log('  !', b);
