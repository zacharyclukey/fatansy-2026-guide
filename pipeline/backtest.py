"""Does the rating actually predict anything?

The whole app rests on an assumption nobody has ever checked: that blending fifty stats
into components produces a better read on next season than the obvious alternatives. This
answers that, honestly, with the same code the app uses.

    python backtest.py                 # 2024 stats -> 2025 outcomes
    python backtest.py 2023 2024       # any pair of seasons

What it does
    1. Fetch season N-1 stats and season N stats from Sleeper.
    2. Build the rating for every player from ONLY the N-1 data, using submetrics.py -
       the same definitions the app ships with.
    3. Compare that rating against three baselines at predicting season N points per game.

The baselines matter more than the headline number. Beating nothing is easy; beating
"he was good last year" is the bar.

    last year's points per game     the naive baseline everyone actually uses
    last year's positional finish   the other naive one
    snap share                      a single stat, to check the blend adds anything

What this CANNOT test
    Sleeper does not publish historical ADP, so the rating cannot be compared against the
    market - which is the comparison you would most like. It is measured against naive
    baselines only, and that limit is real.

Survivorship is handled: a player with no season N row scored zero fantasy points that
year as far as the draft was concerned, so he is kept with a zero, not dropped. Dropping
him would quietly delete every bust and flatter the model.
"""
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import submetrics as SM          # noqa: E402  - the app's own stat definitions
from fetch import collect        # noqa: E402  - the app's own fetcher

MIN_GAMES = 4                    # below this a per-game rate is noise, not a signal


def spearman(pairs):
    """Rank correlation. Robust to the wild outliers a fantasy season produces."""
    if len(pairs) < 8:
        return float('nan')

    def ranks(vals):
        order = sorted(range(len(vals)), key=lambda i: vals[i])
        out = [0.0] * len(vals)
        i = 0
        while i < len(order):
            j = i
            while j + 1 < len(order) and vals[order[j + 1]] == vals[order[i]]:
                j += 1
            avg = (i + j) / 2 + 1
            for k in range(i, j + 1):
                out[order[k]] = avg
            i = j + 1
        return out

    xs = ranks([p[0] for p in pairs])
    ys = ranks([p[1] for p in pairs])
    n = len(xs)
    mx = sum(xs) / n
    my = sum(ys) / n
    num = sum((a - mx) * (b - my) for a, b in zip(xs, ys))
    den = math.sqrt(sum((a - mx) ** 2 for a in xs) * sum((b - my) ** 2 for b in ys))
    return num / den if den else float('nan')


def hit_rate(pairs, top=24):
    """Of the players this metric ranked in its top N, how many finished in the real top N?"""
    if len(pairs) < top * 2:
        return float('nan')
    picked = {i for i, _ in sorted(enumerate(pairs), key=lambda kv: -kv[1][0])[:top]}
    actual = {i for i, _ in sorted(enumerate(pairs), key=lambda kv: -kv[1][1])[:top]}
    return len(picked & actual) / top


def component_scores(stats, pos):
    """Every component's percentile score per player, so each can be judged on its own."""
    groups = {pid: row for pid, row in stats.items() if row.get('pos') == pos}
    if len(groups) < 12:
        return {}, {}

    pct = {pid: {} for pid in groups}
    for _ck, _label, _desc, subs in SM.COMPONENTS:
        for key, _lbl, fn, higher, _w, needs_hist, on in subs:
            if not on or not needs_hist:
                continue
            vals = []
            for pid, row in groups.items():
                try:
                    vals.append((pid, float(fn(row['a'], {}, {}) or 0)))
                except Exception:
                    vals.append((pid, 0.0))
            vals.sort(key=lambda kv: kv[1], reverse=not higher)
            n = len(vals)
            for i, (pid, _v) in enumerate(vals):
                pct[pid][key] = (i / (n - 1)) * 100 if n > 1 else 50.0

    comps = {pid: {} for pid in groups}
    for ck, _label, _desc, subs in SM.COMPONENTS:
        for pid in groups:
            num = den = 0.0
            for key, _lbl, _fn, _hi, w, needs_hist, on in subs:
                if not on or not needs_hist:
                    continue
                pw = SM.weight_for(key, w, pos)
                if not pw or key not in pct[pid]:
                    continue
                num += pct[pid][key] * pw
                den += pw
            comps[pid][ck] = (num / den) if den else None
    return comps, groups


def rating_from(stats, pos):
    """The app's rating, built only from the season handed in.

    Percentiles are within position, exactly as the app computes them, and the component
    blend uses the shipped default weights. No projection component - there is no
    projection for a past season, which is itself worth noting: the component that moves
    the board most in the app is the one this test cannot include.
    """
    groups = {}
    for pid, row in stats.items():
        if row.get('pos') != pos:
            continue
        groups[pid] = row

    if len(groups) < 12:
        return {}

    # every sub-metric, as a percentile within the position
    pct = {pid: {} for pid in groups}
    for comp_key, _label, _desc, subs in SM.COMPONENTS:
        for key, _lbl, fn, higher, _w, needs_hist, on in subs:
            if not on or not needs_hist:
                continue
            vals = []
            for pid, row in groups.items():
                try:
                    vals.append((pid, float(fn(row['a'], {}, {}) or 0)))
                except Exception:
                    vals.append((pid, 0.0))
            vals.sort(key=lambda kv: kv[1], reverse=not higher)
            n = len(vals)
            for i, (pid, _v) in enumerate(vals):
                pct[pid][key] = (i / (n - 1)) * 100 if n > 1 else 50.0

    out = {}
    for pid in groups:
        total = 0.0
        wsum = 0.0
        for comp_key, _label, _desc, subs in SM.COMPONENTS:
            num = den = 0.0
            for key, _lbl, _fn, _hi, w, needs_hist, on in subs:
                if not on or not needs_hist:
                    continue
                pw = SM.weight_for(key, w, pos)
                if not pw or key not in pct[pid]:
                    continue
                num += pct[pid][key] * pw
                den += pw
            if den:
                cw = SM.COMPONENT_WEIGHTS.get(comp_key, 10)
                total += (num / den) * cw
                wsum += cw
        out[pid] = total / wsum if wsum else 50.0
    return out


def index(rows):
    """Sleeper rows -> {player_id: {pos, name, a: stats}}"""
    out = {}
    for r in rows:
        pid = str(r.get('player_id') or '')
        pl = r.get('player') or {}
        if not pid or not pl.get('position'):
            continue
        out[pid] = {
            'pos': pl['position'],
            'name': f"{pl.get('first_name', '')} {pl.get('last_name', '')}".strip(),
            'a': r.get('stats') or {},
        }
    return out


def run(prior_year, target_year, prior_rows=None, target_rows=None):
    prior = index(prior_rows if prior_rows is not None else collect('stats', prior_year))
    target = index(target_rows if target_rows is not None else collect('stats', target_year))
    print(f'\n{prior_year}: {len(prior)} players   {target_year}: {len(target)} players')

    report = []
    for pos in ['QB', 'RB', 'WR', 'TE']:
        rated = rating_from(prior, pos)
        rows = []
        for pid, r in prior.items():
            if r['pos'] != pos or pid not in rated:
                continue
            gp = float(r['a'].get('gp') or 0)
            if gp < MIN_GAMES:
                continue
            t = target.get(pid)
            # no row next season means he did not produce - that is a zero, not a gap
            got = (float(t['a'].get('pts_ppr') or 0) / max(float(t['a'].get('gp') or 1), 1)) if t else 0.0
            rows.append({
                'name': r['name'],
                'rating': rated[pid],
                'lastPpg': float(r['a'].get('pts_ppr') or 0) / gp,
                'lastFinish': -float(r['a'].get('pos_rank_ppr') or 999),
                'snap': float(r['a'].get('off_snp') or 0) / max(float(r['a'].get('tm_off_snp') or 1), 1),
                'next': got,
            })
        if len(rows) < 20:
            print(f'  {pos}: only {len(rows)} players with enough {prior_year} data, skipping')
            continue

        metrics = {
            'the rating': [(r['rating'], r['next']) for r in rows],
            "last year's points/game": [(r['lastPpg'], r['next']) for r in rows],
            "last year's finish": [(r['lastFinish'], r['next']) for r in rows],
            'snap share alone': [(r['snap'], r['next']) for r in rows],
        }
        report.append((pos, len(rows), {k: (spearman(v), hit_rate(v, min(24, len(rows) // 3)))
                                        for k, v in metrics.items()}))

    print(f'\nPredicting {target_year} points per game from {prior_year} data')
    print('Spearman rank correlation, and hit rate on the top third\n')
    print(f"{'':<26}" + ''.join(f'{p:>18}' for p, _n, _m in report))
    print(f"{'':<26}" + ''.join(f"{'(n=' + str(n) + ')':>18}" for _p, n, _m in report))
    names = ['the rating', "last year's points/game", "last year's finish", 'snap share alone']
    for name in names:
        line = f'{name:<26}'
        for _pos, _n, m in report:
            rho, hit = m[name]
            line += f'{rho:>10.2f} {hit * 100:>6.0f}%'
        print(line)

    wins = sum(1 for _p, _n, m in report
               if m['the rating'][0] > max(m[k][0] for k in names if k != 'the rating'))
    # -------- which components actually predict, one at a time --------
    print('\n\nEach component on its own, against the same outcome')
    print('(a component that cannot beat noise is costing you weight)\n')
    per = {}
    for pos in ['QB', 'RB', 'WR', 'TE']:
        comps, groups = component_scores(prior, pos)
        if not comps:
            continue
        for ck, label, _d, _s in SM.COMPONENTS:
            pairs = []
            for pid, row in groups.items():
                if float(row['a'].get('gp') or 0) < MIN_GAMES:
                    continue
                v = comps[pid].get(ck)
                if v is None:
                    continue
                t = target.get(pid)
                got = (float(t['a'].get('pts_ppr') or 0) / max(float(t['a'].get('gp') or 1), 1)) if t else 0.0
                pairs.append((v, got))
            if len(pairs) >= 20:
                per.setdefault(label, {})[pos] = spearman(pairs)

    cols = [p for p in ['QB', 'RB', 'WR', 'TE'] if any(p in v for v in per.values())]
    print(f"{'':<16}" + ''.join(f'{c:>8}' for c in cols) + f"{'mean':>9}")
    ranked = sorted(per.items(),
                    key=lambda kv: -sum(kv[1].values()) / max(len(kv[1]), 1))
    for label, byp in ranked:
        line = f'{label:<16}'
        for c in cols:
            line += f'{byp[c]:>8.2f}' if c in byp else f"{'-':>8}"
        line += f'{sum(byp.values()) / len(byp):>9.2f}'
        print(line)
    print('\nThe app currently weights them:')
    print('  ' + ', '.join(f'{lbl} {SM.COMPONENT_WEIGHTS.get(k, 0)}'
                           for k, lbl, _d, _s in SM.COMPONENTS))

    print(f'\nThe rating is the best predictor at {wins} of {len(report)} positions.')
    if wins <= len(report) / 2:
        print('That is not a good result. The blend is not beating the naive baselines,')
        print('which means the components are mostly re-describing last season, not')
        print('forecasting the next one.')
    return report


if __name__ == '__main__':
    a = sys.argv[1] if len(sys.argv) > 1 else '2024'
    b = sys.argv[2] if len(sys.argv) > 2 else str(int(a) + 1)
    run(a, b)
