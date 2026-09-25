/**
 * Pull contracts/deployments/<net>.json from the server and write it (UTF-8) to both local copies.
 *   node ops/pull-deployments.mjs [arc-mainnet|arc-testnet]   (default arc-mainnet)
 *
 * If <net>-stock.json exists on the server (output of ops/deploy-stock.sh) it is merged into the main file under
 * `stock` — the single file the indexer / web read. `node ops/deploy.mjs` then pushes the merged file back.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const net = process.argv[2] ?? "arc-mainnet";
const remote = (f) => execFileSync("node", [resolve(ROOT, "ops/ssh.mjs"), `cat /opt/arm/contracts/deployments/${f} 2>/dev/null || true`], { encoding: "utf8" });
const main = JSON.parse(remote(`${net}.json`));
const stockRaw = remote(`${net}-stock.json`).trim();
if (stockRaw) {
  const stock = JSON.parse(stockRaw);
  // keep only what the consumers need; the chain-wide fields (usdc, treasury, uniswap core) are already top-level
  const { chainId: _c, usdc: _u, treasury: _t, ecoFund: _e, ...rest } = stock;
  main.stock = rest;
  console.log(`merged ${net}-stock.json → stock (${Object.keys(stock.quotes ?? {}).join(", ") || "no quotes"})`);
}
const json = JSON.stringify(main, null, 2) + "\n";
for (const p of [`contracts/deployments/${net}.json`, `web/src/lib/deployments.${net}.json`]) writeFileSync(resolve(ROOT, p), json);
console.log(json);
