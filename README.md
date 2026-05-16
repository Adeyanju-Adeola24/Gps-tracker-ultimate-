# Gps-tracker-ultimate-

A lightweight GPS tracking proxy and client payload. The repository contains:

- proxy-server.js — HTTPS + WebSocket proxy that accepts encrypted location payloads, publishes realtime updates to Redis, and inserts ciphertext into a TimescaleDB hypertable.
- tracker-payload.js — Client-side JS payload that collects geolocation, fingerprints and encrypts location data with the admin public key. Designed to be served from /payload.
- generate-keys.js — Small Node script to generate an RSA keypair (admin-public.pem / admin-private.pem).
- schema.sql — TimescaleDB/Postgres schema for storing encrypted locations, devices, geofences and alerts.
- firebase-rules.json — example Realtime Database rules referenced by the payload.

This README explains how to set up and run the project locally and in production, and includes security notes.

---

## Quick architecture

1. Client (tracker-payload.js) collects location data in the browser, encrypts it with the admin public key and ships it using a tiered transport (WebSocket, HTTP POST, Firebase, image pixel).
2. Proxy (proxy-server.js) accepts encrypted blobs via WS/POST/pixel, publishes realtime updates to Redis channel `location_updates` and stores ciphertext in a TimescaleDB hypertable `locations_encrypted`.
3. Dashboard (not included) subscribes to Redis, decrypts ciphertext using the admin private key and populates the `devices` table / UI.

---

## Prerequisites

- Node.js 16+ (for proxy and helper scripts)
- PostgreSQL with TimescaleDB extension (or TimescaleDB-managed service)
- Redis for pub/sub
- Valid TLS certificate (privkey.pem + fullchain.pem) or run behind a TLS terminator (recommended)
- (Optional) Firebase project if you plan to use Firebase transport from the client

---

## Important security note

- The admin private key (admin-private.pem) must be kept secret and must never be committed to the repository. Add it to `.gitignore` and store it securely (Vault, KMS, environment, etc.).
- If you ever accidentally commit the private key, rotate the keypair immediately and invalidate the old key.
- The payload contains a Firebase config object — review your Firebase DB rules and security settings before enabling Firebase transport.

---

## Environment variables

The proxy reads configuration from environment variables. Recommended to create a `.env` file in the project root for local development. The key variables used by `proxy-server.js`:

- PORT — port to run the HTTPS server (default: 443)
- DB_HOST — Postgres host (default: localhost)
- DB_PORT — Postgres port (default: 5432)
- DB_NAME — database name (default: tracker)
- DB_USER — database user (default: tracker)
- DB_PASS — database password (default: secret)
- REDIS_URL — Redis connection string (default: redis://localhost:6379)
- PUBLIC_KEY_PATH — path to admin public key PEM used by the proxy to embed into /payload (default: ./admin-public.pem)
- SSL_KEY_PATH — path to TLS private key (default: ./privkey.pem)
- SSL_CERT_PATH — path to TLS certificate (default: ./fullchain.pem)

Example `.env` (do NOT commit):

```
PORT=443
DB_HOST=localhost
DB_PORT=5432
DB_NAME=tracker
DB_USER=tracker
DB_PASS=supersecretpassword
REDIS_URL=redis://localhost:6379
PUBLIC_KEY_PATH=./admin-public.pem
SSL_KEY_PATH=./privkey.pem
SSL_CERT_PATH=./fullchain.pem
```

---

## Setup

1. Clone the repository and install dependencies (create package.json if not present):

   ```bash
   git clone https://github.com/Adeyanju-Adeola24/Gps-tracker-ultimate-.git
   cd Gps-tracker-ultimate-
   npm init -y
   npm install express ws pg ioredis dotenv
   # optionally: npm i express-rate-limit helmet
   ```

2. Add a `.gitignore` and ignore sensitive files:

   Recommended `.gitignore` entries:
   ```gitignore
   node_modules/
   .env
   *.pem
   admin-private.pem
   npm-debug.log
   ```

3. Generate an RSA keypair for admin (local dev):

   ```bash
   node generate-keys.js
   ```

   This will write `admin-public.pem` and `admin-private.pem` into the repo folder. Move `admin-private.pem` to a safe place (outside the repo) and ensure it is ignored by git.

4. Prepare the database:

   - Create the database and user in Postgres.
   - Install/enable TimescaleDB extension for your Postgres instance.
   - Run the schema to create the hypertable and auxiliary tables:

   ```bash
   psql -h $DB_HOST -U $DB_USER -d $DB_NAME -f schema.sql
   ```

   Note: schema.sql creates `locations_encrypted` as a hypertable and adds compression/retention policies. Adjust retention/compression to meet your privacy requirements.

5. Ensure Redis is running and reachable by the proxy.

6. Provide TLS certificates:

   - For production, place `privkey.pem` and `fullchain.pem` (or set SSL_KEY_PATH/SSL_CERT_PATH to the correct files) or run the proxy behind a TLS terminator (load balancer / nginx / cloud LB).

7. Create a `.env` file (see example above) or export the ENV vars, then start the proxy:

   ```bash
   node proxy-server.js
   ```

   The server will read `admin-public.pem` and embed it into the served `/payload` JS file so clients can encrypt location data with that public key.

---

## How the client works

- Serve `tracker-payload.js` from the proxy at `/payload`. The proxy will replace the placeholder `YOUR_PUBLIC_KEY_PEM` in `tracker-payload.js` with the contents of `admin-public.pem` at runtime before returning the JS.
- Clients will generate a persistent beacon ID, capture geolocation with `navigator.geolocation.watchPosition`, build an object with telemetry, encrypt it using Web Crypto (RSA-OAEP with the public key), then attempt to send the ciphertext over WebSocket, HTTP POST (`/api/loc`), Firebase, or an image pixel as a final fallback.

---

## Notes, hardening and TODOs

- Add `package.json` and proper dependency management.
- Add `.github/workflows` for CI (linting & tests).
- Add input validation and rate-limiting to the proxy (consider `express-rate-limit`).
- Add better error handling when reading key/cert files — currently `proxy-server.js` reads them synchronously and the server will crash if missing.
- Implement authentication for dashboard endpoints and secure the private key using a secrets manager.
- Consider HSTS, helmet, and other HTTP security headers if serving directly.
- Add monitoring and alerting for DB/backfill failures.

---

## Troubleshooting

- If the server crashes on startup: check that SSL_KEY_PATH, SSL_CERT_PATH and PUBLIC_KEY_PATH point to valid PEM files and are readable by the process.
- If DB inserts fail: verify the connection details, confirm TimescaleDB extension is enabled and the `locations_encrypted` table exists.
- If the `/payload` served JS does not contain a public key: confirm the proxy can read the `admin-public.pem` and that the placeholder string `YOUR_PUBLIC_KEY_PEM` in `tracker-payload.js` matches exactly.

---

## License

Add a LICENSE file if you plan to publish or share this project. No license is included in this repository by default.

---

If you want, I can also:
- Add a `.gitignore` and `package.json` with recommended dependencies,
- Harden `proxy-server.js` with improved error handling and rate limiting,
- Create a basic GitHub Actions workflow for CI,
- Scaffold a minimal dashboard that subscribes to Redis and decrypts payloads (requires placing the admin private key securely).

Which of the above should I create next?