import { loadConfig } from "./config.js";
import { AuthCodeProvider } from "./auth/authCodeProvider.js";

/**
 * Standalone interactive login: run the Simpro authorization_code browser flow
 * and cache the refresh token, WITHOUT starting the MCP server. Lets a user
 * pre-seed (or refresh) their session, e.g. `npm run login`.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error("Set SIMPRO_CLIENT_ID and SIMPRO_CLIENT_SECRET before logging in.");
  }
  const provider = new AuthCodeProvider(cfg);
  console.error("Starting Simpro authorization_code login…");
  await provider.ensureInteractiveAuth();
  console.error(`Done. Session cached to ${cfg.tokenCacheFile}.`);
}

main().catch((err) => {
  console.error(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
