// Let the app draft for itself from a few slots and print the teams it builds.
//
//   node test/_auto.mjs
//
// Not part of the suite - smoke.mjs is what asserts. This one prints, because the question
// it answers is "does this team look sane to a person", which no assertion can settle.
//
// It found three things the first time it ran, none of them in the simulator:
//   - once your starters were full, the need bonus lifted kickers and defences into the
//     middle of the board and the app drafted them in round 8,
//   - the built-in sample league scored every kicker and defence at zero, so the "best"
//     kicker was whoever happened to sort first,
//   - and the board still wants a second quarterback in a one-quarterback league.
// The first two are fixed. The third is a matter of taste and is left to the position lean.

import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const players = JSON.parse(fs.readFileSync(`${DIR}/data/players.json`, 'utf8'));

async function boot() {
  const dom = new JSDOM(fs.readFileSync(`${DIR}/index.html`, 'utf8'),
    { runScripts: 'outside-only', url: 'https://x.test/' });
  const { window } = dom;
  const errs = [];
  window.addEventListener('error', (e) => errs.push(e.message));
  window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  window.fetch = (u) => (String(u).includes('players.json')
    ? Promise.resolve({ json: () => Promise.resolve(JSON.parse(JSON.stringify(players))) })
    : Promise.reject(new TypeError('no network in here')));
  const store = {};
  Object.defineProperty(window, 'localStorage', { value: {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
  } });
  const rd = (f) => fs.readFileSync(`${DIR}/${f}`, 'utf8')
    .replace(/^export /gm, '').replace(/^import .*\n/gm, '');
  window.eval([rd('strategies.js'), rd('tips.js'), rd('engine.js'), rd('mock.js'),
    rd('sleeper.js'), rd('app.js')].join('\n'));
  await new Promise((r) => setTimeout(r, 400));
  return { window, d: window.document, errs, store };
}

const settle = () => new Promise((r) => setTimeout(r, 40));
const byId = (id) => players.players.find((p) => p.id === id);

// slot, and an optional strategy preset to apply on the ratings page first
for (const [slot, strat] of [[1, null], [6, null], [12, null], [6, 'zero']]) {
  const { window, d, errs, store } = await boot();
  if (strat) {
    d.querySelector('[data-v="ratings"]').click();
    await settle();
    d.querySelector(`[data-strat="${strat}"]`)?.click();
    await settle();
  }
  d.querySelector('[data-v="mock"]').click();
  await settle();
  d.querySelector('#mockSlot').value = String(slot);
  const t0 = Date.now();
  d.querySelector('#mockAll').click();
  await settle();
  const ms = Date.now() - t0;

  window.dispatchEvent(new window.Event('pagehide'));
  const st = JSON.parse(store.draft2026 || '{}');
  const mine = st.picks[0].mine.map(byId);
  const counts = {};
  for (const p of mine) counts[p.pos] = (counts[p.pos] || 0) + 1;

  console.log(`\n=========== slot ${slot}${strat ? `, strategy "${strat}"` : ''}`
    + `  (${ms}ms, finished=${st.mock?.done})`);
  console.log(`  ${mine.map((p) => `${p.pos} ${p.name}`).join(' | ')}`);
  console.log(`  ${JSON.stringify(counts)}`);
  d.querySelector('[data-v="mock"]').click();
  await settle();
  console.log(`  ${d.querySelector('#mockOut').textContent.replace(/\s+/g, ' ').slice(0, 340)}`);
  console.log(`  errors: ${errs.join('; ') || 'none'}`);
}
