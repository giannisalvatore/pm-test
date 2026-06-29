'use strict';
/*
 * calib.js — tara RV_MIN sulla scala REALE di Chainlink, usando i tick salvati dal recorder.
 * Stessa logica del backtest, ma sui prezzi LIVE (data/ticks.db), solo prezzo (niente odds).
 *
 * Lancia sul VPS dopo qualche ORA di raccolta:
 *   cd ~/pm-test && node --experimental-sqlite --no-warnings calib.js
 *
 * "two-sided" (lock-abile) = nella finestra il prezzo va sia >target+M che <target-M.
 * Cerca la soglia rv15 più BASSA per cui le finestre sopra soglia sono ~70% two-sided
 * (= il pareggio del backtest). Quella è la RV_MIN giusta per il live.
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const M = Number(process.env.M) || 10;   // displacement che approssima ask<0.43
const WIN = 300, RVWIN = 900;             // finestra 5m, volatilità su 15m
const TARGET_TWO = 0.70;                  // tasso two-sided desiderato sopra soglia

const db = new DatabaseSync(path.join(__dirname, 'data', 'ticks.db'), { readOnly: true });
const rows = db.prepare('SELECT ts, value FROM ticks ORDER BY ts').all();
if (rows.length < 2) { console.log('ticks.db troppo vuoto.'); process.exit(0); }

// griglia 1/sec con forward-fill (stessa scala del calcolo live)
const sec0 = Math.floor(rows[0].ts / 1000), secN = Math.floor(rows[rows.length - 1].ts / 1000);
const grid = new Float64Array(secN - sec0 + 1); grid.fill(NaN);
let idx = 0, last = NaN;
for (let s = sec0; s <= secN; s++) {
  const tms = (s + 1) * 1000; // ultimo tick <= fine di questo secondo
  while (idx < rows.length && rows[idx].ts < tms) { last = rows[idx].value; idx++; }
  grid[s - sec0] = last;
}
const px = (s) => { const o = s - sec0; return (o >= 0 && o < grid.length) ? grid[o] : NaN; };

function rvAt(openSec) {
  const a = openSec - RVWIN; if (a < sec0) return null;
  let sq = 0, prev = px(a), n = 0;
  for (let k = 1; k <= RVWIN; k++) { const p = px(a + k); if (Number.isFinite(p) && Number.isFinite(prev)) { sq += (p - prev) ** 2; n++; } prev = p; }
  return n >= RVWIN * 0.5 ? Math.sqrt(sq) : null;
}
function twoSided(openSec) {
  const target = px(openSec); if (!Number.isFinite(target)) return null;
  let mx = -Infinity, mn = Infinity, n = 0;
  for (let k = 0; k < WIN; k++) { const p = px(openSec + k); if (!Number.isFinite(p)) continue; if (p > mx) mx = p; if (p < mn) mn = p; n++; }
  if (n < WIN * 0.5) return null;
  return (mx - target >= M) && (target - mn >= M);
}

// raccogli {rv, two} per ogni finestra allineata a 300 con storia sufficiente
const data = [];
const first = Math.ceil((sec0 + RVWIN) / WIN) * WIN, lastOpen = Math.floor((secN - WIN) / WIN) * WIN;
let twoCnt = 0;
for (let s = first; s <= lastOpen; s += WIN) {
  const rv = rvAt(s), tw = twoSided(s);
  if (rv == null || tw == null) continue;
  data.push({ rv, tw }); if (tw) twoCnt++;
}
const N = data.length;
console.log(`\nFinestre analizzabili: ${N}  (ticks.db: ${rows.length} righe, ~${((secN - sec0) / 3600).toFixed(1)}h)`);
if (N < 30) { console.log('Pochi dati: lascia girare il recorder ancora qualche ora e rilancia.'); process.exit(0); }
console.log(`Base two-sided (lock-abili): ${(100 * twoCnt / N).toFixed(0)}%   (M=$${M})`);

const rvs = data.map((d) => d.rv).sort((a, b) => a - b);
const q = (p) => rvs[Math.min(rvs.length - 1, Math.floor(rvs.length * p))];
console.log(`\nDistribuzione rv15 LIVE ($):  p10 ${q(.1).toFixed(0)} · p25 ${q(.25).toFixed(0)} · p50 ${q(.5).toFixed(0)} · p70 ${q(.7).toFixed(0)} · p80 ${q(.8).toFixed(0)} · p90 ${q(.9).toFixed(0)}`);

console.log('\nsoglia rv15 | finestre sopra | two-sided sopra soglia');
let reco = null;
for (let p = 0.1; p <= 0.9; p += 0.1) {
  const th = q(p); const sub = data.filter((d) => d.rv >= th);
  const rate = sub.length ? sub.filter((d) => d.tw).length / sub.length : 0;
  const mark = rate >= TARGET_TWO ? ' <- >=70%' : '';
  if (reco == null && rate >= TARGET_TWO) reco = th;
  console.log(`  >= $${String(th.toFixed(0)).padStart(4)}  |  ${String(sub.length).padStart(4)}        |  ${(100 * rate).toFixed(0)}%${mark}`);
}
console.log('');
if (reco != null) console.log(`>>> RV_MIN consigliato ≈ ${Math.round(reco)}  (la soglia più bassa con >=${TARGET_TWO * 100}% two-sided)`);
else console.log('>>> Nessuna soglia raggiunge il 70% two-sided con questi dati: regime calmo o pochi dati. Rilancia con più ore.');
