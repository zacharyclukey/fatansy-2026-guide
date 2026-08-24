// Hover text. Each entry is [what it is, how it is worked out] - one short line each.
// Long tips do not get read, so if something needs a paragraph it belongs on the page,
// not in a tooltip.

export const TIPS = {
  // the two people mix up
  Worth: ['The picks where taking him costs you nothing.',
    'Everyone in that range is a coin flip with him. It stops at a tier cliff.'],
  steal: ['He is still here past where he stops being worth it.', ''],
  reach: ['Taking him now means passing men your board rates higher.', ''],
  Rating: ['How good he is FOR HIS POSITION, 0-100.',
    'Your weighted components. Cannot compare a QB to an RB.'],
  Score: ['A grade for who to actually draft, 0 to 100. Take the highest.',
    'Mostly VOR — points above a replacement starter — plus your preferences, your stars '
    + 'and fades, and how the room is drafting. Open a player to see every adjustment and '
    + 'its size.'],

  star: ['Your own view of him. Click to cycle.',
    `Liked adds ${5}, faded takes ${5} away, and the change shows in his score. It only `
    + 'ever moves him past men he was level with.'],

  // The distinction people get wrong, including Zach: replacement is not average. The
  // average running back is the 51st of 102, most of whom nobody would ever start. The
  // replacement back is the LAST one you would actually put in your lineup - around the
  // 30th once flex is counted. On this board the gap between those two readings is 83
  // points at running back and 139 at quarterback, so it is not a quibble.
  VOR: ['How many points he beats a replacement starter by.',
    'Replacement is the last man you would actually START at his position — not the '
    + 'average one, who is far worse. That is why quarterbacks look small here: the 12th '
    + 'quarterback is already very good.'],

  Fit: ['How well he matches what you said you like.',
    'Only breaks ties. It can never move a player more than a few spots.'],
  td: ['Steady points, or points that arrive in lumps.',
    "Share of his projection from touchdowns and any bonus YOUR league pays."],
  asc: ['Take the proven man, or the one being asked to jump.',
    "This year's projected points per game against what he actually did."],
  dur: ['How much you care that a player is actually on the field.',
    'Games repeat only weakly year to year (0.27-0.31 at skill, 0.56 at QB). A lean, not a law.'],
  pen: ['How much fumbles and interceptions bother you.',
    'Priced at what your league actually fines them.'],

  ADP: ['Where the wider Sleeper room drafts him.', 'Not your league specifically.'],
  Bye: ['The week his team is off.', ''],

  'Snap %': ['Share of team snaps he was on the field for, 2025.', ''],
  'Tch/g': ['Touches per game, 2025.', 'Carries plus catches / games.'],
  'Pts/g': ['PPR points per game, 2025.', ''],
  Gms: ['Games played in 2025.', 'Out of 17.'],
  Yards: ['Rushing plus receiving yards, 2025.', ''],
  TDs: ['Total touchdowns, 2025.', ''],
  Proj: ['Projected 2026 points under this league.', "Uses your league's own scoring."],
  'P/g': ['Projected points per game, 2026.', ''],
  Tch: ['Projected touches, 2026.', 'Carries plus catches.'],
  'RZ/g': ['Touches inside the 20 per game, 2025.', ''],
  'RZ TD%': ['How often a red-zone touch scored.', 'TDs / red-zone touches.'],

  // draft-day settings
  style: ['Safe starters, or players who could win the league.',
    'Moves weight between volume/role/reliability and Upside.'],
  anchor: ['How much where everybody else is drafting counts.',
    'Heaviest on kickers and defences, where the board has no honest replacement level; '
    + 'half that on a man with no last season; barely anything on everyone else, so your '
    + "league's own scoring still decides the players it can decide."],
  need: ['Nudges toward positions you still need.', 'Adds points to a position short of starters.'],
  rookie: ['Pay up for rookies.', 'Up to +10, scaled by how sure the draft-capital read is.'],
  hideGone: ['Clear drafted players off the board.', ''],
  noProj: ['Nobody has forecast him this season.',
    'Every player with no projection is hurt, and the provider projects him for nothing in '
    + 'all 18 weeks — that is a judgement, not a missing file. With no forecast to defend, '
    + 'the board places him exactly where the room drafts him and says so here.'],
  noQb2: ['Never suggest a backup quarterback.',
    'A rule about how YOU draft, not a claim that the maths is wrong — it keeps his score '
    + 'and his rank honest and simply takes him out of every recommendation. Saved on this '
    + 'computer only, so two people sharing a board can set it differently.'],

  // components
  volume: ['How much work he gets.', 'The most predictive thing in fantasy.'],
  efficiency: ['What he does with each touch.', ''],
  redzone: ['Work where points are scored.', ''],
  explosive: ['Big plays.', ''],
  production: ['What he actually scored last year.', ''],
  role: ['His place in the offence this year.', ''],
  reliability: ['Whether he stays on the field.', ''],
  upside: ['Room to grow — youth and the jump the projection expects.',
    'The only component that shares no formula with any other.'],
  situation: ['The team and schedule around him.', ''],
  projection: ['What 2026 projections expect.', 'Percentile within his position.'],

  'vs ADP': ['How far your board rates him above the room.',
    'His ADP rank minus his rank on your board.'],

  'Back?': ['Chance he is still there at your next pick.',
    'Estimated from ADP spread — a guide, not a guarantee.'],

  call: ['Is he worth this pick, to YOU.',
    'Your board rank vs the live pick, and his ADP vs the live pick. Both have to agree for a steal.'],
  wait: ['Whether he comes back to you next turn.',
    'Odds from ADP, plus how many similar players are left.'],

  'card:pass_yd': ['Passing yards in 2025.', ''],
  'card:pass_td': ['Passing touchdowns in 2025.', ''],
  'card:pass_int': ['Interceptions thrown in 2025.', ''],
  'card:gp': ['Games played in 2025.', 'Out of 17.'],
  'card:rush_att': ['Carries in 2025.', ''],
  'card:rec_tgt': ['Times he was thrown at in 2025.', ''],
  'card:rec': ['Catches in 2025.', ''],
  'card:rush_rec_yd': ['Yards from scrimmage.', 'Rushing plus receiving.'],
  'card:anytime_tds': ['Touchdowns scored in 2025.', ''],
  'card:rush_rz_att': ['Carries inside the opponent 20.', 'Where touchdowns come from.'],
  'card:rec_rz_tgt': ['Targets inside the opponent 20.', ''],
  'card:rush_ypa': ['Yards per carry.', 'Rushing yards / carries.'],
  'card:rec_ypt': ['Yards per target.', 'Receiving yards / times thrown at.'],
  'card:ppg': ['PPR points per game.', 'Total points / games played.'],
  'card:finish': ['Where he finished at his position in 2025.', ''],

  Type: ['What kind of pick he is AT THIS PICK. It changes as the draft moves.',
    'Steal = fallen past his range. Reach = too early. Priced right is always Safe or '
    + 'Swing, never a dash. A dash means his range is still a long way off - check Worth.'],
  handcuff: ['He takes over the job if the man ahead of him cannot play.',
    'Worth the points that job is above a waiver-wire replacement, for as long as you have '
    + 'assumed that man is out. Set that under Time missed.'],

  durdial: ['How much time you assume players miss.',
    'Projections are accurate per game and too high per season, and the whole gap is games '
    + 'missed. Nobody knows the right answer, so it is yours to pick.'],

  byeclash: ['This bye week already costs you starters.',
    'Counts only players filling a starting or flex slot, not your bench.'],

  cliff: ['The last player of his tier.',
    'The next one at his position is a clear step down, not a small one. Filter to that '
    + 'position to see the line drawn where the drop actually is.'],

  move: ['How far the board moves without this component.',
    'Measured by rebuilding with it switched off. Small means the other components cover for it.'],

  advice: ['What to do with this pick.',
    'Compares the best man at each position now against the best you could still expect next turn.'],

  addstat: ['Only stats the rating is not currently using.',
    'Built-ins you switched off, plus 2025 fields with no built-in equivalent.'],

  age: ['How old the projections and ADP are.',
    'Rebuilt from Sleeper each morning. Over a week old means the refresh has stopped.'],

  strat: ['A temperament to start from.',
    'Sets trust, need and safe/upside. Never touches position values or stat weights.'],
  lean: ['Whether to favour a position right now.',
    'Read from how deep each position still is, so it changes as the board empties.'],

  posW: ['What this stat counts for at this position.', 'Zero means it says nothing there.'],
};

// True of every stat, so it is appended rather than written out fifty times.
export const PCT_NOTE = 'Ranked 0-100 vs his position.';
