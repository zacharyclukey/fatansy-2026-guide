// Second hunt: why a "by the book" room is still 44 picks off ADP somewhere, and whether
// the end-of-draft report can be built for any slot without blowing up.
import { readFileSync } from 'node:fs';

const DIR = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, '');
const e = await import(`file://${DIR}/engine.js`);
const mk = await import(`file://${DIR}/mock.js`);
const players = JSON.parse(readFileSync(`${DIR}/data/players.json`, 'utf8'));
const lg = e.SAMPLE_LEAGUE;
const pool = players.players.filter((p) => e.inLeague(p, lg));
const byId = new Map(pool.map((p) => [p.id, p]));
const T = lg.teams;
const R = e.roundsOf(lg);
const total = T * R;

const run = mk.simulate({ players: pool, league: lg, slot: 1, disc: 0, seed: 9, choose: (a) => a[0] });
const ai = run.log.filter((x) => x.team !== 1 && x.adp);
ai.sort((a, b) => Math.abs(b.n - b.adp) - Math.abs(a.n - a.adp));
console.log('--- the ten picks furthest from ADP in a by-the-book room ---');
for (const x of ai.slice(0, 10)) {
  const p = byId.get(x.id);
  console.log(`  pick ${String(x.n).padStart(3)} rd ${String(mk.roundOf(x.n, T)).padStart(2)}  ${p.name.padEnd(22)} ${p.pos}  adp ${String(x.adp).padStart(5)}  ${x.n - x.adp > 0 ? 'fell' : 'reached'} ${Math.abs(Math.round(x.n - x.adp))}`);
}

// how much of the drift is just "ADP is not a pick number"? Compare against a room that
// takes strictly the best ADP available every time.
{
  const gone = new Set();
  const order = [...pool].sort((a, b) => (a.adp || 999) - (b.adp || 999));
  let off = 0; let n = 0; let worst = 0;
  for (let i = 1; i <= total; i += 1) {
    const p = order.find((q) => !gone.has(q.id));
    gone.add(p.id);
    if (p.adp) { off += Math.abs(i - p.adp); n += 1; worst = Math.max(worst, Math.abs(i - p.adp)); }
  }
  console.log(`\na room with NO randomness at all: avg ${(off / n).toFixed(1)} picks off ADP, worst ${worst.toFixed(0)}`);
  console.log('(that is the floor - ADP is a market average, not a pick number, so it can never be 0)');
}

// ---- ADP coverage: how many of the players who actually get drafted have one?
{
  const withAdp = run.log.filter((x) => x.adp).length;
  const ranked = run.log.filter((x) => mk.isRanked(x.adp, total)).length;
  console.log(`\n${withAdp}/${total} picks had an ADP at all; ${ranked} had one inside the draft`);
  const noAdp = run.log.filter((x) => !x.adp);
  console.log(`first pick with no ADP: ${noAdp.length ? `#${noAdp[0].n} (round ${mk.roundOf(noAdp[0].n, T)})` : 'none'}`);
}

// ---- the report, for every slot: byes, lineup, cost
console.log('\n--- what the report has to say, slot by slot ---');
for (let slot = 1; slot <= T; slot += 1) {
  const r = mk.simulate({ players: pool, league: lg, slot, disc: 40, seed: 42,
    choose: (avail, roster) => {
      const need = mk.needsOf(roster, lg);
      const must = need.total >= R - roster.length;
      return avail.find((p) => !must || (need.short[p.pos] || 0) > 0
        || (need.flex > 0 && ['RB', 'WR', 'TE'].includes(p.pos))) || avail[0];
    } });
  const mine = r.rosters[slot];
  const start = e.bestLineup ? e.bestLineup(mine, lg) : null;
  const byes = {};
  for (const p of mine) if (p.bye) byes[p.bye] = (byes[p.bye] || 0) + 1;
  const clash = Object.entries(byes).filter(([, c]) => c >= 3).map(([w, c]) => `wk${w}x${c}`);
  const noBye = mine.filter((p) => !p.bye).length;
  const words = r.log.filter((x) => x.team === slot).map((x) => mk.adpWord(x.n, x.adp, total));
  const blank = words.filter((w) => !w).length;
  console.log(`slot ${String(slot).padStart(2)}: ${mine.map((p) => p.pos).join(' ')}`);
  console.log(`        byes ${Object.keys(byes).length} weeks${clash.length ? ` CLASH ${clash.join(' ')}` : ''}${noBye ? `, ${noBye} with no bye` : ''}, lineup ${start ? 'built' : 'n/a'}, ${blank} picks with no verdict`);
}

// ---- adpWord over the whole range, so nothing reads like nonsense
console.log('\n--- what the verdicts say ---');
for (const [n, adp] of [[1, 1], [10, 22], [10, 14], [10, 11], [10, 10], [10, 7], [10, 1],
  [180, 300], [50, null], [1, 0]]) {
  console.log(`  pick ${n}, adp ${adp}: ${mk.adpWord(n, adp, total)}`);
}
