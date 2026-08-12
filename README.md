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

Every asset URL carries a `?v=` stamp to defeat that caching. Run `./bump.sh` before
committing any change to css or js — it rewrites the stamp everywhere and updates the
build number shown in the footer.

## What is in here

| File | What it does |
|---|---|
| `index.html` | The three views: board, my team, ratings |
| `app.js` | Everything on screen, and the settings that persist in your browser |
| `engine.js` | The rating maths — components, per-position stat weights, VOR, draft score |
| `data/players.json` | 259 players, their percentiles, projections and league rules |
| `styles.css` | Layout and colours, light and dark |

The spreadsheet (`Draft Guide 2026.xlsx`) is deliberately **not** published — it stays on
disk as a draft-day backup. `.gitignore` keeps it out.

## Tests

```
npm --prefix test i jsdom
node test/smoke.mjs
```

39 checks against the real `index.html` in a real DOM — the engine maths, the board, the
draft clock, the call, strategies, Sleeper import and sync, and the offline path. Run it
after any change; it has caught several bugs that looked fine by eye.

## Regenerating the data

The player data is built by a Python pipeline that pulls from Sleeper. `data/players.json`
is the only thing the app needs; drop in a new one and everything re-scores.

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

**Floor** and **Ceiling** are not typed directly — the Safe ↔ Upside slider on the board
splits a fixed budget between them.

`DRAFT SCORE = (value over replacement + tilt × rating) × position multiplier + need bonus
+ rookie bonus`

The rating is *added*, never multiplied: multiplying erases it when value is zero and
inverts it when value is negative.
