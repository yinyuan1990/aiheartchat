/**
 * Non-interactive remote exec for the deploy server.
 * Usage:  node ops/ssh.mjs "<command>"
 * Auth:   SSH key at ~/.ssh/arm_ed25519 if present, otherwise SRV_PW env var (bootstrap only).
 * Host:   SRV_HOST (default 45.205.17.161), SRV_USER (default root), SRV_PORT (default 22)
 */
import { Client } from "ssh2";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const host = process.env.SRV_HOST ?? "45.205.17.161";
const username = process.env.SRV_USER ?? "root";
const port = Number(process.env.SRV_PORT ?? 22);
// `--script path.sh` uploads a local script via stdin and runs it with bash.
let cmd = process.argv.slice(2).join(" ");
let stdinPayload = null;
if (process.argv[2] === "--script") {
  stdinPayload = readFileSync(process.argv[3], "utf8").replace(/\r\n/g, "\n");
  cmd = "bash -s";
}
if (!cmd) {
  console.error('usage: node ops/ssh.mjs "<command>" | node ops/ssh.mjs --script file.sh');
  process.exit(2);
}

const keyPath = join(homedir(), ".ssh", "arm_ed25519");
const auth = existsSync(keyPath) ? { privateKey: readFileSync(keyPath) } : { password: process.env.SRV_PW };
if (!auth.privateKey && !auth.password) {
  console.error("no auth: create ~/.ssh/arm_ed25519 or set SRV_PW");
  process.exit(2);
}

const conn = new Client();
conn
  .on("ready", () => {
    conn.exec(cmd, { pty: false }, (err, stream) => {
      if (err) throw err;
      if (stdinPayload !== null) stream.end(stdinPayload);
      stream.on("data", (d) => process.stdout.write(d));
      stream.stderr.on("data", (d) => process.stderr.write(d));
      stream.on("close", (code) => {
        conn.end();
        process.exit(code ?? 0);
      });
    });
  })
  .on("error", (e) => {
    console.error("ssh error:", e.message);
    process.exit(1);
  })
  .connect({ host, port, username, readyTimeout: 30000, ...auth });
