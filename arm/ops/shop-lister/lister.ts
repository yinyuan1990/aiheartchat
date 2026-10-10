/**
 * 代上架工具 (10.10): a local exe for the operator. Reads a Xianyu listing on this machine (home network: Xianyu
 * throttles our server's datacenter IP), lets you edit it and set price / stock / payment, uploads the pictures to
 * Arm and lists the item into any shop address through POST /api/shop/admin/products (SHOP_ADMIN_TOKEN).
 *
 * Runs a page on 127.0.0.1 and opens the browser. The token lives in %USERPROFILE%\.arm-shop-admin\config.json.
 * Build: node build.mjs → dist/arm-shop-lister.exe
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fetchPicture, ImportError, itemIdOf, listingFrom, readXianyu, type Listing } from "../../indexer/src/shop-import";
import { grabInBrowser, loginState, openLogin } from "./browser";
import { PAGE } from "./page";

const DIR = join(homedir(), ".arm-shop-admin");
const CONFIG = join(DIR, "config.json");
/** how listings are read: browser = the logged-in Chrome of this tool; direct = plain request; auto = direct, browser when throttled */
type Mode = "browser" | "direct" | "auto";
type Config = { token?: string; seller?: string; api?: string; mode?: Mode };
const load = (): Config => {
  try {
    return JSON.parse(readFileSync(CONFIG, "utf8"));
  } catch {
    return {};
  }
};
const save = (c: Config) => {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(CONFIG, JSON.stringify(c, null, 1));
};
const api = () => (load().api ?? "https://arm.yyheart.com").replace(/\/$/, "");

const NONCE = randomBytes(16).toString("hex");
let HOST = "";

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};
const readJson = async (req: IncomingMessage) => {
  let s = "";
  for await (const ch of req) s += ch;
  return (s ? JSON.parse(s) : {}) as Record<string, unknown>;
};

async function upload(buf: Uint8Array, ext: string) {
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(buf)], { type: `image/${ext === "jpg" ? "jpeg" : ext}` }), `pic.${ext}`);
  const r = await fetch(`${api()}/api/upload`, { method: "POST", body: fd, signal: AbortSignal.timeout(60_000) });
  const j = (await r.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!r.ok || !j.url) throw new Error(`upload: ${j.error ?? r.status}`);
  return j.url;
}

async function route(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", `http://${HOST}`);
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(PAGE.replace("__NONCE__", NONCE));
  }
  // other web pages in the same browser must not drive this (the token can list items into any shop)
  if (req.headers.host !== HOST || req.headers["x-nonce"] !== NONCE) return send(res, 403, { error: "forbidden" });

  if (url.pathname === "/api/config") {
    if (req.method === "POST") {
      const b = await readJson(req);
      const c = load();
      if (typeof b.token === "string" && b.token.trim()) c.token = b.token.trim();
      if (typeof b.seller === "string") c.seller = b.seller.trim();
      if (b.mode === "browser" || b.mode === "direct" || b.mode === "auto") c.mode = b.mode;
      save(c);
    }
    const c = load();
    return send(res, 200, { seller: c.seller ?? "", hasToken: !!c.token, api: api(), mode: c.mode ?? "browser" });
  }
  if (url.pathname === "/api/login") {
    if (req.method === "POST") await openLogin();
    return send(res, 200, await loginState());
  }
  if (url.pathname === "/api/shop") {
    const r = await fetch(`${api()}/api/shop/sellers/${encodeURIComponent(url.searchParams.get("addr") ?? "")}?brief=1`);
    return send(res, r.status, await r.json().catch(() => ({ error: `${r.status}` })));
  }
  if (url.pathname === "/api/read" && req.method === "POST") {
    const b = await readJson(req);
    const mode = load().mode ?? "browser";
    try {
      const itemId = await itemIdOf(String(b.text ?? ""));
      const viaBrowser = async (): Promise<Listing & { via: string }> => ({ ...listingFrom(itemId, await grabInBrowser(itemId)), via: "browser" });
      if (mode === "browser") return send(res, 200, await viaBrowser());
      try {
        return send(res, 200, { ...(await readXianyu(itemId)), via: "direct" });
      } catch (e) {
        if (mode === "auto" && e instanceof ImportError && e.code === "busy") return send(res, 200, await viaBrowser());
        throw e;
      }
    } catch (e) {
      return send(res, 400, { error: e instanceof ImportError ? e.code : (e as Error).message });
    }
  }
  if (url.pathname === "/api/list" && req.method === "POST") {
    const c = load();
    if (!c.token) return send(res, 400, { error: "先填管理口令" });
    const b = await readJson(req);
    const pictures = (Array.isArray(b.pictures) ? b.pictures : []).map(String).slice(0, 9);
    const images: string[] = [];
    for (const p of pictures) {
      const pic = await fetchPicture(p);
      if (!pic) return send(res, 400, { error: `图片下载失败：${p}` });
      images.push(await upload(pic.buf, pic.ext));
    }
    const r = await fetch(`${api()}/api/shop/admin/products`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${c.token}` },
      body: JSON.stringify({ ...b, images, pictures: undefined }),
    });
    const j = await r.json().catch(() => ({ error: `${r.status}` }));
    if (r.status === 404) return send(res, 400, { error: "管理口令不对（或服务器没开代上架）" });
    if (r.ok && typeof b.seller === "string") save({ ...load(), seller: b.seller });
    return send(res, r.status, j);
  }
  return send(res, 404, { error: "not found" });
}

const server = createServer((req, res) => {
  route(req, res).catch((e) => send(res, 500, { error: (e as Error).message }));
});
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  HOST = `127.0.0.1:${port}`;
  const link = `http://${HOST}/`;
  console.log(`Arm shop lister: ${link}`);
  console.log("If the browser did not open, copy the address above. Close this window to quit.");
  if (!process.env.ARM_LISTER_NO_OPEN) spawn("cmd", ["/c", "start", "", link], { detached: true, stdio: "ignore" }).unref();
});
