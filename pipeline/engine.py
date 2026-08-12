"""Scoring + VOR + tier engine for Zach's 2026 draft guide.

Data sources (all fetched 2026-08-10):
  - Projections & ADP: https://api.sleeper.com/projections/nfl/2026 (provider: rotowire)
  - 2025 actuals:      https://api.sleeper.com/stats/nfl/2025
  - Schedule/byes:     https://api.sleeper.com/schedule/nfl/regular/2026
  - League rules:      https://api.sleeper.app/v1/user/zclukey/leagues/nfl/2026
"""
import json, os
from reference import BYE, PLAYOFF_OPP, DEF_PROJ, LEAGUES

HERE = os.path.dirname(os.path.abspath(__file__))
proj = json.load(open(os.path.join(HERE, 'sleeper_proj_raw.json')))
acts = json.load(open(os.path.join(HERE, 'sleeper_stats2025_raw.json')))
ACT = {r['player_id']: r['stats'] for r in acts}

VANILLA = ['1812 Fantasy League', 'Last One Standing']
HS = '1812 Highest Scorer'

# ---------------------------------------------------------------- scoring
BASE = dict(pass_yd=.04, pass_td=4, pass_int=-1, pass_2pt=2,
            rush_yd=.1, rush_td=6, rush_2pt=2,
            rec=1, rec_yd=.1, rec_td=6, rec_2pt=2, fum_lost=-2)
# Highest Scorer extras we have genuine projections for.
HS_EXTRA = dict(pass_fd=.1, rush_fd=.1, rec_fd=.1, pass_cmp=.01, rec_40p=1.0)
# EXCLUDED from Highest Scorer (no projection exists): pass_sack -0.1, rush_40p +1,
# TD-distance bonuses (40+/50+), 200-yd game bonuses, pass_cmp_40p. Net effect is
# roughly -3 to +4 points across a full season and does not move players between tiers.

def score(stats, rules):
    return sum(v * (stats.get(k) or 0) for k, v in rules.items())

def score_skill(stats, league):
    return score(stats, {**BASE, **HS_EXTRA} if league == HS else BASE)

def score_k(stats, league):
    """League A/C use Sleeper's standard kicker points. Highest Scorer scores FGs by
    yardage (0.1/yd) with distance-weighted miss penalties, which we can compute exactly."""
    if league == HS:
        return (0.1 * (stats.get('fgm_yds') or 0) + (stats.get('xpm') or 0)
                - 2 * (stats.get('xpmiss') or 0)
                - 1.5 * (stats.get('fgmiss_40_49') or 0)
                - 1.0 * (stats.get('fgmiss_50p') or 0))
    return stats.get('pts_ppr') or 0

def score_def(d, league):
    """d = (adp, sleeper_pts, sack, int, fum_rec, blk, tds).
    Highest Scorer: countable events only. Its points-allowed and yards-allowed bands
    (which are heavily NEGATIVE in that league) cannot be projected, so DEF ordering
    there is a proxy — see the Notes tab."""
    _, pts, sack, ints, fum, blk, tds = d
    if league == HS:
        return sack * 1 + ints * 2 + fum * 2 + blk * 3 + tds * 6
    return pts

# ---------------------------------------------------------------- assemble
players = []
for r in proj:
    p, s = r['player'], r['stats']
    pos = p.get('position')
    if pos not in {'QB', 'RB', 'WR', 'TE', 'K'}:
        continue
    team = r.get('team') or p.get('team')
    adp = s.get('adp_ppr', 999)
    # Draftable universe only: someone, somewhere, is drafting this player.
    if not team or adp >= 999:
        continue
    a = ACT.get(r['player_id'], {})
    players.append(dict(
        pid=r['player_id'], name=f"{p['first_name']} {p['last_name']}".strip(),
        pos=pos, team=team, bye=BYE.get(team, 0), adp=adp, _s=s,
        gp=s.get('gp', 17), exp=p.get('years_exp'),
        inj=p.get('injury_status') or '', inj_part=p.get('injury_body_part') or '',
        a_pts=a.get('pts_ppr'), a_gp=a.get('gp'), a_snap=a.get('off_snp'),
        a_tgt=a.get('rec_tgt'), a_rztgt=a.get('rec_rz_tgt'), a_rec=a.get('rec'),
        a_fd=(a.get('rec_fd') or 0) + (a.get('rush_fd') or 0),
        a_posrank=a.get('pos_rank_ppr'), a_carries=a.get('rush_att'),
        pr={k: s.get(k) for k in ('pts_ppr', 'gp', 'rush_att', 'rec', 'rush_yd', 'rec_yd',
                                  'rush_td', 'rec_td', 'pass_yd', 'pass_td', 'rec_fd',
                                  'rush_fd', 'rec_40p', 'adp_ppr')},
    ))
for t, d in DEF_PROJ.items():
    players.append(dict(pid=t, name=f"{t} Defense", pos='DEF', team=t, bye=BYE.get(t, 0),
                        adp=d[0] if d[0] < 999 else 260, _s=d, gp=17, exp=None,
                        inj='', inj_part='', a_pts=None, a_gp=None, a_snap=None,
                        a_tgt=None, a_rztgt=None, a_rec=None, a_fd=0,
                        a_posrank=None, a_carries=None, pr={}))

# ---------------------------------------------------------------- components
import engine2
skill = [p for p in players if p['pos'] in ('QB', 'RB', 'WR', 'TE')]
engine2.build(skill)
for p in players:                       # K and DEF get neutral component scores
    if p['pos'] in ('K', 'DEF'):
        p['is_rookie'] = False
        p['m'] = {'has2025': False, 'rookie_score': None, 'draft_pick': None,
                  'rookie_conf': '', 'raw2025': {}}
        p['c'] = {k: 50.0 for k, _, _, _ in engine2.COMPONENTS}
        import submetrics as _SM
        p['sub'] = {sub: 50.0 for _c, sub, _l, _h, _w, _hi, _on in _SM.ALL_SUBS}

# ---------------------------------------------------------------- per league
FLEX_SHARE = {'RB': .40, 'WR': .55, 'TE': .05}
_PROJ_KEYS = sorted(set(BASE) | set(HS_EXTRA) | {'gp', 'pts_ppr', 'rush_att', 'rec',
                                                 'rush_40p', 'adp_ppr'})

def playoff_grade(team):
    """Weeks 15-17 matchup quality. Opponent defenses' projected fantasy points are a
    proxy for defensive strength: a high-scoring fantasy D is a BAD offensive matchup.
    Returns 1 (easiest) to 5 (hardest)."""
    opps = PLAYOFF_OPP.get(team, [])
    if not opps:
        return None
    return sum(DEF_PROJ.get(o, (0, 80))[1] for o in opps) / len(opps)

def tier_split(vals):
    """Tiers from real gaps in value, not fixed buckets."""
    if len(vals) < 3:
        return [1] * len(vals)
    gaps = [vals[i] - vals[i + 1] for i in range(len(vals) - 1)]
    pos_gaps = sorted(g for g in gaps if g > 0)
    if not pos_gaps:
        return [1] * len(vals)
    thresh = pos_gaps[min(int(len(pos_gaps) * 0.80), len(pos_gaps) - 1)]
    tiers, t = [], 1
    for i in range(len(vals)):
        tiers.append(t)
        if i < len(gaps) and gaps[i] >= thresh:
            t += 1
    return tiers

RESULT, BASELINES = {}, {}
for lname, cfg in LEAGUES.items():
    teams, starters = cfg['teams'], cfg['starters']
    flex = starters.get('FLEX', 0)
    pool = [p for p in players if p['pos'] in starters
            or (p['pos'] in ('RB', 'WR', 'TE') and flex)]

    for p in pool:
        s = p['_s']
        p[lname] = {'pts': round(
            score_def(s, lname) if p['pos'] == 'DEF' else
            score_k(s, lname) if p['pos'] == 'K' else
            score_skill(s, lname), 1)}

    # Replacement level: the starter you'd be forced to settle for. Smoothed across
    # three ranks so one odd projection can't set the baseline.
    base = {}
    for pos in {x['pos'] for x in pool}:
        n = max(1, int(round(teams * (starters.get(pos, 0) + FLEX_SHARE.get(pos, 0) * flex))))
        ranked = sorted([x for x in pool if x['pos'] == pos], key=lambda x: -x[lname]['pts'])
        window = [ranked[i][lname]['pts'] for i in range(max(0, n - 2), min(len(ranked), n + 1))]
        base[pos] = round(sum(window) / len(window), 1)
    BASELINES[lname] = base

    for p in pool:
        p[lname]['vor'] = round(p[lname]['pts'] - base[p['pos']], 1)

    for pos in {x['pos'] for x in pool}:
        grp = sorted([x for x in pool if x['pos'] == pos], key=lambda x: -x[lname]['vor'])
        for i, (x, t) in enumerate(zip(grp, tier_split([g[lname]['vor'] for g in grp])), 1):
            x[lname]['tier'], x[lname]['posrank'] = t, i

    ranked = sorted(pool, key=lambda x: -x[lname]['vor'])
    for i, p in enumerate(ranked, 1):
        L = p[lname]
        L['rank'] = i
        L['round'] = (i - 1) // teams + 1
        L['adp_round'] = round(p['adp'] / teams + 0.5, 1)
        L['edge'] = round(p['adp'] - i, 1)
        L['pg'] = playoff_grade(p['team'])
    RESULT[lname] = ranked
    print(f"{lname}: {len(ranked)} players | replacement: " +
          ", ".join(f"{k} {v:.0f}" for k, v in sorted(base.items())))

# 2026 projected points as a component, percentile within position. Computed PER LEAGUE
# because the three leagues score differently (first downs, explosive plays, kicker rules).
for lname, ranked in RESULT.items():
    for pos in {p['pos'] for p in ranked}:
        grp = [p for p in ranked if p['pos'] == pos]
        vals = sorted({p[lname]['pts'] for p in grp})
        pm = {v: round(i / max(len(vals) - 1, 1) * 100, 1) for i, v in enumerate(vals)}
        for p in grp:
            p[lname]['proj_pct'] = pm[p[lname]['pts']]

# Position value multipliers: how much a starting slot at each position is actually worth
# in THIS league, relative to the most valuable position. Derived from the average VOR of
# the startable pool (teams x starters, including a share of FLEX), not a hand-picked guess.
# These differ sharply between the 12-team and 18-team leagues - that is the whole point.
POSVAL = {}
for lname, cfg in LEAGUES.items():
    ranked, teams, st = RESULT[lname], cfg['teams'], cfg['starters']
    avg = {}
    for pos in {p['pos'] for p in ranked}:
        n = max(1, int(round(teams * (st.get(pos, 0)
                                      + FLEX_SHARE.get(pos, 0) * st.get('FLEX', 0)))))
        top = sorted([p[lname]['vor'] for p in ranked if p['pos'] == pos], reverse=True)[:n]
        avg[pos] = sum(x for x in top if x > 0) / max(len(top), 1)
    mx = max(avg.values()) or 1
    POSVAL[lname] = {pos: round(v / mx, 2) for pos, v in avg.items()}
    print(f"  position value {lname}: " +
          ", ".join(f"{k} {v}" for k, v in sorted(POSVAL[lname].items(), key=lambda x: -x[1])))

# VOR converted to a 0-100 score for blending with the component ratings.
# This is a LINEAR scaling of the actual VOR value, deliberately NOT a percentile.
# A percentile would compress the scale (the 26th-best player would score ~89 instead
# of his true ~35) and destroy the positional-scarcity signal that makes VOR useful:
# the whole point is that the best QB is worth far less than the best RB in a 1-QB league.
# Above replacement, scale 0-100. BELOW replacement, keep a compressed but ORDERED band
# down to -25 instead of clamping everything to 0. Clamping put 142 of 259 players on
# exactly 0, which made their draft scores identical and gave all of them the same rank.
for lname, ranked in RESULT.items():
    mx = max(p[lname]['vor'] for p in ranked) or 1
    mn = min(p[lname]['vor'] for p in ranked) or -1
    for p in ranked:
        v = p[lname]['vor']
        p[lname]['vor_pct'] = round(v / mx * 100 if v > 0 else v / abs(mn) * 25, 1)
    for i, p in enumerate(sorted(ranked, key=lambda x: x['adp']), 1):
        p[lname]['adp_rank'] = i
    adps = sorted({p['adp'] for p in ranked})
    am = {v: round(100 - i / max(len(adps) - 1, 1) * 100, 1) for i, v in enumerate(adps)}
    for p in ranked:
        p[lname]['adp_pct'] = am[p['adp']]

json.dump({'baselines': BASELINES, 'posval': POSVAL,
           'components': [(k, lbl) for k, _, _, lbl in engine2.COMPONENTS],
           'boards': {k: [{**{kk: vv for kk, vv in p.items()
                              if kk not in ('_s', 'm', 'c') and not isinstance(vv, dict)},
                           'lg': p[k], 'c': p['c'], 'm': p['m'],
                           # EVERY scoring input, not a subset - the web app multiplies
                           # these by the league's own rules, so a missing key (pass_int,
                           # fum_lost, pass_fd) silently mis-scores a whole position
                           'pr': ({kk: p['_s'].get(kk) for kk in _PROJ_KEYS
                                   if p['_s'].get(kk) not in (None, 0)}
                                  if isinstance(p['_s'], dict) else {}),
                           # K and DEF are scored by their own rules, not by stat lines,
                           # so the app takes their projected points straight across
                           'ppts': p[k]['pts'],
                           'sub': p.get('sub') or {}}
                          for p in v] for k, v in RESULT.items()}},
          open(os.path.join(HERE, 'board.json'), 'w'), default=str)
print("\nwrote board.json")

rk = sorted([p for p in RESULT['1812 Fantasy League'] if p.get('is_rookie')],
            key=lambda p: -(p['m']['rookie_score'] or 0))
print("\n--- ROOKIE MODEL ---")
for p in rk[:10]:
    m = p['m']
    print(f"  {p['name']:<20}{p['pos']} {p['team']:<4} pick {str(m['draft_pick']):>5}  "
          f"score {m['rookie_score']:>6}  role {m['role_pct']:>5}%  adp {p['adp']:>6}  {m['rookie_conf']}")

for lname in LEAGUES:
    print(f"\n--- {lname} top 15 ---")
    for p in RESULT[lname][:15]:
        L = p[lname]
        print(f"  {L['rank']:>2} {p['name']:<23} {p['pos']}{L['posrank']:<3} T{L['tier']} "
              f"pts {L['pts']:>6} vor {L['vor']:>6} adp {p['adp']:>5} edge {L['edge']:>6}")
