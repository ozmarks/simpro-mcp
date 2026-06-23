// One deliberate version bump. Bumps package.json, syncs mcpb/manifest.json and
// version.json to match, then commits all three and creates the matching `v<version>` tag.
//
//   npm run release <patch|minor|major|x.y.z>            # local: bump + commit + tag
//   npm run release <patch|minor|major|x.y.z> --files-only  # CI: bump the files only
//
// --files-only edits the three files and prints the new version to stdout, leaving the
// commit/branch/PR to the caller (the bump-version workflow). The release pipeline
// (release-mcpb.yml) re-verifies the three files agree with the tag before building, so
// re-running a failed CI build never changes the version.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: repoRoot, stdio: ["ignore", "pipe", "inherit"] }).toString().trim();
const log = (m) => console.error(`[release] ${m}`);

const args = process.argv.slice(2);
const filesOnly = args.includes("--files-only");
const arg = args.find((a) => !a.startsWith("--"));
if (!arg) {
  console.error("usage: npm run release <patch|minor|major|x.y.z> [--files-only]");
  process.exit(1);
}

if (!filesOnly && git("status", "--porcelain")) {
  console.error("[release] working tree is dirty — commit or stash first.");
  process.exit(1);
}

const pkgPath = join(repoRoot, "package.json");
const manifestPath = join(repoRoot, "mcpb", "manifest.json");
const versionJsonPath = join(repoRoot, "version.json");

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const current = readJson(pkgPath).version;

const nextVersion = (() => {
  if (/^\d+\.\d+\.\d+$/.test(arg)) return arg;
  const [maj, min, pat] = current.split(".").map(Number);
  if (arg === "major") return `${maj + 1}.0.0`;
  if (arg === "minor") return `${maj}.${min + 1}.0`;
  if (arg === "patch") return `${maj}.${min}.${pat + 1}`;
  console.error(`[release] unknown bump "${arg}" — use patch | minor | major | x.y.z`);
  process.exit(1);
})();

if (nextVersion === current) {
  console.error(`[release] version is already ${current}.`);
  process.exit(1);
}

const tag = `v${nextVersion}`;
const existingTags = git("tag", "--list", tag);
if (existingTags) {
  console.error(`[release] tag ${tag} already exists.`);
  process.exit(1);
}

// Patch the `version` field in place, preserving the rest of each file byte-for-byte
// where possible (write the parsed object back with a trailing newline).
const setVersion = (p) => {
  const obj = readJson(p);
  obj.version = nextVersion;
  writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
};
setVersion(pkgPath);
setVersion(manifestPath);
setVersion(versionJsonPath);
log(`${current} → ${nextVersion} (package.json, mcpb/manifest.json, version.json)`);

if (filesOnly) {
  process.stdout.write(nextVersion + "\n");
  process.exit(0);
}

git("add", "package.json", "mcpb/manifest.json", "version.json");
execFileSync("git", ["commit", "-m", `Release ${tag}`], { cwd: repoRoot, stdio: "inherit" });
execFileSync("git", ["tag", tag], { cwd: repoRoot, stdio: "inherit" });
log(`committed and tagged ${tag}`);
log(`push it:  git push --follow-tags`);
