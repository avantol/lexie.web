const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { Client } = require('@stomp/stompjs');
const { createLookup } = require('./cty-lookup');

// Polyfill WebSocket for @stomp/stompjs in Node.js
Object.assign(global, { WebSocket });

const { lookupCallsign: lookupCountry, entityGrid } = createLookup();

const HTTP_PORT = parseInt(process.env.PORT, 10) || 3000;

// g7vrd SockJS endpoint — raw WebSocket URL
const G7VRD_WS_URL = 'wss://ws.g7vrd.co.uk/dx/websocket';

// --- HTTP Server ---
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// --- WebSocket Server (browser clients) ---
const wss = new WebSocket.Server({ server });

function broadcast(data) {
  const json = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(json);
    }
  });
}

wss.on('connection', (ws) => {
  console.log('Web client connected');
});

// --- Spot processing ---
function processSpot(callsign, country, mode, band, message, grid) {
  if (!callsign || !mode) return;

  const resolvedCountry = lookupCountry(callsign) || country;
  if (!resolvedCountry) return;

  // If no grid from the spot, approximate from cty.dat entity coords
  const resolvedGrid = grid || entityGrid(resolvedCountry) || '';

  const now = new Date().toISOString();

  broadcast({
    type: 'spot',
    callsign,
    country: resolvedCountry,
    mode,
    band: band || '',
    grid: resolvedGrid,
    message: message || '',
    timestamp: now,
  });

  console.log(`[${mode}] ${callsign} -> ${resolvedCountry} (${band || '?'})`);
}

// --- Infer mode from frequency (Hz) and spotter note ---
function inferMode(hz, note) {
  // Check note text first for explicit mode mentions
  if (note) {
    const n = note.toUpperCase();
    if (n.includes('FT2')) return 'FT2';
    if (n.includes('FT8')) return 'FT8';
    if (n.includes('FT4')) return 'FT4';
    if (n.includes('JS8')) return 'JS8';
    if (n.includes('RTTY')) return 'RTTY';
    if (n.includes('PSK')) return 'PSK';
    if (n.includes('WSPR')) return 'WSPR';
    if (n.includes('CW')) return 'CW';
    if (n.includes('SSB') || n.includes('USB') || n.includes('LSB') || n.includes('PHONE')) return 'SSB';
  }
  if (!hz) return null;

  // Frequency offset within band (kHz from band edge) determines mode
  // Common FT8 dial frequencies (Hz)
  const ft8Freqs = [1840000, 3573000, 5357000, 7074000, 10136000, 14074000, 18100000, 21074000, 24915000, 28074000, 50313000];
  const ft4Freqs = [3575500, 7047500, 10140000, 14080000, 18104000, 21140000, 24919000, 28180000, 50318000];

  for (const f of ft8Freqs) { if (Math.abs(hz - f) < 4000) return 'FT8'; }
  for (const f of ft4Freqs) { if (Math.abs(hz - f) < 4000) return 'FT4'; }

  // SSB phone sub-band ranges (Hz) — US-centric but covers most ITU regions
  const ssbRanges = [
    [1800000, 2000000, 1843000], // 160m: above ~1843 kHz is phone
    [3600000, 4000000, 3600000], // 80m: 3600+ is phone (varies by region)
    [7125000, 7300000, 7125000], // 40m: 7125+ is phone
    [14150000, 14350000, 14150000], // 20m: 14150+ is phone
    [18110000, 18168000, 18110000], // 17m: 18110+ is phone
    [21200000, 21450000, 21200000], // 15m: 21200+ is phone
    [24930000, 24990000, 24930000], // 12m: 24930+ is phone
    [28300000, 29700000, 28300000], // 10m: 28300+ is phone
    [50100000, 54000000, 50100000], // 6m: 50100+ is phone
  ];
  for (const [lo, hi, phoneStart] of ssbRanges) {
    if (hz >= phoneStart && hz <= hi) return 'SSB';
  }

  // CW is typically the low end of each band
  const cwRanges = [
    [1800000, 1843000], [3500000, 3600000], [5330500, 5354000],
    [7000000, 7125000], [10100000, 10150000], [14000000, 14150000],
    [18068000, 18110000], [21000000, 21200000], [24890000, 24930000],
    [28000000, 28300000], [50000000, 50100000],
  ];
  for (const [lo, hi] of cwRanges) {
    if (hz >= lo && hz <= hi) return 'CW';
  }

  return null;
}

// --- g7vrd STOMP client ---
function connectG7VRD() {
  const stompClient = new Client({
    brokerURL: G7VRD_WS_URL,
    reconnectDelay: 5000,
    heartbeatIncoming: 0,
    heartbeatOutgoing: 0,
  });

  stompClient.onConnect = () => {
    console.log('Connected to g7vrd STOMP feed');

    // Subscribe to PSK Reporter spots (FT8/FT4/etc.)
    stompClient.subscribe('/topic/psks/v1', (message) => {
      try {
        const spot = JSON.parse(message.body);
        const callsign = spot.tx && spot.tx.callsign;
        const country = spot.tx && spot.tx.country;
        const mode = (spot.mode || '').toUpperCase();
        const band = spot.band || '';
        if (callsign && country && mode) {
          const grid = (spot.tx && spot.tx.grid) || '';
          const msg = spot.db != null ? `${spot.db}dB` : '';
          processSpot(callsign.toUpperCase(), country, mode, band, msg, grid);
        }
      } catch (e) {}
    });

    // Subscribe to DX cluster spots
    stompClient.subscribe('/topic/spots/v1', (message) => {
      try {
        const spot = JSON.parse(message.body);
        const callsign = (spot.remote && spot.remote.callsign)
          || spot.dx || spot.dxCallsign;
        const country = (spot.remote && spot.remote.country)
          || spot.dxCountry;
        const band = spot.band || '';
        const mode = (spot.mode || inferMode(spot.hz, spot.note) || '').toUpperCase();
        if (callsign && country && mode) {
          const grid = spot.grid
            || (spot.remote && spot.remote.grid)
            || '';
          const msg = spot.note || '';
          processSpot(callsign.toUpperCase(), country, mode, band, msg, grid);
        }
      } catch (e) {}
    });

    // Subscribe to skimmer data (CW, RTTY, etc.)
    stompClient.subscribe('/topic/skims/v1', (message) => {
      try {
        const spot = JSON.parse(message.body);
        const callsign = spot.call && spot.call.callsign;
        const country = spot.call && spot.call.country;
        const mode = (spot.mode || '').toUpperCase();
        const band = spot.band || '';
        if (callsign && country && mode) {
          const grid = (spot.call && spot.call.grid) || '';
          const msg = [spot.db != null ? `${spot.db}dB` : '', spot.speed ? `${spot.speed}WPM` : '']
            .filter(Boolean).join(' ');
          processSpot(callsign.toUpperCase(), country, mode, band, msg, grid);
        }
      } catch (e) {}
    });

    // Subscribe to WSPR spots
    stompClient.subscribe('/topic/wsprs/v1', (message) => {
      try {
        const data = JSON.parse(message.body);
        const spots = Array.isArray(data) ? data : [data];
        for (const spot of spots) {
          const callsign = spot.callsign || (spot.tx && spot.tx.callsign);
          const country = spot.country || (spot.tx && spot.tx.country);
          const band = spot.band || '';
          if (callsign && country) {
            const grid = (spot.tx && spot.tx.grid) || spot.grid || '';
            const msg = spot.power != null ? `${spot.power}dBm` : '';
            processSpot(callsign.toUpperCase(), country, 'WSPR', band, msg, grid);
          }
        }
      } catch (e) {}
    });
  };

  stompClient.onStompError = (frame) => {
    console.error('STOMP error:', frame.headers['message']);
    console.error('Details:', frame.body);
  };

  stompClient.onWebSocketClose = () => {
    console.log('g7vrd WebSocket closed — will reconnect');
  };

  stompClient.onWebSocketError = (err) => {
    console.error('g7vrd WebSocket error:', err.message || err);
  };

  stompClient.activate();
  return stompClient;
}

const stomp = connectG7VRD();

server.listen(HTTP_PORT, () => {
  console.log(`Lexie running at http://localhost:${HTTP_PORT}`);
  console.log('Data source: g7vrd STOMP feed (wss://ws.g7vrd.co.uk/dx)');
});
