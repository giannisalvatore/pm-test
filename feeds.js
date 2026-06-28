'use strict';
/*
 * feeds.js — dati LIVE per la strategia BTC Up/Down 5m. SOLO Polymarket.
 *
 * PREZZO Chainlink (RTDS WebSocket): current price + price to beat (valore esatto al
 *   bordo finestra, dal buffer di tick) + chiusura al bordo s+300.
 * QUOTE up/down: BOOK CLOB via WebSocket PUSH (wss://.../ws/market) → ask/bid quasi
 *   istantanei (niente più polling HTTP da ~1s). Si (ri)sottoscrive ai token della
 *   finestra corrente; al cambio finestra resubscribe ai nuovi token.
 */

const GAMMA = 'https://gamma-api.polymarket.com';
const PRICE_WS = 'wss://ws-live-data.polymarket.com';
const BOOK_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const WIN = 300;
const TOL = 2000; // tolleranza (ms) per "valore al bordo"

const state = {
  connected: false, bookConnected: false,
  currentPrice: null, lastTs: null,
  windowStart: null, priceToBeat: null, priceToBeatReliable: false,
  upAsk: null, upBid: null, downAsk: null, downBid: null, oddsTs: null,
  oddsWindow: null,
  rv15: null, // volatilita' realizzata ultimi 15 min ($) — segnale di "finestra oscillante"
};

const buffer = new Map(); // ts(ms) -> value (prezzo Chainlink)
let tokens = { s: null, up: null, down: null };
const listeners = [];
function onUpdate(fn) { listeners.push(fn); }
function emit() { for (const fn of listeners) { try { fn(state); } catch (_) {} } }

// ---------------- buffer prezzo + price to beat ----------------
function addTick(ts, value) { if (typeof ts === 'number' && typeof value === 'number') buffer.set(ts, value); }
function prune() {
  if (buffer.size < 1200) return;
  const cutoff = Date.now() - 20 * 60 * 1000;
  for (const ts of buffer.keys()) if (ts < cutoff) buffer.delete(ts);
}
function priceAt(tsMs) {
  if (buffer.has(tsMs)) return buffer.get(tsMs);
  let best = null, bestDiff = Infinity;
  for (const [ts, v] of buffer) { const d = Math.abs(ts - tsMs); if (d <= TOL && d < bestDiff) { bestDiff = d; best = v; } }
  return best;
}

// volatilita' realizzata sugli ultimi `ms`: sqrt(somma dei (delta tra tick consecutivi)^2).
// Serve copertura sufficiente del periodo, altrimenti null (non si filtra finche' non c'e' storia).
function realizedVol(ms) {
  const now = state.lastTs || Date.now();
  const cutoff = now - ms;
  const pts = [];
  for (const [ts, v] of buffer) if (ts >= cutoff && typeof v === 'number') pts.push([ts, v]);
  if (pts.length < (ms / 1000) * 0.5) return null; // serve almeno ~meta' dei secondi
  pts.sort((a, b) => a[0] - b[0]);
  let sq = 0;
  for (let i = 1; i < pts.length; i++) { const d = pts[i][1] - pts[i - 1][1]; sq += d * d; }
  return Math.sqrt(sq);
}

// ---------------- WebSocket PREZZO (Chainlink RTDS) ----------------
function connectPriceWS() {
  if (typeof WebSocket === 'undefined') { console.error('Serve Node 22+ (WebSocket nativo)'); return; }
  const ws = new WebSocket(PRICE_WS);
  const wd = setTimeout(() => { try { ws.close(); } catch (_) {} }, 8000); // watchdog: se non apre, chiudi->retry
  ws.addEventListener('open', () => {
    clearTimeout(wd);
    state.connected = true;
    ws.send(JSON.stringify({ action: 'subscribe', subscriptions: [{ topic: 'crypto_prices_chainlink', type: '*', filters: '{"symbol":"btc/usd"}' }] }));
    console.log(new Date().toISOString(), 'WS prezzo Chainlink connesso');
  });
  ws.addEventListener('message', (e) => {
    let m; try { m = JSON.parse(e.data); } catch (_) { return; }
    const p = m && m.payload; if (!p) return;
    if (Array.isArray(p.data)) { for (const d of p.data) addTick(d.timestamp, d.value); prune(); recompute(); emit(); return; }
    if (p.symbol === 'btc/usd' && typeof p.value === 'number') {
      const ts = p.timestamp || Date.now();
      addTick(ts, p.value); state.currentPrice = p.value; state.lastTs = ts;
      prune(); recompute(); emit();
    }
  });
  ws.addEventListener('close', () => { clearTimeout(wd); state.connected = false; setTimeout(connectPriceWS, 2000); });
  ws.addEventListener('error', () => { try { ws.close(); } catch (_) {} });
}

// finestra corrente + price to beat (valore al bordo esatto); invalida quote vecchie al cambio
function recompute() {
  const nowSec = state.lastTs ? Math.floor(state.lastTs / 1000) : Math.floor(Date.now() / 1000);
  const s = Math.floor(nowSec / WIN) * WIN;
  if (s !== state.windowStart) {
    state.upAsk = state.downAsk = state.upBid = state.downBid = null;
    state.oddsWindow = null;
  }
  state.windowStart = s;
  const ptb = priceAt(s * 1000);
  if (ptb != null) { state.priceToBeat = ptb; state.priceToBeatReliable = true; } else state.priceToBeatReliable = false;
  state.rv15 = realizedVol(15 * 60 * 1000); // segnale di volatilita' recente (null finche' manca storia)
}

// ---------------- token della finestra (Gamma) ----------------
async function ensureTokens(s) {
  if (tokens.s === s && tokens.up) return;
  try {
    const page = await (await fetch(`${GAMMA}/events?slug=btc-updown-5m-${s}`)).json();
    const m = page && page[0] && page[0].markets && page[0].markets[0];
    if (m && m.clobTokenIds) { const t = JSON.parse(m.clobTokenIds); tokens = { s, up: t[0], down: t[1] }; }
  } catch (_) {}
}

// ---------------- WebSocket BOOK (CLOB) — quote push ----------------
const books = new Map(); // assetId -> {bid, ask}
let bookWs = null;
let subTokens = { s: null, up: null, down: null };

function applyOdds() {
  const s = state.windowStart;
  if (subTokens.s !== s) return; // sottoscrizione non ancora per la finestra corrente
  const u = books.get(subTokens.up), d = books.get(subTokens.down);
  if (u) { state.upAsk = u.ask; state.upBid = u.bid; }
  if (d) { state.downAsk = d.ask; state.downBid = d.bid; }
  if (u || d) { state.oddsWindow = s; state.oddsTs = Date.now(); emit(); }
}
function setBest(assetId, bid, ask) {
  const b = books.get(assetId) || { bid: null, ask: null };
  if (bid != null) b.bid = bid;
  if (ask != null) b.ask = ask;
  books.set(assetId, b);
  applyOdds();
}
function handleBook(o) {
  if (!o || !o.asset_id) return;
  const asks = (o.asks || []).map((x) => +x.price).filter((p) => p > 0);
  const bids = (o.bids || []).map((x) => +x.price).filter((p) => p > 0);
  setBest(o.asset_id, bids.length ? Math.max(...bids) : null, asks.length ? Math.min(...asks) : null);
}
function handlePriceChange(c) {
  if (!c || !c.asset_id) return;
  const bid = c.best_bid != null && c.best_bid !== '' ? +c.best_bid : null;
  const ask = c.best_ask != null && c.best_ask !== '' ? +c.best_ask : null;
  if (bid != null || ask != null) setBest(c.asset_id, bid, ask);
}
function connectBookWS(up, down, s) {
  if (bookWs) { try { bookWs.close(); } catch (_) {} bookWs = null; }
  books.clear();
  subTokens = { s, up, down };
  const ws = new WebSocket(BOOK_WS);
  bookWs = ws;
  const wd = setTimeout(() => { try { ws.close(); } catch (_) {} }, 8000); // watchdog
  ws.addEventListener('open', () => { clearTimeout(wd); state.bookConnected = true; ws.send(JSON.stringify({ type: 'market', assets_ids: [up, down] })); });
  ws.addEventListener('message', (e) => {
    let m; try { m = JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString()); } catch (_) { return; }
    if (Array.isArray(m)) { for (const o of m) handleBook(o); return; }       // snapshot iniziale (array)
    if (m.price_changes) { for (const c of m.price_changes) handlePriceChange(c); return; } // delta (con best_bid/ask)
    if (m.asset_id && (m.bids || m.asks)) handleBook(m);                       // snapshot singolo
  });
  ws.addEventListener('close', () => { clearTimeout(wd); if (bookWs === ws) { bookWs = null; state.bookConnected = false; } });
  ws.addEventListener('error', () => { try { ws.close(); } catch (_) {} });
}

// controlla periodicamente se serve (ri)sottoscrivere ai token della finestra corrente
async function bookManager() {
  try {
    const s = state.windowStart != null ? state.windowStart : Math.floor(Date.now() / 1000 / WIN) * WIN;
    await ensureTokens(s);
    if (tokens.up && tokens.s === s && (bookWs === null || subTokens.s !== s)) connectBookWS(tokens.up, tokens.down, s);
  } catch (_) {}
  setTimeout(bookManager, 1500);
}

function start() { connectPriceWS(); bookManager(); }

module.exports = { state, onUpdate, start, priceAt, WIN };
