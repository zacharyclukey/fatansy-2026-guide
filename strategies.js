// Draft strategies as presets.
//
// Each one sets the same handful of knobs you could set yourself - it is a shortcut and a
// short explanation, not a separate engine. `posx` is a per-position multiplier on the
// draft score, so 1.10 means "treat every receiver as 10% more valuable than the maths
// says", which is exactly what committing to a strategy means in practice.
//
// `when` is the honest part: every one of these is wrong in some rooms.

export const STRATEGIES = [
  {
    key: 'balanced',
    name: 'Balanced',
    blurb: 'Take the best player available, nudged by what you still need.',
    when: 'The default. Hard to go badly wrong, rarely wins the league on its own.',
    set: { posx: {}, tilt: 0.5, need: 8, style: 50, rookie: true },
  },
  {
    key: 'value',
    name: 'Pure value',
    blurb: 'Ignore roster needs entirely and take the most points above replacement.',
    when: 'Best in deep benches and early rounds. Can leave you with five backs and no tight end.',
    set: { posx: {}, tilt: 0.2, need: 0, style: 50, rookie: true },
  },
  {
    key: 'zerorb',
    name: 'Zero RB',
    blurb: 'Fade running backs early, hammer receivers, take backs late and often.',
    when: 'Works in full PPR with deep flex, where receivers score like backs. Fragile if your late backs never get work.',
    set: { posx: { RB: 0.82, WR: 1.14, TE: 1.05 }, tilt: 0.5, need: 4, style: 65, rookie: true },
  },
  {
    key: 'herorb',
    name: 'Hero RB',
    blurb: 'One elite back early, then receivers until the middle rounds.',
    when: 'A middle path — you get the positional edge of an elite back without betting the draft on backs.',
    set: { posx: { RB: 0.95, WR: 1.08 }, tilt: 0.5, need: 6, style: 55, rookie: true },
  },
  {
    key: 'robustrb',
    name: 'Robust RB',
    blurb: 'Backs early and often, because the position dries up fastest.',
    when: 'Strongest in standard or half-PPR, and in shallow leagues. In full PPR you are paying up for scarcity that is smaller than it looks.',
    set: { posx: { RB: 1.14, WR: 0.92 }, tilt: 0.5, need: 10, style: 40, rookie: true },
  },
  {
    key: 'upside',
    name: 'Upside hunter',
    blurb: 'Chase ceilings and rookies. Accept busts as the cost of league winners.',
    when: 'Good in a big league where a median team wins nothing. Bad in a small one where consistency takes the title.',
    set: { posx: {}, tilt: 0.7, need: 6, style: 90, rookie: true },
  },
  {
    key: 'floor',
    name: 'Safe floor',
    blurb: 'Locked-in roles and players who never miss games.',
    when: 'Good when your league is shallow and you just need to make the playoffs. Rarely produces the top team.',
    set: { posx: {}, tilt: 0.6, need: 10, style: 10, rookie: false },
  },
];

// Which preset the current settings match, if any - so the UI can show what you are on
// and stop claiming a strategy after you have edited away from it.
export function activeStrategy(st) {
  return STRATEGIES.find((s) => {
    const a = s.set;
    if (Math.abs((st.tilt ?? 0.5) - a.tilt) > 0.01) return false;
    if ((st.need ?? 8) !== a.need) return false;
    if ((st.style ?? 50) !== a.style) return false;
    if (!!st.rookie !== !!a.rookie) return false;
    const keys = new Set([...Object.keys(a.posx), ...Object.keys(st.posx || {})]);
    for (const k of keys) {
      if (Math.abs((a.posx[k] ?? 1) - (st.posx?.[k] ?? 1)) > 0.001) return false;
    }
    return true;
  })?.key || null;
}
