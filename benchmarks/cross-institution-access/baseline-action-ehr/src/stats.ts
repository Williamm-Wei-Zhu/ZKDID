/**
 * Descriptive statistics for the latency series.
 *
 * Percentiles use linear interpolation on the sorted sample (Excel
 * PERCENTILE / numpy default convention).
 */

export interface Stats {
  count: number;
  success_count: number;
  failure_count: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  std: number;
  min: number;
  max: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

export function computeStats(successValues: number[], failureCount: number): Stats {
  const successCount = successValues.length;
  const totalCount = successCount + failureCount;
  if (successCount === 0) {
    return {
      count: totalCount, success_count: 0, failure_count: failureCount,
      mean: NaN, p50: NaN, p95: NaN, p99: NaN, std: NaN, min: NaN, max: NaN,
    };
  }
  const sorted = [...successValues].sort((a, b) => a - b);
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  const variance =
    sorted.reduce((s, v) => s + (v - mean) * (v - mean), 0) /
    Math.max(sorted.length - 1, 1);
  const std = Math.sqrt(variance);
  return {
    count: totalCount,
    success_count: successCount,
    failure_count: failureCount,
    mean,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    std,
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

export function formatStats(name: string, s: Stats): string {
  const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : "NaN");
  return [
    `--- ${name} ---`,
    `count            = ${s.count}`,
    `success_count    = ${s.success_count}`,
    `failure_count    = ${s.failure_count}`,
    `mean (ms)        = ${fmt(s.mean)}`,
    `p50  (ms)        = ${fmt(s.p50)}`,
    `p95  (ms)        = ${fmt(s.p95)}`,
    `p99  (ms)        = ${fmt(s.p99)}`,
    `std  (ms)        = ${fmt(s.std)}`,
    `min  (ms)        = ${fmt(s.min)}`,
    `max  (ms)        = ${fmt(s.max)}`,
  ].join("\n");
}
