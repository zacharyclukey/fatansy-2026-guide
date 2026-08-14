# The data pipeline

Everything in `data/players.json` is built here. Before this existed the scripts lived on
one machine and nobody but the author could refresh the data — which is a bad property for
something you rely on at a fixed date in August.

## Rebuild it yourself

```
cd pipeline
python fetch.py        # pull projections, ADP, injuries and last season's stats
python engine.py       # ratings, tiers, replacement level, rookie model -> board.json
python export_json.py  # slim it down to ../data/players.json
cd .. && python pipeline/check_data.py
```

No dependencies beyond the Python standard library.

## What each file does

| File | Role |
|---|---|
| `fetch.py` | The only part that touches the network. Writes the two raw Sleeper files. |
| `reference.py` | Bye weeks, playoff opponents, defence projections, league configs. |
| `rookies.py` | 2026 NFL draft capital and the confidence attached to each pick. |
| `submetrics.py` | The 50 stats, their formulas, and their weight at each position. |
| `engine.py` | Scoring, replacement level, value over replacement, tiers. |
| `engine2.py` | Percentiles within position, rookie substitution, no-history fallback. |
| `export_json.py` | Trims 2.1 MB of working data down to the ~365 KB the app loads. |
| `check_data.py` | The gate. Refuses a bad rebuild rather than shipping it. |
| `durability.py` | Does availability repeat, and does correcting for it help? Not part of the build. |
| `check_durability.py` | Proves `durability.py` finds a planted effect and not a fake one. |
| `games_effect.py` | Offline: what an expected-games correction would do to the board. |

## Nightly refresh

`.github/workflows/refresh-data.yml` runs the four commands above each morning and commits
`data/players.json` only if `check_data.py` passes. Failures leave the previous file in
place — stale data beats broken data on draft night.

Checks that must pass before a commit:

- at least 200 players, and sane counts at every position
- the top 50 by ADP all actually have an ADP
- rating components and league configs present
- fewer than a quarter of players missing their stat percentiles
- the pool has not shrunk by more than 10% versus the committed file
- fewer than 30% of players moved more than 40 ADP spots overnight

## Does the rating actually work?

```
python backtest.py 2024 2025
```

Or run **Actions → Backtest the ratings** on GitHub, which needs no local setup.

It builds the rating from one season using the shipped `submetrics.py` definitions, then
measures how well it predicts the next season's points per game — against three naive
baselines. The one that matters is *last year's points per game*: if the fifty-stat blend
cannot beat that, it is re-describing last season rather than forecasting the next.

Two things it deliberately does:

- **Keeps players who vanished.** No row next season means zero fantasy production, which
  is a zero, not missing data. Dropping them would delete every bust and flatter the model.
- **Excludes the projection component**, because no projection exists for a past season.
  Worth remembering that this is the component with by far the largest influence in the
  app, so the backtest is testing the *stats* half of the rating, not all of it.

It cannot compare against ADP — Sleeper does not publish historical ADP, so the most
interesting comparison, "does this beat the market", is not available.

## Does availability repeat?

```
python check_durability.py     # prove the script can tell signal from noise
python durability.py 2020 2025 # then run it on real seasons
```

Or **Actions → Does availability repeat?**, which needs no local setup and, unlike a
sandbox, can actually reach Sleeper.

The projection is right about a player per game and wrong about his season, and the whole
gap is games he did not play — Sleeper's own payload says as much, stamping `gp = 18.0` on
all 345 players in a season where nobody can play more than 17. The obvious fix is to price
a man at points per game × expected games. That only works if availability is a fact about
the player rather than something that happened to him, and **that has never been tested**.
This tests it. Read part 1 first; under about 0.20 there is nothing there, and the correct
response is to show expected games as a fact and leave the score alone.

`check_durability.py` is not optional. It runs the same script against a world with a
durability effect planted in it and a world where games played is pure noise, and fails if
the answers are not respectively "found it" and "found nothing". A correction built on noise
costs 0.13 to 0.19 of rank correlation, which is far more than this app has ever gained from
anything.

## Known limits

- **One projection source.** Everything comes from Sleeper. There is no consensus blend.
- **Rookie draft capital is hand-collected** in `rookies.py`. Six late picks are still
  marked unconfirmed and are scored conservatively because of it.
- **`fetch.py` has never run against the live API from this machine** — the sandbox it was
  written in cannot reach Sleeper. It is written defensively and gated by `check_data.py`,
  but the first real run is the first real test.
