const SCALE = 1_000_000n;

export function toMicros(value: string): bigint {
  if (value === '' || value === 'NaN' || value === 'Infinity' || value === '-Infinity') {
    throw new Error(`Invalid numeric value for micros conversion: "${value}"`);
  }
  const str = value;
  const negative = str.startsWith('-');
  const abs = negative ? str.slice(1) : str;
  const dotIdx = abs.indexOf('.');
  if (dotIdx === -1) {
    const raw = BigInt(abs) * SCALE;
    return negative ? -raw : raw;
  }
  const intPart = abs.slice(0, dotIdx) || '0';
  const fracPart = abs.slice(dotIdx + 1);
  const frac6 = (fracPart + '000000').slice(0, 6);
  const raw = BigInt(intPart) * SCALE + BigInt(frac6);
  return negative ? -raw : raw;
}

export function fromMicros(micros: bigint): string {
  const negative = micros < 0n;
  const abs = negative ? -micros : micros;
  const intPart = abs / SCALE;
  const fracPart = abs % SCALE;
  const fracStr = fracPart.toString().padStart(6, '0');
  return negative ? `-${intPart}.${fracStr}` : `${intPart}.${fracStr}`;
}

export function formatUsd(micros: bigint): string {
  const str = fromMicros(micros);
  const dotIdx = str.indexOf('.');
  if (dotIdx === -1) return `${str}.00`;
  return str.slice(0, dotIdx + 3);
}

export function configToMicros(value: number): bigint {
  return BigInt(Math.round(value * 1_000_000));
}

export function mulDiv(a: bigint, b: bigint): bigint {
  return (a * b) / SCALE;
}

export const ZERO_MICROS = 0n;
export const MICROS_SCALE = SCALE;
