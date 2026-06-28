'use strict';
/*
 * analyze.js — analisi di tuning sui dati REALI salvati (positions.db).
 * Lancia sul VPS:  cd ~/pm-test && node --experimental-sqlite --no-warnings analyze.js
 *
 * Risponde a 3 domande con i dati veri:
 *   1) Banda: entrando più VICINO al target la reversione (lock-rate) sale?
 *   2) Soglia: alzandola le nude diventano lock? (distribuzione del minimo del lato mancante)
 *   3) Tempo: entrando PRIMA la reversione sale?
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'data', 'positions.db'), { readOnly: true });
const rows = db.prepare('SELECT * FROM windows WHERE actualGain IS NOT NULL').all()
  .map((r) => ({ ...r, legsArr: JSON.parse(r.legs || '[]') }))
  .filter((r) => r.legsArr.length > 0);

const N = rows.length;
const locks = rows.filter((r) => r.legsArr.length === 2);
const nudes = rows.filter((r) => r.legsArr.length === 1);
const realized = rows.reduce((a, r) => a + (r.actualGain || 0), 0);
const lockAvg = locks.length ? locks.reduce((a, r) => a + r.actualGain, 0) / locks.length : 0;
const rev = N ? locks.length / N : 0;
const breakeven = 1 / (1 + lockAvg);

console.log(`\n=== RIEPILOGO (${N} finestre con entrata) ===`);
console.log(`lock ${locks.length} · nude ${nudes.length} · realizzato $${realized.toFixed(2)}`);
console.log(`reversione ${(100 * rev).toFixed(1)}%  ·  lock medio +$${lockAvg.toFixed(3)}  ·  pareggio ${(100 * breakeven).toFixed(1)}%  -> ${rev > breakeven ? 'PROFITTO' : 'perdita'}`);

function entrata(r) { return r.legsArr.find((l) => l.kind === 'entrata') || r.legsArr[0]; }
function relOf(r) { const e = entrata(r); return e && e.t != null ? Math.floor(e.t / 1000) - r.s : null; }
function distOf(r) { const e = entrata(r); return e && e.priceAtBuy != null && r.priceToBeat != null ? Math.abs(e.priceAtBuy - r.priceToBeat) : null; }
function bucketRate(rowsIn, valFn, edges) {
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i], hi = edges[i + 1];
    const sub = rowsIn.filter((r) => { const v = valFn(r); return v != null && v >= lo && v < hi; });
    if (!sub.length) continue;
    const lk = sub.filter((r) => r.legsArr.length === 2).length;
    const be = 1 / (1 + (sub.filter((r)=>r.legsArr.length===2).reduce((a,r)=>a+r.actualGain,0)/(lk||1)));
    console.log(`  [${lo}-${hi}): n=${String(sub.length).padStart(3)}  reversione ${(100*lk/sub.length).toFixed(0).padStart(2)}%  pareggio ${(100*be).toFixed(0)}%  ${lk/sub.length>be?'+':'-'}`);
  }
}

console.log('\n=== 1) BANDA — lock-rate per |prezzo entrata - target| ($) ===');
console.log('(se la reversione è più alta vicino al target -> stringi la banda)');
bucketRate(rows, distOf, [0, 3, 6, 9, 12, 16, 999]);

console.log('\n=== 3) TEMPO — lock-rate per secondo di entrata ===');
console.log('(se la reversione è più alta entrando prima -> abbassa il cutoff)');
bucketRate(rows, relOf, [0, 30, 60, 90, 120, 151]);

console.log('\n=== 2) SOGLIA — nude: minimo del lato MANCANTE ===');
console.log('(quante nude si rescuerebbero alzando la soglia)');
const miss = nudes.map((r) => { const s = entrata(r).side; return s === 'Up' ? r.downMin : r.upMin; }).filter((x) => x != null);
for (const [lo, hi] of [[0.43, 0.45], [0.45, 0.47], [0.47, 0.50], [0.50, 0.55], [0.55, 2]]) {
  const n = miss.filter((x) => x >= lo && x < hi).length;
  console.log(`  ${lo.toFixed(2)}-${hi.toFixed(2)}: ${String(n).padStart(3)} nude  ${'#'.repeat(Math.min(n, 60))}`);
}
console.log('\n(soglia/banda/tempo dove "reversione > pareggio" = configurazione profittevole)');
