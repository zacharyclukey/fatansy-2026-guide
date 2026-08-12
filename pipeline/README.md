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

## Known limits

- **One projection source.** Everything comes from Sleeper. There is no consensus blend.
- **Rookie draft capital is hand-collected** in `rookies.py`. Six late picks are still
  marked unconfirmed and are scored conservatively because of it.
- **`fetch.py` has never run against the live API from this machine** — the sandbox it was
  written in cannot reach Sleeper. It is written defensively and gated by `check_data.py`,
  but the first real run is the first real test.
