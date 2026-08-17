# 2026 Draft Guide — project spec

Living document. Read this before changing anything. Updated 2026-08-11.

---

## 1. Hard requirement: it must work for ANY Sleeper user

Right now the workbook is wired to one account. Before it can be handed to Amanda — or
anyone — every one of these has to come from a **Setup tab**, not from code:

| What | Where it's hardcoded today | Needs to become |
|---|---|---|
| Sleeper user id `728378880469135360` | `SleeperSync.gs` → `USER_ID` | Derived from a username typed on Setup |
| Three draft ids | `SleeperSync.gs` → `DRAFT_IDS` | Fetched from the user's leagues |
| League names, team counts, rounds, roster slots, scoring | `reference.py` → `LEAGUES` | Fetched per user |
| Position value defaults (0.26 / 1.00 / 0.77 …) | `reference.py` → `POSVAL` | Recomputed from that user's leagues |
| Number of leagues = exactly 3 | Everywhere — `CHOOSE()` with 3 arms, 3 pick logs, 3 hidden column blocks | Must tolerate 1–6 leagues |
| Pick-log row ranges | `SleeperSync.gs` → `LOG_ROWS` | Derived from teams × rounds |

### DONE (2026-08-12) — genuinely no longer three-league

The formula layer was fixed on 08-11, but six things still assumed three. All now derived
from `NL = len(LEAGUES)`:

| Was | Now |
|---|---|
| `PICKS = 6` | `2 × NL` pick columns |
| `_LOGSIZE = [200, 190, 260]` | each league's own `teams × rounds + 12` |
| `for j in range(3)` (×2) | `range(NL)` |
| `SETUP_ACTIVE = SCORE1 + 8` | `SCORE1 + NL + 1` |
| `My Roster!$A$6:$A$29` | span computed from the actual blocks |
| `LOG_ROWS = {1:…, 2:…, 3:…}` in the .gs | published on Setup (cols Q/R), read back |
| `SHORT = {…three names…}` | `_short()` derives a label from any name |

**Verified by building at 2 and 5 leagues.** 5 leagues: 10 pick columns, INDEX blocks 5 wide,
pick logs at 19-222 / 226-417 / 421-684 / 688-849 / 853-1088, roster range `$A$6:$A$49`,
28 roster keys. 2 leagues: 4 pick columns, blocks 2 wide, everything validated.

### DONE (2026-08-11) — the index restructure

- `CHOOSE($M$8, a, b, c)` → `INDEX($BD4:$BF4, $idx)` everywhere per-league. Blocks are sized
  `NL = len(LEAGUES)`, so the build code no longer knows or cares how many leagues there are.
  **Verified by rebuilding with 2 leagues:** blocks shrank to 2 wide, Setup showed 2 rows,
  only 2 toggles appeared, everything still validated.
- The active-league formula is generated from `NL` instead of testing three fixed rows.
- **Setup tab** added (first tab): username, season, and a league table — #, name, teams,
  rounds, draft date, draft id, my slot, roster. Draft Day toggles read their labels, team
  counts and dates from it. Nothing downstream hardcodes a league name any more.
- **`SleeperSync.gs` is no longer tied to one account.** New `Sleeper > Import my leagues`
  takes the username from Setup, resolves the user id, pulls their leagues and drafts, and
  writes the table — including draft slot once Sleeper sets the order. `syncDraft` resolves
  the draft id and user id from Setup at run time.

### DONE (2026-08-12) — the league maths now recomputes in-sheet

Option 1 from the old plan, built:

- **Setup holds a scoring matrix** — one row per league, one column per scoring key
  (17 of them), imported straight from Sleeper's `scoring_settings`. An ACTIVE row picks the
  toggled league with `INDEX`.
- **Setup holds numeric starter counts** per position (J..P), also imported.
- **The board carries 17 projected-stat columns**, and `Proj pts (live)` is
  `SUMPRODUCT(stats, active scoring row)`. **Verified against the Python engine: Gibbs
  computes to 331.4 both ways.**
- **Replacement level is live** — `LARGE(FILTER(pts, pos=P), N)` where
  `N = teams × (starters + FLEX share)`, all read from Setup. `VOR (live)` follows.

So importing a league with different scoring or a different size re-scores the whole board
with no rebuild.

### STILL GENERATED (acceptable)

Tiers and the component percentiles are computed at build time. Percentiles are
position-relative and league-independent, so they travel fine; tiers are a convenience that
stays sensible across normal league shapes. A genuinely unusual format is worth a rebuild.

---

## 2. Design principle (this supersedes earlier guidance)

Earlier direction was "explain things so a newcomer isn't confused." That was taken too far
and produced walls of text. **New rule:**

> **Simple by default. Complexity is opt-in.**

- Default view shows the fewest columns that let you draft well.
- Explanations live *behind* something — a toggle, a hover note, one reference tab — not
  inline on every tab.
- A newcomer should be able to draft without reading anything. Someone who wants the
  reasoning should be able to find it in one click.
- Prefer showing the number over explaining the number.

---

## 3. Tab-by-tab backlog

### Draft Day — mostly good, leave alone
Works. Don't add to it. Settings only: Need bonus, Time missed, **How much the room
counts**, **Rookie upside**. (Rating tilt and Safe ↔ Upside are gone — see §4 below.)

- **Safe ↔ Upside (0–100)** splits a fixed 15-point rating budget between two components,
  Floor and Ceiling. Their weight cells on the Ratings Lab are formulas, greyed, not typed.
  Floor = games, snap share, start rate, locked-in touch share, proven finish.
  Ceiling = explosive plays, RZ conversion, team offence, youth, projected jump on last year.
- **Rookie upside (TRUE/FALSE)** adds up to `ROOKIE_MAX = 10` DRAFT SCORE points to rookies,
  scaled by confidence (1.0 confirmed R1 / 0.6 middle / 0.3 unconfirmed) via the hidden
  `rookie wt` board column.

### Ratings Lab — vague, needs a rebuild
Current problem: 14 flat weights with no structure, and no way to say *which stats* make up a
component. Direction:

- **Two levels.** Within a component, choose which stats feed it and how much
  (e.g. Volume = snap share vs touches vs targets). Then weight the components against
  each other.
- Make it feel malleable — sliders/dropdowns, not a wall of numbers.
- Show the *result*: given these weights, here is your priority order in plain words
  ("you are drafting for volume and red-zone work, and you don't care about schedule").
- Cleaner layout. Fewer words.

### My Roster — DONE (2026-08-12)

Rebuilt. Top to bottom: **MY LINEUP** (a real lineup card for the selected league) →
**BYE WEEKS** → **WHAT THE DRAFT COST** → the old per-position needs blocks → Best available.

- The card is fed by one `SORT(FILTER(...))` spill into hidden columns T–AB, sorted by a new
  hidden board column `posord` (QB1 RB2 WR3 TE4 K5 DEF6) then DRAFT SCORE. Nothing is typed,
  so a rebuild loses nothing.
- **Pick** comes from `MATCH` against the active league's pick log via
  `OFFSET('Draft Day'!$A$1, INDEX({firsts}, idx)-1, 0, INDEX({counts}, idx), 1)`.
- **vs ADP** = pick − ADP rank. ≥8 Bargain, ≥−2 Fair, else Reach.
- **Risk** reads the Floor component (70/50/35 bands); rookies get their own wording because
  Floor cannot see a player with no NFL snaps.
- **Role** is Starter / FLEX / Bench. FLEX goes to the best leftover by DRAFT SCORE via a
  hidden eligibility flag in column L — position order alone would always hand it to a spare
  RB. Verified in simulation: Walker (RB3) and Odunze (WR3) took the two flex spots,
  Tracy (RB4) benched.
- Bye strip counts starters+flex per week and warns at 3.

**Keep in mind:** `ROS_ROW1` is now derived (`CAP_HDR + 6`), not 6. `validate.py` finds the
needs-block header row by searching for `'Position'` rather than assuming row 5.

### Cheat Sheet — untouched, currently just tiers
Needs a reason to exist. A printable draft guide should be genuinely useful away from the
screen. Ideas to weigh: tiers with the drop-off cliffs marked, your target list by round,
sleepers/avoids, bye clusters, a place to write picks by hand.

### Notes & Sources → replace with "How this works"
Sources are over-detailed. Replace with:

- How each tab works, briefly
- The maths behind DRAFT SCORE, in plain language
- **What the user's own ratings currently mean**, expressed as a priority list
- Keep a short sources/limits section at the bottom, not the top

### Start Here — trim hard
Cut to the few things needed before the first draft. Everything else moves to "How this works."

---

## 4. Technical constraints any change must respect

Learned the hard way in this build — do not re-derive these.

1. **Google Sheets only.** `FILTER`, `SORT`, `ARRAY_CONSTRAIN` are available and used.
   Sheets ignores Excel column groups, so never hide anything behind an outline.
2. **`SUMPRODUCT` needs matching array shapes.** Component scores sit in a row, so the
   weights must be mirrored into a row too (the "engine row" on Ratings Lab). A row × column
   pairing is `#VALUE!`.
3. **Never clamp VOR at replacement.** It put 142 of 259 players on exactly 0, which made
   their draft scores identical and gave all of them the same rank. Below replacement keeps
   an ordered band down to −25.
4. **The rating does not enter the draft score at all.** It used to, via a `tilt`
   multiplier; that measured zero lift over the projections in five seasons and
   double-counted the projection percentile, which VOR already is. Anything that is in the
   score is ADDED, not multiplied — multiplying erases a preference when VOR is 0 and
   inverts it when VOR is negative.
   Current: `pre = (VOR + fit) × Position x + need + rookie`, then
   `DRAFT SCORE = pre + w × (pre of the room's pick at his ADP − pre)`, with `w` per player:
   full for K/DEF, half for a man with no season, a tenth for everyone else, all scaled by
   the **How much the room counts** control.
5. **Components are percentiles WITHIN position.** So the rating alone cannot compare a QB to
   an RB — that is what VOR is for. Rated alone, Josh Allen is #1 overall.
6. **Missing 2025 data must never be treated as zero.** Sleeper's stats feed is capped per
   position; ~40 players (incl. Nabers, Garrett Wilson) have no 2025 row. They inherit their
   projection percentile instead. Blank cells, never 0.
7. **`web_fetch` truncates at ~74k characters.** Fetch one position at a time and vary
   `order_by` to widen coverage. Oversized responses land in the tool-results folder and can
   be salvaged with a `raw_decode` loop.
8. **Verify formulas by SHAPE and by TARGET**, not by value — LibreOffice recalc is dead in
   this environment. `validate.py` checks SUMPRODUCT dimensions, INDEX/MATCH lengths, and
   that references land on the column header they're supposed to. Column drift after a layout
   change has caused three separate bugs.
9. **Anything typed by the user must survive a rebuild.** Weights, Position x, draft slot,
   pick logs. A rebuild currently wipes them — worth solving before drafts start.

---

## 5. Build files

`reference.py` league configs · `rookies.py` draft capital · `engine.py` scoring + VOR +
tiers · `engine2.py` component percentiles · `verdicts.py` plain-English calls ·
`build3.py` workbook · `validate.py` checks · `SleeperSync.gs` live draft sync.

Run order: `python3 engine.py && python3 build3.py && python3 validate.py`
