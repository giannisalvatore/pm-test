'use strict';
/*
 * db.js — persistenza posizioni su SQLite nativo (node:sqlite).
 * Salva SOLO le finestre con almeno un'entrata, così sopravvivono ai riavvii.
 * Richiede avvio con:  node --experimental-sqlite NEW/server.js
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const dir = path.join(__dirname, 'data');
fs.mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(path.join(dir, 'positions.db'));

db.exec(`CREATE TABLE IF NOT EXISTS windows (
  s INTEGER PRIMARY KEY,
  priceToBeat REAL, priceToBeatReliable INTEGER,
  lastPrice REAL, closePrice REAL, outcome TEXT, status TEXT,
  gainIfUp REAL, gainIfDown REAL, minGain REAL, maxGain REAL, actualGain REAL, upMin REAL, downMin REAL,
  legs TEXT, createdAt INTEGER, updatedAt INTEGER
)`);
// migrazione: aggiungi le colonne mancanti ai DB già esistenti (sul VPS)
const _cols = db.prepare('PRAGMA table_info(windows)').all().map((c) => c.name);
if (!_cols.includes('upMin')) db.exec('ALTER TABLE windows ADD COLUMN upMin REAL');
if (!_cols.includes('downMin')) db.exec('ALTER TABLE windows ADD COLUMN downMin REAL');

const N = (x) => (x == null || Number.isNaN(x) ? null : x);
const stmtUpsert = db.prepare(`INSERT INTO windows
 (s,priceToBeat,priceToBeatReliable,lastPrice,closePrice,outcome,status,gainIfUp,gainIfDown,minGain,maxGain,actualGain,upMin,downMin,legs,createdAt,updatedAt)
 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
 ON CONFLICT(s) DO UPDATE SET
  priceToBeat=excluded.priceToBeat, priceToBeatReliable=excluded.priceToBeatReliable,
  lastPrice=excluded.lastPrice, closePrice=excluded.closePrice, outcome=excluded.outcome, status=excluded.status,
  gainIfUp=excluded.gainIfUp, gainIfDown=excluded.gainIfDown, minGain=excluded.minGain, maxGain=excluded.maxGain,
  actualGain=excluded.actualGain, upMin=excluded.upMin, downMin=excluded.downMin, legs=excluded.legs, updatedAt=excluded.updatedAt`);

function save(w) {
  if (!w || !w.legs || w.legs.length === 0) return; // SOLO finestre con entrata
  stmtUpsert.run(w.s, N(w.priceToBeat), w.priceToBeatReliable ? 1 : 0, N(w.lastPrice), N(w.closePrice),
    w.outcome || null, w.status || null, N(w.gainIfUp), N(w.gainIfDown), N(w.minGain), N(w.maxGain), N(w.actualGain), N(w.upMin), N(w.downMin),
    JSON.stringify(w.legs), w.createdAt || Date.now(), Date.now());
}

function load() {
  const rows = db.prepare('SELECT * FROM windows ORDER BY s').all();
  return rows.map((r) => ({
    s: r.s, priceToBeat: r.priceToBeat, priceToBeatReliable: !!r.priceToBeatReliable,
    lastPrice: r.lastPrice, closePrice: r.closePrice, outcome: r.outcome, status: r.status,
    gainIfUp: r.gainIfUp, gainIfDown: r.gainIfDown, minGain: r.minGain, maxGain: r.maxGain, actualGain: r.actualGain, upMin: r.upMin, downMin: r.downMin,
    legs: JSON.parse(r.legs || '[]'), createdAt: r.createdAt,
  }));
}

module.exports = { save, load };
