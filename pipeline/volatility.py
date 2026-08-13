"""Who beats their projection, who busts, and does any of it repeat?

Everything else in this pipeline tries to predict the MEAN - how many points a man
scores. That is the crowded problem and we have failed at it four different ways. This
asks about the SPREAD instead, which is a different quantity and usually a more stubborn
one. Touchdown-dependent players tend to stay volatile. High-volume possession players
tend to stay steady. If that holds, then floor and ceiling stop being a blend of stats we
invented and become something measured.

    python volatility.py                # 2020-2025
    python volatility.py 2021 2025

It works on weekly data - Sleeper publishes a projection and a result for every player
every week - so a season is roughly 17 observations per player rather than one. Six
seasons is around twenty thousand player-weeks, which is enough to describe a
distribution instead of guessing at one.

Three questions, in the order they matter:

    1. Does volatility persist?      If a man's boom/bust profile this year tells you
                                     his profile next year, floor and ceiling are real.
    2. Does projection bias persist? If Sleeper under-projects the same players season
                                     after season, that is a discount you can buy, and
                                     the whole room inherits the same bad number.
    3. Does either add lift?         Over plain "he was good last year", for predicting
                                     next season. Held out, same bar as everywhere else.

A missing week is not a missing observation. If a projection existed and the player did
not produce, he scored zero for whoever started him. Those weeks are kept, because they
are exactly the busts that make volatility worth knowing about.
"""
import math
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from backtest import index, spearman             # noqa: E402
from discover import ols, pcts, ranks            # noqa: E402
from fetch import get                            # noqa: E402

POSITIONS = ['QB', 'RB', 'WR', 'TE']
MIN_WEEKS = 8            # fewer than this and a standard deviation is a rumour
WEEKS = range(1, 19)


def week_rows(kind, season, week):
    """One request for every position at once, rather than twelve."""
    qs = ''.join(f'&position[]={p}' for p in POSITIONS)
    url = (f'https://api.sleeper.com/{kind}/nfl/{season}/{week}'
           f'?season_type=regular{qs}&order_by=pts_ppr')
    return get(url) or []


def season_weeks(season):
    """{player_id: {'pos':.., 'name':.., 'weeks': [(projected, actual), ...]}}"""
    proj, act = {}, {}
    for wk in WEEKS:
        p = index(week_rows('projections', season, wk))
        a = index(week_rows('stats', season, wk))
        if not p:
            continue
        proj[wk], act[wk] = p, a
        time.sleep(0.25)          # 216 requests, be polite to a free API
    print(f'  {season}: {len(proj)} weeks fetched')

    out = {}
    for wk in sorted(proj):
        for pid, pr in proj[wk].items():
            pv = float(pr['a'].get('pts_ppr') or 0)
            if pv <= 0:
                continue          # no projection means he was not startable that week
            got = act.get(wk, {}).get(pid)
            av = float(got['a'].get('pts_ppr') or 0) if got else 0.0
            rec = out.setdefault(pid, {'pos': pr['pos'], 'name': pr['name'], 'weeks': []})
            rec['weeks'].append((pv, av))
    return out


def profile(weeks):
    """Turn one player-season of weekly results into the numbers a drafter cares about."""
    n = len(weeks)
    proj = [p for p, _a in weeks]
    act = [a for _p, a in weeks]
    mp, ma = sum(proj) / n, sum(act) / n

    sd = math.sqrt(sum((a - ma) ** 2 for a in act) / n)
    miss = [a - p for p, a in weeks]
    mmiss = sum(miss) / n
    sdmiss = math.sqrt(sum((m - mmiss) ** 2 for m in miss) / n)

    return {
        'n': n,
        'mean': ma,
        'proj': mp,
        'bias': mmiss,                                   # + means he beats his projection
        'sd': sd,
        'cv': sd / ma if ma > 1 else 0.0,                # spread relative to his own level
        'sdmiss': sdmiss,
        'boom': sum(1 for p, a in weeks if a >= p * 1.5) / n,
        'bust': sum(1 for p, a in weeks if a <= p * 0.5) / n,
    }


def build(seasons):
    """{pos: {pair_year: [rows]}} - each row is a player's year N-1 profile and year N result."""
    years = sorted(seasons)
    out = {p: {} for p in POSITIONS}
    for a, b in zip(years, years[1:]):
        for pid, rec in seasons[a].items():
            if rec['pos'] not in POSITIONS or len(rec['weeks']) < MIN_WEEKS:
                continue
            prior = profile(rec['weeks'])
            nxt = seasons[b].get(pid)
            after = profile(nxt['weeks']) if nxt and len(nxt['weeks']) >= MIN_WEEKS else None
            out[rec['pos']].setdefault(b, []).append(
                {'id': pid, 'name': rec['name'], 'prior': prior, 'after': after,
                 'next_mean': after['mean'] if after else 0.0})
    return out


def persistence(table, field, label):
    """Does this trait in one season tell you the same trait the next season?"""
    print(f'\n{label}')
    print(f"    {'':<6}" + ''.join(f'{p:>9}' for p in POSITIONS) + f"{'':>4}")
    pairs_all = sorted({y for pos in POSITIONS for y in table[pos]})
    for yr in pairs_all:
        line = f'    {yr:<6}'
        for pos in POSITIONS:
            rows = [r for r in table[pos].get(yr, []) if r['after']]
            if len(rows) < 25:
                line += f"{'-':>9}"
                continue
            rho = spearman([(r['prior'][field], r['after'][field]) for r in rows])
            line += f'{rho:>9.2f}'
        print(line)
    line = f"    {'mean':<6}"
    for pos in POSITIONS:
        vals = []
        for yr in pairs_all:
            rows = [r for r in table[pos].get(yr, []) if r['after']]
            if len(rows) >= 25:
                rho = spearman([(r['prior'][field], r['after'][field]) for r in rows])
                if not math.isnan(rho):
                    vals.append(rho)
        line += f'{sum(vals) / len(vals):>9.2f}' if vals else f"{'-':>9}"
    print(line + '   <- the row that matters')


def lift(table):
    """Do the weekly traits add anything to 'he was good last year', out of sample?"""
    print('\n' + '=' * 74)
    print('DO THE WEEKLY TRAITS ADD LIFT?')
    print('=' * 74)
    print('Fitted on the early year-pairs, judged on the most recent one. Same bar as')
    print('everywhere else: +0.03 or it is not an edge.\n')

    feats = ['cv', 'bias', 'boom', 'bust', 'sd']
    for pos in POSITIONS:
        yrs = sorted(table[pos])
        if len(yrs) < 2:
            print(f'{pos}: needs two year-pairs.\n')
            continue
        hold = yrs[-1]
        tr = [r for y in yrs[:-1] for r in table[pos][y]]
        te = list(table[pos][hold])
        if len(tr) < 60 or len(te) < 25:
            print(f'{pos}: not enough rows ({len(tr)} train, {len(te)} test).\n')
            continue

        def design(rows):
            base = pcts([r['prior']['mean'] for r in rows])
            cols = {f: pcts([r['prior'][f] for r in rows]) for f in feats}
            return ([[1.0, base[i]] for i in range(len(rows))],
                    [[cols[f][i] for f in feats] for i in range(len(rows))])

        Xb_tr, Xf_tr = design(tr)
        Xb_te, Xf_te = design(te)
        y_tr = ranks([r['next_mean'] for r in tr])
        y_te = [r['next_mean'] for r in te]

        b0 = ols(Xb_tr, y_tr)
        b1 = ols([b + f for b, f in zip(Xb_tr, Xf_tr)], y_tr)
        if not b0 or not b1:
            print(f'{pos}: could not fit.\n')
            continue
        p0 = [sum(c * v for c, v in zip(b0, x)) for x in Xb_te]
        p1 = [sum(c * v for c, v in zip(b1, x)) for x in
              [b + f for b, f in zip(Xb_te, Xf_te)]]
        s0, s1 = spearman(list(zip(p0, y_te))), spearman(list(zip(p1, y_te)))
        d = s1 - s0
        verdict = ('a real edge' if d >= 0.03 else
                   'noise, not an edge' if d > -0.01 else 'actively worse')
        print(f'{pos}  held out {hold}, n={len(te)}')
        print(f'    last season alone        {s0:.3f}')
        print(f'    plus the weekly traits   {s1:.3f}')
        print(f'    lift                     {d:+.3f}   <- {verdict}\n')


def examples(table):
    """Name names, so the numbers can be sanity-checked against memory."""
    print('\n' + '=' * 74)
    print('THE BIGGEST MISSES, MOST RECENT SEASON')
    print('=' * 74)
    print('Projection versus reality, averaged over the weeks he was projected to play.\n')
    for pos in POSITIONS:
        yrs = sorted(table[pos])
        if not yrs:
            continue
        rows = sorted(table[pos][yrs[-1]], key=lambda r: -r['prior']['bias'])
        rows = [r for r in rows if r['prior']['n'] >= 12]
        if len(rows) < 10:
            continue
        print(f'{pos}   beat their projection            missed their projection')
        for over, under in zip(rows[:5], list(reversed(rows))[:5]):
            print(f'    {over["name"][:20]:<20} {over["prior"]["bias"]:>+5.1f}/wk'
                  f'      {under["name"][:20]:<20} {under["prior"]["bias"]:>+5.1f}/wk')
        print()


def run(lo, hi):
    seasons = {}
    for yr in range(int(lo), int(hi) + 1):
        seasons[str(yr)] = season_weeks(str(yr))

    table = build(seasons)
    total = sum(len(v) for pos in POSITIONS for v in table[pos].values())
    print(f'\n{total} player-seasons with at least {MIN_WEEKS} projected weeks.')

    print('\n' + '=' * 74)
    print('DOES ANY OF IT PERSIST?')
    print('=' * 74)
    print('A trait that does not repeat cannot be drafted on, however real it was last')
    print('year. Rank correlation of the trait in one season with the same trait in the')
    print('next. Above about 0.30 is usable; near zero means it was luck.')

    persistence(table, 'cv', 'VOLATILITY  (spread of weekly points, relative to his own average)')
    persistence(table, 'boom', 'BOOM RATE   (weeks beating his projection by half again)')
    persistence(table, 'bust', 'BUST RATE   (weeks at half his projection or worse)')
    persistence(table, 'bias', 'BEATING THE PROJECTION  (does Sleeper keep getting the same men wrong?)')

    lift(table)
    examples(table)

    print('Read it this way. Persistence decides whether floor and ceiling can be')
    print('measured instead of invented - that is worth having even with no lift at all,')
    print('because it makes the slider honest. Lift decides whether any of it belongs in')
    print('the Rating. They are separate questions and can have separate answers.')


if __name__ == '__main__':
    a = sys.argv[1] if len(sys.argv) > 1 else '2020'
    b = sys.argv[2] if len(sys.argv) > 2 else '2025'
    run(a, b)
