# Reference data derived from Sleeper API, 2026 season.
# Source: https://api.sleeper.com/schedule/nfl/regular/2026 (fetched 2026-08-10)

# Bye weeks derived by finding teams absent from each week's game list.
# Week 6 DAL@SEA game is marked "canceled" in the Sleeper feed and excluded.
BYE = {
    'CAR': 5, 'KC': 5,
    'CIN': 6, 'DET': 6, 'MIA': 6, 'MIN': 6,
    'BUF': 7, 'JAX': 7, 'LAC': 7, 'WAS': 7,
    'HOU': 8, 'NO': 8, 'NYG': 8, 'SF': 8,
    'PIT': 9, 'TEN': 9,
    'CHI': 10, 'DEN': 10, 'PHI': 10, 'TB': 10,
    'ATL': 11, 'CLE': 11, 'GB': 11, 'LAR': 11, 'NE': 11, 'SEA': 11,
    'BAL': 13, 'IND': 13, 'LV': 13, 'NYJ': 13,
    'ARI': 14, 'DAL': 14,
}

# Fantasy playoff opponents, weeks 15-17 (playoff_week_start = 15 in both 1812 leagues).
PLAYOFF_OPP = {
    'ARI': ['NYJ', 'NO',  'LV'],   'ATL': ['WAS', 'TB',  'NO'],
    'BAL': ['PIT', 'CLE', 'CIN'],  'BUF': ['CHI', 'DEN', 'MIA'],
    'CAR': ['CIN', 'PIT', 'SEA'],  'CHI': ['BUF', 'GB',  'DET'],
    'CIN': ['CAR', 'IND', 'BAL'],  'CLE': ['NYG', 'BAL', 'IND'],
    'DAL': ['LAR', 'JAX', 'NYG'],  'DEN': ['LV',  'BUF', 'NE'],
    'DET': ['MIN', 'NYG', 'CHI'],  'GB':  ['MIA', 'CHI', 'HOU'],
    'HOU': ['JAX', 'PHI', 'GB'],   'IND': ['TEN', 'CIN', 'CLE'],
    'JAX': ['HOU', 'DAL', 'WAS'],  'KC':  ['NE',  'SF',  'LAC'],
    'LAC': ['SF',  'MIA', 'KC'],   'LAR': ['DAL', 'SEA', 'TB'],
    'LV':  ['DEN', 'TEN', 'ARI'],  'MIA': ['GB',  'LAC', 'BUF'],
    'MIN': ['DET', 'WAS', 'NYJ'],  'NE':  ['KC',  'NYJ', 'DEN'],
    'NO':  ['TB',  'ARI', 'ATL'],  'NYG': ['CLE', 'DET', 'DAL'],
    'NYJ': ['ARI', 'NE',  'MIN'],  'PHI': ['SEA', 'HOU', 'SF'],
    'PIT': ['BAL', 'CAR', 'TEN'],  'SEA': ['PHI', 'LAR', 'CAR'],
    'SF':  ['LAC', 'KC',  'PHI'],  'TB':  ['NO',  'ATL', 'LAR'],
    'TEN': ['IND', 'LV',  'PIT'],  'WAS': ['ATL', 'MIN', 'JAX'],
}

# 2026 DEF projections: team -> (adp_ppr, sleeper_pts_ppr, sack, int, fum_rec, blk_kick, ret/def TDs)
# Source: https://api.sleeper.com/projections/nfl/2026?position[]=DEF (rotowire, fetched 2026-08-10)
DEF_PROJ = {
    'LAR': (115.5, 106, 52, 15, 11, 1, 3), 'HOU': (119.0, 104, 48, 16, 11, 1, 1),
    'SEA': (124.2, 103, 47, 16, 11, 1, 1), 'PHI': (129.0, 98, 46, 15, 10, 1, 0),
    'DEN': (132.8, 96, 48, 14, 9, 1, 0),   'BAL': (142.2, 95, 45, 14, 10, 1, 0),
    'NE':  (149.4, 92, 44, 13, 10, 1, 2),  'MIN': (160.0, 92, 44, 13, 10, 1, 2),
    'DET': (162.2, 92, 42, 13, 11, 1, 1),  'JAX': (177.2, 91, 43, 13, 10, 1, 2),
    'PIT': (181.2, 88, 42, 13, 9, 1, 0),   'KC':  (189.2, 87, 43, 12, 9, 1, 0),
    'NYG': (192.5, 86, 42, 12, 9, 1, 0),   'LAC': (197.6, 86, 42, 12, 9, 1, 0),
    'GB':  (203.4, 86, 42, 12, 9, 1, 0),   'DAL': (205.5, 86, 42, 12, 9, 1, 1),
    'CHI': (209.2, 85, 41, 12, 9, 1, 0),   'SF':  (214.0, 84, 40, 12, 9, 1, 0),
    'IND': (219.0, 84, 40, 12, 9, 1, 0),   'BUF': (225.2, 84, 40, 12, 9, 1, 0),
    'ATL': (228.4, 83, 41, 11, 9, 1, 0),   'TB':  (232.4, 81, 41, 11, 8, 1, 0),
    'CAR': (238.4, 81, 39, 11, 9, 1, 1),   'CIN': (241.2, 79, 39, 11, 8, 1, 0),
    'NO':  (244.6, 77, 39, 10, 8, 1, 1),   'CLE': (266.6, 74, 36, 10, 8, 1, 0),
    'TEN': (270.2, 67, 33, 9, 7, 1, 0),    'ARI': (273.0, 66, 34, 8, 7, 1, 1),
    'LV':  (279.3, 65, 33, 8, 7, 1, 0),    'NYJ': (282.2, 64, 34, 7, 7, 1, 0),
    'MIA': (299.0, 62, 34, 7, 6, 1, 0),    'WAS': (999.0, 75, 39, 10, 7, 1, 0),
}

# League configs pulled from Sleeper.
LEAGUES = {
    '1812 Fantasy League': {
        'league_id': '1380254336671563776', 'draft_id': '1380254336688353280',
        'teams': 12, 'rounds': 16,
        'draft': 'Sat Aug 29, 2026 7:00 PM ET',
        'starters': {'QB': 1, 'RB': 2, 'WR': 2, 'TE': 1, 'FLEX': 2, 'K': 1, 'DEF': 1},
        'bench': 6, 'playoff_start': 15,
    },
    '1812 Highest Scorer': {
        'league_id': '1380255539732185088', 'draft_id': '1380255539740553216',
        'teams': 12, 'rounds': 15,
        'draft': 'Sun Aug 30, 2026 7:00 PM ET',
        'starters': {'QB': 1, 'RB': 2, 'WR': 2, 'TE': 1, 'FLEX': 2, 'K': 1, 'DEF': 1},
        'bench': 5, 'playoff_start': 15,
    },
    'Last One Standing': {
        'league_id': '1389749702513164288', 'draft_id': '1389749702513164289',
        'teams': 18, 'rounds': 14,
        'draft': 'Not scheduled yet',
        'starters': {'QB': 1, 'RB': 2, 'WR': 2, 'TE': 1, 'FLEX': 2},
        'bench': 6, 'playoff_start': None,
    },
}
