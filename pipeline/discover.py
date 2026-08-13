"""What actually tells you a player will BEAT his last season?

The first backtest asked whether the rating beats "last year's points per game". It does
not. But that was the wrong bar, because nobody drafts blind to last year's production -
the market already prices it in. The question that decides drafts is:

    what tells you a player will outperform what last season would have you believe?

That is the same thing as "who were the steals", stated so a computer can check it. This
script answers it.

    python discover.py                    # 2020-2025, five year-pairs
    python discover.py 2018 2025          # any span

Method
    1. Fetch every season in the span.
    2. Build year-pairs: (2020->2021), (2021->2022), ... Each player-season is one row.
    3. Rank-residualise. Rank players by last year's points per game, rank them by what
       they ACTUALLY did the following year, and take the part of the second that the
       first cannot explain. That residual is the steal - a positive one beat his
       baseline, a negative one busted relative to it.
    4. For every sub-metric the app ships, correlate it with that residual. A stat with
       no partial signal is decoration, no matter how well it correlates on its own,
       because last year's points already told you that much.
    5. Then fit a blend on the early pairs and test it on the final pair it has never
       seen. If the fitted blend cannot beat the baseline out of sample, no hand-tuned
       set of weights is going to either, and the rating should stop claiming to predict.

Percentiles are taken within position AND season, so a 2021 row and a 2024 row are
comparable and no season's scoring environment dominates.

Survivorship: a player with no row the following season scored zero as far as your draft
was concerned. He is kept as a zero. Dropping him would delete every bust.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import submetrics as SM          # noqa: E402  - the app's own stat definitions
from backtest import index, spearman, MIN_GAMES   # noqa: E402
from fetch import collect        # noqa: E402

MAX_STATS = 5        # a blend nobody can hold in their head is not a slider people use
POSITIONS = ['QB', 'RB', 'WR', 'TE']


def all_subs(pos):
    """Every sub-metric that is switched on, historical, and means something at this position."""
    out = []
    for ck, _label, _desc, subs in SM.COMPONENTS:
        for key, lbl, fn, higher, w, needs_hist, on in subs:
            if on and needs_hist and SM.weight_for(key, w, pos):
                out.append((key, lbl, fn, higher, ck))
    return out


def pcts(vals):
    """Values -> 0-100 percentile, ties averaged. Within one position-season."""
    order = sorted(range(len(vals)), key=lambda i: vals[i])
    out = [50.0] * len(vals)
    n = len(vals)
    i = 0
    while i < n:
        j = i
        while j + 1 < n and vals[order[j + 1]] == vals[order[i]]:
            j += 1
        share = ((i + j) / 2) / (n - 1) * 100 if n > 1 else 50.0
        for k in range(i, j + 1):
            out[order[k]] = share
        i = j + 1
    return out


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


def zed(vals):
    """Standardise, so fitted coefficients are comparable in size."""
    n = len(vals)
    m = sum(vals) / n
    sd = math.sqrt(sum((v - m) ** 2 for v in vals) / n) or 1.0
    return [(v - m) / sd for v in vals]


def ols(X, y):
    """Least squares via normal equations. Small k, so a plain solve is fine."""
    k = len(X[0])
    A = [[sum(X[r][i] * X[r][j] for r in range(len(X))) for j in range(k)] + [
        sum(X[r][i] * y[r] for r in range(len(X)))] for i in range(k)]
    for c in range(k):                                     # gaussian elimination
        p = max(range(c, k), key=lambda r: abs(A[r][c]))
        if abs(A[p][c]) < 1e-9:
            return None
        A[c], A[p] = A[p], A[c]
        for r in range(k):
            if r == c:
                continue
            f = A[r][c] / A[c][c]
            for j in range(c, k + 1):
                A[r][j] -= f * A[c][j]
    return [A[i][k] / A[i][i] for i in range(k)]


def build(seasons, pos):
    """One row per player-season: his stat percentiles, his baseline, and what he then did."""
    subs = all_subs(pos)
    rows = []
    years = sorted(seasons)
    for a, b in zip(years, years[1:]):
        prior, target = seasons[a], seasons[b]
        group = {pid: r for pid, r in prior.items()
                 if r['pos'] == pos and float(r['a'].get('gp') or 0) >= MIN_GAMES}
        if len(group) < 20:
            continue
        ids = list(group)

        col = {}
        for key, _lbl, fn, higher, _ck in subs:
            raw = []
            for pid in ids:
                try:
                    raw.append(float(fn(group[pid]['a'], {}, {}) or 0))
                except Exception:
                    raw.append(0.0)
            p = pcts(raw)
            col[key] = [(v if higher else 100 - v) for v in p]   # higher always = better

        base = pcts([float(group[pid]['a'].get('pts_ppr') or 0)
                     / max(float(group[pid]['a'].get('gp') or 1), 1) for pid in ids])

        for i, pid in enumerate(ids):
            t = target.get(pid)
            nxt = (float(t['a'].get('pts_ppr') or 0)
                   / max(float(t['a'].get('gp') or 1), 1)) if t else 0.0
            rows.append({'pair': b, 'id': pid, 'name': group[pid]['name'],
                         'base': base[i], 'next': nxt,
                         'x': {k: col[k][i] for k in col}})
    return rows, subs


def comp_by_pair(rows, subs, pos):
    """Each component's correlation with next season, one year-pair at a time.

    The single-pair backtest said Reliability was worth -0.31 at running back. That is
    either a real effect or one season being one season. Showing every pair separately is
    the only way to tell, so the spread is printed next to the mean.
    """
    bykey = {}
    for ck, _label, _desc, ss in SM.COMPONENTS:
        for key, _l, _fn, _hi, w, needs_hist, on in ss:
            if on and needs_hist and SM.weight_for(key, w, pos):
                bykey.setdefault(ck, []).append((key, SM.weight_for(key, w, pos)))

    out = {}
    for pair in sorted({r['pair'] for r in rows}):
        sub = [r for r in rows if r['pair'] == pair]
        if len(sub) < 20:
            continue
        for ck, members in bykey.items():
            vals = []
            for r in sub:
                num = den = 0.0
                for key, w in members:
                    if key in r['x']:
                        num += r['x'][key] * w
                        den += w
                vals.append(num / den if den else 50.0)
            rho = spearman(list(zip(vals, [r['next'] for r in sub])))
            if not math.isnan(rho):
                out.setdefault(ck, []).append((pair, rho))
    return out


def residual(rows):
    """The part of next season that last season's points cannot explain."""
    y = ranks([r['next'] for r in rows])
    x = ranks([r['base'] for r in rows])
    n = len(x)
    mx, my = sum(x) / n, sum(y) / n
    den = sum((v - mx) ** 2 for v in x) or 1.0
    b = sum((x[i] - mx) * (y[i] - my) for i in range(n)) / den
    return [y[i] - (my + b * (x[i] - mx)) for i in range(n)]


def run(lo, hi):
    seasons = {}
    for yr in range(int(lo), int(hi) + 1):
        rows = collect('stats', str(yr))
        seasons[str(yr)] = index(rows)
        print(f'  {yr}: {len(seasons[str(yr)])} players')

    print('\n' + '=' * 74)
    print('DOES EACH COMPONENT HOLD UP ACROSS SEASONS?')
    print('=' * 74)
    print('Correlation with next season, measured separately in every year-pair. A')
    print('component whose numbers swing wildly is not a finding, it is one season.\n')

    labels = {ck: lbl for ck, lbl, _d, _s in SM.COMPONENTS}
    stability = {}
    for pos in POSITIONS:
        rows, subs = build(seasons, pos)
        if len(rows) < 60:
            continue
        stability[pos] = comp_by_pair(rows, subs, pos)

    for pos in POSITIONS:
        if pos not in stability:
            continue
        tab = stability[pos]
        pairs = sorted({p for v in tab.values() for p, _ in v})
        print(f'{pos}')
        print(f"    {'':<16}" + ''.join(f'{p:>8}' for p in pairs)
              + f"{'mean':>9}{'worst':>8}{'best':>7}")
        for ck, vals in sorted(tab.items(), key=lambda kv: -sum(r for _, r in kv[1]) / len(kv[1])):
            d = dict(vals)
            rs = [r for _, r in vals]
            line = f'    {labels.get(ck, ck):<16}'
            for p in pairs:
                line += f'{d[p]:>8.2f}' if p in d else f"{'-':>8}"
            mean = sum(rs) / len(rs)
            line += f'{mean:>9.2f}{min(rs):>8.2f}{max(rs):>7.2f}'
            if min(rs) > 0.45:
                line += '   solid'
            elif max(rs) < 0.15:
                line += '   dead weight'
            elif max(rs) - min(rs) > 0.35:
                line += '   unstable'
            print(line)
        print()

    print('=' * 74)
    print('WHAT PREDICTS BEATING YOUR BASELINE')
    print('=' * 74)
    print('Correlation with the part of next season that last season\'s points/game')
    print('could not explain. Positive means the stat spots players who outperform what')
    print('the obvious number says. Near zero means last year\'s points already told you.\n')

    keep = {}
    for pos in POSITIONS:
        rows, subs = build(seasons, pos)
        if len(rows) < 60:
            print(f'{pos}: only {len(rows)} player-seasons, skipping\n')
            continue
        res = residual(rows)

        scored = []
        for key, lbl, _fn, _hi, ck in subs:
            rho = spearman([(r['x'][key], res[i]) for i, r in enumerate(rows)])
            if not math.isnan(rho):
                scored.append((rho, key, lbl, ck))
        scored.sort(reverse=True)
        keep[pos] = (rows, res, scored)

        print(f'{pos}  ({len(rows)} player-seasons across {len(seasons) - 1} year-pairs)')
        for rho, _key, lbl, ck in scored[:6]:
            flag = '  <-- real signal' if abs(rho) >= 0.10 else ''
            print(f'    {lbl:<22} {rho:+.3f}   [{ck}]{flag}')
        print(f'    {"...":<22}')
        for rho, _key, lbl, ck in scored[-3:]:
            print(f'    {lbl:<22} {rho:+.3f}   [{ck}]')
        strong = sum(1 for rho, *_ in scored if abs(rho) >= 0.10)
        print(f'    {strong} of {len(scored)} stats clear +/-0.10.\n')

    print('=' * 74)
    print('CAN A FITTED BLEND BEAT THE BASELINE OUT OF SAMPLE?')
    print('=' * 74)
    print('Weights fitted on the early year-pairs, then judged on the most recent pair,')
    print('which the fit has never seen. If this cannot win, no hand-tuned weights will.\n')

    for pos in POSITIONS:
        if pos not in keep:
            continue
        rows, _res, scored = keep[pos]
        pairs = sorted({r['pair'] for r in rows})
        if len(pairs) < 2:
            print(f'{pos}: needs at least two year-pairs to hold one out.\n')
            continue
        hold = pairs[-1]
        tr = [r for r in rows if r['pair'] != hold]
        te = [r for r in rows if r['pair'] == hold]
        if len(tr) < 60 or len(te) < 20:
            print(f'{pos}: not enough rows to hold out {hold}.\n')
            continue

        # greedy forward selection, judged on the training pairs only
        chosen = []
        pool = [s[1] for s in scored]
        best_fit = None
        while len(chosen) < MAX_STATS:
            best = None
            for key in pool:
                if key in chosen:
                    continue
                cols = chosen + [key]
                X = [[1.0] + [r['x'][c] for c in cols] + [r['base']] for r in tr]
                beta = ols(X, ranks([r['next'] for r in tr]))
                if not beta:
                    continue
                pred = [sum(b * v for b, v in zip(beta, x)) for x in X]
                rho = spearman(list(zip(pred, [r['next'] for r in tr])))
                if best is None or rho > best[0]:
                    best = (rho, key, beta)
            if not best or (best_fit is not None and best[0] <= best_fit + 0.002):
                break
            best_fit = best[0]
            chosen.append(best[1])

        if not chosen:
            print(f'{pos}: nothing improved on the baseline even in-sample.\n')
            continue

        X = [[1.0] + [r['x'][c] for c in chosen] + [r['base']] for r in tr]
        beta = ols(X, ranks([r['next'] for r in tr]))
        Xte = [[1.0] + [r['x'][c] for c in chosen] + [r['base']] for r in te]
        pred = [sum(b * v for b, v in zip(beta, x)) for x in Xte]
        got = [r['next'] for r in te]

        fitted = spearman(list(zip(pred, got)))
        base = spearman([(r['base'], r['next']) for r in te])
        lift = fitted - base

        names = {s[1]: s[2] for s in scored}
        print(f'{pos}  held out {hold}, n={len(te)}')
        print(f'    picked: {", ".join(names[c] for c in chosen)}')
        print(f'    baseline alone      {base:.3f}')
        print(f'    baseline + these    {fitted:.3f}')
        verdict = ('a real edge' if lift >= 0.03 else
                   'noise, not an edge' if lift > -0.01 else 'actively worse')
        print(f'    lift                {lift:+.3f}   <- {verdict}\n')

    print('Read it this way: lift above +0.03 means those stats are worth building the')
    print('rating from. Anything less and the sliders are a way to express taste, which')
    print('is fine, but they should not be sold as a better forecast.')


if __name__ == '__main__':
    a = sys.argv[1] if len(sys.argv) > 1 else '2020'
    b = sys.argv[2] if len(sys.argv) > 2 else '2025'
    run(a, b)
