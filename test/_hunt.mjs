// A bug hunt, not a test suite. Asserts nothing, reads everything, prints anything that
// looks wrong. smoke.mjs is what gates a commit; this is what finds the things to add to it.
//
//   node test/_hunt.mjs
//
// Written after the value window replaced the 0-100 rating and the fifty-stat editor was
// cut to four sliders. Removals that big have silently broken this app before.

import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const players = JSON.parse(fs.readFileSync(`${DIR}/data/players.json`, 'utf8'));

async function boot({ store = {} } = {}) {
  const errs = [];
  const vc = new (await import('jsdom')).VirtualConsole();
  vc.on('jsdomError', (e) => errs.push(`jsdomError: ${e.message}`));
  vc.on('error', (...a) => errs.push(`console.error: ${a.join(' ')}`));
  const dom = new JSDOM(fs.readFileSync(`${DIR}/index.html`, 'utf8'),
    { runScripts: 'outside-only', url: 'https://x.test/', virtualConsole: vc });
  const { window } = dom;
  window.addEventListener('error', (e) => errs.push(`window.onerror: ${e.message}`));
  window.addEventListener('unhandledrejection', (e) => errs.push(`rejection: ${e.reason}`));
  window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  window.fetch = (u) => (String(u).includes('players.json')
    ? Promise.resolve({ json: () => Promise.resolve(JSON.parse(JSON.stringify(players))) })
    : Promise.resolve({ ok: false, status: 404 }));
  Object.defineProperty(window, 'localStorage', { value: {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
  } });
  const rd = (f) => fs.readFileSync(`${DIR}/${f}`, 'utf8')
    .replace(/^export /gm, '').replace(/^import .*\n/gm, '');
  try {
    window.eval([rd('strategies.js'), rd('tips.js'), rd('engine.js'), rd('mock.js'),
      rd('sleeper.js'), rd('app.js')].join('\n'));
  } catch (e) { errs.push(`eval threw: ${e.message}`); }
  await new Promise((r) => setTimeout(r, 400));
  // A fresh install force-shows the setup page. Every probe below is about the board, so
  // put it back — this is also the bug that made the first run of this file lie to me.
  window.document.querySelector('[data-v="board"]').click();
  await new Promise((r) => setTimeout(r, 60));
  return { window, d: window.document, errs, store };
}

const settle = () => new Promise((r) => setTimeout(r, 60));
const text = (d, sel) => (d.querySelector(sel)?.textContent || '').replace(/\s+/g, ' ').trim();
const junk = (s) => /NaN|undefined|Infinity|\[object/.test(s);
const fire = (el, type) => el.dispatchEvent(
  new el.ownerDocument.defaultView.Event(type, { bubbles: true }));
let problems = 0;
const bad = (m) => { problems += 1; console.log(`  !! ${m}`); };

const VIEWS = ['board', 'roster', 'mock', 'ratings', 'setup'];

// ---------------------------------------------------------------- 1. every view, fresh
console.log('\n=== 1. every view on a fresh install');
{
  const { d, errs } = await boot();
  for (const v of VIEWS) {
    d.querySelector(`[data-v="${v}"]`).click();
    await settle();
    const sec = d.querySelector(`#v-${v}`);
    if (sec.hidden) bad(`${v}: section still hidden after clicking its tab`);
    const t = (sec.textContent || '').replace(/\s+/g, ' ').trim();
    if (junk(t)) bad(`${v}: junk on screen — ${t.match(/.{0,60}(NaN|undefined|Infinity|\[object).{0,40}/)?.[0]}`);
    if (t.length < 30) bad(`${v}: view is empty (${t.length} chars)`);
    console.log(`  ${v.padEnd(8)} ok  ${t.length} chars`);
  }
  if (errs.length) bad(`console errors: ${errs.join(' | ')}`);
}

// ---------------------------------------------------------------- 2. old-schema settings
// Zach has been using this app. What is in his localStorage right now is the shape from
// before the value window and the four sliders existed: comp/sub/tilt/style, no `fit`.
console.log('\n=== 2. a saved profile from the old schema');
{
  const old = {
    league: 0,
    stars: ['4046'], fades: ['4034'],
    tilt: 0.8,
    need: 12,
    style: 80,
    rookie: true,
    rookieMax: 10,          // the old, too-big value
    styleBudget: 15,
    posx: { RB: 1.1, WR: 0.95 },
    // components that no longer exist, plus real ones with edited weights
    comp: { volume: 30, role: 20, reliability: 10, production: 15, upside: 10,
      explosive: 5, efficiency: 5, redzone: 5, situation: 5, floor: 20, ceiling: 20 },
    // a hand-edited sub-weight map, plus a stat that has since been deleted
    sub: { games: { on: true, w: { QB: 10, RB: 40, WR: 10, TE: 10 } },
      a_stat_that_no_longer_exists: { on: true, w: { QB: 5, RB: 5, WR: 5, TE: 5 } },
      x_my_own: { on: true, w: { QB: 5, RB: 5, WR: 5, TE: 5 } } },
    customs: [{ key: 'x_my_own', label: 'Rushing yards', field: 'rush_yd',
      hi: true, pg: true, comp: 'production' }],
    cols: { bye: true, pg: true },
    // no `fit`, no `fitExtra`, no `fitOn` — they did not exist
  };
  const { d, errs, store } = await boot({ store: { draft2026: JSON.stringify(old) } });
  const rows = d.querySelectorAll('.row.player').length;
  console.log(`  board rendered ${rows} rows`);
  if (rows < 50) bad(`old profile produced a board of ${rows} rows`);
  for (const v of VIEWS) {
    d.querySelector(`[data-v="${v}"]`).click();
    await settle();
    const t = (d.querySelector(`#v-${v}`).textContent || '').replace(/\s+/g, ' ').trim();
    if (junk(t)) bad(`old profile, ${v}: ${t.match(/.{0,60}(NaN|undefined|Infinity|\[object).{0,40}/)?.[0]}`);
  }
  d.querySelector('[data-v="board"]').click();
  await settle();
  d.querySelector('.row.player [data-star]').click();     // anything that triggers a save
  await new Promise((r) => setTimeout(r, 340));
  const after = JSON.parse(store.draft2026 || '{}');
  console.log(`  after load: fit=${JSON.stringify(after.fit)} fitOn=${after.fitOn} `
    + `rookieMax=${after.rookieMax} stale comp keys=${Object.keys(after.comp || {}).filter((k) => ['floor', 'ceiling'].includes(k)).join(',') || 'none'}`);
  if (!after.fit) bad('no `fit` key was written into an old profile');
  // the Type column must still be filled in
  const kinds = [...d.querySelectorAll('.row.player')].slice(0, 40)
    .map((r) => r.querySelector('.kind, .soft')?.textContent.trim());
  console.log(`  first 40 Type cells: ${[...new Set(kinds)].join(' ')}`);
  if (errs.length) bad(`console errors: ${errs.join(' | ')}`);
}

// ---------------------------------------------------------------- 3. interactions
console.log('\n=== 3. clicking everything');
{
  const { window, d, errs } = await boot();
  const step = async (what, fn) => {
    const before = errs.length;
    try { await fn(); } catch (e) { bad(`${what} threw: ${e.message}`); }
    await settle();
    if (errs.length > before) bad(`${what}: ${errs.slice(before).join(' | ')}`);
    const t = text(d, '#v-board');
    if (junk(t)) bad(`${what}: junk — ${t.match(/.{0,60}(NaN|undefined|Infinity|\[object).{0,40}/)?.[0]}`);
  };

  await step('expand a player card', () => {
    d.querySelectorAll('.row.player')[3].querySelector('.name, .nm, button')?.click()
      ?? d.querySelectorAll('.row.player')[3].click();
  });
  const panel = d.querySelector('.detail, .expand, .card, .open');
  console.log(`  expanded panel: ${panel ? `${(panel.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 110)}…` : 'NOT FOUND'}`);
  if (!panel) bad('clicking a player did not open a detail panel');

  await step('star a player', () => d.querySelector('.row.player [data-star]')?.click());
  await step('fade a player', () => d.querySelector('.row.player [data-star]')?.click());
  await step('unstar', () => d.querySelector('.row.player [data-star]')?.click());
  await step('mark gone', () => d.querySelector('.row.player [data-d]')?.click());
  await step('mark mine', () => d.querySelectorAll('.row.player [data-m]')[2]?.click());
  await step('undo (Ctrl+Z)', () => {
    d.dispatchEvent(new window.KeyboardEvent('keydown',
      { key: 'z', ctrlKey: true, bubbles: true }));
  });
  for (const f of [...d.querySelectorAll('#filters button')].map((b) => b.dataset.p || b.textContent)) {
    // eslint-disable-next-line no-await-in-loop
    await step(`filter ${f}`, () => [...d.querySelectorAll('#filters button')]
      .find((b) => (b.dataset.p || b.textContent) === f).click());
  }
  await step('back to ALL', () => d.querySelector('#filters button').click());
  for (const c of [...d.querySelectorAll('#colToggles input, #colToggles button')]) {
    // eslint-disable-next-line no-await-in-loop
    await step(`column toggle ${c.value || c.textContent}`, () => c.click());
  }
  await step('search', () => { d.querySelector('#search').value = 'a'; fire(d.querySelector('#search'), 'input'); });
  await step('clear search', () => { d.querySelector('#search').value = ''; fire(d.querySelector('#search'), 'input'); });
  await step('open settings', () => d.querySelector('#settingsBtn').click());
  await step('hide drafted', () => d.querySelector('#hideGone').click());
  await step('need slider', () => { d.querySelector('#need').value = '20'; fire(d.querySelector('#need'), 'input'); });
  await step('slot', () => { d.querySelector('#slot').value = '6'; fire(d.querySelector('#slot'), 'input'); });
  await step('reset drafted', () => d.querySelector('#reset').click());

  // ratings page
  d.querySelector('[data-v="ratings"]').click();
  await settle();
  const sliders = [...d.querySelectorAll('#fitAxes input[type=range]')];
  console.log(`  fit sliders found: ${sliders.length}`);
  if (!sliders.length) bad('the ratings page has no sliders');
  for (const s of sliders) {
    // eslint-disable-next-line no-await-in-loop
    await step(`fit slider ${s.id}`, () => { s.value = '100'; fire(s, 'input'); });
  }
  for (const chip of [...d.querySelectorAll('#stratChips button')]) {
    // eslint-disable-next-line no-await-in-loop
    await step(`strategy ${chip.textContent}`, () => chip.click());
  }
  await step('rookie toggle', () => d.querySelector('#rookie').click());
  await step('reset ratings', () => d.querySelector('#resetR').click());
  if (errs.length) bad(`console errors overall: ${errs.join(' | ')}`);
}

// ---------------------------------------------------------------- 4. league switching
console.log('\n=== 4. league switching');
{
  const two = [
    { name: 'A', teams: 12, rounds: 16, starters: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1 },
      scoring: { rec: 1, rush_yd: 0.1, rec_yd: 0.1, pass_yd: 0.04, rush_td: 6, rec_td: 6, pass_td: 4, fum_lost: -2, pass_int: -2 } },
    { name: 'B', teams: 10, rounds: 15, starters: { QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 1, K: 1, DEF: 1 },
      scoring: { rush_yd: 0.1, rec_yd: 0.1, pass_yd: 0.04, rush_td: 6, rec_td: 6, pass_td: 4 } },
  ];
  const { d, errs } = await boot({ store: { draft2026: JSON.stringify({ imported: two, league: 0 }) } });
  const sel = d.querySelector('#league');
  console.log(`  league picker: ${[...sel.options].map((o) => o.textContent).join(' / ')}`);
  for (const i of [1, 0, 1]) {
    sel.value = String(i);
    fire(sel, 'change');
    // eslint-disable-next-line no-await-in-loop
    await settle();
    const t = text(d, '#v-board');
    if (junk(t)) bad(`league ${i}: ${t.match(/.{0,60}(NaN|undefined|Infinity|\[object).{0,40}/)?.[0]}`);
    console.log(`  league ${i}: ${d.querySelectorAll('.row.player').length} rows, top = ${text(d, '.row.player .nm, .row.player .name').slice(0, 30)}`);
  }
  // league B has no penalties: the "avoid mistakes" slider must not be offered
  d.querySelector('[data-v="ratings"]').click();
  await settle();
  console.log(`  league B fit sliders: ${[...d.querySelectorAll('#fitAxes input[type=range]')].map((s) => s.id).join(' ')}`);
  if (errs.length) bad(`console errors: ${errs.join(' | ')}`);
}

// ---------------------------------------------------------------- 5. deep into a draft
console.log('\n=== 5. the value window and Type once the board is picked over');
{
  const { window, d, errs } = await boot();
  const mark = async (n) => {
    for (let i = 0; i < n; i += 1) {
      const row = d.querySelector('.row.player:not(.drafted) [data-d]');
      if (!row) break;
      row.click();
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 4));
    }
    await settle();
  };
  const census = (label) => {
    const rows = [...d.querySelectorAll('.row.player:not(.drafted)')];
    const c = {};
    for (const r of rows) {
      const k = r.querySelector('.kind')?.textContent.trim() || '—';
      c[k] = (c[k] || 0) + 1;
    }
    const wins = rows.slice(0, 60).map((r) => text2(r));
    console.log(`  ${label}: ${Object.entries(c).map(([k, v]) => `${k} ${v}`).join('  ')}`);
    console.log(`     top 8 Worth: ${wins.slice(0, 8).join(' ')}`);
    // A dash is not a blank: it means "his window has not opened yet", and at pick 1 that
    // is honestly true of most of a hundred-row screen. What would be wrong is dashes
    // NEAR THE CLOCK, where the answer matters - so that is what is checked. REACH_RANGE
    // was tuned for the same trade-off and is deliberately left alone here.
    const near = rows.slice(0, 25).filter((r) => !r.querySelector('.kind')).length;
    if (near > 5) bad(`${label}: ${near} of the top 25 have no Type`);
    return c;
  };
  const text2 = (r) => (r.querySelector('.win')?.textContent || '?').trim();
  census('empty board');
  for (const n of [12, 12, 16, 20, 30, 60]) {
    // eslint-disable-next-line no-await-in-loop
    await mark(n);
    census(`after ${d.querySelectorAll('.row.player.drafted').length} picks`);
  }
  if (errs.length) bad(`console errors: ${errs.join(' | ')}`);
}

console.log(`\n=== ${problems} problem${problems === 1 ? '' : 's'} found`);

// ---------------------------------------------------------------- 6. every player card
console.log('\n=== 6. open the card on every player in the pool');
{
  const { d, errs } = await boot();
  d.querySelector('#search').value = '';
  // 307 players; raise the visible cut so every one of them can be clicked
  for (let i = 0; i < 4; i += 1) { d.querySelector('#more')?.click(); await settle(); }
  const btns = [...d.querySelectorAll('.row.player [data-open]')];
  console.log(`  ${btns.length} rows reachable`);
  let opened = 0;
  const seen = new Set();
  for (const b of btns) {
    const before = errs.length;
    b.click();
    const det = d.querySelector('.detail');
    if (!det) { bad(`no card for ${b.textContent.trim()}`); }
    else {
      opened += 1;
      const t = det.textContent.replace(/\s+/g, ' ');
      if (junk(t)) bad(`card ${b.textContent.trim()}: ${t.match(/.{0,50}(NaN|undefined|Infinity|\[object).{0,30}/)?.[0]}`);
      const m = t.match(/The case for him: ([^(]+)/);
      if (m) seen.add(m[1].trim());
      const w = t.match(/The worry: ([^(]+)/);
      if (w) seen.add(`worry:${w[1].trim()}`);
    }
    if (errs.length > before) bad(`card ${b.textContent.trim()} errored: ${errs.slice(before).join(' | ')}`);
    b.click();
  }
  console.log(`  ${opened} cards opened clean`);
  console.log(`  phrases the verdict can produce: ${[...seen].sort().join(' / ')}`);
}

// ---------------------------------------------------------------- 7. fit across leagues
console.log('\n=== 7. a preference set in one league, carried into another');
{
  const two = [
    { name: 'Pays penalties', teams: 12, rounds: 16, imported: true,
      starters: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1 },
      scoring: { rec: 1, rush_yd: 0.1, rec_yd: 0.1, pass_yd: 0.04, rush_td: 6, rec_td: 6,
        pass_td: 4, fum_lost: -2, pass_int: -2, rec_40p: 1 } },
    // BOTH leagues fine mistakes, so the same four sliders show in each. Only what they
    // COUNT differs — which is exactly Zach's situation: one of his leagues pays for 40+
    // yard catches and first downs, the other two do not.
    { name: 'Also penalties, different lumps', teams: 12, rounds: 16, imported: true,
      starters: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1 },
      scoring: { rec: 1, rush_yd: 0.1, rec_yd: 0.1, pass_yd: 0.04, rush_td: 6, rec_td: 6,
        pass_td: 4, fum_lost: -2, pass_int: -2 } },
  ];
  const stStore = { imported: two, league: 0, fit: { td: 0, asc: 0, dur: 80, pen: 90 } };
  const { d, errs } = await boot({ store: { draft2026: JSON.stringify(stStore) } });
  const top = () => [...d.querySelectorAll('.row.player .nm')].slice(0, 6)
    .map((n) => n.textContent.trim().split(' ').slice(0, 2).join(' '));
  const sel = d.querySelector('#league');
  console.log(`  league A: ${top().join(', ')}`);
  // LOOK at the ratings page under league A first — that is what builds the panel, and a
  // panel that is never built cannot go stale.
  d.querySelector('[data-v="ratings"]').click(); await settle();
  const aCounted = [...d.querySelectorAll('.countList')].map((u) => u.textContent.replace(/\s+/g, ' ').trim());
  console.log(`  A "what this counts": ${aCounted.join(' || ').slice(0, 220)}`);
  d.querySelector('[data-v="board"]').click(); await settle();
  sel.value = '1'; fire(sel, 'change'); await settle();
  console.log(`  league B: ${top().join(', ')}`);
  d.querySelector('[data-v="ratings"]').click(); await settle();
  console.log(`  B sliders: ${[...d.querySelectorAll('#fitAxes input[type=range]')].map((s) => `${s.id}=${s.value}`).join(' ')}`);
  const counted = [...d.querySelectorAll('.countList')].map((u) => u.textContent.replace(/\s+/g, ' ').trim());
  console.log(`  B "what this counts": ${counted.join(' || ').slice(0, 220)}`);
  if (counted.join(' ').includes('40+ yard catches')) {
    bad('league B is showing league A’s scoring in "What this counts" — the panel was not rebuilt');
  }
  if (errs.length) bad(`console errors: ${errs.join(' | ')}`);
}

console.log(`\n=== ${problems} problem${problems === 1 ? '' : 's'} found in total`);
