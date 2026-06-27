'use strict';
/*
 * feeds.js — dati LIVE per la strategia BTC Up/Down 5m. SOLO Polymarket.
 *
 * PRICE TO BEAT = valore Chainlink ESATTO all'istante di apertura finestra (eventStartTime
 * = s*1000), come usa Polymarket per risolvere. Per averlo preciso teniamo un BUFFER di
 * tick (timestamp→valore) alimentato dallo SNAPSHOT iniziale (il socket manda l'array
 * storico per-secondo) + dagli update. priceToBeat = buffer al timestamp del bordo.
 * Stesso per la CHIUSURA = valore al bordo s+300.
 *
 * Quote UP/DOWN = book CLOB reale (ask/bid) ogni secondo.
 */

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const WS_URL = 'wss://ws-live-data.polymarket.com';
const WIN = 300;
const TOL = 2000; // tolleranza (ms) per "valore al bordo"

const state = {
  connected: false,
  currentPrice: null, lastTs: null,
  windowStart: null, priceToBeat: null, priceToBeatReliable: false,
  upAsk: null, upBid: null, downAsk: null, downBid: null, oddsTs: null,
  oddsWindow: null, // finestra a cui appartengono le quote (evita quote stantie al bordo)
};

const buffer = new Map(); // ts(ms) -> value
let tokens = { s: null, up: null, down: null };
const listeners = [];
function onUpdate(fn) { listeners.push(fn); }
function emit() { for (const fn of listeners) { try { fn(state); } catch (_) {} } }

function addTick(ts, value) {
  if (typeof ts !== 'number' || typeof value !== 'number') return;
  buffer.set(ts, value);
}
function prune() {
  if (buffer.size < 1200) return;
  const cutoff = Date.now() - 20 * 60 * 1000; // tieni ~20 min
  for (const ts of buffer.keys()) if (ts < cutoff) buffer.delete(ts);
}

// valore Chainlink al timestamp tsMs: tick più vicino entro ±TOL (preferendo <= tsMs)
function priceAt(tsMs) {
  if (buffer.has(tsMs)) return buffer.get(tsMs);
  let best = null, bestDiff = Infinity;
  for (const [ts, v] of buffer) {
    const d = Math.abs(ts - tsMs);
    if (d <= TOL && d < bestDiff) { bestDiff = d; best = v; }
  }
  return best;
}

// ---------------- Chainlink price (WebSocket RTDS) ----------------
function connectWS() {
  if (typeof WebSocket === 'undefined') { console.error('Serve Node 22+ (WebSocket nativo)'); return; }
  const ws = new WebSocket(WS_URL);
  ws.addEventListener('open', () => {
    state.connected = true;
    ws.send(JSON.stringify({ action: 'subscribe', subscriptions: [{ topic: 'crypto_prices_chainlink', type: '*', filters: '{"symbol":"btc/usd"}' }] }));
    console.log(new Date().toISOString(), 'WS Chainlink connesso');
  });
  ws.addEventListener('message', (e) => {
    let m; try { m = JSON.parse(e.data); } catch (_) { return; }
    const p = m && m.payload;
    if (!p) return;
    // SNAPSHOT: payload.data = array storico per-secondo
    if (Array.isArray(p.data)) {
      for (const d of p.data) addTick(d.timestamp, d.value);
      prune(); recompute(); emit();
      return;
    }
    // UPDATE: payload.value singolo
    if (p.symbol === 'btc/usd' && typeof p.value === 'number') {
      const ts = p.timestamp || Date.now();
      addTick(ts, p.value);
      state.currentPrice = p.value; state.lastTs = ts;
      prune(); recompute(); emit();
    }
  });
  ws.addEventListener('close', () => { state.connected = false; setTimeout(connectWS, 2000); });
  ws.addEventListener('error', () => { try { ws.close(); } catch (_) {} });
}

// ricalcola finestra corrente + price to beat dal buffer (valore al bordo esatto)
function recompute() {
  const nowSec = state.lastTs ? Math.floor(state.lastTs / 1000) : Math.floor(Date.now() / 1000);
  const s = Math.floor(nowSec / WIN) * WIN;
  if (s !== state.windowStart) {
    // NUOVA finestra: invalida SUBITO le quote del ciclo precedente (erano dell'altro mercato!)
    state.upAsk = state.downAsk = state.upBid = state.downBid = null;
    state.oddsWindow = null;
  }
  state.windowStart = s;
  const ptb = priceAt(s * 1000);
  if (ptb != null) { state.priceToBeat = ptb; state.priceToBeatReliable = true; }
  else { state.priceToBeatReliable = false; } // non abbiamo il tick del bordo
}

// ---------------- Quote UP/DOWN (book CLOB) ----------------
async function ensureTokens(s) {
  if (tokens.s === s && tokens.up) return;
  try {
    const page = await (await fetch(`${GAMMA}/events?slug=btc-updown-5m-${s}`)).json();
    const m = page && page[0] && page[0].markets && page[0].markets[0];
    if (m && m.clobTokenIds) { const t = JSON.parse(m.clobTokenIds); tokens = { s, up: t[0], down: t[1] }; }
  } catch (_) {}
}
async function book(tk) {
  try {
    const b = await (await fetch(`${CLOB}/book?token_id=${tk}`)).json();
    const bids = (b.bids || []).map((x) => +x.price).filter((x) => x > 0);
    const asks = (b.asks || []).map((x) => +x.price).filter((x) => x > 0);
    return { ask: asks.length ? Math.min(...asks) : null, bid: bids.length ? Math.max(...bids) : null };
  } catch (_) { return { ask: null, bid: null }; }
}
async function pollOdds() {
  try {
    const s = state.windowStart != null ? state.windowStart : Math.floor(Date.now() / 1000 / WIN) * WIN;
    await ensureTokens(s);
    if (tokens.up && tokens.s === s) {
      const u = await book(tokens.up), d = await book(tokens.down);
      state.upAsk = u.ask; state.upBid = u.bid; state.downAsk = d.ask; state.downBid = d.bid;
      state.oddsWindow = s; state.oddsTs = Date.now(); // quote agganciate a QUESTA finestra
      emit();
    }
  } catch (_) {}
  setTimeout(pollOdds, 1000);
}

function start() { connectWS(); pollOdds(); }

module.exports = { state, onUpdate, start, priceAt, WIN };
