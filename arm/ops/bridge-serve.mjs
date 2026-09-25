// Local host for ops/bridge.html (USDC Base -> Arc via CCTP): serves the page and proxies
// Circle's Iris API + the two public RPCs so the browser never hits CORS.
//   node ops/bridge-serve.mjs            (or double-click dist/memeradar-bridge.exe)
// Then open http://127.0.0.1:8788 — it is opened automatically.
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { exec } from "node:child_process";
import { createRequire } from "node:module";

if (process.platform === "win32") { try { exec("chcp 65001"); } catch {} }

const PORT = Number(process.env.PORT || 8788);
const UPSTREAM = {
  "/iris": "https://iris-api.circle.com",
  "/rpc/base": process.env.BASE_RPC_URL || "https://mainnet.base.org",
  "/rpc/arc": process.env.ARC_RPC_URL || "https://rpc.arc-scan.org",
};

function loadHtml() {
  // inside the SEA build the bundle is CJS and `require` is the embedder's; as plain ESM fall back to createRequire
  try {
    const req = typeof require === "function" ? require : createRequire(import.meta.url);
    const sea = req("node:sea");
    if (sea.isSea()) return sea.getAsset("bridge.html", "utf8");
  } catch (e) { if (process.env.DEBUG) console.error("sea asset:", e.message); }
  const candidates = [typeof import.meta.dirname === "string" ? join(import.meta.dirname, "bridge.html") : null, join(process.cwd(), "bridge.html"), join(process.cwd(), "ops", "bridge.html")].filter(Boolean);
  const f = candidates.find((p) => existsSync(p));
  if (!f) throw new Error("bridge.html not found next to the script");
  return readFileSync(f, "utf8");
}
const html = loadHtml();

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "GET" && url.pathname === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(html); }
  const prefix = Object.keys(UPSTREAM).find((p) => url.pathname === p || url.pathname.startsWith(p + "/"));
  if (!prefix) { res.writeHead(404); return res.end(); }
  const target = UPSTREAM[prefix] + (prefix === "/iris" ? url.pathname.slice(prefix.length) + url.search : "");
  const chunks = []; for await (const c of req) chunks.push(c);
  try {
    const up = await fetch(target, { method: req.method, headers: { "content-type": "application/json" }, body: chunks.length ? Buffer.concat(chunks) : undefined });
    res.writeHead(up.status, { "content-type": up.headers.get("content-type") || "application/json" });
    res.end(Buffer.from(await up.arrayBuffer()));
  } catch (e) { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: String(e.message || e) })); }
});

server.listen(PORT, "127.0.0.1", () => {
  const u = `http://127.0.0.1:${PORT}`;
  console.log(`USDC bridge (Base -> Arc) at ${u}\nkeep this window open while bridging; Ctrl+C to quit`);
  const opener = process.platform === "win32" ? `start "" "${u}"` : process.platform === "darwin" ? `open "${u}"` : `xdg-open "${u}"`;
  exec(opener);
});
