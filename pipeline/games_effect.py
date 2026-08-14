"""What the 2026 projection assumes about availability, and what correcting it would cost.

This is the offline half of the durability question. `durability.py` asks whether an
expected-games correction is *right*, which needs several seasons and a network. This asks
how *big* it is on the board Zach is actually going to draft off, which needs nothing but
the two files already committed here:

    pipeline/sleeper_proj_raw.json    2026 projections and ADP
    data/players.json                 the file the app loads

Both questions matter and they are separate. A correction that is right and moves nothing
is a display change. A correction that moves a lot and has not been shown to be right is
the most dangerous thing you can put on a board a fortnight before a draft.

    python games_effect.py            # run from pipeline/, or pass the repo root
"""
import json
import os
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(HERE)
POS = ['QB', 'RB', 'WR', 'TE']
FLEXABLE = {'RB', 'WR', 'TE'}


def rule(t):
    print('\n' + '=' * 74)
    print(t)
    print('=' * 74)


def load():
    proj = json.load(open(os.path.join(REPO, 'pipeline', 'sleeper_proj_raw.json')))
    app = json.load(open(os.path.join(REPO, 'data', 'players.json')))
    return proj, app


# ------------------------------------------------------------------ 1. the gp field
def gp_field(proj):
    rule('1. WHAT GAME COUNT DOES THE 2026 PROJECTION CARRY?')
    vals = {}
    for r in proj:
        g = (r.get('stats') or {}).get('gp')
        vals[g] = vals.get(g, 0) + 1
    print(f'  rows: {len(proj)}')
    for g, n in sorted(vals.items(), key=lambda kv: -kv[1]):
        print(f'  gp = {g}: {n} players')
    print('\n  The regular season is 18 weeks and every team has a bye, so the most games')
    print('  anybody can play is 17. Whatever else this means, it means Sleeper applies no')
    print('  per-player availability discount at all: the man who played four games last')
    print('  year and the man who played seventeen are priced over the same season.')


# ------------------------------------------------------ 2. is the rate multiplied by 18?
def implied_games(proj, app):
    rule('2. IS THE SEASON PROJECTION A PER-GAME RATE MULTIPLIED BY 18?')
    print('  Each projected counting stat divided by the same man\'s own 2025 per-game')
    print('  rate. If Sleeper builds a season by multiplying a rate by N, the median lands')
    print('  on N.\n')
    by_id = {p['id']: p for p in app['players']}
    for stat, positions in [('rush_att', ['RB']), ('rush_yd', ['RB']),
                            ('rec', ['WR', 'TE']), ('rec_yd', ['WR', 'TE'])]:
        ratios = []
        for r in proj:
            p = by_id.get(str(r.get('player_id') or ''))
            if not p or p['pos'] not in positions:
                continue
            a = p.get('a') or {}
            g, got = a.get('gp') or 0, a.get(stat) or 0
            want = (r.get('stats') or {}).get(stat) or 0
            if g >= 12 and got >= 40 and want >= 40:
                ratios.append(want / (got / g))
        if len(ratios) >= 15:
            print(f'  {stat:<9} {"/".join(positions):<6} n={len(ratios):>3}   '
                  f'median {statistics.median(ratios):>5.2f}   '
                  f'mean {statistics.mean(ratios):>5.2f}')
    print('\n  INCONCLUSIVE, and worth saying so. A projection regresses everyone toward')
    print('  the middle, so the heavy-workload men who pass this filter are projected at')
    print('  less than last year\'s rate. 18 games at 85% of last year and 15.3 games at')
    print('  full rate produce the same number here and this test cannot separate them.')
    print('  So: the gp field says 18, but whether the points behind it are a full')
    print('  season\'s worth is NOT established. It only affects the number displayed,')
    print('  never the order - see part 4a.')


# ------------------------------------------------------------- 3. who actually played
def availability(app):
    rule('3. HOW MANY GAMES DID THE DRAFTABLE POOL PLAY IN 2025?')
    print('  Men with an ADP inside the first 200 picks who have a 2025 season at all.\n')
    out = {}
    for pos in POS:
        g = [p['m']['games_2025'] for p in app['players']
             if p['pos'] == pos and p['m'].get('has2025')
             and p['m'].get('games_2025') is not None and (p.get('adp') or 999) <= 200]
        if not g:
            continue
        out[pos] = g
        print(f'  {pos}  n={len(g):>3}   mean {statistics.mean(g):>5.2f}   '
              f'median {statistics.median(g):>4.1f}   '
              f'played 17: {100*sum(1 for x in g if x >= 17)/len(g):>3.0f}%   '
              f'under 14: {100*sum(1 for x in g if x < 14)/len(g):>3.0f}%')
    allg = [x for v in out.values() for x in v]
    print(f'\n  whole pool  n={len(allg)}  mean {statistics.mean(allg):.2f} of 17')
    print('  If anything this OVERSTATES availability: Sleeper\'s stats feed is capped per')
    print('  position, so it is biased toward men who scored a lot, and scoring a lot')
    print('  requires being on the field.')
    return out


# ----------------------------------------------------------- 4. what it would move
def shrink(g, mean, k):
    return mean if g is None else (g + mean * k) / (1.0 + k)


def replacement(rows, league):
    """Fill every dedicated slot, let the best leftovers take the flex spots, then read
    off who the last man standing is. Same derivation engine.js uses."""
    teams = league.get('teams') or 12
    starters = league.get('starters') or {}
    taken = {p: teams * (starters.get(p) or 0) for p in POS}
    pool = [(p, sorted([r for r in rows if r['pos'] == p], key=lambda r: -r['pts']))
            for p in POS]
    left = []
    for p, s in pool:
        if p in FLEXABLE:
            left += [(r, p) for r in s[taken[p]:]]
    left.sort(key=lambda t: -t[0]['pts'])
    for _r, p in left[:teams * (starters.get('FLEX') or 0)]:
        taken[p] += 1
    return {p: (s[min(max(taken[p], 1), len(s)) - 1]['pts'] if s else 0) for p, s in pool}


def board(rows, league, key):
    rep = replacement([{'pos': r['pos'], 'pts': r[key]} for r in rows], league)
    for r in rows:
        r['vor'] = r[key] - rep[r['pos']]
    return sorted(rows, key=lambda r: -r['vor']), rep


def effect(app, pool):
    league = app['leagues'][0]
    rows = []
    for p in app['players']:
        if p['pos'] not in POS:
            continue
        pts = (p.get('proj') or {}).get('pts_ppr') or 0
        if pts > 0:
            rows.append({'name': p['name'], 'pos': p['pos'], 'adp': p.get('adp') or 999,
                         'pts': pts,
                         'g': p['m'].get('games_2025') if p['m'].get('has2025') else None})
    means = {}
    for pos in POS:
        v = [r['g'] for r in rows if r['pos'] == pos and r['g'] is not None]
        means[pos] = statistics.mean(v) if v else 15.0

    rule('4. IF THE BOARD PRICED EXPECTED GAMES, WHAT WOULD MOVE?')
    print(f'  league: {league.get("name")}, {league.get("teams")} teams\n')
    print('  a) THE FLAT PART - everybody loses the same fraction.')
    flat = statistics.mean([r['pts'] * (1 / 18) for r in rows])
    print(f'     Dropping from 18 games to 17 costs the average player {flat:.1f} points.')
    print('     It is the same multiplier for every man at every position, so it changes')
    print('     NO rankings - not the order, not value over replacement, nothing. It only')
    print('     changes the number on screen. Which is exactly why it is safe, and also')
    print('     exactly why it is not worth arguing about.')

    print('\n  b) THE DIFFERENTIAL PART - this is the whole risk and the whole reward.')
    print('     k mixes in that many games of "just use the position average", because one')
    print('     season is a small sample. Nothing offline can say which k is right.\n')
    base, rep0 = board([dict(r) for r in rows], league, 'pts')
    order0 = [r['name'] for r in base]
    rank0 = {n: i for i, n in enumerate(order0)}
    pos_of = {r['name']: r['pos'] for r in rows}
    print('     replacement level, uncorrected: '
          + '  '.join(f'{p} {v:.0f}' for p, v in rep0.items()))
    for k in (0, 1, 2, 4, 6):
        nb, _rep = board([dict(r, adj=(r['pts'] / 18.0) * shrink(r['g'], means[r['pos']], k))
                          for r in rows], league, 'adj')
        nr = {r['name']: i for i, r in enumerate(nb)}
        moves = [abs(rank0[n] - nr[n]) for n in rank0]
        top50 = len(set(order0[:50]) ^ {r['name'] for r in nb[:50]}) // 2
        q0 = sum(1 for n in order0[:50] if pos_of[n] == 'QB')
        q1 = sum(1 for r in nb[:50] if r['pos'] == 'QB')
        print(f'     k={k}  mean move {statistics.mean(moves):>5.1f} places  '
              f'max {max(moves):>3}  top-50 changes {top50:>2}  '
              f'QBs in the top 50: {q0} -> {q1}')

    print('\n     The quarterback column is the thing to look at. 2025 was a bad year for')
    print('     quarterback health - Burrow 8 games, Daniels 7, Purdy 9, Mahomes 14 - so a')
    print('     correction taken from one season collapses the quarterback replacement')
    print('     level and promotes whichever quarterbacks happened to stay fit. That is a')
    print('     large, confident change to the board built on one season of luck.')

    rule('5. AT k=2, WHO MOVES IN THE TOP 80?')
    nb, rep = board([dict(r, adj=(r['pts'] / 18.0) * shrink(r['g'], means[r['pos']], 2))
                     for r in rows], league, 'adj')
    nr = {r['name']: i for i, r in enumerate(nb)}
    print('  replacement level, corrected:   '
          + '  '.join(f'{p} {v:.0f}' for p, v in rep.items()))
    moved = sorted([(rank0[n] - nr[n], n) for n in rank0 if rank0[n] < 80])
    for label, items in (('falls furthest', moved[:8]), ('rises furthest', moved[-8:][::-1])):
        print(f'\n  {label}:')
        for d, n in items:
            r = next(x for x in rows if x['name'] == n)
            print(f'    {n:<24} {r["pos"]}  board {rank0[n]+1:>3} -> {nr[n]+1:>3}  '
                  f'({d:+d})  2025 games {r["g"] if r["g"] is not None else "-"}')
    print()


def main():
    proj, app = load()
    gp_field(proj)
    implied_games(proj, app)
    pool = availability(app)
    effect(app, pool)
    return 0


if __name__ == '__main__':
    sys.exit(main())
