import "./polyfills";   // must be first — polyfills Buffer/global/process for circomlibjs
import ReactDOM from "react-dom/client";

import { App } from "./App";
import { cacheProverModeFromUrl } from "./lib/auth";
import { warmupPoseidon } from "./lib/localPoseidon";

// Capture `?prover=direct|proxy|backend` into sessionStorage at boot, BEFORE
// the user clicks Google.  The OAuth implicit flow strips query params on
// redirect (only the `#id_token` fragment survives), so caching this inside
// `pickProverUrl()` — which runs only after the redirect — would always see
// an empty `window.location.search`.
cacheProverModeFromUrl();

// Kick off the ~250 ms `buildPoseidon()` initialization right now, in
// parallel with React's boot.  By the time `completeZkLogin()` fires after
// the OAuth redirect (typically ~150 ms after page mount), Poseidon is
// already partially or fully ready, so the salt-derivation phase no longer
// pays the full cold-start tax.
warmupPoseidon();

ReactDOM
    .createRoot( document.getElementById("app") as Element )
    .render(<App />);
