/**
 * One-shot OIDC callback server.
 *
 * Each measurement run spins up a tiny Express server, waits for a single
 * authorization-code redirect, validates `state`, then shuts down. We use
 * Express because the spec asks for it; the listener is per-run to avoid
 * cross-run state contamination.
 */

import express from "express";
import type { Server } from "node:http";

export interface CallbackResult {
  code: string;
  state: string;
}

export interface CallbackServerHandle {
  /** Resolves once the OIDC redirect arrives at /callback. */
  awaitCallback(timeoutMs?: number): Promise<CallbackResult>;
  close(): Promise<void>;
}

/**
 * Start a server bound to `port` that captures exactly one /callback request
 * matching `expectedState`. Any request with the wrong state is rejected with 400.
 */
export async function startCallbackServer(
  port: number,
  expectedState: string
): Promise<CallbackServerHandle> {
  const app = express();
  let server: Server | null = null;

  let resolveCb: ((r: CallbackResult) => void) | null = null;
  let rejectCb: ((e: Error) => void) | null = null;

  const callbackPromise = new Promise<CallbackResult>((resolve, reject) => {
    resolveCb = resolve;
    rejectCb = reject;
  });

  // Handle the OAuth redirect on any path so the same server works whether
  // the registered redirect_uri is `http://host:PORT` (root, as zkEHR uses)
  // or `http://host:PORT/callback`.
  const handler = (req: express.Request, res: express.Response): void => {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const error = typeof req.query.error === "string" ? req.query.error : "";
    const errDesc =
      typeof req.query.error_description === "string" ? req.query.error_description : "";

    if (error) {
      res.status(400).send(`<h1>OIDC error</h1><pre>${error}: ${errDesc}</pre>`);
      rejectCb?.(new Error(`OIDC error from provider: ${error} - ${errDesc}`));
      return;
    }
    if (!code || !state) {
      res.status(400).send("Missing code or state");
      rejectCb?.(new Error("Callback missing code or state"));
      return;
    }
    if (state !== expectedState) {
      res.status(400).send("State mismatch");
      rejectCb?.(new Error(`State mismatch: got=${state} expected=${expectedState}`));
      return;
    }

    res
      .status(200)
      .send(
        `<!doctype html><html><body style="font-family:sans-serif">
        <h2>Login complete.</h2>
        <p>You can close this tab; the experiment is continuing.</p>
        </body></html>`
      );
    resolveCb?.({ code, state });
  };
  app.get("/", handler);
  app.get("/callback", handler);

  await new Promise<void>((resolve, reject) => {
    server = app.listen(port, () => resolve());
    server.once("error", reject);
  });

  return {
    awaitCallback: (timeoutMs = 120_000) =>
      Promise.race<CallbackResult>([
        callbackPromise,
        new Promise<CallbackResult>((_resolve, reject) =>
          setTimeout(
            () => reject(new Error(`Callback timeout after ${timeoutMs}ms`)),
            timeoutMs
          )
        ),
      ]),
    close: async () => {
      if (!server) return;
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    },
  };
}
