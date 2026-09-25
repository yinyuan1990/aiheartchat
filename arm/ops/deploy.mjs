/**
 * Deploy the Arm stack to /opt/arm on the HK server.
 *   node ops/deploy.mjs [--services web,indexer] [--nginx] [--no-build]
 * Uploads source for the chosen services + compose file + nginx template + ops/domains.sh, builds on the server,
 * restarts, verifies. --nginx re-renders /etc/nginx/conf.d/arm.conf from the template (domains from .env).
 */
import { Client } from "ssh2";
import { execSync } from "node:child_process";
import { createReadStream, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const TMP = join(ROOT, "ops", ".tmp");
mkdirSync(TMP, { recursive: true });

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args.splice(i, 2)[1] : null; };
// --services none → only upload compose / nginx template / domains.sh / bridge page (use with --nginx)
const services = (flag("--services") ?? "web,indexer").split(",").filter((s) => s && s !== "none");
const withNginx = args.includes("--nginx");
const noBuild = args.includes("--no-build");
// --upload-only: push sources / compose / nginx template and stop (build + start on the server with nohup; this host
// drops SSH sessions that stay silent for ~60s, which a long `docker compose build` easily is)
const uploadOnly = args.includes("--upload-only");
const resetDb = args.includes("--reset-db"); // wipe indexer DB → full re-index from deploy block

const host = process.env.SRV_HOST ?? "45.205.17.161";
const username = process.env.SRV_USER ?? "root";
const privateKey = readFileSync(join(homedir(), ".ssh", "arm_ed25519"));

const SRC = { web: { dir: "web", ex: ["node_modules", ".next", "scripts"] }, indexer: { dir: "indexer", ex: ["node_modules", "dist"] } };

const conn = new Client();
const exec = (cmd) => new Promise((res, rej) => {
  conn.exec(cmd, (err, stream) => {
    if (err) return rej(err);
    stream.on("data", (d) => process.stdout.write(d));
    stream.stderr.on("data", (d) => process.stderr.write(d));
    stream.on("close", (code) => (code === 0 ? res() : rej(new Error(`exit ${code}`))));
  });
});
const sftp = () => new Promise((res, rej) => conn.sftp((e, s) => (e ? rej(e) : res(s))));
const put = (s, local, remote) => new Promise((res, rej) => {
  const ws = s.createWriteStream(remote);
  ws.on("close", res).on("error", rej);
  createReadStream(local).pipe(ws);
});

conn.on("ready", async () => {
  try {
    await exec("mkdir -p /opt/arm/nginx /opt/arm/contracts/deployments");
    const s = await sftp();
    for (const svc of services) {
      const { dir, ex } = SRC[svc];
      const tgz = join(TMP, `${dir}-src.tgz`);
      execSync(`tar -czf "${tgz}" ${[".git", ...ex].map((e) => `--exclude=${e}`).join(" ")} -C "${join(ROOT, dir)}" .`, { stdio: "inherit" });
      await put(s, tgz, `/opt/arm/${dir}-src.tgz`);
      // sync into the live dir but keep node_modules / build output: reinstalling every deploy is slow on this host
      await exec(`cd /opt/arm && rm -rf ${dir}.new && mkdir ${dir}.new && tar -xzf ${dir}-src.tgz -C ${dir}.new && rm ${dir}-src.tgz && mkdir -p ${dir} && rsync -a --delete --exclude node_modules --exclude .next --exclude dist ${dir}.new/ ${dir}/ && rm -rf ${dir}.new`);
      console.log(`uploaded ${dir} (${(statSync(tgz).size / 1024).toFixed(0)} KB)`);
    }
    await put(s, join(ROOT, "ops/deploy/docker-compose.yml"), "/opt/arm/docker-compose.yml");
    // nginx is a TEMPLATE (server_name placeholder); ops/domains.sh renders it from PUBLIC_DOMAINS in .env
    await exec("mkdir -p /opt/arm/ops");
    await put(s, join(ROOT, "ops/deploy/nginx-arm.conf"), "/opt/arm/nginx/arm.conf.tpl");
    await put(s, join(ROOT, "ops/domains.sh"), "/opt/arm/ops/domains.sh");
    await exec("sed -i 's/\\r$//' /opt/arm/ops/domains.sh && chmod +x /opt/arm/ops/domains.sh");
    // native (no-Docker) build / run scripts
    for (const f of ["native-setup.sh", "native-deploy.sh"]) {
      await put(s, join(ROOT, "ops", f), `/opt/arm/ops/${f}`);
      await exec(`sed -i 's/\\r$//' /opt/arm/ops/${f} && chmod +x /opt/arm/ops/${f}`);
    }
    for (const f of ["arc-mainnet.json", "arc-testnet.json"]) {
      const local = join(ROOT, "contracts/deployments", f);
      if (statSync(local, { throwIfNoEntry: false })) await put(s, local, `/opt/arm/contracts/deployments/${f}`);
    }
    // static USDC bridge page, served by nginx at /tools/bridge (see nginx template)
    await exec("mkdir -p /opt/arm/tools");
    await put(s, join(ROOT, "ops/bridge.html"), "/opt/arm/tools/bridge.html");
    if (uploadOnly) { console.log("UPLOAD_OK"); return; }

    const list = services.join(" ");
    await exec(`set -e
cd /opt/arm
set -a; . ./.env; set +a
${noBuild ? "" : `docker compose build ${list} 2>&1 | grep -E 'Built|ERROR|error' || true`}
${resetDb ? `docker compose stop indexer db && docker compose rm -f indexer db && docker volume rm -f arm_pgdata && echo "db reset"` : ""}
docker compose up -d --remove-orphans db ${list}
sleep 3
for i in $(seq 1 40); do
  ok=1
  ${services.includes("web") ? `[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3100/)" = 200 ] || ok=0` : ""}
  ${services.includes("indexer") ? `[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3101/api/health)" = 200 ] || ok=0` : ""}
  [ $ok = 1 ] && break; sleep 2
done
echo "web:     $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3100/)"
echo "indexer: $(curl -s http://127.0.0.1:3101/api/health)"
docker ps --filter name=arm --format '{{.Names}}  {{.Status}}'`);

    if (withNginx) {
      await exec(`set -e
bash /opt/arm/ops/domains.sh render
d=$(grep -E '^PUBLIC_DOMAINS=' /opt/arm/.env | cut -d= -f2- | cut -d, -f1)
echo "public api ($d): $(curl -s --max-time 8 https://$d/api/health || echo unreachable)"`);
    }
    console.log("DEPLOY_OK");
  } catch (e) {
    console.error("DEPLOY_FAILED:", e.message);
    process.exitCode = 1;
  } finally {
    conn.end();
  }
}).on("error", (e) => { console.error("ssh error:", e.message); process.exit(1); });
// keepalive: `docker compose build` can stay silent for minutes and idle connections were getting dropped mid-deploy
conn.connect({ host, username, privateKey, readyTimeout: 30000, keepaliveInterval: 10000, keepaliveCountMax: 6 });
