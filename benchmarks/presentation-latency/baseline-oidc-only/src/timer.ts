/**
 * Nanosecond-precision timer helpers.
 *
 * Uses `process.hrtime.bigint()` rather than `performance.now()` because some
 * Node builds quantize `performance.now()` at ~1ms — unacceptable for the
 * sub-millisecond steps we measure (jwt_verify_ms, session_create_ms).
 */

export type HrTime = bigint;

export function now(): HrTime {
  return process.hrtime.bigint();
}

/** Elapsed milliseconds between two `now()` snapshots, as a float. */
export function elapsedMs(start: HrTime, end: HrTime = now()): number {
  // Convert ns -> ms while preserving sub-ms precision.
  // BigInt can't be divided into a float directly; we cast through Number after
  // narrowing to a safe magnitude (always safe for elapsed wall time on a single run).
  const deltaNs = Number(end - start);
  return deltaNs / 1_000_000;
}

/** Wraps an async call, returns [resultOrError, elapsedMs]. */
export async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const t0 = now();
  const result = await fn();
  return { result, ms: elapsedMs(t0) };
}
