import { DEFAULT_SETTINGS, buildBoard, priorityOrder, subScores, SAMPLE_LEAGUE, applyCustomStats, draftContext, availability, poolAround, costOfWaiting, STAR_BAND, FIT_AXES, hasPenalties, swingShare, riskPoints, axisKeys, axisSpare, keyName } from './engine.js?v=202608131020';
import { importLeagues, draftPicks, dryRun, SleeperError } from './sleeper.js?v=202608131020';
import { TIPS, PCT_NOTE } from './tips.js?v=202608131020';
import { PRESETS, LEANS, activePreset, activeLean, suggestLean } from './strategies.js?v=202608131020';

const $ = (s) => document.querySelector(s);
const KEY = 'draft2026';
const BUILD = '202608131020';
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
// named pickHistory, not history: `history` is a global in every browser and shadowing
// it is a trap waiting to happen
let pickHistory = [];
let subVersion = 0;
let cachedVersion = -1;
let frame = null;
let limit = 100;
let clock = null;

// The board always shows your rating and the room's ADP - those two are the whole
// argument for or against a pick, so they are never behind a toggle. Everything else is
// a group you can switch on, and several can be on at once.
// One verdict, and it moves with the draft. A man who is a reach at pick 4 becomes a
// steal at pick 40 without anything about him changing.
const KINDS = {
  steal: ['Steal', 'He has fallen past the point where he stops being worth it.'],
  safe: ['Safe', 'Priced about right, and he is a steady scorer who stays on the field.'],
  swing: ['Swing', 'Priced about right, but his points arrive in lumps.'],
  reach: ['Reach', 'Taking him here means passing men your board rates higher.'],
};
const FIXED = [
  ['Type', (r) => (r.kind
    ? `<em class="kind ${r.kind}">${KINDS[r.kind][0]}</em>` : '<em class="soft">—</em>'), 58, ''],
  // Not a grade. The span of picks where taking him costs you nothing, because everyone
  // inside it is a player you would be equally happy with.
  // Plain information, no colour. The judgement is in Type, which knows the clock.
  ['Worth', (r) => `<em class="win">${r.openEnded ? `${r.worthFrom}+`
    : r.worthFrom === r.worthTo ? r.worthFrom
      : `${r.worthFrom}–${r.worthTo}`}</em>`, 66, 'wd'],
  ['ADP', (r) => (r.p.adp ? r.p.adp.toFixed(1) : '—'), 52, ''],
  ['Score', (r) => r.score.toFixed(1), 58, 'sc'],
];
// The stats worth seeing differ by position - a receiver's carries tell you nothing. This
// group only appears when you have filtered to one position, and it changes with it.
const POS_COLS = {
  QB: [['Pa yds', (r) => r.p.a?.pass_yd ?? '—', 62], ['Pa TD', (r) => r.p.a?.pass_td ?? '—', 52],
    ['INT', (r) => r.p.a?.pass_int ?? '—', 46], ['Cmp%', (r) => pct(r.p.a?.cmp_pct), 52],
    ['Y/att', (r) => one(r.p.a?.pass_ypa), 52], ['Ru yds', (r) => r.p.a?.rush_yd ?? '—', 58]],
  RB: [['Carries', (r) => r.p.a?.rush_att ?? '—', 60], ['Y/carry', (r) => one(r.p.a?.rush_ypa), 58],
    ['Targets', (r) => r.p.a?.rec_tgt ?? '—', 60], ['RZ car', (r) => r.p.a?.rush_rz_att ?? '—', 56]],
  WR: [['Targets', (r) => r.p.a?.rec_tgt ?? '—', 60], ['Catch%', (r) => pct(catchRate(r)), 58],
    ['Y/tgt', (r) => one(r.p.a?.rec_ypt), 52], ['RZ tgt', (r) => r.p.a?.rec_rz_tgt ?? '—', 56],
    ['Drops', (r) => r.p.a?.rec_drop ?? '—', 52]],
  TE: [['Targets', (r) => r.p.a?.rec_tgt ?? '—', 60], ['Catch%', (r) => pct(catchRate(r)), 58],
    ['Y/tgt', (r) => one(r.p.a?.rec_ypt), 52], ['RZ tgt', (r) => r.p.a?.rec_rz_tgt ?? '—', 56]],
};
// one button, three states: no view -> I like him more -> I trust him less
const starMark = (r) => (r.star ? '★' : r.fade ? '✕' : '☆');

// How many of your likely starters already sit on this player's bye week.
// Bench players are ignored - a third back on your bye costs you nothing.
function byeClash(bye) {
  if (!bye) return 0;
  const lg = board.league;
  const counts = {};
  const seen = {};
  for (const id of picks().mine) {
    const p = byId(id);
    if (!p) continue;
    seen[p.pos] = (seen[p.pos] || 0) + 1;
    const slots = (lg.starters[p.pos] || 0) + (['RB', 'WR', 'TE'].includes(p.pos)
      ? (lg.starters.FLEX || 0) : 0);
    if (seen[p.pos] <= slots && p.bye) counts[p.bye] = (counts[p.bye] || 0) + 1;
  }
  return counts[bye] || 0;
}

const catchRate = (r) => (r.p.a?.rec_tgt ? (r.p.a.rec / r.p.a.rec_tgt) * 100 : null);

const GROUPS = [
  ['bye', 'Bye + value', [
    ['Bye', (r) => r.p.bye || '—', 42, ''],
    ['vs ADP', (r) => gapCell(r), 56, ''],
  ]],
  ['pg', '2025 per game', [
    ['Snap %', (r) => pct(r.p.m.snap_share), 56, ''],
    ['Tch/g', (r) => one(r.p.m.touches_pg), 52, ''],
    ['Pts/g', (r) => one(r.p.m.last_ppg), 52, ''],
  ]],
  ['tot', '2025 totals', [
    ['Gms', (r) => r.p.a?.gp ?? '—', 44, ''],
    ['Yards', (r) => r.p.a?.rush_rec_yd ?? '—', 56, ''],
    ['TDs', (r) => r.p.a?.anytime_tds ?? '—', 44, ''],
  ]],
  ['proj', '2026 projection', [
    ['Proj', (r) => r.pts.toFixed(0), 52, ''],
    ['P/g', (r) => one(r.p.m.proj_ppg), 48, ''],
    ['Tch', (r) => Math.round((r.p.proj?.rush_att || 0) + (r.p.proj?.rec || 0)) || '—', 48, ''],
  ]],
  ['back', 'Back next turn?', [
    ['Back?', (r) => backCell(r), 62, ''],
  ]],
  ['rz', 'Red zone', [
    ['RZ/g', (r) => one(r.p.m.rz_pg), 50, ''],
    ['RZ TD%', (r) => pct(r.p.m.rz_conv * 100), 60, ''],
  ]],
];
const one = (v) => (v == null ? '—' : (+v).toFixed(1));
const pct = (v) => (v == null || Number.isNaN(v) ? '—' : `${Math.round(v)}%`);
function backCell(r) {
  if (!clock?.target) return '<em class="soft">—</em>';
  const p = availability(r.p.adp, clock.target, clock.currentPick);
  if (p == null) return '<em class="soft">—</em>';
  const v = Math.round(p * 100);
  const txt = p < 0.01 ? '<1%' : p > 0.99 ? '>99%' : `${v}%`;
  return `<em class="${v >= 65 ? 'up' : v < 35 ? 'dn' : ''}">${txt}</em>`;
}

function gapCell(r) {
  const g = r.adpRank - r.rank;
  return `<em class="${g >= 8 ? 'up' : g <= -8 ? 'dn' : ''}">${g > 0 ? '+' : ''}${g}</em>`;
}
const activeCols = () => [
  ...FIXED,
  ...GROUPS.filter(([k]) => st.cols?.[k]).flatMap(([, , cols]) => cols),
  ...(st.cols?.posdetail && POS_COLS[filter]
    ? POS_COLS[filter].map(([n, f, w]) => [n, f, w, ''])
    : []),
];

// ---------------------------------------------------------------- state
function load() {
  const base = DEFAULT_SETTINGS(data);
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { saved = null; }
  st = { ...base, ...(saved || {}) };

  // A saved profile may be older than the current stat list, in both directions.
  // New stats have to be added, and - the part that was silently wrong - stats that no
  // longer exist have to be dropped. A leftover weight for a deleted component still
  // counted towards the total the rating divides by, quietly diluting every real one.
  st.comp = { ...base.comp, ...(st.comp || {}) };
  for (const k of Object.keys(st.comp)) if (!(k in base.comp)) delete st.comp[k];
  st.sub ||= {};
  for (const [k, v] of Object.entries(base.sub)) st.sub[k] = st.sub[k] || v;
  const live = new Set(Object.keys(base.sub));
  for (const k of Object.keys(st.sub)) {
    if (!live.has(k) && !k.startsWith('x_')) delete st.sub[k];   // x_ are your own additions
  }
  // Whoever opens this link is not necessarily whoever generated the data file, so the
  // leagues baked into it are never shown. You get a neutral league until you import.
  data.leagues = st.imported?.length ? [...st.imported] : [SAMPLE_LEAGUE];
  if (st.league >= data.leagues.length) st.league = 0;
  st.slots ||= {};
  st.picks ||= {};
  for (let i = 0; i < data.leagues.length; i++) st.picks[i] ||= { drafted: [], mine: [] };
}
let saveTimer = null;
function save() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { localStorage.setItem(KEY, JSON.stringify(st)); } catch { /* private mode */ }
  }, 250);
}
// anything that must not be lost (closing the tab mid-drag) flushes immediately
function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try { localStorage.setItem(KEY, JSON.stringify(st)); } catch { /* private mode */ }
}
const picks = () => st.picks[st.league];
const byId = (id) => data.players.find((p) => p.id === id);

// ---------------------------------------------------------------- wording
// Sleeper's own wording. Out / IR / PUP means he is not playing; the rest is a question
// mark. Either way it belongs on the row, not buried.
const INJ_BAD = ['Out', 'IR', 'PUP', 'NA', 'Sus', 'DNR'];
const injBadge = (p) => (p.inj
  ? `<span class="inj ${INJ_BAD.includes(p.inj) ? 'bad' : 'warn'}" title="${p.inj}${p.injPart ? ` — ${p.injPart}` : ''}">${p.inj.slice(0, 3).toUpperCase()}</span>`
  : '');

const styleWord = (v) => (v <= 15 ? 'safest floor' : v <= 40 ? 'leaning safe'
  : v < 60 ? 'balanced' : v < 85 ? 'leaning upside' : 'highest ceiling');

function riskOf(r) {
  const f = r.scores.floorish ?? 50;
  if (r.p.inj) {
    const bad = INJ_BAD.includes(r.p.inj);
    return `${bad ? 'Not playing' : 'Injury question'} — ${r.p.inj}`
      + `${r.p.injPart ? ` (${r.p.injPart})` : ''}`;
  }
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
// Two different gaps, and the call needs both:
//
//   market edge = how far past his ADP the draft has gone. Is the ROOM letting him slide?
//   your edge   = how far above the current pick your own board has him. Do YOU want him?
//
// Only when both are positive is it a steal. A player who has slid twenty picks but sits
// 200th on your board is not a bargain - it means the room is right and you agree. And a
// player you rate far above his ADP is worth taking early even though the market calls
// that a reach, which is the whole point of having your own ratings.
function callFor(r) {
  const now = clock?.currentPick;
  if (!now) {
    const g = r.adpRank - r.rank;
    return g >= 12 ? ['Value', `You rate him ${g} spots above the room.`]
      : g <= -12 ? ['Reach', `The room rates him ${-g} spots above you.`]
        : ['Fair', 'You and the room agree on him.'];
  }
  const mkt = r.p.adp ? now - r.p.adp : 0;   // + = the draft is past where he normally goes
  const you = now - r.rank;                  // + = your board has him better than this pick

  if (you >= 10 && mkt >= 8) {
    return ['Steal', `You have him ${Math.round(you)} picks better than this slot, and he is `
      + `${Math.round(mkt)} past his ADP. Both you and the room have left him here.`];
  }
  if (you >= 10) {
    return ['Your guy', `Your board has him ${Math.round(you)} picks better than this slot. `
      + `The room would call this early — that is your rating disagreeing, not a mistake.`];
  }
  if (mkt >= 12 && you <= 0) {
    return ['Room is right', `He has slid ${Math.round(mkt)} picks past his ADP, but your `
      + `board has him at #${r.rank} too. A faller you also do not rate is not a bargain.`];
  }
  if (you >= 4) return ['Value', `A little better than this slot on your board (#${r.rank}).`];
  if (you >= -8) return ['Fair', `About right for this slot — your board has him #${r.rank}.`];
  return ['Reach', `Your board has him #${r.rank}, ${Math.round(-you)} picks later than this.`];
}

// Wait, or take him now - the question the whole board exists to answer. The wording
// changes depending on whether you are actually on the clock, because "take him now" is
// useless advice when it is somebody else's pick.
function waitAdvice(r, drafted) {
  if (!clock?.target) return '';
  const p = availability(r.p.adp, clock.target, clock.currentPick);
  if (p == null) return '';
  // never print "0%" - it reads as a bug rather than as long odds
  const v = p < 0.01 ? '<1' : p > 0.99 ? '>99' : Math.round(p * 100);
  const n = Math.round(p * 100);
  const pool = poolAround(board.rows, r, drafted);
  const at = `pick ${clock.target} (${clock.gap} away)`;
  // deep into the draft the scores compress and "122 similar players" is true but absurd
  const many = pool > 20 ? '20+' : pool;
  const similar = pool >= 4 ? ` ${many} similar players are still on the board.` : '';
  const alone = pool === 0 ? ' Nobody close to him is left.' : '';

  if (clock.onClock) {
    if (n >= 65) return `<b class="good">You can wait.</b> ${v}% he comes back to you at ${at}.${similar}`;
    if (n >= 35) return `<b class="warn">Coin flip.</b> ${v}% he lasts to ${at}.${similar || alone}`;
    return `<b class="bad">Take him now.</b> Only ${v}% he lasts to ${at}.${similar || alone}`;
  }
  if (n >= 65) return `<b class="good">Should reach you.</b> ${v}% he is still there at ${at}.${similar}`;
  if (n >= 35) return `<b class="warn">Might reach you.</b> ${v}% he lasts to ${at}.${similar || alone}`;
  return `<b class="bad">Will not reach you.</b> Only ${v}% he lasts to ${at}.${similar || alone}`;
}

function verdict(r) {
  const ranked = Object.entries(r.scores)
    .filter(([k, v]) => v != null && NAMED[k]).sort((a, b) => b[1] - a[1]);
  const [bk, bv] = ranked[0];
  const [wk, wv] = ranked[ranked.length - 1];
  return (bv >= 60 ? `The case for him: ${NAMED[bk]} (${Math.round(bv)}).` : '')
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

// The recommendation panel: what to do with THIS pick, and why.
function renderAdvice() {
  const box = $('#advice');
  if (!box) return;
  const drafted = new Set(picks().drafted);
  const have = {};
  for (const id of picks().mine) {
    const p = byId(id);
    if (p) have[p.pos] = (have[p.pos] || 0) + 1;
  }
  if (!clock?.target) {
    box.innerHTML = '<p class="hint">Add your draft slot above and this will tell you '
      + 'what to do with each pick.</p>';
    return;
  }
  const ranked = costOfWaiting(board.rows, clock, drafted, board.league, have, { need: st.need })
    .filter((x) => !['K', 'DEF'].includes(x.pos) || x.shortfall > 0);
  if (!ranked.length) { box.innerHTML = ''; return; }

  const top = ranked[0];
  // if you have starred someone at this position who is within touching distance of the
  // best available, recommend YOUR man - that is the whole point of the star
  const near = board.rows.find((r) => r.p.pos === top.pos && r.star && !drafted.has(r.p.id)
    && r.score >= top.best.score - STAR_BAND && r.p.id !== top.best.p.id);
  if (near) top.best = near;
  // and never lead with someone you have said you do not trust, if there is an alternative
  if (top.best.fade) {
    const alt = board.rows.find((r) => r.p.pos === top.pos && !r.fade && !drafted.has(r.p.id)
      && r.score >= top.best.score - STAR_BAND * 2);
    if (alt) top.best = alt;
  }
  const cliff = top.best.lastOfTier;
  // kickers and defences always "can wait" - saying so is noise
  const cheap = ranked.filter((x) => x.cost < top.cost * 0.55 && x.pos !== top.pos
    && !['K', 'DEF'].includes(x.pos)).slice(0, 2);
  const when = clock.onClock ? 'Take' : 'Line up';

  box.innerHTML = `<div class="advHead">
<span class="advTag">${when} ${top.pos}</span>
<b>${top.best.p.name}</b> <span class="tm">${top.best.p.team || ''}</span>
<span class="hint">score ${top.best.score.toFixed(1)}${top.shortfall ? ` · you still need ${top.shortfall}` : ''}${near ? ' · your pick, and close enough to take' : ''}</span>
${cliff ? `<span class="cliffTag">last of ${top.pos} tier ${top.best.tier}</span>` : ''}
</div>
<p class="advWhy">${top.cost < 1
    ? `Nothing is urgent — the best ${top.pos} should still be there at pick ${clock.target}.`
    : `Waiting on ${top.pos} costs you about <b>${top.cost.toFixed(0)}</b> points of score —`}
${top.cost < 1 ? '' : top.survivor
    ? `the best one you could still expect at pick ${clock.target} is ${top.survivor.p.name}.`
    : `there is nobody at ${top.pos} you could count on being there at pick ${clock.target}.`}
${cheap.length
    ? ` ${cheap.map((c) => c.pos).join(' and ')} can wait${cheap.every((c) => c.cost < 1)
      ? ' — the same player will be there next turn.'
      : ` — ${cheap.length > 1 ? 'they cost' : 'it costs'} about ${cheap.map((c) => c.cost.toFixed(0)).join(' and ')}.`}`
    : ''}</p>
<div class="advCost">${ranked.slice(0, 5).map((x) => `<span class="costPill${x === top ? ' hot' : ''}">
<b>${x.pos}</b>${x.cost.toFixed(0)}</span>`).join('')}
<span class="hint">cost of waiting, by position</span></div>`;
}

function tickClock() {
  const lg = board?.league || data.leagues[st.league];
  // per league: slot 4 in one is not slot 4 in another
  const slot = st.slots?.[st.league] ?? lg?.slot ?? null;
  // the pick on the clock is simply however many are already off the board, plus one
  const now = picks().drafted.length + 1;
  clock = draftContext(lg, slot, now);
  const bar = $('#clockBar');
  if (!bar) return;
  $('#clockNow').textContent = `Pick ${now}`;
  if (!slot) {
    $('#clockNext').innerHTML = '<span class="hint">Add your draft slot to see whether players come back to you.</span>';
  } else if (clock?.onClock) {
    $('#clockNext').innerHTML = `<b class="good">You are on the clock.</b> Then pick ${clock.target} — ${clock.gap} away.`;
  } else if (clock?.target) {
    $('#clockNext').innerHTML = `Your next pick is <b>${clock.next}</b>, then <b>${clock.after ?? '—'}</b>. Waiting costs ${clock.gap} pick${clock.gap === 1 ? '' : 's'}.`;
  } else {
    $('#clockNext').innerHTML = '<span class="hint">Draft finished.</span>';
  }
}

function rebuild() {
  if (cachedVersion !== subVersion) {
    cache = subScores(data, st);
    cachedVersion = subVersion;
  }
  board = buildBoard(data, {
    ...st,
    mine: picks().mine.map((id) => byId(id)?.pos),
    // however many are off the board, plus one. Feeding it in here is what makes the
    // Type column move as the draft goes rather than sitting on its pre-draft answer.
    atPick: picks().drafted.length + 1,
  }, cache);
  tickClock();
  renderAll();
}

// Sliders fire an input event per pixel. Coalescing to one rebuild per animation frame
// keeps the drag smooth instead of queueing a full re-render behind every event.
const raf = typeof requestAnimationFrame === 'function'
  ? requestAnimationFrame : (fn) => setTimeout(fn, 16);

function scheduleRebuild() {
  if (frame) return;
  frame = raf(() => { frame = null; rebuild(); });
}

function renderAll() {
  if (view === 'board') { renderBoard(); renderAdvice(); renderLean(); }
  if (view === 'roster') renderRoster();
  if (view === 'ratings') renderRatings();
  if (view === 'setup') renderSetup();
  const age = Math.floor((Date.now() - new Date(data.generated).getTime()) / 86400000);
  const stale = age > 7;
  const u = $('#undo');
  if (u) {
    u.disabled = !pickHistory.length;
    u.textContent = pickHistory.length ? `Undo ${pickHistory[pickHistory.length - 1].label}` : 'Undo';
  }
  $('#meta').innerHTML = `${board.rows.length} players · ${board.league.name} · `
    + `${picks().mine.length} on your roster · build ${BUILD} · `
    + `<span class="age${stale ? ' stale' : ''}" data-tip="age" tabindex="0">`
    + `data ${age <= 0 ? 'from today' : age === 1 ? '1 day old' : `${age} days old`}`
    + `${stale ? ' — ADP moves fast in August' : ''}</span>`;
}

// Rebuilding the whole list with innerHTML meant discarding and re-parsing roughly two
// thousand nodes on every frame of a slider drag. Instead the row elements are kept and
// reused: only the numbers that changed are rewritten, and reordering is done by moving
// the existing nodes. Dragging a slider now touches text, not structure.
let rowEls = new Map();
let lastCols = '';

function rowHTML(r, cols, d, m) {
  return `<span class="rk">${r.rank}</span>
<span class="who">${posTag(r.p.pos)}
<button class="nm" data-open="${r.p.id}" title="Show detail">${r.p.name} <span class="tm">${r.p.team || ''}</span></button>
${r.p.rookie ? '<span class="rook">R</span>' : ''}${injBadge(r.p)}
${r.lastOfTier ? `<span class="tierEnd" data-tip="cliff">last ${r.p.pos}${r.tier}</span>` : ''}
${byeClash(r.p.bye) >= 2 ? `<span class="byeClash" data-tip="byeclash">bye ${r.p.bye} ×${byeClash(r.p.bye) + 1}</span>` : ''}</span>
${cols.map((c) => `<span class="num ${c[3]}">${c[1](r)}</span>`).join('')}
<span class="acts">
<button class="starBtn ${r.star ? 'on' : ''}${r.fade ? ' off' : ''}" data-star="${r.p.id}"
 aria-label="Your view of ${r.p.name}" data-tip="star">${starMark(r)}</button>
<button data-d="${r.p.id}" aria-pressed="${d}">Gone</button>
<button data-m="${r.p.id}" aria-pressed="${m}">Mine</button></span>`;
}

function renderBoard() {
  const q = query.trim().toLowerCase();
  const drafted = new Set(picks().drafted);
  const mine = new Set(picks().mine);
  const cols = activeCols();
  const colKey = cols.map((c) => c[0]).join('|');

  $('#board').style.setProperty('--cols',
    `34px minmax(190px, 1fr) ${cols.map((c) => `${c[2]}px`).join(' ')} 102px`);
  if (colKey !== lastCols) {
    $('#colHeads').innerHTML = cols
      .map((c) => `<span data-tip="${c[0]}" tabindex="0">${c[0]}</span>`).join('');
    rowEls = new Map();            // the cell layout changed, so start the rows again
    $('#rows').innerHTML = '';
    lastCols = colKey;
  }

  const rows = board.rows.filter((r) => (filter === 'ALL' || r.p.pos === filter)
    && (!st.hideGone || !drafted.has(r.p.id) || mine.has(r.p.id))
    && (!st.cols?.starsonly || r.star || r.fade)
    && (!q || r.p.name.toLowerCase().includes(q) || r.p.team?.toLowerCase() === q))
    .slice(0, limit);

  const host = $('#rows');
  const frag = document.createDocumentFragment();
  const keep = new Set();

  for (const r of rows) {
    const d = drafted.has(r.p.id);
    const m = mine.has(r.p.id);
    let el = rowEls.get(r.p.id);
    if (!el) {
      el = document.createElement('div');
      el.dataset.id = r.p.id;
      el.setAttribute('role', 'row');
      el.innerHTML = rowHTML(r, cols, d, m);
      rowEls.set(r.p.id, el);
    } else {
      // reuse: only rewrite the cells whose text actually differs
      el.querySelector('.rk').textContent = r.rank;
      const nums = el.querySelectorAll('.num');
      cols.forEach((c, i) => {
        const v = String(c[1](r));
        if (nums[i] && nums[i].innerHTML !== v) nums[i].innerHTML = v;
      });
      const who = el.querySelector('.who');
      const clash = byeClash(r.p.bye);
      const cb = who.querySelector('.byeClash');
      if (clash >= 2 && !cb) {
        who.insertAdjacentHTML('beforeend',
          `<span class="byeClash" data-tip="byeclash">bye ${r.p.bye} ×${clash + 1}</span>`);
      } else if (clash >= 2 && cb) { cb.textContent = `bye ${r.p.bye} ×${clash + 1}`; }
      else if (cb) { cb.remove(); }
      const badge = who.querySelector('.tierEnd');
      if (r.lastOfTier && !badge) {
        who.insertAdjacentHTML('beforeend',
          `<span class="tierEnd" data-tip="cliff">last ${r.p.pos}${r.tier}</span>`);
      } else if (r.lastOfTier && badge) {
        badge.textContent = `last ${r.p.pos}${r.tier}`;
      } else if (badge) { badge.remove(); }
      const [sb, gb, mb] = el.querySelectorAll('.acts button');
      const mark = starMark(r);
      if (sb.textContent !== mark) {
        sb.textContent = mark;
        sb.className = `starBtn ${r.star ? 'on' : ''}${r.fade ? ' off' : ''}`;
      }
      if (gb.getAttribute('aria-pressed') !== String(d)) gb.setAttribute('aria-pressed', String(d));
      if (mb.getAttribute('aria-pressed') !== String(m)) mb.setAttribute('aria-pressed', String(m));
    }
    const cls = `row player${d ? ' drafted' : ''}${m ? ' mine' : ''}`
      + `${r.lastOfTier && !d ? ' cliff' : ''}${r.star ? ' starred' : ''}${r.fade ? ' faded' : ''}`;
    if (el.className !== cls) el.className = cls;
    keep.add(r.p.id);
    frag.appendChild(el);          // appendChild MOVES an existing node, it does not clone
    if (open === r.p.id) {
      const det = document.createElement('div');
      det.innerHTML = detail(r);
      frag.appendChild(det.firstElementChild);
    }
  }
  for (const [id, el] of rowEls) if (!keep.has(id)) { el.remove(); rowEls.delete(id); }
  if (rows.length < board.rows.length) {
    const more = document.createElement('div');
    more.className = 'more';
    more.innerHTML = `<button id="more">Show ${Math.min(100, board.rows.length - limit)} more`
      + ` <span class="hint">(${limit} shown)</span></button>`;
    frag.appendChild(more);
  }
  host.replaceChildren(frag);
  $('#empty').hidden = rows.length > 0;
}

const posTag = (p) => `<span class="pos ${POSCOL[p] || ''}">${p}</span>`;

function detail(r) {
  const bars = data.components.map((c) => {
    const v = r.scores[c.key];
    if (v == null) return '';
    return `<span class="bar" data-tip="${c.key}" tabindex="0"><span>${c.label}</span>`
      + `<i><b style="width:${Math.max(2, Math.round(v))}%"></b></i><u>${Math.round(v)}</u></span>`;
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
  const [call, why] = callFor(r);
  const drafted = new Set(picks().drafted);
  const wait = waitAdvice(r, drafted);
  return `<div class="detail">
${r.kind ? `<p class="kindLine"><em class="kind ${r.kind}">${KINDS[r.kind][0]}</em> ${KINDS[r.kind][1]}</p>` : ''}
<p class="call"><span class="callTag ${call.replace(/\s+/g, '')}" data-tip="call" tabindex="0">${call}</span> ${why}</p>
${wait ? `<p class="wait" data-tip="wait" tabindex="0">${wait}</p>` : ''}
<p class="verdict"><b>${riskOf(r)}.</b> ${verdict(r)}
${r.lastOfTier ? ` <b class="warn">He is the last ${r.p.pos} of his tier</b> — the next one down is a clear step worse.` : ''}</p>
<div class="bars">${bars}</div>
${statCards(r)}
<p class="facts">${facts.length ? `2025: <b>${facts.join('</b> · <b>')}</b>`
    : 'No 2025 data — rated off the projection.'}</p>
<p class="facts">Your grade <b>${r.rating.toFixed(0)}</b> ranks him <b>${r.posRated}</b> of ${r.posCount} ${r.p.pos}s.
Projected <b>${r.pts.toFixed(1)}</b> points, <b>${r.vor.toFixed(1)}</b> above a replacement ${r.p.pos} — which is why the board has him at <b>#${r.rank}</b> overall.</p>
</div>`;
}

// ---------------------------------------------------------------- my team
function renderRoster() {
  const lg = board.league;
  renderAdvice2();
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

// the same recommendation, on the tab where you are reviewing what you have
function renderAdvice2() {
  const host = $('#rosterAdvice');
  if (!host) return;
  const keep = $('#advice')?.innerHTML || '';
  host.innerHTML = keep || '<p class="hint">Set your draft slot on the Board tab and the '
    + 'recommendation for your next pick appears here too.</p>';
}


// ---------------------------------------------------------------- fit sliders
// Built once and then left alone. Rebuilding the markup on every input event is what made
// the old sliders stutter - the element you were dragging got replaced underneath your
// finger. Only the readout text changes as you drag.
let fitBuilt = '';

function fitWord(v) {
  const n = Math.abs(v);
  if (n < 8) return 'no preference';
  return n < 35 ? 'slight' : n < 75 ? 'clear' : 'strong';
}

function renderFit() {
  const host = $('#fitAxes');
  if (!host) return;
  const league = data.leagues[st.league];
  const axes = FIT_AXES.filter((a) => !a.needsPenalties || hasPenalties(league));
  const sig = axes.map((a) => a.key).join(',');

  if (fitBuilt !== sig) {
    host.innerHTML = axes.map((a) => {
      // Say what the slider counts. The old page let you weight fifty stats; this one
      // shows you the handful that matter and lets you add any your league also scores.
      const counted = a.uses ? a.uses.map((u) => `<li>${u}</li>`).join('')
        : axisKeys(a.key, league, st)
          .map((k) => `<li>${keyName(k)} <em>${league.scoring[k] > 0 ? '+' : ''}`
            + `${league.scoring[k]}</em></li>`).join('');
      const spare = a.uses ? [] : axisSpare(a.key, league, st);
      return `<label class="knob fitAxis">
<span class="knobLabel"><span data-tip="${a.key}" tabindex="0">${a.label}</span>
<em id="fitOut_${a.key}">no preference</em></span>
<input id="fit_${a.key}" class="fitSlide" type="range" min="-100" max="100" step="5" value="0" />
<span class="fitEnds"><b>${a.left}</b><b>${a.right}</b></span>
<span class="hint">${a.hint}</span>
<details class="counts"${a.open ? '' : ''}>
<summary>What this counts</summary>
<ul class="countList">${counted || '<li class="soft">Nothing — this league scores none of it.</li>'}</ul>
${spare.length ? `<p class="hint">Your league also scores these. Tick any you think belong
here.</p><div class="spare">${spare.map((k) => `<label class="check tiny">
<input type="checkbox" data-fitkey="${a.key}|${k}" />
<span>${keyName(k)} <em>${league.scoring[k] > 0 ? '+' : ''}${league.scoring[k]}</em></span>
</label>`).join('')}</div>` : ''}
</details></label>`;
    }).join('');
    fitBuilt = sig;
    for (const a of axes) {
      const el = $(`#fit_${a.key}`);
      if (!el) continue;
      el.oninput = (e) => {
        st.fit = { ...(st.fit || {}), [a.key]: +e.target.value };
        const out = $(`#fitOut_${a.key}`);
        const v = +e.target.value;
        if (out) out.textContent = Math.abs(v) < 8 ? 'no preference'
          : `${fitWord(v)} — ${v < 0 ? a.left.toLowerCase() : a.right.toLowerCase()}`;
        save();
        scheduleRebuild();
      };
    }
    // No wireTips() here on purpose - it is delegated on document.body, so these get
    // tooltips for free. Calling it again would append a second tip element and a second
    // set of listeners on every render.
  }

  for (const box of host.querySelectorAll('[data-fitkey]')) {
    const [axis, field] = box.dataset.fitkey.split('|');
    box.checked = (((st.fitExtra || {})[axis]) || []).includes(field);
  }

  // keep the controls honest when settings arrive from a load, an import or a preset
  for (const a of axes) {
    const el = $(`#fit_${a.key}`);
    const v = (st.fit || {})[a.key] || 0;
    if (el && document.activeElement !== el) el.value = v;
    const out = $(`#fitOut_${a.key}`);
    if (out) {
      out.textContent = Math.abs(v) < 8 ? 'no preference'
        : `${fitWord(v)} — ${v < 0 ? a.left.toLowerCase() : a.right.toLowerCase()}`;
    }
  }

  // The preset chips live on this page and describe these sliders, so they have to
  // follow them. renderStrategies only ran from renderChrome, which a slider never
  // triggers - so moving one left the old preset still showing as active.
  renderStrategies();

  const on = axes.filter((a) => Math.abs((st.fit || {})[a.key] || 0) >= 8);
  const note = $('#fitNote');
  if (!note) return;
  if (!on.length) {
    note.innerHTML = 'Every slider is neutral, so the board is pure value right now. '
      + 'Move one and it will break ties in your favour.';
    return;
  }
  const moved = board.rows.slice(0, 60).filter((r) => Math.abs(r.fit - 50) > 12).length;
  note.innerHTML = `<b>${on.length}</b> preference${on.length > 1 ? 's' : ''} active. `
    + `${moved} of your top 60 lean far enough to be reordered — never by more than a few `
    + `places, because preferences break ties and nothing more.`
    + (hasPenalties(league) ? '' : ' This league fines nothing, so that slider is hidden.');
}

function renderRatings() {
  // The whole page is now the four sliders. There used to be a fifty-stat weight editor
  // here, ten collapsible components with a per-position slider each. It was deleted
  // because it weighted a rating that measured zero lift against the projections over
  // five seasons - so every hour spent in it changed nothing except the user's
  // confidence. What each slider counts is now stated plainly instead.
  renderFit();
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
    const list = await draftPicks(lg.draft_id, st.sleeperId, lg.rosterId);
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
    st.lastSync = Date.now();
    $('#syncClock').textContent = `last synced ${new Date().toLocaleTimeString()}`;
    msg('#syncMsg', `${list.length} picks made, ${added} new, ${pk.mine.length} yours.`
      + (skipped ? ` ${skipped} not in the player pool — deep bench, safe to ignore.` : ''), 'good');
  } catch (e) {
    msg('#syncMsg', e instanceof SleeperError ? e.message : `Sync failed: ${e.message}`, 'bad');
  }
}

async function doDryRun() {
  const name = st.sleeperUser || $('#user').value.trim();
  if (!name) return msg('#setupMsg', 'Type your Sleeper username first.', 'bad');
  $('#dryOut').innerHTML = '<p class="setupMsg">Reading that season…</p>';
  try {
    const known = new Set(data.players.map((p) => p.id));
    const res = await dryRun(name, $('#drySeason').value.trim(), known);
    if (!res.length) {
      $('#dryOut').innerHTML = '<p class="setupMsg bad">No drafts found for that season.</p>';
      return;
    }
    $('#dryOut').innerHTML = res.map((r) => `<div class="lgCard">
<b>${r.name}</b> — read ${r.total} picks, ${r.mine} of them yours
<span class="hint">${r.matched} matched a player on the board`
      + `${r.unknown ? `, ${r.unknown} ${r.unknown === 1 ? 'was' : 'were'} not in the pool (deep bench or since retired)` : ''}.
${r.total && r.mine ? 'The live sync would work on this draft.'
    : r.total ? 'Picks read, but none came back as yours — tell me and I will look at it.'
      : 'No picks in this draft.'}</span></div>`).join('');
  } catch (e) {
    $('#dryOut').innerHTML = `<p class="setupMsg bad">${e instanceof SleeperError ? e.message : e.message}</p>`;
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
    ['Games', a.gp, 'card:gp'], ['Carries', a.rush_att, 'card:rush_att'],
    ['Targets', a.rec_tgt, 'card:rec_tgt'], ['Catches', a.rec, 'card:rec'],
    ['Scrim. yds', a.rush_rec_yd, 'card:rush_rec_yd'], ['TDs', a.anytime_tds, 'card:anytime_tds'],
    ['RZ carries', a.rush_rz_att, 'card:rush_rz_att'], ['RZ targets', a.rec_rz_tgt, 'card:rec_rz_tgt'],
    ['Yds/carry', a.rush_ypa?.toFixed(1), 'card:rush_ypa'],
    ['Yds/target', a.rec_ypt?.toFixed(1), 'card:rec_ypt'],
    ['Pts/game', a.pts_ppr ? (a.pts_ppr / g).toFixed(1) : null, 'card:ppg'],
    ['2025 finish', a.pos_rank_ppr ? `${r.p.pos}${a.pos_rank_ppr}` : null, 'card:finish'],
  ].filter(([, v]) => v != null && v !== '');
  if (!cells.length) return '';
  return `<div class="statGrid">${cells
    .map(([l, v, tip]) => `<span class="stat" data-tip="${tip}" tabindex="0">`
      + `<span>${l}</span><b>${v}</b></span>`).join('')}</div>`;
}

function renderChrome() {
  $('#league').innerHTML = data.leagues
    .map((l, i) => `<option value="${i}"${i === st.league ? ' selected' : ''}>${l.name}</option>`).join('');
  $('#filters').innerHTML = ['ALL', ...data.positions]
    .map((p) => `<button data-f="${p}" aria-pressed="${p === filter}">${p === 'ALL' ? 'All' : p}</button>`).join('');
  $('#need').value = st.need;
  st.cols ||= { bye: true };
  const groups = GROUPS.map(([k, label]) => `<label class="chip">
<input type="checkbox" data-col="${k}"${st.cols[k] ? ' checked' : ''} />${label}</label>`);
  // only offered when you have picked one position, because that is when it means anything
  if (POS_COLS[filter]) {
    groups.push(`<label class="chip"><input type="checkbox" data-col="posdetail"${
      st.cols.posdetail ? ' checked' : ''} />${filter} detail</label>`);
  }
  groups.push(`<label class="chip mineOnly"><input type="checkbox" data-col="starsonly"${
    st.cols.starsonly ? ' checked' : ''} />My list only</label>`);
  $('#colToggles').innerHTML = groups.join('');
  $('#rookie').checked = st.rookie;
  $('#slot').value = st.slots?.[st.league] ?? data.leagues[st.league]?.slot ?? '';
  if ($('#rookie')) $('#rookie').checked = st.rookie;
  $('#hideGone').checked = !!st.hideGone;
  readouts();
}

function renderStrategies() {
  if (!$('#stratChips')) return;
  const on = activePreset(st);
  $('#stratChips').innerHTML = PRESETS
    .map((x) => `<button class="chipBtn" data-strat="${x.key}" aria-pressed="${x.key === on}">${x.name}</button>`)
    .join('');
  const cur = PRESETS.find((x) => x.key === on);
  $('#stratWhy').innerHTML = cur
    ? `<b>${cur.blurb}</b> ${cur.when}`
    : 'Custom — you have moved away from all of these. That is the point of them; they are starting points, not rules.';
}

// The position lean is a reading of the board, not a personality. It changes as players go.
function renderLean() {
  const box = $('#lean');
  if (!box) return;
  if (!clock?.target) {
    box.innerHTML = '<p class="hint">Set your draft slot above and the board will tell you '
      + 'whether a position is worth leaning into.</p>';
    return;
  }
  const drafted = new Set(picks().drafted);
  const have = {};
  for (const id of picks().mine) {
    const p = byId(id);
    if (p) have[p.pos] = (have[p.pos] || 0) + 1;
  }
  const costs = costOfWaiting(board.rows, clock, drafted, board.league, have, { need: st.need });
  const s = suggestLean(costs);
  const on = activeLean(st) || 'custom';
  if (!s) { box.innerHTML = ''; return; }
  const rec = LEANS.find((l) => l.key === s.key);
  const same = on === s.key;
  box.innerHTML = `<div class="leanHead">
<span class="leanTag">Board reading</span>
<b>${rec.name}</b><span class="hint">${s.why}</span></div>
<div class="leanBtns">
${LEANS.map((l) => `<button class="chipBtn" data-lean="${l.key}" aria-pressed="${on === l.key}"
 title="${l.blurb}">${l.name}${l.key === s.key ? ' ★' : ''}</button>`).join('')}
<span class="hint">${same ? 'Your board already matches the reading.'
    : `★ is what the board suggests right now. You are on ${LEANS.find((l) => l.key === on)?.name || 'a custom lean'}.`}</span>
</div>`;
}

function readouts() {
  if ($('#styleOut2')) $('#styleOut2').textContent = styleWord(st.style);
  if ($('#tiltOut2')) $('#tiltOut2').textContent = `${Math.round(st.tilt * 100)}%`;
  $('#needOut').textContent = st.need;
  $('#priority').textContent = priorityOrder(data, st).slice(0, 3)
    .map((c) => c.label.toLowerCase()).join(' › ');
  renderStrategies();
}

function show(v) {
  view = v;
  for (const s of ['board', 'roster', 'ratings', 'setup']) $(`#v-${s}`).hidden = s !== v;
  document.querySelectorAll('[data-v]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
  renderAll();
}

let tipEl = null;
function showTip(el) {
  const [what, how] = tipEl.data[el.dataset.tip] || [];
  if (!what) return;
  tipEl.innerHTML = `<b>${what}</b>${how ? `<span>${how}</span>` : ''}`;
  tipEl.hidden = false;
  const r = el.getBoundingClientRect();
  const w = Math.min(320, window.innerWidth - 20);
  tipEl.style.width = `${w}px`;
  const th = tipEl.offsetHeight;
  // above the element by default, below it when there is no room up there
  const top = r.top - th - 8 > 4 ? r.top - th - 8 : r.bottom + 8;
  tipEl.style.top = `${top}px`;
  tipEl.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
}
const hideTip = () => { if (tipEl) tipEl.hidden = true; };

function wireTips() {
  tipEl = document.createElement('div');
  tipEl.className = 'tip';
  tipEl.hidden = true;
  tipEl.data = { ...TIPS };
  // stat tips travel with the data, so a stat added later explains itself too
  for (const c of data.components) {
    for (const sm of c.subs) {
      if (sm.tip) tipEl.data[`sub:${sm.key}`] = [sm.label, `${sm.tip} ${PCT_NOTE}`];
    }
  }
  document.body.appendChild(tipEl);
  document.body.addEventListener('mouseover', (e) => {
    const t = e.target.closest('[data-tip]');
    if (t) showTip(t); else hideTip();
  });
  document.body.addEventListener('focusin', (e) => {
    const t = e.target.closest('[data-tip]');
    if (t) showTip(t); else hideTip();
  });
  window.addEventListener('scroll', hideTip, true);
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
  $('#league').onchange = (e) => {
    st.league = +e.target.value;
    open = null;
    save();
    renderChrome();   // slot, toggles and filters all belong to the league you just chose
    rebuild();
  };
  $('#search').oninput = (e) => { query = e.target.value; limit = 100; renderBoard(); };
  document.body.addEventListener('change', (e) => {
    if (!e.target.dataset.col) return;
    st.cols[e.target.dataset.col] = e.target.checked;
    save();
    if (e.target.dataset.col === 'starsonly') renderChrome();
    renderBoard();
  });
  $('#reset').onclick = () => {
    remember('cleared the draft');
    st.picks[st.league] = { drafted: [], mine: [] };
    save(); rebuild();
  };
  $('#undo').onclick = undo;
  // ctrl/cmd-Z anywhere that is not a text field
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z'
        && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) {
      e.preventDefault();
      undo();
    }
  });
  for (const [id, fn] of [['need', (v) => { st.need = +v; }],
  ]) {
    const el = $(`#${id}`);
    if (!el) continue;
    el.oninput = (e) => { fn(e.target.value); readouts(); save(); scheduleRebuild(); };
  }
  if ($('#rookie')) $('#rookie').onchange = (e) => { st.rookie = e.target.checked; save(); rebuild(); };
  $('#slot').oninput = (e) => {
    st.slots ||= {};
    st.slots[st.league] = +e.target.value || null;
    save(); rebuild();
  };
  if (window.ResizeObserver) new ResizeObserver(measure).observe(document.querySelector('.top'));
  window.addEventListener('resize', measure);
  // the save is debounced so a slider drag does not hammer the disk - which means a
  // change made in the last quarter second has to be flushed before the page goes away
  window.addEventListener('beforeunload', saveNow);
  window.addEventListener('pagehide', saveNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveNow();
  });
  $('#importL').onclick = doImport;
  $('#syncOnce').onclick = doSync;
  $('#syncAuto').onclick = toggleAuto;
  $('#dryBtn').onclick = doDryRun;
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
      Object.assign(st, { fit: o.fit || st.fit, fitExtra: o.fitExtra || {},
        need: o.need ?? st.need, rookie: o.rookie ?? st.rookie, posx: o.posx || st.posx });
      fitBuilt = '';
      save(); renderChrome(); rebuild();
    }).catch(() => alert('That file is not a preferences file.'));
  };
  $('#resetR').onclick = () => {
    const base = DEFAULT_SETTINGS(data);
    Object.assign(st, { fit: { ...base.fit }, fitExtra: {} });
    fitBuilt = '';
    save(); renderChrome(); rebuild();
  };

  // Ticking an extra scoring key into one of the two point-based sliders. This is all
  // that remains of stat customisation, and it is bounded by what your league actually
  // scores - there is nothing to offer that the league does not pay or fine.
  document.body.addEventListener('change', (e) => {
    const key = e.target.dataset.fitkey;
    if (!key) return;
    const [axis, field] = key.split('|');
    const cur = new Set(((st.fitExtra || {})[axis]) || []);
    if (e.target.checked) cur.add(field); else cur.delete(field);
    st.fitExtra = { ...(st.fitExtra || {}), [axis]: [...cur] };
    fitBuilt = '';
    save(); rebuild();
  });

  document.body.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.strat) {
      // a preset sets temperament only - never position values
      const preset = PRESETS.find((y) => y.key === b.dataset.strat).set;
      Object.assign(st, { ...preset, fit: { ...preset.fit } });
      fitBuilt = '';                 // the readouts must follow the preset
      save(); renderChrome(); rebuild();
    } else if (b.dataset.lean) {
      st.posx = { ...LEANS.find((l) => l.key === b.dataset.lean).posx };
      save(); rebuild();
    } else if (b.id === 'more') { limit += 100; renderBoard(); }
    else if (b.dataset.v) show(b.dataset.v);
    else if (b.dataset.f) {
      filter = b.dataset.f;
      limit = 100;
      renderChrome();
      document.querySelectorAll('[data-f]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.f === filter)));
      renderBoard();
    } else if (b.dataset.open) { open = open === b.dataset.open ? null : b.dataset.open; renderBoard(); }
    else if (b.dataset.star) {
      const id = b.dataset.star;
      st.stars ||= []; st.fades ||= [];
      const liked = st.stars.includes(id);
      const faded = st.fades.includes(id);
      st.stars = st.stars.filter((x) => x !== id);
      st.fades = st.fades.filter((x) => x !== id);
      if (!liked && !faded) st.stars.push(id);      // none -> like
      else if (liked) st.fades.push(id);            // like -> fade
      // fade -> none, so a third click clears it
      save(); rebuild();
    } else if (b.dataset.d) {
      remember(`${byId(b.dataset.d)?.name || 'a player'} off the board`);
      toggle('drafted', b.dataset.d);
    } else if (b.dataset.m) {
      remember(`${byId(b.dataset.m)?.name || 'a player'} to your team`);
      const on = toggle('mine', b.dataset.m);
      const dl = picks().drafted;
      if (on && !dl.includes(b.dataset.m)) dl.push(b.dataset.m);
      save(); rebuild();
    }
  });
}

function remember(label) {
  pickHistory.push({
    label,
    league: st.league,
    drafted: [...picks().drafted],
    mine: [...picks().mine],
  });
  if (pickHistory.length > 30) pickHistory.shift();
}

function undo() {
  const last = pickHistory.pop();
  if (!last) return;
  st.league = last.league;
  st.picks[last.league] = { drafted: last.drafted, mine: last.mine };
  save();
  renderChrome();
  rebuild();
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
// The data file needs the cache stamp as much as the code does. Without it a browser
// happily pairs brand new JavaScript with a players.json from last week - which is what
// made the quarterback columns come back blank: new code, old data, no passing stats.
fetch(`data/players.json?v=${BUILD}`)
  .then((r) => r.json())
  .then((d) => {
    data = d;
    load();
    syncCustoms();     // restore any stats the user added, before anything is scored
    wire();
    wireTips();
    renderChrome();
    rebuild();
    measure();         // the sticky column header sits under the real header height
    if (!st.imported?.length) {
      show('setup');
      msg('#setupMsg', 'Start here: put in your Sleeper username and import your leagues. '
        + 'Until then the board is scored for a standard 12-team PPR league.');
    }
  })
  .catch((e) => {
    document.querySelector('#v-board main').innerHTML =
      `<p class="empty">Could not load the player data.<br><small>${e}</small></p>`;
  });
