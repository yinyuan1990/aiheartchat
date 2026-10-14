/**
 * The only place Arm AI spends money: the server forwards BlockRun's x402 quote, this checks it and signs an EIP-3009
 * USDC transfer to BlockRun (Base). Refuses anything that is not exact USDC-on-Base to BlockRun's known payee, or that
 * goes over the user's caps. The server can ask, but it can never pick the payee or the amount ceiling.
 */
import { randomBytes } from "node:crypto";
import { toHex } from "viem";
import WebSocket from "ws";
import { caps, ledger, record } from "./store.mjs";

/** BlockRun's x402 payee on Base (same constant as the server, the web wallet and the MCP). */
export const BLOCKRUN_PAY_TO = "0xe9030014F5DAe217d0A152f02A043567b16c1aBf";
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const usd = (micro) => `$${(micro / 1e6).toFixed(4)}`;

/** null = fine to sign, otherwise why not (English: it is shown in Cursor by the server, which localizes the frame) */
export function refusal(m, c = caps(), l = ledger()) {
  const a = m?.accepted ?? {};
  if (a.scheme !== "exact" || a.network !== "eip155:8453" || !same(a.asset, BASE_USDC)) return "not an exact USDC-on-Base quote";
  if (!same(a.payTo, BLOCKRUN_PAY_TO)) return `payee ${a.payTo} is not BlockRun`;
  if (!/^\d+$/.test(String(a.amount))) return "bad amount";
  if (!String(m?.resource?.url ?? "").startsWith("https://blockrun.ai/")) return "the quote is not for blockrun.ai";
  const amount = Number(a.amount);
  if (amount > c.maxPerCall * 1e6) return `quote ${usd(amount)} is over your per-call cap ${usd(c.maxPerCall * 1e6)}`;
  if (l.signed + amount > c.dailyCap * 1e6) return `today's cap ${usd(c.dailyCap * 1e6)} reached (signed ${usd(l.signed)})`;
  return null;
}

export async function signQuote(account, a, resource) {
  const now = Math.floor(Date.now() / 1000);
  const auth = { from: account.address, to: BLOCKRUN_PAY_TO, value: BigInt(a.amount), validAfter: BigInt(now - 600), validBefore: BigInt(now + Math.min(Number(a.maxTimeoutSeconds ?? 300), 900)), nonce: toHex(randomBytes(32)) };
  const signature = await account.signTypedData({
    domain: { name: a.extra?.name ?? "USD Coin", version: a.extra?.version ?? "2", chainId: 8453, verifyingContract: BASE_USDC },
    types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
    primaryType: "TransferWithAuthorization",
    message: auth,
  });
  const payload = { x402Version: 2, resource, accepted: a, payload: { signature, authorization: { ...auth, value: String(auth.value), validAfter: String(auth.validAfter), validBefore: String(auth.validBefore) } } };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

/** handle one server message; returns the reply to send (or null) */
export async function handle(m, account) {
  if (m?.t !== "sign" || !m.id) return null;
  const why = refusal(m);
  const entry = { at: new Date().toISOString(), model: m.model, amount: Number(m.accepted?.amount ?? 0), bytes: m.bytes };
  if (why) {
    record({ ...entry, amount: 0, refused: why });
    return { t: "refuse", id: m.id, reason: why };
  }
  const payment = await signQuote(account, m.accepted, m.resource);
  record(entry);
  return { t: "signed", id: m.id, payment };
}

/** keep a WebSocket to the server open (reconnects with backoff); status changes go to onStatus */
export function connect({ url, key, lang, account, onStatus, onSigned }) {
  let ws, delay = 1000, stopped = false, timer, misses = 0;
  const open = () => {
    if (stopped) return;
    let opened = false;
    ws = new WebSocket(`${url}?lang=${encodeURIComponent(lang())}`, { headers: { authorization: `Bearer ${key}` } });
    ws.on("open", () => {
      opened = true;
      misses = 0;
      delay = 1000;
      onStatus("online");
    });
    // the bundled runtime may not report the 401 itself: after 3 refused connects in a row, register again
    ws.on("close", () => {
      if (!opened && ++misses % 3 === 0) onStatus("unregistered");
    });
    ws.on("message", async (raw) => {
      let m;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      const out = await handle(m, account).catch((e) => ({ t: "refuse", id: m.id, reason: e.message }));
      if (out) {
        ws.send(JSON.stringify(out));
        onSigned?.(m, out);
      }
    });
    ws.on("unexpected-response", (_req, res) => onStatus(res.statusCode === 401 ? "unregistered" : `http ${res.statusCode}`));
    ws.on("error", () => {});
    ws.on("close", () => {
      onStatus("offline");
      if (stopped) return;
      timer = setTimeout(open, delay);
      delay = Math.min(delay * 2, 30_000);
    });
  };
  open();
  return {
    /** tell the server the UI language (for the messages it writes into Cursor) without dropping the connection */
    setLang(l) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "lang", lang: l }));
    },
    reconnect() {
      clearTimeout(timer);
      if (ws?.readyState === WebSocket.OPEN) ws.close();
      else open();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      ws?.close();
    },
  };
}
