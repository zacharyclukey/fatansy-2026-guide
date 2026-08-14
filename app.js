import { DEFAULT_SETTINGS, buildBoard, priorityOrder, subScores, SAMPLE_LEAGUE, applyCustomStats, draftContext, availability, poolAround, costOfWaiting, STAR_BAND, FIT_AXES, hasPenalties, swingShare, riskPoints, axisKeys, axisSpare, keyName, inLeague, roundsOf, STREAMED } from './engine.js?v=202608140745';
import { simulate, pickTeam, roundOf, totalPicks, needsOf, roomWord, adpWord, vsAdp, isRanked, teamsOf, autoPick, capsOf } from './mock.js?v=202608140745';
import { importLeagues, draftPicks, dryRun, SleeperError } from './sleeper.js?v=202608140745';
import { TIPS, PCT_NOTE } from './tips.js?v=202608140745';
import { PRESETS, LEANS, activePreset, activeLean, suggestLean } from './strategies.js?v=202608140745';

const $ = (s) => document.querySelector(s);
const KEY = 'draft2026';
const BUILD = '202608140745';
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
  // Safe and Swing split the men who are priced about right, and between them they cover
  // every one of them - there is no third state where he is correctly priced and we say
  // nothing. The cut is where his two traits cross, both measured against his own
  // position: is he more touchdown-dependent than he is durable, or the other way round?
  safe: ['Safe', 'Priced about right, and his points come in more evenly than they do for most at his position.'],
  swing: ['Swing', 'Priced about right, but his points arrive in lumps — he leans on touchdowns more than he stays on the field.'],
  reach: ['Reach', 'Taking him here means passing men your board rates higher.'],
};
const FIXED = [
  ['Type', (r) => (r.kind
    ? `<em class="kind ${r.kind}">${KINDS[r.kind][0]}</em>`
    // The dash now means one thing and one thing only: his window has not opened yet and
    // he is too far off to even call it a reach. It used to mean that OR "he is correctly
    // priced but we have nothing to say about him", which is why it read as a bug.
    : `<em class="soft" title="Not in range yet — his window starts around pick ${r.worthFrom}">—</em>`), 58, ''],
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
  // Not a user setting - there is no control for it - so it always comes from the code.
  // Without this a profile saved before it was retuned keeps the old value for ever.
  //
  // The same argument now applies to three more. Safe-vs-Upside (`style`, `styleBudget`)
  // and Trust-my-ratings (`tilt`) were sliders on the old ratings page. That page is four
  // preferences now and neither slider is anywhere on it - but the engine still reads
  // both, so a profile saved back when they existed goes on shifting component weights and
  // inflating the rating for ever, with nothing on any screen that says so or can undo it.
  // A setting with no control is not a setting, it is a ghost. Pinning them to the code
  // default is the only state a user can actually see and reason about.
  for (const k of ['rookieMax', 'style', 'styleBudget', 'tilt']) st[k] = base[k];
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

// One phrase per component, keyed on the components that actually exist. It carried
// `floor` and `ceiling` long after both were deleted, and had no entry for `upside` - a
// real component worth 5% of the rating - so Upside could never be named as either a
// man's strength or his worry, however far out on it he was. Two dead keys, one live
// component silently invisible.
const NAMED = {
  volume: 'he gets the ball a lot', redzone: 'he works near the goal line',
  explosive: 'he hits big plays', efficiency: 'he does a lot with each touch',
  production: 'he scored well last year', role: 'his role is locked in',
  reliability: 'he stays on the field', upside: 'he is young with room to leap',
  situation: 'the offence around him is good',
};
const WORRY = {
  volume: 'the workload is thin', redzone: 'he does not see the goal line',
  explosive: 'there are no big plays', efficiency: 'he does little with each touch',
  production: 'last year was quiet', role: 'his role is not settled',
  reliability: 'he misses games', upside: 'he has probably shown you his best',
  situation: 'the offence around him is poor',
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

// What the app would do with this pick: which position costs most to wait on, and who to
// take there. Pulled out of the panel so that when the app drafts for you it follows its
// OWN advice rather than a second opinion written next to it - which also means every
// practice draft is a test of the thing you will actually lean on come draft night.
function recommendation(drafted, have) {
  if (!clock?.target) return null;
  const ranked = costOfWaiting(board.rows, clock, drafted, board.league, have, { need: st.need })
    .filter((x) => !['K', 'DEF'].includes(x.pos) || x.shortfall > 0);
  if (!ranked.length) return null;

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
  return { ranked, top, near };
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
  // Two different silences, and they were saying the same thing. No slot means we cannot
  // help yet; no target with a slot set means the draft is over, and telling someone who
  // has just finished a draft to enter their draft slot reads as a bug.
  if (!clock) {
    box.innerHTML = '<p class="hint">Add your draft slot above and this will tell you '
      + 'what to do with each pick.</p>';
    return;
  }
  if (!clock.target) {
    box.innerHTML = '<p class="hint">Every pick is in. Your team is on the '
      + '<b>My team</b> tab.</p>';
    return;
  }
  const rec = recommendation(drafted, have);
  if (!rec) { box.innerHTML = ''; return; }
  const { ranked, top, near } = rec;
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

// ---------------------------------------------------------------- practice draft
// The simulator does not have its own board, its own clock or its own idea of whose turn
// it is. It writes into exactly the same drafted/mine lists the live draft writes into, so
// every part of the app - the Type column, cost of waiting, the roster page, undo - carries
// on working without knowing a mock is happening at all. The log is the source of truth
// and the two lists are rebuilt from it, which is why they cannot drift apart.
const mock = () => (st.mock && st.mock.league === st.league ? st.mock : null);

function syncMockPicks() {
  const m = mock();
  if (!m) return;
  st.picks[st.league] = {
    drafted: m.log.map((x) => x.id),
    mine: m.log.filter((x) => x.team === m.slot).map((x) => x.id),
  };
}

function advanceMock() {
  const m = mock();
  if (!m || m.done) return;
  const lg = data.leagues[st.league];
  const pool = data.players.filter((p) => inLeague(p, lg));
  const res = simulate({ players: pool, league: lg, slot: m.slot, disc: m.disc,
    seed: m.seed, log: m.log });
  m.done = res.done;
  syncMockPicks();
}

// A practice draft clears the board it runs on. If there is anything on it - and on draft
// night there will be - that has to be an explicit second press, not a surprise.
let mockArmed = false;

function startMock() {
  const lg = data.leagues[st.league];
  if (!mock() && picks().drafted.length && !mockArmed) {
    mockArmed = true;
    msg('#mockMsg', `Careful — ${picks().drafted.length} players are already ticked off on `
      + `${lg.name}. A practice draft clears them. Press start again to go ahead.`, 'bad');
    return;
  }
  mockArmed = false;
  msg('#mockMsg', '');
  const slot = Math.max(1, Math.min(teamsOf(lg), +($('#mockSlot')?.value) || 1));
  remember('starting a practice draft');
  st.slots ||= {};
  st.slots[st.league] = slot;          // one slot, shared with the real clock
  st.mock = { league: st.league, slot, disc: +($('#disc')?.value ?? 40),
    seed: Math.floor(Math.random() * 1e6) + 1, log: [], done: false };
  st.picks[st.league] = { drafted: [], mine: [] };
  lastCols = '';                       // the row buttons change wording during a mock
  advanceMock();
  save();
  renderChrome();
  show('board');
  // show() renders with whatever the last rebuild left behind, and that was computed
  // before the room made the picks ahead of yours - so the clock, the Type column and the
  // recommendation would all be a draft behind until you made your first pick.
  rebuild();
}

function endMock(keep) {
  if (!st.mock) return;
  st.mock = null;
  if (!keep) st.picks[st.league] = { drafted: [], mine: [] };
  lastCols = '';
  save();
  renderChrome();
  rebuild();
}

// A pick made by the person, from the real board. Everything else follows from it.
function mockTake(id, by) {
  const m = mock();
  if (!m || m.done) return false;
  const lg = data.leagues[st.league];
  const n = m.log.length + 1;
  if (pickTeam(n, teamsOf(lg)) !== m.slot) return false;
  const p = byId(id);
  if (!p || m.log.some((x) => x.id === id)) return false;
  if (by !== 'app') remember(`${p.name} in the practice draft`);
  m.log.push({ n, team: m.slot, id, pos: p.pos, adp: p.adp ?? null, by: by || 'you' });
  advanceMock();
  save();
  rebuild();
  return true;
}

// Let the app pick for you - one pick, or all the way to the end.
//
// It does exactly what the recommendation panel tells you to do, pick by pick: the
// position that costs most to wait on, the man it names there, your stars and fades
// respected. So a practice draft is not just practice for you, it is a full run of the
// advice you will be following on the night - and the report says which picks were yours.
function autoDraft(all) {
  const m = mock();
  if (!m || m.done) return;
  const lg = data.leagues[st.league];
  const caps = capsOf(lg);
  const rounds = roundsOf(lg);
  let guard = 0;
  do {
    advanceMock();                       // the room, up to your turn or to the end
    if (m.done) break;
    rescore();                           // your need bonus has moved since the last pick
    tickClock();                         // and so has the clock the recommendation needs
    const roster = picks().mine.map((id) => byId(id)).filter(Boolean);
    const have = {};
    for (const x of roster) have[x.pos] = (have[x.pos] || 0) + 1;
    const drafted = new Set(picks().drafted);
    const rec = recommendation(drafted, have);
    const p = autoPick(board.rows, drafted, roster, lg, rounds - roster.length, caps,
      rec ? { id: rec.top.best.p.id, pos: rec.top.pos } : null);
    if (!p) break;
    m.log.push({ n: m.log.length + 1, team: m.slot, id: p.id, pos: p.pos,
      adp: p.adp ?? null, by: 'app' });
    syncMockPicks();
    guard += 1;
  } while (all && !m.done && guard < rounds + 2);
  advanceMock();
  save();
  rebuild();
}

// Start one and play the whole thing through in one press. The fastest way to ask "what
// does this ratings page actually build?" - and to ask it again from a different slot.
function simulateAll() {
  startMock();
  if (mock()) { autoDraft(true); show('mock'); }
}

// The banner across the top of the board while a mock is running. It has one job: someone
// who has never done this should be able to read it and know what to do next.
function renderMockBar() {
  const bar = $('#mockBar');
  if (!bar) return;
  const m = mock();
  document.body.classList.toggle('mocking', !!m);
  bar.hidden = !m;
  if (!m) return;
  const lg = board.league;
  const total = totalPicks(lg);
  const n = m.log.length + 1;

  if (m.done) {
    bar.innerHTML = `<span class="mockTag done">Practice draft finished</span>
<b>All ${total} picks are in.</b>
<span class="hint">Your team is on the Practice draft tab.</span>
<button data-v="mock" class="chipBtn">See how you did</button>`;
    return;
  }

  // what went while it was not your turn - the thing you would have watched happen
  const mineAt = [...m.log].reverse().find((x) => x.team === m.slot);
  const since = m.log.filter((x) => x.n > (mineAt?.n ?? 0));
  const names = since.slice(0, 4).map((x) => byId(x.id)?.name).filter(Boolean);
  bar.innerHTML = `<span class="mockTag">Practice</span>
<b>Round ${roundOf(n, teamsOf(lg))}, pick ${n} of ${total}.</b>
<b class="good">You are on the clock</b> — press <b>Pick</b> on the row you want.
${since.length ? `<span class="hint">${since.length} went since your last pick${
  names.length ? `: ${names.join(', ')}${since.length > names.length ? '…' : ''}` : ''}</span>` : ''}
<button id="mockAuto" class="chipBtn" title="Do what the recommendation says">Pick for me</button>
<button id="mockQuit" class="chipBtn">End</button>`;
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

// Score the board without drawing anything. Split out because the app drafting for you
// needs a fresh board between every one of your picks - the need bonus depends on what you
// already have - and re-rendering fifteen times to get there would be absurd.
function rescore() {
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
}

function rebuild() {
  rescore();
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
  if (view === 'board') { renderMockBar(); renderBoard(); renderAdvice(); renderLean(); renderKeys(); }
  if (view === 'roster') renderRoster();
  if (view === 'mock') renderMock();
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
${mock() ? '' : `<button data-d="${r.p.id}" aria-pressed="${d}">Gone</button>`}
<button data-m="${r.p.id}" aria-pressed="${m}">${mock() ? 'Pick' : 'Mine'}</button></span>`;
}

// Everything the board would show, before the display cut-off: the position filter, the
// search box, hide-drafted and my-list-only, in that order. Pulled out of renderBoard so
// that saving the board to a file cannot drift away from what is on the screen.
function filteredRows() {
  const q = query.trim().toLowerCase();
  const drafted = new Set(picks().drafted);
  const mine = new Set(picks().mine);
  return board.rows.filter((r) => (filter === 'ALL' || r.p.pos === filter)
    && (!st.hideGone || !drafted.has(r.p.id) || mine.has(r.p.id))
    && (!st.cols?.starsonly || r.star || r.fade)
    && (!q || r.p.name.toLowerCase().includes(q) || r.p.team?.toLowerCase() === q));
}

function renderBoard() {
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

  const all = filteredRows();

  // Late in a draft the entire top of the board is gone, and with "hide drafted" off the
  // first hundred rows can be a hundred players somebody else already owns - a screen with
  // nothing on it you could actually take. The practice draft walked straight into this in
  // round 13 and could not make a pick. So the cut extends until there are ten players
  // still available, however far down that is.
  let cut = 0;
  let want = 10;
  while (cut < all.length && want > 0) {
    if (!drafted.has(all[cut].p.id)) want -= 1;
    cut += 1;
  }
  cut = Math.max(limit, cut);
  const rows = all.slice(0, cut);

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
      // During a practice draft there is no Gone button, so this cannot assume three.
      const acts = el.querySelectorAll('.acts button');
      const sb = acts[0];
      const gb = el.querySelector('.acts [data-d]');
      const mb = el.querySelector('.acts [data-m]');
      const mark = starMark(r);
      if (sb.textContent !== mark) {
        sb.textContent = mark;
        sb.className = `starBtn ${r.star ? 'on' : ''}${r.fade ? ' off' : ''}`;
      }
      if (gb && gb.getAttribute('aria-pressed') !== String(d)) gb.setAttribute('aria-pressed', String(d));
      if (mb && mb.getAttribute('aria-pressed') !== String(m)) mb.setAttribute('aria-pressed', String(m));
    }
    // The rule under a tier cliff is drawn ONLY in a single-position view.
    //
    // A cliff is a fact about one position: "he is the last running back before the drop".
    // A horizontal rule, though, is a statement about the two rows it sits between - and
    // on the full board those two rows are almost never the same position. Counted on the
    // real pool: of the 23 cliffs in the top 100, 21 had a different position on the next
    // row, so the line was drawn between, say, the last RB4 and a receiver, announcing a
    // step down that does not exist between those two men. That is also why lines kept
    // appearing mid-run of identical Type labels - it was never tracking Type, and
    // markTiers is not firing too often (a tier every 6 to 12 players at each position).
    // Filter to one position and every rule lands between two players it actually
    // describes. The "last RB4" badge carries the same fact on the full board, correctly
    // attached to the one player it is true of.
    const rule = r.lastOfTier && !d && filter !== 'ALL';
    const cls = `row player${d ? ' drafted' : ''}${m ? ' mine' : ''}`
      + `${rule ? ' cliff' : ''}${r.star ? ' starred' : ''}${r.fade ? ' faded' : ''}`;
    if (el.className !== cls) el.className = cls;
    keep.add(r.p.id);
    frag.appendChild(el);          // appendChild MOVES an existing node, it does not clone
    if (open === r.p.id) {
      // Anything thrown in here strands the board. appendChild above MOVED every row so
      // far out of the live DOM and into this fragment, so a throw before the fragment is
      // reattached leaves them detached - which is exactly what "I clicked a name and he
      // and everyone above him disappeared" was. One missing import did it. The panel is
      // worth less than the board, so if it cannot be built, it is skipped.
      try {
        const det = document.createElement('div');
        det.innerHTML = detail(r);
        if (det.firstElementChild) frag.appendChild(det.firstElementChild);
      } catch (err) {
        console.error('detail panel failed', err);
        open = null;
      }
    }
  }
  for (const [id, el] of rowEls) if (!keep.has(id)) { el.remove(); rowEls.delete(id); }
  if (rows.length < all.length) {
    const more = document.createElement('div');
    more.className = 'more';
    more.innerHTML = `<button id="more">Show ${Math.min(100, all.length - rows.length)} more`
      + ` <span class="hint">(${rows.length} shown)</span></button>`;
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
<p class="facts">${r.rated
    ? `Your grade <b>${r.rating.toFixed(0)}</b> ranks him <b>${r.posRated}</b> of ${r.posCount} ${r.p.pos}s.`
    : `No grade — there are no ${r.p.pos} stats worth rating, so this is pure value.`}
Projected <b>${r.pts.toFixed(1)}</b> points, <b>${r.vor.toFixed(1)}</b> above a replacement ${r.p.pos} — which is why the board has him at <b>#${r.rank}</b> overall.
${STREAMED.includes(r.p.pos) ? `<br />Everyone streams this position off waivers, so “replacement”
here means a good one you could pick up in-season, not the last one drafted. That is why the
board takes ${r.p.pos}s later than the room does.` : ''}</p>
</div>`;
}

// ---------------------------------------------------------------- my team
// Who starts, who sits, and which of them fills the flex. Pulled out of the roster page so
// the practice draft can show the same lineup at the end of a mock without a second, and
// eventually different, copy of the rules.
function lineupOf(mine, lg) {
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
    return { r, n, role, pick, vsAdp: r.adpRank - pick };
  });
  return cards;
}

const lineupTable = (cards) => (cards.length ? `<div class="board">
<div class="row head lineup"><span>Slot</span><span>Player</span><span>Bye</span><span>Risk</span><span>Role</span></div>
${cards.map(({ r, n, role }) => `<div class="row lineup${role === 'Bench' ? ' drafted' : ''}">
<span class="rk">${r.p.pos}${n}</span>
<span class="who">${posTag(r.p.pos)}<span class="nm">${r.p.name} <span class="tm">${r.p.team || ''}</span></span></span>
<span class="num">${r.p.bye || '—'}</span>
<span class="risk">${riskOf(r)}</span>
<span class="role ${role}">${role}</span></div>`).join('')}</div>`
  : '<p class="empty">Tick <b>Mine</b> on the board and your team appears here.</p>');

// bye coverage - starters and flex only, a bench player costs you nothing
function byesHTML(cards) {
  const byes = {};
  for (const c of cards) {
    if (c.role === 'Bench' || !c.r.p.bye) continue;
    byes[c.r.p.bye] = (byes[c.r.p.bye] || 0) + 1;
  }
  const weeks = Object.keys(byes).map(Number).sort((a, b) => a - b);
  const worst = Math.max(0, ...Object.values(byes));
  return weeks.length
    ? weeks.map((w) => `<span class="bye${byes[w] >= 3 ? ' hot' : ''}"><b>${w}</b>${byes[w]} out</span>`).join('')
      + `<p class="facts">${worst >= 3
        ? `Week ${weeks.find((w) => byes[w] === worst)} costs you ${worst} starters. Spread the byes or plan a waiver week.`
        : 'No week costs you more than two starters.'}</p>`
    : '<p class="facts">Nothing drafted yet.</p>';
}

function renderRoster() {
  const lg = board.league;
  renderAdvice2();
  const cards = lineupOf(picks().mine, lg);

  $('#lineup').innerHTML = lineupTable(cards);
  $('#byes').innerHTML = byesHTML(cards);

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

// ---------------------------------------------------------------- save and print
// Three ways to take this off the screen. Not to be confused with "Export my preferences"
// on the Ratings tab, which saves four slider positions and no players at all.
//
// All three go through one helper and no library: a Blob, an object URL, a link with a
// download attribute. That is the whole mechanism, and it keeps this a no-build site.
function saveFile(name, type, text) {
  const a = document.createElement('a');
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.click();
  // the blob is held in memory until this runs; the click has to have happened first
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// Excel decides the encoding from the first bytes and guesses wrong without this, which
// turns every accented name into mojibake.
const BOM = '﻿';
const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (rows) => BOM + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

// The column renderers return HTML because that is what the board wants. A spreadsheet
// wants the words inside it.
function plain(html) {
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

const stampFor = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '').slice(0, 40) || 'league';
const today = () => new Date().toISOString().slice(0, 10);

// 1. The board as it stands: same order, same filter, same columns switched on. Not cut
// at a hundred rows the way the screen is - on paper or in a spreadsheet there is no
// reason to hide the rest.
function boardCsv() {
  // Bye is always given its own column, so drop the copy the "Bye + value" group adds
  const cols = activeCols().filter(([n]) => n !== 'Bye');
  const drafted = new Set(picks().drafted);
  const mine = new Set(picks().mine);
  const head = ['#', 'Player', 'Team', 'Position', 'Bye', ...cols.map((c) => c[0]), 'Status'];
  const body = filteredRows().map((r) => [
    r.rank, r.p.name, r.p.team || '', r.p.pos, r.p.bye || '',
    ...cols.map((c) => plain(c[1](r))),
    mine.has(r.p.id) ? 'Yours' : drafted.has(r.p.id) ? 'Gone' : 'Available',
  ]);
  return csv([head, ...body]);
}

// 3. What you actually ended up with, and what it cost you against the going rate.
function teamCsv() {
  const lg = board.league;
  const cards = lineupOf(picks().mine, lg);
  const head = ['Your pick', 'Player', 'Team', 'Position', 'Bye', 'ADP',
    'The room had him at pick', 'Picks later than the room', 'Starting or bench',
    'How safe he looks'];
  const body = cards.map(({ r, role, pick, vsAdp }) => [
    pick || '', r.p.name, r.p.team || '', r.p.pos, r.p.bye || '',
    r.p.adp ? r.p.adp.toFixed(1) : '', r.adpRank, vsAdp, role, riskOf(r),
  ]);
  const rows = body.length ? [head, ...body]
    : [head, ['', 'Nothing drafted yet — tick "Mine" on the board as players go.']];

  const withPick = cards.filter((c) => c.pick);
  const avg = withPick.length
    ? withPick.reduce((a, c) => a + c.vsAdp, 0) / withPick.length : 0;
  const byes = {};
  for (const c of cards) {
    if (c.role !== 'Bench' && c.r.p.bye) byes[c.r.p.bye] = (byes[c.r.p.bye] || 0) + 1;
  }
  const worstBye = Object.entries(byes).sort((a, b) => b[1] - a[1])[0];
  rows.push([], ['Summary'],
    ['League', lg.name],
    ['Players drafted', cards.length],
    ['Average picks later than the room', avg.toFixed(1)],
    ['Bargains (8 or more picks later than the room)',
      withPick.filter((c) => c.vsAdp >= 8).length],
    ['Worst bye week', worstBye ? `Week ${worstBye[0]} — ${worstBye[1]} starters off` : '—'],
    ['Saved', today()]);
  return csv(rows);
}

// 2. One sheet of paper. This is the version that gets used when the laptop dies, and it
// is the version his fiancee reads, so it carries five things and no jargon: how good we
// think he is, who he is, who he plays for, when his week off is, and where everyone else
// is taking him. No 2025 box-score numbers - they were measured and they predict nothing,
// so printing them would only invite an argument nobody can win.
const CHEAT_POS = [['QB', 'Quarterbacks'], ['RB', 'Running backs'],
  ['WR', 'Wide receivers'], ['TE', 'Tight ends']];
const CHEAT_N = 14;
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function cheatSheetHtml() {
  const lg = board.league;
  const block = ([pos, label]) => {
    const list = board.rows.filter((r) => r.p.pos === pos).slice(0, CHEAT_N);
    const body = list.map((r, i) => `<tr><td class="box"></td><td class="n">${r.rank}</td>
<td class="nm">${esc(r.p.name)}</td><td class="tm">${esc(r.p.team || '')}</td>
<td class="n">${r.p.bye || '-'}</td><td class="n">${r.p.adp ? Math.round(r.p.adp) : '-'}</td></tr>${
  r.lastOfTier && i < list.length - 1
    ? '<tr class="brk"><td></td><td colspan="5">big drop after here</td></tr>' : ''}`).join('');
    return `<section><h2>${label}</h2><table>
<tr class="hd"><th></th><th>#</th><th>Player</th><th>Tm</th><th>Bye</th><th>ADP</th></tr>
${body}</table></section>`;
  };
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>2026 draft cheat sheet</title>
<style>
  /* Printer's default paper, small margins, nothing to swallow ink. */
  @page { size: portrait; margin: 10mm; }
  * { box-sizing: border-box; }
  body { font: 9pt/1.25 "Segoe UI", -apple-system, Arial, sans-serif;
    color: #000; background: #fff; margin: 0; padding: 10mm; }
  h1 { font-size: 15pt; margin: 0 0 1mm; }
  .sub { font-size: 8pt; color: #444; margin: 0 0 2mm; }
  .how { font-size: 7.8pt; margin: 0 0 3mm; padding-bottom: 2mm;
    border-bottom: 1px solid #000; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5mm; }
  h2 { font-size: 9.5pt; margin: 0 0 1mm; border-bottom: 1.5pt solid #000;
    padding-bottom: .6mm; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: .5mm 1mm; text-align: left; vertical-align: baseline; }
  .hd th { font-size: 6.6pt; text-transform: uppercase; letter-spacing: .04em;
    color: #444; font-weight: 600; border-bottom: .5pt solid #999; }
  .n { text-align: right; font-variant-numeric: tabular-nums; }
  /* Four columns on portrait paper is about 44mm each, and "Christian McCaffrey" does
     not fit in that. Wrapping to a second line is ugly; cutting his name off is worse,
     and there is plenty of spare height on the page. */
  .nm { line-height: 1.15; }
  .tm { color: #444; }
  .box { width: 3.2mm; }
  .box::before { content: ""; display: block; width: 2.6mm; height: 2.6mm;
    border: .5pt solid #666; margin-top: .4mm; }
  tr:nth-child(even) td { background: #f2f2f2; }
  .brk td { font-size: 6.4pt; color: #000; letter-spacing: .03em;
    border-top: 1.2pt solid #000; padding-top: .4mm; background: #fff !important; }
  .foot { font-size: 7.4pt; color: #333; margin: 3mm 0 0; padding-top: 1.5mm;
    border-top: 1px solid #000; }
  .noprint { font-size: 9pt; background: #eee; border: 1px solid #999;
    padding: 3mm; margin: 0 0 4mm; }
  @media print { body { padding: 0; } .noprint { display: none; } }
</style></head><body>
<p class="noprint"><b>Press Ctrl+P (or Cmd+P on a Mac) to print this.</b> It is built to fit
  on one sheet of paper. This box does not print.</p>
<h1>2026 draft cheat sheet</h1>
<p class="sub">${esc(lg.name)} &middot; ${esc(today())}</p>
<p class="how"><b>#</b> is the order this guide would take players in, across all positions
  &mdash; a lower number means take him first. <b>ADP</b> is roughly the pick number where
  most people take him, so if he is still there well past his ADP you are getting him
  cheap. <b>Bye</b> is the week his team does not play. A thick line across a column means
  the next player down is a real step worse, so the man above the line is the last good one
  of that group. Tick the box when someone takes him.</p>
<div class="grid">${CHEAT_POS.map(block).join('')}</div>
<p class="foot">The order comes from this year's projections and the preferences you set on
  the Ratings tab. Nobody can tell you in advance who will actually score the most points,
  and this does not try to: it is a plan for the room, not a forecast of the season.</p>
</body></html>`;
}

// ---------------------------------------------------------------- practice results
// Written for someone who has never drafted before. Every number on this page is followed
// by a sentence saying what it means, and the whole thing leads with what happened rather
// than with a table.
function renderMock() {
  const lg = data.leagues[st.league];
  const m = mock();
  const disc = m ? m.disc : (st.disc ?? 40);
  if ($('#disc')) { $('#disc').value = disc; $('#disc').disabled = !!m; }
  if ($('#discOut')) $('#discOut').textContent = roomWord(disc);
  if ($('#mockSlot')) {
    $('#mockSlot').max = teamsOf(lg);
    $('#mockSlot').value = m ? m.slot : (st.slots?.[st.league] ?? 1);
    $('#mockSlot').disabled = !!m;
  }
  if ($('#mockSlotOut')) {
    const s = m ? m.slot : (st.slots?.[st.league] ?? 1);
    $('#mockSlotOut').textContent = `${s} of ${teamsOf(lg)}`;
  }
  if ($('#mockStart')) $('#mockStart').textContent = m ? 'Start a fresh one' : 'Start a practice draft';
  if ($('#mockAll')) $('#mockAll').textContent = m ? 'Draft a fresh one for me' : 'Draft it all for me';
  if ($('#mockEnd')) $('#mockEnd').hidden = !m;
  const out = $('#mockOut');
  if (!out) return;

  if (!m) {
    out.innerHTML = `<p class="facts">Nothing running. Pick a slot, choose how sensible the
other teams are, and press start — you will be sent to the board with the first pick that
is yours already on the clock. ${lg.sample ? '<b>You have not imported a league yet, so this '
      + 'uses a standard 12-team setup.</b>' : `Using your <b>${lg.name}</b> settings: `
      + `${teamsOf(lg)} teams, ${roundsOf(lg)} rounds.`}</p>`;
    return;
  }

  const total = totalPicks(lg);
  if (!m.done) {
    const n = m.log.length + 1;
    out.innerHTML = `<div class="mockRun"><b>In progress — round ${roundOf(n, teamsOf(lg))},
pick ${n} of ${total}.</b> It is your turn. Go to the board and press <b>Pick</b> on the
player you want.<div class="rowbtns"><button data-v="board" class="primary">Back to the board</button>
<button id="mockFinish">Finish the rest for me</button></div></div>`;
    return;
  }

  // ---- finished. What happened?
  const cards = lineupOf(picks().mine, lg);
  const roster = picks().mine.map((id) => byId(id)).filter(Boolean);
  const need = needsOf(roster, lg);
  const mineLog = m.log.filter((x) => x.team === m.slot);
  // Only players the market actually ranks inside this draft. The pool is 300 deep and a
  // fifteen-round draft is 180 picks, so several of everyone's last picks have an ADP past
  // the end of the draft - averaging those in produced "average vs ranking: -80", which is
  // arithmetic about the size of the pool rather than anything about the picks.
  const rated = mineLog.filter((x) => isRanked(x.adp, total));
  // Kickers and defences all go at the end at prices nobody has an opinion about, so
  // "your best bit of business was the Dallas defence" is noise. The headline is about
  // the picks that decided something.
  const called = rated.filter((x) => !['K', 'DEF'].includes(x.pos));
  const gaps = rated.map((x) => vsAdp(x.n, x.adp));
  const avg = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
  const best = [...called].sort((a, b) => (b.n - b.adp) - (a.n - a.adp))[0];
  const worst = [...called].sort((a, b) => (a.n - a.adp) - (b.n - b.adp))[0];
  const short = Object.entries(need.short).filter(([, v]) => v > 0)
    .map(([p, v]) => `${v} ${p}`);
  if (need.flex > 0) short.push(`${need.flex} flex`);
  // Who actually made these picks matters more than anything else on the page. A team the
  // app built is a picture of the ratings page; a team you built is a picture of you.
  const auto = mineLog.filter((x) => x.by === 'app').length;
  const whose = auto === mineLog.length
    ? 'Every pick was made by the app, following its own recommendation each time — so this '
      + 'is the team your ratings and preferences build if you do exactly as you are told.'
    : auto === 0 ? 'You made every pick yourself.'
      : `You made ${mineLog.length - auto} of these picks and the app made ${auto} by `
        + 'following its own recommendation.';

  const card = (label, val, note) => `<div class="card"><span class="cardV">${val}</span>
<span class="cardL">${label}</span><span class="hint">${note}</span></div>`;

  out.innerHTML = `<h2 class="h2">What happened</h2>
<p class="mockLede">You drafted from <b>slot ${m.slot} of ${teamsOf(lg)}</b> against a room that
${roomWord(m.disc)}. ${whose} ${short.length
    ? `<b class="bad">You finished without a full starting lineup — no ${short.join(', no ')}.</b>
That is the one mistake worth avoiding: an empty slot scores zero every week.`
    : '<b class="good">You filled every starting slot.</b>'}
${best && best.n - best.adp >= 6
    ? ` Your best bit of business was <b>${byId(best.id)?.name}</b>, who lasted
${Math.round(best.n - best.adp)} picks past his usual spot.` : ''}
${worst && worst.n - worst.adp <= -10
    ? ` You paid up for <b>${byId(worst.id)?.name}</b>, ${Math.round(-(worst.n - worst.adp))}
picks before the room normally takes him — fine if you meant it.` : ''}</p>

<div class="cards">${card('Average vs ranking', `${avg > 0 ? '+' : ''}${avg.toFixed(1)}`,
    `Above zero means players tended to fall to you. Counts the ${rated.length} of your `
    + `${mineLog.length} picks the room ranks inside a ${total}-pick draft.`)
+ card('Bargains', gaps.filter((g) => g >= 12).length, 'Taken 12+ picks past their usual spot.')
+ card('Reaches', gaps.filter((g) => g <= -12).length, 'Taken 12+ picks early.')
+ card('Starting slots', short.length ? `${need.total} empty` : 'Full', 'Empty slots score nothing.')}</div>

<h2 class="h2">Every pick you made</h2>
<div class="board mockPicks">
<div class="row head mockPick"><span>Rd</span><span>Pick</span><span>Player</span><span>Ranked</span><span>What it cost</span></div>
${mineLog.map((x) => {
    const p = byId(x.id);
    const g = isRanked(x.adp, total) ? vsAdp(x.n, x.adp) : null;
    return `<div class="row mockPick">
<span class="rk">${roundOf(x.n, teamsOf(lg))}</span>
<span class="num">${x.n}</span>
<span class="who">${posTag(p?.pos || '')}<span class="nm">${p?.name || x.id}
<span class="tm">${p?.team || ''}</span></span>${x.by === 'app' && auto < mineLog.length
      ? '<span class="autoMark" title="The app made this pick">auto</span>' : ''}</span>
<span class="num">${x.adp ? x.adp.toFixed(0) : '—'}</span>
<span class="cost ${g == null ? '' : g >= 4 ? 'up' : g <= -4 ? 'dn' : ''}">${adpWord(x.n, x.adp, total)}</span></div>`;
  }).join('')}</div>
<p class="hint">"Ranked" is where the whole fantasy world usually takes him. Later than that
means he fell to you; earlier means you wanted him more than everyone else did.</p>

<h2 class="h2">Your lineup</h2>
${lineupTable(cards)}
<h2 class="h2">Bye weeks</h2>
<div class="byes">${byesHTML(cards)}</div>
<p class="facts">Run it again from a different slot and see how different the same board
feels. Nothing you do here touches your real draft.</p>`;
}

// ---------------------------------------------------------------- ratings

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
  // The signature was the axis keys alone, which meant the panel only ever rebuilt when an
  // axis appeared or vanished. But "What this counts" prints your league's actual scoring
  // values, and two of Zach's three leagues fine mistakes while paying for different lumps
  // - so switching between them left the previous league's list on screen, telling you the
  // slider counted 40+ yard catches at +1 in a league that pays nothing for them. The
  // signature now covers everything the markup is built from.
  const sig = JSON.stringify(axes.map((a) => [a.key,
    a.uses ? null : axisKeys(a.key, league, st).map((k) => [k, league.scoring[k]]),
    a.uses ? null : axisSpare(a.key, league, st).map((k) => [k, league.scoring[k]])]));

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
    box.innerHTML = clock ? '' : '<p class="hint">Set your draft slot above and the board '
      + 'will tell you whether a position is worth leaning into.</p>';
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
  // #styleOut2 and #tiltOut2 were written to here for weeks after the elements they name
  // were deleted from index.html along with the rest of the ratings editor. Guarded, so
  // they never threw - which is exactly why nobody noticed.
  $('#needOut').textContent = st.need;
  $('#priority').textContent = priorityOrder(data, st).slice(0, 3)
    .map((c) => c.label.toLowerCase()).join(' › ');
  renderStrategies();
}

function show(v) {
  view = v;
  for (const s of ['board', 'roster', 'mock', 'ratings', 'setup']) $(`#v-${s}`).hidden = s !== v;
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

// ---------------------------------------------------------------- draft night, no mouse
// A name is called every thirty seconds or so. Between calls you have to find that man on
// a three-hundred-row board and tick him off, and then be ready for the next one. Doing
// that with a mouse is why people stop tracking somewhere in round four and the board
// quietly becomes a lie.
//
// So: type three letters of his name, press one key. The search box is already there and
// already filters the board, so nothing new has to be learned - the only addition is that
// Enter finishes the job and empties the box for the next name.
//
// The rule this is built on is that it must NEVER be a shortcut you have to know about.
// The line under the search box always names the player the next key press will hit and
// the key that will hit him, in words. Nobody has to remember anything, and nobody can
// tick off the wrong man without having read his name first.
function keyTarget() {
  const q = query.trim().toLowerCase();
  if (!q) return { q };
  const drafted = new Set(picks().drafted);
  const hits = board.rows.filter((r) => (filter === 'ALL' || r.p.pos === filter)
    && (r.p.name.toLowerCase().includes(q) || r.p.team?.toLowerCase() === q));
  // The first man matching who is still available. Somebody already off the board is
  // never the target - Enter must not be able to un-tick a pick by accident, and by the
  // middle of a draft half of any search is players who have gone.
  const free = hits.find((r) => !drafted.has(r.p.id));
  return { q, hits, r: free, allGone: hits.length > 0 && !free };
}

// What just happened, held on screen until the next keystroke so you get a confirmation
// rather than a box that empties itself and says nothing.
let keyEcho = '';

function renderKeys() {
  const box = $('#kbd');
  if (!box) return;
  const { q, hits, r, allGone } = keyTarget();
  const who = (x) => `<b>${x.p.name}</b> <span class="kbdPos">${x.p.pos}${x.p.team ? ` · ${x.p.team}` : ''}</span>`;
  if (keyEcho) { box.innerHTML = `<span class="kbdDone">${keyEcho}</span>`; return; }
  if (!q) {
    box.innerHTML = picks().drafted.length
      ? '<span class="kbdIdle">Type a name in the box above and press <kbd>Enter</kbd> to '
        + 'tick the next player off. No mouse needed.</span>'
      : '<span class="kbdIdle">On draft night: type a name above, press <kbd>Enter</kbd> when '
        + 'somebody else takes him, <kbd>Shift</kbd>+<kbd>Enter</kbd> when you take him.</span>';
    return;
  }
  if (!hits.length) { box.innerHTML = `<span class="kbdNone">Nobody on the board is called “${q}”.</span>`; return; }
  if (allGone) {
    box.innerHTML = `<span class="kbdNone">Everyone matching “${q}” is already off the board.</span>`;
    return;
  }
  box.innerHTML = mock()
    ? `<kbd>Enter</kbd> picks ${who(r)}`
    : `<kbd>Enter</kbd> — ${who(r)} goes off the board`
      + ` &nbsp;·&nbsp; <kbd>Shift</kbd>+<kbd>Enter</kbd> — he is yours`;
}

// One key press does the whole job: record him, empty the box, leave the cursor where it
// already is. Anything less and you are back to reaching for the mouse between picks.
function keyAct(mine) {
  const { r } = keyTarget();
  if (!r) return false;
  if (mock()) {
    // mockTake refuses when it is not your turn, so the box is only emptied and the pick
    // only claimed once it has actually been taken.
    if (!mockTake(r.p.id)) return false;
    keyEcho = `${r.p.name} — your pick.`;
    query = '';
    $('#search').value = '';
    renderKeys();
    return true;
  }
  remember(`${r.p.name} ${mine ? 'to your team' : 'off the board'}`);
  if (mine) {
    toggle('mine', r.p.id);
    const dl = picks().drafted;
    if (!dl.includes(r.p.id)) dl.push(r.p.id);
    keyEcho = `${r.p.name} added to your team.`;
    save();
  } else {
    toggle('drafted', r.p.id);
    keyEcho = `${r.p.name} ticked off. Press <kbd>Ctrl</kbd>+<kbd>Z</kbd> if that was wrong.`;
  }
  query = '';
  $('#search').value = '';
  rebuild();
  renderKeys();
  return true;
}

// ---------------------------------------------------------------- events
function wire() {
  $('#settingsBtn').onclick = (e) => {
    const p = $('#settings');
    p.hidden = !p.hidden;
    e.target.setAttribute('aria-expanded', String(!p.hidden));
  };
  $('#saveBtn').onclick = (e) => {
    const p = $('#savePanel');
    p.hidden = !p.hidden;
    e.target.setAttribute('aria-expanded', String(!p.hidden));
  };
  $('#saveBoard').onclick = () => {
    const what = filter === 'ALL' ? 'board' : `board-${filter.toLowerCase()}`;
    saveFile(`${what}-${stampFor(board.league.name)}-${today()}.csv`, 'text/csv', boardCsv());
  };
  $('#saveSheet').onclick = () => {
    saveFile(`cheat-sheet-${stampFor(board.league.name)}-${today()}.html`,
      'text/html', cheatSheetHtml());
  };
  $('#saveTeam').onclick = () => {
    saveFile(`my-team-${stampFor(board.league.name)}-${today()}.csv`, 'text/csv', teamCsv());
  };

  $('#league').onchange = (e) => {
    st.league = +e.target.value;
    open = null;
    save();
    renderChrome();   // slot, toggles and filters all belong to the league you just chose
    rebuild();
  };
  $('#search').oninput = (e) => {
    query = e.target.value;
    limit = 100;
    keyEcho = '';                 // a new keystroke clears the last confirmation
    renderBoard();
    renderKeys();
  };
  $('#search').onkeydown = (e) => {
    if (e.key === 'Escape') { e.target.value = ''; query = ''; keyEcho = ''; renderBoard(); renderKeys(); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    // Shift is "he is mine". Without it, somebody else took him - which is eleven picks
    // in every twelve, so the plain key is the common one.
    if (!keyAct(e.shiftKey)) renderKeys();
  };
  // A slash puts the cursor in the search box from anywhere on the board, so the whole
  // loop is: slash, three letters, Enter. Never while you are already typing somewhere.
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (view !== 'board') return;
    e.preventDefault();
    $('#search').focus();
    $('#search').select();
  });
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
    st.mock = st.mock?.league === st.league ? null : st.mock;
    lastCols = '';
    save(); renderChrome(); rebuild();
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
  // ---- practice draft
  if ($('#mockStart')) $('#mockStart').onclick = startMock;
  if ($('#mockAll')) $('#mockAll').onclick = simulateAll;
  if ($('#mockEnd')) $('#mockEnd').onclick = () => { endMock(false); renderMock(); };
  if ($('#disc')) {
    $('#disc').oninput = (e) => {
      st.disc = +e.target.value;
      $('#discOut').textContent = roomWord(st.disc);
      save();
    };
  }
  if ($('#mockSlot')) {
    $('#mockSlot').oninput = (e) => {
      const lg = data.leagues[st.league];
      const v = Math.max(1, Math.min(teamsOf(lg), +e.target.value || 1));
      $('#mockSlotOut').textContent = `${v} of ${teamsOf(lg)}`;
    };
  }

  $('#importL').onclick = doImport;
  $('#syncOnce').onclick = doSync;
  $('#syncAuto').onclick = toggleAuto;
  $('#dryBtn').onclick = doDryRun;
  $('#hideGone').onchange = (e) => { st.hideGone = e.target.checked; save(); renderBoard(); };

  // ratings profile as a file, so you and someone else can keep different ones.
  //
  // This wrote { comp, sub, style, tilt, need, rookie } - the knobs of the fifty-stat
  // editor - while the importer next to it read { fit, fitExtra, need, rookie, posx }.
  // Not one key overlapped except need and rookie, so "Export my preferences" saved a file
  // that did not contain a single one of the four sliders, and importing it silently reset
  // them all to neutral. Export now writes exactly what import reads, which is the only
  // arrangement that cannot drift apart again.
  $('#exportR').onclick = () => {
    const { fit, fitExtra, fitOn, need, rookie, posx, stars, fades } = st;
    const blob = new Blob([JSON.stringify({ kind: 'draft2026-ratings',
      fit, fitExtra, fitOn, need, rookie, posx, stars, fades }, null, 2)],
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
        fitOn: o.fitOn ?? st.fitOn,
        need: o.need ?? st.need, rookie: o.rookie ?? st.rookie, posx: o.posx || st.posx,
        // Your list of players travels with your preferences. It is the single most
        // laborious thing to rebuild by hand, and the whole reason two people in the same
        // house keep separate files.
        stars: o.stars || st.stars, fades: o.fades || st.fades });
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
    } else if (b.id === 'mockQuit') { endMock(false); }
    else if (b.id === 'mockAuto') { autoDraft(false); }
    else if (b.id === 'mockFinish') { autoDraft(true); show('mock'); }
    else if (b.id === 'more') { limit += 100; renderBoard(); }
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
      // In a practice draft this button IS the pick: it hands the choice to the simulator,
      // which records it and then runs every other team up to your next turn.
      if (mock()) { mockTake(b.dataset.m); return; }
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
    // A practice pick is really several picks - yours, then every team up to your next
    // turn. Snapshotting the log means undo rewinds the room's replies with it, which is
    // the only sensible reading of "take that pick back".
    mockSnap: st.mock ? { ...st.mock, log: [...st.mock.log] } : null,
  });
  if (pickHistory.length > 30) pickHistory.shift();
}

function undo() {
  const last = pickHistory.pop();
  if (!last) return;
  st.league = last.league;
  st.picks[last.league] = { drafted: last.drafted, mine: last.mine };
  if (last.mockSnap) st.mock = { ...last.mockSnap, log: [...last.mockSnap.log] };
  else if (st.mock?.league === last.league) st.mock = null;
  lastCols = '';
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
