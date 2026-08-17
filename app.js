import { DEFAULT_SETTINGS, buildBoard, priorityOrder, subScores, SAMPLE_LEAGUE, applyCustomStats, draftContext, availability, poolAround, planDraft, PLAN_HORIZON, STAR_BAND, FIT_AXES, hasPenalties, swingShare, riskPoints, axisKeys, ANCHOR_CASES, ANCHOR_DEFAULT, STEAL_DILUTION, anchorReach, axisSpare, keyName, inLeague, roundsOf, STREAMED, explain, pickShot, pickCost, marketNote, injuryGap, ownGames, FULL_GAMES, SLACK, REACH_RANGE, FIT_TAGS, DUR_ANCHORS, DUR_DEFAULT, durAnchor } from './engine.js?v=202608171500';
// adpWord is deliberately no longer imported. It reads a pick against ADP in plain words,
// which is exactly the judgement the cost view has stopped making - see costTable below.
// It survives in mock.js because it is still an honest description of what the ROOM did.
import { simulate, pickTeam, roundOf, totalPicks, needsOf, roomWord, vsAdp, isRanked, teamsOf, autoPick, capsOf } from './mock.js?v=202608171500';
import { importLeagues, draftPicks, dryRun, parseDraftId, followDraft, SleeperError } from './sleeper.js?v=202608171500';
import { TIPS, PCT_NOTE } from './tips.js?v=202608171500';
import { PRESETS, LEANS, activePreset, activeLean, suggestLean } from './strategies.js?v=202608171500';

const $ = (s) => document.querySelector(s);
const KEY = 'draft2026';
const BUILD = '202608171500';
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
// One place that asks the engine for words. Called per row for the tooltips, so it must
// never throw and never be expensive: the room's drafted list is only pulled in for the
// card, where naming who a Reach walks past is worth the extra work.
function expl(r, withRoom = false) {
  try {
    return explain(r, picks().drafted.length + 1, {
      st,
      league: board?.league,
      repl: board?.repl,
      rows: withRoom ? board?.rows : null,
      drafted: withRoom ? new Set(picks().drafted) : null,
    });
  } catch (err) {
    console.error('explanation failed', err);
    return null;
  }
}
// A tooltip is an attribute, so anything with a quote in it would end the attribute and
// silently swallow the rest of the row.
const tip = (s) => esc(s).replace(/"/g, '&quot;');

const FIXED = [
  // Every verdict now says why, on hover. The label on its own was the whole complaint:
  // it told you the answer and never the reasoning, which is fine if you wrote it and
  // useless if you did not.
  ['Type', (r) => {
    const e = expl(r);
    const t = e ? ` title="${tip(e.tipLabel)}"` : '';
    return r.kind
      ? `<em class="kind ${r.kind}"${t}>${KINDS[r.kind][0]}</em>`
      // The dash means one thing and one thing only: his window has not opened yet and he
      // is too far off to even call it a reach. It used to mean that OR "he is correctly
      // priced but we have nothing to say about him", which is why it read as a bug.
      : `<em class="soft"${t || ` title="Not in range yet — his window starts around pick ${r.worthFrom}"`}>—</em>`;
  }, 58, ''],
  // Not a grade. The span of picks where taking him costs you nothing, because everyone
  // inside it is a player you would be equally happy with.
  // Plain information, no colour. The judgement is in Type, which knows the clock.
  // Hovering it explains the RANGE, which is what the cell prints. It used to hover the
  // rank explanation - a sentence about projected points, attached to two pick numbers it
  // never mentioned - so the answer under the cursor was to a question nobody had asked
  // there. "Why is he this high" is still one hover away, on the Score column.
  ['Worth', (r) => {
    const e = expl(r);
    return `<em class="win"${e ? ` title="${tip(e.tipWorth)}"` : ''}>${r.openEnded ? `${r.worthFrom}+`
      : r.worthFrom === r.worthTo ? r.worthFrom
        : `${r.worthFrom}–${r.worthTo}`}</em>`;
  }, 66, 'wd'],
  ['ADP', (r) => (r.p.adp ? r.p.adp.toFixed(1) : '—'), 52, ''],
  // Points above a replacement starter, in projected points. Always on the board now,
  // because it is the unit every explanation on this site quotes - "your board had him 20
  // points higher" means twenty of THESE. With Score on 0-100 there would otherwise be no
  // column anywhere in the same currency as the prose.
  ['VOR', (r) => `<em title="${tip(TIPS.VOR)}">${r.vor >= 0 ? '+' : ''}${r.vor.toFixed(0)}</em>`,
    54, 'vr'],
  // Two decimals, because whole numbers tied men the board had already separated.
  ['Score', (r) => {
    const e = expl(r);
    return `<em${e ? ` title="${tip(e.tipRank)}"` : ''}>${r.score100.toFixed(2)}</em>`;
  }, 68, 'sc'],
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
  // The same argument now applies to two more. Safe-vs-Upside (`style`, `styleBudget`) was
  // a slider on the old ratings page. That page is four preferences now and the slider is
  // nowhere on it - but the engine still read it, so a profile saved back when it existed
  // went on shifting component weights for ever, with nothing on any screen that says so
  // or can undo it. A setting with no control is not a setting, it is a ghost. Pinning
  // them to the code default is the only state a user can actually see and reason about.
  for (const k of ['rookieMax', 'style', 'styleBudget']) st[k] = base[k];
  // `tilt` is not pinned, it is DELETED. It was the multiplier that let the 0-100 grade
  // move the score, and it no longer exists anywhere in the engine - the grade computes
  // and draws its bars and does not vote. Leaving the key on a saved profile would leave a
  // dead setting sitting in exported files looking like it still meant something.
  delete st.tilt;
  // The position-lean buttons are gone from the board - the reading tells you what the
  // evidence says and no longer offers a button to overrule it. That leaves `posx` with no
  // control anywhere, and a saved multiplier would go on quietly tilting whole positions
  // for ever with nothing on screen to show it or undo it. Same argument as the sliders
  // above: a setting with no control is a ghost.
  st.posx = {};
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
    if (n >= 65) return `<b class="good">Probably, ${v}%</b> — he should come back to you at ${at}.${similar}`;
    if (n >= 35) return `<b class="warn">Coin flip, ${v}%</b> — he may or may not last to ${at}.${similar || alone}`;
    return `<b class="bad">Probably not, ${v}%</b> — he is unlikely to last to ${at}.${similar || alone}`;
  }
  if (n >= 65) return `<b class="good">Probably, ${v}%</b> — he should still be there at ${at}.${similar}`;
  if (n >= 35) return `<b class="warn">Coin flip, ${v}%</b> — he may or may not last to ${at}.${similar || alone}`;
  return `<b class="bad">Probably not, ${v}%</b> — he is unlikely to last to ${at}.${similar || alone}`;
}

function verdict(r) {
  const ranked = Object.entries(r.scores)
    .filter(([k, v]) => v != null && NAMED[k]).sort((a, b) => b[1] - a[1]);
  const [bk, bv] = ranked[0];
  const [wk, wv] = ranked[ranked.length - 1];
  return (bv >= 60 ? `The case for him: ${NAMED[bk]} (${Math.round(bv)}).` : '')
    + (wv < 45 ? ` The worry: ${WORRY[wk]} (${Math.round(wv)}).` : '');
}

// How often this man would actually be in your lineup, and why - in the plainest words
// there are, because this panel is read by someone who does not follow football.
//
// It is the one number on the card that depends on the team YOU have already got, and it
// is the answer to "why is the app telling me to take a backup running back instead of
// this tight end who is projected for more points". Silent for anyone who would walk
// straight into your starting lineup, because for him there is nothing to explain.
function benchLine(r) {
  if (!r || r.lineup == null || !(r.pts > 0)) return '';
  const share = r.lineup / r.pts;
  const have = picks().mine.map((id) => byId(id)?.pos).filter((q) => q === r.p.pos).length;
  const weeks = Math.round(Math.min(1, share) * 17);
  const hc = r.hc;

  // The insurance case, in the plainest words there are. Both branches state the same three
  // things in the same order - who he is behind, how long that job is expected to be open
  // and why, and what the cover is worth in points - because those are the only three facts
  // in it and burying any of them in prose is how this ended up a word nobody understood.
  //
  // The middle fact is the one that earns its place. A handcuff is not worth a fixed amount;
  // he is worth exactly as much time as you assume the man ahead of him misses, which is a
  // number YOU set on the Draft-day settings panel. Saying so on the card is what stops this
  // reading as a forecast.
  if (hc) {
    const surname = esc(hc.leadName.split(' ').pop());
    const anchor = durAnchor(st.durAnchor || DUR_DEFAULT);
    const gain = Math.round(r.hcGain || 0);
    // The setting is quoted in brackets rather than folded into the sentence, because the
    // four stops are noun phrases of very different shapes ("Nobody gets hurt", "As much
    // time as he missed last year") and every attempt to read one of them mid-clause came
    // out ungrammatical for at least one of the four.
    const dial = `Your <b>Time missed</b> setting (<b>${esc(anchor.short)}</b>)`;
    const open = hc.weeks > 0
      ? `${dial} puts ${esc(hc.leadName)} at <b>${hc.leadGames.toFixed(0)} games of
${FULL_GAMES}</b> — so the job is open about <b>${hc.weeks} week${hc.weeks === 1 ? '' : 's'}</b>
of the season.`
      : `${dial} has ${surname} playing all ${FULL_GAMES} games — so on your own settings this
job never opens and this man is worth nothing to you. Change that assumption and he starts to
matter.`;

    if (r.mineLead) {
      return `<p class="dSub"><b>${esc(hc.leadName)} is already on your team, and this is the
man who takes over his job if he cannot play.</b> ${open}</p>
${gain > 0 ? `<p class="dSub">Taking him is <b>insurance on a player you already own</b>. In
the weeks ${surname} is out you would otherwise be starting whoever is left on the waiver
wire; having this man instead is worth about <b>${gain} points</b> across the season. That is
why he is this high — it is not a claim that he is good.</p>` : ''}
<p class="dNote">This is the one pick that pays for the thing the data is surest about:
projections are accurate per game and too high per season, and the whole difference is
games missed by the man in front.</p>`;
    }
    return `<p class="dSub"><b>He is next in line behind ${esc(hc.leadName)}, who is not on
your team.</b> ${open}</p>
${gain > 0 ? `<p class="dSub">So this is a <b>bet on another manager's bad luck</b>, not cover
for your own — you only ever get paid if ${surname} misses time AND you still have room in
your line-up for this man. Worth about <b>${gain} points</b> to you, which already allows for
the chance that neither happens.</p>` : ''}`;
  }
  if (share > 0.9) return '';                    // he starts; nothing to explain

  const pos = word(r.p.pos, true);
  const own = have === 0 ? '' : ` You already have ${have} ${have === 1 ? word(r.p.pos) : pos}.`;
  const rounded = weeks <= 0 ? 'almost never' : `about ${weeks} week${weeks === 1 ? '' : 's'}`;
  return `<p class="dSub"><b>${rounded} of the season.</b>${own} He would sit on your bench
and only play when the ${pos} ahead of him are hurt or on a bye — so he is worth
<b>${Math.round(r.lineup)}</b> points to your lineup, not the
${Math.round(r.pts)} on his card.</p>
<p class="dNote">Every bench pick is judged this way: not on his projection, but on how
often he would end up in your team and what he would be doing there.</p>`;
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

  // WHICH PLAYER, and this is the whole argument of the panel. Four versions have been
  // tried and the first three each got a real draft wrong:
  //
  // 1. The position with the highest cost of waiting. Scarcity with the level difference
  //    thrown away - it gave up ten points of player for three of scarcity.
  // 2. The best PAIR of positions. Right in principle, still aggregated by position, and
  //    at a turn it kept picking the scarce position when nothing was at risk.
  // 3. The best PAIR of players. Fixed the turn, because "will THIS man last" is the
  //    question a drafter actually has. But two picks is not a long enough horizon: when
  //    both men vanish before your next pick, the second term is identical in both
  //    branches and cancels, and a quarterback cliff twenty picks further on is invisible.
  // 4. This one. `planDraft` rolls the whole remaining draft forward, filling every
  //    starting slot you still need, and takes whoever leaves the best roster. See the
  //    long note above planDraft in engine.js for the draft that forced it.
  //
  // costOfWaiting is gone. It survived as a second sum feeding the board reading, and a
  // second sum is exactly what this panel keeps getting caught doing: it printed "waiting
  // costs 22 at receiver" directly under a panel printing 46 for the same phrase. One
  // calculation now answers every question on this screen.
  // The caps go in so the panel cannot name a man the app itself would refuse to draft -
  // a third quarterback, a fifth tight end. One recommendation, one set of rules.
  const res = planDraft(board.rows, clock, drafted, board.league, have,
    { candidates: 10, horizon: PLAN_HORIZON, caps: myCaps() });
  if (!res?.plan?.length) return null;

  const top = { pos: res.top.row.p.pos, best: res.top.row, total: res.top.total };

  // Your own liked and faded men, applied to the chosen player rather than to a position.
  // If you have starred someone within touching distance, he is the recommendation - that
  // is the entire point of a star. And never lead with a man you have said you distrust
  // when there is a real alternative. Judged on plan total, which is what the plan ranks.
  const near = res.plan.find((c) => c.row.star && c.row.p.id !== top.best.p.id
    && c.total >= res.top.total - STAR_BAND);
  if (near) { top.best = near.row; top.pos = near.row.p.pos; top.total = near.total; }
  if (top.best.fade) {
    const alt = res.plan.find((c) => !c.row.fade && c.row.p.id !== top.best.p.id
      && c.total >= res.top.total - STAR_BAND * 2);
    if (alt) { top.best = alt.row; top.pos = alt.row.p.pos; top.total = alt.total; }
  }
  // "then X at your next pick" has to come from the plan for the man actually named. Read
  // off res.top it would describe the pick you were talked out of by your own star.
  const chosen = res.plan.find((c) => c.row.p.id === top.best.p.id) || res.top;
  top.shortfall = res.slots.filter((s) => s === top.pos).length;
  return { res, top, near: near?.row || null, plan: res.plan,
    first: chosen.steps[0] || null, steps: chosen.steps };
}

// Plain words for the panel. Zach's fiancee reads this too, and "the last good QB goes
// here" is a sentence about quarterbacks, not about a two-letter code.
const POS_WORD = { QB: ['quarterback', 'quarterbacks'], RB: ['running back', 'running backs'],
  WR: ['receiver', 'receivers'], TE: ['tight end', 'tight ends'],
  K: ['kicker', 'kickers'], DEF: ['defence', 'defences'] };
const word = (pos, many) => (POS_WORD[pos]?.[many ? 1 : 0] || pos);
// How big a drop has to be before the panel calls it a cliff and says so in words. On this
// scale the top of the board is around 120 and a startable man is around 40, so ten points
// is roughly a tier - the same order as the gaps markTiers looks for.
const CLIFF = 10;
// Below this the pick was close and the panel has to say so. A cost-of-waiting argument
// only explains a pick that a cost of waiting actually decided; wheeling one out to
// justify a five-point preference is how the panel ended up quoting a 46-point receiver
// cliff as the reason for taking a running back.
const CLOSE = 6;

// Why this man and not the obvious one, in the numbers the decision used.
//
// res.cost carries one cost of waiting per position - what you pay there if you do not
// open with it, read out of the best plan that opens with something else. Every readout
// in the app now uses that same field, so the sentence, the pills and the board reading
// cannot drift apart again.
function planWhy(res, top) {
  const mine = res.cost.find((c) => c.pos === top.pos);
  const rival = res.cost.find((c) => c.pos !== top.pos && c.best);
  if (!mine || !rival || !res.later.length) {
    return 'Best of what is left, counting every pick you have between now and the end.';
  }
  const mineGap = Math.round(mine.gap);
  const theirGap = Math.round(rival.gap);
  const them = word(rival.pos, true);
  const up = (s) => s[0].toUpperCase() + s.slice(1);
  const both = `waiting costs about <b>${mineGap}</b> at ${word(top.pos, true)} and `
    + `<b>${theirGap}</b> at ${them}`;

  // Close first, before any cliff talk. When the alternatives are within a few points the
  // truthful answer is that it barely matters, and the useful thing to add is where the
  // plan picks up the position you are passing on.
  if (rival.loss < CLOSE) {
    const n = Math.round(rival.loss);
    return `Close call — opening with a ${word(rival.pos)} instead works out about `
      + `<b>${n || 1}</b> point${n === 1 ? '' : 's'} worse across the whole draft, so this `
      + `is mostly just the better player`
      + (rival.at ? `. You still get a ${word(rival.pos)} at pick ${rival.at}.` : '.');
  }

  const cliff = `The last ${word(top.pos)} at this level goes about here — wait and the best `
    + `one left is worth <b>${mine.wait.toFixed(0)}</b> instead of ${mine.now.toFixed(0)}, `
    + `and you carry that all season.`;
  const deep = `${up(them)} this good keep coming: pass now and you still get about `
    + `<b>${rival.wait.toFixed(0)}</b> instead of ${rival.now.toFixed(0)}.`;
  // A cliff has to be steep in itself, not merely steeper than the next thing. Comparing
  // the two gaps alone printed "neither falls off a cliff" above a pair of sixty-point
  // drops, because they happened to be sixty-point drops of the same size.
  if (mineGap >= CLIFF && mineGap > theirGap + 3) return `${cliff} ${deep}`;
  if (mineGap >= CLIFF && theirGap >= CLIFF) {
    return `Everything thins out from here — ${both}. He is the best of what is going`
      + `${rival.at ? `, and the plan still gets you a ${word(rival.pos)} at pick ${rival.at}` : ''}.`;
  }
  if (mineGap + 3 < theirGap) {
    const ahead = Math.round(top.best.score - rival.best.score);
    return `Nothing is urgent at ${word(top.pos)} — he is simply the best man left once `
      + `every pick you have is counted. ${up(them)} thin out faster, `
      // and sometimes the man taken is not even the higher score, which is the plan saying
      // the rest of the draft pays it back. "give up -12 points" is not a sentence.
      + (ahead > 0
        ? `but not by enough to give up ${ahead} point${ahead === 1 ? '' : 's'} here.`
        : `but you get them back at your next picks and the whole roster comes out ahead.`);
  }
  return `Nothing here falls off a cliff — ${both}, so this is simply the better player.`;
}

// The recommendation panel: what to do with THIS pick, and why.
// Roster caps, plus any rule you have set for yourself.
//
// It goes through caps rather than through the score for a reason: a cap is a statement
// about what you will DRAFT, and the score is a statement about what a player is worth.
// Suppressing a backup quarterback's score to keep him out of the plan would be lying in
// the column to get an answer in the panel, and it would leak everywhere - his Type, his
// Worth window, the compare panel, the grade. Capping the position says the true thing
// once, in the one place that decides picks.
function myCaps(league) {
  const lg = league || board?.league || data.leagues[st.league];
  const caps = capsOf(lg, board?.shares);
  if (st.noQb2 && caps.QB > 1) caps.QB = 1;
  return caps;
}

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
  const { res, top, near, first, steps } = rec;
  const cliff = top.best.lastOfTier;
  const when = clock.onClock ? 'Take' : 'Line up';

  // The pills used to be a position-level cost of waiting sitting next to a player-level
  // recommendation - two different sums side by side, and the pills were the more
  // believable-looking of the two, so they got read as the reason for the pick. They are
  // now the plan's own arithmetic: how much worse your finished roster is if you open with
  // this position instead of the one named above.
  // Kickers and defences are dropped unless one of them IS the pick. "Starting with a
  // defence costs you 25 points" is true and nobody needed telling.
  const pills = res.cost
    .filter((x) => !STREAMED.includes(x.pos) || x.pos === top.pos).slice(0, 5);
  // what the plan does with your later picks, so the reasoning is inspectable rather than
  // asserted - "then RB at 48, WR at 49" is checkable against your own instinct
  const path = steps
    .map((s) => `${s.slot === 'FLEX' ? 'flex' : s.slot === 'ANY' ? 'best left' : s.slot} at ${s.pick}`)
    .join(', ');

  box.innerHTML = `<div class="advHead">
<span class="advTag">${when} ${top.pos}</span>
<b>${top.best.p.name}</b> <span class="tm">${top.best.p.team || ''}</span>
<span class="hint">score ${top.best.score100.toFixed(2)}${top.shortfall ? ` · you still need ${top.shortfall}` : ''}${near ? ' · your pick, and close enough to take' : ''}</span>
${cliff ? `<span class="cliffTag">last of ${top.pos} tier ${top.best.tier}</span>` : ''}
</div>
<p class="advWhy">${planWhy(res, top)}${first && first.take
    ? ` Then <b>${first.take.p.name}</b> or similar should still be there at pick ${first.pick}.`
    : ''}${path ? `<span class="advPath">plan: ${top.pos} now, ${path}</span>` : ''}</p>
<div class="advCost">${pills.map((x) => `<span class="costPill${x.pos === top.pos ? ' hot' : ''}">
<b>${x.pos}</b>${x.loss < 0.5 ? 'best' : `−${x.loss.toFixed(0)}`}</span>`).join('')}
<span class="hint">points your whole roster loses if you start with that position instead</span></div>
${posAdviceHTML(res, top, drafted)}`;
}

// Filtering to a position is a question: "fine, but who is the best QB here?" The board
// answered it by reordering rows and saying nothing, which leaves you to guess whether the
// man at the top of a filtered list is someone the app would actually take.
//
// So when a filter is on, this answers both halves out loud - the best man at that position
// AND what it costs to take him instead of the recommendation. The cost sentence is not
// written here: it is pickShot + pickCost, the same pair that grades your picks afterwards,
// so the app cannot talk you into a pick it would mark down later.
function posAdviceHTML(res, top, drafted) {
  if (filter === 'ALL' || !res?.plan?.length) return '';
  const best = board.rows.find((r) => r.p.pos === filter && !drafted.has(r.p.id));
  if (!best) return `<p class="posWhy"><b>No ${filter} left on the board.</b></p>`;
  const same = best.p.id === top.best.p.id;
  const shot = pickShot(res, best.p.id, clock, { skipStreamed: false });
  const v = shot ? pickCost(shot) : null;
  const lasts = shot?.hasKeep ? Math.round(shot.keep) : null;
  return `<p class="posWhy"><span class="posTag">${filter}</span>
<b>${esc(best.p.name)}</b> <span class="tm">${best.p.team || ''}</span>
<span class="hint">score ${best.score100.toFixed(2)} · ${filter}${best.posRank} on your board${
  lasts != null ? ` · ${lasts} in 100 he lasts to pick ${clock.target}` : ''}</span>
<span class="posSay">${same
    ? `He is also the pick — nothing on the board beats him right now.`
    : `${esc(v?.why || `Your board rates ${top.best.p.name} higher right now.`)}`}</span>
${same ? '' : `<span class="posSay alt">The panel above says <b>${esc(top.best.p.name)}</b>
instead${v && v.kind === 'wasted'
    ? ' — and taking this one first is the case it is built to avoid.'
    : v && v.points ? `, which is worth about ${v.points} point${v.points === 1 ? '' : 's'} more to your finished roster.`
      : '.'}</span>`}</p>`;
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
  clearShots();
  if (st.clockAt) delete st.clockAt[st.league];
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
  if (!keep) { st.picks[st.league] = { drafted: [], mine: [] }; clearShots(); }
  lastCols = '';
  save();
  renderChrome();
  rebuild();
}

// ---------------------------------------------------------------- what a pick cost
// The alternatives to a pick only exist at the moment it is made. Ten seconds later half
// of them are off the board and "who else could you have had" has no answer left, which is
// why the old cost panel fell back on ADP: it was the only thing still around afterwards.
// So the record is taken here, on the way past, for every pick that is yours.
//
// It runs the plan a second time, with the man you took forced into the shortlist so he
// gets priced even when the app would never have suggested him. That is the extra cost of
// this - one more rollout per pick of yours, about fifteen a draft.
function stampShot(id) {
  if (!clock?.picks?.length || !board?.rows) return;
  const drafted = new Set(picks().drafted);
  if (drafted.has(id)) return;                 // must be recorded BEFORE the pick lands
  const have = {};
  for (const x of picks().mine) {
    const p = byId(x);
    if (p) have[p.pos] = (have[p.pos] || 0) + 1;
  }
  const res = planDraft(board.rows, clock, drafted, board.league, have,
    { candidates: 10, horizon: PLAN_HORIZON, must: [id], caps: myCaps() });
  // The same rule autoPick follows, worked out the same way: until your remaining picks are
  // down to the slots you still have to fill, a kicker and a defence are not on the table.
  // The cost view must not hold a pick against a man the app would have refused to take.
  const roster = picks().mine.map((x) => byId(x)).filter(Boolean);
  const left = roundsOf(board.league) - roster.length;
  const forced = needsOf(roster, board.league).total >= left;
  const shot = pickShot(res, id, clock, { skipStreamed: !forced });
  if (!shot) return;
  // His value window AT THE MOMENT you took him, which is the only moment it means
  // anything. Fifteen picks later the need bonus has moved every rank on the board and a
  // window read off the finished board would be a different question. Read straight off
  // the row valueWindow already wrote - not recomputed here.
  const row = board.rows.find((x) => x.p.id === id);
  if (row) {
    shot.win = { from: row.worthFrom, to: row.worthTo, open: !!row.openEnded, kind: row.kind || null };
  }
  // Kept outside st.picks on purpose: a practice draft rebuilds that object wholesale from
  // its log on every pick, and the records would go with it.
  st.shots ||= {};
  (st.shots[st.league] ||= {})[id] = shot;
}

const shotFor = (id) => st.shots?.[st.league]?.[id] || null;
const clearShots = () => { if (st.shots) st.shots[st.league] = {}; };

// A pick made by the person, from the real board. Everything else follows from it.
function mockTake(id, by) {
  const m = mock();
  if (!m || m.done) return false;
  const lg = data.leagues[st.league];
  const n = m.log.length + 1;
  if (pickTeam(n, teamsOf(lg)) !== m.slot) return false;
  const p = byId(id);
  if (!p || m.log.some((x) => x.id === id)) return false;
  stampShot(id);
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
  const caps = myCaps(lg);
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
    stampShot(p.id);                     // before the pick lands, while the board is intact
    m.log.push({ n: m.log.length + 1, team: m.slot, id: p.id, pos: p.pos,
      adp: p.adp ?? null, by: 'app' });
    syncMockPicks();
    guard += 1;
  } while (all && !m.done && guard < rounds + 2);
  advanceMock();
  save();
  rebuild();
}

// ---------------------------------------------------------------- ten drafts at once
// One draft tells you what the board did. Ten from the same seat tell you whether it MEANT
// it - and that is a different question, the one that decides whether these ratings are
// worth following on the night.
//
// The question it exists to answer, in Zach's words: how often do we take one of these men
// while somebody who was NOT coming back goes to another team? The board already has an
// honest answer for a single pick - pickCost's `wasted` verdict, which fires only when the
// man taken would most likely still have been sitting there next turn AND a better one
// would not. This just runs that verdict N times and counts.
//
// It deliberately reuses seedRun + autoDraft rather than reimplementing the pick loop. A
// second copy of "what would the app do here" would eventually disagree with the first, and
// then a batch of ten would be measuring something the app does not actually do.
function seedRun(slot, seed) {
  st.slots ||= {};
  st.slots[st.league] = slot;
  st.picks[st.league] = { drafted: [], mine: [] };
  if (st.shots) st.shots[st.league] = {};
  if (st.clockAt) delete st.clockAt[st.league];
  st.mock = { league: st.league, slot, disc: +($('#disc')?.value ?? 40),
    seed, log: [], done: false };
  advanceMock();
}

// One row per pick of yours, carrying the same verdict the report on a single draft shows.
function harvestRun(run) {
  const m = st.mock;
  const lg = data.leagues[st.league];
  const T = teamsOf(lg);
  return m.log.filter((x) => x.team === m.slot).map((x) => {
    const p = byId(x.id);
    const shot = shotFor(x.id);
    const v = pickCost(shot);
    return {
      run,
      pick: x.n,
      round: roundOf(x.n, T),
      name: p?.name || x.id,
      pos: p?.pos || x.pos,
      team: p?.team || '',
      adp: p?.adp ?? null,
      ourRank: shot?.me?.rank ?? null,
      score: shot?.me?.score ?? null,
      // the number his whole question turns on: chance he was still there next turn
      lasts: shot?.hasKeep ? Math.round(shot.keep) : null,
      verdict: v.kind,
      gave: v.points || 0,
      lost: v.kind === 'wasted' ? (shot?.lost?.name || '') : '',
      // who you passed to take him, and whether that man came back
      alt: shot?.alt?.name || '',
      altPos: shot?.alt?.pos || '',
      altLasts: shot?.alt?.hasKeep ? Math.round(shot.alt.keep) : null,
    };
  });
}

let batchRows = [];
let batchGrades = [];

// pickCost's five verdicts, short enough for a table cell. Same words, same meanings.
const VERDICT_WORD = {
  top: 'Best there', fine: 'Level with the best', paid: 'Paid to be sure',
  left: 'Left points behind', wasted: 'Cost you a player', unknown: 'Not recorded',
};

async function runBatch(slot, n) {
  const lg = data.leagues[st.league];
  // Everything about to be trampled. A batch must leave your real board exactly as it was -
  // on draft night this button is two inches from a board with fifteen picks on it.
  const keep = {
    mock: st.mock,
    picks: picks(),
    shots: st.shots?.[st.league] || {},
    clockAt: st.clockAt?.[st.league],
    slot: st.slots?.[st.league],
  };
  batchRows = [];
  batchGrades = [];
  try {
    for (let i = 1; i <= n; i += 1) {
      $('#batchOut').innerHTML = `<p class="facts">Running draft ${i} of ${n} from slot `
        + `${slot}…</p>`;
      // A fixed seed per run, derived from the run number, so pressing Run twice on the
      // same slot gives the same answer. A batch you cannot reproduce is not evidence.
      seedRun(slot, 1000 + i * 7919);
      autoDraft(true);
      batchRows.push(...harvestRun(i));
      // Graded by the same draftGrade the single-draft report uses, so "how does the board
      // grade on average from this seat" is the same question asked N times and not a new
      // measure invented for the batch.
      const g = draftGrade(st.mock, lg);
      if (g.overall != null) {
        batchGrades.push({ run: i, overall: g.overall, word: g.word,
          parts: Object.fromEntries(Object.entries(g.parts)
            .filter(([, v]) => v && v.score != null).map(([k, v]) => [k, v.score])) });
      }
      // Hand the frame back so the progress line above actually paints and the tab does
      // not appear frozen for the second and a half this takes.
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    st.mock = keep.mock;
    st.picks[st.league] = keep.picks;
    if (st.shots) st.shots[st.league] = keep.shots;
    st.clockAt ||= {};
    if (keep.clockAt == null) delete st.clockAt[st.league];
    else st.clockAt[st.league] = keep.clockAt;
    st.slots[st.league] = keep.slot;
    lastCols = '';
    save();
    rebuild();
  }
  return { rows: batchRows, grades: batchGrades, n, slot, league: lg.name };
}

const GRADE_LABEL = { left: 'points left on the board', reach: 'reaching',
  bench: 'bench worth', byes: 'bye weeks', prefs: 'your preferences' };

// How the board grades itself from this seat, on average. Worth more than any single draft's
// mark: one draft's grade is partly the room's behaviour on the night, and averaging over
// runs leaves the part that is actually the board's doing. The spread matters as much as the
// average - a seat that grades 82 every time is a plan; 82 on average from 60 to 95 is luck.
function batchGradeHTML(res) {
  const g = res.grades || [];
  if (!g.length) return '';
  const marks = g.map((x) => x.overall);
  const avg = Math.round(marks.reduce((a, b) => a + b, 0) / marks.length);
  const lo = Math.min(...marks);
  const hi = Math.max(...marks);
  const keys = [...new Set(g.flatMap((x) => Object.keys(x.parts)))];
  const per = keys.map((k) => {
    const vals = g.map((x) => x.parts[k]).filter((v) => v != null);
    return { k, avg: Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) };
  }).sort((a, b) => a.avg - b.avg);
  const worst = per[0];
  return `<div class="gradeBig"><b>${avg}</b><span>out of 100 on average, across
${res.n} draft${res.n === 1 ? '' : 's'} from slot ${res.slot}</span>
<span class="hint">Best ${hi}, worst ${lo}${hi - lo > 20
    ? ' — a spread that wide means the night matters more than the plan does'
    : ' — tight enough that this is the plan rather than luck'}.
${worst ? `Weakest measure: <b>${GRADE_LABEL[worst.k] || worst.k}</b>, averaging ${worst.avg}.` : ''}
This grades how you drafted, not how the team will do — nothing here knows the season.</span>
<span class="hint">${per.map((x) => `${GRADE_LABEL[x.k] || x.k} ${x.avg}`).join(' · ')}</span></div>`;
}

function batchHTML(res) {
  const { rows, n } = res;
  if (!rows.length) return '<p class="empty">Nothing came back from those drafts.</p>';
  const byRound = new Map();
  for (const r of rows) {
    if (!byRound.has(r.round)) byRound.set(r.round, []);
    byRound.get(r.round).push(r);
  }
  const pct = (k, tot) => `${Math.round((k / tot) * 100)}%`;

  // The headline: how often a pick of yours went to a man who was not going anywhere while
  // one who WAS went elsewhere. This is the whole reason the batch exists.
  const wasted = rows.filter((r) => r.verdict === 'wasted');
  const lostTally = {};
  for (const r of wasted) if (r.lost) lostTally[r.lost] = (lostTally[r.lost] || 0) + 1;
  const lostTop = Object.entries(lostTally).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const gave = rows.reduce((a, r) => a + (r.gave || 0), 0) / n;

  const head = `<div class="cmpVerdict ${wasted.length ? '' : 'clear'}">
<b>${wasted.length
    ? `${wasted.length} pick${wasted.length === 1 ? '' : 's'} across ${n} drafts went to a `
      + 'man who was not going anywhere'
    : `Across ${n} drafts, no pick was spent on a man who would have come back to you`}</b>
<span class="hint">${wasted.length
    ? `That is ${(wasted.length / n).toFixed(1)} per draft. Each one means you took somebody `
      + 'your board said would still be sitting there next turn, and somebody it rated '
      + 'higher went to another team meanwhile.'
    : 'Every pick was either the best man there or one who was about to go.'}
Average given up per draft: ${gave.toFixed(0)} points.</span>
${lostTop.length ? `<span class="hint">Who you lost, most often: ${lostTop
    .map(([nm, c]) => `<b>${nm}</b> ×${c}`).join(', ')}.</span>` : ''}</div>`;

  const table = `<div class="board costPicks">
<div class="row head costPick"><span>Round</span><span>Who you took</span>
<span>How often</span><span>He lasts</span><span>Who you passed</span></div>
${[...byRound.keys()].sort((a, b) => a - b).map((rd) => {
    const list = byRound.get(rd);
    const tally = {};
    for (const r of list) {
      tally[r.name] ||= { r, k: 0 };
      tally[r.name].k += 1;
    }
    const order = Object.entries(tally).sort((a, b) => b[1].k - a[1].k);
    // Who the runs usually left on the board at this pick, and whether he came back. This
    // replaced the verdict column, which read "Best there" on nineteen rows in twenty -
    // true, and useless, because the auto-drafter takes the top of its own board by
    // construction. Naming nothing is not a verdict.
    const alts = {};
    for (const r of list) if (r.alt) alts[r.alt] = (alts[r.alt] || 0) + 1;
    const altTop = Object.entries(alts).sort((a, b) => b[1] - a[1])[0];
    const altRow = altTop ? list.find((r) => r.alt === altTop[0]) : null;
    const bad = list.filter((r) => r.verdict === 'wasted').length;
    return order.map(([nm, { r, k }], idx) => `<div class="row costPick">
<span class="num">${idx === 0 ? rd : ''}</span>
<span class="who">${posTag(r.pos)}<span class="nm">${nm}
<span class="tm">${r.team}${r.adp ? ` · ADP ${r.adp.toFixed(0)}` : ''}</span></span></span>
<span class="num">${k}/${list.length}${k === list.length ? '' : ` · ${pct(k, list.length)}`}</span>
<span class="num ${r.lasts != null && r.lasts >= 50 ? 'dn' : ''}">${r.lasts == null ? '—'
      : `${r.lasts} in 100`}</span>
<span class="who">${idx === 0 && altRow
      ? `${posTag(altRow.altPos)}<span class="nm">${altTop[0]}
<span class="tm">${altTop[1]} of ${list.length} runs${altRow.altLasts != null
        ? ` · came back ${altRow.altLasts} in 100` : ''}</span></span>` : ''}</span>
<span class="costWhy">${idx !== 0 ? '' : bad
      ? `<b class="dn">${bad} of ${list.length} runs cost you a player here</b>`
      : altRow && altRow.altLasts != null && r.lasts != null
        ? (r.lasts < altRow.altLasts
          ? 'Right way round in most runs — the man taken was going, the man passed came back.'
          : 'Worth a look: the man passed was likelier to go than the man taken.')
        : ''}</span></div>`).join('');
  }).join('')}</div>
<p class="hint"><b>How often</b> is out of ${n} drafts from the same seat, so a name showing
${n}/${n} means the board never wavered and one showing 3/${n} means it is a coin flip between
several men. <b>He lasts</b> is the chance the man you took was still sitting there at your
next pick — a high number there is the warning sign, because you did not have to take him
yet. <b>Who you passed</b> is the best man left on the board, and whether he came back to
you. Those two numbers together are the whole argument for a pick: take the one who was
going, and the one who was not will still be there.</p>`;

  return batchGradeHTML(res) + head + table;
}

function batchCsv(res) {
  const head = ['draft', 'pick', 'round', 'player', 'pos', 'team', 'adp', 'our_rank',
    'our_score', 'chance_he_lasted_to_next_pick', 'verdict', 'points_given_up',
    'player_lost_instead', 'best_man_passed', 'passed_pos',
    'chance_passed_man_came_back', 'draft_grade'];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const gradeOf = new Map((res.grades || []).map((g) => [g.run, g.overall]));
  return [head.join(','), ...res.rows.map((r) => [r.run, r.pick, r.round, r.name, r.pos,
    r.team, r.adp?.toFixed(1) ?? '', r.ourRank ?? '', r.score?.toFixed(1) ?? '',
    r.lasts ?? '', r.verdict, r.gave, r.lost, r.alt, r.altPos, r.altLasts ?? '',
    gradeOf.get(r.run) ?? ''].map(esc).join(','))].join('\n');
}

let lastBatch = null;

async function doBatch() {
  const lg = data.leagues[st.league];
  const slot = Math.max(1, Math.min(teamsOf(lg), +($('#batchSlot')?.value) || 1));
  const n = +($('#batchN')?.value) || 10;
  const btn = $('#batchRun');
  btn.disabled = true;
  msg('#batchMsg', '');
  try {
    lastBatch = await runBatch(slot, n);
    $('#batchOut').innerHTML = batchHTML(lastBatch);
    $('#batchCsv').hidden = false;
  } catch (e) {
    console.error('batch failed', e);
    $('#batchOut').innerHTML = '';
    msg('#batchMsg', `Could not finish those drafts: ${e.message}`, 'bad');
  }
  btn.disabled = false;
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
  // The pick on the clock is however many are already off the board, plus one - unless a
  // live sync has told us the real pick number, which is the better answer whenever the
  // room has taken someone this board does not carry. A practice draft keeps its own log
  // and must not read a leftover number from a Sleeper draft on the same league.
  const synced = mock() ? 0 : (st.clockAt?.[st.league] ?? 0);
  const now = Math.max(picks().drafted.length, synced) + 1;
  clock = draftContext(lg, slot, now);
  const bar = $('#clockBar');
  if (!bar) return;
  $('#clockNow').textContent = `Pick ${now}`;
  renderSyncLive();
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
    // The same men, by id. `mine` is positions and cannot answer "is the man he is standing
    // behind on MY roster", which is the whole difference between insurance and a lottery
    // ticket on somebody else's bad luck. See benchWorth in engine.js.
    mineIds: [...picks().mine],
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
  if (view === 'board') {
    renderMockBar(); renderBoard(); renderAdvice(); renderLean(); renderTeamStrip(); renderKeys();
    renderCompare();
  }
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

// The badge that says a man is next in line for somebody else's job.
//
// It must be readable by someone who has never heard the word "handcuff", which rules the
// word out - so the badge says what the situation IS rather than naming it. "if Gibbs sits"
// is the whole idea in three words: this man plays when that man does not. When the man in
// front is on YOUR team it says so, because that is a different purchase entirely - cover
// for a hole you would otherwise have, rather than a bet on another manager's bad luck.
//
// Silent when the job is never open. At the optimistic stop on the durability dial nobody
// misses a game, so there is nothing to inherit and nothing to say; the badge appearing and
// disappearing as that dial moves is the point rather than a glitch.
function hcBadge(r) {
  if (!r.hc || !(r.hcGain > 0.5)) return '';
  const last = esc(r.hc.leadName.split(' ').pop());
  return r.mineLead
    ? `<span class="hcTag mine" data-tip="handcuff">covers your ${last}</span>`
    : `<span class="hcTag" data-tip="handcuff">if ${last} sits</span>`;
}

function rowHTML(r, cols, d, m) {
  return `<span class="rk">${r.rank}</span>
<span class="who">${posTag(r.p.pos)}
<button class="nm" data-open="${r.p.id}" title="Show detail">${r.p.name} <span class="tm">${r.p.team || ''}</span></button>
${r.p.rookie ? '<span class="rook">R</span>' : ''}${injBadge(r.p)}
${r.lastOfTier ? `<span class="tierEnd" data-tip="cliff">last ${r.p.pos}${r.tier}</span>` : ''}${hcBadge(r)}
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
      // The same treatment for "if Montgomery sits", and it needs it more than the others
      // do. Rows are reused rather than rebuilt, so anything written into .who once stays
      // written; this badge changes on two events that do not touch a single number in the
      // row - moving the durability dial, and marking the man in front as yours. Left out
      // of this loop it went stale both ways: seventeen badges survived a switch to "nobody
      // gets hurt", still promising an inheritance the board had just priced at zero.
      const hc = who.querySelector('.hcTag');
      const want = hcBadge(r);
      if (want && !hc) who.insertAdjacentHTML('beforeend', want);
      else if (want && hc.outerHTML !== want) hc.outerHTML = want;
      else if (!want && hc) hc.remove();
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
  const [, why] = callFor(r);
  const drafted = new Set(picks().drafted);
  const wait = waitAdvice(r, drafted);
  // The card gets the full version, with the room's drafted list, so a Reach can name the
  // men you would actually be walking past rather than gesturing at "men your board rates
  // higher" - who are, half the time, already gone.
  const e = expl(r, true);

  // ---- the numbers, first, because they are what the argument rests on ----
  // They used to be the last line of a paragraph at the bottom of the card. Where he sits,
  // what he is projected for and how far that is above a replacement is the whole case for
  // taking him, so it goes at the top and it is read at a glance rather than parsed.
  const head = [
    [`#${r.rank}`, 'on your board'],
    [r.pts.toFixed(0), 'projected points'],
    [`${r.vor >= 0 ? '+' : ''}${r.vor.toFixed(0)}`, `above a replacement ${r.p.pos}`],
    [`${r.p.pos}${r.posRank}`, `${r.p.pos} on your board`],
  ].filter(Boolean).map(([n, l]) => `<span class="dNum"><b>${n}</b><i>${l}</i></span>`).join('');

  // ---- chips: the standing facts, condensed ----
  // Tier and injury were each a sentence buried in a paragraph. They are one word each.
  const chips = [
    r.tier ? `<span class="chip tier" data-tip="cliff">Tier ${r.tier} ${r.p.pos}</span>` : '',
    r.lastOfTier ? '<span class="chip cliffChip" data-tip="cliff">Last of his tier</span>' : '',
    r.p.inj ? `<span class="chip inj${INJ_BAD.includes(r.p.inj) ? ' out' : ''}">${r.p.inj}`
      + `${r.p.injPart ? ` — ${r.p.injPart}` : ''}</span>` : '',
    r.p.rookie ? '<span class="chip">Rookie</span>' : '',
    r.p.bye ? `<span class="chip">Bye ${r.p.bye}</span>` : '',
  ].filter(Boolean).join('');

  const window = r.openEnded ? `${r.worthFrom} onwards`
    : r.worthFrom === r.worthTo ? `pick ${r.worthFrom}`
      : `picks ${r.worthFrom}–${r.worthTo}`;

  const sec = (title, body, cls = '') => (body
    ? `<section class="dSec ${cls}"><h4>${title}</h4>${body}</section>` : '');

  // ---- what moved his score, and by how much ----
  // The board used to reorder itself when you starred somebody while every number on screen
  // stayed identical, which is impossible to learn from. Now the star goes into the score
  // like everything else, and this is the receipt: every adjustment by name, with its size,
  // hoverable for what it means. If two men swap places, one of these chips says why.
  const boosts = (r.boosts || []).slice().sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  const boostBar = boosts.length ? `<p class="dBoosts">${boosts.map((b) => {
    const t = TIPS[b.key];
    const title = t ? tip(t) : tip([b.label, 'Moves the score by this many points.']);
    return `<span class="boost ${b.amount >= 0 ? 'up' : 'dn'}" title="${title}">`
      + `${esc(b.label)} <b>${b.amount >= 0 ? '+' : '−'}${Math.abs(b.amount).toFixed(2)}</b></span>`;
  }).join('')}<span class="hint">These are already in the score above — they are why he sits
where he sits rather than where plain value would put him. Hover any of them.</span></p>` : '';


  return `<div class="detail">
<div class="dHead">${head}</div>
${chips ? `<p class="dChips">${chips}</p>` : ''}
<p class="dCmp"><button data-cmp="${r.p.id}" class="chipBtn">Compare him with someone</button>
<span class="hint">Put him side by side with one other player.</span></p>

${sec(`Why he is #${r.rank} on your board`, `${e ? `<p class="dSub">${esc(e.rank)}</p>
${e.prefLine ? `<p class="dNote">${esc(e.prefLine)}</p>` : ''}
<p class="dNote">${esc(e.caveat)}</p>` : ''}${boostBar}`)}

${sec('Is he worth this pick?', `
<p class="dCall">${r.kind
    ? `<em class="kind ${r.kind}">${KINDS[r.kind][0]}</em>`
    : '<em class="kind soft">Not yet</em>'} ${esc(e ? e.why
      : (r.kind ? KINDS[r.kind][1] : 'His range is still a long way off.'))}</p>
${e && e.cost ? `<p class="dSub">${esc(e.cost)}</p>` : ''}
${e ? `<p class="dSub">${esc(e.change)}</p>` : ''}
<p class="dSub">Worth <b>${window}</b>. The room takes him around <b>pick ${r.adpRank}</b>.
${why ? ` ${why}` : ''}</p>`)}

${sec('Will he still be there next time you pick?', wait
    ? `<p class="dSub">${wait}</p>` : '')}

${sec('If you took him, how often would he be in your lineup?', benchLine(r))}

${sec('How he matches what you said you like', r.tags?.length
    ? `<p class="tags">${r.tags.map((t) => `<span class="tag${
      t.match === true ? ' want' : t.match === false ? ' against' : ''}" title="${t.why}">${t.tag}${
      t.detail ? ` <em>${t.detail}</em>` : ''}</span>`).join('')}</p>
<p class="dNote">Your preferences, not a forecast. They move him a few places at most.</p>`
    : '<p class="dNote">Nothing stands out either way against your preferences.</p>')}

${sec(r.rated ? `How he rates among ${r.p.pos}s` : 'Rating', r.rated
    ? `<div class="bars">${bars}</div>
<p class="dNote"><b>${riskOf(r)}.</b> ${verdict(r)}</p>
<p class="dNote">These bars are a 0–100 grade against other ${r.p.pos}s and nothing else.
They are not what orders the board — ${r.p.pos}${r.posRank} above is his rank by draft
score, which also counts how scarce the position is and what a replacement would give you.</p>`
    : `<p class="dNote">No grade — there are no ${r.p.pos} stats worth rating, so his place `
      + `on the board is pure value.${STREAMED.includes(r.p.pos)
        ? ` Everyone streams this position off waivers, so “replacement” means a good one `
        + `you could pick up in-season — which is why the board takes ${r.p.pos}s later than `
        + 'the room does.' : ''}</p>`)}

${sec('Last season', `${statCards(r)}
<p class="dNote">${facts.length ? facts.join(' · ')
    : 'No 2025 data — his place on the board comes from the projection.'}
Describes last season; it is not what predicts this one.</p>`)}
</div>`;
}

// ---------------------------------------------------------------- compare two
// "Him or him." Between picks that is the only question there is, and answering it used to
// mean opening one card, reading it, closing it, opening a second and holding the first in
// your head. Two menus and one screen instead.
//
// Nothing on this panel is a new sum. The window comes from valueWindow, the label from
// pickType, the availability numbers from injuryGap and ownGames, the preference labels
// from fitTags, the odds he lasts from availability - all of it read straight off the row
// the board already built. If any of those change, this changes with them.
//
// The band inside which it refuses to name a winner is STAR_BAND, which is what this
// engine already means by "too close to call": it is exactly how far a star moves a player
// (no further, deliberately) and it is the band pickCost uses to say a pick left nothing
// behind. Inside it the panel says coin flip and stops. That refusal is the feature. A
// comparison screen that always crowns somebody trains you to trust a gap that is not
// there, and on this board a three-point gap really is nothing.
let cmpA = null;
let cmpB = null;

const rowFor = (id) => (id ? board?.rows.find((r) => r.p.id === id) || null : null);

// The window, in the same words the card uses.
const windowWords = (r) => (r.openEnded ? `pick ${r.worthFrom} onwards`
  : r.worthFrom === r.worthTo ? `pick ${r.worthFrom}` : `picks ${r.worthFrom}–${r.worthTo}`);

// What his projection becomes if you assume he plays what he has actually played, rather
// than the full season the published projection quietly assumes. This is the durability
// dial's own arithmetic - injuryGap - not a second version of it, and it is shown as a
// number beside the projection rather than folded into it. The board never edits a
// forecast; see the note over positionGames in engine.js.
function availView(r) {
  const games = board?.games;
  if (!r || !games) return null;
  const gap = injuryGap(r.p, board.league, games);
  const gp = ownGames(r.p, games);
  const known = !!(r.p.m?.has2025 && r.p.m.games_2025 != null);
  return { gap, gp, known, at: Math.max(0, r.pts - gap) };
}

const cmpCell = (main, sub) => `<span class="cmpCell"><b>${main}</b>${
  sub ? `<i>${sub}</i>` : ''}</span>`;

const cmpRow = (label, a, b, note = '') => `<div class="cmpRow">
<span class="cmpLab">${label}${note ? `<i>${note}</i>` : ''}</span>${a}${b}</div>`;

// The one sentence the whole panel exists to produce. It is allowed to say "neither".
function cmpVerdict(a, b) {
  const gap = Math.abs(a.score - b.score);
  const [hi, lo] = a.score >= b.score ? [a, b] : [b, a];
  const flip = gap < STAR_BAND;
  const pts = Math.abs(a.pts - b.pts);
  if (flip) {
    return { flip, hi, lo, gap,
      head: 'Coin flip — take either',
      why: `Your board separates them by ${gap.toFixed(1)} points of draft score, and `
        + `anything under ${STAR_BAND} is inside the margin this board treats as no `
        + `difference at all. It is not being coy: on these numbers there is no better `
        + `man here. Take the one you would rather watch, or the one whose bye week suits `
        + `you — and do not spend the clock on it.` };
  }
  return { flip, hi, lo, gap,
    head: `Your board prefers ${hi.p.name}`,
    why: `By ${gap.toFixed(1)} points of draft score — #${hi.rank} against #${lo.rank}. `
      + `That is outside the ${STAR_BAND}-point band this board calls a coin flip, so the `
      + `preference is real, but it is a preference about price and scarcity today, not a `
      + `claim that ${hi.p.name.split(' ').pop()} will score more `
      + `(${pts < 1 ? 'their projections are level' : `the projections are ${pts.toFixed(0)} points apart`}).` };
}

// Where the two differ on the four preferences. Read off the same traits fitTags reads,
// so the panel cannot say one thing while the card says another.
//
// The words are FIT_TAGS' words, not the slider's. The slider's ends say what YOU want
// ("Ignore it" / "Demand it"); FIT_TAGS says what the PLAYER is ("Injury risk" /
// "Ever-present"). An earlier version printed the slider's ends against the player and
// produced "Gibbs is further toward Demand it", which is not a sentence about anybody.
function cmpPrefs(a, b) {
  const league = board.league;
  const leans = st.fit || {};
  const axes = FIT_AXES.filter((x) => !x.needsPenalties || hasPenalties(league));
  const out = [];
  for (const ax of axes) {
    // A kicker or defence has no trait here, only a placeholder tie at 50, and comparing
    // placeholders is exactly the invented opinion the rest of the app refuses to give.
    if (!a.rated || !b.rated) break;
    const pa = a.traits?.[ax.key];
    const pb = b.traits?.[ax.key];
    if (pa == null || pb == null) continue;
    const d = pa - pb;
    if (Math.abs(d) < 15) continue;             // the same, near enough, on this axis
    const [ahead, behind] = d > 0 ? [a, b] : [b, a];
    const lean = leans[ax.key] || 0;
    const [hiTag, loTag] = FIT_TAGS[ax.key] || [[ax.right], [ax.left]];
    // Does the difference point the way you said you wanted, the other way, or nowhere?
    // A positive lean is a vote for the high end of the trait - see the Fit sum in
    // buildBoard - so a positive lean favours whoever is further up it.
    const suits = lean === 0 ? null : (lean > 0) === (d > 0) ? ahead : behind;
    out.push({ axis: ax.key, label: ax.label,
      want: lean === 0 ? null : lean > 0 ? ax.right : ax.left,
      ahead: ahead.p.name, behind: behind.p.name,
      hiTag: hiTag[0], loTag: loTag[0], suits: suits?.p.name || null,
      lean: fitWord(lean), gap: Math.abs(Math.round(d)) });
  }
  return out;
}

function compareHTML(a, b) {
  const lg = board.league;
  const v = cmpVerdict(a, b);
  const av = availView(a);
  const bv = availView(b);
  const drafted = new Set(picks().drafted);
  const at = clock?.currentPick || null;
  const kindCell = (r) => {
    const k = r.kind ? KINDS[r.kind] : null;
    return cmpCell(k ? `<em class="kind ${r.kind}">${k[0]}</em>` : '<em class="kind soft">Not yet</em>',
      k ? k[1] : 'His range is still a long way off — the board is not asking you to take him here.');
  };
  const tagCell = (r) => {
    if (!r.rated) {
      return cmpCell('No labels', `There are no ${r.p.pos} stats to describe, so your `
        + 'preferences have nothing to say about him either way.');
    }
    if (!r.tags?.length) return cmpCell('Nothing stands out', 'He is unremarkable on all four of your preferences.');
    return cmpCell(r.tags.map((t) => `<span class="tag${t.match === true ? ' want'
      : t.match === false ? ' against' : ''}" title="${tip(t.why)}">${t.tag}</span>`).join(' '),
    r.tags.map((t) => t.why).join('; '));
  };
  const availCell = (r, x) => {
    if (!x) return cmpCell('—', '');
    if (!x.gap) {
      return cmpCell(`${Math.round(r.pts)}`, STREAMED.includes(r.p.pos)
        ? `A ${r.p.pos === 'K' ? 'kicker' : 'defence'} has no availability record worth the `
          + 'name, so nothing is taken off.'
        : 'No games missed on record, so this assumption takes nothing off him.');
    }
    return cmpCell(`${Math.round(x.at)} <s>${Math.round(r.pts)}</s>`,
      `${x.known ? `He played ${x.gp} of ${FULL_GAMES} games last season`
        : `He has no record, so this uses what a ${r.p.pos} typically plays (${x.gp.toFixed(1)} of ${FULL_GAMES})`}`
      + ` — ${Math.round(x.gap)} points behind a full season.`);
  };
  const waitCell = (r) => {
    const w = waitAdvice(r, drafted);
    return cmpCell(w || '—', w ? '' : 'Set your draft slot on this page to see whether he comes back to you.');
  };

  // Does the availability assumption change the answer? This is the only thing on the
  // panel that is worth a sentence of its own, because it is the one place two men can
  // swap order without anybody's rating moving.
  let durLine = '';
  if (av && bv && !(a.rated && b.rated)) {
    // One of them is a kicker or a defence, which have no availability record worth the
    // name - injuryGap returns zero for them by design, not because they are indestructible.
    // Reading that zero as "the safer man" would be the panel inventing a fact.
    const un = a.rated ? b : a;
    durLine = `<p class="cmpNote">Availability cannot be compared here. A ${
      un.p.pos === 'K' ? 'kicker' : 'defence'} has no games record worth the name, so the
board takes nothing off ${esc(un.p.name)} — that is an absence of information, not a clean
bill of health.</p>`;
  } else if (av && bv) {
    const rawLead = a.pts - b.pts;
    const adjLead = av.at - bv.at;
    const bigger = av.gap > bv.gap ? a : b;
    const gapDiff = Math.abs(av.gap - bv.gap);
    if (rawLead !== 0 && adjLead !== 0 && Math.sign(rawLead) !== Math.sign(adjLead)) {
      durLine = `<p class="cmpNote warnNote"><b>This is where they actually differ.</b> On the
published projections ${esc(rawLead > 0 ? a.p.name : b.p.name)} is ahead. Assume instead that
each plays what he has actually played, and ${esc(adjLead > 0 ? a.p.name : b.p.name)} comes out
ahead. Nobody can tell you which assumption is right — but if you believe the games, this is a
different call.</p>`;
    } else if (gapDiff >= 15) {
      durLine = `<p class="cmpNote"><b>${esc(bigger.p.name)} carries the bigger availability
question</b> — ${Math.round(gapDiff)} more points of the difference between them rides on him
staying on the field. It does not change which one the board prefers.</p>`;
    } else {
      durLine = '<p class="cmpNote">Availability is not what separates these two — both are '
        + 'carrying about the same question about games played.</p>';
    }
  }

  const byeLine = a.p.bye && a.p.bye === b.p.bye
    ? `<p class="cmpNote">They share <b>bye week ${a.p.bye}</b>, so taking both leaves you a
hole in the same week. That matters more than it looks if you have already got starters on
that bye.</p>` : '';

  const prefs = cmpPrefs(a, b);
  const prefLine = !(a.rated && b.rated)
    ? `<p class="cmpNote">Your preferences cannot separate these two — there are no
${esc(a.rated ? b.p.pos : a.p.pos)} stats to describe, so every trait a ${
  esc(a.rated ? b.p.pos : a.p.pos)} appears to have is a placeholder rather than a fact
about him.</p>`
    : !prefs.length
      ? '<p class="cmpNote">On your four preferences these two look much the same.</p>'
      : `<ul class="cmpPrefs">${prefs.map((x) => `<li><b>${esc(x.label)}</b> — of the two, your
board calls ${esc(x.ahead)} <b>${esc(x.hiTag.toLowerCase())}</b> and ${esc(x.behind)}
<b>${esc(x.loTag.toLowerCase())}</b> (${x.gap} points of percentile apart).${x.want
    ? ` You said you lean toward <b>${esc(x.want.toLowerCase())}</b> — ${x.lean} — so this one
favours <b>${esc(x.suits)}</b>.`
    : ' You have no preference set here, so it is information rather than a nudge.'}</li>`).join('')}</ul>`;

  const head = (r) => `<span class="cmpWho">${posTag(r.p.pos)}<b>${esc(r.p.name)}</b>
<i>${esc(r.p.team || '')}${r.p.rookie ? ' · rookie' : ''}${r.p.inj ? ` · ${esc(r.p.inj)}` : ''}</i></span>`;

  return `<div class="cmp">
<div class="cmpVerdict ${v.flip ? 'flip' : 'clear'}">
<b>${esc(v.head)}</b><span>${esc(v.why)}</span></div>

<div class="cmpGrid">
<div class="cmpRow cmpHead"><span class="cmpLab"></span>${head(a)}${head(b)}</div>

${cmpRow('Projected points', cmpCell(Math.round(a.pts), ''), cmpCell(Math.round(b.pts), ''),
    `A full season in ${esc(lg.name)} scoring`)}

${cmpRow('Where your board has him',
    cmpCell(`#${a.rank}`, `${a.p.pos}${a.posRank} on your board`),
    cmpCell(`#${b.rank}`, `${b.p.pos}${b.posRank} on your board`),
    'Draft score order, not a grade')}

${cmpRow('Worth taking at',
    cmpCell(windowWords(a), `The room takes him around pick ${a.adpRank}`),
    cmpCell(windowWords(b), `The room takes him around pick ${b.adpRank}`),
    'The picks he is the equal of anyone left')}

${cmpRow(at ? `At pick ${at}, right now` : 'Before the draft starts', kindCell(a), kindCell(b))}

${cmpRow('Bye week', cmpCell(a.p.bye || '—', ''), cmpCell(b.p.bye || '—', ''),
    'The week he scores you nothing')}

${cmpRow('If he plays what he has played', availCell(a, av), availCell(b, bv),
    'The projection assumes a full season. This does not.')}

${cmpRow('What you said you like', tagCell(a), tagCell(b),
    'Your preferences, not a forecast')}

${cmpRow('Still there next time you pick?', waitCell(a), waitCell(b),
    'From how far the room usually lets him fall')}
</div>

${durLine}
${byeLine}
${prefLine}

<p class="cmpFoot"><b>What this panel is not.</b> It cannot tell you which of these two will
score more this season. Nothing can — that is the one thing five years of testing on this
data said could not be done. What it can tell you is which one is better value at the pick
in front of you, what each one costs you if he misses time, and which of them matches what
you said you wanted. When those come out level it says so.</p>
</div>`;
}

// The menu of everyone you could compare, in board order, so the top of your board is the
// top of the list. Drafted players stay in it deliberately: "should I have taken him
// instead" is a question worth being able to ask afterwards.
// Rebuilt only when the list would actually read differently. Every pick in a practice
// draft calls renderAll, and re-writing 260 options each time threw away the scroll
// position of a menu somebody was in the middle of reading.
let cmpSig = '';

function cmpOptions(a, b) {
  const drafted = new Set(picks().drafted);
  const rows = board.rows.slice(0, 260);
  const sig = `${st.league}|${rows.length}|${drafted.size}|${rows[0]?.p.id}|${rows.at(-1)?.p.id}`;
  if (sig !== cmpSig) {
    const opts = ['<option value="">— pick a player —</option>'];
    for (const r of rows) {
      opts.push(`<option value="${r.p.id}">#${r.rank} ${esc(r.p.name)} · ${r.p.pos} `
        + `${esc(r.p.team || '')}${drafted.has(r.p.id) ? ' (gone)' : ''}</option>`);
    }
    const html = opts.join('');
    a.innerHTML = html;
    b.innerHTML = html;
    cmpSig = sig;
  }
  a.value = cmpA || '';
  b.value = cmpB || '';
}

function renderCompare() {
  const panel = $('#cmpPanel');
  if (!panel || panel.hidden || !board) return;
  cmpOptions($('#cmpA'), $('#cmpB'));
  const out = $('#cmpOut');
  const a = rowFor(cmpA);
  const b = rowFor(cmpB);
  if (!a || !b) {
    out.innerHTML = `<p class="facts">Choose two players above. You can also open any
player's card on the board and press <b>Compare him with someone</b>${a || b
  ? ' — one is already chosen.' : '.'}</p>`;
    return;
  }
  if (a.p.id === b.p.id) {
    out.innerHTML = '<p class="facts">That is the same player twice. Pick a different one on one side.</p>';
    return;
  }
  try {
    out.innerHTML = compareHTML(a, b);
  } catch (err) {
    console.error('compare failed', err);
    out.innerHTML = '<p class="facts">Could not build that comparison.</p>';
  }
}

// From a card on the board: fill the first empty side, or replace the older one.
function compareWith(id) {
  if (!id || cmpA === id || cmpB === id) return;
  if (!cmpA) cmpA = id;
  else if (!cmpB) cmpB = id;
  else { cmpA = cmpB; cmpB = id; }
  const p = $('#cmpPanel');
  if (p) p.hidden = false;
  const btn = $('#cmpBtn');
  if (btn) btn.setAttribute('aria-expanded', 'true');
  renderCompare();
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

// ---------------------------------------------------------------- what the draft cost
// This used to be four numbers about ADP, and ADP is the wrong scorer. A pick taken before
// the room takes him was called a reach - which meant the app was calling its own advice a
// mistake every time its board disagreed with the market, which is the entire reason to
// have a board of your own. See the long note above pickShot in engine.js.
//
// What it asks now is what a person actually wants to know afterwards: was there somebody
// better sitting right there, and did taking this man cost me anybody. Both come off the
// record taken at the moment of the pick, in the same units the recommendation panel uses,
// so the two cannot contradict each other.
const COST_TONE = { top: 'up', fine: 'up', paid: '', left: 'dn', wasted: 'bad', unknown: '' };

function costList(ids) {
  return ids.map((id) => {
    const p = byId(id);
    if (!p) return null;
    const shot = shotFor(id);
    return { id, p, shot, v: pickCost(shot), mkt: marketNote(shot) };
  }).filter(Boolean);
}

const costCard = (label, val, note) => `<div class="card"><span class="cardV">${val}</span>
<span class="cardL">${label}</span><span class="hint">${note}</span></div>`;

function costCards(list) {
  const known = list.filter((x) => x.shot);
  const lost = known.filter((x) => x.v.kind === 'wasted');
  const clean = known.filter((x) => x.v.kind === 'top' || x.v.kind === 'fine');
  const points = Math.round(known.reduce((a, x) => a + x.v.points, 0));
  return costCard('Picks made', list.length, 'Every player you have taken.')
    + costCard('Best man on the board', `${clean.length} of ${known.length || 0}`,
      'Picks where nothing better was sitting there. These cost you nothing at all.')
    + costCard('Points left behind', points,
      'Added up over the draft, against the best man your own board had at each pick.')
    + costCard('Picks that lost you a player', lost.length,
      lost.length ? `${lost.map((x) => x.v && x.p.name).join(', ')} — you could have waited `
        + 'and did not.'
        : 'None. No pick of yours was spent on a man who was going to be there anyway.');
}

function costTable(list) {
  if (!list.length) {
    return '<p class="empty">Tick <b>Mine</b> on the board as you draft and every pick '
      + 'appears here with what it cost.</p>';
  }
  return `<div class="board costPicks">
<div class="row head costPick"><span>Pick</span><span>Player</span><span>Your board</span>
<span>The room</span><span>What it cost</span></div>
${list.map(({ p, shot, v, mkt }) => `<div class="row costPick">
<span class="num">${shot?.at ?? '—'}</span>
<span class="who">${posTag(p.pos)}<span class="nm">${p.name}
<span class="tm">${p.team || ''}</span></span></span>
<span class="ourRk">${shot ? `#${shot.me.rank}<span class="tm"> · ${Math.round(shot.me.score)}</span>` : '—'}</span>
<span class="num">${p.adp ? p.adp.toFixed(0) : '—'}</span>
<span class="cost ${COST_TONE[v.kind]}"><b>${v.head}</b></span>
<span class="costWhy">${v.why}${mkt ? ` <span class="mkt">${mkt}</span>` : ''}</span></div>`).join('')}</div>
<p class="hint"><b>Your board</b> is where your own ratings had him and what they scored him,
so you can see for yourself where you disagreed with everyone else. <b>The room</b> is the
pick the rest of the fantasy world usually takes him at — that is information about them,
not a mark against you. The only thing counted as a mistake here is taking a man who was
not going anywhere while somebody you wanted more went to another team.</p>`;
}

function renderRoster() {
  const lg = board.league;
  renderAdvice2();
  const cards = lineupOf(picks().mine, lg);

  $('#lineup').innerHTML = lineupTable(cards);
  $('#byes').innerHTML = byesHTML(cards);

  const list = costList(picks().mine);
  $('#cost').innerHTML = costCards(list);
  const table = $('#costPicks');
  if (table) table.innerHTML = costTable(list);

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

// ---------------------------------------------------------------- team strip
// The same question, asked on every pick: what have I got, and what is still empty?
//
// It is answered on the My team tab already, and this does NOT compute a second answer -
// it calls the same lineupOf() that fills that tab. Two functions working out who your
// starting flex is would eventually disagree, and then the app is arguing with itself on
// draft night. So the slot maths lives in one place and this is a second view of it.

// Plain English, because half the point of this app is that someone who does not follow
// football can read it. "You still need 2 WR" is jargon; "two receivers" is not. The
// position words are the recommendation panel's own - one list, so the two boxes on this
// screen cannot end up calling the same position different things.
const COUNT_WORD = ['no', 'a', 'two', 'three', 'four', 'five', 'six'];
function needPhrase(pos, n) {
  const one = pos === 'FLEX' ? 'flex spot' : word(pos, false);
  const many = pos === 'FLEX' ? 'flex spots' : word(pos, true);
  if (n === 1) return `${/^[aeiou]/.test(one) ? 'an' : 'a'} ${one}`;
  return `${COUNT_WORD[n] || n} ${many}`;
}
const joinWords = (list) => (list.length < 2 ? (list[0] || '')
  : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);
// first initial and surname - a full name does not fit a slot chip and truncating with an
// ellipsis makes two different players look the same
const shortName = (name) => {
  const bits = String(name || '').split(' ');
  return bits.length < 2 ? name : `${bits[0][0]}. ${bits.slice(1).join(' ')}`;
};

const SLOT_ORDER = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'DEF'];

function renderTeamStrip() {
  const el = $('#teamStrip');
  if (!el) return;
  el.hidden = !st.showTeam;
  if (!st.showTeam) return;
  const lg = board.league;
  const cards = lineupOf(picks().mine, lg);

  const slots = SLOT_ORDER.filter((p) => lg.starters[p] > 0);
  const gaps = [];
  const cells = [];
  for (const pos of slots) {
    const want = lg.starters[pos];
    const got = cards.filter((c) => (pos === 'FLEX' ? c.role === 'FLEX'
      : c.role === 'Starter' && c.r.p.pos === pos));
    for (let i = 0; i < want; i += 1) {
      const c = got[i];
      cells.push(`<span class="slot ${c ? 'filled' : 'empty'}">
<i class="pos ${POSCOL[pos] || ''}">${pos}</i>
<b>${c ? shortName(c.r.p.name) : 'empty'}</b>
${c?.r.p.bye ? `<em>bye ${c.r.p.bye}</em>` : ''}</span>`);
    }
    if (got.length < want) gaps.push([pos, want - got.length]);
  }

  const bench = cards.filter((c) => c.role === 'Bench');
  const benchMax = lg.bench || 0;
  const total = roundsOf(lg);
  const line = gaps.length
    ? `You still need ${joinWords(gaps.map(([p, n]) => needPhrase(p, n)))}.`
    : 'Every starting spot is filled — from here on you are drafting your bench.';

  el.innerHTML = `<div class="teamHead"><b>Your team</b>
<span class="hint">${cards.length} of ${total} picks made</span></div>
<div class="slots">${cells.join('')}</div>
${benchMax ? `<div class="benchLine"><span class="benchLbl">Bench ${bench.length} of ${benchMax}</span>
<span class="benchWho">${bench.length
  ? bench.map((c) => `${posTag(c.r.p.pos)}${shortName(c.r.p.name)}`).join('')
  : '<span class="hint">nobody yet</span>'}</span></div>` : ''}
<p class="teamNeed${gaps.length ? '' : ' done'}">${line}</p>`;
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

// ---------------------------------------------------------------- how you drafted
// A grade for a practice draft, with one hard rule: it is NOT allowed to grade the team.
//
// Grading a draft on outcomes would mean predicting who scores, and predicting who scores
// is the thing that failed four separate ways when it was measured on 2020-2025 - historic
// stats added nothing to the projections, boom rate does not repeat, projection bias does
// not persist, individual beats are not foreseeable. A number claiming to know how this
// roster will do would be a lie with a decimal point on it, and it would be the most
// believed thing in the whole app because it is the only thing shaped like a verdict.
//
// So this grades the DECISIONS, every one of which is a fact available right now:
//
//   1. what was still on the board when you picked, against what you took   (pickShot)
//   2. whether you took a man before his price                              (valueWindow)
//   3. whether you can field a starting lineup                              (needsOf)
//   4. whether your starters are all off in the same week                   (lineupOf)
//   5. whether you followed your own stated preferences                     (fitTags)
//
// Every one of those is measurable, none of them is a forecast, and all five are things a
// person can actually do differently next time. That is what makes the grade worth having.

// Points given up on ONE pick that cost a full mark. Chosen, not measured: 25 points over
// a season is about a point and a half a week, roughly the distance between a starter and
// the man who would replace him. It is a scale for turning points into a mark out of a
// hundred, and the raw points beside it are the number that actually means something.
const GRADE_LOST = 25;
// Starters allowed on one bye week before it counts against you. Two is a week you can
// paper over from the bench; three is a week you lose.
const BYE_OK = 2;

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const clamp100 = (x) => Math.max(0, Math.min(100, Math.round(x)));

// 1. What else was on the board. Inside STAR_BAND nothing was lost - the same rule
// pickCost already states in words on the pick-by-pick table below.
function gradeLeft(mine) {
  const each = [];
  for (const x of mine) {
    const shot = shotFor(x.id);
    if (!shot) continue;
    const gap = shot.gap || 0;
    each.push({ n: x.n, id: x.id, gap, lost: Math.max(0, gap - STAR_BAND), top: shot.top });
  }
  if (!each.length) return null;
  const lost = each.reduce((a, e) => a + e.lost, 0);
  const worst = each.filter((e) => e.lost > 0).sort((a, b) => b.lost - a.lost)[0] || null;
  return {
    score: clamp100(100 * mean(each.map((e) => Math.max(0, 1 - e.lost / GRADE_LOST)))),
    lost: Math.round(lost), counted: each.length,
    clean: each.filter((e) => e.lost === 0).length, worst,
  };
}

// 2. Reaching, in picks, against the value window the board had him in AT THE TIME.
//
// The gate is the board's OWN verdict at that moment - the `kind` pickType wrote on the
// row while you were looking at it - not a fresh cut of my own. That matters twice over.
// Under SLACK picks early is a rounding error and pickType does not call it a reach; past
// REACH_RANGE it does not call it anything at all, because a man that far down the board
// is not being priced yet, he is simply not in range. Those are almost all late bench
// picks, and marking them as the biggest reaches of the draft - which an earlier cut of
// this did, calling a round-13 flier a 54-pick reach - would make the grade harsher than
// the label the app was showing you while you made the pick.
function gradeReach(mine) {
  const each = [];
  let unpriced = 0;
  for (const x of mine) {
    const win = shotFor(x.id)?.win;
    if (!win || win.from == null) continue;
    const early = win.from - x.n;               // + = taken before his window opened
    const reach = win.kind === 'reach';
    if (!reach && win.kind == null && early > SLACK) unpriced += 1;
    each.push({ n: x.n, id: x.id, early, over: reach ? Math.max(0, early - SLACK) : 0 });
  }
  if (!each.length) return null;
  const reaches = each.filter((e) => e.over > 0).sort((a, b) => b.early - a.early);
  return {
    score: clamp100(100 * mean(each.map((e) => Math.max(0, 1 - e.over / REACH_RANGE)))),
    reaches: reaches.length, counted: each.length, unpriced,
    picks: Math.round(reaches.reduce((a, e) => a + e.early, 0)), worst: reaches[0] || null,
  };
}

// 3. Is your bench worth anything?
//
// This replaced "can you field a lineup", which scored 100 on every completed draft and then
// lectured you about it. Of course the slots are full - the draft filled them. It was only
// ever information DURING a draft, and the roster strip on the board does that job now.
//
// The question that actually has an answer after the fact is the one Zach put: a bench body
// is only worth what he beats a free add by, and how often he reaches your lineup at all. A
// second tight end in a one-tight-end league scores on both counts badly - he plays 18% of
// weeks and the tight end you could pick up for nothing is nearly as good. A fourth back
// plays a third of weeks and the free back is 118 points worse. Same bench slot, wildly
// different asset, and this is the number that says so.
//
// An unfilled starting slot has not stopped mattering - it is caught harder than before,
// because an empty slot means a starter's worth of nothing rather than a bench body's.
function gradeBench(cards, lg) {
  const need = needsOf(roster0(cards), lg);
  const bench = cards.filter((c) => c.role === 'Bench');
  if (!bench.length && !need.total) return null;
  // benchVor is already "points over a free add at his position, times his chance of
  // reaching your lineup" - the board's own number, not a second opinion.
  const worth = bench.map((c) => Math.max(0, c.r.benchVor || 0));
  const dead = worth.filter((w) => w < 1).length;
  const total = worth.reduce((a, b) => a + b, 0);
  const best = [...bench].sort((a, b) => (b.r.benchVor || 0) - (a.r.benchVor || 0))[0];
  // Full marks is every bench man beating a free add by something that matters. The scale
  // is deliberately generous - a bench is allowed a flier - and an empty starting slot costs
  // a flat 25 because it is a different order of mistake.
  const per = bench.length ? total / bench.length : 0;
  const score = clamp100(100 * Math.min(1, per / 12) - 25 * need.total);
  const short = Object.entries(need.short).filter(([, v]) => v > 0).map(([p, v]) => `${v} ${p}`);
  if (need.flex > 0) short.push(`${need.flex} flex`);
  return { score, dead, total: Math.round(total), per: Math.round(per), best, short,
    empty: need.total, size: bench.length };
}
const roster0 = (cards) => cards.map((c) => c.r.p);

// 4. Bye weeks among the men who actually start. A clash on the bench is not a problem.
function gradeByes(cards) {
  const starters = cards.filter((c) => c.role !== 'Bench');
  const by = {};
  for (const c of starters) if (c.r.p.bye) (by[c.r.p.bye] ||= []).push(c.r.p.name);
  const bad = Object.entries(by).filter(([, list]) => list.length > BYE_OK)
    .map(([wk, list]) => ({ week: +wk, names: list }))
    .sort((a, b) => b.names.length - a.names.length);
  const excess = bad.reduce((a, x) => a + (x.names.length - BYE_OK), 0);
  return { score: clamp100(100 - 25 * excess), worst: bad[0] || null, starters: starters.length, bad };
}

// 5. Did you follow your own preferences? The tags are fitTags' own answer to "does this
// man match what you said you liked", so this counts them rather than re-deciding.
function gradePrefs(mine) {
  let want = 0;
  let against = 0;
  const missed = [];
  for (const x of mine) {
    const r = rowFor(x.id);
    if (!r?.tags?.length) continue;
    for (const t of r.tags) {
      if (t.match === true) want += 1;
      else if (t.match === false) { against += 1; missed.push(`${r.p.name} — ${t.tag}`); }
    }
  }
  if (!want && !against) return null;           // your sliders are neutral; nothing to follow
  return { score: clamp100(100 * (want / (want + against))), want, against, missed };
}

const GRADE_WORDS = [[85, 'Disciplined'], [70, 'Sound'], [55, 'Loose'], [0, 'Rushed']];
const gradeWord = (n) => (GRADE_WORDS.find(([c]) => n >= c) || [0, 'Rushed'])[1];

function draftGrade(m, lg) {
  const mine = m.log.filter((x) => x.team === m.slot);
  const roster = picks().mine.map((id) => byId(id)).filter(Boolean);
  const cards = lineupOf(picks().mine, lg);
  const parts = {
    left: gradeLeft(mine),
    reach: gradeReach(mine),
    bench: gradeBench(cards, lg),
    byes: gradeByes(cards),
    prefs: gradePrefs(mine),
  };
  const live = Object.values(parts).filter((x) => x && x.score != null).map((x) => x.score);
  const overall = live.length ? Math.round(mean(live)) : null;
  return { parts, overall, word: overall == null ? null : gradeWord(overall), mine };
}

// `data` is for the test suite, not the screen: "No reaches" is the right wording for a
// person and a useless thing to assert on, so the count it stands for is carried where a
// machine can read it without the prose having to change shape.
const gradeCard = (label, score, head, why, data = '') => `<div class="gradeCard"${data}>
<span class="gradeN ${score >= 85 ? 'up' : score >= 55 ? '' : 'dn'}">${score}</span>
<span class="gradeL">${label}</span>
<b>${head}</b><span class="gradeWhy">${why}</span></div>`;

function gradeHTML(m, lg) {
  const g = draftGrade(m, lg);
  if (g.overall == null) return '';
  const { left, reach, bench, byes, prefs } = g.parts;
  const nm = (id) => esc(byId(id)?.name || 'that pick');
  const cards = [];

  if (left) {
    cards.push(gradeCard('Points left on the board', left.score,
      left.lost === 0 ? 'Nothing left behind' : `${left.lost} points left behind`,
      `On ${left.clean} of your ${left.counted} picks, nothing better than the man you took `
      + `was sitting there. ${left.worst
        ? `The one that cost most was pick ${left.worst.n} — your board had `
          + `${esc(left.worst.top?.name || 'someone')} ${Math.round(left.worst.gap)} points higher.`
        : 'You took the best man on your own board, or something level with him, every time.'} `
      + `Anything under ${STAR_BAND} points apart is counted as nothing lost, because on this `
      + 'board that really is a coin flip.'));
  }
  if (reach) {
    const aside = reach.unpriced
      ? ` ${reach.unpriced === 1 ? 'One pick was' : `${reach.unpriced} picks were`} so far down `
        + `the board that it had no price for ${reach.unpriced === 1 ? 'him' : 'them'} at all — `
        + 'late bench men, mostly — and those count neither for nor against you.'
      : '';
    cards.push(gradeCard('Taking men before their price', reach.score,
      reach.reaches === 0 ? 'No reaches' : `${reach.reaches} reach${reach.reaches === 1 ? '' : 'es'}`,
      (reach.reaches === 0
        ? `Not one of your ${reach.counted} picks was a man your own board would have called `
          + 'a Reach at the moment you took him, so you never paid a pick you did not have to.'
        : `${reach.picks} picks early in total. The biggest was ${nm(reach.worst.id)} at pick `
          + `${reach.worst.n}, ${Math.round(reach.worst.early)} picks before his window opened. `
          + 'Reaching is not automatically wrong — it is how you make sure of a man you want — '
          + `but each one is a pick spent earlier than it needed to be. Under ${SLACK} picks `
          + 'early is a rounding error and is not counted.') + aside,
    ` data-reaches="${reach.reaches}" data-unpriced="${reach.unpriced}"`));
  }
  if (bench) {
    cards.push(gradeCard('What your bench is worth', bench.score,
      bench.empty
        ? `${bench.empty} starting slot${bench.empty === 1 ? '' : 's'} empty`
        : bench.dead === 0 ? 'Every bench man earns his slot'
          : `${bench.dead} of ${bench.size} doing nothing`,
      (bench.empty
        ? `You finished with no ${bench.short.join(', no ')}, which costs more than any bench `
          + 'question — an empty slot scores zero every week. '
        : '')
      + `A bench player is only worth what he beats a free add by, times how often he `
      + `actually reaches your lineup. Yours average ${bench.per} points on that measure`
      + `${bench.best ? `, the best of them ${esc(bench.best.r.p.name)}` : ''}. `
      + `${bench.dead
        ? `${bench.dead === 1 ? 'One' : bench.dead} of them beat nothing you could not have `
          + 'picked up for free during the season — a second man at a position you only start '
          + 'one of is the usual culprit.'
        : 'None of them is a man you could have replaced off waivers for nothing.'}`,
      ` data-dead="${bench.dead}" data-empty="${bench.empty}"`));
  }
  cards.push(gradeCard('Bye weeks among your starters', byes.score,
    byes.worst
      ? `${byes.bad.length === 1 ? `Week ${byes.worst.week}` : `${byes.bad.length} bad weeks`}: `
        + `${byes.worst.names.length} out`
      : 'No bad weeks',
    byes.worst
      ? `${byes.bad.map((x) => `Week ${x.week} takes out ${x.names.map(esc).join(', ')}`)
        .join('. ')}. More than ${BYE_OK} starters on one bye is a week you lose rather than `
        + 'a week you paper over from the bench.'
      : `No week takes more than ${BYE_OK} of your ${byes.starters} starters out at once.`));
  if (prefs) {
    cards.push(gradeCard('Following your own preferences', prefs.score,
      `${prefs.want} for, ${prefs.against} against`,
      `Counting the labels on the men you took: ${prefs.want} matched what you said you `
      + `liked on the Ratings page and ${prefs.against} cut against it. ${prefs.against
        ? `The ones that went the other way: ${prefs.missed.slice(0, 3).map(esc).join('; ')}`
          + `${prefs.missed.length > 3 ? '…' : ''}. ` : ''}`
      + 'Neither is right or wrong — this only asks whether the draft you made matches the '
      + 'draft you said you wanted.'));
  }
  const noPrefs = prefs ? '' : `<p class="gradeAside">Your four preference sliders are all
sitting in the middle, so there was nothing of your own for this draft to follow or ignore —
that measure is left out of the mark rather than guessed at. Move them on the
<b>Ratings</b> tab and run another practice draft to see whether you actually draft the way
you say you want to.</p>`;

  return `<h2 class="h2">How you drafted</h2>
<div class="gradeTop">
<span class="gradeBig"><b>${g.overall}</b><i>out of 100</i></span>
<span class="gradeSay"><b>${g.word}</b>
<span>This is a grade for the ${g.mine.length} decisions you made, averaged across the
measures below. It is not a score for your team.</span></span>
</div>
<p class="gradeWarn"><b>This says how you drafted, not how your team will do.</b> Nobody can
grade a draft on results — who scores this season is the one thing that could not be
predicted when it was tested against five years of real data, and a number here pretending
otherwise would be the most believed and least honest thing in the app. What it can measure,
and what all of it is, is your decisions: what was on the board when you picked, whether you
paid before you had to, whether you can put out a lineup, and whether you did what you said
you wanted to do. A perfect 100 here would not mean you will win. It would mean you drafted
tidily.</p>
<div class="gradeCards">${cards.join('')}</div>
${noPrefs}`;
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
  if ($('#batchSlot')) {
    $('#batchSlot').max = teamsOf(lg);
    // Defaults to your real seat, because "is the board consistent from where I actually
    // pick" is the only version of the question worth asking first.
    if (!$('#batchSlot').value) $('#batchSlot').value = st.slots?.[st.league] ?? 1;
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
  const best = [...called].sort((a, b) => (b.n - b.adp) - (a.n - a.adp))[0];
  // The verdicts, in pick order, off the records taken as each pick was made.
  const costs = costList(mineLog.map((x) => x.id));
  const byPick = new Map(costs.map((c) => [c.id, c]));
  const wasted = costs.filter((c) => c.v.kind === 'wasted');
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

  out.innerHTML = `<h2 class="h2">What happened</h2>
<p class="mockLede">You drafted from <b>slot ${m.slot} of ${teamsOf(lg)}</b> against a room that
${roomWord(m.disc)}. ${whose} ${short.length
    ? `<b class="bad">You finished without a full starting lineup — no ${short.join(', no ')}.</b>
That is the one mistake worth avoiding: an empty slot scores zero every week.`
    : '<b class="good">You filled every starting slot.</b>'}
${best && best.n - best.adp >= 6
    ? ` Your best bit of business was <b>${byId(best.id)?.name}</b>, who lasted
${Math.round(best.n - best.adp)} picks past his usual spot.` : ''}
${wasted.length
    ? ` The one thing that went wrong: <b>${wasted.map((c) => c.p.name).join('</b>, <b>')}</b>
— ${wasted.length === 1 ? 'he was' : 'they were'} still going to be there next time round,
and waiting would have got you somebody else as well.`
    : ' <b class="good">No pick of yours was spent on a man who was going to be there anyway.</b>'}</p>

<div class="cards">${costCards(costs)
+ costCard('Starting slots', short.length ? `${need.total} empty` : 'Full', 'Empty slots score nothing.')}</div>

${gradeHTML(m, lg)}

<h2 class="h2">Every pick you made</h2>
<div class="board costPicks">
<div class="row head costPick"><span>Pick</span><span>Player</span><span>Your board</span>
<span>The room</span><span>What it cost</span></div>
${mineLog.map((x) => {
    const c = byPick.get(x.id);
    if (!c) return '';
    const { p, shot, v, mkt } = c;
    return `<div class="row costPick">
<span class="num">${x.n}</span>
<span class="who">${posTag(p.pos)}<span class="nm">${p.name}
<span class="tm">${p.team || ''}</span></span>${x.by === 'app' && auto < mineLog.length
      ? '<span class="autoMark" title="The app made this pick">auto</span>' : ''}</span>
<span class="ourRk">${shot ? `#${shot.me.rank}<span class="tm"> · ${Math.round(shot.me.score)}</span>` : '—'}</span>
<span class="num">${x.adp ? x.adp.toFixed(0) : '—'}</span>
<span class="cost ${COST_TONE[v.kind]}"><b>${v.head}</b></span>
<span class="costWhy">${v.why}${mkt ? ` <span class="mkt">${mkt}</span>` : ''}</span></div>`;
  }).join('')}</div>
<p class="hint"><b>Your board</b> is where your own ratings had him at that moment and what
they scored him. <b>The room</b> is where the rest of the fantasy world usually takes him.
Taking somebody earlier than the room does is not a mistake — it is the whole reason to
have ratings of your own. The only thing counted against you here is spending a pick on a
man who was not going anywhere while somebody you wanted more went to another team.</p>

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
    // A fresh import replaces every real league, sample league included - but not a mock
    // you are following. That is not one of your leagues, it came from a link, and
    // re-importing would silently drop it mid-draft.
    const kept = (st.imported || []).filter((l) => l.follow);
    st.imported = [...leagues, ...kept];
    data.leagues = [...st.imported];
    st.league = 0;
    // The kept mocks have moved along the list, so their ticked-off players belong to
    // whatever league now sits at that index. Clear them rather than mix two drafts up;
    // an auto-sync puts a live one back within seconds.
    for (let i = leagues.length; i < data.leagues.length; i++) {
      st.picks[i] = { drafted: [], mine: [] };
      if (st.clockAt) delete st.clockAt[i];
    }
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
    const slot = st.slots?.[st.league] ?? lg.slot ?? null;
    const list = await draftPicks(lg.draft_id, st.sleeperId, lg.rosterId, slot);
    if (!list.length) {
      return msg('#syncMsg', lg.follow
        ? 'That mock has not started yet. Leave auto-sync running and it will pick up the '
          + 'moment the first pick is made.'
        : 'The draft has not started — no picks yet.');
    }
    const known = new Set(data.players.map((p) => p.id));
    const pk = picks();
    let added = 0;
    let claimed = 0;
    let skipped = 0;
    // The pick on the clock is Sleeper's pick_no, NOT how many players we managed to tick
    // off. Those two are the same number only if every man taken is on our board, and over
    // sixteen rounds he is not - a deep-bench tight end nobody projects gets skipped here
    // and the clock silently runs a pick or two behind for the rest of the draft. Which is
    // the one number the whole recommendation is built on.
    // In the order they were made. Sleeper does not promise one, and the cost snapshots
    // below reconstruct the board pick by pick, so the order is load-bearing.
    list.sort((a, b) => (a.pick || 0) - (b.pick || 0));
    st.clockAt ||= {};
    // Read BEFORE anything else, because taking snapshots winds this value backwards as
    // scratch. Comparing against it afterwards would be comparing against ourselves.
    const wasAt = st.clockAt[st.league];

    let upto = 0;
    const onBoard = [];                     // the picks we actually carry, in pick order
    for (const p of list) {
      if (p.pick > upto) upto = p.pick;
      if (!known.has(p.playerId)) { skipped += 1; continue; }
      onBoard.push(p);
    }
    for (const p of onBoard) {
      if (!pk.drafted.includes(p.playerId)) { pk.drafted.push(p.playerId); added += 1; }
      if (p.mine && !pk.mine.includes(p.playerId)) { pk.mine.push(p.playerId); claimed += 1; }
    }

    // "What it cost" is a snapshot of the board as it stood BEFORE a pick: who else was
    // there, and who you could still have had instead. That snapshot was only ever taken by
    // the manual Mine button, so every pick arriving through the sync read "Not recorded" -
    // and following a live draft is precisely the case where you are NOT pressing that
    // button. The report was blank in the one situation it exists for.
    //
    // It cannot be taken after the fact from the finished board, so it is reconstructed:
    // for each pick of ours with no snapshot, the drafted and mine lists are wound back to
    // exactly who had gone before that pick number, the board is re-scored in that state,
    // and the snapshot is taken there. Which also means joining a draft late still gets you
    // costs for the picks you made before you attached.
    //
    // Bounded by your own picks - sixteen in a full draft - and each one is stamped once.
    const key = `${lg.draft_id}:`;
    const todo = onBoard.filter((p) => p.mine && !shotFor(p.playerId)
      && !stampTried.has(key + p.playerId));
    if (todo.length) {
      const finalDrafted = [...pk.drafted];
      const finalMine = [...pk.mine];
      for (const p of todo) {
        stampTried.add(key + p.playerId);
        pk.drafted = onBoard.filter((x) => x.pick < p.pick).map((x) => x.playerId);
        pk.mine = onBoard.filter((x) => x.pick < p.pick && x.mine).map((x) => x.playerId);
        st.clockAt[st.league] = Math.max(0, (p.pick || 1) - 1);
        rescore();
        tickClock();
        stampShot(p.playerId);
      }
      pk.drafted = finalDrafted;
      pk.mine = finalMine;
    }
    // Did anything actually move? A poll that brings nothing new must do NOTHING - the old
    // code rescored 250 players and rewrote every row on a timer whether or not a pick had
    // been made, which is both wasted work and actively disruptive, because it fights your
    // scroll position and anything you are typing.
    //
    // "Nothing new" has to mean nothing, so all three ways the draft can move are counted:
    //
    //   added    a player came off the board                -> the pool changed
    //   claimed  a player was recognised as YOURS           -> your roster and needs changed
    //   upto     the pick number advanced                   -> everyone's odds of lasting
    //            (this one fires even when the man taken is not on our board at all, and it
    //            has to: waiting eight more picks changes the recommendation even if every
    //            one of them was spent on a player we do not carry)
    //
    // Any of the three and the board is rebuilt in full, exactly as before - same rescore,
    // same recommendation, same cost of waiting. The only thing that got faster is the case
    // where the answer would have been identical.
    const moved = added > 0 || claimed > 0 || wasAt !== upto;
    st.clockAt[st.league] = upto;
    if (moved) {
      lastChange = Date.now();
      save();
      rebuild();
    }
    st.lastSync = Date.now();
    renderSyncLive();
    $('#syncClock').textContent = `synced ${new Date().toLocaleTimeString()} · `
      + `every ${Math.round(syncEvery() / 1000)}s`;
    msg('#syncMsg', `pick ${upto + 1} on the clock — ${list.length} gone, `
      + `${pk.mine.length} yours.`
      + (skipped ? ` ${skipped} not in the player pool — deep bench, safe to ignore.` : '')
      + (lg.follow && !slot ? ' Set your draft slot on the Board tab so it knows which '
        + 'picks are yours.' : ''), 'good');
    return moved;
  } catch (e) {
    msg('#syncMsg', e instanceof SleeperError ? e.message : `Sync failed: ${e.message}`, 'bad');
  }
  return false;
}

// Follow a Sleeper mock draft by its link.
//
// A mock arrives as one more league in the dropdown rather than as a mode of its own. That
// is the whole trick: once it is a league, the board, the clock, the Type column, cost of
// waiting and the recommendation all work on it without knowing anything has changed.
async function doFollow() {
  const id = parseDraftId($('#followUrl').value);
  if (!id) {
    return msg('#followMsg', 'That does not look like a Sleeper draft link. It should look '
      + 'like https://sleeper.app/draft/nfl/1394053712187506688 — open the mock on Sleeper '
      + 'and copy the address bar.', 'bad');
  }
  msg('#followMsg', 'Reading that draft…');
  try {
    const lg = await followDraft(id, data.scoreKeys, st.sleeperId);
    st.imported = [...(st.imported || [])];
    const at = st.imported.findIndex((l) => l.draft_id === lg.draft_id);
    if (at >= 0) {
      // re-following refreshes the settings and keeps whatever is already ticked off
      st.imported[at] = { ...lg, slot: lg.slot ?? st.imported[at].slot ?? null };
      st.league = at;
    } else {
      st.imported.push(lg);
      st.league = st.imported.length - 1;
    }
    data.leagues = [...st.imported];
    st.picks[st.league] ||= { drafted: [], mine: [] };
    st.slots ||= {};
    if (lg.slot) st.slots[st.league] = lg.slot;
    save();
    renderChrome();
    rebuild();
    const shape = Object.entries(lg.starters).map(([k, v]) => `${v}${k}`).join(' · ');
    msg('#followMsg', `Following ${lg.name} — ${lg.teams} teams, ${lg.rounds || '?'} rounds, `
      + `${shape}. ${lg.scoringFrom
        ? `Scoring came across from ${lg.scoringFrom}.`
        : lg.srcBlocked
          ? 'That mock was made from a league Sleeper would not let the board read — most '
            + 'likely a private one, or one you are not in. Scoring is ordinary PPR-style '
            + 'rules, so if that league pays bonuses the ratings will be a little off.'
          : 'Sleeper only publishes one word of scoring for a standalone mock, so the board '
            + 'is using ordinary scoring — no bonuses, no fines.'} `
      + `${lg.slot ? `You are in seat ${lg.slot}.` : 'Set your draft slot on the Board tab.'} `
      + 'Then press Start auto-sync above.', 'good');
  } catch (e) {
    msg('#followMsg', e instanceof SleeperError ? e.message : `Could not read it: ${e.message}`, 'bad');
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

// How often to ask Sleeper.
//
// Sleeper has no push, so following a draft means polling, and the old fixed eight-second
// interval was wrong in both directions at once. Too slow, because a room on autopick fires
// four picks in two seconds and you sat up to eight seconds behind a board that had already
// moved. Too expensive, because every single poll called rebuild() whether or not anything
// had happened.
//
// Fixed by splitting the two concerns. Ask often while the room is moving; ease off when it
// is not; and do no work at all on a poll that brings nothing new. That makes the fast case
// cheaper than the old slow one - four polls a minute that each rescored the board, against
// thirty that mostly parse a small JSON array and stop.
const SYNC_FAST = 2000;          // a pick every two seconds is faster than anyone can read
const SYNC_EASY = 6000;
const SYNC_IDLE = 20000;
const QUIET_EASY = 30000;        // nothing new for this long and the room is between picks
const QUIET_IDLE = 180000;       // this long and it is paused, or waiting for a human
let lastChange = 0;
let auto = false;
// Picks we have already tried to take a cost snapshot for. A pick the planner cannot place
// - too deep in the pool to have been one of the candidates it considered - yields no
// snapshot, and without this it would be retried, at one full rescore a time, on every
// single poll for the rest of the draft.
const stampTried = new Set();

// Is it following, and how fresh is the board? On the board, where you actually are.
function renderSyncLive() {
  const el = $('#syncLive');
  if (!el) return;
  if (!auto) { el.className = 'syncLive'; el.textContent = ''; return; }
  const ago = st.lastSync ? Math.round((Date.now() - st.lastSync) / 1000) : null;
  el.className = 'syncLive on';
  el.textContent = `following · ${ago == null ? 'asking…'
    : ago < 3 ? 'up to date' : `${ago}s ago`}`;
}

function syncEvery() {
  const quiet = Date.now() - lastChange;
  if (quiet > QUIET_IDLE) return SYNC_IDLE;
  if (quiet > QUIET_EASY) return SYNC_EASY;
  return SYNC_FAST;
}

function scheduleSync() {
  if (!auto) return;
  timer = setTimeout(async () => {
    timer = null;
    // A hidden tab is throttled by the browser anyway, so polling one buys nothing and
    // just spends somebody's battery. The visibility handler below catches straight up on
    // the way back, so you never return to a stale board.
    //
    // Tested against visibilityState, NOT document.hidden. `hidden` is also true while a
    // page is prerendering, which is not the same thing as being in a background tab - a
    // prerendered page that never polls would come up blank and stay blank. (jsdom reports
    // exactly that state, which is how this was caught.)
    if (document.visibilityState !== 'hidden') await doSync();
    scheduleSync();
  }, syncEvery());
  // one chain at a time: an await longer than the interval used to let setInterval stack
  // overlapping requests, which is how the pick count could briefly go backwards
}

function toggleAuto() {
  const b = $('#syncAuto');
  if (auto) {
    auto = false;
    if (timer) { clearTimeout(timer); timer = null; }
    b.textContent = 'Start auto-sync';
    b.setAttribute('aria-pressed', 'false');
    renderSyncLive();
    return msg('#syncMsg', 'Auto-sync stopped.');
  }
  auto = true;
  lastChange = Date.now();          // start in the fast band, not the idle one
  b.textContent = 'Stop auto-sync';
  b.setAttribute('aria-pressed', 'true');
  renderSyncLive();                 // say "following" before the first answer comes back
  doSync().then(scheduleSync);
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
  anchorReadout();
  st.cols ||= { bye: true };
  // The 2025 columns stay exactly where they are and keep their full width - they are how
  // a person recognises a player, and hiding them would make the board a list of strangers.
  // The only thing added is a note saying which way round they work: they describe last
  // season, they do not predict this one, and nothing in the score is built on them.
  const GROUP_NOTE = {
    pg: 'Describes last season. It is not part of his score and does not predict 2026 — '
      + 'it is here so you can recognise the player.',
    tot: 'Describes last season. It is not part of his score and does not predict 2026 — '
      + 'it is here so you can recognise the player.',
  };
  const groups = GROUPS.map(([k, label]) => `<label class="chip"${
    GROUP_NOTE[k] ? ` title="${esc(GROUP_NOTE[k])}"` : ''}>
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
  if ($('#noQb2')) $('#noQb2').checked = !!st.noQb2;
  const dur = $('#durAnchor');
  if (dur) {
    const now = st.durAnchor || DUR_DEFAULT;
    if (!dur.options.length) {
      dur.innerHTML = DUR_ANCHORS.map((x) => `<option value="${x.key}">${x.short}</option>`).join('');
    }
    dur.value = now;
    const a = durAnchor(now);
    const games = board?.games;
    // The stop, then what it actually works out to, because "an average amount" means
    // nothing until you are told it is 14 games out of 17.
    const num = games && now !== 'full'
      ? ` Works out to about ${(games.league ?? FULL_GAMES).toFixed(0)} games of ${FULL_GAMES}`
      + `${now === 'typical' ? ' for everybody' : ' on average'}.` : '';
    $('#durHint').textContent = `${a.blurb}${num}`;
  }
  const tb = $('#teamBtn');
  if (tb) tb.setAttribute('aria-expanded', String(!!st.showTeam));
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
  // Read off the plan, not off a second sum. This used to call costOfWaiting, which prices
  // a position at your NEXT pick only - so it sat directly under the recommendation
  // quoting a different number for the same English phrase, and on one board it said
  // "receivers are the scarce thing, so backs can wait" immediately below "Take RB".
  // Same field the pills and the reason sentence use now.
  const res = planDraft(board.rows, clock, drafted, board.league, have,
    { candidates: 10, horizon: PLAN_HORIZON, caps: myCaps() });
  if (!res) { box.innerHTML = ''; return; }
  const s = suggestLean(res.cost.map((c) => ({ pos: c.pos, cost: c.gap })));
  const on = activeLean(st) || 'custom';
  if (!s) { box.innerHTML = ''; return; }
  const rec = LEANS.find((l) => l.key === s.key);
  // A reading, not a control. There used to be four buttons here that set position
  // multipliers by hand. They were a second way to move the board that competed with the
  // board's own reasoning, and the reading beside them already said which one the evidence
  // pointed at - so the buttons only ever offered you the chance to disagree with a
  // recommendation you had just been given, using a number nobody could interpret.
  //
  // What the reading is: the cost of waiting at each position, worked out from your draft
  // slot and who has already gone. It moves as the board empties, which is exactly why it
  // could never be a setting you pick once and leave.
  box.innerHTML = `<div class="leanHead">
<span class="leanTag">Board reading</span>
<b>${rec.name}</b><span class="hint">${s.why}</span></div>
${rec.blurb ? `<p class="leanWhy">${rec.blurb}</p>` : ''}`;
}

// The two costs of anchoring, on the screen next to the control that buys them. Both are
// real, both are invisible if nobody writes them down, and the second one gets worse the
// further the slider goes - so the warning is conditional and the plain line is not.
function anchorReadout() {
  const el = $('#anchor');
  if (!el) return;
  const dial = st.anchor ?? ANCHOR_DEFAULT;
  const pct = Math.round(dial * 100);
  el.value = pct;
  $('#anchorOut').textContent = `${pct}%`;
  const hint = $('#anchorHint');
  if (!hint) return;
  const stream = Math.round(dial * ANCHOR_CASES.stream * 100);
  const known = Math.round(dial * ANCHOR_CASES.known * 100);
  // Not one number, because it is not one number. Saying "70%" flat would be the blunt
  // instrument this was built to avoid, and the whole point is that it lands differently
  // on a defence than on a receiver.
  let s = dial <= 0
    ? 'Off. Your projections alone decide the board, including kickers and defences, where '
    + 'the board has no honest replacement level to work from and gets them badly wrong.'
    : `Where everybody else is drafting counts for ${stream}% on kickers and defences, `
    + `about half that on a man with no last season, and ${known}% on everyone else. `
    + 'The cost: your league pays for first downs and long catches and the rest of the '
    + 'world does not, so the more the room counts, the less of that edge you keep.';
  // The real figure for the pool in front of you, not the dial position. It is much lower
  // than the dial, because most of the board is established players who barely feel this.
  const reach = board ? anchorReach(board.rows, st) : 0;
  if (reach > STEAL_DILUTION) {
    s += ` Careful this high — the room is now ${Math.round(reach * 100)}% of your whole `
      + 'board, and "steal" and "reach" are measured against where the room drafts, so '
      + 'those two labels are largely comparing it with itself.';
  }
  hint.textContent = s;
}

function readouts() {
  // #styleOut2 and #tiltOut2 were written to here for weeks after the elements they name
  // were deleted from index.html along with the rest of the ratings editor. Guarded, so
  // they never threw - which is exactly why nobody noticed.
  $('#needOut').textContent = st.need;
  anchorReadout();
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
    stampShot(r.p.id);
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
  // This one is remembered, unlike the two panels above it. Whether you want your roster
  // on screen is a way of working, not a thing you open and close.
  $('#teamBtn').onclick = (e) => {
    st.showTeam = !st.showTeam;
    e.target.setAttribute('aria-expanded', String(!!st.showTeam));
    save();
    renderTeamStrip();
  };
  $('#cmpBtn').onclick = (e) => {
    const p = $('#cmpPanel');
    p.hidden = !p.hidden;
    e.target.setAttribute('aria-expanded', String(!p.hidden));
    renderCompare();
  };
  $('#cmpA').onchange = (e) => { cmpA = e.target.value || null; renderCompare(); };
  $('#cmpB').onchange = (e) => { cmpB = e.target.value || null; renderCompare(); };
  $('#cmpSwap').onclick = () => { [cmpA, cmpB] = [cmpB, cmpA]; renderCompare(); };
  $('#cmpClear').onclick = () => { cmpA = null; cmpB = null; renderCompare(); };
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
    if (st.clockAt) delete st.clockAt[st.league];   // or the clock keeps a cleared board's pick number
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
    ['anchor', (v) => { st.anchor = +v / 100; }],
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
  if ($('#batchRun')) $('#batchRun').onclick = doBatch;
  if ($('#batchCsv')) {
    $('#batchCsv').onclick = () => {
      if (!lastBatch) return;
      saveFile(`drafts-slot${lastBatch.slot}-x${lastBatch.n}-`
        + `${stampFor(lastBatch.league)}-${today()}.csv`, 'text/csv', batchCsv(lastBatch));
    };
  }
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
  // Coming back to the tab is the one moment you are certain to be behind, so catch up
  // immediately rather than waiting out whatever interval the backoff had settled on.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' || !auto) return;
    if (timer) { clearTimeout(timer); timer = null; }
    doSync().then(scheduleSync);
  });
  $('#followBtn').onclick = doFollow;
  $('#dryBtn').onclick = doDryRun;
  $('#hideGone').onchange = (e) => { st.hideGone = e.target.checked; save(); renderBoard(); };
  if ($('#noQb2')) {
    $('#noQb2').onchange = (e) => { st.noQb2 = e.target.checked; save(); rebuild(); };
  }
  // Changing the assumption changes what every bench player is worth, so this rebuilds the
  // board rather than just repainting it.
  const durSel = $('#durAnchor');
  if (durSel) {
    // renderChrome as well as rebuild: the hint under the dial spells out what the stop you
    // just picked works out to in games, and that line lives in the chrome rather than on
    // the board. rebuild() alone left it describing the setting you had a moment ago.
    durSel.onchange = (e) => {
      st.durAnchor = e.target.value; save(); rebuild(); renderChrome();
    };
  }

  // ratings profile as a file, so you and someone else can keep different ones.
  //
  // This wrote { comp, sub, style, tilt, need, rookie } - the knobs of the fifty-stat
  // editor - while the importer next to it read { fit, fitExtra, need, rookie, posx }.
  // Not one key overlapped except need and rookie, so "Export my preferences" saved a file
  // that did not contain a single one of the four sliders, and importing it silently reset
  // them all to neutral. Export now writes exactly what import reads, which is the only
  // arrangement that cannot drift apart again. `anchor` is on the list for the same
  // reason `need` is: it is a control on the Settings panel, so it is a preference, and a
  // preferences file that quietly leaves one out is the bug described above happening again.
  $('#exportR').onclick = () => {
    const { fit, fitExtra, fitOn, need, anchor, rookie, posx, stars, fades } = st;
    const blob = new Blob([JSON.stringify({ kind: 'draft2026-ratings',
      fit, fitExtra, fitOn, need, anchor, rookie, posx, stars, fades }, null, 2)],
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
        need: o.need ?? st.need, anchor: o.anchor ?? st.anchor,
        rookie: o.rookie ?? st.rookie, posx: o.posx || st.posx,
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
      // The panel answers "who is the best one of these" now, so it has to hear about the
      // filter. Without this the position answer only appeared after some unrelated event
      // happened to redraw the advice.
      renderAdvice();
    } else if (b.dataset.cmp) { compareWith(b.dataset.cmp); }
    else if (b.dataset.open) { open = open === b.dataset.open ? null : b.dataset.open; renderBoard(); }
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
      stampShot(b.dataset.m);
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
