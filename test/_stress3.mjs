// Third hunt: the resume path, superflex scarcity, and whether the run bonus does anything.
import { readFileSync } from 'node:fs';

const DIR = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, '');
const e = await import(`file://${DIR}/engine.js`);
const mk = await import(`file://${DIR}/mock.js`);
const players = JSON.parse(readFileSync(`${DIR}/data/players.json`, 'utf8'));
const lg = e.SAMPLE_LEAGUE;
const pool = players.players.filter((p) => e.inLeague(p, lg));
const R = e.roundsOf(lg);

// ---------------------------------------------------------------- A. a log with a stranger in it
// The app keeps a mock in progress in localStorage. If players.json is refreshed underneath
// it - which happens every time the data file is rebuilt - a saved log can name a player who
// is no longer in the pool. simulate() rebuilds rosters with players.find(); a miss puts
// undefined in a roster, and everything downstream reads p.pos off it.
console.log('--- A. resuming a mock whose log names a player who is gone ---');
{
  const seed = mk.simulate({ players: pool, league: lg, slot: 3, disc: 40, seed: 1,
    choose: (a) => a[0] });
  const log = seed.log.slice(0, 40);
  const shrunk = pool.filter((p) => p.id !== log[5].id);   // that player no longer exists
  try {
    const out = mk.simulate({ players: shrunk, league: lg, slot: 3, disc: 40, seed: 1,
      log: [...log], choose: (a) => a[0] });
    const holes = Object.values(out.rosters).flat().filter((p) => !p).length;
    console.log(`  survived: ${out.log.length} picks, done=${out.done}, ${holes} undefined in rosters`);
    if (holes) console.log('  ! a roster contains undefined - anything reading p.pos will throw');
  } catch (err) {
    console.log(`  ! THREW: ${err.message}`);
  }
}

// and the same thing one layer up: needsOf on a roster with a hole
console.log('--- and what needsOf does with one ---');
try {
  mk.needsOf([{ pos: 'RB' }, undefined], lg);
  console.log('  needsOf survived a hole');
} catch (err) {
  console.log(`  ! needsOf THREW: ${err.message}`);
}

// ---------------------------------------------------------------- B. does the run bonus bite?
console.log('\n--- B. positional runs ---');
{
  const streaks = (log) => {
    let longest = 1; let cur = 1; let twos = 0;
    for (let i = 1; i < log.length; i += 1) {
      if (log[i].pos === log[i - 1].pos) { cur += 1; if (cur === 2) twos += 1; } else cur = 1;
      longest = Math.max(longest, cur);
    }
    return { longest, twos };
  };
  for (const disc of [0, 40, 100]) {
    const all = [];
    for (let seed = 1; seed <= 20; seed += 1) {
      const r = mk.simulate({ players: pool, league: lg, slot: 1, disc, seed, choose: (a) => a[0] });
      all.push(streaks(r.log.slice(0, 120)));   // first ten rounds, before the K/DEF tail
    }
    const avgL = all.reduce((a, s) => a + s.longest, 0) / all.length;
    const avgT = all.reduce((a, s) => a + s.twos, 0) / all.length;
    console.log(`  disc ${String(disc).padStart(3)}: longest run ${avgL.toFixed(1)}, ${avgT.toFixed(1)} back-to-back pairs in 120 picks`);
  }
}

// ---------------------------------------------------------------- C. superflex scarcity
console.log('\n--- C. superflex: 12 teams must start 24 QBs ---');
{
  const sf = { ...lg, starters: { ...lg.starters, QB: 2 } };
  const qbs = pool.filter((p) => p.pos === 'QB').length;
  console.log(`  ${qbs} quarterbacks in the pool`);
  const r = mk.simulate({ players: pool, league: sf, slot: 1, disc: 40, seed: 3,
    choose: (avail, roster) => {
      const need = mk.needsOf(roster, sf);
      const must = need.total >= R - roster.length;
      return avail.find((p) => !must || (need.short[p.pos] || 0) > 0
        || (need.flex > 0 && ['RB', 'WR', 'TE'].includes(p.pos))) || avail[0];
    } });
  const taken = r.log.filter((x) => x.pos === 'QB');
  const rds = taken.map((x) => mk.roundOf(x.n, lg.teams));
  console.log(`  ${taken.length} QBs taken, first in round ${Math.min(...rds)}, last in round ${Math.max(...rds)}`);
  const short = Object.entries(r.rosters).filter(([, ro]) => mk.needsOf(ro, sf).total > 0);
  console.log(`  ${short.length} teams could not fill a lineup`);
  const r1 = r.log.slice(0, 12).map((x) => x.pos).join(' ');
  console.log(`  round 1: ${r1}`);
  if (!r1.includes('QB')) console.log('  ! not one QB in round one of a superflex draft - the room follows single-QB ADP');
}

// ---------------------------------------------------------------- D. the forced cliff
console.log('\n--- D. when every team fills its last slots at once ---');
{
  const r = mk.simulate({ players: pool, league: lg, slot: 1, disc: 40, seed: 5, choose: (a) => a[0] });
  for (let rd = R - 3; rd <= R; rd += 1) {
    const picks = r.log.filter((x) => mk.roundOf(x.n, lg.teams) === rd);
    const by = {};
    for (const x of picks) by[x.pos] = (by[x.pos] || 0) + 1;
    console.log(`  round ${rd}: ${Object.entries(by).map(([p, c]) => `${c} ${p}`).join(', ')}`);
  }
}

// ---------------------------------------------------------------- E. does anyone go undrafted who shouldn't?
console.log('\n--- E. top-of-the-board players left on the table ---');
{
  const r = mk.simulate({ players: pool, league: lg, slot: 1, disc: 40, seed: 8, choose: (a) => a[0] });
  const gone = new Set(r.log.map((x) => x.id));
  const left = [...pool].sort((a, b) => (a.adp || 999) - (b.adp || 999))
    .filter((p) => !gone.has(p.id)).slice(0, 8);
  for (const p of left) console.log(`  adp ${String(p.adp).padStart(5)}  ${p.name.padEnd(22)} ${p.pos}`);
}

// ---------------------------------------------------------------- F. an empty or one-man pool
console.log('\n--- F. degenerate pools ---');
for (const [name, arr] of [['empty', []], ['one player', pool.slice(0, 1)]]) {
  try {
    const r = mk.simulate({ players: arr, league: lg, slot: 1, disc: 40, seed: 1, choose: (a) => a[0] });
    console.log(`  ${name}: ${r.log.length} picks, done=${r.done}`);
  } catch (err) {
    console.log(`  ! ${name} THREW: ${err.message}`);
  }
}

// ---------------------------------------------------------------- G. slot out of range
console.log('\n--- G. a slot nobody owns ---');
for (const slot of [0, 13, 99]) {
  try {
    const r = mk.simulate({ players: pool, league: lg, slot, disc: 40, seed: 1, choose: (a) => a[0] });
    const mine = r.log.filter((x) => x.team === slot).length;
    console.log(`  slot ${slot}: ${r.log.length} picks, done=${r.done}, ${mine} of them mine`);
  } catch (err) {
    console.log(`  ! slot ${slot} THREW: ${err.message}`);
  }
}
