"""The two-level rating structure.

Level 1 - each COMPONENT is a blend of named SUB-METRICS. Every one is a real, specific
          stat, and every one has its own on/off switch and weight in the sheet.
Level 2 - the components are blended against each other.

Each sub-metric is
    (key, label, extractor, higher_is_better, default_weight, needs_history, default_on)

`needs_history` marks stats computed from 2025 play - rookies and veterans with no 2025 row
get a substituted score for those, never a zero.
`default_on` keeps the starting board sensible: the well-covered stats are on, the niche
ones are available but switched off until you want them.
"""


def _d(a, b):
    a = a or 0
    b = b or 0
    return a / b if b else 0.0


COMPONENTS = [
    ('volume', 'Volume', 'How much work he gets', [
        ('snap_share', 'Snap share %',
         lambda a, s, m: _d(a.get('off_snp'), a.get('tm_off_snp')) * 100, True, 30, True, True),
        ('snaps_pg', 'Snaps / game',
         lambda a, s, m: _d(a.get('off_snp'), a.get('gp')), True, 10, True, False),
        ('touches_pg', 'Touches / game',
         lambda a, s, m: _d((a.get('rush_att') or 0) + (a.get('rec_tgt') or 0), a.get('gp')),
         True, 30, True, True),
        ('carries_pg', 'Carries / game',
         lambda a, s, m: _d(a.get('rush_att'), a.get('gp')), True, 15, True, True),
        ('targets_pg', 'Targets / game',
         lambda a, s, m: _d(a.get('rec_tgt'), a.get('gp')), True, 15, True, True),
        ('rec_pg', 'Receptions / game',
         lambda a, s, m: _d(a.get('rec'), a.get('gp')), True, 10, True, False),
    ]),
    ('efficiency', 'Efficiency', 'What he does with it', [
        ('ypt', 'Yards per touch',
         lambda a, s, m: _d(a.get('rush_rec_yd'),
                            (a.get('rush_att') or 0) + (a.get('rec') or 0)), True, 25, True, True),
        ('ypc', 'Yards per carry',
         lambda a, s, m: a.get('rush_ypa') or 0, True, 15, True, True),
        ('yptgt', 'Yards per target',
         lambda a, s, m: a.get('rec_ypt') or 0, True, 15, True, True),
        ('ypr', 'Yards per reception',
         lambda a, s, m: a.get('rec_ypr') or 0, True, 10, True, False),
        ('catch_rate', 'Catch rate %',
         lambda a, s, m: _d(a.get('rec'), a.get('rec_tgt')) * 100, True, 15, True, True),
        ('drop_rate', 'Drop rate %',
         lambda a, s, m: _d(a.get('rec_drop'), a.get('rec_tgt')) * 100, False, 10, True, True),
        ('btkl', 'Broken tackles / carry',
         lambda a, s, m: _d(a.get('rush_btkl'), a.get('rush_att')), True, 10, True, True),
        ('yac', 'Yards after contact / carry',
         lambda a, s, m: _d(a.get('rush_yac'), a.get('rush_att')), True, 10, True, True),
        ('air_pt', 'Air yards per target',
         lambda a, s, m: _d(a.get('rec_air_yd'), a.get('rec_tgt')), True, 10, True, False),
        ('stuffed', 'Runs stuffed / carry',
         lambda a, s, m: _d(a.get('rush_tkl_loss'), a.get('rush_att')), False, 10, True, False),
    ]),
    ('redzone', 'Red zone', 'Work where points are scored', [
        ('rz_carries_pg', 'Red-zone carries / game',
         lambda a, s, m: _d(a.get('rush_rz_att'), a.get('gp')), True, 30, True, True),
        ('rz_targets_pg', 'Red-zone targets / game',
         lambda a, s, m: _d(a.get('rec_rz_tgt'), a.get('gp')), True, 30, True, True),
        ('rz_conv', 'TDs per red-zone touch',
         lambda a, s, m: _d(a.get('anytime_tds'),
                            (a.get('rush_rz_att') or 0) + (a.get('rec_rz_tgt') or 0)),
         True, 20, True, True),
        ('td_pg', 'Touchdowns / game',
         lambda a, s, m: _d(a.get('anytime_tds'), a.get('gp')), True, 20, True, True),
        ('first_td', 'First touchdown of a game',
         lambda a, s, m: a.get('first_td') or 0, True, 10, True, False),
    ]),
    ('explosive', 'Explosive', 'Big plays', [
        ('exp_pg', '40+ yard plays / game',
         lambda a, s, m: _d((a.get('rec_40p') or 0) + (a.get('rush_40p') or 0), a.get('gp')),
         True, 35, True, True),
        ('exp_td_pg', 'Long touchdowns / game',
         lambda a, s, m: _d((a.get('rec_td_40p') or 0) + (a.get('rush_td_40p') or 0),
                            a.get('gp')), True, 25, True, True),
        ('rec20_pg', '20+ yard catches / game',
         lambda a, s, m: _d((a.get('rec_20_29') or 0) + (a.get('rec_30_39') or 0),
                            a.get('gp')), True, 20, True, True),
        ('hundred', '100-yard games',
         lambda a, s, m: a.get('bonus_rush_rec_yd_100') or 0, True, 20, True, True),
    ]),
    ('production', 'Production', 'What he actually scored', [
        ('ppg', 'Fantasy points / game',
         lambda a, s, m: _d(a.get('pts_ppr'), a.get('gp')), True, 40, True, True),
        ('total_pts', 'Total fantasy points',
         lambda a, s, m: a.get('pts_ppr') or 0, True, 15, True, False),
        ('yards_pg', 'Yards / game',
         lambda a, s, m: _d((a.get('rush_rec_yd') or 0) + 0.4 * (a.get('pass_yd') or 0),
                            a.get('gp')), True, 25, True, True),
        ('total_td', 'Total touchdowns',
         lambda a, s, m: a.get('anytime_tds') or 0, True, 15, True, False),
        ('finish', 'Finish at his position',
         lambda a, s, m: a.get('pos_rank_ppr') or 999, False, 20, True, True),
    ]),
    ('role', 'Role', 'His place in the offence this year', [
        ('touch_share', 'Share of team touches (2026)',
         lambda a, s, m: m.get('role_pct', 0), True, 60, False, True),
        ('start_rate', 'Games started %',
         lambda a, s, m: _d(a.get('gs'), a.get('gp')) * 100, True, 25, True, True),
        ('proj_touches', 'Projected touches',
         lambda a, s, m: (s.get('rush_att') or 0) + (s.get('rec') or 0), True, 25, False, True),
    ]),
    ('reliability', 'Reliability', 'Can you count on him', [
        ('games', 'Games played',
         lambda a, s, m: a.get('gp') or 0, True, 50, True, True),
        ('starts', 'Games started',
         lambda a, s, m: a.get('gs') or 0, True, 20, True, False),
        ('fum_pg', 'Fumbles / game',
         lambda a, s, m: _d(a.get('fum'), a.get('gp')), False, 25, True, True),
        ('pen_pg', 'Penalties / game',
         lambda a, s, m: _d(a.get('penalty'), a.get('gp')), False, 10, True, False),
    ]),
    ('floor', 'Floor', 'How safe he is - the reasons he cannot bust', [
        ('f_games', 'Games played',
         lambda a, s, m: a.get('gp') or 0, True, 25, True, True),
        ('f_snap', 'Snap share %',
         lambda a, s, m: _d(a.get('off_snp'), a.get('tm_off_snp')) * 100, True, 25, True, True),
        ('f_start', 'Games started %',
         lambda a, s, m: _d(a.get('gs'), a.get('gp')) * 100, True, 20, True, True),
        ('f_share', 'Locked-in share of touches',
         lambda a, s, m: m.get('role_pct', 0), True, 20, False, True),
        ('f_finish', 'Proven finish last year',
         lambda a, s, m: a.get('pos_rank_ppr') or 999, False, 10, True, True),
    ]),
    ('ceiling', 'Ceiling', 'How high he can go - the reasons he could win you the league', [
        ('c_exp', 'Explosive plays / game',
         lambda a, s, m: _d((a.get('rec_40p') or 0) + (a.get('rush_40p') or 0), a.get('gp')),
         True, 25, True, True),
        ('c_rz', 'TDs per red-zone touch',
         lambda a, s, m: _d(a.get('anytime_tds'),
                            (a.get('rush_rz_att') or 0) + (a.get('rec_rz_tgt') or 0)),
         True, 20, True, True),
        ('c_off', 'Team offence',
         lambda a, s, m: m.get('team_off', 0), True, 20, False, True),
        ('c_young', 'Young enough to leap',
         lambda a, s, m: m.get('years_exp', 5), False, 15, False, True),
        ('c_breakout', 'Projected jump on last year',
         lambda a, s, m: m.get('breakout', 0), True, 20, False, True),
    ]),
    ('situation', 'Situation', 'The team around him', [
        ('team_off', 'Team offence',
         lambda a, s, m: m.get('team_off', 0), True, 50, False, True),
        ('team_def', 'Team defence',
         lambda a, s, m: m.get('team_def', 0), True, 20, False, True),
        ('sos', 'Schedule (easier is better)',
         lambda a, s, m: m.get('sos_raw', 80), False, 30, False, True),
    ]),
]

# Level 2 starting weights. Volume and red zone lead, as asked.
COMPONENT_WEIGHTS = {
    'volume': 16, 'efficiency': 10, 'redzone': 12, 'explosive': 6,
    'production': 12, 'role': 9, 'reliability': 5, 'situation': 4, 'projection': 11,
    # Floor and Ceiling are driven by the Safe <-> Upside slider on Draft Day, which
    # splits a fixed budget between them. The numbers here are only the starting split.
    'floor': 8, 'ceiling': 7,
}

# A component with no sub-metrics - the 2026 projected-points percentile. League-specific,
# so it is computed per league rather than here.
PROJECTION = ('projection', '2026 projection', 'What the projections expect this year')

# Which positions each stat actually means anything for. A rushing-efficiency stat is
# dead weight on a receiver (for tight ends, "broken tackles per carry" has TWO distinct
# values across the whole position), and receiving stats say little about a back's role.
# Anything not listed applies everywhere.
RATE_POS = ['QB', 'RB', 'WR', 'TE']
ONLY = {
    'carries_pg':    ['QB', 'RB'],
    'ypc':           ['QB', 'RB'],
    'btkl':          ['RB'],
    'yac':           ['RB'],
    'stuffed':       ['RB'],
    'rz_carries_pg': ['QB', 'RB'],
    'targets_pg':    ['RB', 'WR', 'TE'],
    'rec_pg':        ['RB', 'WR', 'TE'],
    'yptgt':         ['RB', 'WR', 'TE'],
    'ypr':           ['WR', 'TE'],
    'catch_rate':    ['RB', 'WR', 'TE'],
    'drop_rate':     ['RB', 'WR', 'TE'],
    'air_pt':        ['WR', 'TE'],
    'rz_targets_pg': ['RB', 'WR', 'TE'],
    'rec20_pg':      ['WR', 'TE'],
}


def weight_for(sub_key, base, pos):
    """Starting weight for one stat at one position - 0 where the stat is meaningless."""
    allowed = ONLY.get(sub_key)
    return base if (allowed is None or pos in allowed) else 0


MAX_SUBS = max(len(subs) for _k, _l, _d2, subs in COMPONENTS)
ALL_SUBS = [(c[0], s[0], s[1], s[3], s[4], s[5], s[6]) for c in COMPONENTS for s in c[3]]
