-- Add protocol venue
INSERT INTO venues (name, venue_type, is_anchor, is_enabled) VALUES
    ('protocol', 'cex', TRUE, TRUE)
ON CONFLICT (name) DO NOTHING;

-- Add new pairs
INSERT INTO pairs (base_asset, quote_asset, is_enabled) VALUES
    ('cbBTC', 'USDC', TRUE),
    ('cbBTC', 'WETH', TRUE)
ON CONFLICT (base_asset, quote_asset) DO NOTHING;

-- Add connector health for protocol venue
INSERT INTO connector_health (venue_id)
SELECT id FROM venues v
WHERE v.name = 'protocol'
AND NOT EXISTS (SELECT 1 FROM connector_health ch WHERE ch.venue_id = v.id);
