'use strict';
/*
 * recorder.js — SERVIZIO REGISTRATORE TICK (autonomo, stabile, da NON riavviare).
 *
 * Si collega al prezzo Chainlink live di Polymarket (RTDS WebSocket) e salva OGNI tick
 * in data/ticks.db (file SEPARATO da positions.db -> il reset delle giocate non lo tocca).
 * Il servizio di giocata (server.js) all'avvio ricarica gli ultimi ~min di tick da qui,
 * cosi rv15/price-to-beat sono pronti SUBITO anche dopo un riavvio.
 *
 * Avvio:  node --experimental-sqlite --no-warnings recorder.js
 *   pm2:  pm2 start npm --name tickrec -- run rec
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const PRICE_WS = 'wss://ws-live-data.polymarket.com';
const RETENTION_DAYS = Number(process.env.TICK_RETENTION_DAYS) || 30; // quanto storico tenere
const PRUNE_EVERY_MS = 10 * 60 * 1000;

const dir = path.join(__dirname, 'data');
fs.mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(path.join(dir, 'ticks.db'));
try { db.exec('PRAGMA journal_mode=WAL'); } catch (_) {}
db.exec('CREATE TABLE IF NOT EXISTS ticks (ts INTEGER PRIMARY KEY, value REAL)');
const stmtIns = db.prepare('INSERT OR REPLACE INTO ticks (ts, value) VALUES (?, ?)');
const stmtPrune = db.prepare('DELETE FROM ticks WHERE ts < ?');

let saved = 0;
function save(ts, value) {
  if (typeof ts !== 'number' || typeof value !== 'number') return;
  try { stmtIns.run(ts, value); saved++; } catch (_) {}
}
function prune() {
  try { const info = stmtPrune.run(Date.now() - RETENTION_DAYS * 86400 * 1000); if (info && info.changes) console.log(new Date().toISOString(), 'prune:', info.changes, 'tick vecchi rimossi'); } catch (_) {}
}
function logStats() {
  try {
    const r = db.prepare('SELECT COUNT(*) c, MIN(ts) a, MAX(ts) b FROM ticks').get();
    const span = r.a ? ((r.b - r.a) / 3600000).toFixed(1) : 0;
    console.log(new Date().toISOString(), `ticks DB: ${r.c} righe · storico ${span}h · salvati(sessione) ${saved}`);
  } catch (_) {}
}

// ---------------- WebSocket prezzo Chainlink (RTDS) ----------------
function connect() {
  if (typeof WebSocket === 'undefined') { console.error('Serve Node 22+ (WebSocket nativo)'); process.exit(1); }
  const ws = new WebSocket(PRICE_WS);
  const wd = setTimeout(() => { try { ws.close(); } catch (_) {} }, 8000); // watchdog apertura
  ws.addEventListener('open', () => {
    clearTimeout(wd);
    ws.send(JSON.stringify({ action: 'subscribe', subscriptions: [{ topic: 'crypto_prices_chainlink', type: '*', filters: '{"symbol":"btc/usd"}' }] }));
    console.log(new Date().toISOString(), 'recorder: WS Chainlink connesso');
  });
  ws.addEventListener('message', (e) => {
    let m; try { m = JSON.parse(e.data); } catch (_) { return; }
    const p = m && m.payload; if (!p) return;
    if (Array.isArray(p.data)) { for (const d of p.data) save(d.timestamp, d.value); return; } // snapshot iniziale
    if (p.symbol === 'btc/usd' && typeof p.value === 'number') save(p.timestamp || Date.now(), p.value);
  });
  ws.addEventListener('close', () => { clearTimeout(wd); console.log(new Date().toISOString(), 'recorder: WS chiuso, riconnetto…'); setTimeout(connect, 2000); });
  ws.addEventListener('error', () => { try { ws.close(); } catch (_) {} });
}

prune();
connect();
setInterval(prune, PRUNE_EVERY_MS);
setInterval(logStats, 60 * 1000);
console.log(new Date().toISOString(), `recorder avviato · retention ${RETENTION_DAYS} giorni · db ${path.join(dir, 'ticks.db')}`);
