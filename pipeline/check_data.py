"""The gate between a rebuild and a commit.

An automated refresh that quietly writes a broken file is worse than one that never runs -
you would find out on draft night. So nothing gets committed unless the new data/players.json
looks like a real, complete season's worth of players AND is not wildly different from the
file it would replace.

Exit 0 = safe to commit. Exit 1 = keep the old file.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
NEW = os.path.join(HERE, '..', 'data', 'players.json')

MIN_PLAYERS = 200
MIN_BY_POS = {'QB': 20, 'RB': 35, 'WR': 40, 'TE': 20}
MAX_SHRINK = 0.10          # a 10% drop in the player pool is a red flag, not a news day


def fail(msg):
    print(f'  REJECT  {msg}')
    return False


def main():
    if not os.path.exists(NEW):
        print('REJECT  no players.json was produced')
        return 1
    with open(NEW) as f:
        d = json.load(f)

    okay = True
    players = d.get('players') or []
    print(f'checking {len(players)} players, generated {d.get("generated")}')

    if len(players) < MIN_PLAYERS:
        okay = fail(f'only {len(players)} players, expected at least {MIN_PLAYERS}')

    by_pos = {}
    for p in players:
        by_pos[p['pos']] = by_pos.get(p['pos'], 0) + 1
    for pos, least in MIN_BY_POS.items():
        if by_pos.get(pos, 0) < least:
            okay = fail(f'{by_pos.get(pos, 0)} {pos}s, expected at least {least}')

    # ADP drives the whole draft-clock feature. If the top of the board has no ADP the
    # app still renders, which is exactly why this has to be checked rather than eyeballed.
    top = sorted([p for p in players if p.get('adp')], key=lambda p: p['adp'])[:50]
    if len(top) < 50:
        okay = fail(f'only {len(top)} players have an ADP')

    if not d.get('components'):
        okay = fail('no rating components in the file')
    if not d.get('leagues'):
        okay = fail('no league configs in the file')

    # every player needs the percentiles the rating is built from
    thin = [p['name'] for p in players if len(p.get('sub') or {}) < 10]
    if len(thin) > len(players) * 0.25:
        okay = fail(f'{len(thin)} players have almost no stat percentiles')

    # and compare against what is already committed
    import subprocess
    try:
        old = subprocess.check_output(['git', 'show', 'HEAD:data/players.json'],
                                      cwd=os.path.join(HERE, '..'), stderr=subprocess.DEVNULL)
        prev = json.loads(old)
        was = len(prev.get('players') or [])
        if was and len(players) < was * (1 - MAX_SHRINK):
            okay = fail(f'player pool shrank from {was} to {len(players)}')
        else:
            print(f'  pool {was} -> {len(players)}')
        # ADP moving is the point; ADP moving for EVERYONE means something broke
        old_adp = {p['id']: p.get('adp') for p in prev.get('players') or []}
        moved = [p for p in players
                 if old_adp.get(p['id']) and p.get('adp')
                 and abs(p['adp'] - old_adp[p['id']]) > 40]
        if len(moved) > len(players) * 0.30:
            okay = fail(f'{len(moved)} players moved more than 40 ADP spots overnight')
        else:
            print(f'  {len(moved)} players moved more than 40 ADP spots')
    except (subprocess.CalledProcessError, json.JSONDecodeError):
        print('  no previous file to compare against (first run)')

    inj = sum(1 for p in players if p.get('inj'))
    print(f'  {inj} players carry an injury flag')
    print('OK - safe to commit' if okay else 'REJECTED - keeping the previous data')
    return 0 if okay else 1


if __name__ == '__main__':
    sys.exit(main())
