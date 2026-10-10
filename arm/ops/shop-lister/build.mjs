// Build dist/arm-shop-lister.exe: esbuild → one CJS file → Node single executable application (SEA) via postject.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
const esbuild = join(here, "../../indexer/node_modules/.bin/esbuild.cmd");
mkdirSync(dist, { recursive: true });
const sh = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit", cwd: here, shell: cmd.endsWith(".cmd") });

sh(esbuild, ["lister.ts", "--bundle", "--platform=node", "--format=cjs", "--target=node22", `--outfile=${join(dist, "lister.cjs")}`]);
writeFileSync(join(dist, "sea-config.json"), JSON.stringify({ main: "lister.cjs", output: "sea-prep.blob", disableExperimentalSEAWarning: true }));
execFileSync(process.execPath, ["--experimental-sea-config", "sea-config.json"], { stdio: "inherit", cwd: dist });
const exe = join(dist, "arm-shop-lister.exe");
copyFileSync(process.execPath, exe);
sh("npx.cmd", ["--yes", "postject", exe, "NODE_SEA_BLOB", join(dist, "sea-prep.blob"), "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"]);
console.log("built", exe);
