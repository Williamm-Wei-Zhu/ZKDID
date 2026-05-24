/** Stats helpers — same conventions as the OIDC-only baseline (n-1 std, linear-interp percentiles). */

export interface Stats {
  count: number; success_count: number; failure_count: number;
  mean: number; p50: number; p95: number; p99: number; std: number; min: number; max: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank), hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

export function computeStats(successes: number[], failureCount: number): Stats {
  const n = successes.length;
  const total = n + failureCount;
  if (n === 0) {
    return { count: total, success_count: 0, failure_count: failureCount,
             mean: NaN, p50: NaN, p95: NaN, p99: NaN, std: NaN, min: NaN, max: NaN };
  }
  const s = [...successes].sort((a, b) => a - b);
  const mean = s.reduce((a, v) => a + v, 0) / s.length;
  const variance = s.reduce((a, v) => a + (v - mean) ** 2, 0) / Math.max(s.length - 1, 1);
  return {
    count: total, success_count: n, failure_count: failureCount,
    mean, std: Math.sqrt(variance),
    p50: percentile(s, 50), p95: percentile(s, 95), p99: percentile(s, 99),
    min: s[0], max: s[s.length - 1],
  };
}

export function formatStats(name: string, s: Stats): string {
  const f = (n: number) => Number.isFinite(n) ? n.toFixed(3) : "NaN";
  return [
    `--- ${name} ---`,
    `count            = ${s.count}`,
    `success_count    = ${s.success_count}`,
    `failure_count    = ${s.failure_count}`,
    `mean (ms)        = ${f(s.mean)}`,
    `p50  (ms)        = ${f(s.p50)}`,
    `p95  (ms)        = ${f(s.p95)}`,
    `p99  (ms)        = ${f(s.p99)}`,
    `std  (ms)        = ${f(s.std)}`,
    `min  (ms)        = ${f(s.min)}`,
    `max  (ms)        = ${f(s.max)}`,
  ].join("\n");
}
