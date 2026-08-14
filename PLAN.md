# What to do next, and why

Written 14 August 2026. First draft is **29 August, fifteen days away**. That deadline is
part of the ranking: something small that can be built and tested twice before draft night
beats something clever that lands the day before.

The bar everything here has to clear is set by what has already been measured over
2020-2025, which is not up for renegotiation:

- Sleeper's projections are strong (rank correlation 0.76-0.82 against next season) and
  beat "last year's points per game" by about +0.25 at every position.
- Every historical box-score stat, all fifty of them, added +0.007 to +0.015 on top. That
  is noise.
- The projections are **right per game and wrong per season**, and the entire shortfall is
  games missed.
- Bust rate repeats year to year (~0.50). Boom rate does not (~0.05). Sell a floor, never
  a ceiling.
- Projection bias does not persist, and individual beats are not foreseeable.

So nothing below claims to know more than the projection. Every item earns its place by
making a true thing easier to see, faster to act on, or harder to get wrong.

---

## What was measured this run

### The one that could not be done, and why

**The headline test — does an expected-games correction actually improve next-season rank
correlation — was not run this session, because the data could not be fetched.** The bash
sandbox's proxy allows pypi and github.com only; `api.sleeper.com` returns nothing. The
usual escape hatch, `web_fetch`, now refuses any URL that has not already appeared in the
conversation, so it could not be used either. Only two seasons of data exist on disk
(2026 projections, 2025 actuals) and a year-pair test needs at least four.

That measurement is not impossible, it is just impossible *here*. GitHub Actions can reach
Sleeper — that is how `volatility.py` and `annual.py` produced their numbers. So this run
built the script instead. See "what was built" at the bottom.

### 1. Sleeper's 2026 projection applies no availability discount to anyone

`pipeline/games_effect.py`, part 1. Every one of the **345 rows in
`sleeper_proj_raw.json` carries `gp = 18.0`** — all of them, at every position. The regular
season is 18 weeks and every team has a bye, so the most anybody can play is 17.

Whatever else that means, it means the man who played four games last year and the man who
played seventeen are priced over the same season. This is not an inference from the
measurements; it is a field in the payload.

### 2. Whether the points behind that 18 are a full season's worth is NOT established

`pipeline/games_effect.py`, part 2. Dividing each projected counting stat by the same
player's own 2025 per-game rate gives medians of 15.0 (RB carries), 15.0 (RB yards), 16.4
(WR/TE catches) and 16.2 (WR/TE yards) — not 18.

That test cannot settle it, and saying so is more useful than picking a side. A projection
regresses everyone toward the middle, so the heavy-workload players who pass the filter are
projected at less than last year's rate. Eighteen games at 85% of last year's rate and 15.3
games at full rate produce exactly the same number here.

**It does not matter much**, for the reason in part 4a below.

### 3. The draftable pool played 14.5 games of 17 last season

`pipeline/games_effect.py`, part 3. Players with an ADP inside the first 200 picks who had
a 2025 season at all:

| | n | mean games | played all 17 | under 14 |
|---|---|---|---|---|
| QB | 26 | 13.92 | 42% | 31% |
| RB | 55 | 14.71 | 45% | 25% |
| WR | 64 | 14.38 | 33% | 22% |
| TE | 27 | 14.85 | 44% | 26% |

Whole pool: **14.49 of 17**. If anything that overstates it — Sleeper's stats feed is
capped per position, so the sample leans toward players who scored a lot, and scoring a lot
requires being on the field.

### 4. What an expected-games correction would do to the board

`pipeline/games_effect.py`, parts 4 and 5, run against the 12-team 1812 Fantasy League with
replacement level rebuilt from the corrected points the same way `engine.js` derives it.

**a) The flat part changes nothing.** Rescaling everyone from 18 games to 17 costs the
average player 9.0 points. It is the same multiplier for every player at every position, so
it moves no rankings at all — not the order, not value over replacement, nothing. It only
changes the number on screen. That is why the 17-vs-18 question above is not worth
arguing about, and also why fixing it is completely safe.

**b) The differential part is where everything happens.** `k` is how many games' worth of
"just use the position average" get mixed into a player's own season, because one season is
a small sample:

| shrinkage | mean move | biggest move | changes in the top 50 | QBs in the top 50 |
|---|---|---|---|---|
| k=0 | 23.1 places | 161 | 10 | 1 → 5 |
| k=1 | 13.7 | 100 | 9 | 1 → 4 |
| k=2 | 9.6 | 73 | 8 | 1 → 4 |
| k=4 | 6.2 | 57 | 4 | 1 → 2 |
| k=6 | 4.9 | 36 | 3 | 1 → 2 |

**Nothing offline can say which k is right.** The size of the change is entirely a
function of a constant nobody has calibrated.

**The quarterback column is the warning.** 2025 was a bad year for quarterback health —
Burrow 8 games, Daniels 7, Purdy 9, Lamar 13, Mahomes 14. A correction taken from that one
season collapses the quarterback replacement level from 296 points to 225 and promotes
whichever quarterbacks happened to stay fit. At k=2 that is Dak Prescott from board 78 to
49, Trevor Lawrence 79 to 51, Drake Maye 61 to 41 — and Jayden Daniels from 68 to 141.

Those are enormous moves to make on the strength of one season of luck, in an app whose own
history is a list of confident-looking signals that turned out to be noise. This is the
single most important finding of the run: **the correction is not a small tidy-up. Done to
the score, it is the biggest change the board has ever had, and it is currently unjustified.**

### 5. The existing "punish injury risk" preference already picks out the same players

`pipeline/games_effect.py` was checked against `engine.js`'s `durability()`. Rank
correlation between what that preference sees and a shrunk expected-games estimate: QB
0.999, RB 0.995, WR 0.970, TE 0.991.

So the app already has a control that singles out exactly these players. Two differences
matter. It is **off by default**, so today it does nothing. And it nudges the *rating*,
which is a tilt on top of value — where an expected-games multiplier changes the projected
points that value over replacement is built from. Same players, very different force.

### 6. The 2025 box-score columns are already off by default

`app.js` line 1498: `st.cols ||= { bye: true }`. The "2025 per game" and "2025 totals"
groups are opt-in checkboxes that start unticked, and the per-position detail columns are
opt-in too. Nothing needs demoting. See the killed list.

### 7. The measured definition of "letting you down" is not the one that was proposed

`pipeline/volatility.py`, `profile()`: bust is **a week in which he scored half or less of
that week's projection**, as a rate over weeks he had a projection at all. That is the
definition behind the 0.50-0.53 persistence. "Games below some fraction of his own average"
is a *different* statistic and has never been measured.

### 8. Baseline

`node test/smoke.mjs` — **312 passed, 0 failed**, before and after this run's changes.

---

## The plan, in order

### 1. Press the button and find out whether availability repeats
*Built this run. Costs one click and about ten minutes of a GitHub runner.*

On github.com, **Actions → "Does availability repeat?" → Run workflow**. It fetches season
stats plus week one of each season from 2020 to 2025, and answers two questions: does games
played in one season predict games played in the next, and does correcting for it improve
the ranking of next season's actual points.

**Why the measurements support it:** the whole shortfall in every projection is games
missed. That is established. What is *not* established is that missing games is a fact
about the player rather than something that happened to him — and boom rate looked just as
plausible before it came back at 0.05.

**What could go wrong:** availability may not repeat, and the honest answer would be to
stop. The workflow says so in its own summary. There is also a caveat no measurement can
remove, and the script prints it: a man who plays 17 games two years running may be durable,
or may simply be a starter. Some of any correlation is job security rather than health.

**How to read it:** part 1 first. Under about 0.20 and there is nothing here. For lift, the
bar is +0.02 — every box-score stat in the app put together was worth +0.015, and that was
correctly called noise.

**Everything below at rank 2 and rank 9 depends on this answer.**

### 2. Show expected games as a fact, and leave the score alone
*Half a day. Safe whatever the workflow says.*

On the player's card, one line: **"played 7 of 17 last year — a full season at this rate
would be 309 points."** No new maths, no change to any ranking, no new column on the
default board.

**Why:** part 1 of the measurements says the projection prices a four-game season and a
seventeen-game season identically. That is a true and surprising thing about the number on
screen, and right now nothing anywhere says it. A person who can see "played 7 of 17" next
to a big projection can draw their own conclusion in about a second — which is exactly the
kind of thing that works for someone who does not follow football closely, because it needs
no vocabulary at all.

**What could go wrong:** it is one more line on a card that is already busy. Keep it to one
line and put it near the projection, not in a new section.

**Verification:** `test/smoke.mjs` already builds the real DOM. Assert the line appears for
a player with a known `games_2025`, is absent for a player with no 2025 season, and that no
draft score anywhere changed.

### 3. Two players side by side, on one line
*One to two days. No new modelling.*

Between picks the only question anybody actually asks is "him or him", and today that means
opening one card, remembering it, and opening another. `app.js` tracks `open` as a single
player id — you literally cannot have two cards up.

Make `open` hold up to two, and when it holds two, render the same handful of numbers as
two columns with the better one marked.

**Why:** nothing predictive, purely a reduction in mistakes made under a 90-second clock.
Of everything in this document it is the item most likely to change what actually gets
picked, and the only one that helps someone who does not know the players at all.

**What could go wrong:** it is a real change to the busiest rendering path in the app,
which is hand-optimised to reuse row elements rather than re-render. Two open rows must not
break `rowEls` reuse. That is the risk, and it is a testable one.

**Verification:** jsdom. Open two rows, assert both stay open, assert the comparison marks
the higher of two known values, assert the board still reorders correctly afterwards.

### 4. A pre-flight check, run the night before
*Half a day. Pure mistake-prevention.*

One panel on Setup with five things the app can verify about itself:

1. how old `data/players.json` is;
2. whether a draft slot is set for the league you are about to draft;
3. whether the Sleeper dry-run passes for that draft id;
4. whether the roster settings the data file holds still match what Sleeper says today;
5. whether a practice draft has ever been played in this league.

**Why:** every one of these has already gone wrong. The README lists seven bugs found by
playing practice drafts, one of which was "a finished draft told you to enter your draft
slot". A league whose settings the data file has not heard of scored every kicker and
defence at zero. These are not hypothetical failure modes, they are the repo's own history.

**What could go wrong:** almost nothing — it reads state that already exists and writes
none. The one judgement call is not letting it become a wall of text; five lines with a
tick or a cross.

**Verification:** jsdom, with a stubbed Sleeper client. Assert each check fails when its
condition is broken and passes when it is not.

### 5. Replace ceiling talk with the bust rate that was actually measured
*Two to three days, most of it in the pipeline.*

Show **"let you down in 5 of his 16 games last year"**, using `volatility.py`'s existing
definition: a week in which he scored half or less of that week's projection.

**Why:** bust rate repeats at 0.50-0.53 and boom rate does not (0.12, 0.03, 0.12). A floor
can be measured; a ceiling cannot. And "he let you down five times" needs no explanation to
anybody.

**Use the measured definition, not a new one.** The standing proposal was "games below some
fraction of his own average", which is a different statistic that nobody has ever tested.
Inventing a fresh definition and shipping it unmeasured is precisely the mistake the
fifty-stat rating was.

**What it costs:** `data/players.json` has no bust field, so this needs a new pipeline step
fetching 18 weeks of 2025 projections and results (~36 requests), a new field per player, a
`check_data.py` gate, and then the display. The pipeline half cannot be tested in this
sandbox at all — it needs a GitHub run.

**What could go wrong, and it is real:** bust rate and games missed overlap. An injured
player often still carries a projection and scores zero, which counts as a bust. Show both
"let you down 5 times" and "played 7 of 17" side by side and you are showing one fact
twice. Pick one per card.

**Verification:** the pipeline step gets a planted-and-control check like
`check_durability.py`. The display gets jsdom assertions.

### 6. Refresh injuries and ADP on draft morning
*One day, with one unknown that could sink it.*

A button that re-pulls injury status and ADP from Sleeper and overlays them on the board, so
somebody landing on IR overnight does not sit at pick 14 all evening.

**Why:** it out-predicts nothing. It just stops the board being wrong about a fact the
whole room already knows.

**The unknown:** `sleeper.js` talks to `api.sleeper.app/v1`, which is known to work from the
browser. Projections and ADP live on **`api.sleeper.com`** — a different host, whose CORS
headers this app has never touched from a page, and which cannot be tested from this sandbox
or from jsdom. **If that host does not allow cross-origin reads, this idea is dead and there
is no way to find out except by trying it in a browser.** Try it in five minutes before
planning a day around it.

**Fallback if CORS blocks it:** the nightly Action already rebuilds the data file. Add a
manual "Actions → refresh data now" run to the README, which is not one click but is one
click plus a wait, and is guaranteed to work.

**What could go wrong beyond that:** a refresh that half-succeeds and leaves the board in a
mixed state during a live draft is worse than a stale board. It must be all-or-nothing, and
it must never touch picks already made.

### 7. Hand your settings to someone else as a link
*Half a day.*

Settings live in `localStorage` under one key. Open the site in a different browser and you
get defaults. So the second person drafting off this thing starts from nothing that has been
tuned.

Encode the settings object into the URL and add a "copy a link to my setup" button.

**Why:** the project's own spec says it must work for any Sleeper user, and two people are
going to use it. This is the cheapest possible version of that.

**What could go wrong:** the URL carries no picks and no personal data beyond preferences —
keep it that way. Reject a malformed payload rather than half-applying it.

**Verification:** jsdom. Round-trip a settings object through encode and decode, assert
equality, assert a corrupt payload falls back to defaults.

### 8. Make the stale-data warning know about draft day
*An hour.*

`app.js` calls the data stale after 7 days. Seven days is fine in July and useless on
29 August. Within three days of a draft, anything over one day old should go red.

**Why:** the most likely draft-night failure is not a wrong model, it is a board built from
a week-old file because a nightly Action failed quietly. Sleeper already supplies the draft
date and Setup already holds it.

**Verification:** jsdom with a faked clock.

### 9. Only if the workflow says yes: put expected games into the score
*One to two days, and not before the number exists.*

If part 1 of `durability.py` comes back with persistence well above 0.20 **and** part 2
shows lift clearly above +0.02, then replace the season projection with
`points per game × expected games`, using the `k` the sweep picked rather than one chosen by
feel.

**Why it is last despite being the highest-value idea:** measurement 4 above. It moves the
board 10 to 23 places on average and adds three or four quarterbacks to the top 50. A change
that large, two weeks before a draft, on an untested assumption, is the exact shape of
mistake this project has already made four times.

**If the workflow says no, that is a good outcome, not a wasted one.** Rank 2 still ships,
and the app gets to say something true about availability without pretending to price it.

---

## Killed

**Demoting the 2025 box-score columns.** Already done and nobody noticed. `st.cols` starts
as `{ bye: true }`, so both 2025 groups and the per-position detail columns begin unticked,
and the card's stat grid only appears when a row is expanded. The measurements say those
numbers predict nothing; the app already treats them as opt-in curiosities. There is nothing
left to demote and removing them outright would only cost someone a sanity check they like
having.

**Any freshly invented definition of "letting you down".** "Games below some fraction of his
own average" sounds reasonable and has never been measured. The one that *was* measured —
half or less of that week's projection, persisting at 0.50-0.53 — is right there in
`volatility.py`. Use it. Inventing a new statistic because it reads better is how the
fifty-stat rating happened.

**Rescaling everyone from 18 games to 17 as a board improvement.** Measured: it moves
nothing. Zero rank changes, by construction. Worth doing as part of rank 2 for honesty,
worth no argument at all beyond that.

**Turning on the existing "punish injury risk" preference as a substitute.** It picks out
the same players (rank correlation 0.97-0.999 with an expected-games estimate) but acts on
the rating, which is a tilt on top of value rather than the value itself. Turning it on by
default would be making the same unmeasured bet as rank 9, quietly, through a control the
user cannot see the effect of. Leave it off until the workflow has spoken.

**A plain-English "why is he here" sentence on every card.** Considered and dropped. The
design rule is show the number rather than explain the number, and the last time this app
added prose it lost the plot as a draft-day tool.

---

## What to build first

**Today:** press the workflow button. It costs nothing and it gates the two biggest items.

**This week, in this order:** rank 2 (expected games as a fact), rank 3 (two-player
compare), rank 4 (pre-flight). All three are safe, all three are testable in jsdom, and all
three help the person who knows less about football more than they help the person who knows
more. Spend five minutes on rank 6's CORS question at some point, because the answer decides
whether it is a day of work or nothing.

**Only if there is time before 29 August:** rank 5 (measured bust rate), rank 7 (settings
link), rank 8 (freshness). Rank 5 is the one to drop first if the fortnight gets tight — it
needs a pipeline change that cannot be tested outside GitHub, and the app is not worse
without it.

**Rank 9 waits for its number, and may never come.**

---

## What was built this run

One thing, and only because it is the measurement this document is missing and it cannot
touch the board:

- **`pipeline/durability.py`** — measures whether availability repeats, and whether
  correcting for it improves next-season rank correlation, sweeping the shrinkage constant.
- **`pipeline/check_durability.py`** — the reason to believe it. Two synthetic worlds: one
  with a persistent durability planted in it, one where games played is rerolled at random
  every season. In the planted world it must find persistence above 0.50 and lift above
  +0.05; in the control it must find neither. **All four checks pass** — persistence 0.79 /
  0.83 / 0.79 / 0.78 planted against -0.10 / 0.13 / 0.08 / -0.05 control, and lift +0.267 /
  +0.105 / +0.140 / +0.116 planted against -0.022 / +0.005 / +0.003 / -0.009 control. The
  control half is the one that matters: multiplying a good projection by a noisy number
  costs 0.13 to 0.19 of rank correlation, far more than anything this app has ever gained.
- **`.github/workflows/durability.yml`** — runs the check first, then the measurement, and
  publishes both with instructions on how to read them.
- **`pipeline/games_effect.py`** — every offline number quoted above, reproducible from
  files already in the repo.

Judged safe because none of it is loaded by the site, imported by any module, or run by the
nightly refresh. `node test/smoke.mjs` is 312 passed, 0 failed, unchanged.

## What could not be verified

- **Anything visual.** There is no browser in this sandbox. Every layout claim in this
  document is a guess about how something will look, including whether a two-player compare
  fits a phone screen.
- **`durability.py` against real data.** It has only ever run against synthetic seasons. The
  first real run is the first real test, exactly as `fetch.py` was.
- **Whether `api.sleeper.com` allows cross-origin reads** from a GitHub Pages page. Rank 6
  lives or dies on it and it can only be answered in a browser.
- **The right shrinkage constant.** Every `k` in this document is an illustration, not a
  recommendation. The sweep in `durability.py` is what picks it.
- **Whether availability repeats at all.** That is the whole point of rank 1, and until it
  runs, the case for rank 9 rests on an assumption, not a measurement.
