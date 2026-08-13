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
    if (s.includes('players.json')) {          // the URL carries a ?v= cache stamp
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
// position multipliers as the app has them, read back out of saved settings
const st_posx = (d) => {
  const raw = d.defaultView.localStorage.getItem('draft2026');
  return raw ? (JSON.parse(raw).posx || {}) : {};
};
const fire = (el, type) => {
  const w = el.ownerDocument ? el.ownerDocument.defaultView : el;   // works for window too
  el.dispatchEvent(new w.Event(type, { bubbles: true }));
};

// ------------------------------------------------------- 0. the sticky-header trap
// This bug has shipped twice: the column labels detach and float over row two. Both times
// the cause was an `overflow` on an ancestor of .row.head, which makes a sticky element
// position against that box instead of the viewport. It is invisible in jsdom because
// jsdom does no layout, so it is checked in the stylesheet instead.
{
  const css = fs.readFileSync(`${DIR}/styles.css`, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');          // strip comments, they discuss overflow
  const blocks = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)];
  const ancestors = /(^|,)\s*(main|body|html|section|\.board|#v-board main|#v-board \.board)\s*$/;
  const guilty = blocks.filter(([, sel, body]) => /overflow(-x|-y)?\s*:/.test(body)
    && sel.split(',').some((s) => ancestors.test(s.trim())));
  ok('nothing that contains the board sets overflow', guilty.length === 0,
    guilty.map(([, s]) => s.trim()).join(' / '));
  ok('the sticky header is still sticky', /\.row\.head\s*\{[^}]*position:\s*sticky/.test(css));
}

// ------------------------------------------------- 0b. nothing exported has gone missing
// Three separate times an edit that replaced a block between two markers has silently
// deleted a neighbouring function. Each time the app broke in a way only one test caught.
{
  const src = fs.readFileSync(`${DIR}/engine.js`, 'utf8');
  const exported = [...src.matchAll(/^export (?:function|const) (\w+)/gm)].map((m) => m[1]);
  const needed = ['DEFAULT_SETTINGS', 'componentWeights', 'componentScore', 'floorScore',
    'projectedPoints', 'inLeague', 'flexFill', 'replacementLevels', 'SAMPLE_LEAGUE',
    'subScores', 'RAW_FIELDS', 'applyCustomStats', 'unusedStats', 'buildBoard', 'pickType',
    'markTiers', 'myPicks', 'draftContext', 'availability', 'poolAround', 'costOfWaiting',
    'influence', 'priorityOrder'];
  const missing = needed.filter((n) => !exported.includes(n));
  ok('every engine export the app imports still exists', missing.length === 0, missing.join(', '));

  const app = fs.readFileSync(`${DIR}/app.js`, 'utf8');
  const imported = [...(app.match(/^import \{([^}]*)\} from '\.\/engine\.js/m)?.[1] || '')
    .split(',').map((x) => x.trim()).filter(Boolean)];
  const broken = imported.filter((n) => !exported.includes(n));
  ok('the app imports nothing that is not exported', broken.length === 0, broken.join(', '));
}

// --------------------------------------------- 0b2. no duplicate element ids
// The strategy block ended up rendered twice - once on the board, once on the Ratings
// tab - because a removal silently did not apply. querySelector only ever finds the
// first, so the Ratings copy was never populated and the move looked like it failed.
{
  const html = fs.readFileSync(`${DIR}/index.html`, 'utf8');
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  const dupes = [...new Set(ids.filter((i) => ids.filter((x) => x === i).length > 1))];
  ok('no element id appears twice', dupes.length === 0, dupes.join(', '));
}

// --------------------------------------------- 0c. every asset is cache-busted
// New code paired with a stale cached data file is a silent, confusing failure: the
// quarterback columns came back blank because players.json had no version stamp.
{
  const app = fs.readFileSync(`${DIR}/app.js`, 'utf8');
  const html = fs.readFileSync(`${DIR}/index.html`, 'utf8');
  ok('the data file is cache-busted', /players\.json\?v=/.test(app));
  const unversioned = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)]
    .map((m) => m[1]).filter((u) => !u.includes('?v='));
  ok('every script and stylesheet is cache-busted', unversioned.length === 0, unversioned.join(', '));
  const imports = [...app.matchAll(/from '\.\/([^']+\.js)([^']*)'/g)]
    .filter((m) => !m[2].includes('?v=')).map((m) => m[1]);
  ok('every module import is cache-busted', imports.length === 0, imports.join(', '));
}

// ---------------------------------------------------------------- 1. the engine
{
  const m = await import(`file://${DIR}/engine.js`);
  const data = JSON.parse(JSON.stringify(players));
  const st = { ...m.DEFAULT_SETTINGS(data), mine: [] };
  data.leagues = [m.SAMPLE_LEAGUE];
  const b = m.buildBoard(data, st);
  // never hardcode the pool size - the nightly refresh changes it
  ok('board builds', b.rows.length === players.players.length,
    `${b.rows.length} of ${players.players.length}`);
  ok('the pool is a real season', players.players.length >= 200, `${players.players.length}`);

  // replacement level must be derived from who really fills the flex, not a fixed guess
  const ff = m.flexFill(data.players, m.SAMPLE_LEAGUE);
  ok('flex fill derived', ff.used.WR > ff.used.RB,
    `RB ${ff.used.RB}, WR ${ff.used.WR} — in PPR the leftovers are receivers`);
  const top12 = b.rows.slice(0, 12).filter((r) => r.p.pos === 'RB').length;
  ok('board is not RB-swamped', top12 <= 6, `${top12} backs in the top 12`);

  // ---- Fit: a preference, and provably not more than that ----------------
  ok('neutral sliders leave every player at 50', b.rows.every((r) => r.fit === 50));

  const before = new Map(b.rows.map((r) => [r.p.id, r.rank]));
  const hard = m.buildBoard(data, { ...st, fit: { td: 100, asc: 0, dur: 0, pen: 0 } });
  const moves = hard.rows.slice(0, 80).map((r) => Math.abs(before.get(r.p.id) - r.rank));
  ok('a slider at its extreme still reorders the board', Math.max(...moves) > 0);
  // The whole claim of Fit is that it breaks ties. If one slider could move a man forty
  // places it would be overruling the projections, which measured +0.25 against every
  // alternative while preferences measured nothing at all.
  ok('but it can never overrule value', Math.max(...moves) <= 25,
    `biggest move ${Math.max(...moves)} places`);

  // lumpiness is league-specific: a bonus one league pays and another does not must move
  const plain = { ...m.SAMPLE_LEAGUE, scoring: { ...m.SAMPLE_LEAGUE.scoring, rec_40p: 0 } };
  const bonus = { ...m.SAMPLE_LEAGUE, scoring: { ...m.SAMPLE_LEAGUE.scoring, rec_40p: 2 } };
  const wr = data.players.find((p) => p.pos === 'WR' && (p.proj?.rec_40p || 0) > 0);
  ok('a league bonus changes who counts as boom-or-bust',
    !wr || m.swingShare(wr, bonus) > m.swingShare(wr, plain));
  ok('penalties are detected per league', m.hasPenalties(
    { scoring: { fum_lost: -2 } }) === true && m.hasPenalties({ scoring: { rec: 1 } }) === false);

  // ---- the value window --------------------------------------------------
  ok('every player has a window', b.rows.every(
    (r) => r.worthFrom >= 1 && r.worthTo >= r.worthFrom));
  ok('the window contains his own rank', b.rows.every(
    (r) => r.rank >= r.worthFrom && r.rank <= r.worthTo));
  ok('verdicts agree with the window', b.rows.every((r) => (r.openEnded
    ? r.verdict === 'fair'
    : (r.verdict === 'bargain' && r.adpRank > r.worthTo)
      || (r.verdict === 'costly' && r.adpRank < r.worthFrom)
      || (r.verdict === 'fair' && r.adpRank >= r.worthFrom && r.adpRank <= r.worthTo))));
  // a window that swallowed the whole board would make the verdict meaningless
  const widest = Math.max(...b.rows.map((r) => r.worthTo - r.worthFrom));
  ok('windows stay narrow enough to mean something', widest <= m.WINDOW_MAX,
    `widest ${widest}, cap ${m.WINDOW_MAX}`);
  ok('a truncated window claims nothing either way',
    b.rows.every((r) => !r.openEnded || r.verdict === 'fair'));

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
  ok('the four fixed columns are always shown',
    [...d.querySelectorAll('#colHeads span')].slice(0, 4).map((x) => x.textContent).join(',')
      === 'Type,Worth,ADP,Score');

  // Worth is a pick RANGE, not a grade. A 0-100 number here would mean the value window
  // silently reverted to the rating it replaced.
  ok('Worth shows a pick range, not a score',
    [...d.querySelectorAll('.row .win')].slice(0, 30)
      .every((x) => /^\d+(–\d+|\+)?$/.test(x.textContent.trim())));
  ok('every row carries a verdict',
    [...d.querySelectorAll('.row .win')].slice(0, 30)
      .every((x) => ['bargain', 'fair', 'costly'].some((v) => x.classList.contains(v))));

  // stat groups are additive and must not squeeze the name column
  for (const k of ['pg', 'tot', 'proj', 'rz', 'back']) {
    const cb = d.querySelector(`[data-col="${k}"]`);
    cb.checked = true; fire(cb, 'change');
  }
  await settle();
  const tpl = d.querySelector('#board').style.getPropertyValue('--cols');
  ok('columns grow rightwards', tpl.includes('minmax(190px, 1fr)'));
  // 4 fixed + bye 2 + per-game 3 + totals 3 + projection 3 + back 1 + red zone 2
  ok('all groups on', d.querySelectorAll('#colHeads span').length === 18,
    `${d.querySelectorAll('#colHeads span').length} columns`);

  // the expensive one: dragging a slider must not rebuild the list
  let created = 0;
  const real = d.createElement.bind(d);
  d.createElement = (t) => { created += 1; return real(t); };
  // Need bonus is the slider that still lives on the board; the rating knobs moved to
  // the Ratings tab where they belong
  const sl = d.querySelector('#need');
  for (let i = 0; i <= 40; i += 1) { sl.value = String(i % 21); fire(sl, 'input'); }
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
  // tier cliffs: the last man before a real step down at his position
  const cliffs = [...d.querySelectorAll('.tierEnd')];
  ok('tier cliffs are marked', cliffs.length > 0, `${cliffs.length} visible in the top 100`);
  ok('cliff labels name the position and tier', cliffs.every((c) => /^last [A-Z]{2,3}\d+$/.test(c.textContent)),
    cliffs.slice(0, 3).map((c) => c.textContent).join(', '));

  // bye clashes and undo
  d.querySelector('[data-f="ALL"]').click();
  const q2 = d.querySelector('#search'); q2.value = ''; fire(q2, 'input');
  await settle();
  const before = d.querySelectorAll('.row.mine').length;
  d.querySelectorAll('.row.player [data-m]')[0].click();
  await settle();
  ok('a pick lands on your team', d.querySelectorAll('.row.mine').length === before + 1);
  ok('undo offers to take it back', /Undo .+/.test(d.querySelector('#undo').textContent),
    d.querySelector('#undo').textContent);
  d.querySelector('#undo').click();
  await settle();
  ok('undo puts it back', d.querySelectorAll('.row.mine').length === before);
  ok('and disables itself when there is nothing left', d.querySelector('#undo').disabled);

  ok('data age is shown', /data .*(today|day)/.test(d.querySelector('#meta').textContent),
    d.querySelector('#meta').textContent.slice(-60));
}

// ------------------------------------------- 2b. pick type, stars, positional detail
{
  const { d } = await boot();
  d.querySelector('[data-v="board"]').click();
  await settle();

  const kinds = [...d.querySelectorAll('.row.player .kind')].map((x) => x.textContent);
  ok('pick types are labelled', kinds.length > 10, `${kinds.length} in the top 100`);
  ok('only the three known types appear',
    kinds.every((k) => ['Safe', 'Swing', 'Skip'].includes(k)), [...new Set(kinds)].join(','));

  // position detail only offered once you have filtered to one position
  ok('no position detail chip on the full board', !d.querySelector('[data-col="posdetail"]'));
  d.querySelector('[data-f="WR"]').click();
  await settle();
  const pd = d.querySelector('[data-col="posdetail"]');
  ok('a position filter offers its own stats', !!pd);
  pd.checked = true; fire(pd, 'change');
  await settle();
  const heads = [...d.querySelectorAll('#colHeads span')].map((x) => x.textContent);
  ok('receiver columns are receiver stats', heads.includes('Catch%') && heads.includes('RZ tgt'),
    heads.join(' '));
  ok('and not carries', !heads.includes('Carries'));
  d.querySelector('[data-f="RB"]').click();
  await settle();
  const rbHeads = [...d.querySelectorAll('#colHeads span')].map((x) => x.textContent);
  ok('backs get carries instead', rbHeads.includes('Carries') && !rbHeads.includes('Catch%'),
    rbHeads.join(' '));
  d.querySelector('[data-f="ALL"]').click();
  await settle();

  // star / fade / clear on one button
  const rowOf = (i) => [...d.querySelectorAll('.row.player')][i];
  const nameAt = (i) => rowOf(i).querySelector('.nm').textContent.trim();
  const target = nameAt(14);
  const before = 15;
  rowOf(14).querySelector('[data-star]').click();
  await settle();
  const after = [...d.querySelectorAll('.row.player .nm')].findIndex((x) => x.textContent.trim() === target) + 1;
  ok('a star lifts a player', after < before, `${target} ${before} -> ${after}`);
  ok('but not past anyone much better', after >= before - 12, `moved ${before - after} places`);
  ok('the row is marked', !!d.querySelector('.row.starred'));

  const starEl = () => [...d.querySelectorAll('.row.player')]
    .find((r) => r.querySelector('.nm').textContent.trim() === target).querySelector('[data-star]');
  ok('one click means liked', starEl().textContent === '★');
  starEl().click(); await settle();
  ok('two clicks means faded', starEl().textContent === '✕');
  const faded = [...d.querySelectorAll('.row.player .nm')].findIndex((x) => x.textContent.trim() === target) + 1;
  ok('a fade drops him', faded > after, `${after} -> ${faded}`);
  starEl().click(); await settle();
  ok('three clicks clears it', starEl().textContent === '☆');

  // and your list can be viewed on its own
  starEl().click(); await settle();
  const only = d.querySelector('[data-col="starsonly"]');
  only.checked = true; fire(only, 'change');
  await settle();
  ok('My list only filters to your picks', d.querySelectorAll('.row.player').length === 1,
    `${d.querySelectorAll('.row.player').length} rows`);
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
  // derived, not hardcoded - the stat list changes and the test should follow it
  const nStats = players.components.reduce((a, c) => a + c.subs.length, 0);
  ok('per-position sliders', d.querySelectorAll('#comps [data-sw]').length === nStats * 4,
    `${d.querySelectorAll('#comps [data-sw]').length} for ${nStats} stats x 4 positions`);

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
  // the influence readout - it is measured, so it must actually be there and be numeric
  const moves = [...d.querySelectorAll('#comps .cMove')].map((x) => x.textContent.trim());
  ok('every component reports its influence',
    moves.length === players.components.length && moves.every((x) => /^±\d/.test(x)),
    `${moves.length} of ${players.components.length}: ${moves.join(' ')}`);
  // the Ratings Lab must not slam your open panel shut when you change something in it
  const comps = [...d.querySelectorAll('details.comp')];
  comps[0].removeAttribute('open');
  const rel = comps.find((c) => c.querySelector('.cName').textContent === 'Reliability');
  rel.setAttribute('open', '');
  rel.querySelector('input[type="checkbox"][data-son]').click();
  await settle();
  ok('the panel you are working in stays open',
    [...d.querySelectorAll('details.comp[open]')].map((x) => x.dataset.comp).join(',') === 'reliability',
    [...d.querySelectorAll('details.comp[open] .cName')].map((x) => x.textContent).join(','));

  // a quarterback has to be rated on passing, not on his carries
  const qbStats = players.components.flatMap((c) => c.subs.filter((s) => s.w.QB > 0));
  ok('quarterbacks are rated on passing',
    qbStats.some((s) => /pass|Completion|Interception/i.test(s.label)),
    `${qbStats.length} stats count for a QB`);
  ok('touches no longer counts for a quarterback',
    !players.components.flatMap((c) => c.subs).find((s) => s.key === 'touches_pg')?.w.QB);

  // finding a stat among fifty behind ten collapsed panels
  const findBox = d.querySelector('#statFind');
  findBox.value = 'interception'; fire(findBox, 'input');
  await settle();
  const found = [...d.querySelectorAll('.statRow:not(.hdr) label span')].map((x) => x.textContent.trim());
  ok('a stat can be found by name', found.length === 1 && /Interceptions/.test(found[0]),
    found.join(' | '));
  ok('and its panel is opened for you', d.querySelector('details.comp')?.hasAttribute('open'));
  findBox.value = ''; fire(findBox, 'input');
  await settle();

  ok('the influence note explains itself', /switch a component off|switch/.test(d.querySelector('#inflNote').textContent));

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

// -------------------------------------------- 4b. the model has no duplicated formulas
{
  // Floor used to be 100% formulas copied from volume/role/reliability/production, which
  // double-counted them every time the Safe/Upside slider moved. Nothing may share a stat.
  const seen = new Map();
  for (const c of players.components) {
    for (const s of c.subs) {
      if (!seen.has(s.label)) seen.set(s.label, []);
      seen.get(s.label).push(c.key);
    }
  }
  const shared = [...seen].filter(([, cs]) => new Set(cs).size > 1);
  ok('no stat appears in two components', shared.length === 0,
    shared.map(([l, cs]) => `${l} in ${cs.join('+')}`).join('; '));
  ok('floor is gone as a component', !players.components.some((c) => c.key === 'floor'));
  ok('upside survives with its own stats',
    players.components.find((c) => c.key === 'upside')?.subs.length === 2);
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
  // the lean is a reading of the board, so it needs to know when you pick
  ok('a lean needs the draft slot first',
    /Set your draft slot/.test(d.querySelector('#lean').textContent));
  const sl2 = d.querySelector('#slot'); sl2.value = '4'; fire(sl2, 'input');
  await settle();
  ok('with a slot the board reads itself',
    /Waiting costs you .* at running back/.test(d.querySelector('#lean').textContent),
    d.querySelector('#lean').textContent.replace(/\s+/g, ' ').slice(0, 90));
  ok('one lean is starred as the suggestion',
    [...d.querySelectorAll('[data-lean]')].filter((x) => x.textContent.includes('★')).length === 1);

  d.querySelector('[data-lean="zerorb"]').click(); await settle();
  const zero = mix();
  d.querySelector('[data-lean="robustrb"]').click(); await settle();
  const robust = mix();
  ok('Zero RB favours receivers', zero.WR > zero.RB, `WR ${zero.WR} vs RB ${zero.RB}`);
  ok('Robust RB favours backs', robust.RB > robust.WR, `RB ${robust.RB} vs WR ${robust.WR}`);

  // presets are temperament only and live in the lab
  d.querySelector('[data-v="ratings"]').click(); await settle();
  ok('presets are in the lab', d.querySelectorAll('[data-strat]').length === 5);
  ok('no position lean in the lab', d.querySelectorAll('#v-ratings [data-lean]').length === 0);
  const before = JSON.stringify(st_posx(d));
  d.querySelector('[data-strat="upside"]').click(); await settle();
  d.querySelector('[data-v="ratings"]').click();
  ok('a preset leaves position values alone', JSON.stringify(st_posx(d)) === before);
  const tw = d.querySelector('#tilt2'); tw.value = '175'; fire(tw, 'input');
  await settle();
  d.querySelector('[data-v="ratings"]').click();
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
