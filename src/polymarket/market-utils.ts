interface MarketData {
  conditionId?: string;
  closed?: boolean;
  outcomePrices?: string;
  clobTokenIds?: string;
}

export function getTokenPrice(market: MarketData, tokenId: string): number | null {
  const prices = (JSON.parse(market.outcomePrices || '[]') as (string | number)[]).map(Number);
  const tokenIds = JSON.parse(market.clobTokenIds || '[]') as string[];
  const idx = tokenIds.indexOf(tokenId);
  const price = idx >= 0 ? prices[idx] : null;
  return (price != null && price > 0 && !isNaN(price)) ? price : null;
}

export function getResolutionPrice(market: MarketData, tokenId: string): number {
  const prices = (JSON.parse(market.outcomePrices || '[]') as (string | number)[]).map(Number);
  const tokenIds = JSON.parse(market.clobTokenIds || '[]') as string[];
  const idx = tokenIds.indexOf(tokenId);
  if (idx >= 0 && !isNaN(prices[idx])) return prices[idx];
  return 0;
}
