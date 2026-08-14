// Two different kinds of choice, which used to be muddled into one list.
//
// PRESETS are about temperament - what kind of player you want when the value numbers
// cannot separate two men. They are preferences you can hold before the draft starts, so
// they live on the Ratings page as starting points. Each one just sets the four sliders.
//
// LEANS are about position scarcity, which you cannot know in advance. Whether Zero RB is
// right depends entirely on how the board falls on the night. So they are not offered as
// a personality to pick up front - the app watches the board and suggests one when the
// evidence is there, and an advanced user can force one from the board.
//
// "Trust my ratings" used to be a preset. It is gone, because the thing it told you to
// trust measured no better than chance against the projections over five seasons.

export const PRESETS = [
  {
    key: 'balanced',
    name: 'Balanced',
    blurb: 'Best player available, nudged by what you still need.',
    when: 'Hard to go badly wrong. Rarely wins the league on its own.',
    set: { fit: { td: 0, asc: 0, dur: 0, pen: 0 }, need: 8, rookie: true },
  },
  {
    key: 'value',
    name: 'Pure value',
    blurb: 'Ignore roster holes and take the most points above replacement.',
    when: 'Strong early and with deep benches. Can leave you with five backs and no tight end.',
    set: { fit: { td: 0, asc: 0, dur: 0, pen: 0 }, need: 0, rookie: true },
  },
  {
    key: 'upside',
    name: 'Upside hunter',
    blurb: 'Chase the men whose points come in lumps, and the ones being asked to jump.',
    when: 'Good in a big league where a median team wins nothing. Bad in a small one.',
    set: { fit: { td: 70, asc: 60, dur: -40, pen: 0 }, need: 6, rookie: true },
  },
  {
    key: 'floor',
    name: 'Safe floor',
    blurb: 'Steady scorers who were on the field every week.',
    when: 'Good when you just need to make the playoffs. Rarely produces the best team.',
    set: { fit: { td: -60, asc: -50, dur: 80, pen: 40 }, need: 10, rookie: false },
  },
  {
    key: 'clean',
    name: 'No mistakes',
    blurb: 'Avoid the men who fumble and throw interceptions, priced at your league rules.',
    when: 'Worth more the harder your league fines them. Does nothing in a league that does not.',
    set: { fit: { td: -20, asc: 0, dur: 40, pen: 90 }, need: 8, rookie: true },
  },
];
// Position leans. These only ever set position multipliers - never the rating knobs.
export const LEANS = [
  {
    key: 'none', name: 'No lean', blurb: 'Positions valued as the maths finds them.',
    posx: {},
  },
  {
    key: 'zerorb', name: 'Zero RB', blurb: 'Fade backs early, hammer receivers, take backs late.',
    posx: { RB: 0.82, WR: 1.14, TE: 1.05 },
  },
  {
    key: 'herorb', name: 'Hero RB', blurb: 'One elite back, then receivers into the middle rounds.',
    posx: { RB: 0.95, WR: 1.08 },
  },
  {
    key: 'robustrb', name: 'Robust RB', blurb: 'Backs early and often, because they dry up fastest.',
    posx: { RB: 1.14, WR: 0.92 },
  },
];

export function activePreset(st) {
  return PRESETS.find((s) => {
    const a = s.set;
    const fit = st.fit || {};
    return Object.entries(a.fit).every(([k, v]) => (fit[k] || 0) === v)
      && (st.need ?? 8) === a.need
      && !!st.rookie === !!a.rookie;
  })?.key || null;
}

export function activeLean(st) {
  return LEANS.find((l) => {
    const keys = new Set([...Object.keys(l.posx), ...Object.keys(st.posx || {})]);
    for (const k of keys) {
      if (Math.abs((l.posx[k] ?? 1) - (st.posx?.[k] ?? 1)) > 0.001) return false;
    }
    return true;
  })?.key || null;
}

// Should the board be leaning one way right now?
//
// Two earlier attempts measured "depth" directly and both were bad. Counting players
// within a fixed score band found nobody at the top of the board and everybody at the
// bottom. Counting the best remaining tier was scale-free but still meaningless late,
// when a single tier holds thirty interchangeable receivers.
//
// The right question was already being answered elsewhere: cost of waiting. It is not
// "which position is deeper in the abstract" but "which position will still have someone
// comparable when I next pick" - which depends on your slot and on who has gone. So the
// lean is read straight off that, and it only appears once the app knows your draft slot.
export function suggestLean(costs) {
  if (!costs?.length) return null;
  const by = Object.fromEntries(costs.map((c) => [c.pos, c]));
  const rb = by.RB;
  const wr = by.WR;
  if (!rb || !wr) return null;
  const gap = rb.cost - wr.cost;
  const fmt = (c) => `${c.cost.toFixed(0)} points`;
  const both = `Waiting costs you ${fmt(rb)} at running back and ${fmt(wr)} at receiver`;

  // both cheap: nothing is scarce, the lean question is not live yet
  if (rb.cost < 6 && wr.cost < 6) {
    return { key: 'none', why: `${both}. Neither is scarce enough to change how you draft.` };
  }
  if (gap >= 8) {
    return { key: 'robustrb',
      why: `${both}. Backs are the ones that will not come back to you.` };
  }
  if (gap <= -8) {
    return { key: 'zerorb',
      why: `${both}. Receivers are the scarce thing right now, so backs can wait.` };
  }
  return { key: 'none', why: `${both}. Close enough that you should just take the better player.` };
}
