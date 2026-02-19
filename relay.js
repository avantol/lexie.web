#!/usr/bin/env node
// Lexie Relay — runs on the local machine next to WSJT-X.
// Captures UDP packets and forwards them over WebSocket to a remote Lexie server.
//
// Usage:
//   node relay.js wss://your-server.com/relay?key=YOUR_SECRET
//   node relay.js ws://your-server.com/relay?key=YOUR_SECRET
//
// Or set via environment:
//   LEXIE_SERVER=wss://your-server.com/relay?key=YOUR_SECRET node relay.js

const dgram = require('dgram');
const WebSocket = require('ws');

const WSJTX_PORT = parseInt(process.env.WSJTX_PORT, 10) || 2237;
const MULTICAST_ADDR = '224.0.0.1';
const SERVER_URL = process.argv[2] || process.env.LEXIE_SERVER;

if (!SERVER_URL) {
  console.error('Usage: node relay.js <server-url>');
  console.error('  e.g. node relay.js wss://lexie.example.com/relay?key=mysecret');
  console.error('  or:  LEXIE_SERVER=wss://... node relay.js');
  process.exit(1);
}

let ws = null;
let packetCount = 0;

function connectWebSocket() {
  console.log(`Connecting to ${SERVER_URL.replace(/key=[^&]+/, 'key=***')}...`);
  ws = new WebSocket(SERVER_URL);

  ws.on('open', () => {
    console.log('Connected to Lexie server');
  });

  ws.on('close', () => {
    console.log('Disconnected from server — reconnecting in 5s...');
    ws = null;
    setTimeout(connectWebSocket, 5000);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
    try { ws.close(); } catch {}
  });
}

connectWebSocket();

// --- UDP Listener ---
const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });

udp.on('message', (msg) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(msg);  // Forward raw binary packet
    packetCount++;
    if (packetCount % 100 === 0) {
      console.log(`Forwarded ${packetCount} packets`);
    }
  }
});

udp.on('error', (err) => {
  console.error('UDP error:', err.message);
});

udp.on('listening', () => {
  const addr = udp.address();
  console.log(`Listening for WSJT-X on UDP ${addr.address}:${addr.port}`);
  try {
    udp.addMembership(MULTICAST_ADDR);
    console.log(`Joined multicast group ${MULTICAST_ADDR}`);
  } catch (e) {
    console.log('Multicast join skipped:', e.message);
  }
});

udp.bind(WSJTX_PORT);
