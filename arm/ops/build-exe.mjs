/**
 * Build Windows single-executable tools from ops/*.mjs with Node's SEA support.
 *   cd ops && node build-exe.mjs            # all targets
 *   cd ops && node build-exe.mjs bridge     # one target
 * Targets:
 *   domains -> dist/arm-domains.exe   (ops/domains-cli.mjs, SSH domain manager)
 *   bridge  -> dist/memeradar-bridge.exe    (ops/bridge-serve.mjs + bridge.html asset, USDC Base -> Arc)
 * Steps: esbuild bundle (CJS) → SEA blob (+assets) → copy node.exe → inject blob with postject.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const ROOT = resolve(import.meta.dirname);
const TMP = join(ROOT, ".tmp");
const DIST = join(ROOT, "dist");
mkdirSync(TMP, { recursive: true });
mkdirSync(DIST, { recursive: true });

const TARGETS = {
  domains: { entry: "domains-cli.mjs", exe: "arm-domains.exe", external: ["cpu-features", "./crypto/build/Release/sshcrypto.node"] },
  bridge: { entry: "bridge-serve.mjs", exe: "memeradar-bridge.exe", assets: { "bridge.html": join(ROOT, "bridge.html") } },
};
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(TARGETS);

for (const name of wanted) {
  const t = TARGETS[name];
  if (!t) throw new Error(`unknown target ${name}; use ${Object.keys(TARGETS).join(" | ")}`);
  const bundle = join(TMP, `${name}.cjs`);
  await build({ entryPoints: [join(ROOT, t.entry)], bundle: true, platform: "node", target: "node22", format: "cjs", outfile: bundle, external: t.external ?? [], logLevel: "warning" });

  const seaCfg = join(TMP, `sea-${name}.json`);
  const blob = join(TMP, `sea-${name}.blob`);
  writeFileSync(seaCfg, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, ...(t.assets ? { assets: t.assets } : {}) }));
  execFileSync(process.execPath, ["--experimental-sea-config", seaCfg], { stdio: "inherit" });

  const exe = join(DIST, t.exe);
  copyFileSync(process.execPath, exe);
  execFileSync("npx", ["--yes", "postject", exe, "NODE_SEA_BLOB", blob, "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"], { stdio: "inherit", shell: true });
  console.log(`built ${exe} (${(statSync(exe).size / 1024 / 1024).toFixed(0)} MB)`);
}
