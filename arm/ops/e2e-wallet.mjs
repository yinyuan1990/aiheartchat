/** Create (once) the local E2E test wallet and print its address. Key stays in ops/.tmp (gitignored). */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const file = resolve(import.meta.dirname, ".tmp/e2e-wallet.json");
mkdirSync(resolve(import.meta.dirname, ".tmp"), { recursive: true });
if (!existsSync(file)) {
  const pk = generatePrivateKey();
  writeFileSync(file, JSON.stringify({ privateKey: pk, address: privateKeyToAccount(pk).address }, null, 2));
}
const w = JSON.parse(readFileSync(file, "utf8"));
console.log(w.address);
