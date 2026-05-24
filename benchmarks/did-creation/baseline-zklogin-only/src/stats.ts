/** Stats helpers (same conventions as the OIDC-only and private-key DID baselines). */

export interface Stats {
  count: number; success_count: number; failure_count: number;
  mean: number; p50: number; p95: number; p99: number; std: number; min: number; max: number;
}

function percentile(s: number[], p: number): number {
  if (s.length === 0) return Number.NaN;
  if (s.length === 1) return s[0];
  const r = (p / 100) * (s.length - 1);
  const lo = Math.floor(r), hi = Math.ceil(r);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (r - lo);
}

export function computeStats(successes: number[], failureCount: number): Stats {
  const n = successes.length;
  if (n === 0) {
    return { count: failureCount, success_count: 0, failure_count: failureCount,
             mean: NaN, p50: NaN, p95: NaN, p99: NaN, std: NaN, min: NaN, max: NaN };
  }
  const s = [...successes].sort((a, b) => a - b);
  const mean = s.reduce((a, v) => a + v, 0) / s.length;
  const variance = s.reduce((a, v) => a + (v - mean) ** 2, 0) / Math.max(s.length - 1, 1);
  return {
    count: n + failureCount, success_count: n, failure_count: failureCount,
    mean, std: Math.sqrt(variance),
    p50: percentile(s, 50), p95: percentile(s, 95), p99: percentile(s, 99),
    min: s[0], max: s[s.length - 1],
  };
}

export function formatStats(name: string, s: Stats): string {
  const f = (n: number) => Number.isFinite(n) ? n.toFixed(3) : "NaN";
  return [`--- ${name} ---`,
    `count            = ${s.count}`,
    `success_count    = ${s.success_count}`,
    `failure_count    = ${s.failure_count}`,
    `mean (ms)        = ${f(s.mean)}`,
    `p50  (ms)        = ${f(s.p50)}`,
    `p95  (ms)        = ${f(s.p95)}`,
    `p99  (ms)        = ${f(s.p99)}`,
    `std  (ms)        = ${f(s.std)}`,
    `min  (ms)        = ${f(s.min)}`,
    `max  (ms)        = ${f(s.max)}`].join("\n");
}
