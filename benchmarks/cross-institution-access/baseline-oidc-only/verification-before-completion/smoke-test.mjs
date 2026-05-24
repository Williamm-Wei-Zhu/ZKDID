// Provider-independent smoke test of timing, PKCE, claims, stats, CSV.
import { generateNonce, generatePkce, generateState, buildAuthorizationUrl } from "../dist/oidcClient.js";
import { computeStats, formatStats } from "../dist/stats.js";
import { writeCsv } from "../dist/csv.js";
import { now, elapsedMs } from "../dist/timer.js";
import { validateClaims } from "../dist/jwtVerifier.js";

const results = { passed: [], failed: [] };
function check(name, ok, detail) {
  (ok ? results.passed : results.failed).push({ name, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
}

// timer
const t0 = now();
await new Promise((r) => setTimeout(r, 25));
const ms = elapsedMs(t0);
check("timer.elapsedMs in [20,200] for ~25ms sleep", ms >= 20 && ms <= 200, `observed=${ms.toFixed(2)}ms`);

// PKCE
const pkce = generatePkce();
check("pkce.code_verifier length", pkce.code_verifier.length === 43, `len=${pkce.code_verifier.length}`);
check("pkce.code_challenge_method", pkce.code_challenge_method === "S256");

// Auth URL
const state = generateState();
const nonce = generateNonce();
const url = buildAuthorizationUrl({
  authorizationEndpoint: "https://example.test/auth",
  clientId: "cid",
  redirectUri: "http://localhost:8765/callback",
  scope: "openid email profile",
  state, nonce, pkce,
});
const u = new URL(url);
check("authUrl response_type", u.searchParams.get("response_type") === "code");
check("authUrl code_challenge_method", u.searchParams.get("code_challenge_method") === "S256");
check("authUrl state present", u.searchParams.get("state") === state);
check("authUrl nonce present", u.searchParams.get("nonce") === nonce);

// Claims
const goodClaims = {
  iss: "https://issuer.test",
  sub: "user-1",
  aud: "client-1",
  exp: Math.floor(Date.now() / 1000) + 3600,
  iat: Math.floor(Date.now() / 1000),
  nonce: "n123",
};
try {
  const v = validateClaims(goodClaims, {
    expectedIssuer: "https://issuer.test",
    expectedAudience: "client-1",
    expectedNonce: "n123",
  });
  check("validateClaims accepts good claims", v.sub === "user-1");
} catch (e) {
  check("validateClaims accepts good claims", false, e.message);
}

const badCases = [
  { mut: { iss: "https://wrong" }, label: "rejects bad iss" },
  { mut: { aud: "wrong-aud" }, label: "rejects bad aud" },
  { mut: { exp: Math.floor(Date.now() / 1000) - 10 }, label: "rejects expired token" },
  { mut: { nonce: "wrong" }, label: "rejects nonce mismatch" },
  { mut: { sub: "" }, label: "rejects empty sub" },
];
for (const bc of badCases) {
  try {
    validateClaims({ ...goodClaims, ...bc.mut }, {
      expectedIssuer: "https://issuer.test",
      expectedAudience: "client-1",
      expectedNonce: "n123",
    });
    check(bc.label, false, "did not throw");
  } catch {
    check(bc.label, true);
  }
}

// Stats
const s = computeStats([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 2);
check("stats.count = successes + failures", s.count === 12);
check("stats.success_count = 10", s.success_count === 10);
check("stats.failure_count = 2", s.failure_count === 2);
check("stats.mean = 5.5", Math.abs(s.mean - 5.5) < 1e-9);
check("stats.p50 = 5.5", Math.abs(s.p50 - 5.5) < 1e-9);
check("stats.p95 = 9.55", Math.abs(s.p95 - 9.55) < 1e-9);

// CSV writer
await writeCsv("verification-before-completion/_smoke.csv", [
  {
    run_id: 1, mode: "full", start_time_iso: new Date().toISOString(),
    oidc_login_ms: 12.345, token_exchange_ms: 45.678,
    jwks_fetch_or_cache_ms: 1.2, jwt_verify_ms: 0.5,
    claim_validation_ms: 0.1, session_create_ms: 0.05,
    total_ms: 60.0, success: true, error_message: "",
  },
  {
    run_id: 2, mode: "full", start_time_iso: new Date().toISOString(),
    oidc_login_ms: 0, token_exchange_ms: 0,
    jwks_fetch_or_cache_ms: 0, jwt_verify_ms: 0,
    claim_validation_ms: 0, session_create_ms: 0,
    total_ms: 13.5, success: false,
    error_message: 'simulated, comma "and" quote failure',
  },
]);
check("csv written", true);

console.log("\n--- summary ---");
console.log(formatStats("dummy_ms", s));
console.log(`\npassed=${results.passed.length} failed=${results.failed.length}`);
if (results.failed.length > 0) {
  console.log("FAILURES:", results.failed);
  process.exit(1);
}
