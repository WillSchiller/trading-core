#!/bin/bash
# Wipe PCA data for fresh start
# Run on instance: bash scripts/wipe-pca-data.sh

set -e

echo "Wiping PCA tables..."

docker exec dislocation-postgres psql -U trader -d dislocation_trader -c "
TRUNCATE pca_signals, pca_residuals, pca_factor_models, pca_prices RESTART IDENTITY;
"

echo "Done. Restart the app to begin fresh."
