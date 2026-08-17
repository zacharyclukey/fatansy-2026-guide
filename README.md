# 2026 draft guide

A draft board for Sleeper leagues. Everything is computed in the browser — pick a league,
set what you care about, and the board re-scores as you type.

**Live:** _(fill in once Pages is on — `https://<your-user>.github.io/<repo>/`)_

## Publishing this to the web (one time)

1. Install **GitHub Desktop** and sign in.
2. `File → Add local repository…` and choose this folder. It is already a git repo with
   history, so it will just pick it up.
3. Click **Publish repository**. Untick "Keep this code private" if you want your fiancée
   to be able to open the link without a GitHub account.
4. On github.com, open the repo → **Settings → Pages**. Set Source to **Deploy from a
   branch**, branch **main**, folder **/ (root)**. Save.
5. Wait a minute, refresh, and the URL appears at the top of that page.

After that, every change is: open GitHub Desktop → **Push origin**. The site updates in
under a minute.

### "I pushed but the site looks the same"

Almost always the browser, not the deploy. GitHub Pages serves css and js with a long
cache, so Chrome keeps the old copies. Three things to check, in order:

1. **Hard refresh** — Ctrl+Shift+R (or open the URL in an incognito window).
2. **Check the build stamp** in the footer of the page. It changes with every release, so
   if it matches the newest one you are looking at current code.
3. Only then look at the repo's **Actions** tab for a failed `pages build and deployment`.

Every asset URL carries a `?v=` stamp to defeat that caching — **including
`data/players.json`**, which was missed at first and caused a genuinely confusing bug:
new code paired with a week-old cached data file, so columns that depended on newly added
fields silently rendered blank. Run `./bump.sh` before
committing any change to css or js — it rewrites the stamp everywhere and updates the
build number shown in the footer.

## What is in here

| File | What it does |
|---|---|
| `index.html` | The five views: board, my team, practice draft, ratings, setup |
| `app.js` | Everything on screen, and the settings that persist in your browser |
| `engine.js` | The rating maths — components, per-position stat weights, VOR, draft score |
| `mock.js` | The practice draft: snake order, the simulated room, the report |
| `data/players.json` | 259 players, their percentiles, projections and league rules |
| `styles.css` | Layout and colours, light and dark |

The spreadsheet (`Draft Guide 2026.xlsx`) is deliberately **not** published — it stays on
disk as a draft-day backup. `.gitignore` keeps it out.

## Tests

```
npm --prefix test i jsdom
node test/smoke.mjs
node test/_probe.mjs   # optional: plays three practice drafts and prints what the app said
node test/_auto.mjs    # optional: lets the app draft for itself and prints the teams
```

224 checks against the real `index.html` in a real DOM — the engine maths, the board, the
draft clock, the call, strategies, Sleeper import and sync, and the offline path. Two of
them play a **whole 180-pick draft**, once headlessly and once by clicking the real buttons,
which is the best regression test in here: it covers the snake maths, the drafted list, the
clock, the Type column and undo all at once. Run it after any change; it has caught several
bugs that looked fine by eye.

## Practice draft

Your drafts have not happened yet, so nothing in this app had ever run under real
conditions. The **Practice draft** tab fixes that: it drafts the other teams for you, using
your real league settings, and hands you the board when it is your turn. A full mock takes
about a minute. Nothing it does touches a real draft — and it warns you before it clears a
board you have picks on.

**Draft it all for me** plays the whole thing in one press, doing exactly what the
recommendation panel says on every pick — so it is both a look at what your ratings build
and a full rehearsal of the advice you will be following on the night. You can hand over
half way through, and the report marks which picks were yours and which were the app's.

One control: **how disciplined is this room**. Tight means the other teams take the best
player left by ADP almost every time; loose means they reach. The model underneath is
deliberately small — sample from the top of the remaining board weighted by ADP, lean
slightly toward unfilled starting slots, lean slightly toward whatever position just went
twice in a row, and fill your empty slots once you run out of room to shop.

**It is not a prediction.** It does not know your family and it cannot know who busts —
nothing measured over 2020–2025 could. It copies the one habit every draft room really has,
so that the interface gets used in anger before the night it matters.

## Players with no NFL season

Roughly a third of the pool has no 2025 games — rookies, and veterans the stats feed does
not cover. They used to be handed **one** number, the rookie model's score, copied into all
forty history sub-metrics. The rating is the mean of those sub-metrics, so it just returned
that one number wearing forty hats: a quarterback who had never taken a snap read 94 for
rushing efficiency, 94 for red-zone conversion and 94 for reliability, rated 81 out of 100
while projecting 84 points **below** replacement, and got drafted at pick 96 against an ADP
of 170. Every unexplained reach on the board was a player who had never played.

Now a man with no season is rated on the three things actually knowable about him — his
projection (45%), where he went in the NFL draft (30%), and how much of his team's work he
has been handed (25% between depth chart and team offence) — and the stats he does not have
say nothing at all. The pipeline emits blanks instead of copies, `check_data.py` fails the
build if anything starts inventing them again, and the app ignores them either way, so it
is correct with today's committed data file as well as tomorrow's.

The rookie bonus dropped from +10 to +4 at the same time: draft capital is now inside the
rating, so a full need-bonus on top of it was the same fact counted twice.

Playing practice drafts has found seven real bugs so far, every one of them in the app
rather than the simulator: the recommendation panel was a draft behind on the first pick, a
finished draft told you to enter your draft slot, the board could reach round 13 with
nothing left on screen you could actually take, picks were priced against an ADP from
beyond the end of the draft, filling your starters lifted kickers and defences into the
middle rounds of the board, the app drafted a kicker in round 8, and any league the data
file has not heard of scored every kicker and defence at zero.

## Regenerating the data

`pipeline/` holds the whole build, and a GitHub Action re-runs it every morning and commits
the result, so the board is current on draft day without anyone doing anything. See
[pipeline/README.md](pipeline/README.md).

**One repo setting is needed for the automation:** Settings → Actions → General →
Workflow permissions → **Read and write permissions**. Without it the Action can rebuild
the data but not commit it.

## The backtest result, which is not flattering

Run 2024 → 2025, the rating loses to a single number at every position:

| Spearman vs next-season points/game | QB | RB | WR | TE |
|---|---|---|---|---|
| the rating | 0.72 | 0.67 | 0.72 | 0.64 |
| **last year's points per game** | 0.71 | **0.74** | **0.78** | **0.76** |
| last year's finish | **0.73** | 0.74 | 0.78 | **0.77** |
| snap share alone | 0.70 | 0.70 | 0.74 | 0.71 |

Fifty stats and ten components, beaten by "he scored a lot last year" at four positions
out of four. That is worth stating plainly rather than burying: **the blend is not a
better forecast than the naive baseline.**

Two honest caveats, neither of which rescues it:

- The projection component is excluded, because no projection exists for a past season.
  In the live app that component has by far the largest influence, so what the backtest
  condemns is the *stats* half of the rating.
- Players who vanished are kept as zeros, which lifts every metric's correlation equally.
  The comparison between metrics is still like for like.

What it does **not** mean is that the ratings are useless. They decide order within a
tier and they are what makes a pick "yours" rather than the room's. But they should not
be sold as a sharper prediction, and the default trust level should reflect that.

`python backtest.py 2024 2025` also now reports every component's predictive power on its
own, which is the evidence needed to re-weight rather than guess.

## An honest note on how much the ratings move anything

The Ratings Lab shows a **±** figure per component: how far the board moves if you switch
that component off. It is measured by rebuilding the board, not estimated.

At the default settings the numbers are small — most components move players 2-4 places
and change almost nobody in the top 50. Two reasons, and only one of them was fixable:

1. **Value over replacement is the draft score, and the rating is not in it at all.** The
   grade describes a player; it does not price him. There is no longer any setting that
   lets it outvote the projections, because five seasons of testing found it did not beat
   them. Re-weighting the components changes the bars on the card and cannot change the
   order of the board by a single place — there is a test that asserts exactly that.
2. **The components used to overlap, badly.** That part is fixed — see below.

### The duplication that was there

`Floor` was **100% formulas copied from other components** — its snap share was Volume's,
its touch share was Role's, its games played was Reliability's, its finish was
Production's. `Ceiling` was 65% copies. So the Safe ↔ Upside slider was secretly a second
volume/role knob, and every one of those stats was counted twice in any rating that used
both.

Fixed by deleting Floor as a component and trimming Ceiling to the two stats that are
genuinely its own — youth and the jump the 2026 projection expects — now called **Upside**.
A player's floor is still shown in the risk label; it is just computed from volume, role
and reliability for display rather than being fed back into the rating as if it were new
information. Safe ↔ Upside now moves weight between the steady components and Upside.

No stat appears in two components any more, and the test suite fails if one ever does.

## Your own view of a player

The star button on each row cycles: **☆ no view → ★ you rate him → ✕ you trust him less**.

It is deliberately not a score override. A liked player is lifted above anyone within
**5 points of score** of him and no further; a faded one drops below the same band. So it
only ever settles calls the numbers were close to indifferent about, and nobody's score
changes. The recommendation follows the same rule — if you have starred someone at the
position it is recommending and he is within that band, it names your man instead.

**My list only** filters the board to players you have an opinion about.

## Pick type

A small tag on every row saying what kind of pick he is *right now*, read from three
numbers that already existed: his floor, his upside, and how your rank compares with the
room's.

| Tag | Means |
|---|---|
| **Safe** | High floor, priced about right. The boring correct pick. |
| **Swing** | Real upside, shakier floor. Wins weeks, loses some too. |
| **Skip** | The room takes him 20+ spots before your board would. |

No tag means he is none of those three, which is most players.

## How the rating works

Two levels. Each **component** (volume, red zone, efficiency, …) is a weighted blend of
named stats, and the components are then weighted against each other.

Stat weights are **per position**, which matters more than it sounds: "broken tackles per
carry" has two distinct values across every tight end in the league, so weighting it for
tight ends was flattening the real differences between them. Zeroed weights are greyed out
in the ratings view but still editable.

**Replacement level is derived, not assumed.** The flex split used to be a hardcoded
RB 40 / WR 55 / TE 5. In a full-PPR league the twelve best players left over after every
team fills its dedicated slots are *all receivers*, so that guess measured receivers
against a bar five slots too shallow and backs against one five slots too deep. Both
errors pushed the same way and the board came out badly RB-heavy — 8 of the top 12 were
backs against the room's 6. The app now fills each position's own slots, lets the best
remaining flex-eligible players take the flex spots, and reads off who they actually are.
It self-corrects for PPR, half-PPR, TE premium or anything else a league invents.

**Floor** and **Ceiling** are gone as components; **Upside** is not typed directly — the Safe ↔ Upside slider on the board
splits a fixed budget between them.

```
pre-anchor = (value over replacement + fit lean) × position multiplier
             + need bonus + rookie bonus
DRAFT SCORE = pre-anchor + w × (what the room's pick at his ADP is worth − pre-anchor)
```

The grade does **not** appear in that formula. It used to, through a `tilt` multiplier, and
that was wrong twice over: measured over five seasons the grade added nothing to the
projections, and the one part of it that does predict — the projection percentile — is
already the whole of value over replacement. So the grade still computes and still draws
its bars on the player card, and it cannot move where anybody is drafted.

`w` is the **How much the room counts** control, scaled per player by how much the board
deserves to be believed about him: full weight on kickers and defences (their replacement
level is a number we invented, because nobody drafts a backup kicker), half on a man with
no prior season (a projection nobody has checked), and a tenth on everybody else — which is
where your league's odd scoring rules are left free to disagree with the rest of the world.

Fit is *added*, never multiplied: multiplying erases it when value is zero and inverts it
when value is negative.
