// node build.mjs → dist/ArmAI.exe (single file, Bun runtime inside). Checks the language files first.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const root = import.meta.dirname;
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
execFileSync(process.execPath, [join(root, "i18n/check.mjs")], { stdio: "inherit" });
mkdirSync(join(root, "dist"), { recursive: true });
const out = join(root, "dist", "ArmAI.exe");
const bun = join(root, "node_modules", "bun", "bin", process.platform === "win32" ? "bun.exe" : "bun");
execFileSync(bun, [
  "build", join(root, "src/main.mjs"), "--compile", "--minify", "--target=bun-windows-x64", `--outfile=${out}`,
  "--windows-title=Arm AI", "--windows-publisher=Arm", `--windows-version=${version}.0`, "--windows-description=Arm AI: your own x402 wallet for AI models in Cursor",
], { stdio: "inherit", cwd: root });
console.log(`${out}  ${(statSync(out).size / 1048576).toFixed(1)} MB`);
