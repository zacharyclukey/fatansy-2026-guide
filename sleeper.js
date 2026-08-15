// Talking to Sleeper straight from the browser.
//
// This is the one part of the app that needs the network, and it is the one part I could
// not test before it was live: the sandbox this was built in cannot reach api.sleeper.app
// at all. So everything here assumes it might fail, says so plainly when it does, and
// leaves the board working either way - the player pool is baked into data/players.json,
// so a Sleeper outage costs you league import and live picks, nothing else.

const API = 'https://api.sleeper.app/v1';

export class SleeperError extends Error {
  constructor(msg, kind) { super(msg); this.kind = kind; }
}

async function get(path) {
  let res;
  try {
    res = await fetch(API + path);
  } catch (e) {
    // A blocked cross-origin request and a dead connection look the same from here -
    // the browser refuses to tell a page why, on purpose.
    throw new SleeperError(
      'Could not reach Sleeper. Either you are offline, or your browser blocked the '
      + 'request because Sleeper does not allow other sites to read it.', 'blocked');
  }
  if (res.status === 404) throw new SleeperError('Sleeper has no record of that.', 'notfound');
  if (!res.ok) throw new SleeperError(`Sleeper answered ${res.status}.`, 'http');
  return res.json();
}

export const getUser = (name) => get(`/user/${encodeURIComponent(name.trim())}`);
export const getLeagues = (userId, season) => get(`/user/${userId}/leagues/nfl/${season}`);
export const getDraft = (draftId) => get(`/draft/${draftId}`);
export const getPicks = (draftId) => get(`/draft/${draftId}/picks`);
export const getRosters = (leagueId) => get(`/league/${leagueId}/rosters`);
export const getLeague = (leagueId) => get(`/league/${leagueId}`);

// Sleeper's roster_positions is a flat list with one entry per slot, bench included.
function starters(rosterPositions = []) {
  const out = {};
  let bench = 0;
  for (const p of rosterPositions) {
    if (p === 'BN') { bench += 1; continue; }
    if (p === 'IR' || p === 'TAXI') continue;
    const key = p === 'SUPER_FLEX' ? 'FLEX' : p === 'WRRB_FLEX' || p === 'REC_FLEX' ? 'FLEX' : p;
    out[key] = (out[key] || 0) + 1;
  }
  return { starters: out, bench };
}

// Only the keys the rating engine knows how to multiply. Anything exotic in a league's
// scoring is dropped rather than silently mis-scored, and reported so it is not a surprise.
export function scoringFor(settings, known) {
  const scoring = {};
  const ignored = [];
  for (const [k, v] of Object.entries(settings || {})) {
    if (!v) continue;
    if (known.includes(k)) scoring[k] = v;
    else ignored.push(k);
  }
  return { scoring, ignored };
}

export async function importLeagues(username, season, scoreKeys) {
  const user = await getUser(username);
  if (!user?.user_id) throw new SleeperError(`No Sleeper account called "${username}".`, 'notfound');
  const raw = await getLeagues(user.user_id, season);
  if (!raw?.length) {
    throw new SleeperError(`${username} has no ${season} leagues on Sleeper yet.`, 'empty');
  }

  const leagues = [];
  for (const L of raw) {
    const { starters: s, bench } = starters(L.roster_positions);
    const { scoring, ignored } = scoringFor(L.scoring_settings, scoreKeys);
    // Which roster is yours. Needed because an AUTODRAFTED pick can come back with an
    // empty picked_by - if we only matched on that, every pick made while you were on
    // autopick would look like somebody else's. It also gives a second route to your slot.
    let rounds = null;
    let slot = null;
    let when = null;
    let rosterId = null;
    try {
      const rosters = await getRosters(L.league_id);
      rosterId = (rosters || []).find((r) => r.owner_id === user.user_id)?.roster_id ?? null;
    } catch { /* not fatal - picked_by still covers manual picks */ }

    try {
      const d = await getDraft(L.draft_id);
      rounds = d?.settings?.rounds ?? null;
      // draft_order only exists once the commissioner has actually set the order. Before
      // that Sleeper genuinely does not know where you are picking, so neither can we.
      slot = d?.draft_order?.[user.user_id] ?? null;
      if (!slot && d?.slot_to_roster_id) {
        // some drafts publish the slot->roster mapping first; that is enough to find yours
        const mine = Object.entries(d.slot_to_roster_id)
          .find(([, rid]) => rid === rosterId);
        slot = mine ? Number(mine[0]) : null;
      }
      when = d?.start_time ? new Date(d.start_time).toLocaleString() : null;
    } catch { /* the draft may not exist yet - that is fine, the league still imports */ }
    leagues.push({
      name: L.name,
      league_id: L.league_id,
      draft_id: L.draft_id,
      teams: L.total_rosters,
      rounds,
      draft: when,
      slot,
      starters: s,
      bench,
      rosterId,
      scoring,
      ignored,
      imported: true,
    });
  }
  return { userId: user.user_id, leagues };
}

// ------------------------------------------------------------------ mock drafts
// A mock draft is not a league. It has no rosters, usually no league_id of its own, and
// before it starts it does not even know who is sitting in which seat. So none of the
// username-based import above can reach one - you get at it by its link and nothing else.
//
// Everything a mock DOES publish is in the draft object itself: how many teams, how many
// rounds, and one `slots_*` count per lineup position. That is enough to score a board.

// Accepts a pasted link in any of the shapes Sleeper hands out, or a bare id.
export function parseDraftId(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^\d{6,}$/.test(s)) return s;
  const m = s.match(/\/draft\/(?:[a-z]+\/)?(\d{6,})/i);
  return m ? m[1] : null;
}

// Sleeper's draft settings carry one count per lineup slot. The flex family has four
// different names for what the engine treats as one thing, and the IDP slots have no
// projections behind them at all, so they are dropped rather than scored as zero.
const SLOT_KEYS = {
  slots_qb: 'QB', slots_rb: 'RB', slots_wr: 'WR', slots_te: 'TE',
  slots_k: 'K', slots_def: 'DEF',
  slots_flex: 'FLEX', slots_super_flex: 'FLEX',
  slots_wrrb_flex: 'FLEX', slots_rec_flex: 'FLEX',
};
export function slotsFromSettings(settings = {}) {
  const out = {};
  for (const [k, pos] of Object.entries(SLOT_KEYS)) {
    const n = Number(settings[k]) || 0;
    if (n > 0) out[pos] = (out[pos] || 0) + n;
  }
  return { starters: out, bench: Number(settings.slots_bn) || 0 };
}

// A mock only tells you "ppr", "half_ppr" or "std" - one word where a real league gives
// forty numbers. So this is the ordinary scoring everyone uses, with the one number that
// word actually decides filled in. It is a fallback and the UI says so: a league that pays
// bonuses or fines mistakes will not be reproduced by it.
const PLAIN = {
  pass_yd: 0.04, pass_td: 4, pass_int: -1, pass_2pt: 2,
  rush_yd: 0.1, rush_td: 6, rush_2pt: 2,
  rec_yd: 0.1, rec_td: 6, rec_2pt: 2, fum_lost: -2,
};
export function standardScoring(type, known = []) {
  const rec = type === 'std' ? 0 : type === 'half_ppr' ? 0.5 : 1;
  const all = { ...PLAIN, ...(rec ? { rec } : {}) };
  const out = {};
  for (const [k, v] of Object.entries(all)) if (!known.length || known.includes(k)) out[k] = v;
  return out;
}

// Turn a draft id into something the board can be scored for.
//
// Where the scoring comes from matters enough to report. A mock spun up FROM a league
// carries that league's id in its metadata, and that league is readable even when you are
// not in it - so in the common case we get the real scoring settings, bonuses and all. A
// standalone mock does not, and then we are guessing from one word.
export async function followDraft(draftId, scoreKeys = [], userId = null) {
  const d = await getDraft(draftId);
  if (!d?.draft_id) throw new SleeperError('Sleeper has no draft at that link.', 'notfound');

  const srcId = d.metadata?.league_id || d.league_id || null;
  let shape = slotsFromSettings(d.settings);
  let scoring = standardScoring(d.metadata?.scoring_type, scoreKeys);
  let ignored = [];
  let scoringFrom = null;
  let srcName = null;
  if (srcId) {
    try {
      const L = await getLeague(srcId);
      if (L?.scoring_settings) {
        const got = scoringFor(L.scoring_settings, scoreKeys);
        scoring = got.scoring;
        ignored = got.ignored;
        scoringFrom = L.name || 'the league it was made from';
        srcName = L.name || null;
      }
      if (L?.roster_positions?.length) shape = starters(L.roster_positions);
    } catch { /* the source league may be private or gone - the one word still works */ }
  }

  const teams = Number(d.settings?.teams) || 12;
  return {
    name: `Mock — ${srcName || d.metadata?.name || 'Sleeper'}`,
    league_id: srcId,
    draft_id: String(d.draft_id),
    teams,
    rounds: Number(d.settings?.rounds) || null,
    starters: shape.starters,
    bench: shape.bench,
    scoring,
    ignored,
    // draft_order is null until the room is seated, so before then nobody can know your
    // seat - not us and not Sleeper. The board asks you for it instead.
    slot: d.draft_order?.[userId] ?? null,
    rosterId: null,
    status: d.status || 'pre_draft',
    scoringFrom,
    imported: true,
    follow: true,
  };
}

// Every pick made so far, as {playerId, mine, pick, round}.
//
// Three different ways to recognise your own pick, because no single one of them survives
// every case. picked_by is empty on an autopick. roster_id does not exist in a mock, which
// has no rosters. draft_slot is always there but only means anything once you have told
// the app which seat is yours.
export async function draftPicks(draftId, userId, rosterId, slot = null) {
  const picks = await getPicks(draftId);
  return (picks || []).map((p) => ({
    playerId: String(p.player_id),
    mine: (!!userId && p.picked_by === userId)
      || (rosterId != null && p.roster_id === rosterId)
      || (slot != null && Number(p.draft_slot) === Number(slot)),
    pick: p.pick_no,
    round: p.round,
  }));
}

// A read-only rehearsal. Runs the whole live-sync path against a season that has already
// drafted and reports what it WOULD do, without touching anything you have set up.
export async function dryRun(username, season, knownIds) {
  const user = await getUser(username);
  if (!user?.user_id) throw new SleeperError(`No Sleeper account called "${username}".`, 'notfound');
  const leagues = await getLeagues(user.user_id, season);
  if (!leagues?.length) throw new SleeperError(`No ${season} leagues on that account.`, 'empty');

  const out = [];
  for (const L of leagues) {
    if (!L.draft_id) continue;
    let rosterId = null;
    try {
      const rosters = await getRosters(L.league_id);
      rosterId = (rosters || []).find((r) => r.owner_id === user.user_id)?.roster_id ?? null;
    } catch { /* fall back to picked_by */ }
    let picks = [];
    try {
      picks = await draftPicks(L.draft_id, user.user_id, rosterId);
    } catch { /* draft may have been deleted */ }
    out.push({
      name: L.name,
      total: picks.length,
      matched: picks.filter((p) => knownIds.has(p.playerId)).length,
      mine: picks.filter((p) => p.mine).length,
      unknown: picks.filter((p) => !knownIds.has(p.playerId)).length,
    });
  }
  return out;
}
