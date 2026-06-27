'use strict';
/*
 * server.js — server di test per la dashboard LIVE della strategia.
 * Avvio:  node NEW/server.js   →  http://localhost:4000
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const feeds = require('./feeds');
const engine = require('./engine');

feeds.onUpdate(engine.onFeed);
feeds.start();

const INDEX = path.join(__dirname, 'public', 'index.html');

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/state')) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      feed: feeds.state,
      params: { band: engine.BAND, thresh: engine.THRESH, entryMaxRel: engine.ENTRY_MAX_REL, stake: engine.STAKE },
      windows: engine.snapshot(),
      stats: engine.stats(),
    }));
    return;
  }
  try {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(fs.readFileSync(INDEX));
  } catch (e) {
    res.statusCode = 500; res.end('errore: ' + e.message);
  }
});

const PORT = 4000;
server.listen(PORT, () => console.log('NEW dashboard → http://localhost:' + PORT));
