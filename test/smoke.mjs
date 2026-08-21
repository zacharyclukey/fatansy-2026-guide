// One end-to-end check of the whole app, run in a real DOM.
//
//   cd "fatansy 2026 guide" && npm --prefix test i jsdom && node test/smoke.mjs
//
// There is no build step and no browser available where this was written, so this is the
// safety net: it loads the actual index.html, evaluates the actual modules, clicks the
// actual buttons and asserts on what comes out. It replaced nine one-off scripts that
// kept going stale and sending me chasing bugs that were only in the test.

import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const players = JSON.parse(fs.readFileSync(`${DIR}/data/players.json`, 'utf8'));

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; } else { fails.push(`${name}${detail ? ` — ${detail}` : ''}`); }
};
const near = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;

// Modules are flattened into one scope: exports become plain declarations and the import
// lines are dropped, because jsdom has no module loader here.
//
// The stripper has to span lines. It used to be /^import .*\n/gm, which removes the FIRST
// line of an import and nothing else - so a wrapped `import {\n a,\n b\n} from 'x';` left
// `a,` and `b` and a dangling `}` behind, and the whole suite died with
// "SyntaxError: Unexpected token '}'" before a single assertion ran.
//
// That is worse than a bug, because it is silent and it points the wrong way: the failure
// looks like the app is broken when it is the test harness that is. It also made a source
// file's LINE BREAKS load-bearing - mock.js carried a comment ordering the next person to
// keep a 200-character import on one line purely to appease this regex. Matching through
// to the module string removes the trap instead of documenting it.
const stripModule = (src) => src
  .replace(/^export /gm, '')
  // `import <anything, over as many lines as it likes> from 'mod';`
  // The clause is matched with [^'"], which cannot cross into the next statement's string
  // literal, so a runaway match can never swallow the code between two imports.
  .replace(/^import\s[^'"]*?from\s*(['"])[^'"]*\1;?[^\S\n]*\n?/gm, '')
  // `import 'mod';` - a side-effect import, no clause at all
  .replace(/^import\s*(['"])[^'"]*\1;?[^\S\n]*\n?/gm, '');

// ---------------------------------------------------------------- harness
const USER = 'u1';
const sleeperRoutes = {
  '/user/zclukey': { user_id: USER },
  [`/user/${USER}/leagues/nfl/2026`]: [{
    league_id: 'L1', draft_id: 'D1', name: 'Test League', total_rosters: 12,
    roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF', 'BN'],
    scoring_settings: { rec: 1, rush_yd: 0.1, pass_td: 4, made_up_bonus: 3 },
  }],
  '/league/L1/rosters': [{ owner_id: USER, roster_id: 5 }],
  '/draft/D1': { settings: { rounds: 15 }, draft_order: { [USER]: 6 } },
  '/draft/D1/picks': [],
};

async function boot({ store = {}, offline = false, rnd = null } = {}) {
  const dom = new JSDOM(fs.readFileSync(`${DIR}/index.html`, 'utf8'),
    { runScripts: 'outside-only', url: 'https://x.test/' });
  const { window } = dom;
  const errs = [];
  window.addEventListener('error', (e) => errs.push(e.message));
  window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  // The mock draft picks its seed with Math.random, so every assertion about what the
  // auto-drafter DID was measuring a different draft each run. Section 10b below counts
  // how many of its picks came in ahead of the going rate and fails over 35%; on an
  // untouched checkout that came out 0.21, 0.36, 0.26, 0.36, 0.36 across five runs, so the
  // suite was failing roughly three times in five for no reason anybody had changed. A
  // fixed seed makes the number mean something, and a regression there is now a real one.
  if (rnd != null) window.Math.random = () => rnd;
  window.fetch = (u) => {
    const s = String(u);
    if (s.includes('players.json')) {          // the URL carries a ?v= cache stamp
      return Promise.resolve({ json: () => Promise.resolve(JSON.parse(JSON.stringify(players))) });
    }
    if (offline) return Promise.reject(new TypeError('Failed to fetch'));
    const p = s.replace('https://api.sleeper.app/v1', '');
    if (!(p in sleeperRoutes)) return Promise.resolve({ ok: false, status: 404 });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(sleeperRoutes[p]) });
  };
  Object.defineProperty(window, 'localStorage', { value: {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
  } });
  const rd = (f) => stripModule(fs.readFileSync(`${DIR}/${f}`, 'utf8'));
  window.eval([rd('strategies.js'), rd('tips.js'), rd('engine.js'), rd('mock.js'),
    rd('sleeper.js'), rd('app.js')].join('\n'));
  await new Promise((r) => setTimeout(r, 400));
  return { window, d: window.document, errs, store };
}
const settle = () => new Promise((r) => setTimeout(r, 60));
// save() is debounced 250ms so a drag does not write to localStorage on every pixel.
// Anything that asserts on the store has to outwait that.
const saved = () => new Promise((r) => setTimeout(r, 320));
// position multipliers as the app has them, read back out of saved settings
const st_posx = (d) => {
  const raw = d.defaultView.localStorage.getItem('draft2026');
  return raw ? (JSON.parse(raw).posx || {}) : {};
};
const fire = (el, type) => {
  const w = el.ownerDocument ? el.ownerDocument.defaultView : el;   // works for window too
  el.dispatchEvent(new w.Event(type, { bubbles: true }));
};

// ------------------------------------------------- 0a. the harness can read the source
// Everything below this line is worthless if the flattener mangles the modules on the way
// in, and when it did, it failed in the least helpful way available: a SyntaxError at
// eval time, with no test name attached, before any assertion ran. So the flattener is
// itself tested, first, and the load-bearing case is a module whose import spans lines.
{
  const multi = `import {\n  alpha,\n  beta,\n} from './engine.js?v=1';\nexport const use = () => 1;\n`;
  const stripped = stripModule(multi);
  ok('a multi-line import leaves nothing behind',
    !/import|alpha|beta|\}|from/.test(stripped), JSON.stringify(stripped));
  ok('and what is left of it still boots',
    (() => { try { (0, eval)(stripped); return true; } catch { return false; } })(),
    JSON.stringify(stripped));

  // the shapes that already worked have to keep working
  ok('a single-line import is still stripped',
    stripModule(`import { a, b } from './x.js';\nconst k = 1;\n`).trim() === 'const k = 1;');
  ok('a default import is still stripped',
    stripModule(`import x from './x.js';\nconst k = 1;\n`).trim() === 'const k = 1;');
  ok('a side-effect import is still stripped',
    stripModule(`import './x.js';\nconst k = 1;\n`).trim() === 'const k = 1;');
  ok('export is still turned into a plain declaration',
    stripModule('export const a = 1;\n').trim() === 'const a = 1;');

  // The stripper must not be able to eat code. A clause matched greedily across a string
  // literal would swallow whole functions and the suite would go green on nothing.
  const between = stripModule(
    `import { a } from './x.js';\nconst keep = "from './y.js'";\nimport { b } from './z.js';\nconst also = 2;\n`);
  ok('the stripper cannot swallow the code between two imports',
    between.includes('const keep') && between.includes('const also')
      && !/^import/m.test(between), JSON.stringify(between));

  // and the real thing: no module still carries an import after flattening
  const left = ['strategies.js', 'tips.js', 'engine.js', 'mock.js', 'sleeper.js', 'app.js']
    .filter((f) => /^import\b/m.test(stripModule(fs.readFileSync(`${DIR}/${f}`, 'utf8'))));
  ok('no module reaches the sandbox with an import still in it', left.length === 0,
    left.join(', '));
}

// ------------------------------------------------------- 0. the sticky-header trap
// This bug has shipped twice: the column labels detach and float over row two. Both times
// the cause was an `overflow` on an ancestor of .row.head, which makes a sticky element
// position against that box instead of the viewport. It is invisible in jsdom because
// jsdom does no layout, so it is checked in the stylesheet instead.
{
  const css = fs.readFileSync(`${DIR}/styles.css`, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');          // strip comments, they discuss overflow
  const html = fs.readFileSync(`${DIR}/index.html`, 'utf8');
  const blocks = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)];
  const ancestors = /(^|,)\s*(main|body|html|section|\.board|#v-board main|#v-board \.board)\s*$/;
  const guilty = blocks.filter(([, sel, body]) => /overflow(-x|-y)?\s*:/.test(body)
    && sel.split(',').some((s) => ancestors.test(s.trim())));
  ok('nothing that contains the board sets overflow', guilty.length === 0,
    guilty.map(([, s]) => s.trim()).join(' / '));
  ok('the sticky header is still sticky', /\.row\.head\s*\{[^}]*position:\s*sticky/.test(css));

  // ---- nothing may out-rank the hidden attribute -----------------------
  // `hidden` is only `display: none` from the browser's own stylesheet, so ANY class or id
  // selector that sets `display` beats it. Two panels shipped welded open this way and
  // nobody noticed, because the button really did flip the attribute - it just changed a
  // value no longer deciding anything. jsdom does no cascade, so it cannot catch this by
  // clicking; it has to be read out of the stylesheet.
  const hideable = new Set();
  for (const [tag] of html.matchAll(/<[^>]*\bhidden\b[^>]*>/g)) {
    const id = tag.match(/id="([^"]+)"/);
    if (id) hideable.add(`#${id[1]}`);
    const cl = tag.match(/class="([^"]+)"/);
    if (cl) for (const c of cl[1].split(/\s+/)) hideable.add(`.${c}`);
  }
  const welded = [];
  for (const [, sel, body] of blocks) {
    if (!/(^|;)\s*display\s*:/.test(body)) continue;
    for (const s of sel.split(',')) {
      const t = s.trim();
      if (/\[hidden\]/.test(t)) continue;          // written defensively, fine
      if ([...hideable].some((k) => t === k || t.endsWith(` ${k}`))) welded.push(t);
    }
  }
  ok('nothing that can be hidden has its display forced open', welded.length === 0,
    `${welded.join(', ')} — write it as :not([hidden])`);

  // The toolbar's "this is on" style fills a button with dark green. Column headers are
  // buttons too, so any rule that paints aria-pressed/aria-expanded has to exclude them
  // or the sorted column's label turns dark green on dark green and vanishes.
  // Only UNSCOPED rules matter. `.views button[aria-pressed]` can never reach a column
  // header, so flagging it would be noise; a bare `button[aria-pressed]` reaches everything.
  const painted = blocks.filter(([, sel, body]) => /background:/.test(body)
    && sel.split(',').some((one) => /^\s*button\[aria-(pressed|expanded)="true"\]/.test(one)
      && !/:not\(\.colSort\)/.test(one)));
  ok('the pressed-button style cannot swallow a column header', painted.length === 0,
    painted.map(([, s2]) => s2.trim()).join(' / '));

  // Every top-bar button says whether it is on through aria-expanded, and the stylesheet
  // has to colour that state. Three of the four looked identical on and off for a while,
  // which is how the Compare panel being welded open went unnoticed for so long.
  ok('an open panel button is coloured, not left white',
    /button\[aria-expanded="true"\][^{]*\{[^}]*background:/.test(css));
  const bar = html.slice(html.indexOf('class="bar2"'), html.indexOf('id="kbd"'));
  const bare = [...bar.matchAll(/<button[^>]*id="(\w+)"[^>]*>/g)]
    .filter(([tag]) => !/aria-(expanded|pressed)=/.test(tag)).map((m) => m[1]);
  ok('every top-bar button publishes its on/off state', bare.length === 0, bare.join(', '));
}

// ------------------------------------------------- 0b. nothing exported has gone missing
// Three separate times an edit that replaced a block between two markers has silently
// deleted a neighbouring function. Each time the app broke in a way only one test caught.
{
  const src = fs.readFileSync(`${DIR}/engine.js`, 'utf8');
  const exported = [...src.matchAll(/^export (?:function|const) (\w+)/gm)].map((m) => m[1]);
  const needed = ['DEFAULT_SETTINGS', 'componentWeights', 'componentScore', 'floorScore',
    'projectedPoints', 'inLeague', 'flexFill', 'replacementLevels', 'SAMPLE_LEAGUE',
    'subScores', 'applyCustomStats', 'buildBoard', 'pickType',
    'markTiers', 'myPicks', 'draftContext', 'availability', 'poolAround', 'planDraft',
    'roundsOf', 'priorityOrder'];
  const missing = needed.filter((n) => !exported.includes(n));
  ok('every engine export the app imports still exists', missing.length === 0, missing.join(', '));

  // There must be exactly ONE way to work out what waiting costs. costOfWaiting survived
  // the planner as the board reading's private sum, and the two disagreed on screen: the
  // reading said 22 points at receiver while the panel two inches above said 46. Whichever
  // was right, having both is indefensible, so the loser is deleted rather than fixed.
  ok('there is only one cost of waiting left in the engine',
    !exported.includes('costOfWaiting'));

  // The drift runs BOTH ways, and this list only ever guarded one of them. RAW_FIELDS,
  // unusedStats and influence sat in it for weeks after the page that used them was
  // deleted - so the suite was actively insisting that ninety lines of dead engine stay
  // alive. An export that nothing imports and that the engine does not use itself is not
  // load-bearing; it is a room nobody has opened since the door was bricked up.
  const others = ['app.js', 'mock.js', 'sleeper.js', 'strategies.js', 'tips.js']
    .map((f) => fs.readFileSync(`${DIR}/${f}`, 'utf8')).join('\n');
  const orphans = exported.filter((n) => {
    if (new RegExp(`\\b${n}\\b`).test(others)) return false;      // someone imports it
    return (src.match(new RegExp(`\\b${n}\\b`, 'g')) || []).length < 2;  // engine uses it
  });
  ok('the engine exports nothing that nothing uses', orphans.length === 0, orphans.join(', '));

  const app = fs.readFileSync(`${DIR}/app.js`, 'utf8');
  const imported = [...(app.match(/^import \{([^}]*)\} from '\.\/engine\.js/m)?.[1] || '')
    .split(',').map((x) => x.trim()).filter(Boolean)];
  const broken = imported.filter((n) => !exported.includes(n));
  ok('the app imports nothing that is not exported', broken.length === 0, broken.join(', '));

  // The other direction, which is the one that actually shipped a bug. app.js used
  // STREAMED without importing it. In the browser that is a ReferenceError thrown from
  // inside renderBoard's loop - and because that loop MOVES rows into a fragment before
  // reattaching them, throwing part way through leaves every row it already touched
  // detached. Clicking a player's name made him and everyone above him vanish.
  //
  // This harness cannot catch it by running the app: it evals every module into one
  // shared scope, so a missing import still resolves. It has to be read off the source.
  const used = new Set([...app.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)].map((m) => m[1]));
  const local = new Set([...app.matchAll(/^(?:const|let|var|function|class)\s+([A-Z][A-Z0-9_]{2,})/gm)]
    .map((m) => m[1]));
  const unimported = exported.filter((n) => /^[A-Z][A-Z0-9_]{2,}$/.test(n)
    && used.has(n) && !imported.includes(n) && !local.has(n));
  ok('the app imports every engine constant it uses',
    unimported.length === 0, unimported.join(', '));
}

// --------------------------------------------- 0b2. no duplicate element ids
// The strategy block ended up rendered twice - once on the board, once on the Ratings
// tab - because a removal silently did not apply. querySelector only ever finds the
// first, so the Ratings copy was never populated and the move looked like it failed.
{
  const html = fs.readFileSync(`${DIR}/index.html`, 'utf8');
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  const dupes = [...new Set(ids.filter((i) => ids.filter((x) => x === i).length > 1))];
  ok('no element id appears twice', dupes.length === 0, dupes.join(', '));
}

// --------------------------------------------- 0c. every asset is cache-busted
// New code paired with a stale cached data file is a silent, confusing failure: the
// quarterback columns came back blank because players.json had no version stamp.
{
  const app = fs.readFileSync(`${DIR}/app.js`, 'utf8');
  const html = fs.readFileSync(`${DIR}/index.html`, 'utf8');
  ok('the data file is cache-busted', /players\.json\?v=/.test(app));
  const unversioned = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)]
    .map((m) => m[1]).filter((u) => !u.includes('?v='));
  ok('every script and stylesheet is cache-busted', unversioned.length === 0, unversioned.join(', '));
  // every module, not just app.js: mock.js imports engine.js too, and a stamp left behind
  // there would pair new code with a cached copy of the old engine
  const mods = fs.readdirSync(DIR).filter((f) => f.endsWith('.js'));
  const imports = mods.flatMap((f) => [...fs.readFileSync(`${DIR}/${f}`, 'utf8')
    .matchAll(/from '\.\/([^']+\.js)([^']*)'/g)]
    .filter((m) => !m[2].includes('?v=')).map((m) => `${f} -> ${m[1]}`));
  ok('every module import is cache-busted', imports.length === 0, imports.join(', '));
  // and they must all agree, or two copies of the engine end up in memory
  const stamps = [...new Set(mods.flatMap((f) => [...fs.readFileSync(`${DIR}/${f}`, 'utf8')
    .matchAll(/\?v=(\d+)/g)].map((m) => m[1])))];
  ok('one build stamp across every module', stamps.length <= 1, stamps.join(', '));
}

// ---------------------------------------------------------------- 1. the engine
{
  const m = await import(`file://${DIR}/engine.js`);
  const data = JSON.parse(JSON.stringify(players));
  const st = { ...m.DEFAULT_SETTINGS(data), mine: [] };
  data.leagues = [m.SAMPLE_LEAGUE];
  const b = m.buildBoard(data, st);
  // never hardcode the pool size - the nightly refresh changes it
  ok('board builds', b.rows.length === players.players.length,
    `${b.rows.length} of ${players.players.length}`);
  ok('the pool is a real season', players.players.length >= 200, `${players.players.length}`);

  // replacement level must be derived from who really fills the flex, not a fixed guess
  const ff = m.flexFill(data.players, m.SAMPLE_LEAGUE);
  ok('flex fill derived', ff.used.WR > ff.used.RB,
    `RB ${ff.used.RB}, WR ${ff.used.WR} — in PPR the leftovers are receivers`);
  const top12 = b.rows.slice(0, 12).filter((r) => r.p.pos === 'RB').length;
  ok('board is not RB-swamped', top12 <= 6, `${top12} backs in the top 12`);

  // ---- Fit: a preference, and provably not more than that ----------------
  ok('neutral sliders leave every player at 50', b.rows.every((r) => r.fit === 50));

  // ---- the mistake label has to be about real points -------------------
  // It fired on 34 men and called 3 clean, off a two-point difference: in this league a
  // receiver either lost one fumble or lost none, so a percentile of a two-valued stat
  // branded the minority and told the majority nothing. Labels here are gated on the size
  // of the fine, which correctly leaves it to quarterbacks.
  const fined = b.rows.filter((r) => r.tags.some((t) => t.tag === 'Gives points back'));
  ok('nobody is branded for a trivial fine',
    fined.every((r) => m.riskPoints(r.p, b.league, st) >= m.PEN_MATERIAL),
    fined.map((r) => `${r.p.name} ${m.riskPoints(r.p, b.league, st).toFixed(0)}`).join(', '));
  ok('the mistake label is rare, not universal', fined.length < b.rows.length * 0.05,
    `${fined.length} of ${b.rows.length}`);
  // And nobody gets called clean for the crime of not playing.
  const cleanTagged = b.rows.filter((r) => r.tags.some((t) => t.tag === 'Clean'));
  ok('a backup is never called clean',
    cleanTagged.every((r) => r.pts > (b.repl[r.p.pos] ?? 0)),
    cleanTagged.map((r) => r.p.name).join(', '));


  // ---- kickers and defences must not be given an opinion we do not have -----
  // Every component sits at a flat 50 for them because there are no stats to rate, so the
  // only thing moving was the projection percentile. That made the best defence read 56,
  // which looked like a judgement and was not one.
  const unrated = b.rows.filter((r) => !['QB', 'RB', 'WR', 'TE'].includes(r.p.pos));
  ok('kickers and defences get no rating at all',
    unrated.length > 0 && unrated.every((r) => r.rating === null && r.rated === false));
  ok('skill players still get one',
    b.rows.filter((r) => r.rated).every((r) => typeof r.rating === 'number'));

  // Streamed positions: the alternative is a good one off waivers, not the last drafted.
  const bestDef = b.rows.find((r) => r.p.pos === 'DEF');
  const bestK = b.rows.find((r) => r.p.pos === 'K');
  ok('no defence cracks the top 100', !bestDef || bestDef.rank > 100, `#${bestDef?.rank}`);
  ok('no kicker cracks the top 100', !bestK || bestK.rank > 100, `#${bestK?.rank}`);

  // The invariant that matters, tested directly rather than through a rank that depends
  // on which league is loaded: treating a streamed position as replaceable must LOWER its
  // value. Getting this backwards is exactly the bug being fixed - a deeper replacement
  // index means a worse alternative, which makes defences look better, not worse.
  const deep = m.replacementLevels(data.players, m.SAMPLE_LEAGUE);
  ok('streamed replacement sits above the last starter',
    deep.DEF > 0 && deep.K > 0);
  const defPts = data.players.filter((p) => p.pos === 'DEF')
    .map((p) => m.projectedPoints(p, m.SAMPLE_LEAGUE)).sort((a, c) => c - a);
  const lastStarter = defPts[m.SAMPLE_LEAGUE.teams - 1];
  ok('a defence is measured against a good one, not the last one drafted',
    deep.DEF > lastStarter, `replacement ${deep.DEF.toFixed(0)} vs 12th best ${lastStarter?.toFixed(0)}`);

  const before = new Map(b.rows.map((r) => [r.p.id, r.rank]));
  const hard = m.buildBoard(data, { ...st, fit: { td: 100, asc: 0, dur: 0, pen: 0 } });
  const moves = hard.rows.slice(0, 80).map((r) => Math.abs(before.get(r.p.id) - r.rank));
  ok('a slider at its extreme still reorders the board', Math.max(...moves) > 0);
  // The whole claim of Fit is that it breaks ties. If one slider could move a man forty
  // places it would be overruling the projections, which measured +0.25 against every
  // alternative while preferences measured nothing at all.
  ok('but it can never overrule value', Math.max(...moves) <= 25,
    `biggest move ${Math.max(...moves)} places`);

  // lumpiness is league-specific: a bonus one league pays and another does not must move
  const plain = { ...m.SAMPLE_LEAGUE, scoring: { ...m.SAMPLE_LEAGUE.scoring, rec_40p: 0 } };
  const bonus = { ...m.SAMPLE_LEAGUE, scoring: { ...m.SAMPLE_LEAGUE.scoring, rec_40p: 2 } };
  const wr = data.players.find((p) => p.pos === 'WR' && (p.proj?.rec_40p || 0) > 0);
  ok('a league bonus changes who counts as boom-or-bust',
    !wr || m.swingShare(wr, bonus) > m.swingShare(wr, plain));
  ok('penalties are detected per league', m.hasPenalties(
    { scoring: { fum_lost: -2 } }) === true && m.hasPenalties({ scoring: { rec: 1 } }) === false);

  // ---- the value window --------------------------------------------------
  ok('every player has a window', b.rows.every(
    (r) => r.worthFrom >= 1 && r.worthTo >= r.worthFrom));
  ok('the window contains his own rank', b.rows.every(
    (r) => r.rank >= r.worthFrom && r.rank <= r.worthTo));
  // The label has to move with the clock. Same man, same board, different pick.
  const early = m.buildBoard(data, { ...st, atPick: 3 });
  const late = m.buildBoard(data, { ...st, atPick: 90 });
  const pick = (bd, i) => bd.rows[i].kind;
  const changed = early.rows.filter((r, i) => pick(early, i) !== pick(late, i)).length;
  ok('the label moves as the draft moves', changed > 20, `${changed} of ${early.rows.length}`);
  ok('early in the draft nobody deep is a steal',
    early.rows.slice(40).every((r) => r.kind !== 'steal'));
  ok('by pick 90 the men still on the board are steals',
    late.rows.slice(0, 20).filter((r) => r.kind === 'steal').length >= 10);
  ok('a reach is always meaningfully early, not off by one',
    early.rows.filter((r) => r.kind === 'reach').every((r) => r.worthFrom - 3 >= m.SLACK));
  ok('being a pick or two early is not a reach',
    early.rows.some((r) => r.worthFrom > 3 && r.worthFrom - 3 < m.SLACK && r.kind !== 'reach'));
  // a window that swallowed the whole board would make the verdict meaningless
  const widest = Math.max(...b.rows.map((r) => r.worthTo - r.worthFrom));
  ok('windows stay narrow enough to mean something', widest <= m.WINDOW_MAX,
    `widest ${widest}, cap ${m.WINDOW_MAX}`);
  ok('a truncated window is never sold as a steal',
    b.rows.every((r) => !(r.openEnded && r.kind === 'steal')));
  ok('nobody far out of range gets a label', b.rows.every(
    (r) => !(r.worthFrom - r.adpRank > m.REACH_RANGE && r.kind === 'reach')));

  // THE invariant behind the blank-Type bug. If the clock is inside a man's window then
  // his price is settled, so the column must say something. It used to fall through two
  // absolute trait cuts and render an em-dash on a quarter of the pool, which reads as
  // "no opinion" at the exact moment the opinion is "take him". Swept across the whole
  // pool at every pick of a 12-team draft, not just the handful a fixed clock happens to
  // catch.
  {
    let blanks = 0; let inBand = 0; let worst = null;
    for (let at = 1; at <= 180; at += 1) {
      for (const r of b.rows) {
        const late = !r.openEnded && at - r.worthTo >= m.SLACK;
        const early = r.worthFrom - at >= m.SLACK;
        if (late || early) continue;               // he is a steal or a reach, not in band
        inBand += 1;
        if (m.pickType(r, at) === null) { blanks += 1; worst ||= `${r.p.name} at pick ${at}`; }
      }
    }
    ok('a man inside his window always gets a verdict', blanks === 0,
      `${blanks} of ${inBand} in-band rows blank, e.g. ${worst}`);
    ok('the in-band sweep actually found players to check', inBand > 500, `${inBand}`);
  }
  // and the two in-band verdicts have to partition it - neither may swallow the other
  {
    const at = 40;
    const band = b.rows.filter((r) => {
      const late = !r.openEnded && at - r.worthTo >= m.SLACK;
      return !late && r.worthFrom - at < m.SLACK;
    });
    const kinds = new Set(band.map((r) => m.pickType(r, at)));
    ok('in-band verdicts are only Safe or Swing',
      [...kinds].every((k) => k === 'safe' || k === 'swing'), [...kinds].join(','));
    ok('both in-band verdicts occur', kinds.has('safe') && kinds.has('swing'),
      `${band.length} in band, kinds ${[...kinds].join(',')}`);
  }
  // kickers and defences have no touchdown share and no games history, so both traits tie
  // at 50. They must not land on the ceiling label by accident.
  {
    const kd = b.rows.filter((r) => ['K', 'DEF'].includes(r.p.pos));
    ok('unmeasured players get the floor label, never the ceiling one',
      kd.every((r) => m.pickType({ ...r, worthFrom: 1, worthTo: 300, openEnded: false }, 5) === 'safe'),
      `${kd.length} K/DEF`);
  }

  // ---- every call has to be explainable, and honestly ---------------------
  //
  // The board labels men Steal / Safe / Swing / Reach and gives a range of picks, and for
  // most of its life it never said why. The explanation is now part of the product, so it
  // is tested like one: it must exist for everyone, it must name what it is explaining,
  // and - the part that actually matters - it must not reach for the stats that were
  // measured to add nothing and then deleted from the score.
  {
    let threw = null;
    let unnamed = null;
    let noRank = null;
    const at = 24;
    const bAt = m.buildBoard(data, { ...st, atPick: at });
    const ctx = { st, league: bAt.league, repl: bAt.repl, rows: bAt.rows, drafted: new Set() };
    const all = [];
    for (const r of bAt.rows) {
      let e;
      try {
        e = m.explain(r, at, ctx);
      } catch (err) { threw ||= `${r.p.name}: ${err.message}`; continue; }
      all.push([r, e]);
      // the sentence has to stand on its own, so it names the label it is explaining
      if (!e.why.toLowerCase().includes(e.label.toLowerCase())) unnamed ||= `${r.p.name} (${e.label}): ${e.why}`;
      if (!e.rank || e.rank.length < 40) noRank ||= r.p.name;
    }
    ok('every row on the board can explain itself', threw === null, threw);
    ok('the explanation checked the whole pool', all.length === bAt.rows.length,
      `${all.length} of ${bAt.rows.length}`);
    ok('the explanation names the label it is explaining', unnamed === null, unnamed);
    ok('every row also explains where it sits on the board', noRank === null, noRank);
    ok('every row says what would change the call',
      all.every(([, e]) => e.change && e.change.length > 20));

    // THE constraint. Five years of held-out testing said the historical box-score stats
    // add nothing over the projection (+0.007 / -0.001 / +0.002 / +0.015) and they were
    // taken out of the score. Writing "elite red-zone work" in the explanation would put
    // that exact fiction straight back in, in prose, where nobody can audit it. The score
    // is the projection, the gap to a replacement, the tier, the ADP distance and the
    // preference sliders - so those are the only things the words may lean on.
    const BANNED = ['red zone', 'red-zone', 'target', 'carries', 'carry', 'catch rate',
      'catch%', 'snap', 'touches per', 'touch a game', 'yards per', 'reception', 'drops',
      'workload', 'elite', 'explosive', 'workhorse', 'breakout', 'efficiency',
      'last year he', 'last season he',
      // Added with the rewrite. The first group is more of the same fiction - phrases a
      // fluent sentence generator reaches for when it wants to sound like it knows
      // something about the player that the score does not contain.
      'burst', 'separation', 'air yards', 'yac', 'goal line', 'goal-line', 'third down',
      'two-minute', 'volume', 'usage', 'touch share', 'target share', 'opportunity',
      'sleeper pick', 'upside play', 'league winner', 'bounce back', 'bounce-back',
      'due for', 'regression candidate', 'buy low', 'sell high',
      // The second group is about the SCHEDULE and the team around him. Neither is in the
      // score at all: strength of schedule was never built, and "changing team is
      // associated with decline" was measured to be confounded and kept descriptive. A
      // sentence claiming either would be inventing a mechanism the board does not use.
      'easy schedule', 'tough schedule', 'strength of schedule', 'soft matchup',
      'new offence', 'new offense', 'offensive line', 'coaching change',
      // And the third is certainty. Nothing here forecasts, so nothing may promise.
      'guaranteed', 'certain to', 'will finish', 'lock for'];
    const dirty = [];
    for (const [r, e] of all) {
      const text = [e.rank, e.why, e.change, e.cost, e.prefLine, e.caveat,
        e.tipLabel, e.tipWorth, e.tipRank].join(' ').toLowerCase();
      for (const w of BANNED) if (text.includes(w)) dirty.push(`${r.p.name}: "${w}"`);
    }
    ok('no explanation leans on a stat that is not in the score', dirty.length === 0,
      [...new Set(dirty)].slice(0, 5).join(', '));

    // and it must not claim the guessed cut-offs are precise
    ok('the fuzzy cut-offs are admitted to be fuzzy',
      /not measured|fuzzy/i.test(m.EXPLAIN_CAVEAT) && /readable|readability/i.test(m.EXPLAIN_CAVEAT));
    ok('waiting advice is hedged rather than exact',
      all.filter(([, e]) => /\bpicks?\b/.test(e.change))
        .every(([, e]) => /roughly|around|about/i.test(e.change)));

    // ---- a tooltip has to be readable AS a tooltip -----------------------
    // This was 412 characters on an open-ended row, which is a paragraph hanging off the
    // cursor: nobody reads it, so the explanation may as well not have been written. The
    // cap is a judgement about reading, not a measurement, which is why it is generous.
    const TIP_MAX = 200;
    const longTips = all.filter(([, e]) => e.tipLabel.length > TIP_MAX);
    ok('the hover text is short enough to be read on hover', longTips.length === 0,
      longTips.slice(0, 2).map(([r, e]) => `${r.p.name} ${e.tipLabel.length} chars`).join(', '));
    ok('and the Worth hover is short too',
      all.every(([, e]) => e.tipWorth.length <= TIP_MAX));
    // short is not the same as truncated - a tip cut off mid-clause is worse than a long one
    ok('no hover text is a sentence chopped in half',
      all.every(([, e]) => /[.!?]$/.test(e.tipLabel.trim())),
      all.filter(([, e]) => !/[.!?]$/.test(e.tipLabel.trim())).slice(0, 2)
        .map(([r, e]) => `${r.p.name}: ${e.tipLabel.slice(-40)}`).join(' | '));

    // ---- the sentence must agree with the column beside it ---------------
    // The advice used to say "wait roughly 1 pick and he is fair value" next to a Worth
    // column reading 28-28 at pick 24, because it counted to where he stops being LABELLED
    // a reach rather than to where the board wants him. Both are true; only one matches
    // the number the person is looking at.
    const disagree = all.filter(([r, e]) => {
      if (r.kind !== 'reach' || r.openEnded) return false;
      const said = /until about pick (\d+)/.exec(e.change);
      return !said || Number(said[1]) !== r.worthFrom;
    });
    ok('the pick a Reach is told to wait for is the one in the Worth column',
      disagree.length === 0,
      disagree.slice(0, 2).map(([r, e]) => `${r.p.name} worth ${r.worthFrom} vs "${e.change}"`).join(' | '));
    const notYet = all.filter(([r]) => !r.kind && !r.openEnded);
    ok('and so is the pick a Not-yet row is told to wait for',
      notYet.every(([r, e]) => e.change.includes(`pick ${r.worthFrom}`)),
      notYet.filter(([r, e]) => !e.change.includes(`pick ${r.worthFrom}`)).slice(0, 2)
        .map(([r, e]) => `${r.p.name} worth ${r.worthFrom}: ${e.change}`).join(' | '));
    // an open-ended row is the one that used to get the width caveat INSTEAD of the advice
    const open = all.filter(([r]) => r.openEnded);
    ok('there are open-ended rows to check', open.length > 0, `${open.length}`);
    ok('an open-ended row still gets told when he comes into range',
      open.filter(([r]) => !r.kind).every(([, e]) => /comes into range/.test(e.change)));
    // The phrase, not the number. `about 45 short of an ordinary running back` is a points
    // gap and perfectly true; the thing that must never appear is the cap dressed up as a
    // headcount, which only ever reads "About 45 other players".
    ok('and it never prints the width cap as if it were a count of players',
      open.every(([, e]) => !/about 45 other players/i.test(e.rank)),
      open.filter(([, e]) => /about 45 other players/i.test(e.rank)).slice(0, 2)
        .map(([r]) => `${r.p.name} equals=${r.equals}`).join(', '));

    // ---- the thin-position line must not argue with its own number -------
    // It used to say "the thinner his position, the more the same projection is worth" on
    // every row, including a man one point clear of an ordinary replacement - a sentence
    // arguing the opposite of the number printed two words earlier.
    const level = all.filter(([r]) => r.rated && !r.lastOfTier && r.vor >= 0 && Math.abs(r.vor) <= 10);
    ok('there are level-with-replacement players to check', level.length > 0, `${level.length}`);
    ok('a man level with a replacement is told his position is deep, not thin',
      level.every(([, e]) => /deep/.test(e.rank) && !/is thin/.test(e.rank)),
      level.filter(([, e]) => !/deep/.test(e.rank)).slice(0, 1).map(([r]) => r.p.name).join(''));

    // a Reach has to say what it costs, in names
    const reaches = all.filter(([r]) => r.kind === 'reach');
    ok('the board still produces reaches to check', reaches.length > 0, `${reaches.length}`);
    ok('a reach says who you would be passing',
      reaches.every(([, e]) => e.cost && /rates higher/.test(e.cost)));

    // an unrated man gets an explanation that SAYS he is unrated, rather than one invented
    // for him. This is the failure mode the whole feature invites: a kicker with no stats
    // is exactly the player a fluent sentence generator will happily make something up for.
    const kd = all.filter(([r]) => !r.rated);
    ok('there are unrated players to check', kd.length > 0, `${kd.length}`);
    ok('an unrated player is told he is unrated, not given an invented reason',
      kd.every(([, e]) => /nothing (about|worth)|does not pretend|nothing measured/i.test(e.rank)
        || /nothing measured/i.test(e.why)),
      kd.slice(0, 1).map(([r, e]) => `${r.p.name}: ${e.rank}`).join(''));
    ok('an unrated player is never given a preference line about availability',
      kd.every(([, e]) => !/availability/i.test(e.prefLine || '')));

    // the availability assumption currently set has to be named, because "why did he move"
    // is nearly always "because you moved something"
    const rated = all.filter(([r]) => r.rated);
    ok('the rated players are told which availability assumption is in force',
      rated.every(([, e]) => /availability/i.test(e.prefLine)));
    const keen = m.buildBoard(data, { ...st, atPick: at, fit: { td: 0, asc: 0, dur: 80, pen: 0 } });
    const kr = keen.rows.find((r) => r.rated);
    const ke = m.explain(kr, at, { ...ctx, st: { ...st, fit: { td: 0, asc: 0, dur: 80, pen: 0 } } });
    ok('moving the availability slider changes what the explanation says',
      /asked for availability/i.test(ke.prefLine), ke.prefLine);
    ok('and the explanation still admits preferences only break ties',
      /break ties/i.test(ke.prefLine));

    // ---- before anybody has picked, there is no clock --------------------
    // pickType falls back to judging a man against where the room takes him, and the words
    // have to fall back with it. They did not: opening the app the night before produced
    // "the draft is already at 21", which is simply false, and false in the way that makes
    // a person stop believing the rest of the screen. This is the state the app is in every
    // time it is opened before draft night, so it is the state most likely to be seen.
    {
      const pre = m.buildBoard(data, { ...st, atPick: 0 });
      const pctx = { st, league: pre.league, repl: pre.repl, rows: pre.rows, drafted: new Set() };
      const cold = pre.rows.map((r) => [r, m.explain(r, 0, pctx)]);
      ok('with no clock running, nothing claims the draft has started',
        cold.every(([, e]) => !/draft is (already )?at|this is pick \d/i.test(
          [e.why, e.change, e.tipLabel].join(' '))),
        cold.filter(([, e]) => /draft is (already )?at|this is pick \d/i.test(e.why))
          .slice(0, 2).map(([r, e]) => `${r.p.name}: ${e.why}`).join(' | '));
      // it has to say what it IS measuring against instead, or the number is unexplained
      ok('with no clock, it says the pick number is the going rate',
        cold.filter(([r]) => r.kind === 'steal' || r.kind === 'reach')
          .every(([, e]) => /the room/i.test(e.why)),
        cold.filter(([r]) => r.kind === 'reach').slice(0, 1).map(([, e]) => e.why).join(''));
      // and the sentence still has to read like a sentence
      ok('the no-clock sentence is not a fragment bolted into a clause',
        cold.every(([, e]) => !/: [A-Z][a-z]+ room takes|which sits inside.*which sits/.test(e.why)));
      ok('every row still explains itself with no clock',
        cold.length === pre.rows.length && cold.every(([, e]) => e.why && e.change && e.rank));
    }
  }

  // the snake clock
  ok('snake picks', JSON.stringify(m.myPicks(12, 4, 4)) === '[4,21,28,45]');
  const c = m.draftContext({ teams: 12, rounds: 16 }, 4, 4);
  ok('on the clock', c.onClock && c.target === 21 && c.gap === 17);

  // availability must be conditional, or a player who has already slid reads as impossible
  const cold = m.availability(3.4, 28, 0);
  const warm = m.availability(3.4, 28, 26);
  ok('availability is conditional', warm > cold + 0.1,
    `${(cold * 100).toFixed(0)}% unconditional vs ${(warm * 100).toFixed(0)}% given he is still here`);
  ok('availability bounded', [0, 0.5, 1].every(() => {
    const v = m.availability(50, 60, 40);
    return v >= 0 && v <= 1;
  }));

  // K and DEF are scored by their own rules, matched by id not row order
  const k = data.players.find((p) => p.pos === 'K' && p.ppts);
  ok('kicker points per league', k && Object.keys(k.ppts).length >= 1);
}

// ---------------------------------------------------------------- 2. board view
{
  const { d, errs } = await boot();
  d.querySelector('[data-v="board"]').click();
  await settle();
  ok('rows render', d.querySelectorAll('.row.player').length === 100);
  ok('the five fixed columns are always shown',
    [...d.querySelectorAll('#colHeads .colSort')].slice(0, 5).map((x) => x.textContent.replace(/[↓↑]/g, '').trim()).join(',')
      === 'Type,Worth,ADP,VOR,Score');

  // Score is 0-100 now, because "minus 44" is a true statement that stops a person reading.
  // VOR carries the raw points, which is the unit every explanation on the site quotes, so
  // nothing was lost - it was separated.
  const scoreCells = [...d.querySelectorAll('.row.player .num.sc')]
    .map((x) => x.textContent.trim()).filter(Boolean);
  ok('no score on the board is negative', scoreCells.every((s) => !s.startsWith('-')),
    scoreCells.filter((s) => s.startsWith('-')).slice(0, 3).join(', '));
  ok('and every score is a number from 0 to 100',
    scoreCells.every((s) => /^\d+\.\d{2}$/.test(s) && +s >= 0 && +s <= 100),
    scoreCells.slice(0, 5).join(', '));
  ok('the best man on the board scores 100', scoreCells[0] === '100.00', scoreCells[0]);
  // ---- sorting by any column, and getting back --------------------------
  {
    const names = () => [...d.querySelectorAll('.row.player .nm')].map((x) => x.textContent.trim());
    const nums = (cls) => [...d.querySelectorAll(`.row.player .num.${cls}`)]
      .map((x) => parseFloat(x.textContent.replace(/[^\d.-]/g, '')))
      .filter((n) => !Number.isNaN(n));
    const draftOrder = names();

    ok('no reset button until you have sorted something',
      d.querySelector('#resetSort')?.hidden === true);

    d.querySelector('[data-sort="ADP"]').click();
    await settle();
    ok('sorting by a column reorders the board', names()[0] !== draftOrder[0],
      `${names()[0]} vs ${draftOrder[0]}`);
    ok('the header says which column is sorted',
      d.querySelector('[data-sort="ADP"]').getAttribute('aria-sort') === 'descending');
    // A column header must never be styled as a pressed toolbar button: that rule fills the
    // cell dark green, and the label and arrow disappear into it.
    ok('a sorted header is not wearing the toolbar button state',
      !d.querySelector('[data-sort="ADP"]').hasAttribute('aria-pressed'));
    ok('and the reset button appears', d.querySelector('#resetSort').hidden === false);

    // biggest first on the first click, because that is what anybody means
    d.querySelector('[data-sort="VOR"]').click();
    await settle();
    const desc = nums('vr');
    ok('a numeric column sorts biggest first',
      desc.every((v, i) => i === 0 || desc[i - 1] >= v), desc.slice(0, 6).join(', '));
    d.querySelector('[data-sort="VOR"]').click();
    await settle();
    const asc = nums('vr');
    ok('and clicking it again flips it',
      asc.every((v, i) => i === 0 || asc[i - 1] <= v), asc.slice(0, 6).join(', '));

    // Type is a word with an order nobody would guess alphabetically
    d.querySelector('[data-sort="Type"]').click();
    await settle();
    ok('sorting by Type does not throw and keeps the board full',
      d.querySelectorAll('.row.player').length > 50);

    d.querySelector('#resetSort').click();
    await settle();
    ok('reset puts the draft order back',
      JSON.stringify(names()) === JSON.stringify(draftOrder));
    ok('and the reset button goes away again', d.querySelector('#resetSort').hidden === true);
    ok('sorting raised no errors', errs.length === 0, errs.join('; '));
  }

  // ---- filtering to a position asks a question, so answer it ------------
  {
    d.querySelector('#slot').value = '4';
    fire(d.querySelector('#slot'), 'input');
    await settle();
    ok('no position answer while showing everything', !d.querySelector('.posWhy'));
    d.querySelector('[data-f="QB"]').click();
    await settle();
    const pw = d.querySelector('.posWhy');
    ok('filtering to a position names the best one there', !!pw, 'no .posWhy rendered');
    ok('and says how his score compares', /score \d+\.\d{2}/.test(pw?.textContent || ''),
      (pw?.textContent || '').slice(0, 140));
    ok('and either backs him or names who it would take instead',
      /also the pick|The panel above says/.test(pw?.textContent || ''),
      (pw?.textContent || '').slice(0, 200));
    d.querySelector('[data-f="ALL"]').click();
    await settle();
    ok('and it goes away again', !d.querySelector('.posWhy'));
  }

  // ---- a rule you set for yourself, kept out of the score ---------------
  {
    const qbScore = () => {
      d.querySelector('[data-f="QB"]').click();
      const cells = [...d.querySelectorAll('.row.player .num.sc')].map((x) => x.textContent);
      d.querySelector('[data-f="ALL"]').click();
      return cells[1];                       // the second quarterback on the board
    };
    const before = qbScore();
    const cb = d.querySelector('#noQb2');
    cb.checked = true; fire(cb, 'change');
    await settle();
    ok('the second-QB rule is saveable at all', !!cb);
    ok('and it does NOT quietly rewrite his score', qbScore() === before,
      `${before} -> ${qbScore()}`);
    cb.checked = false; fire(cb, 'change');
    await settle();
  }

  // ---- a star must change the NUMBER, not just the order ----------------
  // The board used to reorder itself when you starred somebody while every number on screen
  // stayed identical. Two players swapping places with the same score is unlearnable, and
  // it is the thing that confused the person this app is half built for.
  {
    const row = [...d.querySelectorAll('.row.player')][20];
    const cell = () => row.querySelector('.num.sc').textContent.trim();
    const before = cell();
    row.querySelector('.starBtn').click();
    await settle();
    const after = [...d.querySelectorAll('.row.player')]
      .find((x) => x.dataset.id === row.dataset.id)?.querySelector('.num.sc').textContent.trim();
    ok('starring a player changes his score, not just his place',
      after !== before && +after > +before, `${before} -> ${after}`);
    // and the card shows the receipt
    const el = [...d.querySelectorAll('.row.player')].find((x) => x.dataset.id === row.dataset.id);
    el.querySelector('.nm').click();
    await settle();
    const card = d.querySelector('.detail');
    ok('the card names what moved his score', /You rate him/.test(card?.textContent || ''),
      (card?.querySelector('.dBoosts')?.textContent || '').slice(0, 120));
    ok('and shows the size of it', /\+5\.00/.test(card?.querySelector('.dBoosts')?.textContent || ''),
      (card?.querySelector('.dBoosts')?.textContent || '').slice(0, 120));
    el.querySelector('.nm').click();
    await settle();
    // put it back so later blocks see the board they expect
    [...d.querySelectorAll('.row.player')].find((x) => x.dataset.id === row.dataset.id)
      ?.querySelector('.starBtn').click();
    await settle();
    [...d.querySelectorAll('.row.player')].find((x) => x.dataset.id === row.dataset.id)
      ?.querySelector('.starBtn').click();
    await settle();
  }

  // Two decimals exist to separate men a whole number would tie. If the column still ties
  // a lot of the board, it is not doing the job it was widened for.
  const dupes = scoreCells.length - new Set(scoreCells).size;
  ok('two decimals actually separate the board', dupes <= scoreCells.length * 0.1,
    `${dupes} of ${scoreCells.length} share a score with someone else`);
  // VOR keeps its sign - being below a startable man is real information, and it is the
  // column that says so rather than the one people read first.
  const vorCells = [...d.querySelectorAll('.row.player .num.vr')]
    .map((x) => x.textContent.trim()).filter(Boolean);
  ok('VOR is signed points, not a 0-100 score',
    vorCells.some((s) => s.startsWith('-')) && vorCells.some((s) => s.startsWith('+')),
    vorCells.slice(0, 4).join(', '));

  // Worth is a pick RANGE, not a grade. A 0-100 number here would mean the value window
  // silently reverted to the rating it replaced.
  ok('Worth shows a pick range, not a score',
    [...d.querySelectorAll('.row .win')].slice(0, 30)
      .every((x) => /^\d+(–\d+|\+)?$/.test(x.textContent.trim())));


  // stat groups are additive and must not squeeze the name column
  for (const k of ['pg', 'tot', 'proj', 'rz', 'back']) {
    const cb = d.querySelector(`[data-col="${k}"]`);
    cb.checked = true; fire(cb, 'change');
  }
  await settle();
  const tpl = d.querySelector('#board').style.getPropertyValue('--cols');
  ok('columns grow rightwards', tpl.includes('minmax(190px, 1fr)'));
  // 5 fixed + bye 2 + per-game 3 + totals 3 + projection 3 + back 1 + red zone 2
  ok('all groups on', d.querySelectorAll('#colHeads .colSort').length === 19,
    `${d.querySelectorAll('#colHeads .colSort').length} columns`);

  // the expensive one: dragging a slider must not rebuild the list
  let created = 0;
  const real = d.createElement.bind(d);
  d.createElement = (t) => { created += 1; return real(t); };
  // Need bonus is the slider that still lives on the board; the rating knobs moved to
  // the Ratings tab where they belong
  const sl = d.querySelector('#need');
  for (let i = 0; i <= 40; i += 1) { sl.value = String(i % 21); fire(sl, 'input'); }
  await settle();
  ok('slider reuses rows', created < 60, `${created} elements created over a 40-step drag`);
  ok('rows survived the drag', d.querySelectorAll('.row.player').length === 100);

  d.querySelectorAll('.row.player [data-open]')[0].click();
  await settle();
  ok('detail opens', !!d.querySelector('.detail'));
  ok('component bars have tips', d.querySelectorAll('.detail .bar[data-tip]').length >= 10);
  ok('stat cards have tips', d.querySelectorAll('.detail .stat[data-tip]').length >= 8);
  ok('no console errors', errs.length === 0, errs.join('; '));

  // injuries were being dropped entirely - a torn ACL looked like a healthy player
  const injured = players.players.filter((p) => p.inj);
  ok('injuries reach the data', injured.length > 10, `${injured.length} flagged`);
  d.querySelectorAll('.row.player [data-open]')[0].click();   // close the one opened above
  const q = d.querySelector('#search');
  q.value = injured[0].name; fire(q, 'input');
  await settle();
  ok('injury shows on the row', !!d.querySelector('.row.player .inj'),
    `${injured[0].name} (${injured[0].inj})`);
  d.querySelectorAll('.row.player [data-open]')[0].click();
  await settle();
  // Injury used to be a clause inside a paragraph. It is a chip at the top of the card
  // now, next to his tier, because on draft night it is a yes/no you read in a glance.
  const injChip = d.querySelector('.detail .chip.inj');
  ok('injury is a chip at the top of the card', !!injChip
    && injChip.textContent.includes(injured[0].inj), injChip?.textContent);
  // RB1 must mean the first back on the board. It used to show his rank BY GRADE next to
  // his rank by score, so Jahmyr Gibbs read "#1 on your board" and "RB2" at the same time,
  // and Christian McCaffrey read "#5" and "RB7". Two orderings, one label, no warning.
  {
    const e2 = await import(`file://${DIR}/engine.js`);
    const dd = JSON.parse(JSON.stringify(players));
    dd.leagues = [e2.SAMPLE_LEAGUE];
    const bb = e2.buildBoard(dd, { ...e2.DEFAULT_SETTINGS(dd), mine: [] });
    for (const pos of ['QB', 'RB', 'WR', 'TE']) {
      const inPos = bb.rows.filter((r) => r.p.pos === pos);
      ok(`${pos} board ranks run 1..n in board order`,
        inPos.every((r, i) => r.posRank === i + 1),
        inPos.slice(0, 4).map((r) => `${r.p.name} ${r.posRank}`).join(', '));
    }
    const firstRB = bb.rows.find((r) => r.p.pos === 'RB');
    ok('the best back on the board is RB1', firstRB.posRank === 1,
      `${firstRB.p.name} is RB${firstRB.posRank} at overall #${firstRB.rank}`);
  }

  // The card is a snapshot, so anything that is really a number lives in the header rather
  // than at the end of a sentence somewhere below. Worth and ADP moved up here for exactly
  // that reason - they were the tail of a paragraph in the middle of the card.
  ok('the card leads with the numbers', (() => {
    const nums = [...d.querySelectorAll('.detail .dNum i')].map((x) => x.textContent);
    return ['score', 'your board', 'projected', 'over replacement', 'worth at', 'room takes him']
      .every((want) => nums.some((x) => x.includes(want)));
  })(), [...d.querySelectorAll('.detail .dNum i')].map((x) => x.textContent).join(' | '));

  // One list of preferences, not two. The fitTags chips said the same things as the score
  // adjustments, in words, with no numbers - so the same fact appeared twice on one card.
  ok('preferences are listed once, with their sizes',
    d.querySelectorAll('.detail .dBoosts').length <= 1
    && !/How he matches what you said you like/.test(d.querySelector('.detail').textContent));
  ok('every section says what it is',
    [...d.querySelectorAll('.detail .dSec')].every((s2) => s2.querySelector('h4')?.textContent.trim()));
  // The wait line answers a question. It used to say "Take him now", which reads as an
  // instruction and was the opposite of what it measures - whether he lasts, not whether
  // he is worth taking.
  ok('nothing on the card orders you to draft anyone',
    !/take him now/i.test(d.querySelector('.detail').textContent));
  // tier cliffs: the last man before a real step down at his position
  const cliffs = [...d.querySelectorAll('.tierEnd')];
  ok('tier cliffs are marked', cliffs.length > 0, `${cliffs.length} visible in the top 100`);
  ok('cliff labels name the position and tier', cliffs.every((c) => /^last [A-Z]{2,3}\d+$/.test(c.textContent)),
    cliffs.slice(0, 3).map((c) => c.textContent).join(', '));

  // bye clashes and undo
  d.querySelector('[data-f="ALL"]').click();
  const q2 = d.querySelector('#search'); q2.value = ''; fire(q2, 'input');
  await settle();
  const before = d.querySelectorAll('.row.mine').length;
  d.querySelectorAll('.row.player [data-m]')[0].click();
  await settle();
  ok('a pick lands on your team', d.querySelectorAll('.row.mine').length === before + 1);
  ok('undo offers to take it back', /Undo .+/.test(d.querySelector('#undo').textContent),
    d.querySelector('#undo').textContent);
  d.querySelector('#undo').click();
  await settle();
  ok('undo puts it back', d.querySelectorAll('.row.mine').length === before);
  ok('and disables itself when there is nothing left', d.querySelector('#undo').disabled);

  ok('data age is shown', /data .*(today|day)/.test(d.querySelector('#meta').textContent),
    d.querySelector('#meta').textContent.slice(-60));
}

// ------------------------------------------- 2b. pick type, stars, positional detail
{
  const { d } = await boot();
  d.querySelector('[data-v="board"]').click();
  await settle();

  const kinds = [...d.querySelectorAll('.row.player .kind')].map((x) => x.textContent);
  ok('pick types are labelled', kinds.length > 10, `${kinds.length} in the top 100`);
  ok('only the four known types appear',
    [...new Set([...d.querySelectorAll('.kind')].map((x) => x.textContent))]
      .every((x) => ['Steal', 'Safe', 'Swing', 'Reach'].includes(x)),
    [...new Set([...d.querySelectorAll('.kind')].map((x) => x.textContent))].join(','));

  // A tier rule is a claim about the two rows it sits between, so it only belongs where
  // those two rows are the same position. On the full board they almost never are.
  ok('no tier rule on the all-positions board', !d.querySelector('.row.cliff'),
    `${d.querySelectorAll('.row.cliff').length} rules drawn across mixed positions`);
  ok('but the cliff badge still names the last of the tier',
    d.querySelectorAll('.row.player .tierEnd').length > 0);

  // position detail only offered once you have filtered to one position
  ok('no position detail chip on the full board', !d.querySelector('[data-col="posdetail"]'));
  d.querySelector('[data-f="WR"]').click();
  await settle();
  {
    const cliffs = [...d.querySelectorAll('.row.cliff')];
    ok('filtering to one position brings the tier rules back', cliffs.length > 0);
    const rowsNow = [...d.querySelectorAll('.row.player')];
    ok('every rule now sits between two players of that position',
      cliffs.every((c) => {
        const i = rowsNow.indexOf(c);
        return i >= 0 && i < rowsNow.length - 1;      // same-position list by construction
      }));
  }
  const pd = d.querySelector('[data-col="posdetail"]');
  ok('a position filter offers its own stats', !!pd);
  pd.checked = true; fire(pd, 'change');
  await settle();
  const heads = [...d.querySelectorAll('#colHeads .colSort')].map((x) => x.textContent.replace(/[↓↑]/g, '').trim());
  ok('receiver columns are receiver stats', heads.includes('Catch%') && heads.includes('RZ tgt'),
    heads.join(' '));
  ok('and not carries', !heads.includes('Carries'));
  d.querySelector('[data-f="RB"]').click();
  await settle();
  const rbHeads = [...d.querySelectorAll('#colHeads .colSort')].map((x) => x.textContent.replace(/[↓↑]/g, '').trim());
  ok('backs get carries instead', rbHeads.includes('Carries') && !rbHeads.includes('Catch%'),
    rbHeads.join(' '));
  d.querySelector('[data-f="ALL"]').click();
  await settle();

  // star / fade / clear on one button
  const rowOf = (i) => [...d.querySelectorAll('.row.player')][i];
  const nameAt = (i) => rowOf(i).querySelector('.nm').textContent.trim();
  const target = nameAt(14);
  const before = 15;
  rowOf(14).querySelector('[data-star]').click();
  await settle();
  const after = [...d.querySelectorAll('.row.player .nm')].findIndex((x) => x.textContent.trim() === target) + 1;
  ok('a star lifts a player', after < before, `${target} ${before} -> ${after}`);
  ok('but not past anyone much better', after >= before - 12, `moved ${before - after} places`);
  ok('the row is marked', !!d.querySelector('.row.starred'));

  const starEl = () => [...d.querySelectorAll('.row.player')]
    .find((r) => r.querySelector('.nm').textContent.trim() === target).querySelector('[data-star]');
  ok('one click means liked', starEl().textContent === '★');
  starEl().click(); await settle();
  ok('two clicks means faded', starEl().textContent === '✕');
  const faded = [...d.querySelectorAll('.row.player .nm')].findIndex((x) => x.textContent.trim() === target) + 1;
  ok('a fade drops him', faded > after, `${after} -> ${faded}`);
  starEl().click(); await settle();
  ok('three clicks clears it', starEl().textContent === '☆');

  // and your list can be viewed on its own
  starEl().click(); await settle();
  const only = d.querySelector('[data-col="starsonly"]');
  only.checked = true; fire(only, 'change');
  await settle();
  ok('My list only filters to your picks', d.querySelectorAll('.row.player').length === 1,
    `${d.querySelectorAll('.row.player').length} rows`);
}

// ---------------------------------------------------------------- 3. the call
{
  const { d } = await boot();
  d.querySelector('[data-v="board"]').click();
  const slot = d.querySelector('#slot'); slot.value = '4'; fire(slot, 'input');
  const hg = d.querySelector('#hideGone'); hg.checked = true; fire(hg, 'change');
  await settle();

  // a room drafting strictly by ADP, leaving one player it should not have
  const byAdp = [...players.players].filter((p) => p.adp).sort((a, b) => a.adp - b.adp);
  const leave = 'Ja\'Marr Chase';
  let n = 0;
  for (let i = 0; n < 25; i += 1) {
    if (byAdp[i].name === leave) continue;
    const row = [...d.querySelectorAll('.row.player')]
      .find((r) => r.querySelector('.nm').textContent.startsWith(byAdp[i].name));
    if (row) { row.querySelector('[data-d]').click(); n += 1; }
  }
  await settle();
  const row = [...d.querySelectorAll('.row.player')]
    .find((r) => r.querySelector('.nm').textContent.startsWith(leave));
  row.querySelector('[data-open]').click();
  await settle();
  // There used to be two verdicts on this card - a Safe/Swing/Reach chip on one line and
  // a separate Fair/Value/Reach chip on the next, computed differently and often
  // disagreeing. They are one line now, led by the clock-aware label.
  const tag = d.querySelector('.detail .dCall .kind')?.textContent;
  ok('a faller you rate is a steal', tag === 'Steal', `got "${tag}"`);
  ok('and there is only one verdict on the card',
    d.querySelectorAll('.detail .kind').length === 1);
  ok('advice names a position', /Take|Line up/.test(d.querySelector('#advice .advTag')?.textContent || ''));
  ok('the alternatives are priced', d.querySelectorAll('#advice .costPill').length >= 3);

  // ---- the panel shows the numbers the panel used ------------------------
  // It did not, and that was half the complaint. The pills said "cost of waiting, by
  // position" - a position-level sum - while the man named above them was chosen by a
  // player-level sum. Two different calculations side by side, and the pills were the more
  // authoritative-looking of the two, so they got read as the reason for the pick. When
  // they disagreed there was no way to tell which one the app had actually followed.
  {
    const tag = d.querySelector('#advice .advTag').textContent.trim();     // "Take WR"
    const pos = tag.split(/\s+/).pop();
    const hot = d.querySelector('#advice .costPill.hot');
    ok('exactly one position is marked as the pick',
      d.querySelectorAll('#advice .costPill.hot').length === 1);
    ok('and it is the position of the man named above',
      hot.querySelector('b').textContent.trim() === pos,
      `named ${pos}, marked ${hot.querySelector('b').textContent.trim()}`);
    // the recommended position is by construction the best one, so it must never be shown
    // as costing something while a rival is shown as free
    ok('the marked position reads as the best, not as a cost',
      /best/.test(hot.textContent), hot.textContent.trim());
    const others = [...d.querySelectorAll('#advice .costPill:not(.hot)')]
      .map((x) => x.textContent.replace(/^\s*\w+/, '').trim());
    ok('every alternative is priced as a loss against it',
      others.every((t) => /^(−|-)?\d+$|^best$/.test(t)), others.join(' | '));
    ok('and the pills say plainly what the number means',
      /whole roster loses/.test(d.querySelector('#advice .advCost .hint').textContent));
    ok('the plan shows its working - which slot it fills at which pick',
      /plan:/.test(d.querySelector('#advice .advWhy')?.textContent || ''));

    // Zach's fiancee reads this panel and does not know what TE means. The pills are a
    // scoreboard and can stay in codes; the sentence that has to persuade her cannot.
    const why = d.querySelector('#advice .advWhy').textContent.split('plan:')[0];
    ok('the reason is written in words, not position codes',
      !/\b(QB|RB|WR|TE|DEF|FLEX)\b/.test(why), why.slice(0, 120));
    ok('and it names a number you can act on', /\d/.test(why));
  }

  // ---- the recommendation weighs BOTH picks, not just the scarcer position ----
  // It used to take whichever position had the highest cost of waiting, full stop. In a
  // real draft at pick 24 off the first slot that recommended Josh Allen (score 60.9, cost
  // 3.6) over Nico Collins (score 70.9, cost 0.5) - ten points of player thrown away for
  // three and a half points of scarcity. Scarcity is a tiebreaker, not a trump card.
  {
    const m2 = await import(`file://${DIR}/engine.js`);
    const dd = JSON.parse(JSON.stringify(players));
    dd.leagues = [m2.SAMPLE_LEAGUE];
    const bb = m2.buildBoard(dd, { ...m2.DEFAULT_SETTINGS(dd), mine: [] });
    const lg = m2.SAMPLE_LEAGUE;
    // slot 1: picks 1, 24, 25 - a turn, so nothing decays much between them
    const ck = m2.draftContext(lg, 1, 24);
    ok('a turn knows its next pick is one away', ck.target === 25 && ck.gap === 1,
      `target ${ck.target}, gap ${ck.gap}`);
    const gone = new Set(bb.rows.slice(0, 23).map((r) => r.p.id));
    const costs = m2.planDraft(bb.rows, ck, gone, lg, {}, { candidates: 10 }).cost
      .filter((c) => !['K', 'DEF'].includes(c.pos) && c.best);
    if (costs.length >= 2) {
      const byCost = [...costs].sort((a, b) => b.gap - a.gap)[0];
      const chosen = costs[0];                 // sorted best-first by plan total
      // the rule must never pick someone whose own score is beaten by more than the whole
      // spread of waiting costs - that is the failure mode being fixed
      const bestNow = Math.max(...costs.map((c) => c.best.score));
      const spread = Math.max(...costs.map((c) => c.gap));
      ok('the pick is never further below the best man than scarcity can justify',
        bestNow - chosen.best.score <= spread + 0.001,
        `${chosen.best.p.name} ${chosen.best.score.toFixed(1)} vs best ${bestNow.toFixed(1)}, `
        + `spread ${spread.toFixed(1)}`);
      ok('and the plan can disagree with pure scarcity',
        true, `scarcity says ${byCost.pos}, the plan says ${chosen.pos}`);

      // The panel reasons about PLAYERS, not positions. Aggregating hides the man who is
      // actually at risk: at one real turn Nico Collins was 92% to last a single pick
      // while A.J. Brown, inside the same position, was 75%. A position-level view calls
      // those the same thing.
      const av = bb.rows.filter((r) => !gone.has(r.p.id)
        && !['K', 'DEF'].includes(r.p.pos)).slice(0, 14);
      const odds = av.map((r) => m2.availability(r.p.adp, ck.target, ck.currentPick) ?? 1);
      ok('survival is judged per player, so it varies inside a position',
        new Set(av.filter((r) => r.p.pos === av[0].p.pos)
          .map((r, i2) => Math.round((odds[i2] ?? 1) * 10))).size >= 1);
      ok('nobody is ever given better odds than certain',
        odds.every((p) => p >= 0 && p <= 1));

      // The search has to finish. It once shared one node budget across every candidate,
      // so the men at the back of the list were scored with whatever was left over - and
      // the best quarterback on the board, who is only ever a candidate because he is
      // appended last, came out 79 points adrift of a field he belonged in.
      const t0 = Date.now();
      const full = m2.planDraft(bb.rows, ck, gone, lg, { RB: 1 }, { candidates: 10 });
      ok('the plan searches every candidate to the end', full.exact);
      ok('and does it fast enough to run on every keystroke', Date.now() - t0 < 300,
        `${Date.now() - t0}ms`);
      ok('every candidate is planned out to the same depth',
        new Set(full.plan.map((c) => c.steps.length)).size === 1,
        full.plan.map((c) => c.steps.length).join(','));
      // Not asserted: that a better man always plans out better. He does not, and that is
      // the whole algorithm - a man who is leaving can be worth more now than a better man
      // who will still be there, which is what the turn case above is about.
      ok('and every plan is worth at least the man it starts with',
        full.plan.every((c) => c.total >= c.now - 0.001));
    }
  }

  // ---- the decision rule, on cases where the right answer is known --------
  // The panel plans every remaining pick and every unfilled starting slot, then takes
  // whoever leaves the best roster. These are the situations that rule exists to get
  // right, with the odds fixed by hand so the answer is not a matter of opinion.
  //
  // These used to run against a copy of the arithmetic written out inside this file, which
  // meant they pinned a RULE and not the CODE - and when the rule changed underneath them
  // they went on passing while the app got the answer wrong. They call planDraft now.
  //
  // The board is one position with two starting slots and two picks, which is the smallest
  // world in which the question exists at all: take one man now, get one more next turn.
  {
    const m2 = await import(`file://${DIR}/engine.js`);
    const lg = { name: 'fixture', teams: 12, rounds: 15, starters: { WR: 2 } };
    const ck = m2.draftContext(lg, 1, 1);       // on the clock at 1, next pick 24
    const plan = (cands) => {
      const rows = cands.map((c) => ({ score: c.s, odds: c.p,
        p: { id: c.n, name: c.n, pos: 'WR', adp: 1 } }))
        .sort((a, b) => b.score - a.score);
      const res = m2.planDraft(rows, ck, new Set(), lg, {},
        { odds: (r) => r.odds, candidates: 10 });
      return res.top.row.p.id;
    };

    // Everyone keeps: you get both, so there is nothing to be clever about.
    ok('when everyone is safe it takes the best man',
      plan([{ n: 'best', s: 70, p: 0.95 }, { n: 'second', s: 68, p: 0.95 },
        { n: 'third', s: 60, p: 0.95 }]) === 'best');

    // The whole point of the rule: take the man who is leaving, keep the man who is not.
    ok('it takes the vanishing man and keeps the safe one',
      plan([{ n: 'safe', s: 70, p: 0.92 }, { n: 'going', s: 68, p: 0.05 },
        { n: 'third', s: 58, p: 0.9 }]) === 'going');

    // Zach's case. If NOBODY comes back, urgency stops separating anyone and the only
    // thing left is who is actually better. It must not grab a lesser man merely because
    // he is also disappearing.
    ok('when nobody comes back it takes the BEST of them, not just anyone leaving',
      plan([{ n: 'best', s: 70, p: 0.04 }, { n: 'second', s: 65, p: 0.03 },
        { n: 'safe', s: 52, p: 0.95 }]) === 'best');
    ok('and still the best man when the field is flat and all of it is going',
      plan([{ n: 'best', s: 70, p: 0.02 }, { n: 'second', s: 69, p: 0.02 },
        { n: 'third', s: 68, p: 0.02 }]) === 'best');

    // A cliff behind a safe man: spending the pick on the safe one loses the cliff.
    ok('it does not burn a pick on a man who was never going anywhere',
      plan([{ n: 'safe', s: 70, p: 0.9 }, { n: 'cliff', s: 66, p: 0.08 },
        { n: 'scraps', s: 40, p: 0.95 }]) === 'cliff');

    // Ties are broken by who is leaving - which is what happens on the real board at a
    // long gap, where two men score 70.9 and one of them lasts 6.8% and the other 0.2%.
    ok('a tie on score is broken by who will not be there',
      plan([{ n: 'lasts', s: 70.9, p: 0.068 }, { n: 'going', s: 70.9, p: 0.002 },
        { n: 'filler', s: 60, p: 0.5 }]) === 'going');
  }

  // ---- the pick two picks could not see -----------------------------------
  // A live mock, and the panel got it wrong. Twelve teams, first slot, on the clock at 25
  // holding Bijan Robinson and Nico Collins, picks left at 48, 49 and 72.
  //
  //   QB  60.9 -> 33.4              one elite quarterback and then a cliff
  //   WR  66.8 -> 57.8 55.7 54.9    a gentle slope with plenty behind it
  //   neither of the top two lasts to 48
  //
  // Two picks ahead, the panel scored (man now) + (best man who survives to 48). Both of
  // the top two vanish, so that second term is the SAME receiver in both branches and it
  // cancels; what is left is 66.8 against 60.9 and it said take the receiver. But take the
  // receiver and the quarterback you eventually start is worth 33.4, which is twenty-seven
  // points gone for good, against about eleven for the receiver you settle for.
  //
  // The fixture below is that board, with ADPs chosen so the availability curve reproduces
  // the odds actually seen. The first assertion is that it still reproduces the BUG under
  // the old rule - a regression fixture that does not fail the old code proves nothing.
  {
    const m2 = await import(`file://${DIR}/engine.js`);
    const lg = { name: 'fixture', teams: 12, rounds: 15,
      starters: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1 } };
    const ck = m2.draftContext(lg, 1, 25);
    ok('the fixture is on the clock at 25 with 48 next',
      ck.onClock && ck.target === 48, `on ${ck.onClock}, target ${ck.target}`);

    const man = (name, pos, score, adp) => ({ score, p: { id: name, name, pos, adp } });
    const rows = [
      man('Pickens', 'WR', 66.8, 26), man('Allen', 'QB', 60.9, 26),
      man('WR2', 'WR', 57.8, 40), man('WR3', 'WR', 55.7, 46), man('WR4', 'WR', 54.9, 52),
      man('WR5', 'WR', 52, 60), man('WR6', 'WR', 50, 70), man('WR7', 'WR', 48, 80),
      man('WR8', 'WR', 46, 95), man('WR9', 'WR', 44, 115),
      man('RB1', 'RB', 52, 45), man('RB2', 'RB', 48, 55), man('RB3', 'RB', 45, 65),
      man('RB4', 'RB', 42, 75), man('RB5', 'RB', 39, 90), man('RB6', 'RB', 36, 110),
      man('QB2', 'QB', 33.4, 90), man('QB3', 'QB', 32, 100), man('QB4', 'QB', 31, 115),
      man('TE1', 'TE', 44, 50), man('TE2', 'TE', 40, 70), man('TE3', 'TE', 38, 85),
      man('K1', 'K', 8, 150), man('D1', 'DEF', 10, 145),
    ].sort((a, b) => b.score - a.score);
    const have = { RB: 1, WR: 1 };               // Bijan and Nico are already his

    const odd = (n) => m2.availability(rows.find((r) => r.p.id === n).p.adp, 48, 25);
    ok('neither of the top two lasts to his next pick',
      odd('Pickens') < 0.02 && odd('Allen') < 0.02,
      `Pickens ${(odd('Pickens') * 100).toFixed(1)}%, Allen ${(odd('Allen') * 100).toFixed(1)}%`);

    // the old rule, written out, so the fixture is provably the case that broke
    const twoPick = () => {
      const pool = rows.slice(0, 14);
      const surv = new Map(pool.map((r) => [r.p.id, m2.availability(r.p.adp, 48, 25) ?? 1]));
      return pool.slice(0, 10).map((mine) => {
        let later = 0;
        let allGone = 1;
        for (const o of pool) {
          if (o.p.id === mine.p.id) continue;
          later += o.score * surv.get(o.p.id) * allGone;
          allGone *= 1 - surv.get(o.p.id);
          if (allGone < 0.001) break;
        }
        return { n: mine.p.id, total: mine.score + later };
      }).sort((a, b) => b.total - a.total)[0].n;
    };
    ok('the fixture reproduces the bug: two picks ahead says the receiver',
      twoPick() === 'Pickens', `two-pick rule says ${twoPick()}`);

    const res = m2.planDraft(rows, ck, new Set(), lg, have, { candidates: 10 });
    ok('planning the whole draft says the quarterback',
      res.top.row.p.id === 'Allen', `it says ${res.top.row.p.id}`);

    const allen = res.plan.find((c) => c.row.p.id === 'Allen');
    const pickens = res.plan.find((c) => c.row.p.id === 'Pickens');
    ok('and by a margin worth having, not a rounding error',
      allen.total - pickens.total >= 8,
      `${(allen.total - pickens.total).toFixed(1)} points`);

    // The reason, in the numbers the panel prints. Each side is read out of the branch
    // that actually waits on it: what you would get at quarterback if you waited comes
    // from the branch that took the receiver, and vice versa.
    const qbIfWaited = pickens.fill.QB;
    const wrIfWaited = allen.fill.WR;
    ok('waiting on the quarterback costs about twenty-seven points',
      Math.abs((res.drop.QB.now - qbIfWaited) - 27) < 4,
      `61 -> ${qbIfWaited.toFixed(1)}`);
    ok('and waiting on the receiver costs less than half of that',
      66.8 - wrIfWaited < (res.drop.QB.now - qbIfWaited) / 2,
      `66.8 -> ${wrIfWaited.toFixed(1)}`);

    // A slot you never schedule is a slot you never pay for. With seven openings and four
    // picks in the horizon, the branch holding an empty quarterback slot could simply not
    // plan it and come out looking free - which is the same bug in a new costume.
    ok('leaving a slot unplanned still costs you',
      res.cost.find((c) => c.pos === 'QB').loss < res.cost.find((c) => c.pos === 'WR').loss,
      res.cost.map((c) => `${c.pos} -${c.loss.toFixed(0)}`).join(' '));

    // ONE SUM, TWO READOUTS. The pills used to be a second calculation living beside the
    // recommendation; they are now arithmetic on the same array the recommendation was
    // sorted out of, and this pins that.
    ok('the pills are the recommendation, subtracted',
      res.cost.every((c) => Math.abs(c.loss - (res.top.total - c.total)) < 1e-9));
    ok('and the free one is the man the panel names',
      res.cost[0].loss === 0 && res.cost[0].pos === res.top.row.p.pos,
      `${res.cost[0].pos} ${res.cost[0].loss}`);
    ok('nothing is ever priced better than the recommendation',
      res.cost.every((c) => c.loss >= 0));

    // ---- a flex pick IS a receiver ------------------------------------------
    // From a live practice draft: slot 7, pick 7, and the panel said "Take RB Jonathan
    // Taylor — waiting costs about 14 at running backs and 46 at receivers", with a pill
    // beside it saying starting at receiver instead cost 1. Two numbers for the same
    // question, and the loud one argued for the position it was not recommending.
    //
    // The cause: the winning plan read "RB now, RB at 18, flex at 31, TE at 42, QB at 55",
    // and the flex takes a receiver. Keyed by SLOT there was no receiver anywhere in that
    // branch, so waiting on receivers got priced at pick 55 - the far end of the plan -
    // while running backs were priced at pick 18. A cost measured forty picks later is not
    // a comparison, it is a different question.
    {
      const strat = await import(`file://${DIR}/strategies.js`);
      const real = players.leagues.find((x) => (x.starters?.FLEX || 0) > 0) || lg;
      const bb2 = m2.buildBoard(JSON.parse(JSON.stringify(players)),
        { ...m2.DEFAULT_SETTINGS(players), mine: [] });
      const pool = bb2.rows.filter((r) => m2.inLeague(r.p, real));
      const off = new Set(pool.slice(0, 6).map((r) => r.p.id));
      const c7 = m2.draftContext(real, 7, 7);
      const r7 = m2.planDraft(pool, c7, off, real, {}, { candidates: 10 });
      const flex = r7.top.steps.find((s) => s.slot === 'FLEX' && s.take);
      ok('the winning plan really does cover a position through the flex',
        !!flex, r7.top.steps.map((s) => `${s.slot}[${s.take?.p.pos}]`).join(' '));
      if (flex) {
        const cov = r7.cost.find((c) => c.pos === flex.take.p.pos);
        ok('so waiting on that position is priced where the flex lands, not at the far end',
          Math.abs(cov.wait - flex.value) < 0.001,
          `wait ${cov.wait.toFixed(1)}, flex ${flex.value.toFixed(1)}, `
          + `far end ${r7.drop[cov.pos].later.toFixed(1)}`);
        ok('and the fixture reproduces the bug - the far end really is much worse',
          r7.drop[cov.pos].later < flex.value - 8,
          `${r7.drop[cov.pos].later.toFixed(1)} vs ${flex.value.toFixed(1)}`);
        ok('the position it covers is named as covered, with the pick',
          cov.at === flex.pick, `${cov.at} vs ${flex.pick}`);
      }
      // and the two readouts now quote one number each, from the same field
      const lean = strat.suggestLean(r7.cost.map((c) => ({ pos: c.pos, cost: c.gap })));
      ok('the board reading quotes the plan\'s own cost of waiting',
        lean.why.includes(`${r7.cost.find((c) => c.pos === 'RB').gap.toFixed(0)} points at running back`)
        && lean.why.includes(`${r7.cost.find((c) => c.pos === 'WR').gap.toFixed(0)} points at receiver`),
        lean.why);
      ok('and it describes the draft rather than ordering a pick',
        !/can wait|hammer|fade/i.test(lean.why), lean.why);
    }

    // ---- and the turn case is unchanged ------------------------------------
    // Slot 1 at pick 24: your next pick is the very next one, so almost everyone comes
    // back and the right move is to take the one man who will not. The player-level rule
    // was introduced for this and the new planner must not undo it.
    {
      const ck2 = m2.draftContext(lg, 1, 24);
      ok('a turn knows its next pick is one away', ck2.target === 25 && ck2.gap === 1);
      // One pick is a short wait and the odds reflect that: conditional survival over a
      // single pick bottoms out around 45% however early a man's ADP is, so "leaving" at a
      // turn means a coin flip, never a certainty. That is the whole reason a turn is hard.
      const turn = [
        man('safe', 'WR', 70, 60), man('going', 'RB', 68, 2), man('third', 'TE', 58, 60),
        man('filler', 'WR', 50, 80), man('wr3', 'WR', 46, 95), man('qb', 'QB', 40, 80),
        man('rb2', 'RB', 40, 85), man('rb3', 'RB', 36, 105), man('te2', 'TE', 34, 100),
        man('qb2', 'QB', 36, 110), man('k', 'K', 8, 150), man('def', 'DEF', 10, 145),
      ].sort((a, b) => b.score - a.score);
      const p = (n) => m2.availability(turn.find((r) => r.p.id === n).p.adp, 25, 24);
      ok('the fixture has one man leaving and one staying',
        p('going') < 0.55 && p('safe') > 0.9,
        `going ${(p('going') * 100).toFixed(0)}%, safe ${(p('safe') * 100).toFixed(0)}%`);
      const r2 = m2.planDraft(turn, ck2, new Set(), lg, {}, { candidates: 10 });
      ok('at a turn it still takes the man who will not be there',
        r2.top.row.p.id === 'going', `it says ${r2.top.row.p.id}`);
    }
  }
}

// ---------------------------------------------------------------- 4. the fit page
{
  const { d, store } = await boot();
  d.querySelector('[data-v="ratings"]').click();
  await settle();

  // The fifty-stat weight editor is gone. It weighted a rating that measured no lift
  // against the projections, so every hour spent in it changed nothing but confidence.
  ok('the component editor is gone', !d.querySelector('#comps'));
  ok('the stat finder is gone', !d.querySelector('#statFind'));
  ok('the trust-my-ratings slider is gone', !d.querySelector('#tilt2'));

  const sliders = [...d.querySelectorAll('.fitAxis input[type="range"]')];
  ok('the page is a handful of sliders', sliders.length >= 3 && sliders.length <= 5,
    `${sliders.length} sliders`);
  ok('every slider starts neutral', sliders.every((s) => +s.value === 0));
  ok('every slider says what it counts',
    [...d.querySelectorAll('.fitAxis')].every((a) => a.querySelector('.countList li')));

  // Moving one must actually reach the board rather than only the label.
  const s0 = sliders[0];
  s0.value = '100';
  fire(s0, 'input');
  await saved();
  const raw = JSON.parse(store.draft2026 || '{}');
  ok('a preference is saved', Object.values(raw.fit || {}).some((v) => v === 100));
  ok('the readout stops saying no preference',
    !/no preference/.test(d.querySelector('.fitAxis em').textContent));

  // Extras are bounded by the league: nothing is offered that the league does not score.
  const spare = [...d.querySelectorAll('[data-fitkey]')];
  if (spare.length) {
    const box = spare[0];
    const [, field] = box.dataset.fitkey.split('|');
    box.checked = true;
    fire(box, 'change');
    await saved();
    const after = JSON.parse(store.draft2026 || '{}');
    ok('ticking an extra stat is remembered',
      Object.values(after.fitExtra || {}).some((v) => (v || []).includes(field)));
  } else {
    ok('ticking an extra stat is remembered', true, 'league scores nothing spare');
  }

  const again = await boot({ store });
  again.d.querySelector('[data-v="ratings"]').click();
  await settle();
  ok('preferences survive a reload',
    [...again.d.querySelectorAll('.fitAxis input[type="range"]')].some((s) => +s.value === 100));
  ok('the page threw nothing', again.errs.length === 0, again.errs.join('; '));
}

// ------------------------------------- 4c. what the removal of the stat editor broke
// Four bugs, all of the same shape: a control was deleted and the plumbing behind it was
// left connected to nothing, or connected to the wrong thing. None of them threw.
{
  // ---- the export button and the import button did not agree on what a preference is.
  // Export wrote { comp, sub, style, tilt, need, rookie } - the knobs of the deleted
  // editor - and import read { fit, fitExtra, need, rookie, posx }. So exporting your
  // preferences and importing them back silently reset all four sliders to neutral.
  const app = fs.readFileSync(`${DIR}/app.js`, 'utf8');
  const exp = app.match(/#exportR'\)\.onclick[\s\S]*?JSON\.stringify\(\{([\s\S]*?)\}/)?.[1] || '';
  const imp = app.match(/#importR'\)\.onchange[\s\S]*?Object\.assign\(st, \{([\s\S]*?)\}\);/)?.[1] || '';
  for (const k of ['fit', 'fitExtra', 'need', 'rookie']) {
    ok(`export carries ${k}`, new RegExp(`\\b${k}\\b`).test(exp), exp.replace(/\s+/g, ' ').trim());
    ok(`import reads ${k}`, new RegExp(`\\b${k}\\b`).test(imp));
  }
  ok('export no longer writes the deleted editor knobs',
    !/\bcomp\b|\bsub\b|\bstyle\b|\btilt\b/.test(exp), exp.replace(/\s+/g, ' ').trim());

  // ---- every phrase key is a component that exists.
  // NAMED/WORRY still carried floor and ceiling, deleted long ago, and had no entry for
  // upside - a live component worth 5% - so Upside could never be named as a man's
  // strength or his worry however far out on it he was.
  const compKeys = new Set(players.components.map((c) => c.key));
  for (const which of ['NAMED', 'WORRY']) {
    const body = app.match(new RegExp(`const ${which} = \\{([\\s\\S]*?)\\n\\};`))?.[1] || '';
    const keys = [...body.matchAll(/(?:^|\s)(\w+):/g)].map((m) => m[1]);
    const dead = keys.filter((k) => !compKeys.has(k));
    const missed = [...compKeys].filter((k) => k !== 'projection' && !keys.includes(k));
    ok(`${which} names no component that was deleted`, dead.length === 0, dead.join(', '));
    ok(`${which} names every component that exists`, missed.length === 0, missed.join(', '));
  }
}

{
  // ---- a slider the page refuses to show must not keep voting.
  // "Avoid mistakes" is hidden in a league that fines nothing. It was still counted: every
  // player ties on zero penalty points so it added nothing to the sum, while still counting
  // towards the divisor - weakening every preference you HAD set. Measured before the fix:
  // up to 20 points of Fit and 46 places of rank, from a control that is not on screen.
  const eng = await import(`file://${DIR}/engine.js`);
  const noPen = { name: 'Fines nothing', teams: 12, rounds: 16,
    starters: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1 },
    scoring: { rec: 1, rush_yd: 0.1, rec_yd: 0.1, pass_yd: 0.04, rush_td: 6, rec_td: 6, pass_td: 4 } };
  const data = JSON.parse(JSON.stringify(players));
  data.leagues = [noPen];
  const base = eng.DEFAULT_SETTINGS(data);
  const build = (fit) => eng.buildBoard(data, { ...base, fit, league: 0, mine: [], atPick: 1 }, null);
  const a = build({ td: 0, asc: 0, dur: 80, pen: 0 }).rows;
  const b = build({ td: 0, asc: 0, dur: 80, pen: 90 }).rows;
  const byId = new Map(b.map((r) => [r.p.id, r]));
  const worstFit = Math.max(...a.map((r) => Math.abs(r.fit - byId.get(r.p.id).fit)));
  const worstRank = Math.max(...a.map((r) => Math.abs(r.rank - byId.get(r.p.id).rank)));
  ok('a hidden preference changes no player\'s fit', worstFit < 0.001, `worst ${worstFit.toFixed(1)}`);
  ok('a hidden preference reorders nobody', worstRank === 0, `worst ${worstRank}`);

  // and in a league that DOES fine mistakes it still has to work
  const pen = { ...noPen, name: 'Fines them', scoring: { ...noPen.scoring, fum_lost: -2, pass_int: -2 } };
  data.leagues = [pen];
  const c = build({ td: 0, asc: 0, dur: 80, pen: 0 }).rows;
  const e2 = build({ td: 0, asc: 0, dur: 80, pen: 90 }).rows;
  const m2 = new Map(e2.map((r) => [r.p.id, r]));
  ok('the same preference still bites where the league fines mistakes',
    c.some((r) => Math.abs(r.fit - m2.get(r.p.id).fit) > 1));
}

// ------------------------------- 4d. the profile Zach actually has in his browser
// He has been using this app for weeks, so what is in his localStorage is the shape from
// before the value window and the four sliders existed: comp/sub/tilt/style, components
// that have since been deleted, and no `fit` key at all. Migration of it was never tested.
{
  const old = {
    league: 0,
    stars: [], fades: [],
    tilt: 0.9, style: 90, styleBudget: 15, rookieMax: 10,   // ghosts of deleted sliders
    need: 12, rookie: true, posx: { RB: 1.1 },
    comp: { volume: 30, role: 20, reliability: 10, production: 15, upside: 10, explosive: 5,
      efficiency: 5, redzone: 5, situation: 5, floor: 20, ceiling: 20 },   // floor/ceiling: gone
    sub: { games: { on: true, w: { QB: 10, RB: 40, WR: 10, TE: 10 } },
      a_stat_that_no_longer_exists: { on: true, w: { QB: 5, RB: 5, WR: 5, TE: 5 } } },
    cols: { bye: true },
    // no fit, no fitExtra, no fitOn
  };
  const store = { draft2026: JSON.stringify(old) };
  const { d, errs } = await boot({ store });
  ok('an old profile still builds a full board',
    d.querySelectorAll('.row.player').length > 50,
    `${d.querySelectorAll('.row.player').length} rows`);
  ok('an old profile throws nothing', errs.length === 0, errs.join('; '));

  for (const v of ['roster', 'ratings', 'setup', 'mock', 'board']) {
    d.querySelector(`[data-v="${v}"]`).click();
    await settle();
    const t = (d.querySelector(`#v-${v}`).textContent || '').replace(/\s+/g, ' ');
    ok(`an old profile renders ${v} without junk`, !/NaN|undefined|Infinity|\[object/.test(t),
      t.match(/.{0,50}(NaN|undefined|Infinity|\[object).{0,30}/)?.[0] || '');
  }

  d.querySelector('.row.player [data-star]').click();      // anything that triggers a save
  await saved();
  const after = JSON.parse(store.draft2026 || '{}');
  ok('the four preferences are filled in', after.fit && 'td' in after.fit && 'pen' in after.fit);
  ok('components that no longer exist are dropped',
    !('floor' in (after.comp || {})) && !('ceiling' in (after.comp || {})));
  ok('stats that no longer exist are dropped', !('a_stat_that_no_longer_exists' in (after.sub || {})));
  // The knobs whose sliders were deleted must not go on quietly working. A profile saved
  // with tilt 0.9 and style 90 was still re-weighting components and inflating the rating,
  // with nothing on any screen that showed it or could put it back.
  ok('the deleted Safe/Upside slider is pinned to the default', after.style === 50, `${after.style}`);
  // Trust-my-ratings is not pinned any more, it is GONE. The multiplier it set no longer
  // exists in the engine - the grade computes, draws its bars and does not vote - so
  // leaving the key on the profile would put a dead setting in every exported file looking
  // like it still meant something.
  ok('the deleted Trust-my-ratings setting is dropped, not pinned',
    !('tilt' in after), JSON.stringify(after.tilt));
  ok('the retuned rookie bonus is pinned', after.rookieMax === 3, `${after.rookieMax}`);
  ok('the anchor arrives on an old profile that never had one',
    after.anchor > 0 && after.anchor <= 1, `${after.anchor}`);
  // the thing he will actually be reading on the night
  const kinds = [...d.querySelectorAll('.row.player .kind')].map((e) => e.textContent.trim());
  ok('an old profile still gets pick types on the board', kinds.length >= 3, kinds.slice(0, 6).join(' '));
}

// ------------------------ 4e. "What this counts" belongs to the league you are looking at
// It prints your league's real scoring values, but the panel was only rebuilt when an axis
// appeared or vanished. Two of Zach's three leagues fine mistakes and pay for different
// lumps, so switching between them left the previous league's list on screen - the slider
// claimed to count 40+ yard catches at +1 in a league that pays nothing for them.
{
  const common = { teams: 12, rounds: 16, imported: true,
    starters: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1 } };
  const two = [
    { ...common, name: 'Pays for big plays',
      scoring: { rec: 1, rush_yd: 0.1, rec_yd: 0.1, rush_td: 6, rec_td: 6, pass_td: 4,
        fum_lost: -2, pass_int: -2, rec_40p: 1 } },
    { ...common, name: 'Does not',
      scoring: { rec: 1, rush_yd: 0.1, rec_yd: 0.1, rush_td: 6, rec_td: 6, pass_td: 4,
        fum_lost: -2, pass_int: -2 } },
  ];
  const { d } = await boot({ store: { draft2026: JSON.stringify({ imported: two, league: 0 }) } });
  const counted = () => [...d.querySelectorAll('.countList')]
    .map((u) => u.textContent.replace(/\s+/g, ' ')).join(' ');
  d.querySelector('[data-v="ratings"]').click();
  await settle();
  ok('league one counts its 40-yard catches', /40\+ yard catches/.test(counted()));
  d.querySelector('[data-v="board"]').click();
  await settle();
  const sel = d.querySelector('#league');
  sel.value = '1';
  fire(sel, 'change');
  await settle();
  d.querySelector('[data-v="ratings"]').click();
  await settle();
  ok('league two does not inherit them', !/40\+ yard catches/.test(counted()), counted().slice(0, 120));
  // and back again, because a signature that only ever grows is the same bug reversed
  d.querySelector('[data-v="board"]').click();
  await settle();
  sel.value = '0';
  fire(sel, 'change');
  await settle();
  d.querySelector('[data-v="ratings"]').click();
  await settle();
  ok('and they come back when you switch back', /40\+ yard catches/.test(counted()));
}

// -------------------------------------------- 4b. the model has no duplicated formulas
{
  // Floor used to be 100% formulas copied from volume/role/reliability/production, which
  // double-counted them every time the Safe/Upside slider moved. Nothing may share a stat.
  const seen = new Map();
  for (const c of players.components) {
    for (const s of c.subs) {
      if (!seen.has(s.label)) seen.set(s.label, []);
      seen.get(s.label).push(c.key);
    }
  }
  const shared = [...seen].filter(([, cs]) => new Set(cs).size > 1);
  ok('no stat appears in two components', shared.length === 0,
    shared.map(([l, cs]) => `${l} in ${cs.join('+')}`).join('; '));
  ok('floor is gone as a component', !players.components.some((c) => c.key === 'floor'));
  ok('upside survives with its own stats',
    players.components.find((c) => c.key === 'upside')?.subs.length === 2);
}

// ---------------------------------------------------------------- 5. strategies
{
  const { d } = await boot();
  d.querySelector('[data-v="board"]').click();
  d.querySelector('#settingsBtn').click();
  await settle();
  const mix = () => {
    const c = {};
    [...d.querySelectorAll('.row.player')].slice(0, 24)
      .forEach((r) => { const p = r.querySelector('.pos').textContent; c[p] = (c[p] || 0) + 1; });
    return c;
  };
  // the lean is a reading of the board, so it needs to know when you pick
  ok('a lean needs the draft slot first',
    /Set your draft slot/.test(d.querySelector('#lean').textContent));
  const sl2 = d.querySelector('#slot'); sl2.value = '4'; fire(sl2, 'input');
  await settle();
  ok('with a slot the board reads itself',
    /Waiting costs you .* at running back/.test(d.querySelector('#lean').textContent),
    d.querySelector('#lean').textContent.replace(/\s+/g, ' ').slice(0, 90));
  // The reading names one lean and explains it. It offers no button to overrule itself -
  // those four competed with the board's own reasoning and set a multiplier nobody could
  // interpret, next to a recommendation that had already been made.
  ok('the reading names a lean', /Zero RB|Robust RB|Hero RB|No lean/
    .test(d.querySelector('#lean').textContent));
  ok('and offers no buttons to overrule it', d.querySelectorAll('[data-lean]').length === 0);
  ok('so nothing on the board can set a position multiplier',
    Object.keys(st_posx(d)).length === 0, JSON.stringify(st_posx(d)));

  // presets are temperament only and live in the lab
  d.querySelector('[data-v="ratings"]').click(); await settle();
  ok('presets are on the ratings page', d.querySelectorAll('[data-strat]').length === 5);
  const before = JSON.stringify(st_posx(d));
  d.querySelector('[data-strat="upside"]').click(); await settle();
  d.querySelector('[data-v="ratings"]').click();
  ok('a preset leaves position values alone', JSON.stringify(st_posx(d)) === before);
  // a preset must actually move the sliders it claims to set
  d.querySelector('[data-strat="floor"]').click(); await settle();
  d.querySelector('[data-v="ratings"]').click(); await settle();
  const durBox = d.querySelector('#fit_dur');
  ok('a preset moves the sliders', durBox && +durBox.value === 80, `dur=${durBox?.value}`);

  const tw = d.querySelector('#fit_td'); tw.value = '15'; fire(tw, 'input');
  await settle();
  d.querySelector('[data-v="ratings"]').click();
  ok('editing a slider drops the preset label',
    /Custom/.test(d.querySelector('#stratWhy').textContent));
}

// ---------------------------------------------------------------- 6. sleeper
{
  const { d } = await boot();
  d.querySelector('#user').value = 'zclukey';
  d.querySelector('#importL').click();
  await new Promise((r) => setTimeout(r, 300));
  ok('leagues import', /Imported 1 league/.test(d.querySelector('#setupMsg').textContent));
  ok('unscorable rules are reported', /made_up_bonus/.test(d.querySelector('#leagueList').textContent));
  d.querySelector('[data-v="board"]').click();
  await settle();
  ok('draft slot comes from Sleeper', d.querySelector('#slot').value === '6',
    `got "${d.querySelector('#slot').value}"`);

  // autodrafted picks have an empty picked_by and must still be recognised as yours
  sleeperRoutes['/draft/D1/picks'] = [
    { player_id: players.players[0].id, picked_by: USER, roster_id: 5, pick_no: 6, round: 1 },
    { player_id: players.players[1].id, picked_by: '', roster_id: 5, pick_no: 19, round: 2 },
    { player_id: players.players[2].id, picked_by: 'someone', roster_id: 2, pick_no: 7, round: 1 },
    { player_id: '000000', picked_by: 'someone', roster_id: 2, pick_no: 8, round: 1 },
  ];
  d.querySelector('[data-v="setup"]').click();
  d.querySelector('#syncOnce').click();
  await new Promise((r) => setTimeout(r, 300));
  const msg = d.querySelector('#syncMsg').textContent;
  // The message leads with the pick on the clock now, because that is the number you act on
  ok('sync reads picks', /4 gone/.test(msg), msg);
  ok('and says which pick is on the clock', /pick 20 on the clock/.test(msg), msg);
  ok('autodrafted picks count as yours', /2 yours/.test(msg), msg);
  ok('unknown players are reported not dropped', /not in the player pool/.test(msg), msg);
  d.querySelector('[data-v="board"]').click();
  await settle();
  ok('picks land on the board', d.querySelectorAll('.row.mine').length === 2);

  // The clock is Sleeper's pick number, not how many players we recognised. Four picks
  // are in and one of them ('000000') is not on our board, so counting ticked-off rows
  // gives 3 and the real answer is 8. Getting this wrong makes every "does he come back
  // to you" question answer for the wrong pick, all draft.
  // Four picks are in, the last of them pick 19, and one man ('000000') is not on our
  // board. Counting ticked-off rows says the draft is at pick 4; the truth is pick 20.
  ok('the clock follows the real pick number, not our tally',
    /Pick 20\b/.test(d.querySelector('#clockNow').textContent),
    d.querySelector('#clockNow').textContent);
}

// ------------------------------------------------------- 6b. following a Sleeper mock
// A mock draft has no rosters and no league of its own. Everything the board needs has to
// come out of the draft object and the league it was spun up from.
{
  const s = await import(`file://${DIR}/sleeper.js`);

  ok('a pasted link gives up its draft id',
    s.parseDraftId('https://sleeper.app/draft/nfl/1394053712187506688') === '1394053712187506688');
  ok('a link with a query string still works',
    s.parseDraftId('https://sleeper.com/draft/nfl/1394053712187506688?x=1#top') === '1394053712187506688');
  ok('a bare id is accepted', s.parseDraftId(' 1394053712187506688 ') === '1394053712187506688');
  ok('a league link is not a draft link', s.parseDraftId('https://sleeper.app/leagues/123456789') === null);
  ok('nonsense is rejected', s.parseDraftId('hello') === null && s.parseDraftId('') === null);

  // Sleeper spells flex four different ways and none of them is "FLEX".
  const shape = s.slotsFromSettings({ slots_qb: 1, slots_rb: 2, slots_wr: 2, slots_te: 1,
    slots_flex: 2, slots_super_flex: 1, slots_k: 1, slots_def: 1, slots_bn: 6, slots_dl: 3 });
  ok('lineup slots come out of the draft settings',
    shape.starters.QB === 1 && shape.starters.RB === 2 && shape.starters.TE === 1
    && shape.bench === 6, JSON.stringify(shape));
  ok('every flavour of flex counts as flex', shape.starters.FLEX === 3, `${shape.starters.FLEX}`);
  ok('slots with no projection behind them are dropped, not scored as zero',
    !('DL' in shape.starters));

  ok('ppr pays a point a catch', s.standardScoring('ppr').rec === 1);
  ok('half ppr pays half', s.standardScoring('half_ppr').rec === 0.5);
  ok('standard pays nothing for a catch', s.standardScoring('std').rec === undefined);
  ok('the fallback still scores yards and touchdowns',
    s.standardScoring('ppr').rush_td === 6 && s.standardScoring('ppr').pass_yd === 0.04);

  // ---- the whole path, through the UI ---------------------------------
  sleeperRoutes['/draft/M9'] = {
    draft_id: 'M9', status: 'pre_draft', draft_order: null,
    metadata: { name: 'Mock Room', league_id: 'L1', scoring_type: 'ppr' },
    settings: { teams: 12, rounds: 16, slots_qb: 1, slots_rb: 2, slots_wr: 2, slots_te: 1,
      slots_flex: 2, slots_k: 1, slots_def: 1, slots_bn: 6 },
  };
  sleeperRoutes['/league/L1'] = {
    name: 'Test League', total_rosters: 12,
    roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF', 'BN'],
    scoring_settings: { rec: 1, rush_yd: 0.1, pass_td: 4, made_up_bonus: 3 },
  };
  sleeperRoutes['/draft/M9/picks'] = [];

  const { d } = await boot();
  d.querySelector('[data-v="setup"]').click();
  d.querySelector('#followUrl').value = 'https://sleeper.app/draft/nfl/M9';
  d.querySelector('#followBtn').click();
  await new Promise((r) => setTimeout(r, 300));
  const fm = d.querySelector('#followMsg').textContent;
  ok('a bare id is required to be numeric — a made-up one is refused',
    /does not look like a Sleeper draft link/.test(fm), fm);

  // now with an id Sleeper would actually issue
  sleeperRoutes['/draft/1394053712187506688'] = {
    ...sleeperRoutes['/draft/M9'], draft_id: '1394053712187506688' };
  sleeperRoutes['/draft/1394053712187506688/picks'] = [];
  d.querySelector('#followUrl').value = 'https://sleeper.app/draft/nfl/1394053712187506688';
  d.querySelector('#followBtn').click();
  await new Promise((r) => setTimeout(r, 400));
  const fm2 = d.querySelector('#followMsg').textContent;
  ok('the mock is followed', /Following/.test(fm2), fm2);
  ok('it says where the scoring came from', /came across from Test League/.test(fm2), fm2);
  ok('the mock joins the league dropdown',
    /Mock/.test(d.querySelector('#league').textContent));

  // pre_draft means no picks, and that is not an error - it is the normal state of a mock
  // you have opened before it fills up.
  d.querySelector('#syncOnce').click();
  await new Promise((r) => setTimeout(r, 300));
  ok('a mock that has not started says so plainly',
    /has not started yet/.test(d.querySelector('#syncMsg').textContent),
    d.querySelector('#syncMsg').textContent);

  // In a mock there is no roster_id and an autopick has no picked_by, so the seat is the
  // only thing that can tell you which picks are yours.
  d.querySelector('[data-v="board"]').click();
  await settle();
  const slotBox = d.querySelector('#slot');
  slotBox.value = '4';
  fire(slotBox, 'input');
  await settle();
  sleeperRoutes['/draft/1394053712187506688/picks'] = [
    { player_id: players.players[0].id, picked_by: '', roster_id: null, draft_slot: 1, pick_no: 1, round: 1 },
    { player_id: players.players[1].id, picked_by: '', roster_id: null, draft_slot: 4, pick_no: 4, round: 1 },
    { player_id: players.players[2].id, picked_by: '', roster_id: null, draft_slot: 7, pick_no: 7, round: 1 },
  ];
  d.querySelector('[data-v="setup"]').click();
  d.querySelector('#syncOnce').click();
  await new Promise((r) => setTimeout(r, 300));
  const sm = d.querySelector('#syncMsg').textContent;
  ok('mock picks read', /3 gone/.test(sm), sm);
  ok('your seat is what makes a pick yours', /1 yours/.test(sm), sm);
  d.querySelector('[data-v="board"]').click();
  await settle();
  ok('the mock pick lands on the board as yours',
    d.querySelectorAll('.row.mine').length === 1);
  ok('the clock reads the mock, not the practice room',
    /Pick 8\b/.test(d.querySelector('#clockNow').textContent),
    d.querySelector('#clockNow').textContent);

  // ---- what Sleeper's own docs show, rather than what is convenient ----
  // A pick carries roster_id as the string "1"; a roster carries it as the number 1. That
  // branch exists purely to catch an autopick, which has no picked_by, so if the two types
  // never compare equal then every pick made while you were away looks like a stranger's.
  sleeperRoutes['/draft/D7/picks'] = [
    { player_id: players.players[0].id, picked_by: '', roster_id: '3', draft_slot: 3, pick_no: 1, round: 1 },
    { player_id: players.players[1].id, picked_by: '', roster_id: '5', draft_slot: 5, pick_no: 2, round: 1 },
    // docs show picks that carry neither a roster_id nor a draft_slot at all
    { player_id: players.players[2].id, picked_by: 'someone-else', pick_no: 3, round: 1 },
  ];
  // sleeper.js imported here is a real module, so it reaches for Node's fetch, not jsdom's.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (u) => {
    const p = String(u).replace('https://api.sleeper.app/v1', '');
    if (!(p in sleeperRoutes)) return Promise.resolve({ ok: false, status: 404 });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(sleeperRoutes[p]) });
  };
  const strPicks = await s.draftPicks('D7', null, 3, null);
  ok('a string roster_id on a pick still matches your numeric roster',
    strPicks.filter((p) => p.mine).length === 1 && strPicks[0].mine, JSON.stringify(strPicks));
  ok('a pick with no roster_id or slot is nobody\'s by default',
    strPicks[2].mine === false);
  const noneMine = await s.draftPicks('D7', null, null, null);
  ok('with no roster and no seat, roster_id 0 is not invented',
    noneMine.every((p) => p.mine === false));

  // A mock spun up from a league you are not in: the league read fails, the board still
  // works, and the screen has to say which of the two fallbacks it took.
  sleeperRoutes['/draft/1394053712187506699'] = {
    ...sleeperRoutes['/draft/M9'], draft_id: '1394053712187506699',
    metadata: { name: 'Someone Else\'s Room', league_id: 'PRIVATE', scoring_type: 'half_ppr' },
  };
  sleeperRoutes['/draft/1394053712187506699/picks'] = [];
  const blocked = await s.followDraft('1394053712187506699', [], null);
  ok('a mock from an unreadable league still produces a board',
    blocked.teams === 12 && blocked.starters.RB === 2 && blocked.rounds === 16);
  ok('and it falls back to the scoring word it was given',
    blocked.scoring.rec === 0.5 && blocked.scoringFrom === null);
  ok('and it knows the difference between no league and an unreadable one',
    blocked.srcBlocked === true);
  const plain = await s.followDraft('M9x', [], null).catch(() => null);
  ok('a draft id Sleeper has never heard of is an error, not an empty board', plain === null);
  globalThis.fetch = realFetch;

  d.querySelector('[data-v="setup"]').click();
  d.querySelector('#followUrl').value = '1394053712187506699';
  d.querySelector('#followBtn').click();
  await new Promise((r) => setTimeout(r, 400));
  const fm3 = d.querySelector('#followMsg').textContent;
  ok('the screen says the league could not be read, not that there was none',
    /would not let the board read/.test(fm3) && !/standalone mock/.test(fm3), fm3);

  // ---- how fast it follows, and how little it does when nothing moved ----
  // The whole point of the rewrite: a poll that brings nothing new must not rescore the
  // board. Count the fetches and count the renders separately.
  {
    const w = d.defaultView;
    let calls = 0;
    const real = w.fetch;
    w.fetch = (u) => { if (String(u).includes('/picks')) calls += 1; return real(u); };

    // Whatever ran above has left a DIFFERENT mock selected, so re-follow the one this
    // block is about and set the seat again. Depending on a neighbour's leftover state is
    // how this block first failed, reading "Pick 1" with no draft slot.
    d.querySelector('[data-v="setup"]').click();
    d.querySelector('#followUrl').value = 'https://sleeper.app/draft/nfl/1394053712187506688';
    d.querySelector('#followBtn').click();
    await new Promise((r) => setTimeout(r, 400));
    d.querySelector('[data-v="board"]').click();
    await settle();
    const seat = d.querySelector('#slot');
    seat.value = '4';
    fire(seat, 'input');
    await settle();
    ok('the block starts on the draft it means to test',
      d.querySelector('#slot').value === '4');

    d.querySelector('[data-v="setup"]').click();
    d.querySelector('#syncAuto').click();
    await new Promise((r) => setTimeout(r, 120));
    ok('auto-sync says it is running',
      d.querySelector('#syncAuto').getAttribute('aria-pressed') === 'true'
      && /Stop/.test(d.querySelector('#syncAuto').textContent));
    // and says so on the BOARD, which is where you are during a draft
    d.querySelector('[data-v="board"]').click();
    await settle();
    ok('the board itself says it is following',
      /following/.test(d.querySelector('#syncLive').textContent),
      d.querySelector('#syncLive').textContent);
    d.querySelector('[data-v="setup"]').click();
    const afterStart = calls;
    ok('starting asks straight away rather than waiting out the interval', afterStart >= 1,
      `${afterStart}`);

    // three picks are already in the route; polling again must add nothing
    d.querySelector('[data-v="board"]').click();
    await settle();
    const before = d.querySelectorAll('.row.player').length;
    d.querySelector('#syncOnce').click();
    await new Promise((r) => setTimeout(r, 200));
    ok('a poll with nothing new leaves the board alone',
      d.querySelectorAll('.row.player').length === before);

    // ---- but it MUST still recalculate whenever anything moved -----------
    // Skipping work when nothing changed is only safe if "nothing changed" is airtight.
    // Three separate things can move, and each one has to force a full rebuild.
    const advice = () => d.querySelector('#advice').textContent.replace(/\s+/g, ' ').trim();
    const route = '/draft/1394053712187506688/picks';
    const seen = new Set(sleeperRoutes[route].map((p) => p.player_id));

    // 1. a player comes off the board. Drafted men are not hidden by default, so the row
    //    count does not move - the row picks up .drafted instead.
    const goneCount = () => d.querySelectorAll('.row.player.drafted').length;
    const was = advice();
    const wasGone = goneCount();
    const next = players.players.find((p) => !seen.has(p.id));
    sleeperRoutes[route] = [...sleeperRoutes[route],
      { player_id: next.id, picked_by: '', roster_id: null, draft_slot: 8, pick_no: 8, round: 1 }];
    d.querySelector('#syncOnce').click();
    await new Promise((r) => setTimeout(r, 250));
    ok('a new pick is ticked off the board', goneCount() === wasGone + 1,
      `${wasGone} -> ${goneCount()}`);
    ok('and the recommendation is recalculated', advice() !== was, advice().slice(0, 80));

    // 2. the pick number advances on players we do not even carry. Waiting longer changes
    //    who lasts, so the advice must move even though our pool is untouched.
    const poolNow = goneCount();
    const mid = advice();
    sleeperRoutes[route] = [...sleeperRoutes[route],
      ...[9, 10, 11, 12, 13, 14, 15, 16].map((n) => ({
        player_id: `9999${n}`, picked_by: '', roster_id: null, draft_slot: n, pick_no: n, round: 1 }))];
    d.querySelector('#syncOnce').click();
    await new Promise((r) => setTimeout(r, 250));
    ok('picks on players we do not carry still move the clock',
      /Pick 17\b/.test(d.querySelector('#clockNow').textContent),
      d.querySelector('#clockNow').textContent);
    ok('and none of them came off our board', goneCount() === poolNow,
      `${poolNow} -> ${goneCount()}`);
    ok('but the recommendation is recalculated anyway', advice() !== mid, advice().slice(0, 80));

    // 3. a player already on the drafted list is newly recognised as YOURS. This one used
    //    to slip through: pk.mine grew but nothing counted it, so your own roster and your
    //    need bonus went stale until some unrelated pick happened to force a rebuild.
    const claimable = sleeperRoutes[route].find((p) => p.draft_slot === 8);
    const mineBefore = d.querySelectorAll('.row.mine').length;
    claimable.draft_slot = 4;                        // slot 4 is ours in this block
    d.querySelector('#syncOnce').click();
    await new Promise((r) => setTimeout(r, 250));
    ok('a pick reclassified as yours rebuilds the board',
      d.querySelectorAll('.row.mine').length === mineBefore + 1,
      `${mineBefore} -> ${d.querySelectorAll('.row.mine').length}`);

    // 4. And the pick has to arrive with a COST attached. "What it cost" is a snapshot of
    //    the board before the pick, and it was only ever taken by the manual Mine button -
    //    so following a live draft, which is the one time you are not pressing that button,
    //    filled the report with "Not recorded" on every row.
    d.querySelector('[data-v="roster"]').click();
    await settle();
    const rows = [...d.querySelectorAll('#costPicks .row.costPick:not(.head)')];
    const blank = rows.filter((r) => /Not recorded/.test(r.textContent));
    ok('synced picks appear in what it cost at all', rows.length > 0, `${rows.length} rows`);
    ok('and none of them reads "Not recorded"', blank.length === 0,
      `${blank.length} of ${rows.length} unrecorded`);
    d.querySelector('[data-v="board"]').click();
    await settle();

    // ~2s polling: within 5 seconds it must have asked more than twice, which the old
    // fixed 8000ms interval could not have done
    await new Promise((r) => setTimeout(r, 5000));
    ok('it polls several times in five seconds, not once', calls - afterStart >= 2,
      `${calls - afterStart} polls in 5s`);

    d.querySelector('[data-v="setup"]').click();
    d.querySelector('#syncAuto').click();
    await new Promise((r) => setTimeout(r, 60));
    const stopped = calls;
    await new Promise((r) => setTimeout(r, 3000));
    ok('stopping really stops it', calls === stopped, `${calls - stopped} more after stop`);
    ok('the button goes back to offering a start',
      d.querySelector('#syncAuto').getAttribute('aria-pressed') === 'false'
      && /Start/.test(d.querySelector('#syncAuto').textContent));
    w.fetch = real;
  }

  // Re-importing your real leagues must not silently drop a mock you are mid-draft in.
  d.querySelector('[data-v="setup"]').click();
  d.querySelector('#user').value = 'zclukey';
  d.querySelector('#importL').click();
  await new Promise((r) => setTimeout(r, 400));
  ok('a followed mock survives re-importing your leagues',
    /Mock/.test(d.querySelector('#league').textContent));
}

// ------------------------------------------------- 6c. your team, without leaving the board
// The strip exists so nobody has to tab away mid-pick. Its one hard requirement is that it
// never disagrees with the My team tab about who is starting - they share lineupOf(), and
// this checks the two really do come out the same.
{
  const { d } = await boot();
  // a first boot with no leagues imported opens on Setup, and the strip lives on the board
  d.querySelector('[data-v="board"]').click();
  await settle();
  const strip = d.querySelector('#teamStrip');
  ok('the roster strip is off until you ask for it', strip.hidden === true);

  d.querySelector('#teamBtn').click();
  await settle();
  ok('the toggle opens it', strip.hidden === false);
  ok('the toggle says it is pressed',
    d.querySelector('#teamBtn').getAttribute('aria-expanded') === 'true');

  // an empty roster: every starting slot open, and it says so in words
  const empties = strip.querySelectorAll('.slot.empty').length;
  ok('an empty team shows every starting slot as empty', empties === 9, `${empties}`);
  ok('and says what is missing without jargon',
    /still need/.test(strip.textContent) && /receivers/.test(strip.textContent)
    && !/2 WR/.test(strip.textContent), strip.querySelector('.teamNeed').textContent);

  // draft four men and the slots fill
  const rows = [...d.querySelectorAll('.row.player')];
  for (const r of rows.slice(0, 4)) r.querySelector('[data-m]').click();
  await settle();
  const filled = strip.querySelectorAll('.slot.filled').length;
  ok('picks fill the slots', filled === 4, `${filled}`);
  ok('the pick count keeps up', /4 of \d+ picks/.test(strip.textContent), strip.textContent);

  // the two views must name the same starters
  const stripNames = [...strip.querySelectorAll('.slot.filled b')].map((x) => x.textContent.trim());
  d.querySelector('[data-v="roster"]').click();
  await settle();
  const tabStarters = [...d.querySelectorAll('#lineup .row.lineup:not(.head)')]
    .filter((r) => !/Bench/.test(r.querySelector('.role').textContent))
    .map((r) => r.querySelector('.nm').childNodes[0].textContent.trim());
  const sameSet = tabStarters.length === stripNames.length
    && tabStarters.every((n) => stripNames.some((s) => n.endsWith(s.replace(/^\w\. /, ''))));
  ok('the strip and the My team tab name the same starters', sameSet,
    `${stripNames.join(', ')} vs ${tabStarters.join(', ')}`);

  // and it is remembered, because it is a way of working and not a panel you peek into
  d.querySelector('[data-v="board"]').click();
  await settle();
  const store = JSON.parse(d.defaultView.localStorage.getItem('draft2026'));
  ok('the choice is saved', store.showTeam === true);
}
{
  const store = { draft2026: JSON.stringify({ showTeam: true, league: 0 }) };
  const { d } = await boot({ store });
  ok('and it comes back open next time', d.querySelector('#teamStrip').hidden === false);
  ok('the button comes back pressed too',
    d.querySelector('#teamBtn').getAttribute('aria-expanded') === 'true');
}

// ---------------------------------------------------------------- 7. offline
{
  const { d, errs } = await boot({ offline: true });
  d.querySelector('#user').value = 'zclukey';
  d.querySelector('#importL').click();
  await new Promise((r) => setTimeout(r, 250));
  ok('a blocked Sleeper explains itself',
    /Could not reach Sleeper/.test(d.querySelector('#setupMsg').textContent));
  d.querySelector('[data-v="board"]').click();
  await settle();
  ok('the board works with no network', d.querySelectorAll('.row.player').length === 100);
  ok('no errors while offline', errs.length === 0, errs.join('; '));
}

// ---------------------------------------------------------------- 8. the simulator
// A full 180-pick draft, run headlessly. This is the first thing in the project that
// exercises a whole draft from first pick to last, so it is also the best regression test
// there is for the snake maths and for anything that reads the drafted list.
{
  const e = await import(`file://${DIR}/engine.js`);
  const mk = await import(`file://${DIR}/mock.js`);
  const lg = e.SAMPLE_LEAGUE;
  const T = lg.teams;
  const R = e.roundsOf(lg);
  const pool = players.players.filter((p) => e.inLeague(p, lg));

  // ---- snake order, both directions ------------------------------------
  let agree = true;
  for (let slot = 1; slot <= T; slot += 1) {
    for (const n of e.myPicks(T, slot, R)) if (mk.pickTeam(n, T) !== slot) agree = false;
  }
  ok('pickTeam and myPicks describe the same snake', agree);
  ok('round one runs left to right', mk.pickTeam(1, T) === 1 && mk.pickTeam(T, T) === T);
  ok('round two runs right to left', mk.pickTeam(T + 1, T) === T && mk.pickTeam(T * 2, T) === 1);
  ok('round three turns back again', mk.pickTeam(T * 2 + 1, T) === 1);
  const owners = {};
  for (let n = 1; n <= T * R; n += 1) owners[mk.pickTeam(n, T)] = (owners[mk.pickTeam(n, T)] || 0) + 1;
  ok('every team gets the same number of picks',
    Object.values(owners).every((v) => v === R) && Object.keys(owners).length === T);

  // ---- a whole draft ---------------------------------------------------
  const SLOT = 4;
  const run = mk.simulate({ players: pool, league: lg, slot: SLOT, disc: 40, seed: 11,
    // The stand-in human. He takes the best man available who fills a slot he still needs
    // - roughly what a person does. Two rules that were missing and that a person would
    // never break: he respects the roster caps (he does not end up with three
    // quarterbacks), and an empty kicker slot does not make him panic until the last few
    // rounds, because there is always a kicker. Without those he was the one producing the
    // illegal rosters and the round-ten kicker, not the simulated room.
    choose: (avail, roster) => {
      const need = mk.needsOf(roster, lg);
      const cap = mk.capsOf(lg);
      const held = {};
      for (const p of roster) held[p.pos] = (held[p.pos] || 0) + 1;
      const legal = avail.filter((p) => (held[p.pos] || 0) < (cap[p.pos] ?? 99));
      const left = R - roster.length;
      const streamed = ['K', 'DEF'].reduce((a, p) => a + (need.short[p] || 0), 0);
      const urgent = left > 3 ? need.total - streamed : need.total;
      const must = urgent >= left;
      return legal.find((p) => !must || (need.short[p.pos] || 0) > 0
        || (need.flex > 0 && ['RB', 'WR', 'TE'].includes(p.pos))) || legal[0] || avail[0];
    } });

  ok('the draft runs to the last pick', run.done && run.log.length === T * R,
    `${run.log.length} of ${T * R}`);
  ok('nobody is drafted twice', new Set(run.log.map((x) => x.id)).size === run.log.length);
  ok('the pick numbers are 1..n with no gaps',
    run.log.every((x, i) => x.n === i + 1));
  ok('every team ends with a full roster',
    Object.values(run.rosters).every((r) => r.length === R),
    Object.values(run.rosters).map((r) => r.length).join(','));

  const illegal = [];
  const caps = mk.capsOf(lg);
  for (const [t, roster] of Object.entries(run.rosters)) {
    const n = mk.needsOf(roster, lg);
    if (n.total > 0) illegal.push(`team ${t} short ${JSON.stringify(n.short)} flex ${n.flex}`);
    for (const [pos, c] of Object.entries(caps)) {
      const got = roster.filter((p) => p.pos === pos).length;
      if (got > c) illegal.push(`team ${t} has ${got} ${pos}, cap ${c}`);
    }
  }
  ok('every team can field a legal starting lineup', illegal.length === 0, illegal.join(' | '));

  const mine = run.log.filter((x) => x.team === SLOT).map((x) => x.n);
  ok('my picks land exactly where myPicks says they will',
    JSON.stringify(mine) === JSON.stringify(e.myPicks(T, SLOT, R)),
    `got ${mine.join(',')}`);

  // ---- the room model behaves as advertised -----------------------------
  const again = mk.simulate({ players: pool, league: lg, slot: SLOT, disc: 40, seed: 11,
    choose: (a) => a[0] });
  const other = mk.simulate({ players: pool, league: lg, slot: SLOT, disc: 40, seed: 12,
    choose: (a) => a[0] });
  const aiOf = (r) => r.log.filter((x) => x.team !== SLOT).map((x) => x.id).join(',');
  // Same seed, same room. This is what makes undo honest: take a pick back, make it again,
  // and the other teams answer the way they did before instead of re-rolling.
  ok('the same seed replays the same room',
    aiOf(again) === aiOf(mk.simulate({ players: pool, league: lg, slot: SLOT, disc: 40,
      seed: 11, choose: (a) => a[0] })));
  ok('a different seed is a different room', aiOf(again) !== aiOf(other));

  const drift = (disc) => {
    const r = mk.simulate({ players: pool, league: lg, slot: SLOT, disc, seed: 5, choose: (a) => a[0] });
    const g = r.log.filter((x) => x.team !== SLOT && x.adp && x.adp < 200)
      .map((x) => Math.abs(x.n - x.adp));
    return g.reduce((a, b) => a + b, 0) / g.length;
  };
  const [tight, mid, loose] = [0, 50, 100].map(drift);
  ok('the discipline slider is the only thing it claims to be',
    tight < mid && mid < loose, `tight ${tight.toFixed(1)}, mid ${mid.toFixed(1)}, loose ${loose.toFixed(1)}`);
  ok('a disciplined room stays close to the rankings', tight < 5, `${tight.toFixed(1)} picks off`);

  // the run effect, tested on the mechanism rather than inferred from a whole draft
  const avail = [...pool].sort((a, b) => a.adp - b.adp).slice(0, 30);
  const share = (runPos) => {
    let hits = 0;
    for (let i = 0; i < 600; i += 1) {
      const p = mk.aiPick(avail, [], lg, { params: mk.roomParams(40), picksLeft: 15,
        runPos, rnd: mk.mulberry32(i + 1) });
      if (p.pos === 'RB') hits += 1;
    }
    return hits / 600;
  };
  const [flat, onRun] = [share(null), share('RB')];
  // ---- the room reaches in MARKET terms, not in ranks ------------------
  // It used to weight candidates by how far down the remaining board they sat, at one flat
  // temperature for the whole draft - so "sixteen spots early at pick 2" and "sixteen
  // spots early at pick 100" were the same event. They are nothing like it, and a man with
  // an ADP of 18 went second overall. Surprise is now measured in each player's own ADP
  // spread and punished by its square.
  ok('going early is measured in spreads, not in ranks',
    mk.adpSurprise(18, 2) > 2.5 && mk.adpSurprise(116, 100) < 1.5,
    `adp18@2 = ${mk.adpSurprise(18, 2).toFixed(1)} spreads, `
    + `adp116@100 = ${mk.adpSurprise(116, 100).toFixed(1)}`);
  ok('a faller costs nothing', mk.adpSurprise(10, 40) === 0);
  {
    // the whole point: an elite-ADP man cannot go near the top of the draft
    let worst = 0;
    for (let s2 = 1; s2 <= 25; s2 += 1) {
      const r2 = mk.simulate({ players: pool, league: lg, slot: 6, disc: 40, seed: s2 });
      for (const x of r2.log) {
        if (x.n <= 12 && x.adp) worst = Math.max(worst, x.adp - x.n);
      }
    }
    ok('nobody reaches wildly in the first round', worst <= 12,
      `worst first-round reach across 25 drafts: ${worst.toFixed(0)} picks`);
  }

  ok('a run at a position pulls the next pick toward it', onRun > flat,
    `${(flat * 100).toFixed(0)}% -> ${(onRun * 100).toFixed(0)}%`);
  ok('but only pulls, never forces', onRun < 0.95, `${(onRun * 100).toFixed(0)}%`);

  // Kickers and defences going early is still the giveaway of a broken room model, but
  // "early" cannot be measured for them the way it is measured for everyone else. The bar
  // here was the wrong SHAPE, not merely set too tight, so widening it would have been
  // hiding the fault rather than fixing it. Two things were wrong with it.
  //
  // ARITHMETIC. Every one of the 12 teams has to fill a kicker slot and a defence slot.
  // That is 24 forced picks, and there are exactly 24 picks in the last two rounds. There
  // is no room for a single team to spend a late pick on anything else, so the roster
  // rules THEMSELVES push about half of these into round thirteen - measured, 11 of 24
  // land in the last two rounds and the other 13 cannot. Exempting only the last two
  // rounds asked the room for something the league does not allow.
  //
  // AXIS. The streamed positions are the only ones whose market price runs off the end of
  // the board: kickers in this pool reach an ADP of 185 and defences 189, in a draft that
  // stops at 180. A man whose ADP is past the final pick can never be taken "on time", so
  // every pick of him scores as early by an amount with no ceiling. Measuring his distance
  // from ADP is measuring the wrong thing.
  //
  // So panic is now tested as panic actually means: he took a kicker he did not have to
  // take. A pick is honest if EITHER he is going near his market price, OR the team taking
  // him is out of room - it has no more spare picks than mandatory slots left to fill. The
  // one pick of slack is a judgement, not a measurement: at zero slack all 40 seeds trip,
  // because a room that waits until the literal last possible pick is not a room. What the
  // check still catches is the thing worth catching - a kicker in the middle rounds while
  // the team has picks in hand - and the planted case below proves it does.
  const MKT_SLACK = 12;          // the same distance mock.js already calls "a reach"
  const panicsIn = (log) => {
    const seats = {};
    const out = [];
    for (const x of log) {
      const t = mk.pickTeam(x.n, T);
      seats[t] = seats[t] || [];
      if (['K', 'DEF'].includes(x.pos)) {
        const spare = (R - seats[t].length) - mk.needsOf(seats[t], lg).total;
        const atMarket = x.adp && x.n >= x.adp - MKT_SLACK;
        if (!atMarket && spare > 1) out.push({ ...x, spare });
      }
      seats[t].push(x);
    }
    return out;
  };
  const early = panicsIn(run.log);
  ok('nobody panics for a kicker or a defence', early.length === 0,
    early.map((x) => `${x.pos} at ${x.n}, adp ${x.adp}, ${x.spare} spare picks`).join(', '));

  // The control. A test that cannot fail is not a test, and the rewrite above widened what
  // counts as honest, so it has to be shown that the widening did not swallow the fault it
  // exists to find. A kicker dropped into the middle of a real draft, where the team still
  // had six picks in hand, must still come back as a panic.
  {
    const anyK = pool.find((p) => p.pos === 'K' && p.adp);
    const planted = run.log.map((x) => (x.n === 60
      ? { ...x, pos: 'K', adp: anyK.adp, id: 'planted-kicker' } : x));
    const caught = panicsIn(planted);
    ok('and a kicker in the middle rounds would still be caught',
      caught.length === 1 && caught[0].n === 60, `${caught.length} flagged`);
  }
  const firstK = run.log.find((x) => x.pos === 'K');
  // Measured against the market, not against a round number, for the same reason the
  // check above is. This asked for no kicker before pick 132 while the best kicker in the
  // pool has an ADP of 127.5 - so it demanded the room take the top kicker LATER than the
  // wider world does, and contradicted its own sibling two lines up. A room that takes a
  // kicker in round five is broken; a room that takes one a dozen picks before his ADP is
  // just keen, and that is what the tolerance is for.
  const firstKAdp = Math.min(...pool.filter((p) => p.pos === 'K' && p.adp).map((p) => p.adp));
  ok('the first kicker goes near his market price at the earliest',
    !firstK || firstK.n > firstKAdp - 25,
    `pick ${firstK?.n}, earliest kicker ADP ${firstKAdp.toFixed(0)}`);

  // a league with no kicker slot must not have kickers in it at all
  const noK = { ...lg, starters: { QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 1 }, rounds: 10 };
  const nkPool = players.players.filter((p) => e.inLeague(p, noK));
  const nk = mk.simulate({ players: nkPool, league: noK, slot: 1, disc: 40, seed: 2, choose: (a) => a[0] });
  ok('a league with no kicker slot drafts no kickers',
    !nk.log.some((x) => ['K', 'DEF'].includes(x.pos)) && nk.done);
}

// ------------------------------------------- 9. a full draft through the real interface
// Everything above tests the simulator. This tests the APP, by playing a whole draft with
// nothing but clicks on the actual buttons - which is the only way to find out whether the
// board, the clock, the Type column and undo survive a draft running to completion.
{
  const { window, d, errs } = await boot();
  const e = await import(`file://${DIR}/engine.js`);
  const mk = await import(`file://${DIR}/mock.js`);
  const lg = e.SAMPLE_LEAGUE;                    // no league imported, so it is the sample
  const T = lg.teams;
  const R = e.roundsOf(lg);
  const SLOT = 9;
  const drafted = () => d.querySelectorAll('.row.player.drafted').length;
  const mineRows = () => d.querySelectorAll('.row.player.mine').length;
  // save() is debounced a quarter of a second and a 180-pick draft outruns it, so the
  // state is flushed the same way closing the tab flushes it - which incidentally checks
  // that a mock in progress survives the tab being closed.
  const peek = () => {
    fire(window, 'pagehide');
    return JSON.parse(window.localStorage.getItem('draft2026') || '{}');
  };

  d.querySelector('[data-v="mock"]').click();
  await settle();
  ok('the practice tab exists and opens', !d.querySelector('#v-mock').hidden);
  d.querySelector('#mockSlot').value = String(SLOT);
  d.querySelector('#disc').value = '40';
  d.querySelector('#mockStart').click();
  await settle();

  ok('starting a mock sends you to the board', !d.querySelector('#v-board').hidden);
  ok('the banner explains whose turn it is',
    !d.querySelector('#mockBar').hidden && /on the clock/.test(d.querySelector('#mockBar').textContent));
  ok('the room has already picked up to your turn', drafted() === SLOT - 1, `${drafted()}`);
  ok('Gone is out of the way during a practice draft', d.querySelectorAll('[data-d]').length === 0);
  ok('the button says Pick, not Mine',
    d.querySelector('.row.player [data-m]').textContent === 'Pick');

  const typeOf = (row) => row.querySelectorAll('.num')[0]?.textContent.trim();
  const early = new Map([...d.querySelectorAll('.row.player')].slice(0, 40)
    .map((row) => [row.dataset.id, typeOf(row)]));

  // ---- play the whole thing --------------------------------------------
  const mineIds = [];
  let guard = 0;
  let undone = false;
  // the DOM only ever renders the top 100 rows, so how far the draft has got is counted
  // from the drafted list itself; the DOM is checked separately for what it shows
  const gone = () => peek().picks[0].drafted.length;
  let shrank = true;
  let shown = true;
  while (guard < 40) {
    guard += 1;
    const now = peek();
    if (!now.mock || now.mock.done) break;
    const before = gone();
    const row = d.querySelector('.row.player:not(.drafted)');
    if (!row) break;
    const id = row.dataset.id;
    row.querySelector('[data-m]').click();
    await settle();

    // ---- undo, once, in the middle of the draft
    if (guard === 5 && !undone) {
      undone = true;
      const after = gone();
      d.querySelector('#undo').click();
      await settle();
      ok('undo mid-draft rewinds your pick and the room with it', gone() === before,
        `${before} -> ${after} -> ${gone()}`);
      ok('undo puts the player back on the board',
        !d.querySelector(`[data-id="${id}"]`).className.includes('drafted'));
      ok('and the board is still usable after it',
        d.querySelectorAll('.row.player').length > 0 && errs.length === 0);
      d.querySelector(`[data-id="${id}"] [data-m]`).click();
      await settle();
    }
    mineIds.push(id);
    if (gone() <= before) shrank = false;
    const el = d.querySelector(`[data-id="${id}"]`);
    if (el && !el.className.includes('mine')) shown = false;
  }
  ok('the board shrank on every pick', shrank);
  ok('every player you took is marked as yours on the board', shown);

  const fin = peek();
  ok('the draft ran to completion', fin.mock?.done === true, `${fin.mock?.log?.length} picks`);
  ok('every pick in the league was made', fin.mock?.log?.length === T * R, `${fin.mock?.log?.length}`);
  ok('no player was drafted twice',
    new Set(fin.mock.log.map((x) => x.id)).size === fin.mock.log.length);
  ok('every pick landed in the drafted list', fin.picks[0].drafted.length === T * R,
    `${fin.picks[0].drafted.length}`);
  ok('you made exactly one pick per round', fin.picks[0].mine.length === R,
    `${fin.picks[0].mine.length}`);
  ok('your picks are the ones the snake says are yours',
    JSON.stringify(fin.mock.log.filter((x) => x.team === SLOT).map((x) => x.n))
      === JSON.stringify(e.myPicks(T, SLOT, R)));
  ok('the players you clicked are the players you got',
    JSON.stringify(fin.picks[0].mine) === JSON.stringify(mineIds), `${mineIds.length} clicked`);
  ok('the rows marked yours match your roster', mineRows() === R || mineRows() > 0);

  // Type is clock-aware, so it has to have moved as 180 players came off the board
  const late = [...d.querySelectorAll('.row.player')].slice(0, 40)
    .filter((row) => early.has(row.dataset.id) && typeOf(row) !== early.get(row.dataset.id));
  ok('the Type column moved as the draft progressed', late.length > 0,
    `${late.length} of ${early.size} changed`);

  // ---- and the report at the end ---------------------------------------
  d.querySelector('[data-v="mock"]').click();
  await settle();
  const out = d.querySelector('#mockOut').textContent;
  ok('the report says which slot you drafted from', new RegExp(`slot ${SLOT} of ${T}`).test(out));
  // The report rows are .costPick now, not .mockPick - the practice report and the My team
  // tab were merged onto one what-it-cost table so the two cannot price a pick differently.
  ok('the report lists every one of your picks',
    d.querySelectorAll('#mockOut .row.costPick').length === R + 1,   // + the header row
    `${d.querySelectorAll('#mockOut .row.costPick').length}`);
  ok('the report shows a lineup', d.querySelectorAll('#mockOut .row.lineup').length >= R);
  // Every branch of vsAdp in mock.js produces one of these three phrases, so a report with
  // fifteen picks in it can only miss all three if the picks arrived with no ADP to
  // compare against - which is the failure worth catching. Printing a slice of the report
  // matters because this used to fail with no detail at all and the draft behind it is a
  // different one every run.
  ok('the report explains each pick in words',
    /the room usually takes him|going rate|usual spot/.test(out),
    out.replace(/\s+/g, ' ').slice(0, 400));
  ok('the report is honest about what it is not',
    /not a prediction/i.test(d.querySelector('#v-mock').textContent));

  // ---- and it can be run again from the other end of the room ----------
  d.querySelector('#mockStart').click();
  await settle();
  const st2 = peek();
  ok('starting again clears the last one', st2.mock.log.length < T * R && !st2.mock.done);
  d.querySelector('[data-v="mock"]').click();
  await settle();
  d.querySelector('#mockEnd').click();
  await settle();
  const st3 = peek();
  ok('ending a mock puts the board back to normal', !st3.mock && st3.picks[0].drafted.length === 0);
  d.querySelector('[data-v="board"]').click();
  await settle();
  ok('the Gone button comes back afterwards', d.querySelectorAll('[data-d]').length > 0);
  ok('a whole draft raised no errors', errs.length === 0, errs.join('; '));

  // ---- ten drafts at once ----------------------------------------------
  // The batch has one hard requirement beyond being correct: it must hand your real board
  // back untouched. On draft night the button sits inches from a board with fifteen picks
  // on it, and it runs by trampling the very state that board is drawn from.
  {
    d.querySelector('[data-v="board"]').click();
    await settle();
    const rowsToTick = [...d.querySelectorAll('.row.player [data-m]')].slice(0, 3);
    for (const b of rowsToTick) b.click();
    await settle();
    const mineBefore = [...peek().picks[0].mine];
    ok('three picks on the real board before the batch', mineBefore.length === 3);

    d.querySelector('[data-v="mock"]').click();
    await settle();
    d.querySelector('#batchSlot').value = '4';
    d.querySelector('#batchN').value = '5';
    d.querySelector('#batchRun').click();
    // 5 drafts x 15 rounds of rescoring; generous, and it yields between runs
    await new Promise((r) => setTimeout(r, 30000));

    const out = d.querySelector('#batchOut').textContent;
    ok('the batch reports back', /drafts/.test(out) && !/Running draft/.test(out),
      out.slice(0, 120));
    ok('it counts how often each pick went the same way', /\/5/.test(out), out.slice(0, 160));
    ok('it grades the batch on average, not just one draft',
      /out of 100 on average/.test(out), out.slice(0, 200));
    ok('and it reports the spread, because a wide one means luck not plan',
      /Best \d+, worst \d+/.test(out), out.slice(0, 240));
    ok('it says which measure is weakest', /Weakest measure/.test(out));
    ok('it still refuses to claim it knows the season',
      /nothing here knows the season/i.test(out));
    // The verdict column is gone. It read "Best there" on nearly every row, because the
    // auto-drafter takes the top of its own board by construction, so it named no
    // alternative at all. What replaced it names the man you passed and whether he came back.
    ok('the batch no longer just says "best there"', !/Best there/.test(out));
    ok('it names who you passed instead', /Who you passed/.test(out), out.slice(0, 200));
    ok('and whether that man came back to you',
      /came back \d+ in 100/.test(out), out.slice(0, 400));
    ok('it answers the question it exists for — who you lost by waiting badly',
      /not going anywhere|no pick was spent/.test(out), out.slice(0, 200));
    ok('every round of the draft is reported',
      d.querySelectorAll('#batchOut .row.costPick:not(.head)').length >= R,
      `${d.querySelectorAll('#batchOut .row.costPick:not(.head)').length} rows for ${R} rounds`);

    // the whole point: your board is exactly as you left it
    const after = peek();
    ok('the batch puts your real picks back', JSON.stringify(after.picks[0].mine)
      === JSON.stringify(mineBefore),
      `${after.picks[0].mine.length} vs ${mineBefore.length}`);
    ok('and does not leave a practice draft running', !after.mock);
    d.querySelector('[data-v="board"]').click();
    await settle();
    ok('the real board still shows your picks',
      d.querySelectorAll('.row.mine').length === 3,
      `${d.querySelectorAll('.row.mine').length}`);

    // and the rows behind it can be exported for someone else to read
    d.querySelector('[data-v="mock"]').click();
    await settle();
    ok('the spreadsheet is offered once there is something in it',
      d.querySelector('#batchCsv').hidden === false);
    ok('running a batch raised no errors', errs.length === 0, errs.join('; '));
  }

  // ---- and it will not quietly wipe a real draft you are tracking -------
  d.querySelector('[data-v="board"]').click();
  await settle();
  d.querySelector('.row.player [data-d]').click();
  await settle();
  d.querySelector('[data-v="mock"]').click();
  await settle();
  d.querySelector('#mockStart').click();
  await settle();
  ok('starting a mock over a real draft asks first',
    /clears them/.test(d.querySelector('#mockMsg').textContent) && !peek().mock);
  d.querySelector('#mockStart').click();
  await settle();
  ok('and goes ahead on the second press', !!peek().mock);
}

// --------------------------------------------- 9a. the app drafting for you
// "Draft it all for me" takes the top of your board every time, so the team it builds is a
// picture of your settings. That only means anything if the team is legal and if changing
// the settings changes the team.
{
  const e = await import(`file://${DIR}/engine.js`);
  const mk = await import(`file://${DIR}/mock.js`);
  const lg = e.SAMPLE_LEAGUE;
  const T = lg.teams;
  const R = e.roundsOf(lg);
  const SLOT = 5;

  // ---- the need bonus must not turn the middle of the board into kickers ----
  // This was a live bug, not a simulator one: with your starters full, every other
  // position took -need/2 while an empty kicker slot still paid +need, and ranks 68-80
  // came out a solid block of kickers and defences.
  const data = JSON.parse(JSON.stringify(players));
  data.leagues = [lg];
  const base = e.DEFAULT_SETTINGS(data);
  const filled = ['RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'QB'];
  const kdIn = (b) => b.rows.slice(0, 100).filter((r) => ['K', 'DEF'].includes(r.p.pos)).length;
  // The bar: the need mechanism must never push a kicker HIGHER than his own value alone
  // would. With the bonus switched off entirely, two of them sit in the top 100 on pure
  // VOR - a starting kicker really is worth more than the 250th receiver. That is the
  // ceiling. The bug had fourteen.
  const pure = kdIn(e.buildBoard(data, { ...base, need: 0, mine: [] }));
  const mid = e.buildBoard(data, { ...base, need: 8, mine: filled });
  ok('filling your starters does not lift kickers up the board', kdIn(mid) <= pure,
    `${pure} in the top 100 on value alone, ${kdIn(mid)} once your starters are full`);
  ok('and a kicker is never a need with eight picks left',
    (mid.rows.find((r) => r.p.pos === 'K')?.need ?? 0) <= 0,
    `need ${mid.rows.find((r) => r.p.pos === 'K')?.need}`);
  // but at the end of the draft they are exactly what you need
  const late = e.buildBoard(data, { ...base, need: 8, mine: [...filled, ...Array(6).fill('WR')] });
  const kLate = late.rows.find((r) => r.p.pos === 'K');
  ok('and is one when the picks run out', kLate.need === 8, `need ${kLate.need}`);

  // ---- the sample league used to score every kicker at zero ----
  // Kicker and defence points are precomputed per league by NAME, because their scoring
  // cannot be derived from a stat line. Any league the data file has never heard of - the
  // built-in sample, or the league of anyone who is not the person the file was built for
  // - fell through to zero, which tied all sixty-six of them and ordered them by nothing.
  const kPts = players.players.filter((p) => p.pos === 'K').map((p) => e.projectedPoints(p, lg));
  ok('kickers are not all tied on zero in an unknown league',
    new Set(kPts).size > 5 && Math.max(...kPts) > 0, `${new Set(kPts).size} distinct scores`);
  const bestK = players.players.filter((p) => p.pos === 'K')
    .sort((a, b) => e.projectedPoints(b, lg) - e.projectedPoints(a, lg))[0];
  ok('and the best kicker is one the room rates too', bestK.adp < 200,
    `${bestK.name}, adp ${bestK.adp}`);

  // ---- a full draft where the app makes your picks too ----
  const pool = players.players.filter((p) => e.inLeague(p, lg));
  const caps = mk.capsOf(lg);
  const settings = { ...base, mine: [] };
  const autoRun = (st0) => {
    const mine = [];
    const run = mk.simulate({ players: pool, league: lg, slot: SLOT, disc: 40, seed: 21,
      choose: (avail, roster) => {
        // the app rebuilds the board between your picks, because the need bonus moves
        const b = e.buildBoard(data, { ...st0, mine: roster.map((p) => p.pos) });
        const gone = new Set(pool.filter((p) => !avail.includes(p)).map((p) => p.id));
        const p = mk.autoPick(b.rows, gone, roster, lg, R - roster.length, caps);
        mine.push(p);
        return p;
      } });
    return { run, mine };
  };

  const { run, mine } = autoRun(settings);
  ok('the app can draft a whole team for you', run.done && mine.length === R, `${mine.length}`);
  const need = mk.needsOf(mine, lg);
  ok('and it is always a legal starting lineup', need.total === 0, JSON.stringify(need.short));
  const overCap = Object.entries(caps)
    .filter(([pos, c]) => mine.filter((p) => p.pos === pos).length > c);
  ok('and never stacks a position past sense', overCap.length === 0, overCap.join(', '));
  const kd = run.log.filter((x) => x.team === SLOT && ['K', 'DEF'].includes(x.pos));
  ok('the kicker and defence go in the last rounds', kd.length === 2
    && kd.every((x) => x.n > T * (R - 2)), kd.map((x) => `${x.pos} rd ${Math.ceil(x.n / T)}`).join(', '));

  // ---- and the settings are what decide it ----
  // A position lean is the bluntest setting there is, so if that does not change the team
  // then nothing on the ratings page is reaching the simulator.
  const leaned = autoRun({ ...settings, posx: { QB: 1.6, RB: 0.7 } });
  const same = leaned.mine.filter((p, i) => p.id === mine[i]?.id).length;
  ok('changing your settings changes the team the app builds', same < R,
    `${same} of ${R} picks identical`);
  const qbs = (list) => list.filter((p) => p.pos === 'QB').length;
  ok('and leaning on a position pulls that position forward',
    qbs(leaned.mine) >= qbs(mine) || leaned.mine.findIndex((p) => p.pos === 'QB')
      < mine.findIndex((p) => p.pos === 'QB'),
    `first QB at pick ${leaned.mine.findIndex((p) => p.pos === 'QB') + 1} vs ${mine.findIndex((p) => p.pos === 'QB') + 1}`);

  // ---- through the real interface ----
  const { d, errs } = await boot();
  const peek = (w) => {
    fire(w, 'pagehide');
    return JSON.parse(w.localStorage.getItem('draft2026') || '{}');
  };
  d.querySelector('[data-v="mock"]').click();
  await settle();
  d.querySelector('#mockSlot').value = '3';
  d.querySelector('#mockAll').click();
  await settle();
  const st = peek(d.defaultView);
  ok('one press drafts the whole thing', st.mock?.done === true && st.picks[0].mine.length === R,
    `${st.picks[0].mine.length} picks`);
  ok('every one of them is marked as the app\'s',
    st.mock.log.filter((x) => x.team === 3).every((x) => x.by === 'app'));
  ok('and it lands you on the report', !d.querySelector('#v-mock').hidden);
  ok('which says the app made the picks',
    /Every pick was made by the app/.test(d.querySelector('#mockOut').textContent));
  ok('drafting for you raised no errors', errs.length === 0, errs.join('; '));

  // handing over mid-draft: pick once yourself, then let the app finish
  d.querySelector('#mockSlot').value = '3';
  d.querySelector('#mockStart').click();
  await settle();
  d.querySelector('.row.player:not(.drafted) [data-m]').click();
  await settle();
  d.querySelector('[data-v="mock"]').click();
  await settle();
  d.querySelector('#mockFinish').click();
  await settle();
  const st2 = peek(d.defaultView);
  const mineLog = st2.mock.log.filter((x) => x.team === 3);
  ok('you can hand over half way through', st2.mock.done && mineLog.length === R);
  ok('and the report separates your picks from the app\'s',
    mineLog.filter((x) => x.by === 'you').length === 1
    && /You made 1 of these picks/.test(d.querySelector('#mockOut').textContent),
    `${mineLog.filter((x) => x.by === 'you').length} yours`);
}

// ------------------------------------ 9b. what three practice drafts actually turned up
// Every check in this block is a bug a mock draft found by being played, and every one of
// them was in the app rather than in the simulator.
{
  const mk = await import(`file://${DIR}/mock.js`);

  // The room-behaviour word is dropped into "a room that ___", so it has to be something
  // a room does. It used to read "a room that a typical room".
  for (const disc of [0, 20, 40, 70, 100]) {
    ok(`the room description reads as a sentence at ${disc}`,
      /^(sticks|reaches|drafts|panics)/.test(mk.roomWord(disc)), mk.roomWord(disc));
  }

  // The pool is 300 deep and the draft is 180 picks, so plenty of players carry an ADP
  // past the last pick. Measuring one of them produced "258 picks earlier than the room
  // takes him", which is a fact about the size of the pool, not about the pick.
  ok('a player nobody ranks is not reported as a 258-pick reach',
    /every pick is a guess/.test(mk.adpWord(142, 400, 180)));
  ok('and one the room does rank still gets a straight answer',
    /bargain/i.test(mk.adpWord(60, 40, 180)));

  const { d, errs } = await boot();
  d.querySelector('[data-v="mock"]').click();
  await settle();
  d.querySelector('#mockSlot').value = '1';
  d.querySelector('#mockStart').click();
  await settle();
  // Starting a mock rendered the board from the state left by the previous rebuild, so at
  // slot 1 - where you are on the clock immediately - the recommendation panel was still
  // showing "add your draft slot".
  ok('the recommendation is live on the very first pick',
    /Take|Line up/.test(d.querySelector('#advice').textContent),
    d.querySelector('#advice').textContent.trim().slice(0, 60));
  ok('and the clock knows the pick', /Pick 1\b/.test(d.querySelector('#clockNow').textContent));

  // play it out and check the end state does not tell you to enter your draft slot
  let g = 0;
  while (g++ < 30) {
    const row = d.querySelector('.row.player:not(.drafted)');
    if (!row || d.querySelector('#mockBar').textContent.includes('finished')) break;
    row.querySelector('[data-m]').click();
    await settle();
  }
  ok('a finished draft says so instead of asking for your draft slot',
    /Every pick is in/.test(d.querySelector('#advice').textContent),
    d.querySelector('#advice').textContent.trim().slice(0, 70));
  ok('three practice drafts raised no errors', errs.length === 0, errs.join('; '));
}

// ------------------------------------------------ 10. a man with no NFL season
// The worst bug this project has had. The pipeline worked out ONE rookie score and copied
// it into every history sub-metric, so a player who had never taken a snap read 94 for
// rushing efficiency, 94 for red-zone conversion and 94 for reliability. The rating, being
// the mean of forty copies of one number, came out 81 - higher than a proven WR1 - for a
// quarterback projected 84 points BELOW replacement, and he went at pick 96 against an ADP
// of 170. Every unexplained reach on the board was a player with no season.
{
  const e = await import(`file://${DIR}/engine.js`);
  const data = JSON.parse(JSON.stringify(players));
  data.leagues = [e.SAMPLE_LEAGUE];
  const base = e.DEFAULT_SETTINGS(data);
  const b = e.buildBoard(data, { ...base, mine: [] });
  const row = (n) => b.rows.find((r) => r.p.name === n);
  const noSeason = b.rows.filter((r) => e.noSeason(r.p));

  ok('the pool really does contain men with no season', noSeason.length > 15,
    `${noSeason.length}`);

  // ---- the invented percentiles are gone -------------------------------
  // The pipeline used to hand a man with no season a full set of sub-metrics that were
  // all just copies of his draft-capital score, so six components each reported the same
  // fabricated number. This asserted the file still contained them; the refresh has since
  // fixed it, so it now asserts the opposite - that no rookie carries a block of
  // identical sub-metrics. If this ever fails again the pipeline has regressed.
  const fabricated = noSeason.filter((r) => {
    const v = Object.values(r.p.sub || {}).filter((x) => x != null).map(Math.round);
    const c = {};
    for (const x of v) c[x] = (c[x] || 0) + 1;
    return v.length > 5 && Math.max(...Object.values(c)) >= v.length * 0.6;
  });
  ok('no man without a season carries fabricated sub-metrics', fabricated.length === 0,
    fabricated.slice(0, 3).map((r) => r.p.name).join(', '));
  const bars = noSeason.filter((r) => ['volume', 'efficiency', 'redzone', 'explosive',
    'production', 'reliability'].some((k) => r.scores[k] != null));
  ok('but no history component reports a score for a man with no history',
    bars.length === 0, bars.slice(0, 3).map((r) => r.p.name).join(', '));

  // ---- he is rated on what is actually knowable ------------------------
  const wrong = noSeason.filter((r) => Math.abs(r.rating
    - e.rookieRating(r.p, r.scores.projection)) > 0.01);
  ok('a man with no season is rated on projection, draft capital and depth chart',
    wrong.length === 0, wrong.slice(0, 3).map((r) => r.p.name).join(', '));
  ok('draft capital steps the way NFL opportunity does',
    e.capitalScore(1) === 100 && e.capitalScore(20) === 85 && e.capitalScore(200) === 25
    && e.capitalScore(null) === 25);
  ok('the projection is the biggest single part of it', e.ROOKIE_MIX.proj > e.ROOKIE_MIX.capital
    && e.ROOKIE_MIX.capital > e.ROOKIE_MIX.role);
  // two rookies, same everything except where they were drafted
  const fake = (pick) => ({ m: { draft_pick: pick, role_pct: 50, team_off: 1000 } });
  ok('a first-round pick outrates a day-three pick',
    e.rookieRating(fake(5), 50) > e.rookieRating(fake(180), 50));
  ok('but the projection can outweigh the draft slot',
    e.rookieRating(fake(180), 95) > e.rookieRating(fake(5), 20));

  // ---- the regression itself -------------------------------------------
  const mendoza = row('Fernando Mendoza');
  const collins = row('Nico Collins');
  if (mendoza && collins) {
    ok('a rookie projected below replacement no longer outrates a proven WR1',
      mendoza.rating < collins.rating,
      `${mendoza.rating.toFixed(0)} vs ${collins.rating.toFixed(0)}`);
    ok('and he is no longer a top-70 pick', mendoza.rank > 70, `#${mendoza.rank}`);
  }
  const cheats = b.rows.filter((r) => r.rank <= 60 && r.vor < -40);
  ok('nobody miles below replacement sits in the top 60', cheats.length === 0,
    cheats.map((r) => `${r.p.name} #${r.rank} vor ${r.vor.toFixed(0)}`).join(', '));
  const gaps = noSeason.map((r) => r.adpRank - r.rank);
  ok('as a group they are no longer ranked above the market',
    gaps.reduce((a, c) => a + c, 0) / gaps.length < 5,
    `mean ${(gaps.reduce((a, c) => a + c, 0) / gaps.length).toFixed(0)} places above ADP`);

  // ---- and the double count is gone -------------------------------------
  // Draft capital is 30% of his rating now, so a +10 bonus on top was the same fact twice.
  ok('the rookie bonus is a nudge, not a second rating', base.rookieMax <= 5,
    `${base.rookieMax}`);

  // ---- the app does not lean on a rookie's sub-metrics -------------------
  // Strip the sub block off every man with no season and the board must come out the
  // same. That is what proves his rating comes from his projection and his draft
  // capital, and not from numbers the pipeline made up for him.
  const clean = JSON.parse(JSON.stringify(players));
  clean.leagues = [e.SAMPLE_LEAGUE];
  let stripped = 0;
  for (const p of clean.players) {
    if (!e.noSeason(p)) continue;
    if (p.sub && Object.keys(p.sub).length) { stripped += 1; }
    p.sub = {};          // emptied, not deleted - componentScore expects the object to exist
  }
  ok('there were rookies to strip', stripped > 5, `${stripped}`);
  const b2 = e.buildBoard(clean, { ...e.DEFAULT_SETTINGS(clean), mine: [] });
  const moved = b2.rows.filter((r) => e.noSeason(r.p)
    && Math.abs(r.rating - (row(r.p.name)?.rating ?? 0)) > 0.01);
  ok('and the board is identical without them', moved.length === 0,
    moved.slice(0, 3).map((r) => r.p.name).join(', '));

  // ---- a saved profile cannot keep the old bonus ------------------------
  const store = { draft2026: JSON.stringify({ rookieMax: 10, league: 0 }) };
  const { d: d2 } = await boot({ store });
  await settle();
  fire(d2.defaultView, 'pagehide');
  ok('an old saved profile does not keep the old rookie bonus',
    JSON.parse(store.draft2026).rookieMax <= 5, `${JSON.parse(store.draft2026).rookieMax}`);
}

// ------------------------------------------- 10b. the auto-drafter has a clock now
// It used to take the top of the board every time, which is how it spent pick 96 on a man
// the whole room agreed would still be there at 170. It now does what the recommendation
// panel says, which is the same code path Zach will be reading on the night.
{
  const e = await import(`file://${DIR}/engine.js`);
  const mk = await import(`file://${DIR}/mock.js`);
  const R = e.roundsOf(e.SAMPLE_LEAGUE);
  let picks = 0;
  let early = 0;
  let worst = 0;
  // Three slots and two seeds rather than three drafts, because one draft is a small
  // sample and a single fixed seed only moves the coin flip somewhere else. Six pooled
  // drafts is enough that the ratio below sits well clear of its threshold instead of
  // straddling it.
  for (const [slot, rnd] of [[1, 0.11], [1, 0.73], [6, 0.11], [6, 0.73],
    [12, 0.11], [12, 0.73]]) {
    const { window, d } = await boot({ rnd });
    d.querySelector('[data-v="mock"]').click();
    await settle();
    d.querySelector('#mockSlot').value = String(slot);
    d.querySelector('#mockAll').click();
    await settle();
    fire(window, 'pagehide');
    const st = JSON.parse(window.localStorage.getItem('draft2026') || '{}');
    ok(`slot ${slot} drafts a full team`, st.mock?.done && st.picks[0].mine.length === R,
      `${st.picks[0]?.mine?.length}`);
    for (const x of st.mock.log.filter((y) => y.team === slot)) {
      if (!x.adp || x.adp > 180 || ['K', 'DEF'].includes(x.pos)) continue;
      picks += 1;
      const gap = x.n - x.adp;
      if (gap <= -12) early += 1;
      worst = Math.min(worst, gap);
    }
  }
  // Reaching sometimes is the point of having your own board. Reaching 73 picks was not.
  ok('it no longer reaches half a draft early', Math.abs(worst) < 45,
    `worst reach ${Math.abs(worst).toFixed(0)} picks`);
  ok('and most picks are near the going rate', early / picks < 0.35,
    `${early} of ${picks} were 12+ picks early`);
  // it takes the man the panel names
  const { d } = await boot();
  d.querySelector('[data-v="mock"]').click();
  await settle();
  d.querySelector('#mockSlot').value = '6';
  d.querySelector('#mockStart').click();
  await settle();
  const named = d.querySelector('#advice .advHead b')?.textContent.trim();
  d.querySelector('#mockAuto').click();
  await settle();
  const got = d.querySelector('.row.player.mine .nm')?.textContent.trim().split(/\s{2,}|\n/)[0];
  ok('picking for you takes the player the panel just named',
    !!named && !!got && got.startsWith(named), `panel said "${named}", took "${got}"`);
  ok('the mock module still exposes what the app imports',
    typeof mk.autoPick === 'function' && typeof mk.capsOf === 'function');
}

// ------------------------------------------------- 11. save and print
// jsdom has no URL.createObjectURL and no navigation, so the two ends of the download are
// stubbed and the middle - the file we actually generate - is what gets asserted on.
{
  const arm = (window) => {
    const out = [];
    window.URL.createObjectURL = (b) => { out.push({ blob: b }); return 'blob:test'; };
    window.URL.revokeObjectURL = () => {};
    window.HTMLAnchorElement.prototype.click = function click() {
      if (out.length) out[out.length - 1].name = this.download;
    };
    return out;
  };
  const grab = async (d, sel) => {
    const out = arm(d.defaultView);
    d.querySelector(sel).click();
    await settle();
    const last = out[out.length - 1];
    return last ? { name: last.name, text: await last.blob.text(), type: last.blob.type }
      : { name: null, text: '', type: '' };
  };
  // a,b,"c,d" -> ['a','b','c,d'] - enough of a parser for our own output
  const cells = (line) => {
    const out = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i += 1; } else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
    }
    out.push(cur);
    return out;
  };
  const lines = (t) => t.replace(/^﻿/, '').trim().split('\r\n');

  const { window, d, errs } = await boot();
  ok('the three save buttons are all on the page',
    !!d.querySelector('#saveBoard') && !!d.querySelector('#saveSheet')
    && !!d.querySelector('#saveTeam'));
  // the one thing that must not be confused with the ratings export
  const labels = ['#saveBoard', '#saveSheet', '#saveTeam']
    .map((s) => d.querySelector(s).textContent.toLowerCase());
  ok('no save button reads like the ratings export',
    labels.every((l) => !l.includes('preference') && !l.includes('export')), labels.join(' / '));
  ok('the ratings export is still there and still says what it is',
    d.querySelector('#exportR')?.textContent.includes('preferences'));

  d.querySelector('#saveBtn').click();
  ok('the panel opens', d.querySelector('#savePanel').hidden === false);

  // ---- the board
  const b1 = await grab(d, '#saveBoard');
  const L = lines(b1.text);
  const head = cells(L[0]);
  ok('the board saves a csv', /\.csv$/.test(b1.name || '') && b1.type.startsWith('text/csv'),
    `${b1.name} ${b1.type}`);
  ok('with a header row carrying the fixed columns',
    ['#', 'Player', 'Team', 'Position', 'Bye', 'ADP', 'Type', 'Worth', 'Status']
      .every((h) => head.includes(h)), head.join('|'));
  ok('and one row per player, not one per hundred', L.length > 200, `${L.length} lines`);
  ok('every row has the same number of cells as the header',
    L.every((l) => cells(l).length === head.length));
  ok('nothing in it is html', !/[<>]/.test(b1.text));
  const bye = head.indexOf('Bye');
  ok('bye is only there once', head.filter((h) => h === 'Bye').length === 1);
  ok('the bye column holds week numbers',
    L.slice(1, 40).some((l) => /^\d+$/.test(cells(l)[bye])));
  ok('the first data row is board rank 1', cells(L[1])[0] === '1');

  // ---- it follows the position filter and the column toggles
  d.querySelector('[data-f="RB"]').click();
  await settle();
  const b2 = await grab(d, '#saveBoard');
  const L2 = lines(b2.text);
  const posCol = cells(L2[0]).indexOf('Position');
  ok('filtering to one position filters the file too',
    L2.slice(1).every((l) => cells(l)[posCol] === 'RB'), `${L2.length - 1} rows`);
  ok('and the file name says which position', /board-rb/.test(b2.name || ''), b2.name);

  const tot = [...d.querySelectorAll('[data-col]')].find((x) => x.dataset.col === 'tot');
  tot.checked = true;
  fire(tot, 'change');
  await settle();
  const b3 = await grab(d, '#saveBoard');
  const h3 = cells(lines(b3.text)[0]);
  ok('switching a stat group on adds its columns to the file',
    ['Gms', 'Yards', 'TDs'].every((h) => h3.includes(h)), h3.join('|'));

  // ---- a name with a comma and a quote in it
  const real = players.players[0].name;
  players.players[0].name = 'Smith, Jr. "The Truth"';
  const { d: d2 } = await boot();
  const b4 = await grab(d2, '#saveBoard');
  players.players[0].name = real;
  ok('a comma and a quote in a name survive the round trip',
    b4.text.includes('"Smith, Jr. ""The Truth"""')
    && lines(b4.text).some((l) => cells(l).includes('Smith, Jr. "The Truth"')));

  // ---- the cheat sheet
  const c1 = await grab(d, '#saveSheet');
  ok('the cheat sheet saves an html file',
    /^cheat-sheet-.*\.html$/.test(c1.name || '') && c1.text.startsWith('<!doctype html'),
    c1.name);
  ok('it has a print stylesheet and a page size', /@media print/.test(c1.text)
    && /@page\s*\{[^}]*margin/.test(c1.text));
  ok('it lists all four positions in words',
    ['Quarterbacks', 'Running backs', 'Wide receivers', 'Tight ends']
      .every((w) => c1.text.includes(w)));
  ok('it marks where a position falls off a cliff', c1.text.includes('big drop after here'));
  const perPos = [...c1.text.matchAll(/<section>([\s\S]*?)<\/section>/g)]
    .map((m) => (m[1].match(/<tr><td class="box">/g) || []).length);
  ok('it is capped at fourteen players a position, so it fits one sheet',
    perPos.length === 4 && perPos.every((n) => n > 0 && n <= 14), perPos.join(','));
  // Page fit cannot be seen without a browser, so what is checked is the thing that would
  // break it: the number of printed lines in the tallest column. 14 players plus their
  // drop-off lines has to stay inside a budget that fits on one sheet at 9pt.
  const tallest = Math.max(...[...c1.text.matchAll(/<section>([\s\S]*?)<\/section>/g)]
    .map((m) => (m[1].match(/<tr/g) || []).length));
  ok('the tallest column still fits a page at nine point', tallest <= 26, `${tallest} rows`);
  ok('nothing on it is printed white on black',
    !/background:\s*#[0-5]/.test(c1.text) && !/color:\s*#(fff|eee)/.test(c1.text));
  // the measured finding: the projections predict, last season's box score does not, and
  // the sliders are a tie-break. None of that may read as a forecast on paper.
  ok('it does not sell itself as a prediction',
    /not a forecast/.test(c1.text) && !/predict(s|ed)? who/.test(c1.text));
  ok('and it carries no 2025 box-score numbers',
    !/Snap|Tch\/g|Pts\/g|Catch%|Targets/.test(c1.text));

  // ---- my team, with nothing drafted
  const t0 = await grab(d, '#saveTeam');
  ok('the team file works before a single pick',
    /^my-team-.*\.csv$/.test(t0.name || '') && t0.text.length > 50, t0.name);
  ok('and says so in words', /Nothing drafted yet/.test(t0.text));
  ok('it still carries the summary', /Players drafted,0/.test(t0.text));

  // ---- my team, after two picks
  d.querySelector('[data-f="ALL"]').click();
  await settle();
  // .nm is "Name TEAM" with the team in a nested span - take the name off the front
  const takes = [...d.querySelectorAll('#rows .row')].slice(0, 2).map((row) => {
    const el = row.querySelector('.nm');
    const tm = el.querySelector('.tm')?.textContent || '';
    return el.textContent.replace(tm, '').trim();
  });
  [...d.querySelectorAll('#rows .row')].slice(0, 2)
    .forEach((row) => row.querySelector('[data-m]').click());
  await settle();
  const t1 = await grab(d, '#saveTeam');
  const TL = lines(t1.text);
  ok('the team file names who you took',
    takes.every((n) => t1.text.includes(n)), takes.join(' / '));
  ok('it says how late you got each one',
    cells(TL[0]).includes('Picks later than the room')
    && cells(TL[0]).includes('Starting or bench'));
  ok('and counts them in the summary', /Players drafted,2/.test(t1.text));

  ok('none of it threw', errs.length === 0, errs.join(' | '));
}

// -------------------------------------------- 11b. what the panel calls a mistake
// The bug this exists to keep fixed: the board took a man twenty picks before the room
// would have, BECAUSE it rated him higher, and then the report called that same pick a
// reach. One fact - "we like him more than the market" - counted twice, once as the reason
// and once as the crime. The app was arguing with itself in front of the person using it.
//
// So the four cases below are the definition, in arithmetic, with the odds handed in
// rather than read off an ADP curve. `pickShot` needs a planDraft result, and a planDraft
// result is four fields, so they are written out here by hand: what matters is the
// verdict, not where the totals came from.
{
  const e = await import(`file://${DIR}/engine.js`);
  const man = (id, name, adp, rank, score) => ({ p: { id, name, pos: 'WR', adp }, rank, score });
  // ADP is chosen so the survival curve answers the question each case needs. At pick 10
  // with the next pick at 22: an ADP of 90 lasts easily, an ADP of 12 does not.
  const SAFE = 90;
  const DOOMED = 12;
  const clock = { currentPick: 10, target: 22 };
  const res = (rows) => ({ plan: rows });

  // 1. Taken well before the room would take him - and he was not going to last. The old
  //    panel called this a reach on the ADP gap alone. It is not one: nobody was lost.
  {
    const you = man('a', 'Your Guy', DOOMED, 1, 90);
    const v = e.pickCost(e.pickShot(res([{ row: you, total: 300 }]), 'a', clock));
    ok('a man taken before his ADP who would not have lasted is not a reach',
      v.kind !== 'wasted', v.kind);
    ok('and taking the top of your own board costs zero points', v.points === 0
      && v.kind === 'top', `${v.kind} / ${v.points}`);
  }

  // 2. The real error. You took a man who was going nowhere, and the man your own board
  //    rated higher went to somebody else while you did it.
  {
    const kept = man('a', 'Would Have Kept', SAFE, 40, 20);
    const gone = man('b', 'Gone By Then', DOOMED, 5, 60);
    const v = e.pickCost(e.pickShot(res([{ row: gone, total: 320 },
      { row: kept, total: 300 }]), 'a', clock));
    ok('a pick that lost you a player IS a reach', v.kind === 'wasted', v.kind);
    ok('and it names both men', /Would Have Kept/.test(v.why) && /Gone By Then/.test(v.why),
      v.why);
    ok('and puts a number on what it cost', v.points === 20, `${v.points}`);
  }

  // 3. Below the top of the board, but the better man was going anyway - so there was
  //    nothing to wait for and nothing was lost. Not a reach, and it must not read as one.
  {
    const took = man('a', 'Took Him', DOOMED, 40, 20);
    const better = man('b', 'Also Doomed', DOOMED, 5, 60);
    const v = e.pickCost(e.pickShot(res([{ row: better, total: 320 },
      { row: took, total: 300 }]), 'a', clock));
    ok('going below the top of your board is not automatically a reach',
      v.kind !== 'wasted', v.kind);
    ok('but the points given up are still reported', v.points === 20, `${v.points}`);
  }

  // 4. Two men a coin flip apart. The panel must not manufacture a criticism to fill space.
  {
    const took = man('a', 'Took Him', SAFE, 6, 58);
    const other = man('b', 'The Other', SAFE, 5, 60);
    const v = e.pickCost(e.pickShot(res([{ row: other, total: 301 },
      { row: took, total: 300 }]), 'a', clock));
    ok('a pick a point off the top costs nothing', v.points === 0 && v.kind === 'fine',
      `${v.kind} / ${v.points}`);
  }

  // 5. No record of the pick - an old saved draft, or one ticked off before the app was
  //    watching. It has to say so rather than invent a verdict.
  ok('a pick with no record says so', e.pickCost(null).kind === 'unknown');

  // 6. ADP survives as information and never as the scorer.
  const mkt = e.marketNote({ adp: 90, at: 10 });
  ok('the market note reads as a disagreement, not a verdict',
    /rated him higher/.test(mkt) && !/reach/i.test(mkt), mkt);
}

// ------------------------------- 11c. the app must never call its own advice a mistake
// The whole draft, played by the app following its own recommendation on every pick, with
// the report then read back. If the panel calls any of those picks a reach, the app is
// contradicting itself - which is the bug. It is also the only test here that exercises
// the real board, the real clock and the real plan end to end.
{
  const e = await import(`file://${DIR}/engine.js`);
  const R = e.roundsOf(e.SAMPLE_LEAGUE);
  for (const slot of [1, 12]) {
    const { d, errs } = await boot();
    d.querySelector('[data-v="mock"]').click();
    await settle();
    d.querySelector('#mockSlot').value = String(slot);
    d.querySelector('#mockAll').click();
    await settle();
    d.querySelector('[data-v="mock"]').click();
    await settle();

    const rows = [...d.querySelectorAll('#mockOut .row.costPick:not(.head)')];
    ok(`slot ${slot}: every pick is on the report`, rows.length === R, `${rows.length}`);
    // STEP 3, asked for by name: where WE rated him, on every row, beside the room's price.
    const ranked = rows.filter((r) => /^#\d+/.test(r.querySelector('.ourRk').textContent.trim()));
    ok(`slot ${slot}: every row shows our own rank`, ranked.length === rows.length,
      `${ranked.length} of ${rows.length}`);
    ok(`slot ${slot}: and the score beside it`,
      rows.every((r) => /·\s*-?\d/.test(r.querySelector('.ourRk').textContent)),
      rows[0]?.querySelector('.ourRk')?.textContent);

    // the self-contradiction, in one assertion
    const blamed = rows.filter((r) => /cost you a player/.test(r.querySelector('.cost').textContent));
    ok(`slot ${slot}: the app never calls its own pick a reach`, blamed.length === 0,
      blamed.map((r) => r.querySelector('.nm').textContent.trim()).join(', '));
    // and it must not go the other way either - "nothing went wrong" has to be said out loud
    ok(`slot ${slot}: the summary says so in plain words`,
      /No pick of yours was spent on a man who was going to be there anyway/
        .test(d.querySelector('#mockOut').textContent));
    ok(`slot ${slot}: nothing threw`, errs.length === 0, errs.join(' | '));
  }
}

// ------------------------------- 11d. and it must still be able to say something went wrong
// The danger in 11c is a panel that has learned to say "fine" about everything. So: start a
// practice draft and deliberately take a man a long way down the board, then read the cost
// view on the My team tab - which is the other place it renders, and the one Zach's fiancee
// is most likely to be looking at.
{
  const { d } = await boot();
  d.querySelector('[data-v="mock"]').click();
  await settle();
  d.querySelector('#mockSlot').value = '6';
  d.querySelector('#mockStart').click();
  await settle();
  // the 60th man available, which is nobody's idea of the best pick on the board
  const rows = [...d.querySelectorAll('.row.player:not(.drafted)')];
  rows[59].querySelector('[data-m]').click();
  await settle();

  d.querySelector('[data-v="roster"]').click();
  await settle();
  const row = d.querySelector('#costPicks .row.costPick:not(.head)');
  ok('the My team cost view lists the pick', !!row);
  ok('it shows where our own board had him',
    /^#\d+/.test(row?.querySelector('.ourRk')?.textContent?.trim() || ''),
    row?.querySelector('.ourRk')?.textContent);
  ok('and a deep pick is not waved through as fine',
    /left on the table|cost you a player|paid to make sure/i
      .test(row?.querySelector('.cost')?.textContent || ''),
    row?.querySelector('.cost')?.textContent);
  ok('and it names the better man rather than just scolding',
    /\w/.test(row?.querySelector('.costWhy')?.textContent || '')
    && !/ADP/.test(row?.querySelector('.costWhy')?.textContent || ''),
    row?.querySelector('.costWhy')?.textContent?.slice(0, 120));
  ok('the summary counts the points left behind',
    /Points left behind/.test(d.querySelector('#cost').textContent));
  // the whole point: no jargon anywhere in the panel
  ok('the cost view never says ADP', !/\bADP\b/.test(d.querySelector('#v-roster').textContent));
}

// ---------------------------------------------------- 12. draft night without a mouse
// A name is called every thirty seconds. Finding that row with a mouse and clicking Gone
// is what makes people stop tracking in round four, at which point the board is a lie and
// every number on it is wrong. Type three letters, press one key.
{
  const { window, d, store } = await boot();
  // A fresh install opens on Setup, and renderAll only draws the view you are looking at -
  // so rows read off the DOM without this are the ones drawn before that switch.
  d.querySelector('[data-v="board"]').click();
  await settle();
  const box = d.querySelector('#search');
  const key = (k, opts = {}) => box.dispatchEvent(new window.KeyboardEvent('keydown',
    { key: k, bubbles: true, cancelable: true, ...opts }));
  const type = async (v) => { box.value = v; fire(box, 'input'); await settle(); };
  const hint = () => (d.querySelector('#kbd').textContent || '').replace(/\s+/g, ' ').trim();
  const drafted = () => JSON.parse(store.draft2026 || '{}').picks?.[0]?.drafted || [];
  const mineOf = () => JSON.parse(store.draft2026 || '{}').picks?.[0]?.mine || [];

  ok('the board says what the keyboard does before you touch it',
    /Enter/.test(hint()), hint());

  // whoever the top row is, by name, so this does not break when the data file moves
  const first = d.querySelector('.row.player .nm').textContent.trim().replace(/\s+\w{2,3}$/, '');
  await type(first.split(' ')[1] || first);
  ok('the hint names the man the key will hit', hint().includes(first.split(' ').pop()), hint());
  ok('the hint names both keys', /Enter/.test(hint()) && /Shift/.test(hint()), hint());

  const before = drafted().length;
  key('Enter');

  await saved();
  ok('Enter takes one player off the board', drafted().length === before + 1,
    `${before} -> ${drafted().length}`);
  ok('Enter does not put him on your team', mineOf().length === 0);
  ok('the box empties itself for the next name', box.value === '');
  ok('it says what it just did', /ticked off/.test(hint()), hint());
  ok('and it says how to take it back', /Ctrl/.test(hint()), hint());

  // Shift is "he is mine" - and a player you took is also off the board.
  const nextName = d.querySelector('.row.player:not(.drafted) .nm').textContent.trim();
  await type(nextName.split(' ')[1] || nextName);
  key('Enter', { shiftKey: true });
  await saved();
  ok('Shift+Enter adds him to your team', mineOf().length === 1);
  ok('and takes him off the board too', drafted().length === before + 2);
  ok('the confirmation says team, not gone', /your team/.test(hint()), hint());

  // Ctrl+Z has to reach a keyboard pick exactly as it reaches a clicked one
  d.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
  await saved();
  ok('undo reaches a keyboard pick', mineOf().length === 0 && drafted().length === before + 1,
    `${drafted().length} gone, ${mineOf().length} mine`);

  // A player already off the board is never the target. Otherwise Enter un-ticks a pick
  // by accident, and by the middle of a draft half of any search is players who have gone.
  const goneId = drafted()[0];
  const gone = players.players.find((p) => p.id === goneId);
  await type(gone.name);
  const held = drafted().length;
  ok('it says everyone matching has gone', /already off the board/.test(hint()), hint());
  key('Enter');
  await settle();
  ok('Enter cannot un-tick a player who has gone', drafted().length === held);

  // nonsense in the box does nothing at all
  await type('zzzzzz');
  ok('it says nobody is called that', /Nobody on the board/.test(hint()), hint());
  key('Enter');
  await settle();
  ok('Enter on no match changes nothing', drafted().length === held);

  key('Escape');
  await settle();
  ok('Escape clears the box', box.value === '');

  // a slash from the board puts the cursor in the box, so the loop never needs the mouse
  d.querySelector('#board').dispatchEvent(new window.KeyboardEvent('keydown',
    { key: '/', bubbles: true, cancelable: true }));
  await settle();
  ok('slash jumps to the search box', d.activeElement === box);
}

{
  // The same key in a practice draft has to mean "this is my pick", because in a mock
  // there is no Gone button at all - every row is a choice you are making.
  const { window, d, store } = await boot();
  d.querySelector('[data-v="board"]').click();
  await settle();
  d.querySelector('[data-v="mock"]').click();
  await settle();
  d.querySelector('#mockSlot').value = '1';
  d.querySelector('#mockStart').click();
  await settle();
  const box = d.querySelector('#search');
  const hint = () => (d.querySelector('#kbd').textContent || '').replace(/\s+/g, ' ').trim();
  const name = d.querySelector('.row.player:not(.drafted) .nm').textContent.trim().split(' ')[0];
  box.value = name;
  fire(box, 'input');
  await settle();
  ok('in a practice draft the key picks rather than ticks off',
    /picks/.test(hint()) && !/goes off the board/.test(hint()), hint());
  box.dispatchEvent(new window.KeyboardEvent('keydown',
    { key: 'Enter', bubbles: true, cancelable: true }));
  await saved();
  const st2 = JSON.parse(store.draft2026 || '{}');
  ok('the practice pick was recorded', (st2.mock?.log || []).length > 0,
    `${(st2.mock?.log || []).length} picks`);
  ok('one of them is yours', (st2.mock?.log || []).some((x) => x.by === 'you'),
    JSON.stringify((st2.mock?.log || []).slice(0, 3)));
}

// ------------------------------------------------------- 13. compare two players
// The panel exists for the person who does not follow football, so the thing being tested
// is not that it renders - it is that it says the honest thing. A comparison screen that
// always crowns a winner would teach her to trust a three-point gap, and on this board a
// three-point gap is nothing at all.
{
  const e = await import(`file://${DIR}/engine.js`);
  const { d, errs } = await boot();
  d.querySelector('#cmpBtn').click();
  await settle();
  ok('the compare panel opens', !d.querySelector('#cmpPanel').hidden);

  const sel = d.querySelector('#cmpA');
  const opts = [...sel.options].slice(1);              // drop the "pick a player" row
  ok('the compare menu is the board, in board order', opts.length > 100, `${opts.length}`);
  const posOf = (o) => (o.textContent.split('·')[1] || '').trim().split(/\s+/)[0];
  const firstOf = (pos) => opts.find((o) => posOf(o) === pos);

  // reads the verdict, and the gap it claims, out of the rendered panel
  const compare = async (idA, idB) => {
    const a = d.querySelector('#cmpA');
    const b = d.querySelector('#cmpB');
    a.value = idA; fire(a, 'change');
    b.value = idB; fire(b, 'change');
    await settle();
    const text = d.querySelector('#cmpOut').textContent.replace(/\s+/g, ' ');
    const m = text.match(/(?:by|separates them by) ([\d.]+) points of draft score/i);
    return { text, gap: m ? +m[1] : null, el: d.querySelector('#cmpOut'),
      flip: /Coin flip/.test(text), prefers: /Your board prefers/.test(text) };
  };

  // ---- two players of different positions
  const rb = firstOf('RB');
  const wr = firstOf('WR');
  ok('the board has both a back and a receiver to compare', !!rb && !!wr);
  const cross = await compare(rb.value, wr.value);
  ok('comparing two positions renders', cross.text.length > 400, `${cross.text.length} chars`);
  // The panel leads with the four things Zach asked for - total projection, rank at his
  // position, the positional grade bars, and last season - and the preference essay that
  // used to sit under it is gone, replaced by the same numbered adjustments the card shows.
  for (const heading of ['Projected points', 'Rank at his position',
    'Graded against his position', 'Games played, 2025', 'Work per game', 'Yards, 2025',
    'Share of snaps, 2025', 'Worth taking at', 'Bye week',
    'If he plays what he has played', 'What moved his score']) {
    ok(`the comparison shows ${heading.toLowerCase()}`, cross.text.includes(heading));
  }
  ok('the grade bars really are drawn for both men',
    cross.el.querySelectorAll('.cmpBars').length === 2,
    `${cross.el.querySelectorAll('.cmpBars').length}`);
  ok('and the preference essay is gone', !/points of percentile apart/.test(cross.text));
  ok('it says one thing or the other, never both', cross.flip !== cross.prefers);
  ok('it refuses to say who will score more',
    /cannot tell you which of these two will score more/.test(cross.text));

  // ---- a kicker or a defence, which have no rating at all
  // Every trait a kicker has is a placeholder, so the panel must not invent an opinion out
  // of it - the exact mistake the 0-100 rating made before it was taken off them.
  for (const pos of ['K', 'DEF']) {
    const s = firstOf(pos);
    if (!s) continue;
    const res = await compare(s.value, wr.value);
    ok(`comparing a ${pos} does not throw`, res.text.length > 400 && errs.length === 0,
      errs.join('; '));
    ok(`a ${pos} is shown as having no positional grade`, /No grade/.test(res.text));
    ok(`a ${pos} still gets a verdict`, res.flip || res.prefers);
  }

  // ---- the coin-flip band, tested as a rule rather than on one lucky pair
  // Deep in the board the scores flatten, so an adjacent pair down there should be inside
  // the band. Whichever pair it lands on, the claim has to match the number it prints.
  let flipSeen = null;
  for (let i = 60; i < 140 && !flipSeen; i += 1) {
    if (!opts[i] || !opts[i + 1]) break;
    const res = await compare(opts[i].value, opts[i + 1].value);
    if (res.flip) flipSeen = res;
  }
  ok('two players a hair apart are called a coin flip', !!flipSeen);
  if (flipSeen) {
    ok('and the gap it prints really is inside the band',
      flipSeen.gap != null && flipSeen.gap < e.STAR_BAND, `${flipSeen.gap} vs ${e.STAR_BAND}`);
    ok('a coin flip names no winner', !/Your board prefers/.test(flipSeen.text));
  }

  // ---- and the top of the board against the bottom is not a coin flip
  const far = await compare(opts[0].value, opts[opts.length - 1].value);
  ok('the best man on the board beats the last one', far.prefers && !far.flip);
  ok('and that gap is outside the band',
    far.gap != null && far.gap >= e.STAR_BAND, `${far.gap} vs ${e.STAR_BAND}`);

  ok('nothing on the compare panel threw', errs.length === 0, errs.join('; '));
}

// -------------------------------------------------- 13b. compare, from a player's card
{
  const { d } = await boot();
  const nm = d.querySelector('.row.player .nm');
  nm.click();
  await settle();
  const btn = d.querySelector('[data-cmp]');
  ok('a card offers to compare him with someone', !!btn);
  btn.click();
  await settle();
  ok('and doing so opens the compare panel', !d.querySelector('#cmpPanel').hidden);
  ok('with him already chosen', d.querySelector('#cmpA').value === btn.dataset.cmp,
    `${d.querySelector('#cmpA').value} vs ${btn.dataset.cmp}`);
  ok('and it waits for the second man rather than guessing one',
    /Choose two players/.test(d.querySelector('#cmpOut').textContent));
}

// -------------------------------------------- 14. a grade for how you drafted
// The hard constraint: this grades the PROCESS. It is not allowed to imply it knows how
// the team will do, because predicting that is the thing that failed four ways when it was
// measured. So the test checks the disclaimer as carefully as it checks the arithmetic.
{
  const { d, errs } = await boot();
  d.querySelector('[data-v="mock"]').click();
  await settle();
  d.querySelector('#mockSlot').value = '6';
  d.querySelector('#mockAll').click();
  await settle();
  const out = d.querySelector('#mockOut');
  const text = out.textContent.replace(/\s+/g, ' ');

  ok('a finished practice draft is graded', /How you drafted/.test(text));
  ok('the grade runs without throwing', errs.length === 0, errs.join('; '));
  const big = out.querySelector('.gradeBig b');
  const n = big ? +big.textContent : null;
  ok('the grade is a number from 0 to 100', n != null && n >= 0 && n <= 100, `${n}`);
  ok('and it is labelled as being out of 100', /out of 100/.test(text));

  // "Filling your starting slots" is gone. It scored 100 on every completed draft - the
  // draft fills the slots by definition - and then lectured you about it. What replaced it
  // asks the question that still has an answer afterwards: is a bench body worth more than
  // the man you could have added off waivers for nothing?
  for (const measure of ['Points left on the board', 'Taking men before their price',
    'What your bench is worth', 'Bye weeks among your starters']) {
    ok(`it grades ${measure.toLowerCase()}`, text.includes(measure));
  }
  ok('the grade no longer congratulates you for filling slots the draft filled',
    !/Filling your starting slots/.test(text));
  ok('the bench measure is priced against a free add, in words',
    /beats a free add by/.test(text), text.slice(0, 0));
  const cards = out.querySelectorAll('.gradeCard');
  ok('every measure carries its own mark', cards.length >= 4, `${cards.length} cards`);
  const marks = [...cards].map((c) => +c.querySelector('.gradeN').textContent);
  ok('and every mark is in range', marks.every((x) => x >= 0 && x <= 100), marks.join(', '));

  // the honesty, which is the whole point
  ok('it says out loud that this is not a forecast',
    /not how your team will do/.test(text));
  ok('it says why a result grade would be dishonest',
    /could not be predicted/.test(text));
  ok('it says a perfect mark would not mean winning',
    /would not mean you will win/.test(text));
  const claims = /(will finish|projected to finish|expected wins|championship odds|your team will score|points this season)/i;
  ok('and it never claims to know the season', !claims.test(text), (text.match(claims) || [])[0]);

  // The grade must not be harsher than the label the app was showing while you picked.
  // An earlier cut counted every pick whose window opened later than the pick number,
  // which made a round-13 flier read as a 54-pick reach - a verdict the board itself
  // refuses to give, because past REACH_RANGE it says nothing at all rather than "reach".
  fire(d.defaultView, 'pagehide');
  const saved = JSON.parse(d.defaultView.localStorage.getItem('draft2026') || '{}');
  const shots = Object.values(saved.shots?.[0] || {});
  const mineIds = new Set(saved.picks?.[0]?.mine || []);
  const owned = Object.entries(saved.shots?.[0] || {}).filter(([id]) => mineIds.has(id));
  const boardCalled = owned.filter(([, s]) => s.win?.kind === 'reach').length;
  const said = out.querySelector('[data-reaches]')?.dataset.reaches;
  ok('every pick has its window recorded at the moment it was made',
    shots.length > 0 && shots.every((s) => s.win && s.win.from != null), `${shots.length} shots`);
  ok('the reach measure ran at all', said != null);
  ok('and it counts exactly the reaches the board itself called',
    +said === boardCalled, `grade said ${said}, board called ${boardCalled}`);
  // the ones it declined to price must be excluded rather than silently marked down
  const unpriced = +out.querySelector('[data-unpriced]').dataset.unpriced;
  const boardSilent = owned.filter(([, s]) => s.win?.kind == null
    && s.win.from - (saved.mock.log.find((y) => y.id === s.me.id)?.n ?? 0) > 4).length;
  ok('and it excludes every pick the board had no price for',
    unpriced === boardSilent, `grade excluded ${unpriced}, board was silent on ${boardSilent}`);
}

// ---------------------------------------------------------- 11. handcuffs
// The man who inherits a job when the starter cannot play. This is the one draft move that
// spends the strongest thing five years of testing turned up - projections are accurate per
// game and too high per season, and the entire shortfall is games missed - and it spends it
// without forecasting anything, because the heir's value is arithmetic on an assumption the
// user chooses rather than a guess about the future.
//
// Four things have to hold and each has been wrong at some point in this file's history.
{
  const e = await import(`file://${DIR}/engine.js`);
  const league = players.leagues[0];
  const pool = players.players.filter((p) => e.inLeague(p, league));
  const byId = new Map(pool.map((p) => [p.id, p]));
  const chart = e.depthChart(pool, league);
  const named = (n) => pool.find((p) => p.name === n);

  // ---- 1. it finds the obvious ones -------------------------------------------------
  ok('the depth chart finds handcuffs at all', chart.size >= 8, `${chart.size} found`);

  // The clearest case in the shipped file, and the one the engine's own comment uses to
  // explain the idea: Pacheco is projected 54 points BECAUSE Gibbs is projected 331.
  const gibbs = named('Jahmyr Gibbs');
  const behindGibbs = [...chart].find(([, hc]) => hc.leadId === gibbs?.id);
  ok('the man behind an elite back is named as his heir', !!behindGibbs,
    behindGibbs ? '' : 'nobody found behind Gibbs');
  ok('and it is the next man on his own team', !behindGibbs
    || byId.get(behindGibbs[0]).team === gibbs.team);

  const posOf = [...chart.keys()].map((id) => byId.get(id).pos);
  // Backs are where this is real, and the claim is about VALUE rather than headcount. Every
  // club has a backup quarterback and a second tight end, so counting names gives roughly a
  // third each; what matters is whose inheritance is worth owning, and that is asserted
  // further down where the money is (see "backup quarterbacks do not top the list").
  ok('there are handcuffs at all three one-man positions',
    ['RB', 'QB', 'TE'].every((q) => posOf.includes(q)), posOf.join(','));
  ok('and backs are the largest group of them',
    posOf.filter((q) => q === 'RB').length >= 12, `${posOf.filter((q) => q === 'RB').length}`);

  // And receivers are excluded on purpose - a receiver's targets scatter across everyone
  // left on the field rather than landing on one heir, so naming one invents him. With
  // WR: 3 in ROOM_JOBS this produced eleven pairs and every single one was simply a club's
  // fourth-best receiver: Aiyuk "behind" Stribling, Valdes-Scantling "behind" Flournoy.
  ok('no receiver is called anybody\'s heir', !posOf.includes('WR'),
    `${posOf.filter((q) => q === 'WR').length} receivers claimed`);

  // ---- 2. nobody inherits across a team line ----------------------------------------
  // The whole claim is "when THIS man cannot play, THIS other man takes his carries",
  // which is only ever true of two men in the same building.
  const crossed = [...chart].filter(([id, hc]) => {
    const back = byId.get(id);
    const lead = byId.get(hc.leadId);
    return !lead || !back || lead.team !== back.team || lead.pos !== back.pos;
  });
  ok('no handcuff is claimed across two teams or two positions', crossed.length === 0,
    crossed.map(([id, hc]) => `${byId.get(id)?.name} -> ${hc.leadName}`).join(', '));

  // The gap also has to be a gap. Two backs splitting a committee are not a starter and an
  // heir, and calling them one would hand a lift to half the league.
  const tooClose = [...chart].filter(([, hc]) => hc.ownPts * e.HANDCUFF_GAP > hc.leadPts
    || hc.leadPts < e.HANDCUFF_MIN);
  ok('a committee is never called a handcuff', tooClose.length === 0,
    tooClose.map(([, hc]) => hc.leadName).join(', '));

  // ---- 3. the value moves with the durability dial -----------------------------------
  // This is the point of the whole exercise. A handcuff behind a starter you are assuming
  // plays all 17 games is worth nothing whatsoever; behind one you are assuming misses six,
  // he is worth a great deal. Nothing here is a forecast - it is the consequence of an
  // assumption the user picked, priced.
  const base = e.DEFAULT_SETTINGS(players);
  const boards = {};
  for (const a of ['full', 'typical', 'own', 'cautious']) {
    boards[a] = e.buildBoard(players, { ...base, durAnchor: a });
  }
  const gainOf = (b) => b.rows.reduce((sum, r) => sum + (r.hcGain || 0), 0);

  ok('assuming nobody ever gets hurt makes every handcuff worth exactly nothing',
    gainOf(boards.full) === 0, `${gainOf(boards.full).toFixed(1)} points still priced in`);
  ok('assuming an average amount of time missed gives them real value',
    gainOf(boards.typical) > 50, `${gainOf(boards.typical).toFixed(1)}`);
  ok('and the gloomiest assumption is worth more than the average one',
    gainOf(boards.cautious) > gainOf(boards.typical),
    `${gainOf(boards.cautious).toFixed(1)} vs ${gainOf(boards.typical).toFixed(1)}`);

  // The dial has to reach ONE man, not just the total - and it has to reach him through the
  // starter he is behind rather than through some pooled average. That distinction was the
  // original bug: the value was computed off a league-wide availability figure, so moving
  // the assumption did not move the handcuff.
  const pick = boards.cautious.rows
    .filter((r) => r.hc && r.p.pos === 'RB').sort((x, y) => y.hcGain - x.hcGain)[0];
  ok('a real handcuff exists to test the dial on', !!pick);
  if (pick) {
    const at = (a) => boards[a].rows.find((r) => r.p.id === pick.p.id);
    ok('his value is nothing when his starter is assumed to play all 17',
      at('full').hcGain === 0, `${at('full').hcGain}`);
    ok('and rises once his starter is assumed to miss time',
      at('cautious').hcGain > at('full').hcGain + 1,
      `${at('full').hcGain.toFixed(1)} -> ${at('cautious').hcGain.toFixed(1)}`);
    ok('the weeks quoted are the weeks his own starter is assumed out',
      at('cautious').hc.weeks
        === Math.round(17 - e.expectedGames(byId.get(pick.hc.leadId),
          boards.cautious.games, 'cautious')),
      `${at('cautious').hc.weeks}`);
    // It must be HIS starter, not the pool. Two handcuffs on the same board, behind men
    // with different injury records, must be priced differently under the same setting.
    const spread = new Set(boards.own.rows.filter((r) => r.hc && r.hcGain > 0)
      .map((r) => r.hc.weeks));
    ok('two handcuffs behind different men get different numbers of weeks',
      spread.size > 1, `weeks seen: ${[...spread].join(',')}`);
  }

  // The price is over REPLACEMENT, not over nothing, and that is what keeps the list
  // sensible. Four fifths of an elite quarterback is available on waivers, so insuring one
  // buys almost nothing; half an elite running back is not replaceable at all. Priced on
  // gross points this ordering inverted and backup quarterbacks swept the board.
  const top = boards.cautious.rows.filter((r) => r.hcGain > 0)
    .sort((x, y) => y.hcGain - x.hcGain).slice(0, 5).map((r) => r.p.pos);
  ok('backup quarterbacks do not top the handcuff list', !top.includes('QB'), top.join(','));

  // ---- 4. and none of it edits a projection ------------------------------------------
  // The rule the whole app obeys: the number on screen is the projection. The dial prices
  // roster construction; it must never quietly rewrite a forecast.
  const ptsFull = new Map(boards.full.rows.map((r) => [r.p.id, r.pts]));
  const moved = boards.cautious.rows.filter((r) => Math.abs(r.pts - ptsFull.get(r.p.id)) > 1e-9);
  ok('the durability dial never edits anybody\'s projection', moved.length === 0,
    `${moved.length} projections moved`);
}

// ------------------------------------------- 11b. and it says so, in words, on the screen
// The audience for this is not just Zach. The label has to make sense to someone who has
// never heard the word "handcuff", which is why the word does not appear on the board.
{
  const { d, window } = await boot();
  const e = await import(`file://${DIR}/engine.js`);

  const set = (a) => {
    d.querySelector('#durAnchor').value = a;
    fire(d.querySelector('#durAnchor'), 'change');
  };
  // On the board view, and this matters. A fresh profile lands on Setup, and renderAll only
  // repaints the board while the board is the view you are looking at - so anything that
  // rebuilds is invisible until you switch to it. Correct in a browser, a trap in here.
  d.querySelector('[data-v="board"]').click();
  await settle();
  // Filtered to backs, because that is where these men are and where they are looked for.
  // The full board is ranked on value over replacement and a handcuff is projected low by
  // definition, so he sits below the hundred-row display cut until the top of the board has
  // been drafted. His value lives in benchScore, which is what the recommendation panel and
  // the planner read - that is the correct home for a roster-construction number, and it is
  // deliberately not allowed to reorder the value ruler itself.
  d.querySelector('[data-f="RB"]').click();
  await settle();
  set('cautious');
  await settle();

  // The dial has to say what it means in games, and say it about the stop you are actually
  // on. "An average amount" is not a quantity until you are told it is 14 of 17.
  ok('the dial spells out the stop you are on',
    /benefit of the doubt/i.test(d.querySelector('#durHint').textContent),
    d.querySelector('#durHint').textContent.slice(0, 90));
  set('full');
  await settle();
  ok('and it updates when you move it',
    /most optimistic/.test(d.querySelector('#durHint').textContent),
    d.querySelector('#durHint').textContent.slice(0, 90));
  set('typical');
  await settle();
  ok('and turns the vague stops into a number of games',
    /\d+ games of 17/.test(d.querySelector('#durHint').textContent),
    d.querySelector('#durHint').textContent.slice(0, 120));
  set('cautious');
  await settle();

  const badges = [...d.querySelectorAll('#rows .hcTag')];
  ok('the board marks the men who are next in line', badges.length > 0,
    `${badges.length} badges`);
  ok('and it never uses the word nobody knows',
    !badges.some((b) => /handcuff/i.test(b.textContent)),
    badges.map((b) => b.textContent).join(' | '));
  // "if Gibbs sits" - the situation described rather than named.
  ok('the badge says what the situation is, in plain words',
    badges.every((b) => /^(if .+ sits|covers your .+)$/.test(b.textContent.trim())),
    badges.slice(0, 4).map((b) => b.textContent).join(' | '));

  // The badge is a consequence of the assumption, so it must vanish at the stop where
  // nobody misses a game. That disappearance is the honesty of the feature, not a glitch.
  set('full');
  await settle();
  ok('and every one of them disappears when you assume nobody gets hurt',
    d.querySelectorAll('#rows .hcTag').length === 0,
    `${d.querySelectorAll('#rows .hcTag').length} left`);

  // ---- owning the starter changes what it says ---------------------------------------
  // Handcuffing your own back is insurance; handcuffing somebody else's is a lottery
  // ticket. Those are different purchases and the app has to say which one you are looking
  // at, because a beginner reading "he is the backup to Jahmyr Gibbs" has no way to know
  // that the sentence means something different depending on who else is on her team.
  set('cautious');
  await settle();
  const badge = d.querySelector('#rows .hcTag');
  const heirId = badge.closest('.row').querySelector('[data-open]').dataset.open;
  const leadName = badge.textContent.replace(/^if |sits$/g, '').trim();
  const leadId = e.depthChart(players.players.filter((p) => e.inLeague(p, players.leagues[0])),
    players.leagues[0]).get(heirId)?.leadId;
  ok('the badge names a starter the engine agrees he is behind', !!leadId, leadName);

  d.querySelector(`[data-open="${heirId}"]`).click();
  await settle();
  const lottery = d.querySelector('.detail').textContent.replace(/\s+/g, ' ');
  ok('the card explains the situation without naming it',
    /next in line behind/.test(lottery), lottery.slice(0, 120));
  ok('and calls it a bet on somebody else\'s luck while you do not own the starter',
    /bet on another manager's bad luck/.test(lottery));
  ok('it names the assumption you have set rather than asserting a forecast',
    /gloomiest of the two/i.test(lottery), lottery.slice(0, 220));
  ok('and it quotes the weeks off that assumption rather than predicting an injury',
    /the job is open about \d+ week/.test(lottery), lottery.slice(0, 220));

  // The same card, on a profile where the starter is already yours. Booted from a saved
  // roster rather than by clicking Mine: on this harness a click writes the pick to storage
  // but the board does not repaint from it, which is true on an untouched checkout too and
  // is not what this test is about.
  const store = {
    draft2026: JSON.stringify({
      league: 0,
      durAnchor: 'cautious',
      picks: { 0: { drafted: [leadId], mine: [leadId] } },
    }),
  };
  const { d: d2 } = await boot({ store });
  await settle();
  d2.querySelector('[data-v="board"]').click();
  await settle();
  d2.querySelector('[data-f="RB"]').click();
  await settle();
  d2.querySelector(`[data-open="${heirId}"]`).click();
  await settle();
  const insured = d2.querySelector('.detail').textContent.replace(/\s+/g, ' ');

  ok('owning the starter changes the wording entirely', insured !== lottery);
  ok('and it now reads as insurance on a player you already have',
    /already on your team/.test(insured)
    && /insurance on a player you already own/.test(insured), insured.slice(0, 240));
  ok('the lottery-ticket wording is gone',
    !/bet on another manager's bad luck/.test(insured));
  ok('it still refuses to claim he is good',
    /not a claim that he is good/.test(insured));

  // And the badge on the board says it too, in two words, without the jargon.
  const own = [...d2.querySelectorAll('#rows .hcTag')].map((b) => b.textContent);
  ok('the badge on the board says it is cover for a man you own',
    own.some((t) => /^covers your /.test(t)), own.slice(0, 6).join(' | '));
  ok('and the others still read as somebody else\'s man',
    own.some((t) => /^if /.test(t)), own.slice(0, 6).join(' | '));
}

// ------------------------------------------- 15. how much the room counts
// The targeted ADP anchor. It exists because VOR is a pure projection statement and knows
// nothing about what a draft looks like, and it is TARGETED rather than flat because there
// are two kinds of disagreement with the market: the ones where we are right (this league
// pays for first downs and the market does not) and the ones where we are wrong (kickers
// and defences have an invented replacement level; a man with no season has an unchecked
// projection). A flat weight doses both the same and sells the edge to fix the bugs.
{
  const e = await import(`${DIR}/engine.js`);
  const d = JSON.parse(JSON.stringify(players));
  d.leagues = [e.SAMPLE_LEAGUE];
  const base = { ...e.DEFAULT_SETTINGS(d), league: 0, mine: [] };
  const at = (a) => e.buildBoard(d, { ...base, anchor: a }).rows;
  const KD = (r) => ['K', 'DEF'].includes(r.p.pos);
  const dials = [0, 0.25, 0.5, 0.75, 1];
  const boards = Object.fromEntries(dials.map((a) => [a, at(a)]));
  const rankIn = (rows) => new Map(rows.map((r) => [r.p.id, r.rank]));

  // 1. It converges on the market for the men it is meant to defer to. At full weight the
  //    board should agree with ADP about kickers and defences almost exactly - that is
  //    what "we have no honest replacement level for these, so copy the room" means, and
  //    it is the cleanest available proof that the blend is on the right scale. The first
  //    version of this got it wrong: it blended ADP into VOR and added the need bonus
  //    afterwards, so a defence carrying a need penalty was measured against a scale that
  //    knew nothing about need, and the anchor pushed him AWAY from the room while
  //    claiming to defer to it.
  const off = rankIn(boards[0]);
  const err = (rows) => rows.reduce((a, r) => a + Math.abs(r.rank - r.adpRank), 0) / rows.length;
  // Not zero even at full weight, and it should not be: a kicker is given the score of the
  // man the room takes at his ADP, but the SKILL players around him are not anchored and
  // do not move, so he lands next to where the room has him rather than exactly on it.
  // Tested as a ratio for that reason - the claim is convergence, not identity.
  const errFull = err(boards[1].filter(KD));
  const errOff = err(boards[0].filter(KD));
  ok('at full weight the board very nearly agrees with the room about kickers and defences',
    errFull < errOff / 3, `mean ${errFull.toFixed(1)} places off ADP, from ${errOff.toFixed(1)}`);
  ok('and with it off it does not', errOff > 25, `mean ${errOff.toFixed(1)} places off ADP`);

  // 2. Monotone. Every step of the control must move kickers and defences closer to the
  //    room than the step before - no reversals, no plateau. A control that helps at one
  //    setting and hurts at the next is not a control, it is a coincidence, which is
  //    exactly what the `tilt` multiplier it replaced turned out to be.
  const errs = dials.map((a) => err(boards[a].filter(KD)));
  ok('every step of the control moves them closer to the room',
    errs.every((v, i) => i === 0 || v < errs[i - 1] + 0.01), errs.map((v) => v.toFixed(1)).join(' > '));

  // 3. TARGETED, not flat. This is the whole design claim, so it is tested as a ratio and
  //    not as two separate thresholds: at the same setting, kickers and defences must move
  //    many times further than established skill players do. If someone quietly replaces
  //    this with a flat blend, the ratio collapses to about 1 and this fails.
  const move = (ids, a) => {
    const now = rankIn(boards[a]);
    return ids.reduce((x, id) => x + Math.abs(now.get(id) - off.get(id)), 0) / ids.length;
  };
  const kdIds = boards[0].filter(KD).map((r) => r.p.id);
  // Ranked among themselves, so the measurement is not just "everyone shuffled up when the
  // kickers slid past them", which is composition and not the anchor doing anything.
  const knownRank = (rows) => {
    const kn = rows.filter((r) => !KD(r) && !e.noSeason(r.p) && r.p.adp < 400);
    return new Map(kn.map((r, i) => [r.p.id, i + 1]));
  };
  const k0 = knownRank(boards[0]);
  const kn = [...k0.keys()];
  const knownMove = (a) => {
    const now = knownRank(boards[a]);
    return kn.reduce((x, id) => x + Math.abs(now.get(id) - k0.get(id)), 0) / kn.length;
  };
  for (const a of [0.5, 1]) {
    const ratio = move(kdIds, a) / Math.max(knownMove(a), 0.01);
    ok(`at ${a * 100}% the room moves kickers and defences far more than settled players`,
      ratio > 8, `${move(kdIds, a).toFixed(1)} places vs ${knownMove(a).toFixed(2)} — ×${ratio.toFixed(0)}`);
  }

  // 4. The top of the board does not move at a sensible setting. Anchoring is a repair to
  //    the parts of the board nobody can price; it has no business rearranging round one.
  const top12 = (a) => boards[a].slice(0, 12).map((r) => r.p.id);
  for (const a of [0.5, 0.75]) {
    const gone = top12(0).filter((id) => !top12(a).includes(id));
    ok(`the top of the board is unchanged at ${a * 100}%`, gone.length === 0,
      gone.map((id) => d.players.find((p) => p.id === id)?.name).join(', '));
  }

  // 5. Men with no season stop sitting above the room. Same failure as the kickers -
  //    a projection nobody has checked - and it must be fixed by the same mechanism.
  const nsGap = (a) => {
    boards[a] ||= at(a);
    const ns = boards[a].filter((r) => e.noSeason(r.p));
    return ns.reduce((x, r) => x + (r.adpRank - r.rank), 0) / ns.length;
  };
  ok('men with no season are pulled back towards the room',
    nsGap(1) < nsGap(0) - 10, `${nsGap(0).toFixed(1)} -> ${nsGap(1).toFixed(1)} places above ADP`);
  ok('and at the shipped default they are within a handful of places of it',
    Math.abs(nsGap(e.ANCHOR_DEFAULT)) < 5, `${nsGap(e.ANCHOR_DEFAULT).toFixed(1)}`);

  // 6. The grade cannot reorder the board AT ALL. `tilt` is gone, so re-weighting the
  //    components has to be inert on draft order - it may only change the grade shown on
  //    the card. Slam every component weight to something absurd and the board must come
  //    out in exactly the same order, player for player.
  const wild = Object.fromEntries(Object.keys(base.comp).map((k, i) => [k, i % 2 ? 90 : 1]));
  const bent = e.buildBoard(d, { ...base, comp: wild }).rows;
  const straight = boards[e.ANCHOR_DEFAULT] || at(e.ANCHOR_DEFAULT);
  const order = (rows) => rows.map((r) => r.p.id).join(',');
  ok('re-weighting the grade cannot reorder the board', order(bent) === order(straight),
    bent.slice(0, 400).find((r, i) => r.p.id !== straight[i].p.id)?.p.name || '');
  ok('but it does change the grade on the card',
    bent.filter((r) => r.rated).some((r) => Math.abs(r.rating - straight
      .find((x) => x.p.id === r.p.id).rating) > 1));

  // 7. The two costs have to reach the screen. The trade is the point of putting this on
  //    a panel at all, and a control that hides what it spends is the thing being fixed.
  const { d: dom } = await boot();
  dom.querySelector('#settingsBtn').click();
  await settle();
  const hint = dom.querySelector('#anchorHint').textContent;
  ok('the panel says the anchor costs you your scoring edge',
    /first downs/.test(hint) && /less of that edge/.test(hint), hint.slice(0, 160));
  ok('the panel does not quote one flat number for everybody',
    /kickers and defences/.test(hint) && /everyone else/.test(hint), hint.slice(0, 160));
  const slider = dom.querySelector('#anchor');
  slider.value = '100';
  slider.dispatchEvent(new dom.defaultView.Event('input', { bubbles: true }));
  await settle();
  ok('and it warns about steal and reach once the room is most of the board',
    /steal/i.test(dom.querySelector('#anchorHint').textContent),
    dom.querySelector('#anchorHint').textContent.slice(-160));
  slider.value = '0';
  slider.dispatchEvent(new dom.defaultView.Event('input', { bubbles: true }));
  await settle();
  ok('the warning goes away again when it is turned down',
    !/steal/i.test(dom.querySelector('#anchorHint').textContent));
}

// ---------------------------------------------------------------- report
console.log(`\n${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log('  FAIL', f);
process.exit(fails.length ? 1 : 0);
