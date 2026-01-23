export function normalizeSymbol(symbol: string): string {
  const upper = symbol.toUpperCase().replace('-', '').replace('/', '');

  if (upper === 'ETHUSDC' || upper === 'ETHUSDC' || upper === 'ETH/USDC') return 'WETH/USDC';
  if (upper === 'ETHUSD' || upper === 'ETH-USD') return 'WETH/USDC';
  if (upper === 'CBETHETH' || upper === 'CBETH-ETH') return 'cbETH/WETH';
  if (upper === 'CBETHUSD' || upper === 'CBETH-USD') return 'cbETH/USDC';

  return symbol;
}

export function parseCanonicalPair(pair: string): { base: string; quote: string } {
  const parts = pair.split('/');
  if (parts.length !== 2) {
    throw new Error(`Invalid pair format: ${pair}`);
  }
  return { base: parts[0], quote: parts[1] };
}

export function buildCanonicalPair(base: string, quote: string): string {
  return `${base}/${quote}`;
}
