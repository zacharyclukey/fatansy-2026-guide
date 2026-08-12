// One end-to-end check of the whole app, run in a real DOM.
//
//   cd "fatansy 2026 guide" && npm --prefix test i jsdom && node test/smoke.mjs
//
// There is no build step and no browser available where this was written, so this is the
// safety net: it loads the actual index.html, evaluates the actual modules, clicks the
// actual buttons and asserts on what comes out. It replaced nine one-off scripts that
// kept going stale and sending me chasing bugs that were only in the test.

import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const players = JSON.parse(fs.readFileSync(`${DIR}/data/players.json`, 'utf8'));

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; } else { fails.push(`${name}${detail ? ` — ${detail}` : ''}`); }
};
const near = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;

// ---------------------------------------------------------------- harness
const USER = 'u1';
const sleeperRoutes = {
  '/user/zclukey': { user_id: USER },
  [`/user/${USER}/leagues/nfl/2026`]: [{
    league_id: 'L1', draft_id: 'D1', name: 'Test League', total_rosters: 12,
    roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF', 'BN'],
    scoring_settings: { rec: 1, rush_yd: 0.1, pass_td: 4, made_up_bonus: 3 },
  }],
  '/league/L1/rosters': [{ owner_id: USER, roster_id: 5 }],
  '/draft/D1': { settings: { rounds: 15 }, draft_order: { [USER]: 6 } },
  '/draft/D1/picks': [],
};

async function boot({ store = {}, offline = false } = {}) {
  const dom = new JSDOM(fs.readFileSync(`${DIR}/index.html`, 'utf8'),
    { runScripts: 'outside-only', url: 'https://x.test/' });
  const { window } = dom;
  const errs = [];
  window.addEventListener('error', (e) => errs.push(e.message));
  window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  window.fetch = (u) => {
    const s = String(u);
    if (s.endsWith('players.json')) {
      return Promise.resolve({ json: () => Promise.resolve(JSON.parse(JSON.stringify(players))) });
    }
    if (offline) return Promise.reject(new TypeError('Failed to fetch'));
    const p = s.replace('https://api.sleeper.app/v1', '');
    if (!(p in sleeperRoutes)) return Promise.resolve({ ok: false, status: 404 });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(sleeperRoutes[p]) });
  };
  Object.defineProperty(window, 'localStorage', { value: {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
  } });
  const rd = (f) => fs.readFileSync(`${DIR}/${f}`, 'utf8').replace(/^export /gm, '');
  window.eval([rd('strategies.js'), rd('tips.js'), rd('engine.js'), rd('sleeper.js'),
    fs.readFileSync(`${DIR}/app.js`, 'utf8').replace(/^import .*\n/gm, '')].join('\n'));
  await new Promise((r) => setTimeout(r, 400));
  return { window, d: window.document, errs, store };
}
const settle = () => new Promise((r) => setTimeout(r, 60));
const fire = (el, type) => {
  const w = el.ownerDocument ? el.ownerDocument.defaultView : el;   // works for window too
  el.dispatchEvent(new w.Event(type, { bubbles: true }));
};

// ---------------------------------------------------------------- 1. the engine
{
  const m = await import(`file://${DIR}/engine.js`);
  const data = JSON.parse(JSON.stringify(players));
  const st = { ...m.DEFAULT_SETTINGS(data), mine: [] };
  data.leagues = [m.SAMPLE_LEAGUE];
  const b = m.buildBoard(data, st);
  ok('board builds', b.rows.length === 259, `${b.rows.length} rows`);

  // replacement level must be derived from who really fills the flex, not a fixed guess
  const ff = m.flexFill(data.players, m.SAMPLE_LEAGUE);
  ok('flex fill derived', ff.used.WR > ff.used.RB,
    `RB ${ff.used.RB}, WR ${ff.used.WR} — in PPR the leftovers are receivers`);
  const top12 = b.rows.slice(0, 12).filter((r) => r.p.pos === 'RB').length;
  ok('board is not RB-swamped', top12 <= 6, `${top12} backs in the top 12`);

  // the snake clock
  ok('snake picks', JSON.stringify(m.myPicks(12, 4, 4)) === '[4,21,28,45]');
  const c = m.draftContext({ teams: 12, rounds: 16 }, 4, 4);
  ok('on the clock', c.onClock && c.target === 21 && c.gap === 17);

  // availability must be conditional, or a player who has already slid reads as impossible
  const cold = m.availability(3.4, 28, 0);
  const warm = m.availability(3.4, 28, 26);
  ok('availability is conditional', warm > cold + 0.1,
    `${(cold * 100).toFixed(0)}% unconditional vs ${(warm * 100).toFixed(0)}% given he is still here`);
  ok('availability bounded', [0, 0.5, 1].every(() => {
    const v = m.availability(50, 60, 40);
    return v >= 0 && v <= 1;
  }));

  // K and DEF are scored by their own rules, matched by id not row order
  const k = data.players.find((p) => p.pos === 'K' && p.ppts);
  ok('kicker points per league', k && Object.keys(k.ppts).length >= 1);
}

// ---------------------------------------------------------------- 2. board view
{
  const { d, errs } = await boot();
  d.querySelector('[data-v="board"]').click();
  await settle();
  ok('rows render', d.querySelectorAll('.row.player').length === 100);
  ok('rating and ADP are always shown',
    [...d.querySelectorAll('#colHeads span')].slice(0, 3).map((x) => x.textContent).join(',') === 'Rating,ADP,Score');

  // stat groups are additive and must not squeeze the name column
  for (const k of ['pg', 'tot', 'proj', 'rz', 'back']) {
    const cb = d.querySelector(`[data-col="${k}"]`);
    cb.checked = true; fire(cb, 'change');
  }
  await settle();
  const tpl = d.querySelector('#board').style.getPropertyValue('--cols');
  ok('columns grow rightwards', tpl.includes('minmax(190px, 1fr)'));
  // 3 fixed + bye 2 + per-game 3 + totals 3 + projection 3 + back 1 + red zone 2
  ok('all groups on', d.querySelectorAll('#colHeads span').length === 17,
    `${d.querySelectorAll('#colHeads span').length} columns`);

  // the expensive one: dragging a slider must not rebuild the list
  let created = 0;
  const real = d.createElement.bind(d);
  d.createElement = (t) => { created += 1; return real(t); };
  const sl = d.querySelector('#style');
  for (let i = 0; i <= 40; i += 1) { sl.value = String(i * 2); fire(sl, 'input'); }
  await settle();
  ok('slider reuses rows', created < 60, `${created} elements created over a 40-step drag`);
  ok('rows survived the drag', d.querySelectorAll('.row.player').length === 100);

  d.querySelectorAll('.row.player [data-open]')[0].click();
  await settle();
  ok('detail opens', !!d.querySelector('.detail'));
  ok('component bars have tips', d.querySelectorAll('.detail .bar[data-tip]').length >= 10);
  ok('stat cards have tips', d.querySelectorAll('.detail .stat[data-tip]').length >= 8);
  ok('no console errors', errs.length === 0, errs.join('; '));

  // injuries were being dropped entirely - a torn ACL looked like a healthy player
  const injured = players.players.filter((p) => p.inj);
  ok('injuries reach the data', injured.length > 10, `${injured.length} flagged`);
  d.querySelectorAll('.row.player [data-open]')[0].click();   // close the one opened above
  const q = d.querySelector('#search');
  q.value = injured[0].name; fire(q, 'input');
  await settle();
  ok('injury shows on the row', !!d.querySelector('.row.player .inj'),
    `${injured[0].name} (${injured[0].inj})`);
  d.querySelectorAll('.row.player [data-open]')[0].click();
  await settle();
  ok('injury leads the risk line', /Injury question|Not playing/
    .test(d.querySelector('.detail .verdict').textContent));
  ok('data age is shown', /data .*(today|day)/.test(d.querySelector('#meta').textContent),
    d.querySelector('#meta').textContent.slice(-60));
}

// ---------------------------------------------------------------- 3. the call
{
  const { d } = await boot();
  d.querySelector('[data-v="board"]').click();
  const slot = d.querySelector('#slot'); slot.value = '4'; fire(slot, 'input');
  const hg = d.querySelector('#hideGone'); hg.checked = true; fire(hg, 'change');
  await settle();

  // a room drafting strictly by ADP, leaving one player it should not have
  const byAdp = [...players.players].filter((p) => p.adp).sort((a, b) => a.adp - b.adp);
  const leave = 'Ja\'Marr Chase';
  let n = 0;
  for (let i = 0; n < 25; i += 1) {
    if (byAdp[i].name === leave) continue;
    const row = [...d.querySelectorAll('.row.player')]
      .find((r) => r.querySelector('.nm').textContent.startsWith(byAdp[i].name));
    if (row) { row.querySelector('[data-d]').click(); n += 1; }
  }
  await settle();
  const row = [...d.querySelectorAll('.row.player')]
    .find((r) => r.querySelector('.nm').textContent.startsWith(leave));
  row.querySelector('[data-open]').click();
  await settle();
  const tag = d.querySelector('.detail .callTag').textContent;
  ok('a faller you rate is a steal', tag === 'Steal', `got "${tag}"`);
  ok('advice names a position', /Take|Line up/.test(d.querySelector('#advice .advTag')?.textContent || ''));
  ok('cost of waiting is shown', d.querySelectorAll('#advice .costPill').length >= 3);
}

// ---------------------------------------------------------------- 4. ratings
{
  const { d, store } = await boot();
  d.querySelector('[data-v="ratings"]').click();
  await settle();
  ok('every weight is a slider', d.querySelectorAll('#comps input[type="number"]').length === 0);
  ok('per-position sliders', d.querySelectorAll('#comps [data-sw]').length === 200,
    `${d.querySelectorAll('#comps [data-sw]').length}`);

  const before = d.querySelectorAll('#comps .statRow:not(.hdr)').length;
  const menu = d.querySelector('#addPick');
  const offered = [...menu.options].slice(1).map((o) => o.text);

  // the menu must never offer a stat the rating is already using
  const inUse = [...d.querySelectorAll('#comps .statRow:not(.hdr)')]
    .filter((r) => !r.classList.contains('off'))
    .map((r) => r.querySelector('label span').textContent.trim());
  const clash = offered.filter((o) => inUse.some((u) => o.startsWith(u)));
  ok('no stat already in use is offered', clash.length === 0, clash.join(', '));
  ok('switched-off built-ins are offered', offered.some((o) => /switch on in/.test(o)));
  ok('unmapped raw fields are offered', offered.some((o) => /add to/.test(o)));

  // turning a built-in back on must not create a second copy of it
  const rows0 = d.querySelectorAll('#comps .statRow:not(.hdr)').length;
  menu.value = [...menu.options].find((o) => /switch on in/.test(o.text)).value;
  fire(menu, 'change');
  await settle();
  d.querySelector('[data-v="ratings"]').click();
  ok('switching one on adds no duplicate row',
    d.querySelectorAll('#comps .statRow:not(.hdr)').length === rows0);

  const menu2 = d.querySelector('#addPick');
  const opt = [...menu2.options].find((o) => /add to/.test(o.text));
  menu2.value = opt.value;
  fire(menu2, 'change');
  await settle();
  d.querySelector('[data-v="ratings"]').click();
  ok('an unused stat can be added',
    d.querySelectorAll('#comps .statRow:not(.hdr)').length === before + 1);

  // and it has to come back after a reload. Closing the page must flush the debounced
  // save first, or a change made in the last quarter second is silently lost.
  fire(d.defaultView, 'pagehide');
  const again = await boot({ store });
  again.d.querySelector('[data-v="ratings"]').click();
  await settle();
  ok('added stats survive a reload',
    again.d.querySelectorAll('#comps .statRow:not(.hdr)').length === before + 1);
}

// ---------------------------------------------------------------- 5. strategies
{
  const { d } = await boot();
  d.querySelector('[data-v="board"]').click();
  d.querySelector('#settingsBtn').click();
  await settle();
  const mix = () => {
    const c = {};
    [...d.querySelectorAll('.row.player')].slice(0, 24)
      .forEach((r) => { const p = r.querySelector('.pos').textContent; c[p] = (c[p] || 0) + 1; });
    return c;
  };
  d.querySelector('[data-strat="zerorb"]').click(); await settle();
  const zero = mix();
  d.querySelector('[data-strat="robustrb"]').click(); await settle();
  const robust = mix();
  ok('Zero RB favours receivers', zero.WR > zero.RB, `WR ${zero.WR} vs RB ${zero.RB}`);
  ok('Robust RB favours backs', robust.RB > robust.WR, `RB ${robust.RB} vs WR ${robust.WR}`);
  const need = d.querySelector('#need'); need.value = '15'; fire(need, 'input');
  await settle();
  ok('editing a slider drops the preset label',
    /Custom/.test(d.querySelector('#stratWhy').textContent));
}

// ---------------------------------------------------------------- 6. sleeper
{
  const { d } = await boot();
  d.querySelector('#user').value = 'zclukey';
  d.querySelector('#importL').click();
  await new Promise((r) => setTimeout(r, 300));
  ok('leagues import', /Imported 1 league/.test(d.querySelector('#setupMsg').textContent));
  ok('unscorable rules are reported', /made_up_bonus/.test(d.querySelector('#leagueList').textContent));
  d.querySelector('[data-v="board"]').click();
  await settle();
  ok('draft slot comes from Sleeper', d.querySelector('#slot').value === '6',
    `got "${d.querySelector('#slot').value}"`);

  // autodrafted picks have an empty picked_by and must still be recognised as yours
  sleeperRoutes['/draft/D1/picks'] = [
    { player_id: players.players[0].id, picked_by: USER, roster_id: 5, pick_no: 6, round: 1 },
    { player_id: players.players[1].id, picked_by: '', roster_id: 5, pick_no: 19, round: 2 },
    { player_id: players.players[2].id, picked_by: 'someone', roster_id: 2, pick_no: 7, round: 1 },
    { player_id: '000000', picked_by: 'someone', roster_id: 2, pick_no: 8, round: 1 },
  ];
  d.querySelector('[data-v="setup"]').click();
  d.querySelector('#syncOnce').click();
  await new Promise((r) => setTimeout(r, 300));
  const msg = d.querySelector('#syncMsg').textContent;
  ok('sync reads picks', /4 picks made/.test(msg), msg);
  ok('autodrafted picks count as yours', /2 yours/.test(msg), msg);
  ok('unknown players are reported not dropped', /not in the player pool/.test(msg), msg);
  d.querySelector('[data-v="board"]').click();
  await settle();
  ok('picks land on the board', d.querySelectorAll('.row.mine').length === 2);
}

// ---------------------------------------------------------------- 7. offline
{
  const { d, errs } = await boot({ offline: true });
  d.querySelector('#user').value = 'zclukey';
  d.querySelector('#importL').click();
  await new Promise((r) => setTimeout(r, 250));
  ok('a blocked Sleeper explains itself',
    /Could not reach Sleeper/.test(d.querySelector('#setupMsg').textContent));
  d.querySelector('[data-v="board"]').click();
  await settle();
  ok('the board works with no network', d.querySelectorAll('.row.player').length === 100);
  ok('no errors while offline', errs.length === 0, errs.join('; '));
}

// ---------------------------------------------------------------- report
console.log(`\n${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log('  FAIL', f);
process.exit(fails.length ? 1 : 0);
