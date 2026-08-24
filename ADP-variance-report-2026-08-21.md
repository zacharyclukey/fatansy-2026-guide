# Where the board disagrees with the room — and whether it is right

Board exported 21 Aug 2026, 562 players. Your ratings: steady-points −35, ascending +20,
availability +15, mistakes −15, need bonus 0, **room counts 100%**, rookies on, no stars or
fades.

## The short answer

**No formula error. One real data hole. Everything else is either correct or an assumption
you can see and change.**

Your top eleven track ADP almost exactly — gaps of 0 to 3 places. A board with a broken
value formula does not do that. The divergence starts at pick 12 and it is concentrated in
two places, for two different reasons.

---

## 1. Jayden Higgins — **corrected: not a data error, a torn ACL**

My first read of this was wrong and the correction matters, so here is the whole of it.

| | |
|---|---|
| Board (before) | **#353** |
| Room | ADP **172.2** |
| Projection | **0 points** |

Rotowire's projection object for him contains one field, `gp: 18`, and no statistics. I went
looking for the missing data. It is not missing:

```
injury_status : IR
injury_body_part : Knee - ACL
injury_notes : Surgery
weekly projections, weeks 1–18 : all null
```

They are not failing to project him. They are **declining to**, deliberately, for all
eighteen weeks. Of the 23 players carrying IR/PUP/DNR, 8 have a projection and 15 do not —
so it is a judgement made player by player, and the absence is itself the forecast.

There is therefore no data to go and fetch. Inventing a projection from his 2025 line would
be manufacturing the exact opinion the provider withheld.

**But the board's answer was still bad**, because zero is a confident-looking number and it
buried him 180 places below where the room takes him. The room is not paying for his points;
it is paying for a **spare IR slot** — your league has one — which is a roster move no points
forecast can express.

**What changed:** "no forecast at all" is now its own case in the ADP anchor, weighted 1.0.
When we have no opinion to defend, the room's ADP is the only information in the building and
the board defers to it completely. He now sits at **#147** on your settings (#212 at the
default anchor), against an ADP of 172 — and his card carries a chip reading
**"No projection — ranked on ADP"** so the screen says why rather than showing a silent zero.

He is the only projection-less skill player the room drafts inside 200. The next is at 244.

---

## 2. Genuine value: Bowers and Collins

Both survive at maximum ADP anchoring, which is the test that matters. I rebuilt your board
at three anchor settings:

| | ADP | anchor 0 | anchor 0.7 | **anchor 1.0 (yours)** |
|---|---|---|---|---|
| Brock Bowers | 22.1 | 11 | 13 | **12** |
| Nico Collins | 25.7 | 10 | 12 | **13** |

Turning the room's opinion from "ignored" to "counts as much as possible" moves them one or
two places. Their position is coming from the projection, not from a setting.

### Brock Bowers — accurate

Projected **102 catches, 1077 yards, 7 TD = 254 points.** Check it against his own 2025 rate:
64 catches and 682 yards in 12 games is 5.3 catches and 57 yards a game, which over a full
season is 91/966. The projection is a modest step up from what he already did, not a leap.

He is TE1 by **19 points** over Trey McBride, and the tight end replacement level in your
league is **162**. That is the whole story: 254 − 162 = 92 points above a startable tight end,
which is a running-back-sized edge. The room drafts tight ends late by convention; your board
prices the gap.

### Nico Collins — accurate, but it is Sleeper's opinion, not a fact

Sleeper's own WR order, in your scoring:

| | | proj | ADP order at WR |
|---|---|---|---|
| 1 | Puka Nacua | 313 | 2 |
| 2 | Ja'Marr Chase | 311 | 1 |
| 3 | Jaxon Smith-Njigba | 285 | 3 |
| 4 | Amon-Ra St. Brown | 281 | 4 |
| 5 | CeeDee Lamb | 271 | 5 |
| **6** | **Nico Collins** | **262** | **10** |
| 7 | Justin Jefferson | 250 | 6 |

The projection is 84 catches, 1262 yards, 8 TD. His 2025 was 71/1132/7 in 15 games — so this
is essentially his own 2025 rate over a full season, which is conservative rather than bold.

The board is not inventing anything. **Sleeper rates him WR6 and the market drafts him WR10**,
and your board reports Sleeper. That is a real disagreement, not arithmetic.

**Caveat worth taking seriously:** the whole board is single-sourced. There is no second
projection anywhere in this app. If Sleeper is wrong about Collins, you are wrong about
Collins, and nothing on the screen will warn you.

### Both are still labelled **Reach** at pick 12

Their worth windows are 10–12 and 10–13, and their odds of lasting to your next turn are
**96% and 98%**. Even though the valuation is right, the board is telling you not to spend
pick 12 on either — they are coming back. Being high on a player and taking him early are two
different decisions, and the board is already separating them correctly.

---

## 3. Assumption, not error: the buried backs

| player | ADP | board | Sleeper projects |
|---|---|---|---|
| Blake Corum | 103.5 | 168 | 757 rush yds, 6 TD |
| Chuba Hubbard | 76.1 | 137 | 766 rush yds, 5 TD |
| RJ Harvey | 79.9 | 141 | 515 rush yds, 3 TD, 37 rec |
| Zach Charbonnet | 141.7 | 252 | 264 rush yds, 3 TD |
| Brian Robinson | 150.1 | 236 | 358 rush yds, 2 TD |
| Tyler Allgeier | 146.1 | 241 | 400 rush yds, 3 TD |
| Alvin Kamara | 160.2 | 249 | 185 rush yds, 1 TD |

Every one has a **complete, real projection**. No missing data. Sleeper simply projects them
as committee and backup backs, which by definition scores badly.

The room is not valuing their projected season — it is buying the branch where the man in
front of them gets hurt. That is a legitimate thing to pay for and the app does price it, but
**not in the Score column**. Score is deliberately roster-blind so it does not move under you
when you make a pick; the insurance value lives in the recommendation, which knows who you
already own. So a handcuff will always look worse on the board than he is worth to you
specifically.

Two honest notes on that:

- I capped the handcuff lift at 5 points earlier today, at your request, to stop it deciding
  picks on its own. That cap is doing exactly what you asked and it is part of why these men
  sit low.
- A −100 VOR cannot be rescued by a 5-point cap. If you want these visible on the board rather
  than only in the recommendation, that is a different change and worth deciding deliberately.

---

## 4. Everything else flagged

Twenty-seven players inside the drafted range exceed a tier-weighted tolerance (±4 places in
round one, widening to ±50 by pick 120). After the three groups above, the remainder are all
small and all explainable:

- **Jayden Reed** (+51): projected 197.6 off a 7-game 2025. Your *ascending +20* preference
  favours exactly this shape. Working as configured.
- **Brock Purdy** (+40), **Lamar Jackson** (−22): quarterback VOR is compressed because the
  12th quarterback is already good. Small point differences move a QB a long way in rank.
  Structural, not an error.
- **KC Concepcion** (+33): rookie, no 2025 data, rookie bonus on. Expected.
- **Travis Hunter** (−61), **Mike Evans** (+20): 7 and 8 games played in 2025 — your
  availability +15 is pulling them apart from the room. Working as configured.

---

## What I would actually do

1. ~~Fix Higgins~~ **Done.** No forecast is now its own anchor case, and the row says so.
2. **Leave Bowers and Collins alone.** The maths is right and the board is already telling you
   to wait on both.
3. **Decide about handcuffs deliberately** rather than letting the cap decide by accident.
4. **Know that you are single-sourced.** Every number here traces to one projection provider.
   That is the largest uncertainty on the board and it is not visible anywhere on it.

## A note on the method

Two of my own findings in this report were wrong before they were right, and both were caught
by checking rather than reasoning:

- I first read your `anchor: 1` as 1% and reported the anchor slider as broken. It is the
  engine's 0–1 scale, so you are at **100%** — maximum pull toward ADP — and my comparison had
  clamped both sides to the same value. That matters for the conclusion: Bowers and Collins
  hold their positions *at maximum anchoring*, which is a stronger result than I first had.
- I called Higgins a data error before I fetched the player and found the ACL.

Where I have not been able to check, I have said so — chiefly that every projection here comes
from one provider, and nothing in this app can tell you when that provider is wrong.
