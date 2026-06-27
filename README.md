# pm-test — BTC Up/Down 5m (paper test)

Dashboard live di **test** per la strategia "BTC Up or Down 5m" di Polymarket.
Dati **100% Polymarket**: prezzo Chainlink via socket RTDS + quote dal book CLOB.
È **paper trading** (nessun soldo reale): mostra quando comprerebbe e il guadagno min/max/reale.

## Requisiti
- Node 22+ (usa fetch, WebSocket e SQLite nativi — **zero dipendenze** da installare)

## Avvio
```
npm start
```
(equivale a `node --experimental-sqlite --no-warnings server.js`)

Dashboard → http://localhost:4000

## Strategia
- **Price to beat** = valore Chainlink all'istante esatto di apertura finestra (come Polymarket).
- **Entrata** (solo nei primi 150s): se `|prezzo − price to beat| ≤ 15` e l'ask di un lato `< 0,43` → $1 su quel lato.
- **Messa in sicurezza**: appena l'altro lato va `< 0,43` → $1 anche sull'altro (lock).
- $1 per posizione → payout del lato vincente = `1/prezzo_acquisto`.

## File
- `server.js` — http server + API (`/api/state`)
- `feeds.js` — feed live (prezzo Chainlink + quote CLOB)
- `engine.js` — motore strategia + persistenza + riconciliazione esiti
- `db.js` — persistenza posizioni su SQLite (`node:sqlite`)
- `public/index.html` — dashboard

Le posizioni sono salvate in `data/positions.db` (escluso dal repo) e sopravvivono ai riavvii.
