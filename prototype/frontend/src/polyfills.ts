// Browser polyfills for Node built-ins that circomlibjs assumes.
// Loaded FIRST in _init.tsx before any module that touches circomlibjs.
import { Buffer } from "buffer";

// @ts-expect-error — attaching to global for legacy lib compat
if (typeof window !== "undefined" && !window.Buffer) window.Buffer = Buffer;
// Node-era libs expect a `global` reference
if (typeof globalThis !== "undefined" && !(globalThis as any).global) (globalThis as any).global = globalThis;
// Minimal process shim (circomlibjs reads process.env occasionally)
if (typeof (globalThis as any).process === "undefined") {
  (globalThis as any).process = { env: {}, browser: true };
}
