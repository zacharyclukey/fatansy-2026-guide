"""Component-score engine: turns raw stats into 14 tunable 0-100 rating inputs.

Every component is a PERCENTILE WITHIN POSITION. A 90 in Volume means "carried a bigger
workload than 90% of other players at his position". Percentiles are used so that
components measured in different units (snaps, yards, touchdowns) can be blended with
simple weights and nothing dominates just because its numbers are bigger.
"""
import json, os
from collections import defaultdict
from reference import BYE, PLAYOFF_OPP, DEF_PROJ, LEAGUES
from rookies import DRAFT_CAPITAL, capital_score, confidence
import submetrics as SM

HERE = os.path.dirname(os.path.abspath(__file__))
proj = json.load(open(os.path.join(HERE, 'sleeper_proj_raw.json')))
acts = json.load(open(os.path.join(HERE, 'sleeper_stats2025_raw.json')))
ACT = {r['player_id']: r['stats'] for r in acts}

DIVISIONS = [
    ['BUF', 'MIA', 'NE', 'NYJ'], ['BAL', 'CIN', 'CLE', 'PIT'],
    ['HOU', 'IND', 'JAX', 'TEN'], ['DEN', 'KC', 'LAC', 'LV'],
    ['DAL', 'NYG', 'PHI', 'WAS'], ['CHI', 'DET', 'GB', 'MIN'],
    ['ATL', 'CAR', 'NO', 'TB'],   ['ARI', 'LAR', 'SF', 'SEA'],
]
DIV_OF = {t: d for d in DIVISIONS for t in d}


def g(s, k, default=0.0):
    v = s.get(k)
    return default if v is None else float(v)


# ---------------------------------------------------------------- team ratings
TEAM_OFF = defaultdict(float)      # sum of projected skill-position points
TEAM_TOUCH = defaultdict(lambda: defaultdict(float))   # team -> pos -> projected touches
for r in proj:
    pos, s = r['player']['position'], r['stats']
    t = r.get('team') or r['player'].get('team')
    if pos in ('QB', 'RB', 'WR', 'TE') and t and g(s, 'adp_ppr', 999) < 999:
        TEAM_OFF[t] += g(s, 'pts_ppr')
        TEAM_TOUCH[t][pos] += g(s, 'rush_att') + g(s, 'rec')

# Defensive quality proxy: projected fantasy points for that team's DEF.
TEAM_DEF = {t: d[1] for t, d in DEF_PROJ.items()}


def sos_score(team):
    """Opponent difficulty. Built from the two chunks of schedule we know exactly:
    the 6 division games every team plays, and the weeks 15-17 fantasy playoff run.
    Higher opponent defensive rating = harder. Returned raw; inverted later."""
    div = [TEAM_DEF.get(o, 80) for o in DIV_OF.get(team, []) if o != team]
    po = [TEAM_DEF.get(o, 80) for o in PLAYOFF_OPP.get(team, [])]
    if not div and not po:
        return 80.0
    dm = sum(div) / len(div) if div else 80.0
    pm = sum(po) / len(po) if po else 80.0
    return 0.6 * dm + 0.4 * pm          # division games outnumber playoff games


# ---------------------------------------------------------------- raw metrics
def raw_metrics(pid, pos, team, s):
    """Every raw number the rating is built from, per player. a = 2025 actuals."""
    a = ACT.get(pid, {})
    gp = max(g(a, 'gp'), 1)
    tm_snp = max(g(a, 'tm_off_snp'), 1)
    touches = g(a, 'rush_att') + g(a, 'rec_tgt')
    rz = g(a, 'rush_rz_att') + g(a, 'rec_rz_tgt') + g(a, 'pass_rz_att')
    tds = g(a, 'anytime_tds')
    explosive = g(a, 'rec_40p') + g(a, 'rush_40p')
    exp_td = (g(a, 'rec_td_40p') + g(a, 'rush_td_40p')
              + g(a, 'rec_td_50p') + g(a, 'rush_td_50p') + g(a, 'pass_td_40p'))
    yards = g(a, 'rush_rec_yd') + 0.4 * g(a, 'pass_yd')
    turnovers = g(a, 'fum_lost') + g(a, 'pass_int')

    # role: this player's share of his team's projected touches at his position
    tt = TEAM_TOUCH[team][pos] if team else 0
    my = g(s, 'rush_att') + g(s, 'rec')
    role = (my / tt * 100) if tt > 0 else 0

    # efficiency: position-appropriate, since yards-per-carry means nothing for a WR
    if pos == 'RB':
        eff = (g(a, 'rush_ypa') * 10 + (g(a, 'rush_btkl') / max(g(a, 'rush_att'), 1)) * 100
               + (g(a, 'rush_yac') / max(g(a, 'rush_att'), 1)) * 10)
    elif pos in ('WR', 'TE'):
        drop_rate = g(a, 'rec_drop') / max(g(a, 'rec_tgt'), 1)
        eff = (g(a, 'rec_ypt') * 10 + (g(a, 'rec_yar') / max(g(a, 'rec'), 1)) * 5
               - drop_rate * 100)
    elif pos == 'QB':
        eff = g(a, 'pass_ypa') * 8 + g(a, 'cmp_pct') + g(a, 'pass_rtg') * 0.4
    else:
        eff = 0

    return dict(
        has2025=bool(a),
        # bool(a) is not "he played". The 2025 feed returns a row for men who took no
        # snaps at all - a rookie comes back as {'pos_rank_ppr': 173} - and treating that
        # as a season let players with no games set the percentile scale for everyone.
        played=bool(a) and int(g(a, 'gp')) > 0,
        snap_share=round(g(a, 'off_snp') / tm_snp * 100, 1),
        touches_pg=round(touches / gp, 2),
        volume_raw=round(g(a, 'off_snp') / tm_snp * 100 * 0.55 + (touches / gp) * 2.2, 2),
        eff_raw=round(eff, 2),
        rz_pg=round(rz / gp, 2),
        rz_conv=round(tds / rz, 3) if rz >= 5 else 0,
        rz_raw=round((rz / gp) * 10 + (tds / rz if rz >= 5 else 0) * 20, 2),
        explosive_pg=round((explosive + exp_td) / gp, 3),
        yards_pg=round(yards / gp, 1),
        last_ppg=round(g(a, 'pts_ppr') / gp, 2) if a else 0,
        last_finish=int(g(a, 'pos_rank_ppr', 999)),
        role_pct=round(role, 1),
        turnovers_pg=round(turnovers / gp, 3),
        games_2025=int(g(a, 'gp')), starts_2025=int(g(a, 'gs')),
        missed=int(17 - g(a, 'gp')) if a else None,
        team_off=round(TEAM_OFF.get(team, 0), 0),
        team_def=TEAM_DEF.get(team, 80),
        sos_raw=round(sos_score(team), 1),
        # breakout signal: how much more the projection expects than he did last year
        breakout=round((g(s, 'pts_ppr') / max(g(s, 'gp'), 1))
                       - (g(a, 'pts_ppr') / gp), 2) if a else 0.0,
        proj_ppg=round(g(s, 'pts_ppr') / max(g(s, 'gp'), 1), 2),
        raw2025=a,
    )


# ---------------------------------------------------------------- percentiles
def pctile(vals):
    """Map values -> 0-100 percentile. Ties share a rank."""
    order = sorted(set(vals))
    if len(order) <= 1:
        return {v: 50.0 for v in vals}
    return {v: round(i / (len(order) - 1) * 100, 1) for i, v in enumerate(order)}


COMPONENTS = [
    # key            metric field       higher_is_better  label
    ('volume',      'volume_raw',      True,  'Volume'),
    ('efficiency',  'eff_raw',         True,  'Efficiency'),
    ('redzone',     'rz_raw',          True,  'Red zone'),
    ('explosive',   'explosive_pg',    True,  'Explosive plays'),
    ('yardage',     'yards_pg',        True,  'Yardage'),
    ('last_ppg',    'last_ppg',        True,  "Last year's PPG"),
    ('last_finish', 'last_finish',     False, "Last year's finish"),
    ('role',        'role_pct',        True,  'Role / depth chart'),
    ('turnovers',   'turnovers_pg',    False, 'Ball security'),
    ('durability',  'games_2025',      True,  'Durability'),
    ('team_off',    'team_off',        True,  'Team offense'),
    ('team_def',    'team_def',        True,  'Team defense'),
    ('sos',         'sos_raw',         False, 'Strength of schedule'),
]
# Components that depend on 2025 NFL history - rookies have none of these.
HISTORY = {'volume', 'efficiency', 'redzone', 'explosive', 'yardage',
           'last_ppg', 'last_finish', 'turnovers', 'durability'}


def build(players):
    """players: list of dicts with pid, pos, team, adp, stats. Adds .m (metrics) and .c (scores)."""
    for p in players:
        p['m'] = raw_metrics(p['pid'], p['pos'], p['team'], p['_s'])

    # --- rookie model -------------------------------------------------------
    for p in players:
        m = p['m']
        pick = DRAFT_CAPITAL.get(p['name'], (None, False))[0]
        p['is_rookie'] = (p.get('exp') == 0)
        if p['is_rookie']:
            cap = capital_score(pick)
            # vacated opportunity: how much of the team's projected work he is handed
            share = min(m['role_pct'], 100)
            toff = TEAM_OFF.get(p['team'], 0)
            toff_pct = min(toff / 1400 * 100, 100)
            m['rookie_score'] = round(0.45 * cap + 0.30 * share + 0.15 * toff_pct
                                      + 0.10 * min(m['team_def'], 100), 1)
            m['draft_pick'] = pick
            m['rookie_conf'] = confidence(p['name'])
        else:
            m['rookie_score'] = None
            m['draft_pick'] = None
            m['rookie_conf'] = ''

    # --- players with NO 2025 data ------------------------------------------
    # The 2025 stats feed is capped per position, so some veterans who missed time are
    # absent (Malik Nabers, Garrett Wilson, Chris Godwin...). Treating "absent" as ZERO
    # scored them as though they had done nothing all year, which buried real first-round
    # talent far below its ADP. Anyone without history now gets their 2026 projection
    # percentile substituted into the history components instead - the same trick used
    # for rookies, and the best signal available for a player with no recent tape.
    by_pos_all = defaultdict(list)
    for p in players:
        by_pos_all[p['pos']].append(p)
    for pos, grp in by_pos_all.items():
        vals = [float((x['_s'].get('pts_ppr') or 0)) for x in grp]
        pm = pctile(vals)
        for x in grp:
            x['m']['nohist_score'] = pm[float((x['_s'].get('pts_ppr') or 0))]
            x['m']['no_history'] = (not x['m']['played']) and not x['is_rookie']

    # --- percentile each component within position ---------------------------
    by_pos = defaultdict(list)
    for p in players:
        by_pos[p['pos']].append(p)

    for pos, grp in by_pos.items():
        for key, field, hib, _ in COMPONENTS:
            hist = key in HISTORY
            # only players WITH real 2025 history set the scale for history components
            pool = [x for x in grp if (not hist or (not x['is_rookie'] and x['m']['played']))]
            if not pool:
                for x in grp:
                    x.setdefault('c', {})[key] = 50.0
                continue
            vals = [x['m'][field] for x in pool]
            pm = pctile(vals)
            for x in pool:
                v = pm[x['m'][field]]
                x.setdefault('c', {})[key] = v if hib else round(100 - v, 1)
            if hist:
                for x in grp:
                    # NO SEASON, SO NO PERCENTILE.
                    #
                    # This used to copy one number - the rookie model's score, or the
                    # player's projection percentile - into every history component and
                    # every history sub-metric underneath them. Forty copies of the same
                    # number. The app then averaged those forty copies and called it a
                    # rating, so Fernando Mendoza, who has never played an NFL snap, read
                    # 94 for rushing efficiency, 94 for red-zone conversion and 94 for
                    # reliability, rated 81 out of 100, and got drafted at pick 96 against
                    # an ADP of 170. Every unexplained reach on the board was a player who
                    # had never played.
                    #
                    # A blank is the honest answer and the app already knows what to do
                    # with one: it rates a man with no season on his projection, his draft
                    # capital and his spot on the depth chart, and on nothing else.
                    if x['is_rookie'] or not x['m']['played']:
                        x.setdefault('c', {})[key] = None

    # ---- two-level rating: percentile every SUB-METRIC within position -------
    # The old 13 blended components stay (the board still shows them as a stat view);
    # these finer scores are what the Ratings Lab now mixes.
    for p in players:
        a = p['m'].get('raw2025') or {}
        p['m']['years_exp'] = p.get('exp') if p.get('exp') is not None else 5
        p['sub_raw'] = {}
        for comp, sub, _lbl, _hib, _w, _hist, _on in SM.ALL_SUBS:
            try:
                fn = next(x[2] for c in SM.COMPONENTS if c[0] == comp
                          for x in c[3] if x[0] == sub)
                p['sub_raw'][sub] = float(fn(a, p['_s'], p['m']) or 0)
            except Exception:
                p['sub_raw'][sub] = 0.0

    by_pos2 = defaultdict(list)
    for p in players:
        by_pos2[p['pos']].append(p)
    for pos, grp in by_pos2.items():
        for comp, sub, _lbl, hib, _w, hist, _on in SM.ALL_SUBS:
            pool = [x for x in grp
                    if not hist or (not x['is_rookie'] and x['m']['played'])]
            if not pool:
                for x in grp:
                    x.setdefault('sub', {})[sub] = 50.0
                continue
            pm = pctile([x['sub_raw'][sub] for x in pool])
            for x in pool:
                v = pm[x['sub_raw'][sub]]
                x.setdefault('sub', {})[sub] = v if hib else round(100 - v, 1)
            if hist:
                # same as above: no season, no percentile. export_json drops the blanks
                # and the app reads a missing sub as "nothing to go on".
                for x in grp:
                    if x['is_rookie'] or not x['m']['played']:
                        x.setdefault('sub', {})[sub] = None

    return players
