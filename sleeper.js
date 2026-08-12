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

// Every pick made so far, as {playerId, mine, pick, round}.
export async function draftPicks(draftId, userId, rosterId) {
  const picks = await getPicks(draftId);
  return (picks || []).map((p) => ({
    playerId: String(p.player_id),
    // whoever actually made it, falling back to the roster it landed on
    mine: (!!userId && p.picked_by === userId)
      || (rosterId != null && p.roster_id === rosterId),
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
