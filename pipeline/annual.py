"""Who beats their preseason projection, who falls short, and can you see it coming?

The weekly study asks about spread. This one asks about the season as a whole: you draft
a man because a number said he would score 240 points, and he scored 310, or 90. Is
there anything visible in August that says which it will be?

    python annual.py                # 2020-2025
    python annual.py 2021 2025

Three parts, and the first is not optional.

    1. IS THE PROJECTION ACTUALLY PRESEASON?
       Sleeper returns a season projection for 2022 today, but nothing says whether that
       is the number as it stood in August 2022 or one quietly updated afterwards. If it
       is the latter, every result below would be contaminated and would look like a
       brilliant finding rather than a bug. Week 1's projection is provably preseason -
       it is published before a game is played - so the two are compared. If the season
       endpoint is suspiciously more accurate than week one, it has seen the future and
       the week-one version is used instead.

    2. IS THE PROJECTION CALIBRATED?
       Regression to the mean says the most optimistic projections should fall short and
       the modest ones should beat. If that holds it is directly usable and has nothing
       to do with forecasting anyone: it says the top of the board is priced too
       confidently, every year, for everyone.

    3. CAN YOU SEE A BEAT COMING?
       Everything knowable in August - last year's volume, availability, boom and bust
       rates, and how big a jump the projection is asking him to make - against how far
       he beat or missed. Held out on the most recent season, same bar as everywhere
       else.

Two different surprises are reported, because they answer different questions. Total
surprise includes getting hurt, which is what actually happened to your team. Per-game
surprise removes it, and says whether he was good when he played.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from backtest import index, spearman             # noqa: E402
from discover import ols, pcts, ranks            # noqa: E402
from fetch import collect                        # noqa: E402
from volatility import week_rows, profile        # noqa: E402

POSITIONS = ['QB', 'RB', 'WR', 'TE']
MIN_PROJ = {'QB': 120, 'RB': 80, 'WR': 80, 'TE': 60}     # below this nobody is drafting him
BUCKETS = [(1, 6), (7, 12), (13, 24), (25, 48), (49, 96)]


def preseason(season):
    """Week 1's projection, scaled to a season. Provably made before anything happened."""
    rows = index(week_rows('projections', season, 1))
    return {pid: float(r['a'].get('pts_ppr') or 0) * 17
            for pid, r in rows.items() if float(r['a'].get('pts_ppr') or 0) > 0}


def integrity(seasons, seasonproj, wk1):
    """Has the season-level projection been updated with hindsight?"""
    print('\n' + '=' * 74)
    print('IS THE SEASON PROJECTION ACTUALLY PRESEASON?')
    print('=' * 74)
    print('Week 1 is published before a game is played, so it cannot have seen the')
    print('future. If the season endpoint scores much higher against reality, it has.\n')

    verdict = {}
    for yr in sorted(seasonproj):
        pairs_s, pairs_w, agree = [], [], []
        for pid, pv in seasonproj[yr].items():
            act = seasons.get(yr, {}).get(pid)
            if pv <= 0 or pid not in wk1.get(yr, {}):
                continue
            real = float(act['a'].get('pts_ppr') or 0) if act else 0.0
            pairs_s.append((pv, real))
            pairs_w.append((wk1[yr][pid], real))
            agree.append((pv, wk1[yr][pid]))
        if len(pairs_s) < 60:
            print(f'  {yr}: too few overlapping players to check')
            continue
        rs, rw = spearman(pairs_s), spearman(pairs_w)
        ra = spearman(agree)
        flag = ('SUSPECT - looks updated' if rs - rw > 0.12 else 'consistent with preseason')
        verdict[yr] = rs - rw <= 0.12
        print(f'  {yr}  season endpoint {rs:.2f} vs reality, week-1 x17 {rw:.2f}, '
              f'they agree with each other {ra:.2f}   {flag}')
    bad = [y for y, ok in verdict.items() if not ok]
    if bad:
        print(f'\n  Using the week-1 projection instead for: {", ".join(sorted(bad))}')
    else:
        print('\n  No sign of hindsight. Using the season endpoint.')
    return verdict


def rows_for(seasons, proj, pos, yr):
    out = []
    for pid, pv in proj.get(yr, {}).items():
        p = seasons[yr].get(pid) or {}
        if (p.get('pos') or '') != pos or pv < MIN_PROJ[pos]:
            continue
        gp = float(p.get('a', {}).get('gp') or 0)
        tot = float(p.get('a', {}).get('pts_ppr') or 0)
        out.append({'id': pid, 'name': p.get('name', '?'), 'proj': pv, 'total': tot,
                    'gp': gp, 'ppg': tot / gp if gp else 0.0,
                    'projppg': pv / 17.0})
    out.sort(key=lambda r: -r['proj'])
    for i, r in enumerate(out):
        r['projrank'] = i + 1
        r['surprise'] = r['total'] - r['proj']
        r['surpg'] = r['ppg'] - r['projppg']
    return out


def calibration(seasons, proj, years):
    print('\n' + '=' * 74)
    print('IS THE PROJECTION CALIBRATED?')
    print('=' * 74)
    print('Players grouped by where the projection ranked them. "Beat" is finishing above')
    print('the number they were sold at. If the top buckets sit well under half, the top')
    print('of the board is priced too confidently and that is true every single year.\n')

    for pos in POSITIONS:
        allrows = [r for yr in years for r in rows_for(seasons, proj, pos, yr)]
        if len(allrows) < 80:
            print(f'{pos}: too few rows.\n')
            continue
        print(f'{pos}')
        print(f"    {'projected':<12}{'n':>5}{'beat it':>10}{'avg miss':>11}"
              f"{'per game':>11}{'played 14+':>12}")
        for lo, hi in BUCKETS:
            b = [r for r in allrows if lo <= r['projrank'] <= hi]
            if len(b) < 12:
                continue
            beat = sum(1 for r in b if r['surprise'] > 0) / len(b)
            avg = sum(r['surprise'] for r in b) / len(b)
            apg = sum(r['surpg'] for r in b) / len(b)
            heal = sum(1 for r in b if r['gp'] >= 14) / len(b)
            print(f'    {f"{lo}-{hi}":<12}{len(b):>5}{beat * 100:>9.0f}%{avg:>11.0f}'
                  f'{apg:>11.1f}{heal * 100:>11.0f}%')
        print()


def indicators(seasons, proj, weekly, years):
    print('\n' + '=' * 74)
    print('CAN YOU SEE A BEAT COMING?')
    print('=' * 74)
    print('Everything knowable in August, against how far he beat or missed his own')
    print('projection. Fitted on the earlier seasons, judged on the most recent.\n')

    feats = ['last_ppg', 'last_gp', 'cv', 'boom', 'bust', 'bias', 'jump']
    for pos in POSITIONS:
        data = {}
        for a, b in zip(years, years[1:]):
            rows = []
            for r in rows_for(seasons, proj, pos, b):
                prev = seasons[a].get(r['id'])
                wk = weekly.get(a, {}).get(r['id'])
                if not prev or not wk or len(wk['weeks']) < 8:
                    continue          # rookies and the absent have no August history
                pr = profile(wk['weeks'])
                gp = float(prev['a'].get('gp') or 0)
                lppg = float(prev['a'].get('pts_ppr') or 0) / gp if gp else 0.0
                rows.append({**r, 'last_ppg': lppg, 'last_gp': gp, 'cv': pr['cv'],
                             'boom': pr['boom'], 'bust': pr['bust'], 'bias': pr['bias'],
                             # how big a leap is the projection asking for?
                             'jump': r['projppg'] - lppg})
            if len(rows) >= 30:
                data[b] = rows
        if len(data) < 2:
            print(f'{pos}: not enough seasons with history.\n')
            continue

        yrs = sorted(data)
        tr = [r for y in yrs[:-1] for r in data[y]]
        te = data[yrs[-1]]
        if len(tr) < 60 or len(te) < 25:
            print(f'{pos}: {len(tr)} train / {len(te)} test, too thin.\n')
            continue

        print(f'{pos}  held out {yrs[-1]}, n={len(te)}')
        for key, target in [('total surprise', 'surprise'), ('per-game surprise', 'surpg')]:
            corr = []
            for f in feats:
                rho = spearman([(r[f], r[target]) for r in tr])
                if not math.isnan(rho):
                    corr.append((abs(rho), rho, f))
            corr.sort(reverse=True)
            top = ', '.join(f'{f} {r:+.2f}' for _a, r, f in corr[:3])
            X = [[1.0] + [pcts([r[f] for r in tr])[i] for f in feats]
                 for i in range(len(tr))]
            beta = ols(X, ranks([r[target] for r in tr]))
            if beta:
                Xte = [[1.0] + [pcts([r[f] for r in te])[i] for f in feats]
                       for i in range(len(te))]
                pred = [sum(c * v for c, v in zip(beta, x)) for x in Xte]
                out = spearman(list(zip(pred, [r[target] for r in te])))
                good = ('predictable' if out >= 0.20 else
                        'weak' if out >= 0.10 else 'essentially unpredictable')
                print(f'    {key:<20} strongest in training: {top}')
                print(f'    {"":<20} held-out correlation {out:+.2f}  <- {good}')
        print()


def examples(seasons, proj, years):
    print('\n' + '=' * 74)
    print(f'BIGGEST BEATS AND MISSES, {years[-1]}')
    print('=' * 74)
    print('Check these against what you remember. If the names look wrong, the numbers')
    print('are wrong, and nothing above should be believed.\n')
    for pos in POSITIONS:
        rows = [r for r in rows_for(seasons, proj, pos, years[-1]) if r['projrank'] <= 60]
        if len(rows) < 20:
            continue
        rows.sort(key=lambda r: -r['surprise'])
        print(f'{pos}   beat the projection                     fell short')
        for o, u in zip(rows[:5], list(reversed(rows))[:5]):
            print(f'    {o["name"][:18]:<18}{o["surprise"]:>+6.0f} ({o["gp"]:.0f}g)'
                  f'      {u["name"][:18]:<18}{u["surprise"]:>+6.0f} ({u["gp"]:.0f}g)')
        print()


def run(lo, hi):
    years = [str(y) for y in range(int(lo), int(hi) + 1)]
    seasons, seasonproj, wk1, weekly = {}, {}, {}, {}
    for yr in years:
        seasons[yr] = index(collect('stats', yr))
        seasonproj[yr] = {pid: float(r['a'].get('pts_ppr') or 0)
                          for pid, r in index(collect('projections', yr)).items()}
        wk1[yr] = preseason(yr)
        print(f'  {yr}: {len(seasons[yr])} players, {len(seasonproj[yr])} projections, '
              f'{len(wk1[yr])} week-1 projections')

    ok = integrity(seasons, seasonproj, wk1)
    proj = {yr: (seasonproj[yr] if ok.get(yr, True) else wk1[yr]) for yr in years}

    calibration(seasons, proj, years)

    for yr in years[:-1]:
        from volatility import season_weeks
        weekly[yr] = season_weeks(yr)
    indicators(seasons, proj, weekly, years)

    examples(seasons, proj, years)

    print('If the calibration table shows the top buckets beating well under half the')
    print('time, that is the usable finding, and it needs no model at all: it says the')
    print('projections are too confident about the players they are most confident')
    print('about. Whether an individual beat is foreseeable is a separate question, and')
    print('the held-out number is the only honest answer to it.')


if __name__ == '__main__':
    a = sys.argv[1] if len(sys.argv) > 1 else '2020'
    b = sys.argv[2] if len(sys.argv) > 2 else '2025'
    run(a, b)
