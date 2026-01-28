# PCA Factor Recovery - Research Note

**Source**: Systematic Long Short Newsletter, Jan 28 2026

## Core Insight

Run PCA on 500+ assets and the first 5-10 eigenvectors **converge to actual systematic factors**, not arbitrary statistical directions.

**The test is simple**: K eigenvalues explode as you add assets, the rest stay bounded.

## Why It Works

### Eigenvalue Growth Mechanism

- Factor eigenvalues scale with N (number of assets)
- Residual eigenvalues stay bounded
- Adding assets that load on market factor → that eigenvalue grows
- Idiosyncratic noise doesn't compound (Apple's noise independent of Microsoft's)

### Approximate Factor Structure

Strict factor structure (residuals uncorrelated) is unrealistic. Approximate factor structure relaxes this:

- Residual correlations allowed
- Requirement: residual eigenvalues must be **bounded** as N grows
- If 100 tech stocks have pairwise residual correlations ~0.10, that creates another factor (K+1 eigenvalues exploding)

### Eigenvector Convergence Theorem

Eigenvectors corresponding to unbounded eigenvalues **converge to true factor loadings**. Not "approximately represent" — mathematically converge.

- Convergence rate depends on gap between factor and residual eigenvalues
- 100x gap = fast convergence, easy separation
- 2x gap = need much more data

## Practical Implementation

```python
import numpy as np
from sklearn.covariance import LedoitWolf

# Shrinkage when N/T > 0.3
lw = LedoitWolf().fit(returns)
cov_matrix = lw.covariance_

eigenvalues, eigenvectors = np.linalg.eigh(cov_matrix)

# Sort descending
idx = eigenvalues.argsort()[::-1]
eigenvalues = eigenvalues[idx]
eigenvectors = eigenvectors[:, idx]

# Extract factor loadings (scaled eigenvectors)
K = 5  # From scree plot
factor_loadings = eigenvectors[:, :K] * np.sqrt(eigenvalues[:K])
```

## Validation

- First eigenvector should correlate **0.9+** with cap-weighted market index
- Second eigenvector often loads small-cap positive, large-cap negative (size)
- Use scree plot: look for "elbow" where eigenvalues drop sharply
- For diversified portfolios, K typically 5-10

## Implications for Crypto PCA

Our current implementation uses 12 assets. This is **below the convergence threshold**.

**Actions to consider**:
1. Expand asset universe to 30-50+ liquid crypto assets
2. Monitor variance explained by PC1 (currently 81% - good)
3. Track eigenvalue ratios as we add assets
4. First eigenvector should correlate with BTC-weighted market index

## Reference

Chamberlain & Rothschild: "Arbitrage, Factor Structure, and Mean-Variance Analysis on Large Asset Markets"
