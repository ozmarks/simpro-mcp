// Build the distributable .mcpb bundle (mcpb/server/ is generated) → simpro-mcp-server.mcpb at the repo root.
import { execFileSync } from "node:child_process";
import { cpSync, rmSync, mkdirSync, copyFileSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
const npm = isWin ? "npm.cmd" : "npm";
const npx = isWin ? "npx.cmd" : "npx";

// Windows npm/npx are .cmd shims execFileSync can't spawn without shell:true (EINVAL); harmless on POSIX.
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: "inherit", cwd: repoRoot, shell: isWin, ...opts });

const log = (m) => console.log(`[build-mcpb] ${m}`);

// package.json and manifest.json versions must agree so the Release asset matches what the manifest reports.
const pkgVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
const manifestPath = join(repoRoot, "mcpb", "manifest.json");
const manifestVersion = JSON.parse(readFileSync(manifestPath, "utf8")).version;
if (pkgVersion !== manifestVersion) {
  throw new Error(
    `Version mismatch: package.json is ${pkgVersion} but mcpb/manifest.json is ${manifestVersion}. ` +
      `Bump both to the same value before building.`,
  );
}

log("building dist/ (tsc + copy-data)…");
run(npm, ["run", "build"]);

const serverDir = join(repoRoot, "mcpb", "server");
log("resetting mcpb/server/…");
rmSync(serverDir, { recursive: true, force: true });
mkdirSync(serverDir, { recursive: true });

log("copying dist/ -> mcpb/server/ (no sourcemaps)…");
cpSync(join(repoRoot, "dist"), serverDir, {
  recursive: true,
  filter: (src) => !src.endsWith(".js.map"),
});

copyFileSync(join(repoRoot, "package.json"), join(serverDir, "package.json"));
copyFileSync(join(repoRoot, "package-lock.json"), join(serverDir, "package-lock.json"));

// --ignore-scripts: the bundle has no src/, so a prepare/build hook has nothing to do.
log("installing production deps into mcpb/server/…");
run(npm, ["ci", "--omit=dev", "--ignore-scripts"], { cwd: serverDir });
rmSync(join(serverDir, "package-lock.json"), { force: true });

log("validating manifest…");
run(npx, ["-y", "@anthropic-ai/mcpb", "validate", "manifest.json"], { cwd: join(repoRoot, "mcpb") });

const outFile = join(repoRoot, "simpro-mcp-server.mcpb");
log("packing…");
run(npx, ["-y", "@anthropic-ai/mcpb", "pack", ".", outFile], { cwd: join(repoRoot, "mcpb") });

const { size } = statSync(outFile);
log(`done -> simpro-mcp-server.mcpb (${(size / 1e6).toFixed(1)} MB)`);
