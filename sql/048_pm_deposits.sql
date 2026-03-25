CREATE TABLE IF NOT EXISTS pm_deposits (
  id SERIAL PRIMARY KEY,
  amount NUMERIC(24,8) NOT NULL,
  type VARCHAR(10) NOT NULL CHECK (type IN ('deposit', 'withdraw')),
  note VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed with initial deposits
INSERT INTO pm_deposits (amount, type, note, created_at) VALUES
  (100, 'deposit', 'Initial deposit', '2026-03-20 00:00:00+00'),
  (2, 'deposit', 'Top-up', '2026-03-25 00:00:00+00');
