import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

// Frontend dependencies are already bundled into dist/client by Vite.
const runtimeDependencies = [
  "@fastify/rate-limit",
  "@fastify/static",
  "better-sqlite3",
  "diff",
  "dotenv",
  "fastify",
  "ipaddr.js",
  "playwright",
  "zod",
  "tldts",
];
const manifestPath = resolve("package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.dependencies = Object.fromEntries(
  runtimeDependencies.map((name) => {
    const version = manifest.dependencies[name];
    if (!version) throw new Error(`Missing runtime dependency: ${name}`);
    return [name, version];
  }),
);
delete manifest.devDependencies;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const require = createRequire(manifestPath);
const sqliteDirectory = dirname(require.resolve("better-sqlite3/package.json"));
const { getPrebuildPath } = require(join(sqliteDirectory, "lib/binding.js"));
const nativeBinding = getPrebuildPath();

// Retain the package-selected binary; compiled fallbacks stay intact if needed.
if (nativeBinding && existsSync(nativeBinding)) {
  for (const entry of readdirSync(join(sqliteDirectory, "prebuilds"))) {
    const candidate = join(sqliteDirectory, "prebuilds", entry);
    if (candidate !== nativeBinding) rmSync(candidate, { recursive: true });
  }
  rmSync(join(sqliteDirectory, "build"), { recursive: true, force: true });
}
for (const directory of ["deps", "src"]) {
  rmSync(join(sqliteDirectory, directory), { recursive: true, force: true });
}
