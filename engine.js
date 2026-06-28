'use strict';
/*
 * engine.js — motore della strategia (test).
 *
 * Regole (parametri dell'utente):
 *   BAND   = 15   -> entro solo se |currentPrice - priceToBeat| <= 15
 *   THRESH = 0.43 -> compro un lato solo se il suo ASK < 0.43
 *   $1 per posizione -> shares = 1/prezzo. Payout del lato vincente = shares * $1.
 *
 *   1) ENTRATA: nessuna posizione + dentro la banda + un lato < 0.43 -> compro $1 su quel lato.
 *   2) SICUREZZA: ho 1 lato + l'ALTRO va < 0.43 -> compro $1 anche sull'altro (lock).
 *
 * Guadagno: se chiude UP paga il lato UP, se chiude DOWN paga il lato DOWN.
 *   gainIfUp   = sharesUp   - spesa ;  gainIfDown = sharesDown - spesa
 *   min/max = il peggiore/migliore tra i due. actualGain = quello dell'esito reale.
 */

const feeds = require('./feeds');
const db = require('./db');

const WIN = 300;
const BAND = 10;
const THRESH = 0.43;
const MIN_OBS = 30;        // il prezzo deve restare range-bound per ALMENO 30s prima di poter entrare
const ENTRY_MAX_REL = 150; // entrata (1ª gamba) solo entro 2,5 min; dopo non si entra
const STAKE = Number(process.env.STAKE) || 1; // $ per posizione (paper=1; prod: STAKE=10)

const windows = new Map(); // s -> record
let currentS = null;

// carica le posizioni salvate (sopravvivono ai riavvii del backend)
for (const w of db.load()) windows.set(w.s, w);

function computeGains(w) {
  const spent = w.legs.length * STAKE; // $ totali messi (STAKE per gamba)
  let shUp = 0, shDown = 0;
  for (const l of w.legs) { if (l.side === 'Up') shUp += l.shares; else shDown += l.shares; }
  w.gainIfUp = +(shUp - spent).toFixed(3);
  w.gainIfDown = +(shDown - spent).toFixed(3);
  w.minGain = +Math.min(w.gainIfUp, w.gainIfDown).toFixed(3);
  w.maxGain = +Math.max(w.gainIfUp, w.gainIfDown).toFixed(3);
  if (w.outcome) w.actualGain = w.outcome === 'Up' ? w.gainIfUp : w.gainIfDown;
}

function setStatus(w) {
  if (w.closePrice != null) { w.status = w.legs.length === 0 ? 'saltata' : (w.legs.length === 2 ? 'lock chiusa' : 'nuda chiusa'); }
  else if (w.legs.length === 0) w.status = 'attesa';
  else if (w.legs.length === 1) w.status = 'entrata (1/2)';
  else w.status = 'in sicurezza (lock)';
}

function finalize(w) {
  if (w.closePrice != null) return;
  // chiusura = valore Chainlink ESATTO al bordo s+300 (come risolve Polymarket); fallback ultimo prezzo
  const exact = feeds.priceAt((w.s + WIN) * 1000);
  w.closePrice = exact != null ? exact : w.lastPrice;
  if (w.priceToBeat != null && w.closePrice != null) w.outcome = w.closePrice >= w.priceToBeat ? 'Up' : 'Down';
  computeGains(w);
  setStatus(w);
  if (w.legs.length > 0) db.save(w);
}

function buy(w, side, price, kind, f) {
  if (price == null || price <= 0) return;
  w.legs.push({ side, price: +price.toFixed(3), shares: +(STAKE / price).toFixed(3), kind, t: Date.now(), priceAtBuy: f.currentPrice });
  computeGains(w);
  setStatus(w);
  db.save(w); // persisti subito l'acquisto
}

function onFeed(f) {
  if (f.windowStart == null) return;
  // cambio finestra -> chiudo la precedente
  if (currentS != null && f.windowStart !== currentS) {
    const old = windows.get(currentS);
    if (old) {
      if (old.legs.length > 0) finalize(old);     // chiudi solo se c'è stata un'entrata
      else windows.delete(currentS);              // nessuna entrata -> non tracciare
    }
  }
  currentS = f.windowStart;

  let w = windows.get(f.windowStart);
  if (!w) {
    w = { s: f.windowStart, priceToBeat: f.priceToBeat, priceToBeatReliable: f.priceToBeatReliable,
      legs: [], lastPrice: f.currentPrice, lastUpAsk: null, lastDownAsk: null,
      closePrice: null, outcome: null, status: 'attesa',
      gainIfUp: 0, gainIfDown: 0, minGain: 0, maxGain: 0, actualGain: null, upMin: null, downMin: null, calmStart: null, createdAt: Date.now() };
    windows.set(f.windowStart, w);
  }
  // prendi sempre il price-to-beat affidabile (valore esatto al bordo dal buffer)
  if (f.priceToBeatReliable && f.priceToBeat != null) { w.priceToBeat = f.priceToBeat; w.priceToBeatReliable = true; }
  else if (w.priceToBeat == null && f.priceToBeat != null) { w.priceToBeat = f.priceToBeat; }
  w.lastPrice = f.currentPrice; w.lastUpAsk = f.upAsk; w.lastDownAsk = f.downAsk;

  const rel = Math.floor((f.lastTs || Date.now()) / 1000) - f.windowStart; // secondi dentro la finestra
  // FILTRO range-bound ROLLING: da quanti secondi il prezzo è CONTINUAMENTE entro ±BAND dal target.
  // Se esce (breakout) la striscia si azzera; se rientra riparte da capo (altra chance di stabilizzarsi).
  if (w.priceToBeat != null && f.currentPrice != null) {
    const dev = Math.abs(f.currentPrice - w.priceToBeat);
    if (dev <= BAND) { if (w.calmStart == null) w.calmStart = rel; }
    else w.calmStart = null;
  }

  // traccia il MINIMO ask di ENTRAMBI i lati durante la finestra (sempre, 1 o 2 gambe)
  if (f.oddsWindow === f.windowStart) {
    if (f.upAsk != null) w.upMin = w.upMin == null ? f.upAsk : Math.min(w.upMin, f.upAsk);
    if (f.downAsk != null) w.downMin = w.downMin == null ? f.downAsk : Math.min(w.downMin, f.downAsk);
  }

  // strategia: solo con price-to-beat affidabile E quote del CICLO CORRENTE (no quote stantie)
  const oddsOk = f.oddsWindow === f.windowStart && f.upAsk != null && f.downAsk != null;
  if (w.priceToBeatReliable && w.priceToBeat != null && f.currentPrice != null && oddsOk) {
    const haveUp = w.legs.some((l) => l.side === 'Up');
    const haveDown = w.legs.some((l) => l.side === 'Down');
    // entra solo se range-bound CONTINUO da almeno MIN_OBS secondi (la striscia si azzera ai breakout)
    const calmDur = w.calmStart != null ? (rel - w.calmStart) : -1;
    if (w.legs.length === 0 && calmDur >= MIN_OBS && rel <= ENTRY_MAX_REL) {
      if (f.upAsk != null && f.upAsk < THRESH) buy(w, 'Up', f.upAsk, 'entrata', f);
      else if (f.downAsk != null && f.downAsk < THRESH) buy(w, 'Down', f.downAsk, 'entrata', f);
    } else if (w.legs.length === 1) {
      if (haveUp && f.downAsk != null && f.downAsk < THRESH) buy(w, 'Down', f.downAsk, 'sicurezza', f);
      else if (haveDown && f.upAsk != null && f.upAsk < THRESH) buy(w, 'Up', f.upAsk, 'sicurezza', f);
    }
  }
  setStatus(w);
}

function snapshot() {
  const arr = [...windows.values()].filter((w) => w.legs.length > 0).sort((a, b) => b.s - a.s).slice(0, 200);
  return arr.map((w) => ({
    s: w.s,
    iso: new Date(w.s * 1000).toISOString().slice(11, 16),
    priceToBeat: w.priceToBeat, priceToBeatReliable: w.priceToBeatReliable,
    lastPrice: w.lastPrice, closePrice: w.closePrice, outcome: w.outcome,
    distance: w.priceToBeat != null && w.lastPrice != null ? +(w.lastPrice - w.priceToBeat).toFixed(2) : null,
    legs: w.legs.map((l) => ({ side: l.side, price: l.price, shares: l.shares, kind: l.kind, iso: new Date(l.t).toISOString().slice(11, 19) })),
    status: w.status, gainIfUp: w.gainIfUp, gainIfDown: w.gainIfDown, minGain: w.minGain, maxGain: w.maxGain, actualGain: w.actualGain,
    upMin: w.upMin, downMin: w.downMin,
  }));
}

// statistiche cumulate sulle finestre chiuse con almeno una gamba
function stats() {
  let played = 0, locks = 0, nudeWin = 0, nudeLose = 0, realized = 0;
  for (const w of windows.values()) {
    if (w.closePrice == null || w.legs.length === 0) continue;
    played++; realized += w.actualGain || 0;
    if (w.legs.length === 2) locks++;
    else if (w.actualGain > 0) nudeWin++; else nudeLose++;
  }
  return { played, locks, nudeWin, nudeLose, realized: +realized.toFixed(2) };
}

// riconcilia gli esiti delle posizioni rimaste aperte mentre il backend era spento
async function reconcile() {
  const GAMMA = 'https://gamma-api.polymarket.com';
  const now = Math.floor(Date.now() / 1000);
  for (const w of windows.values()) {
    if (w.closePrice != null || w.legs.length === 0 || w.s + WIN >= now) continue;
    try {
      const page = await (await fetch(`${GAMMA}/events?slug=btc-updown-5m-${w.s}`)).json();
      const m = page && page[0] && page[0].markets && page[0].markets[0];
      if (m && m.closed) {
        const pr = JSON.parse(m.outcomePrices);
        w.outcome = pr[0] === '1' ? 'Up' : 'Down';
        if (w.closePrice == null) w.closePrice = w.lastPrice;
        computeGains(w); setStatus(w); db.save(w);
      }
    } catch (_) {}
  }
}
reconcile();

// azzera tutto: posizioni in memoria + DB (per ripartire con dati puliti)
function reset() { windows.clear(); currentS = null; db.clear(); }

module.exports = { onFeed, snapshot, stats, reset, BAND, THRESH, ENTRY_MAX_REL, STAKE };
