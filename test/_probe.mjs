// Play three practice drafts and print what the app SAID at every one of your picks.
//
//   node test/_probe.mjs
//
// Not part of the suite - smoke.mjs is what asserts. This one asserts nothing and reads
// everything, which is the only way to find the class of bug where the app is working
// perfectly and telling you something silly. It found four of them the first time it ran:
// the recommendation panel was a draft behind on the very first pick, a finished draft
// told you to enter your draft slot, the board could reach round 13 with nothing on screen
// left to take, and picks were being priced against an ADP from past the end of the draft.
//
// The drafter here is deliberately naive - it always takes the top of your board - which
// is the strategy most likely to embarrass the app.

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

const settle = () => new Promise((r) => setTimeout(r, 25));
const text = (d, sel) => (d.querySelector(sel)?.textContent || '').replace(/\s+/g, ' ').trim();
// the tells that something rendered from a value nobody meant to print
const junk = (s) => /NaN|undefined|Infinity|\[object|null/.test(s);

for (const SLOT of [1, 6, 12]) {
  const { window, d, errs, store } = await boot();
  d.querySelector('[data-v="mock"]').click();
  await settle();
  d.querySelector('#mockSlot').value = String(SLOT);
  d.querySelector('#mockStart').click();
  await settle();

  console.log(`\n================================================ slot ${SLOT}`);
  let guard = 0;
  while (guard++ < 40) {
    window.dispatchEvent(new window.Event('pagehide'));      // flush the debounced save
    const st = JSON.parse(store.draft2026 || '{}');
    if (!st.mock || st.mock.done) break;
    const n = st.mock.log.length + 1;
    for (const [what, sel] of [['advice', '#advice'], ['banner', '#mockBar'], ['lean', '#lean']]) {
      const s = text(d, sel);
      if (junk(s)) console.log(`  !! pick ${n} ${what}: ${s.slice(0, 140)}`);
    }
    if (!text(d, '#advice')) console.log(`  !! pick ${n}: nothing in the advice panel`);
    const row = d.querySelector('.row.player:not(.drafted)');
    if (!row) { console.log(`  !! pick ${n}: nothing on screen left to take`); break; }
    console.log(`  pick ${String(n).padStart(3)}: ${text(d, '#advice').slice(0, 120)}`);
    row.querySelector('[data-m]').click();
    await settle();
  }

  d.querySelector('[data-v="roster"]').click();
  await settle();
  if (junk(text(d, '#v-roster'))) console.log('  !! junk on the roster page');
  d.querySelector('[data-v="mock"]').click();
  await settle();
  console.log(`\n  REPORT: ${text(d, '#mockOut').slice(0, 900)}`);
  console.log(`  errors: ${errs.join('; ') || 'none'}`);
}
