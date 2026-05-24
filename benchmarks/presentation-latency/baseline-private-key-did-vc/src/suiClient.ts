/**
 * Singleton Sui devnet client. We initialize from the SUI_RPC_URL env var
 * so the experiment can target a self-hosted RPC if needed.
 */

import { SuiClient } from "@mysten/sui/client";
import { cfg } from "./config.js";

let _client: SuiClient | null = null;
export function suiClient(): SuiClient {
  if (!_client) _client = new SuiClient({ url: cfg.rpcUrl });
  return _client;
}
