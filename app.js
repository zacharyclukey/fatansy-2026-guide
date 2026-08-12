import { DEFAULT_SETTINGS, buildBoard, priorityOrder, subScores, SAMPLE_LEAGUE, RAW_FIELDS, applyCustomStats } from './engine.js';
import { importLeagues, draftPicks, SleeperError } from './sleeper.js';

const $ = (s) => document.querySelector(s);
const KEY = 'draft2026';
const POSCOL = { QB: 'QB', RB: 'RB', WR: 'WR', TE: 'TE' };

let data;
let st;
let board;
let view = 'board';
let filter = 'ALL';
let query = '';
let open = null;
let timer = null;
let cache = null;
let cacheKey = '';
let frame = null;
let limit = 100;

// Four ways to look at the same player. Columns and headers both switch.
const VIEWS = [
  ['Value', ['Bye', 'Score', 'vs ADP'], (r) => [r.p.bye || '—', r.score.toFixed(1),
    fmtGap(r.adpRank - r.rank)]],
  ['2025 per game', ['Snap %', 'Touch/g', 'Pts/g'], (r) => [
    pct(r.p.m.snap_share), one(r.p.m.touches_pg), one(r.p.m.last_ppg)]],
  ['2025 totals', ['Games', 'Yards', 'TDs'], (r) => [
    r.p.a?.gp ?? '—', r.p.a?.rush_rec_yd ?? '—', r.p.a?.anytime_tds ?? '—']],
  ['2026 projection', ['Points', 'Pts/g', 'Touches'], (r) => [
    r.pts.toFixed(0), one(r.p.m.proj_ppg),
    Math.round((r.p.proj?.rush_att || 0) + (r.p.proj?.rec || 0)) || '—']],
  ['Red zone', ['RZ/g', 'RZ TD%', 'TDs'], (r) => [
    one(r.p.m.rz_pg), pct(r.p.m.rz_conv * 100), r.p.a?.anytime_tds ?? '—']],
];
const one = (v) => (v == null ? '—' : (+v).toFixed(1));
const pct = (v) => (v == null || Number.isNaN(v) ? '—' : `${Math.round(v)}%`);
const fmtGap = (g) => `${g > 0 ? '+' : ''}${g}`;
let statView = 0;

// ---------------------------------------------------------------- state
function load() {
  const base = DEFAULT_SETTINGS(data);
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { saved = null; }
  st = { ...base, ...(saved || {}) };
  // a saved profile from an older build may not know about newer stats
  st.comp = { ...base.comp, ...(st.comp || {}) };
  for (const [k, v] of Object.entries(base.sub)) st.sub[k] = st.sub[k] || v;
  // Whoever opens this link is not necessarily whoever generated the data file, so the
  // leagues baked into it are never shown. You get a neutral league until you import.
  data.leagues = st.imported?.length ? [...st.imported] : [SAMPLE_LEAGUE];
  if (st.league >= data.leagues.length) st.league = 0;
  st.picks ||= {};
  for (let i = 0; i < data.leagues.length; i++) st.picks[i] ||= { drafted: [], mine: [] };
}
const save = () => localStorage.setItem(KEY, JSON.stringify(st));
const picks = () => st.picks[st.league];
const byId = (id) => data.players.find((p) => p.id === id);

// ---------------------------------------------------------------- wording
const styleWord = (v) => (v <= 15 ? 'safest floor' : v <= 40 ? 'leaning safe'
  : v < 60 ? 'balanced' : v < 85 ? 'leaning upside' : 'highest ceiling');

function riskOf(r) {
  const f = r.scores.floor ?? 50;
  if (r.p.rookie) return `Rookie — ${f >= 55 ? 'good landing spot' : 'dart throw'}`;
  if (f >= 70) return 'Safe — locked-in role';
  if (f >= 50) return 'Solid — real workload';
  if (f >= 35) return 'Shaky — role not settled';
  return 'Risky — little proven work';
}

const NAMED = {
  volume: 'he gets the ball a lot', redzone: 'he works near the goal line',
  explosive: 'he hits big plays', efficiency: 'he does a lot with each touch',
  production: 'he scored well last year', role: 'his role is locked in',
  reliability: 'he stays on the field', ceiling: 'he has room to leap',
  floor: 'his floor is high', situation: 'the offence around him is good',
};
const WORRY = {
  volume: 'the workload is thin', redzone: 'he does not see the goal line',
  explosive: 'there are no big plays', efficiency: 'he does little with each touch',
  production: 'last year was quiet', role: 'his role is not settled',
  reliability: 'he misses games', ceiling: 'there is not much upside',
  floor: 'the floor is low', situation: 'the offence around him is poor',
};

// The projection is left out of both halves - it is most of what the score already says,
// so naming it as his strength tells you nothing.
function verdict(r) {
  const gap = r.adpRank - r.rank;
  const ranked = Object.entries(r.scores)
    .filter(([k, v]) => v != null && NAMED[k]).sort((a, b) => b[1] - a[1]);
  const [bk, bv] = ranked[0];
  const [wk, wv] = ranked[ranked.length - 1];
  const lead = gap >= 12 ? `Value — the room lets him fall ${gap} picks past where you rate him.`
    : gap <= -12 ? `A reach — you have him ${-gap} picks ahead of the room.`
      : 'Priced about where the room has him.';
  return lead
    + (bv >= 60 ? ` The case for him: ${NAMED[bk]} (${Math.round(bv)}).` : '')
    + (wv < 45 ? ` The worry: ${WORRY[wk]} (${Math.round(wv)}).` : '');
}

// ---------------------------------------------------------------- board
// User-added stats are spliced into the component definitions and given percentiles,
// so from here on they behave exactly like the built-in ones.
function syncCustoms() {
  st.customs ||= [];
  for (const c of data.components) c.subs = c.subs.filter((s2) => !s2.custom);
  applyCustomStats(data, st.customs);
  for (const cs of st.customs) {
    const comp = data.components.find((c) => c.key === cs.comp);
    if (!comp) continue;
    comp.subs.push({ key: cs.key, label: cs.label, on: true, custom: true,
      w: Object.fromEntries(data.ratePos.map((q) => [q, 10])) });
    st.sub[cs.key] ||= { on: true, w: Object.fromEntries(data.ratePos.map((q) => [q, 10])) };
  }
}

function rebuild() {
  const key = JSON.stringify(st.sub);
  if (key !== cacheKey) { cache = subScores(data, st); cacheKey = key; }
  board = buildBoard(data, { ...st, mine: picks().mine.map((id) => byId(id)?.pos) }, cache);
  renderAll();
}

// Sliders fire an input event per pixel. Coalescing to one rebuild per animation frame
// keeps the drag smooth instead of queueing a full re-render behind every event.
function scheduleRebuild() {
  if (frame) return;
  frame = requestAnimationFrame(() => { frame = null; rebuild(); });
}

function renderAll() {
  if (view === 'board') renderBoard();
  if (view === 'roster') renderRoster();
  if (view === 'ratings') renderRatings();
  if (view === 'setup') renderSetup();
  $('#meta').textContent = `${board.rows.length} players · ${board.league.name} · `
    + `${picks().mine.length} on your roster · data ${data.generated}`;
}

function renderBoard() {
  const q = query.trim().toLowerCase();
  const drafted = new Set(picks().drafted);
  const mine = new Set(picks().mine);
  const rows = board.rows.filter((r) => (filter === 'ALL' || r.p.pos === filter)
    && (!st.hideGone || !drafted.has(r.p.id) || mine.has(r.p.id))
    && (!q || r.p.name.toLowerCase().includes(q) || r.p.team?.toLowerCase() === q));

  const [, heads, cells] = VIEWS[statView];
  $('#colHeads').innerHTML = heads
    .map((h, i) => `<span class="col${'ABC'[i]}">${h}</span>`).join('');

  const out = [];
  for (const r of rows.slice(0, limit)) {
    const d = drafted.has(r.p.id);
    const m = mine.has(r.p.id);
    const gap = r.adpRank - r.rank;
    out.push(`<div class="row player${d ? ' drafted' : ''}${m ? ' mine' : ''}" role="row">
<span class="rk">${r.rank}</span>
<span class="who">${posTag(r.p.pos)}
<button class="nm" data-open="${r.p.id}" title="Show detail">${r.p.name} <span class="tm">${r.p.team || ''}</span></button>
${r.p.rookie ? '<span class="rook">R</span>' : ''}</span>
${cells(r).map((v, i) => `<span class="num col${'ABC'[i]}${statView === 0 && i === 1 ? ' sc' : ''}`
  + `${statView === 0 && i === 2 ? (gap >= 8 ? ' up' : gap <= -8 ? ' dn' : '') : ''}">${v}</span>`).join('')}
<span class="acts">
<button data-d="${r.p.id}" aria-pressed="${d}">Gone</button>
<button data-m="${r.p.id}" aria-pressed="${m}">Mine</button></span></div>`);
    if (open === r.p.id) out.push(detail(r));
  }
  if (rows.length > limit) {
    out.push(`<div class="more"><button id="more">Show ${Math.min(100, rows.length - limit)} more`
      + ` <span class="hint">(${limit} of ${rows.length})</span></button></div>`);
  }
  $('#rows').innerHTML = out.join('');
  $('#empty').hidden = rows.length > 0;
}

const posTag = (p) => `<span class="pos ${POSCOL[p] || ''}">${p}</span>`;

function detail(r) {
  const bars = data.components.map((c) => {
    const v = r.scores[c.key];
    if (v == null) return '';
    return `<span class="bar"><span>${c.label}</span><i><b style="width:${Math.max(2, Math.round(v))}%"></b></i><u>${Math.round(v)}</u></span>`;
  }).join('');
  const m = r.p.m || {};
  const facts = [
    r.p.a?.gp ? `${r.p.a.gp} games` : null,
    m.snap_share ? `${Math.round(m.snap_share)}% of snaps` : null,
    m.touches_pg ? `${m.touches_pg.toFixed(1)} touches a game` : null,
    m.rz_pg ? `${m.rz_pg.toFixed(1)} red-zone touches a game` : null,
    m.last_ppg ? `${m.last_ppg.toFixed(1)} points a game` : null,
    m.draft_pick ? `NFL pick ${m.draft_pick}` : null,
  ].filter(Boolean);
  return `<div class="detail">
<p class="verdict"><b>${riskOf(r)}.</b> ${verdict(r)}</p>
<div class="bars">${bars}</div>
${statCards(r)}
<p class="facts">${facts.length ? `2025: <b>${facts.join('</b> · <b>')}</b>`
    : 'No 2025 data — rated off the projection.'}</p>
<p class="facts">Projected ${r.pts.toFixed(1)} points · ${r.vor.toFixed(1)} above replacement · your rating ${r.rating.toFixed(1)}</p>
</div>`;
}

// ---------------------------------------------------------------- my team
function renderRoster() {
  const lg = board.league;
  const mine = picks().mine;
  const rows = mine.map((id) => board.rows.find((r) => r.p.id === id)).filter(Boolean);
  const order = data.positions;
  rows.sort((a, b) => order.indexOf(a.p.pos) - order.indexOf(b.p.pos) || b.score - a.score);

  const seen = {};
  const flexUsed = [];
  const cards = rows.map((r) => {
    const n = (seen[r.p.pos] = (seen[r.p.pos] || 0) + 1);
    const want = lg.starters[r.p.pos] || 0;
    let role = 'Bench';
    if (n <= want) role = 'Starter';
    else if (['RB', 'WR', 'TE'].includes(r.p.pos) && flexUsed.length < (lg.starters.FLEX || 0)) {
      // FLEX goes to the best leftover by score, not to whoever sits highest by position
      const leftovers = rows.filter((x) => {
        const k = rows.filter((y) => y.p.pos === x.p.pos).indexOf(x) + 1;
        return ['RB', 'WR', 'TE'].includes(x.p.pos) && k > (lg.starters[x.p.pos] || 0);
      }).sort((a, b) => b.score - a.score);
      if (leftovers.slice(0, lg.starters.FLEX || 0).includes(r)) {
        role = 'FLEX'; flexUsed.push(r);
      }
    }
    const pick = mine.indexOf(r.p.id) + 1;
    const vsAdp = r.adpRank - pick;
    return { r, n, role, pick, vsAdp };
  });

  $('#lineup').innerHTML = cards.length ? `<div class="board">
<div class="row head lineup"><span>Slot</span><span>Player</span><span>Bye</span><span>Risk</span><span>Role</span></div>
${cards.map(({ r, n, role }) => `<div class="row lineup${role === 'Bench' ? ' drafted' : ''}">
<span class="rk">${r.p.pos}${n}</span>
<span class="who">${posTag(r.p.pos)}<span class="nm">${r.p.name} <span class="tm">${r.p.team || ''}</span></span></span>
<span class="num">${r.p.bye || '—'}</span>
<span class="risk">${riskOf(r)}</span>
<span class="role ${role}">${role}</span></div>`).join('')}</div>`
    : '<p class="empty">Tick <b>Mine</b> on the board and your team appears here.</p>';

  // bye coverage - starters and flex only, a bench player costs you nothing
  const byes = {};
  for (const c of cards) {
    if (c.role === 'Bench' || !c.r.p.bye) continue;
    byes[c.r.p.bye] = (byes[c.r.p.bye] || 0) + 1;
  }
  const weeks = Object.keys(byes).map(Number).sort((a, b) => a - b);
  const worst = Math.max(0, ...Object.values(byes));
  $('#byes').innerHTML = weeks.length
    ? weeks.map((w) => `<span class="bye${byes[w] >= 3 ? ' hot' : ''}"><b>${w}</b>${byes[w]} out</span>`).join('')
      + `<p class="facts">${worst >= 3
        ? `Week ${weeks.find((w) => byes[w] === worst)} costs you ${worst} starters. Spread the byes or plan a waiver week.`
        : 'No week costs you more than two starters.'}</p>`
    : '<p class="facts">Nothing drafted yet.</p>';

  const withPick = cards.filter((c) => c.pick);
  const avg = withPick.length
    ? withPick.reduce((a, c) => a + c.vsAdp, 0) / withPick.length : 0;
  const card = (label, val, note) => `<div class="card"><span class="cardV">${val}</span>
<span class="cardL">${label}</span><span class="hint">${note}</span></div>`;
  $('#cost').innerHTML = card('Picks made', cards.length, 'Players you have ticked Mine.')
    + card('Average vs ADP', avg.toFixed(1), 'Positive means they fell to you.')
    + card('Bargains', withPick.filter((c) => c.vsAdp >= 8).length, 'Taken 8+ picks after the room had them.')
    + card('Risky picks', cards.filter((c) => /^Risky|dart throw/.test(riskOf(c.r))).length,
      'Balance these against the safe ones.');

  const have = {};
  for (const c of cards) have[c.r.p.pos] = (have[c.r.p.pos] || 0) + 1;
  $('#needs').innerHTML = `<div class="row head needs"><span>Position</span><span>Need</span><span>Have</span><span>Status</span></div>`
    + Object.entries(lg.starters).filter(([p]) => p !== 'FLEX').map(([p, want]) => {
      const got = have[p] || 0;
      return `<div class="row needs"><span class="who">${posTag(p)}</span>
<span class="num">${want}</span><span class="num">${got}</span>
<span class="${got < want ? 'dn' : 'up'}">${got < want ? `Need ${want - got} more` : `Filled — ${got} drafted`}</span></div>`;
    }).join('');
}

// ---------------------------------------------------------------- ratings
function customsFor(key) { return (st.customs || []).filter((c) => c.comp === key); }

function renderRatings() {
  const cw = board.weights;
  const maxW = Math.max(...Object.values(cw), 1);
  $('#priority2').textContent = priorityOrder(data, st).slice(0, 4)
    .map((c) => c.label.toLowerCase()).join(' › ');
  $('#comps').innerHTML = data.components.map((c) => {
    const locked = c.key === 'floor' || c.key === 'ceiling';
    const subs = c.subs.map((sm) => {
      const cfg = st.sub[sm.key];
      if (!cfg) return '';
      return `<div class="statRow${cfg.on ? '' : ' off'}">
<label><input type="checkbox" data-son="${sm.key}"${cfg.on ? ' checked' : ''} />
<span>${sm.label}${sm.custom ? ' <em class="hint" style="display:inline">added</em>' : ''}</span></label>
${data.ratePos.map((q) => `<span class="miniW${cfg.w[q] ? '' : ' zero'}">
<input type="range" min="0" max="40" step="1" data-sw="${sm.key}" data-q="${q}" value="${cfg.w[q]}" />
<u>${cfg.w[q]}</u></span>`).join('')}
</div>`;
    }).join('');

    const unused = RAW_FIELDS.filter(([f]) => !customsFor(c.key).some((x) => x.field === f));
    return `<details class="comp"${c.key === 'volume' ? ' open' : ''}>
<summary><span class="cName">${c.label}</span>
<span class="cDesc">${c.desc}</span>
<span class="cMeter"><b style="width:${Math.round(((cw[c.key] ?? 0) / maxW) * 100)}%"></b></span>
<span class="cW">${cw[c.key] ?? 0}</span></summary>
<div class="cBody">
${locked
    ? '<p class="hint">Driven by the Safe ↔ Upside slider on the board, so it is not set here.</p>'
    : `<div class="cTop"><span>How much this component counts</span>
<input type="range" min="0" max="30" step="1" data-cw="${c.key}" value="${st.comp[c.key] ?? 0}" /></div>`}
${c.subs.length ? `<div class="statRow hdr"><span>Stat</span>${data.ratePos.map((q) => `<span>${q}</span>`).join('')}</div>${subs}
<p class="hint">One slider per position. A zero means the stat says nothing there — a receiver has no carries to break tackles on — but you can raise it if you disagree.</p>` : ''}
${locked ? '' : `<div class="addBar">
<select data-addfield="${c.key}"><option value="">Add another stat…</option>
${unused.map(([f, lbl, hi, pg]) => `<option value="${f}|${hi}|${pg}">${lbl}${pg ? ' (per game)' : ''}</option>`).join('')}</select>
${customsFor(c.key).length ? `<button data-clearcustom="${c.key}" class="small">Remove added stats</button>` : ''}
</div>`}
</div></details>`;
  }).join('');
}

// ---------------------------------------------------------------- sleeper
function msg(el, text, kind) {
  const n = $(el);
  n.hidden = !text;
  n.textContent = text || '';
  n.className = `setupMsg${kind ? ` ${kind}` : ''}`;
}

function renderSetup() {
  $('#user').value = st.sleeperUser || '';
  const mine = data.leagues.filter((l) => l.imported);
  $('#leagueList').innerHTML = mine.length ? mine.map((l) => `<div class="lgCard">
<b>${l.name}</b> — ${l.teams} teams${l.rounds ? `, ${l.rounds} rounds` : ''}
<span class="hint">${Object.entries(l.starters).map(([k, v]) => `${v}${k}`).join(' · ')}${l.draft ? ` · drafts ${l.draft}` : ''}${l.slot ? ` · you pick ${l.slot}` : ''}</span>
${l.ignored?.length ? `<span class="hint">Not scored: ${l.ignored.join(', ')} — no projection exists for these.</span>` : ''}
</div>`).join('') : '';
}

async function doImport() {
  const name = $('#user').value.trim();
  if (!name) return msg('#setupMsg', 'Type your Sleeper username first.', 'bad');
  msg('#setupMsg', 'Asking Sleeper…');
  try {
    const { userId, leagues } = await importLeagues(name, $('#season').value.trim(), data.scoreKeys);
    st.sleeperUser = name;
    st.sleeperId = userId;
    st.imported = leagues;
    // a fresh import replaces everything, sample league included
    data.leagues = leagues;
    st.league = 0;
    for (let i = 0; i < data.leagues.length; i++) st.picks[i] ||= { drafted: [], mine: [] };
    save();
    renderChrome();
    rebuild();
    msg('#setupMsg', `Imported ${leagues.length} league${leagues.length === 1 ? '' : 's'}. `
      + 'Pick one from the dropdown at the top.', 'good');
  } catch (e) {
    msg('#setupMsg', e instanceof SleeperError ? e.message : `Something went wrong: ${e.message}`, 'bad');
  }
}

async function doSync() {
  const lg = data.leagues[st.league];
  if (!lg.draft_id) return msg('#syncMsg', 'This league has no draft on Sleeper yet.', 'bad');
  try {
    const list = await draftPicks(lg.draft_id, st.sleeperId);
    if (!list.length) return msg('#syncMsg', 'The draft has not started — no picks yet.');
    const known = new Set(data.players.map((p) => p.id));
    const pk = picks();
    let added = 0;
    let skipped = 0;
    for (const p of list) {
      if (!known.has(p.playerId)) { skipped += 1; continue; }
      if (!pk.drafted.includes(p.playerId)) { pk.drafted.push(p.playerId); added += 1; }
      if (p.mine && !pk.mine.includes(p.playerId)) pk.mine.push(p.playerId);
    }
    save();
    rebuild();
    msg('#syncMsg', `${list.length} picks made, ${added} new.`
      + (skipped ? ` ${skipped} not in the player pool — deep bench, safe to ignore.` : ''), 'good');
  } catch (e) {
    msg('#syncMsg', e instanceof SleeperError ? e.message : `Sync failed: ${e.message}`, 'bad');
  }
}

function toggleAuto() {
  const b = $('#syncAuto');
  if (timer) {
    clearInterval(timer);
    timer = null;
    b.textContent = 'Start auto-sync';
    return msg('#syncMsg', 'Auto-sync stopped.');
  }
  timer = setInterval(doSync, 8000);
  b.textContent = 'Stop auto-sync';
  doSync();
}

// ---------------------------------------------------------------- chrome
function statCards(r) {
  const a = r.p.a || {};
  const g = Math.max(a.gp || 0, 1);
  const cells = [
    ['Games', a.gp], ['Carries', a.rush_att], ['Targets', a.rec_tgt],
    ['Catches', a.rec], ['Scrim. yds', a.rush_rec_yd], ['TDs', a.anytime_tds],
    ['RZ carries', a.rush_rz_att], ['RZ targets', a.rec_rz_tgt],
    ['Yds/carry', a.rush_ypa?.toFixed(1)], ['Yds/target', a.rec_ypt?.toFixed(1)],
    ['Pts/game', a.pts_ppr ? (a.pts_ppr / g).toFixed(1) : null],
    ['2025 finish', a.pos_rank_ppr ? `${r.p.pos}${a.pos_rank_ppr}` : null],
  ].filter(([, v]) => v != null && v !== '');
  if (!cells.length) return '';
  return `<div class="statGrid">${cells
    .map(([l, v]) => `<span class="stat"><span>${l}</span><b>${v}</b></span>`).join('')}</div>`;
}

function renderChrome() {
  $('#league').innerHTML = data.leagues
    .map((l, i) => `<option value="${i}"${i === st.league ? ' selected' : ''}>${l.name}</option>`).join('');
  $('#filters').innerHTML = ['ALL', ...data.positions]
    .map((p) => `<button data-f="${p}" aria-pressed="${p === filter}">${p === 'ALL' ? 'All' : p}</button>`).join('');
  $('#style').value = st.style;
  $('#tilt').value = Math.round(st.tilt * 100);
  $('#need').value = st.need;
  $('#statView').innerHTML = VIEWS
    .map(([n], i) => `<option value="${i}"${i === statView ? ' selected' : ''}>${n}</option>`).join('');
  $('#rookie').checked = st.rookie;
  $('#hideGone').checked = !!st.hideGone;
  readouts();
}

function readouts() {
  $('#styleOut').textContent = styleWord(st.style);
  $('#tiltOut').textContent = `${Math.round(st.tilt * 100)}%`;
  $('#needOut').textContent = st.need;
  $('#priority').textContent = priorityOrder(data, st).slice(0, 3)
    .map((c) => c.label.toLowerCase()).join(' › ');
}

function show(v) {
  view = v;
  for (const s of ['board', 'roster', 'ratings', 'setup']) $(`#v-${s}`).hidden = s !== v;
  document.querySelectorAll('[data-v]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
  renderAll();
}

function measure() {
  const h = document.querySelector('.top')?.offsetHeight || 60;
  document.documentElement.style.setProperty('--stick', `${h}px`);
}

// ---------------------------------------------------------------- events
function wire() {
  $('#settingsBtn').onclick = (e) => {
    const p = $('#settings');
    p.hidden = !p.hidden;
    e.target.setAttribute('aria-expanded', String(!p.hidden));
  };
  $('#league').onchange = (e) => { st.league = +e.target.value; open = null; save(); rebuild(); };
  $('#search').oninput = (e) => { query = e.target.value; limit = 100; renderBoard(); };
  $('#statView').onchange = (e) => { statView = +e.target.value; save(); renderBoard(); };
  $('#reset').onclick = () => { st.picks[st.league] = { drafted: [], mine: [] }; save(); rebuild(); };
  for (const [id, fn] of [['style', (v) => { st.style = +v; }],
    ['tilt', (v) => { st.tilt = +v / 100; }], ['need', (v) => { st.need = +v; }]]) {
    $(`#${id}`).oninput = (e) => { fn(e.target.value); readouts(); save(); scheduleRebuild(); };
  }
  $('#rookie').onchange = (e) => { st.rookie = e.target.checked; save(); rebuild(); };
  if (window.ResizeObserver) new ResizeObserver(measure).observe(document.querySelector('.top'));
  window.addEventListener('resize', measure);
  $('#importL').onclick = doImport;
  $('#syncOnce').onclick = doSync;
  $('#syncAuto').onclick = toggleAuto;
  $('#hideGone').onchange = (e) => { st.hideGone = e.target.checked; save(); renderBoard(); };

  // ratings profile as a file, so you and someone else can keep different ones
  $('#exportR').onclick = () => {
    const { comp, sub, style, tilt, need, rookie } = st;
    const blob = new Blob([JSON.stringify({ kind: 'draft2026-ratings', comp, sub, style, tilt, need, rookie }, null, 2)],
      { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'my-ratings.json';
    a.click();
  };
  $('#importR').onchange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    f.text().then((t) => {
      const o = JSON.parse(t);
      Object.assign(st, { comp: o.comp, sub: o.sub, style: o.style, tilt: o.tilt, need: o.need, rookie: o.rookie });
      save(); renderChrome(); rebuild();
    }).catch(() => alert('That file is not a ratings profile.'));
  };
  $('#resetR').onclick = () => {
    const base = DEFAULT_SETTINGS(data);
    Object.assign(st, { comp: base.comp, sub: base.sub });
    save(); rebuild();
  };

  document.body.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.cw) {
      st.comp[t.dataset.cw] = +t.value;
      t.closest('.comp').querySelector('.cW').textContent = t.value;
      save(); scheduleRebuild();
    } else if (t.dataset.sw) {
      const v = +t.value || 0;
      st.sub[t.dataset.sw].w[t.dataset.q] = v;
      t.parentElement.querySelector('u').textContent = v;
      t.parentElement.classList.toggle('zero', !v);
      save(); scheduleRebuild();
    }
  });
  document.body.addEventListener('change', (e) => {
    const add = e.target.dataset.addfield;
    if (add && e.target.value) {
      const [field, hi, pg] = e.target.value.split('|');
      const meta = RAW_FIELDS.find(([f]) => f === field);
      st.customs ||= [];
      st.customs.push({
        key: `x_${add}_${field}`, field, comp: add,
        hi: hi === 'true', pg: pg === 'true',
        label: meta[1] + (pg === 'true' ? ' / game' : ''),
      });
      syncCustoms();
      cacheKey = '';
      save(); rebuild();
      return;
    }
    if (e.target.dataset.son) {
      st.sub[e.target.dataset.son].on = e.target.checked;
      e.target.closest('.statRow').classList.toggle('off', !e.target.checked);
      save(); rebuild();
    }
  });

  document.body.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.clearcustom) {
      st.customs = (st.customs || []).filter((c) => c.comp !== b.dataset.clearcustom);
      syncCustoms(); cacheKey = ''; save(); rebuild();
    } else if (b.id === 'more') { limit += 100; renderBoard(); }
    else if (b.dataset.v) show(b.dataset.v);
    else if (b.dataset.f) {
      filter = b.dataset.f;
      limit = 100;
      document.querySelectorAll('[data-f]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.f === filter)));
      renderBoard();
    } else if (b.dataset.open) { open = open === b.dataset.open ? null : b.dataset.open; renderBoard(); }
    else if (b.dataset.d) toggle('drafted', b.dataset.d);
    else if (b.dataset.m) {
      const on = toggle('mine', b.dataset.m);
      const dl = picks().drafted;
      if (on && !dl.includes(b.dataset.m)) dl.push(b.dataset.m);
      save(); rebuild();
    }
  });
}

function toggle(list, id) {
  const arr = picks()[list];
  const i = arr.indexOf(id);
  if (i >= 0) arr.splice(i, 1); else arr.push(id);
  save();
  if (list === 'drafted') rebuild();
  return i < 0;
}

// ---------------------------------------------------------------- go
fetch('data/players.json')
  .then((r) => r.json())
  .then((d) => { data = d; load(); wire(); renderChrome(); rebuild(); })
  .catch((e) => {
    document.querySelector('#v-board main').innerHTML =
      `<p class="empty">Could not load the player data.<br><small>${e}</small></p>`;
  });
