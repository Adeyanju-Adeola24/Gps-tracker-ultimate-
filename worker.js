// worker.js – Full Phase 1 Worker for GPS Tracker

import trackerPayloadTemplate from './src/tracker-payload.js?raw';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. /payload – serve tracking engine with real public key
    if (url.pathname === '/payload') {
      const publicKeyPem = env.PUBLIC_KEY;
      const payload = trackerPayloadTemplate.replace('YOUR_PUBLIC_KEY_PEM', publicKeyPem);
      return new Response(payload, {
        headers: { 'Content-Type': 'application/javascript' },
      });
    }

    // 2. /api/loc – HTTPS POST fallback
    if (url.pathname === '/api/loc' && request.method === 'POST') {
      const encryptedPayload = await request.text();
      if (!encryptedPayload || encryptedPayload.length > 2000) {
        return new Response('Invalid payload', { status: 400 });
      }
      await storeEncryptedPayload(env, encryptedPayload, request.headers.get('CF-Connecting-IP') || 'unknown', request.headers.get('User-Agent') || '');
      return new Response(JSON.stringify({ status: 'ok' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 3. /pixel – image beacon emergency fallback
    if (url.pathname === '/pixel') {
      const encData = url.searchParams.get('d');
      if (encData) {
        ctx.waitUntil(storeEncryptedPayload(env, encData, request.headers.get('CF-Connecting-IP') || 'unknown', request.headers.get('User-Agent') || ''));
      }
      const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
      return new Response(pixel, {
        headers: {
          'Content-Type': 'image/gif',
          'Content-Length': pixel.length.toString(),
          'Cache-Control': 'no-cache, no-store',
        },
      });
    }

    // 4. /ws – WebSocket upgrade
    if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
      return handleWebSocket(request, env, ctx);
    }

    // 5. Everything else: serve static assets from public/
    return env.ASSETS.fetch(request);
  },
};

// WebSocket handling
function handleWebSocket(request, env, ctx) {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);

  server.accept();

  server.addEventListener('message', async (event) => {
    const encryptedPayload = event.data;
    if (typeof encryptedPayload !== 'string' || encryptedPayload.length > 2000) return;
    try {
      await storeEncryptedPayload(env, encryptedPayload, request.headers.get('CF-Connecting-IP') || 'unknown', request.headers.get('User-Agent') || '');
    } catch (e) {
      console.error('DB insert error:', e);
    }
  });

  server.addEventListener('close', () => {});

  return new Response(null, { status: 101, webSocket: client });
}

// Store encrypted payload in D1
async function storeEncryptedPayload(env, ciphertext, ip, userAgent) {
  const ipHash = await sha256(ip);
  await env.LOCATIONS_DB
    .prepare(
      'INSERT INTO locations_encrypted (time, device_id, ciphertext, ip_hash, user_agent) VALUES (?, ?, ?, ?, ?)'
    )
    .bind(new Date().toISOString(), 'unknown', ciphertext, ipHash, userAgent)
    .run();
}

// Simple SHA-256 hashing using Web Crypto
async function sha256(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
        }
