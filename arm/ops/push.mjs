/**
 * Sync a local directory to the server (tar over SFTP), optionally run a command after.
 *   node ops/push.mjs <localDir> <remoteDir> [--exclude a,b,c] [--run "<cmd>"]
 * Example:
 *   node ops/push.mjs contracts /opt/arm/contracts --exclude out,cache --run "cd /opt/arm/contracts && forge test"
 */
import { Client } from "ssh2";
import { execSync } from "node:child_process";
import { createReadStream, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : null;
};
const excludes = (flag("--exclude") ?? "").split(",").filter(Boolean);
const run = flag("--run");
const [localDir, remoteDir] = args;
if (!localDir || !remoteDir) {
  console.error("usage: node ops/push.mjs <localDir> <remoteDir> [--exclude a,b] [--run cmd]");
  process.exit(2);
}

const ROOT = resolve(import.meta.dirname, "..");
const local = resolve(ROOT, localDir);
const TMP = join(ROOT, "ops", ".tmp");
mkdirSync(TMP, { recursive: true });
const tgz = join(TMP, `${basename(local)}.tgz`);
const ex = ["node_modules", ".git", ...excludes].map((e) => `--exclude=${e}`).join(" ");
execSync(`tar -czf "${tgz}" ${ex} -C "${local}" .`, { stdio: "inherit" });
console.log(`packed ${basename(local)}: ${(statSync(tgz).size / 1024).toFixed(0)} KB`);

const host = process.env.SRV_HOST ?? "45.205.17.161";
const username = process.env.SRV_USER ?? "root";
const privateKey = readFileSync(join(homedir(), ".ssh", "arm_ed25519"));

const conn = new Client();
const exec = (cmd) =>
  new Promise((res, rej) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return rej(err);
      stream.on("data", (d) => process.stdout.write(d));
      stream.stderr.on("data", (d) => process.stderr.write(d));
      stream.on("close", (code) => (code === 0 ? res() : rej(new Error(`exit ${code}`))));
    });
  });

conn.on("ready", async () => {
  try {
    const remoteTgz = `${remoteDir}.tgz`;
    await exec(`mkdir -p "${remoteDir}"`);
    await new Promise((res, rej) =>
      conn.sftp((e, s) => {
        if (e) return rej(e);
        const ws = s.createWriteStream(remoteTgz);
        ws.on("close", res).on("error", rej);
        createReadStream(tgz).pipe(ws);
      }),
    );
    // Only wipe tracked-source subtrees; keep remote-only dirs (out/, cache/, lib/) intact.
    await exec(`cd "${remoteDir}" && tar -xzf "${remoteTgz}" && rm -f "${remoteTgz}" && echo synced`);
    if (run) await exec(`export PATH=$HOME/.foundry/bin:$PATH; ${run}`);
  } catch (e) {
    console.error("PUSH_FAILED:", e.message);
    process.exitCode = 1;
  } finally {
    conn.end();
  }
}).on("error", (e) => {
  console.error("ssh error:", e.message);
  process.exit(1);
});
conn.connect({ host, username, privateKey, readyTimeout: 30000 });
