"""Is a man's availability a fact about him, or just what happened to him?

Everything else in this pipeline has asked how many points a player will score, and the
answer has come back the same four times: Sleeper's projection already knows, and nothing
we add improves it. But the projection is wrong in one specific, measured way. It is right
about how good a man is per game and wrong about his season, and the whole gap is games he
did not play. Sleeper's own payload says so out loud: every 2026 projection carries
`gp = 18.0`, for all 345 players, healthy or not, in a season where nobody can play more
than 17.

So the obvious correction is to stop pricing everyone at a full year:

    season points = points per game x expected games

That is only worth doing if expected games can be estimated at all, and it can only be
estimated if availability repeats. If who gets hurt is random from one year to the next,
last season's games played is noise and multiplying by it makes the board worse, not
better. That is the question this script exists to answer, and it is a question, not a
foregone conclusion - boom rate looked just as plausible and turned out not to repeat.

    python durability.py                # 2020-2025
    python durability.py 2021 2025

Three parts:

    1. DOES AVAILABILITY REPEAT?
       Rank correlation between games played in one season and games played in the next,
       per position, for every year-pair. This is the whole idea in one number. Under
       about 0.20 and there is nothing here; the honest thing is to say so and stop.

    2. DOES THE CORRECTION IMPROVE THE RANKING?
       Held out on real seasons. Rank the drafted pool by the preseason projection, then
       by projection-per-game x expected games, and see which orders next season's actual
       points better. Reported per position and per year-pair, because one season passing
       is not a finding.

    3. HOW HARD SHOULD IT LISTEN TO ONE SEASON?
       One year is a small sample, so the estimate is pulled toward the position average.
       `k` is how many games of "just use the average" get mixed in. k=0 trusts one
       season completely, k=6 barely listens to it. The sweep says which is right rather
       than someone picking a number that feels sensible.

Two house rules inherited from the rest of the pipeline, both of which matter here:

  - **The projection is week one's, multiplied up.** Sleeper's season endpoint may have
    been quietly updated after the fact; week one provably cannot have been, because it
    is published before a game is played. `annual.py` tests this directly.
  - **A player who vanishes scores zero, not nothing.** Dropping him would delete exactly
    the injuries this script is about and would flatter every result.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from backtest import index, spearman             # noqa: E402
from fetch import collect                        # noqa: E402
from volatility import week_rows                 # noqa: E402

POSITIONS = ['QB', 'RB', 'WR', 'TE']
MIN_PPG = {'QB': 8.0, 'RB': 5.0, 'WR': 5.0, 'TE': 4.0}   # below this nobody is drafting him
KS = [0, 1, 2, 4, 6]
MAX_GAMES = 17


def season_games(season):
    """{player_id: (pos, name, games played, total ppr points)} for one finished season."""
    out = {}
    for pid, r in index(collect('stats', season)).items():
        a = r['a']
        gp = a.get('gp')
        if gp is None:
            continue
        out[pid] = (r['pos'], r['name'], min(float(gp), MAX_GAMES),
                    float(a.get('pts_ppr') or 0))
    return out


def week_one(season):
    """{player_id: projected points per game}, provably made before anything happened."""
    out = {}
    for pid, r in index(week_rows('projections', season, 1)).items():
        v = float(r['a'].get('pts_ppr') or 0)
        if v > 0:
            out[pid] = v
    return out


def shrink(games, mean, k):
    """One season is a small sample. Mix in k games' worth of the position average."""
    if games is None:
        return mean
    return (games + mean * k) / (1.0 + k)


def rule(t):
    print('\n' + '=' * 74)
    print(t)
    print('=' * 74)


# ------------------------------------------------------------------ 1. does it repeat
def persistence(games, years):
    rule('1. DOES AVAILABILITY REPEAT?')
    print('  Rank correlation between games played in one season and the next, among men')
    print('  who were on the field enough in the first year to have an opinion about.')
    print('  If this is near zero, last season\'s games are noise and everything below is')
    print('  a way of making the board worse.\n')
    print(f"    {'pair':<10}" + ''.join(f'{p:>9}' for p in POSITIONS))
    means = {p: [] for p in POSITIONS}
    for a, b in zip(years, years[1:]):
        line = f'    {a}->{b:<5}'
        for pos in POSITIONS:
            pairs = [(ga, games[b][pid][2]) for pid, (p, _n, ga, _pt) in games[a].items()
                     if p == pos and ga >= 4 and pid in games[b]]
            if len(pairs) < 20:
                line += f"{'-':>9}"
                continue
            rho = spearman(pairs)
            line += f'{rho:>9.2f}'
            if not math.isnan(rho):
                means[pos].append(rho)
        print(line)
    line = f"    {'mean':<10}"
    for pos in POSITIONS:
        v = means[pos]
        line += f'{sum(v)/len(v):>9.2f}' if v else f"{'-':>9}"
    print(line + '   <- the row that matters')
    print('\n  A caveat that cannot be measured away: a man who plays 17 games two years')
    print('  running may be durable, or may simply be a starter, and a starter gets more')
    print('  chances to play than a backup. Some of any correlation here is job security')
    print('  rather than health. That does not make it useless - job security is worth')
    print('  drafting too - but it is not the same claim.')


# --------------------------------------------------------- 2 & 3. does it actually help
def lift(games, wk1, years):
    rule('2. DOES CORRECTING FOR EXPECTED GAMES IMPROVE THE RANKING?')
    print('  Rank correlation against next season\'s ACTUAL total points. "projection" is')
    print('  week one\'s number - inside a position that orders men identically however')
    print('  many games you multiply it by, so it is the honest baseline. "corrected"')
    print('  multiplies by expected games instead of a full season.\n')

    best = {}
    for pos in POSITIONS:
        print(f'  {pos}')
        print(f"      {'pair':<10}{'n':>5}{'projection':>12}"
              + ''.join(f'{f"k={k}":>8}' for k in KS))
        totals = {k: [] for k in KS}
        base_all = []
        for a, b in zip(years, years[1:]):
            if b not in wk1 or a not in games:
                continue
            mean_a = [g for _p, (p, _n, g, _pt) in [(i, v) for i, v in games[a].items()]
                      if p == pos]
            mean_a = sum(mean_a) / len(mean_a) if mean_a else 15.0
            rows = []
            for pid, ppg in wk1[b].items():
                prior = games[a].get(pid)
                if not prior or prior[0] != pos or ppg < MIN_PPG[pos]:
                    continue
                # he must have been on the field enough in year A for his games to mean
                # anything; a man who played twice is not evidence of anything
                gprior = prior[2] if prior[2] >= 4 else None
                actual = games[b][pid][3] if pid in games[b] else 0.0
                rows.append((ppg, gprior, actual))
            if len(rows) < 25:
                continue
            base = spearman([(ppg, act) for ppg, _g, act in rows])
            base_all.append(base)
            line = f'      {a}->{b:<5}{len(rows):>5}{base:>12.3f}'
            for k in KS:
                rho = spearman([(ppg * shrink(g, mean_a, k), act) for ppg, g, act in rows])
                totals[k].append(rho)
                line += f'{rho - base:>+8.3f}'
            print(line)
        if base_all:
            line = f"      {'mean':<10}{'':>5}{sum(base_all)/len(base_all):>12.3f}"
            for k in KS:
                v = totals[k]
                line += f'{(sum(v)/len(v)) - (sum(base_all)/len(base_all)):>+8.3f}' if v \
                    else f"{'-':>8}"
            print(line + '  <- lift over the projection')
            gains = {k: (sum(totals[k]) / len(totals[k])) - (sum(base_all) / len(base_all))
                     for k in KS if totals[k]}
            if gains:
                bk = max(gains, key=lambda k: gains[k])
                best[pos] = (bk, gains[bk])
        print()

    rule('3. THE VERDICT, IN ONE PLACE')
    print('  Best shrinkage and the lift it buys, per position:\n')
    for pos in POSITIONS:
        if pos not in best:
            print(f'    {pos}  not enough data')
            continue
        k, g = best[pos]
        print(f'    {pos}  k={k}   lift {g:+.3f}')
    print('\n  For scale, every stat in submetrics.py put together was worth +0.007 to')
    print('  +0.015, which is noise. A correction has to clear that by a distance before')
    print('  it is worth putting on a board two people have to read under time pressure.')
    print('  Anything under about +0.02 should be treated as nothing found, and the')
    print('  correct response to nothing found is to show expected games as a fact on the')
    print('  card and leave the score alone.')


def run(lo, hi):
    years = list(range(int(lo), int(hi) + 1))
    print(f'seasons {years[0]}-{years[-1]}')
    games, wk1 = {}, {}
    for y in years:
        print(f'\nfetching {y}')
        games[y] = season_games(y)
        print(f'  {len(games[y])} players with a games-played count')
        wk1[y] = week_one(y)
        print(f'  {len(wk1[y])} players with a week-one projection')
    have = [y for y in years if len(games.get(y, {})) >= 100]
    if len(have) < 2:
        print('\nNot enough seasons came back to compare anything. Nothing measured.')
        return 1
    persistence(games, have)
    lift(games, wk1, have)
    print()
    return 0


def main():
    lo = sys.argv[1] if len(sys.argv) > 1 else '2020'
    hi = sys.argv[2] if len(sys.argv) > 2 else '2025'
    return run(lo, hi)


if __name__ == '__main__':
    sys.exit(main())
