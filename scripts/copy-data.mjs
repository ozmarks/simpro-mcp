import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = join(here, "..");
const src = join(serverRoot, "data");
const outDir = process.argv[2] ?? "dist";
const dest = join(serverRoot, outDir, "data");

if (!existsSync(src)) {
  console.error(`[copy-data] source not found: ${src}`);
  process.exit(1);
}
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.error(`[copy-data] copied ${src} -> ${dest}`);
