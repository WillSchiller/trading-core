export function sqrtPriceX96ToPrice(
  sqrtPriceX96: bigint,
  token0Decimals: number,
  token1Decimals: number
): number {
  const Q96 = 2n ** 96n;
  const sqrtPriceX96Number = Number(sqrtPriceX96);
  const Q96Number = Number(Q96);
  const price = (sqrtPriceX96Number / Q96Number) ** 2;
  const decimalAdjustment = 10 ** (token0Decimals - token1Decimals);
  return price * decimalAdjustment;
}

export function calculateSpreadBps(cexMid: number, dexMid: number): number {
  return ((dexMid - cexMid) / cexMid) * 10000;
}

export function bpsToDecimal(bps: number): number {
  return bps / 10000;
}

export function decimalToBps(decimal: number): number {
  return decimal * 10000;
}
