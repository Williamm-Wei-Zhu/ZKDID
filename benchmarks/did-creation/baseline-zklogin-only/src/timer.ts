export type HrTime = bigint;
export function now(): HrTime { return process.hrtime.bigint(); }
export function elapsedMs(start: HrTime, end: HrTime = now()): number {
  return Number(end - start) / 1_000_000;
}
