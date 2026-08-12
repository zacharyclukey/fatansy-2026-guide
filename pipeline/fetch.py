"""Pull the raw Sleeper data the rest of the pipeline reads.

This step used to be done by hand, which is why the data went stale and why nobody but me
could refresh it. It is now the first thing the nightly rebuild runs.

Two files come out:
    sleeper_proj_raw.json    2026 projections, ADP and injury status
    sleeper_stats2025_raw.json   what actually happened in 2025

Sleeper caps a single response, so each position is requested separately and the results
are merged by player id. Ordering by ADP and again by projected points widens the net -
a player outside the top 60 by ADP may still be inside the top 60 by projection.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SEASON = os.environ.get('SEASON', '2026')
LAST = str(int(SEASON) - 1)
POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']
ORDERS = ['adp_ppr', 'pts_ppr']
UA = 'draft-guide/1.0 (+github actions; personal fantasy tool)'


def get(url, tries=4):
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=45) as r:
                return json.loads(r.read().decode())
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
            if attempt == tries - 1:
                print(f'  FAILED {url}\n    {e}', file=sys.stderr)
                return None
            time.sleep(2 ** attempt)
    return None


def collect(kind, season):
    """Everything Sleeper will give us for one season, keyed by player id."""
    out = {}
    for pos in POSITIONS:
        for order in ORDERS:
            url = (f'https://api.sleeper.com/{kind}/nfl/{season}'
                   f'?season_type=regular&position[]={pos}&order_by={order}')
            rows = get(url)
            if not rows:
                continue
            for row in rows:
                pid = str(row.get('player_id') or '')
                if pid:
                    out.setdefault(pid, row)
            print(f'  {kind} {season} {pos:<3} by {order:<8} -> {len(rows):>3} rows, '
                  f'{len(out):>4} unique so far')
            time.sleep(0.4)          # be polite to a free API
    return list(out.values())


def main():
    print(f'projections and ADP for {SEASON}')
    proj = collect('projections', SEASON)
    print(f'\nactual results for {LAST}')
    acts = collect('stats', LAST)

    if len(proj) < 200 or len(acts) < 150:
        print(f'\nRefusing to write: only {len(proj)} projections and {len(acts)} stat lines. '
              'That is far below normal and suggests Sleeper returned something unexpected.',
              file=sys.stderr)
        return 1

    for name, rows in (('sleeper_proj_raw.json', proj), ('sleeper_stats2025_raw.json', acts)):
        with open(os.path.join(HERE, name), 'w') as f:
            json.dump(rows, f)
        print(f'wrote {name}  {len(rows)} rows')

    injured = sum(1 for r in proj if (r.get('player') or {}).get('injury_status'))
    print(f'\n{injured} players carry an injury status')
    return 0


if __name__ == '__main__':
    sys.exit(main())
