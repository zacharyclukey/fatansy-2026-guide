import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const m = await import(`file://${DIR}/engine.js`);
const data = JSON.parse(fs.readFileSync(`${DIR}/data/players.json`,'utf8'));
const lg = data.leagues[0];
const bb = m.buildBoard(data, { ...m.DEFAULT_SETTINGS(data), league: 0, mine: [] });
const rows = bb.rows.filter(r => m.inLeague(r.p, lg));
const gone = new Set(rows.slice(0,6).map(r=>r.p.id));   // 6 went before his pick
console.log('gone:', rows.slice(0,6).map(r=>r.p.name).join(', '));
const ck = m.draftContext(lg, 7, 7);
console.log('picks', ck.picks.slice(0,6), 'target', ck.target);
const res = m.planDraft(rows, ck, gone, lg, {}, { candidates: 10 });
console.log('slots', res.slots.join(','), '| later', res.later.join(','));
for (const c of res.plan.slice(0,5))
  console.log(`${c.row.p.pos} ${c.row.p.name.padEnd(20)} now ${c.now.toFixed(1).padStart(6)} tot ${c.total.toFixed(1)}  ${c.steps.map(s=>`${s.slot}@${s.pick}=${s.value.toFixed(0)}[${s.take?.p.pos}]`).join(' ')}`);
console.log('cost', res.cost.map(c=>`${c.pos} -${c.loss.toFixed(1)}`).join('  '));
console.log('drop', Object.entries(res.drop).map(([k,v])=>`${k} ${v.now.toFixed(0)}->${v.later.toFixed(0)}`).join('  '));
const win=res.plan[0], riv=res.plan.find(c=>c.row.p.pos===res.cost.find(x=>x.pos!==res.top.row.p.pos).pos);
console.log('winner fill', JSON.stringify(win.fill,null,0).replace(/\.\d+/g,''));
console.log('rival ', riv.row.p.name, 'fill', JSON.stringify(riv.fill).replace(/\.\d+/g,''));
