"""2026 NFL draft capital for draftable rookies.

Draft capital is the single strongest public predictor of rookie fantasy production:
NFL teams give snaps to the players they spent premium picks on, and opportunity drives
fantasy points far more than talent does.

Sources:
  https://www.profootballrumors.com/2026/04/2026-nfl-draft-results-by-round  (picks 1-16)
  https://www.philadelphiaeagles.com/news/eagles-makai-lemon-2026-nfl-draft  (pick 20)
  Web search, ESPN/Yahoo 2026 draft trackers (picks 24, 32, and round-2 confirmations)

Where a pick is unconfirmed the player is marked capital_confirmed=False and treated as
a Day 3 selection. Their ADPs (145-176) are consistent with late picks.
"""

# player name -> (overall pick, confirmed?)
DRAFT_CAPITAL = {
    'Fernando Mendoza': (1, True),
    'Jeremiyah Love': (3, True),
    'Carnell Tate': (4, True),
    'Jordyn Tyson': (8, True),
    'Ty Simpson': (13, True),
    'Kenyon Sadiq': (16, True),
    'Makai Lemon': (20, True),
    'KC Concepcion': (24, True),
    'Jadarian Price': (32, True),
    'Denzel Boston': (45, False),      # confirmed Round 2, exact pick unknown
    'Omar Cooper': (110, False),
    'Nicholas Singleton': (110, False),
    'Emmett Johnson': (110, False),
    'Jonah Coleman': (110, False),
    'Eli Stowers': (110, False),
    "De'Zhaun Stribling": (110, False),
}


def capital_score(pick):
    """Convert an overall draft pick into a 0-100 opportunity expectation.
    Steps mirror how NFL usage actually breaks: top-10 picks play immediately,
    round 1 gets every chance, day 2 gets a real look, day 3 must earn it."""
    if pick is None:
        return 25.0
    if pick <= 10:
        return 100.0
    if pick <= 32:
        return 85.0
    if pick <= 64:
        return 65.0
    if pick <= 100:
        return 45.0
    return 25.0


def confidence(name):
    pick, conf = DRAFT_CAPITAL.get(name, (None, False))
    if pick is None:
        return 'LOW - no draft data'
    if not conf:
        return 'LOW - pick unconfirmed'
    return 'HIGH - round 1' if pick <= 32 else 'MEDIUM'
