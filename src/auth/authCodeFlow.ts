import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { URL } from "node:url";
import type { Config } from "../config.js";
import { fetchSimproToken, type SimproTokenResponse } from "./simproToken.js";

function log(line: string): void {
  console.error(`  oauth ${line}`);
}

const CALLBACK_PATH = "/callback";

export function redirectUri(cfg: Config): string {
  return `http://localhost:${cfg.authRedirectPort}${CALLBACK_PATH}`;
}

function buildAuthorizeUrl(cfg: Config, state: string): URL {
  const u = new URL(cfg.authUrl);
  u.searchParams.set("client_id", cfg.clientId!);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", redirectUri(cfg));
  u.searchParams.set("state", state);
  return u;
}

// On failure the URL is printed to stderr so a headless/SSH user can paste it.
function openBrowser(url: string): void {
  const cmd =
    process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => log(`could not launch a browser; open this URL manually:\n  ${url}`));
    child.unref();
  } catch {
    log(`could not launch a browser; open this URL manually:\n  ${url}`);
  }
}

const SUCCESS_HTML =
  "<!doctype html><meta charset=utf-8><title>Simpro authorised</title>" +
  "<body style=\"font-family:system-ui;margin:4rem;text-align:center\">" +
  "<h1>✓ Authorised</h1><p>Simpro access granted. You can close this tab and return to your terminal.</p>";

const ERROR_HTML = (msg: string) =>
  "<!doctype html><meta charset=utf-8><title>Authorisation failed</title>" +
  "<body style=\"font-family:system-ui;margin:4rem;text-align:center\">" +
  `<h1>Authorisation failed</h1><p>${msg}</p><p>Return to your terminal for details.</p>`;

const FLOW_TIMEOUT_MS = 5 * 60 * 1000;

export function runLocalhostAuthFlow(cfg: Config): Promise<SimproTokenResponse> {
  if (!cfg.clientId || !cfg.clientSecret) {
    return Promise.reject(
      new Error("authorization_code auth needs SIMPRO_CLIENT_ID and SIMPRO_CLIENT_SECRET."),
    );
  }
  const state = randomBytes(16).toString("base64url");

  return new Promise<SimproTokenResponse>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      fn();
    };

    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${cfg.authRedirectPort}`);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }
      const { code, state: returnedState, error, error_description } = Object.fromEntries(url.searchParams);
      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" }).end(ERROR_HTML(error));
        finish(() => reject(new Error(`Simpro denied authorisation: ${error}${error_description ? ` — ${error_description}` : ""}`)));
        return;
      }
      // Simpro doesn't echo state (returns it empty), so reject only a non-empty
      // mismatch. CAVEAT: when state comes back empty this leaves no CSRF check on
      // the callback — a local process that reaches http://localhost:<port>/callback
      // with its own code during the ~5-min window could inject it. Accepted as
      // low-risk: the listener binds 127.0.0.1 only, is single-shot and time-boxed,
      // the port must be known, and the code is bound to our redirect_uri at exchange.
      // Simpro echoing state is the only thing that would let us close it fully.
      if (returnedState && returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html" }).end(ERROR_HTML("state mismatch"));
        finish(() => reject(new Error("Authorisation callback state mismatch (possible CSRF); aborting.")));
        return;
      }
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" }).end(ERROR_HTML("no authorization code"));
        finish(() => reject(new Error("Authorisation callback carried no code.")));
        return;
      }
      try {
        const tokens = await fetchSimproToken(cfg.tokenUrl, cfg.clientId!, cfg.clientSecret!, {
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri(cfg),
        });
        res.writeHead(200, { "Content-Type": "text/html" }).end(SUCCESS_HTML);
        finish(() => resolve(tokens));
      } catch (e) {
        res.writeHead(502, { "Content-Type": "text/html" }).end(ERROR_HTML("token exchange failed"));
        finish(() => reject(e as Error));
      }
    });

    const timer = setTimeout(
      () => finish(() => reject(new Error(`Timed out after ${FLOW_TIMEOUT_MS / 1000}s waiting for Simpro authorisation.`))),
      FLOW_TIMEOUT_MS,
    );
    timer.unref();

    server.on("error", (e) =>
      finish(() => reject(new Error(`Could not bind the localhost callback on port ${cfg.authRedirectPort}: ${(e as Error).message}`))),
    );

    server.listen(cfg.authRedirectPort, "127.0.0.1", () => {
      const authorizeUrl = buildAuthorizeUrl(cfg, state).toString();
      log(`waiting for Simpro authorisation on ${redirectUri(cfg)}`);
      log(`opening browser to:\n  ${authorizeUrl}`);
      openBrowser(authorizeUrl);
    });
  });
}
