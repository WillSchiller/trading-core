CREATE TABLE IF NOT EXISTS observatory_heartbeat (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  quotes_seen_1m INTEGER NOT NULL DEFAULT 0,
  signals_written_1m INTEGER NOT NULL DEFAULT 0,
  active_positions INTEGER NOT NULL DEFAULT 0,
  pca_assets_tracked INTEGER NOT NULL DEFAULT 0,
  db_ok BOOLEAN NOT NULL DEFAULT true
);
