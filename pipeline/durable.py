"""How many games does a draftable player actually give you, and does it differ by position?

The app's durability dial has an anchor called "the average at their position". Built from
2025 alone that came out RB 15.5, WR 14.3 - which, applied to the board, docks receivers
harder than backs and pushes backs up the rankings. That is a real consequence resting on
one season, and it says the opposite of what most people believe about running backs. So:
does it hold up over six years, or was it noise?

    python durable.py                # 2019-2025
    python durable.py 2017 2025

THE TRAP, and why this script is not two lines long
    The obvious approach is "take the top 36 at each position and average their games".
    That is circular. Ranking by points selects for men who PLAYED, because playing is how
    you score points - so the top 36 will always look durable, at every position, and the
    number tells you nothing.

    Instead, draftability is decided by the PREVIOUS season and availability is measured in
    the NEXT one. Top 36 by 2023 finish, then count their 2024 games. That is exactly the
    question a drafter faces in August: of the men I would have taken, how much of a season
    did I get? A player who vanishes entirely counts as zero, because that is what he was
    worth to whoever drafted him.

WHAT TO DO WITH THE ANSWER
    If the positional gap is consistent in sign across most year-pairs, the positional
    anchor is real and the app should keep it. If it flips around, the anchor is fitting
    noise and should either be dropped or pinned to the league average.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from backtest import index                      # noqa: E402
from fetch import collect                       # noqa: E402

POSITIONS = ['QB', 'RB', 'WR', 'TE']
FULL = 17
DEPTH = 36          # matches DRAFTABLE in engine.js


def draftable(season, pos, depth=DEPTH):
    """The men you would have drafted, ranked by how they finished THAT season."""
    out = []
    for pid, r in season.items():
        if r['pos'] != pos:
            continue
        rank = r['a'].get('pos_rank_ppr')
        if rank is None:
            continue
        out.append((float(rank), pid))
    out.sort()
    return [pid for _r, pid in out[:depth]]


def games(season, pid):
    """Games played, with an absent man counting as zero - he gave his owner nothing."""
    r = season.get(pid)
    if not r:
        return 0.0
    return max(0.0, min(float(FULL), float(r['a'].get('gp') or 0)))


def run(lo, hi):
    years = [str(y) for y in range(int(lo), int(hi) + 1)]
    seasons = {}
    for y in years:
        seasons[y] = index(collect('stats', y))
        print(f'  {y}: {len(seasons[y])} players')

    print('\n' + '=' * 74)
    print('GAMES PLAYED BY MEN YOU WOULD ACTUALLY HAVE DRAFTED')
    print('=' * 74)
    print('Chosen on the previous season\'s finish, counted in the following season, so')
    print('nothing is selected for having stayed healthy. Out of 17.\n')

    pairs = list(zip(years, years[1:]))
    table = {p: {} for p in POSITIONS}
    league = {}
    for a, b in pairs:
        allg = []
        for pos in POSITIONS:
            ids = draftable(seasons[a], pos)
            if len(ids) < 20:
                continue
            g = [games(seasons[b], pid) for pid in ids]
            table[pos][b] = sum(g) / len(g)
            allg += g
        if allg:
            league[b] = sum(allg) / len(allg)

    cols = [b for _a, b in pairs if b in league]
    print(f"{'':<10}" + ''.join(f'{c:>8}' for c in cols) + f"{'mean':>9}{'spread':>9}")
    for pos in POSITIONS:
        vals = [table[pos][c] for c in cols if c in table[pos]]
        if not vals:
            continue
        line = f'{pos:<10}'
        for c in cols:
            line += f'{table[pos][c]:>8.1f}' if c in table[pos] else f"{'-':>8}"
        line += f'{sum(vals) / len(vals):>9.1f}{max(vals) - min(vals):>9.1f}'
        print(line)
    line = f"{'LEAGUE':<10}"
    for c in cols:
        line += f'{league[c]:>8.1f}'
    lv = list(league.values())
    line += f'{sum(lv) / len(lv):>9.1f}{max(lv) - min(lv):>9.1f}'
    print(line)

    print('\n' + '=' * 74)
    print('IS THE POSITIONAL GAP REAL, OR WAS 2025 A ONE-OFF?')
    print('=' * 74)
    print('The app currently lets you anchor on position. That is only defensible if the')
    print('same position comes out ahead year after year.\n')

    for x, y in [('RB', 'WR'), ('RB', 'TE'), ('WR', 'TE'), ('QB', 'RB')]:
        shared = [c for c in cols if c in table[x] and c in table[y]]
        if len(shared) < 3:
            continue
        diffs = [table[x][c] - table[y][c] for c in shared]
        wins = sum(1 for d in diffs if d > 0)
        mean = sum(diffs) / len(diffs)
        sd = math.sqrt(sum((d - mean) ** 2 for d in diffs) / len(diffs)) if len(diffs) > 1 else 0
        # A gap that flips sign is not a fact about the position, it is a fact about a year.
        verdict = ('consistent' if wins in (0, len(diffs)) and abs(mean) > 0.4
                   else 'leans that way' if (wins >= len(diffs) - 1 or wins <= 1) and abs(mean) > 0.3
                   else 'FLIPS - not a real positional effect')
        print(f'  {x} minus {y}:  mean {mean:+.2f} games, spread {sd:.2f}, '
              f'{x} ahead in {wins} of {len(diffs)} years   -> {verdict}')
        print(f'      {"  ".join(f"{c}:{d:+.1f}" for c, d in zip(shared, diffs))}')

    print('\nRead it this way. If every comparison says FLIPS, the positional anchor in the')
    print('app is fitting one season of noise and should be pinned to the league average')
    print('instead. If a gap is consistent across six years, it is real and worth keeping -')
    print('even if it is the opposite of what everybody assumes about running backs.')


if __name__ == '__main__':
    a = sys.argv[1] if len(sys.argv) > 1 else '2019'
    b = sys.argv[2] if len(sys.argv) > 2 else '2025'
    run(a, b)
