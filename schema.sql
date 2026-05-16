-- Enable TimescaleDB extension
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Encrypted locations hypertable
CREATE TABLE locations_encrypted (
    time        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    device_id   TEXT NOT NULL,
    ciphertext  TEXT NOT NULL,
    ip_hash     TEXT,
    user_agent  TEXT
);

SELECT create_hypertable('locations_encrypted', 'time');

-- Compress after 7 days
ALTER TABLE locations_encrypted SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'device_id',
    timescaledb.compress_orderby = 'time DESC'
);
SELECT add_compression_policy('locations_encrypted', INTERVAL '7 days');

-- Auto-delete after 30 days
SELECT add_retention_policy('locations_encrypted', INTERVAL '30 days');

-- Device metadata (populated by dashboard decryption)
CREATE TABLE devices (
    device_id   TEXT PRIMARY KEY,
    fingerprint TEXT,
    ref_tag     TEXT,
    label       TEXT,
    first_seen  TIMESTAMPTZ DEFAULT NOW(),
    last_seen   TIMESTAMPTZ DEFAULT NOW(),
    beacon_id   TEXT,
    is_active   BOOLEAN DEFAULT TRUE
);

-- Geofences
CREATE TABLE geofences (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    polygon     GEOMETRY(POLYGON, 4326),
    alert_on    TEXT CHECK (alert_on IN ('entry', 'exit', 'both')),
    webhook_url TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Alerts log
CREATE TABLE alerts (
    id          SERIAL PRIMARY KEY,
    device_id   TEXT,
    geofence_id INTEGER REFERENCES geofences(id),
    event       TEXT CHECK (event IN ('entry', 'exit')),
    triggered   TIMESTAMPTZ DEFAULT NOW()
);