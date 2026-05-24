/**
 * Nanosecond-precision timer helpers.
 *
 * Uses `process.hrtime.bigint()` rather than `performance.now()` because some
 * Node builds quantize `performance.now()` at ~1ms — unacceptable for the
 * sub-millisecond steps we measure (status_check_ms, etc).
 */

export type HrTime = bigint;

export function now(): HrTime {
  return process.hrtime.bigint();
}

/** Elapsed milliseconds between two `now()` snapshots, as a float. */
export function elapsedMs(start: HrTime, end: HrTime = now()): number {
  const deltaNs = Number(end - start);
  return deltaNs / 1_000_000;
}
