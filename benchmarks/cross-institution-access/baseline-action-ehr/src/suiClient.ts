/**
 * Lazy Sui client singleton, parameterized by the rpcUrl in cfg.
 *
 * Kept separate from config.ts so unit tests can import config without
 * pulling the @mysten/sui networking layer.
 */

import { SuiClient } from "@mysten/sui/client";
import { cfg } from "./config.js";

let _client: SuiClient | null = null;

export function suiClient(): SuiClient {
  if (!_client) {
    _client = new SuiClient({ url: cfg.rpcUrl });
  }
  return _client;
}
