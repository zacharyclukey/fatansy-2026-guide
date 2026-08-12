"""Emit the one data file the web app loads.

board.json is 2.1 MB because every player is repeated once per league. The app does not
need that: a player's sub-metric percentiles are position-relative and league-independent,
and everything league-specific (projected points, replacement level, VOR) is recomputed in
the browser from the league's own scoring settings - exactly as the workbook did in-sheet.

So this writes ONE player list plus the league configs, and the app derives the rest.
"""
import json
import os
from datetime import date

import reference as R
import submetrics as SM

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'data', 'players.json')

D = json.load(open(os.path.join(HERE, 'board.json')))
LNAMES = list(D['boards'])
BASE = D['boards'][LNAMES[0]]

# scoring keys the app multiplies projected stats by - same list the workbook used
from engine import BASE as _BASE, HS_EXTRA as _HSX, HS as _HS
SCORE_KEYS = sorted(set(_BASE) | set(_HSX))

# raw 2025 fields worth carrying for the "show me the actual numbers" view
RAW_KEEP = ['pass_att', 'pass_cmp', 'pass_yd', 'pass_td', 'pass_int', 'cmp_pct', 'pass_ypa',
            'pass_rtg', 'pass_sack', 'pass_rz_att', 'pass_td_40p', 'pass_fd',
            'gp', 'gs', 'off_snp', 'tm_off_snp', 'rush_att', 'rec_tgt', 'rec', 'rush_yd',
            'rec_yd', 'rush_rec_yd', 'anytime_tds', 'fum', 'fum_lost', 'pts_ppr',
            'pos_rank_ppr', 'rush_rz_att', 'rec_rz_tgt', 'rec_40p', 'rush_40p',
            'rec_drop', 'rush_ypa', 'rec_ypt', 'rec_ypr', 'bonus_rush_rec_yd_100']

# What each stat means and how it is worked out, for the hover tips. Every one of these
# then gets "ranked 0-100 against others at his position" appended, because that part is
# true of all of them.
TIPS = {
 'pass_att_pg': 'Pass attempts divided by games played - the quarterback version of volume.',
 'pass_ypa': 'Passing yards per attempt.',
 'cmp_pct': 'Completion percentage.',
 'pass_rtg': 'Traditional passer rating.',
 'sack_rate': 'Sacks taken per dropback. Lower is better.',
 'pass_rz_pg': 'Pass attempts inside the opponent 20, per game.',
 'pass_td_pg': 'Passing touchdowns divided by games played.',
 'pass_deep': 'Passing touchdowns of 40 yards or more.',
 'int_pg': 'Interceptions thrown per game. Lower is better.',
 'c_young': 'Years in the league, inverted - younger players have more room to improve.',
 'snap_share': 'Share of his team offensive snaps he was on the field for. Snaps / team snaps.',
 'snaps_pg': 'Offensive snaps divided by games played.',
 'touches_pg': 'Carries plus targets, divided by games played.',
 'carries_pg': 'Rushing attempts divided by games played.',
 'targets_pg': 'Times he was thrown at, divided by games played.',
 'rec_pg': 'Catches divided by games played.',
 'ypt': 'Yards from scrimmage divided by carries plus catches.',
 'ypc': 'Rushing yards divided by carries.',
 'yptgt': 'Receiving yards divided by targets - rewards catching AND catching deep.',
 'ypr': 'Receiving yards divided by catches.',
 'catch_rate': 'Catches divided by targets.',
 'drop_rate': 'Drops divided by targets. Lower is better.',
 'btkl': 'Broken tackles divided by carries.',
 'yac': 'Yards after contact divided by carries.',
 'air_pt': 'Air yards divided by targets - how far downfield he is used.',
 'stuffed': 'Runs stopped at or behind the line, divided by carries. Lower is better.',
 'rz_carries_pg': 'Carries inside the opponent 20, divided by games.',
 'rz_targets_pg': 'Targets inside the opponent 20, divided by games.',
 'rz_conv': 'Touchdowns divided by red-zone touches - does he finish once he gets there.',
 'td_pg': 'Total touchdowns divided by games played.',
 'first_td': 'Times he scored the first touchdown of a game.',
 'exp_pg': 'Plays of 40+ yards, run or catch, divided by games.',
 'exp_td_pg': 'Touchdowns of 40+ yards divided by games.',
 'rec20_pg': 'Catches of 20-39 yards divided by games.',
 'hundred': 'Games with 100+ yards from scrimmage.',
 'ppg': 'PPR fantasy points divided by games played.',
 'total_pts': 'Total PPR fantasy points across the season.',
 'yards_pg': 'Yards from scrimmage (plus 40% of passing yards) divided by games.',
 'total_td': 'Total touchdowns.',
 'finish': 'Where he finished at his position in 2025. Lower is better.',
 'touch_share': "Share of his team's 2026 projected touches at his position.",
 'start_rate': 'Games started divided by games played.',
 'proj_touches': 'Projected 2026 carries plus catches.',
 'games': 'Games played in 2025.',
 'starts': 'Games started in 2025.',
 'fum_pg': 'Fumbles divided by games played. Lower is better.',
 'pen_pg': 'Penalties divided by games played. Lower is better.',
 'c_breakout': 'How much more the 2026 projection expects per game than he managed in 2025.',
 'team_off': "His offence's projected fantasy points.",
 'team_def': "His defence's quality - a good defence means more of the game with the lead.",
 'sos': 'Strength of schedule from opponent defences. Easier is better.',
}

M_KEEP = ['has2025', 'snap_share', 'touches_pg', 'rz_pg', 'rz_conv', 'explosive_pg',
          'yards_pg', 'last_ppg', 'last_finish', 'role_pct', 'games_2025', 'missed',
          'team_off', 'team_def', 'sos_raw', 'breakout', 'proj_ppg', 'rookie_score',
          'draft_pick', 'rookie_conf', 'no_history', 'years_exp']


def rnd(v, n=2):
    return round(v, n) if isinstance(v, float) else v


def trim(d, keep):
    if not d:
        return {}
    return {k: rnd(d[k]) for k in keep if d.get(k) not in (None, 0, False)}


# each league's board is sorted by ITS OWN rank, so index positions do not line up -
# look K and DEF points up by player id, not by row number
PTS = {n: {str(x['pid']): round(x['lg']['pts'], 1) for x in D['boards'][n]} for n in LNAMES}

players = []
for i, p in enumerate(BASE):
    m = p['m']
    players.append({
        'id': str(p['pid']),
        'name': p['name'],
        'pos': p['pos'],
        'team': p['team'],
        'bye': p['bye'],
        'adp': rnd(p['adp'], 1),
        'exp': p.get('exp'),
        'rookie': bool(p.get('is_rookie')),
        # dropping these was a real hazard: a player with a torn ACL looked healthy
        **({'inj': p['inj']} if p.get('inj') else {}),
        **({'injPart': p['inj_part']} if p.get('inj_part') else {}),
        # percentiles within position, 0-100. The app blends these; it never re-derives them.
        'sub': {k: rnd(v, 1) for k, v in p['sub'].items() if v is not None},
        'proj': trim(p.get('pr'), SCORE_KEYS + ['gp', 'pts_ppr', 'rush_att', 'rec']),
        'a': trim(m.get('raw2025'), RAW_KEEP),
        # K and DEF have no projectable stat line - carry their points per league instead
        **({'ppts': {n: PTS[n][str(p['pid'])] for n in LNAMES
                     if str(p['pid']) in PTS[n]}}
           if p['pos'] in ('K', 'DEF') else {}),
        'm': trim(m, M_KEEP),
    })

# the rating structure itself, so the app builds its own controls instead of hardcoding them
components = []
for key, label, desc, subs in SM.COMPONENTS:
    components.append({
        'key': key, 'label': label, 'desc': desc,
        'weight': SM.COMPONENT_WEIGHTS.get(key, 10),
        'subs': [{
            'key': sk, 'label': lb, 'on': on,
            'tip': TIPS.get(sk, ''),
            # a weight per position - 0 where the stat means nothing there
            'w': {q: SM.weight_for(sk, dw, q) for q in SM.RATE_POS},
        } for sk, lb, _ex, _hi, dw, _nh, on in subs],
    })
components.append({
    'key': SM.PROJECTION[0], 'label': SM.PROJECTION[1], 'desc': SM.PROJECTION[2],
    'weight': SM.COMPONENT_WEIGHTS['projection'], 'subs': [],
})

leagues = []
for n in LNAMES:
    c = R.LEAGUES[n]
    leagues.append({
        'name': n, 'league_id': c.get('league_id'), 'draft_id': c.get('draft_id'),
        'teams': c['teams'], 'rounds': c['rounds'], 'draft': c.get('draft'),
        'starters': c['starters'], 'bench': c.get('bench'),
        # the league's real Sleeper rules - the app multiplies projected stats by these,
        # so editing a value here re-scores the whole board with no rebuild
        'scoring': {k: v for k, v in
                    dict(_BASE, **(_HSX if n == _HS else {})).items()},
    })

out = {
    'generated': date.today().isoformat(),
    'season': 2026,
    'scoreKeys': SCORE_KEYS,
    'positions': ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'],
    'ratePos': SM.RATE_POS,
    'components': components,
    'leagues': leagues,
    'players': players,
}

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, 'w') as f:
    json.dump(out, f, separators=(',', ':'))
print(f'wrote {OUT}  {os.path.getsize(OUT)/1024:.0f} KB  '
      f'{len(players)} players  {len(components)} components  {len(leagues)} leagues')
