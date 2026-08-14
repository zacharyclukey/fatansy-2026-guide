"""Prove durability.py can find a durability effect, and does not invent one.

No script in this pipeline gets believed until it has been run against data with a known
answer. A measurement script that always says "nothing found" would look identical to an
honest one right up until the day it mattered, and a measurement script that finds
structure in noise is worse than no script at all.

So two synthetic worlds, identical in every respect except one:

  PLANTED   every player has a fixed durability that carries from season to season. The
            projection is exactly right about him per game and knows nothing at all about
            whether he will be on the field. Expected games is therefore real information,
            and durability.py MUST find both a high persistence and a large lift.

  CONTROL   the same players, the same talent, the same projections - but games played is
            rerolled independently every season, so last year's tells you nothing.
            Persistence must come out near zero, and the correction must buy nothing.

The control is the half that catches the dangerous failure. Multiplying a good projection
by a noisy number can only make it worse, so a script that reports a gain here is finding
a pattern that is not in the data.

    python check_durability.py           # prints both worlds and a pass/fail line
"""
import io
import os
import random
import sys
from contextlib import redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import durability as D                            # noqa: E402

N = 220
POS = ['QB', 'RB', 'WR', 'TE']
SEASONS = (2020, 2025)

random.seed(11)
TALENT = {}
DURABLE = {}
for i in range(N):
    pid = str(5000 + i)
    TALENT[pid] = 4 + random.random() * 16         # his true points per game
    DURABLE[pid] = random.random()                 # 0 made of glass, 1 never misses a snap

MODE = 'planted'


def games_for(pid, season):
    """Deterministic per (player, season) so the two fetches of a season agree."""
    random.seed(hash((pid, season, MODE)) % 999983)
    if MODE == 'planted':
        return max(1, min(17, round(random.gauss(6 + DURABLE[pid] * 11, 1.6))))
    return max(1, min(17, round(random.gauss(12, 3.6))))


def fake_collect(kind, season):
    rows = []
    for i in range(N):
        pid = str(5000 + i)
        g = games_for(pid, season)
        rows.append({'player_id': pid, 'stats': {'gp': g, 'pts_ppr': TALENT[pid] * g},
                     'player': {'position': POS[i % 4], 'first_name': 'P',
                                'last_name': str(i)}})
    return rows


def fake_week_rows(kind, season, week):
    if week != 1:
        return []
    return [{'player_id': str(5000 + i), 'stats': {'pts_ppr': TALENT[str(5000 + i)]},
             'player': {'position': POS[i % 4], 'first_name': 'P', 'last_name': str(i)}}
            for i in range(N)]


def numbers(text):
    """Pull the two summary rows out of durability.py's own output."""
    persist, lifts = None, {}
    for line in text.splitlines():
        s = line.strip()
        if s.startswith('mean') and 'the row that matters' in line:
            persist = [float(x) for x in s.split()[1:5]]
        if s.startswith(('QB  k=', 'RB  k=', 'WR  k=', 'TE  k=')):
            pos, _k, lift = s.split()[0], s.split()[1], s.split()[-1]
            lifts[pos] = float(lift)
    return persist, lifts


def world(mode):
    global MODE
    MODE = mode
    buf = io.StringIO()
    with redirect_stdout(buf):
        D.run(*SEASONS)
    return buf.getvalue()


def main():
    D.collect = fake_collect
    D.week_rows = fake_week_rows

    ok = True
    out = {}
    for mode in ('planted', 'control'):
        text = world(mode)
        out[mode] = text
        print('\n' + '#' * 74)
        print(f'# {mode.upper()} WORLD')
        print('#' * 74)
        print('\n'.join(ln for ln in text.splitlines()
                        if not ln.startswith(('fetching', '  ', 'seasons')) or '0.' in ln
                        or '-' in ln))

    pp, pl = numbers(out['planted'])
    cp, cl = numbers(out['control'])

    print('\n' + '=' * 74)
    print('DID THE SCRIPT BEHAVE?')
    print('=' * 74)

    def check(label, got, want):
        nonlocal ok
        if not want:
            ok = False
        print(f'  [{"ok  " if want else "FAIL"}] {label}: {got}')

    check('planted world, availability repeats (want every position > 0.50)',
          pp, pp is not None and min(pp) > 0.50)
    check('control world, availability does not repeat (want every position < 0.20)',
          cp, cp is not None and max(abs(x) for x in cp) < 0.20)
    check('planted world, the correction helps (want every position > +0.05)',
          pl, len(pl) == 4 and min(pl.values()) > 0.05)
    check('control world, the correction buys nothing (want every position < +0.05)',
          cl, len(cl) == 4 and max(cl.values()) < 0.05)

    print('\n  ' + ('durability.py finds what is there and nothing that is not.' if ok
                    else 'durability.py is NOT trustworthy - do not act on its output.'))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
