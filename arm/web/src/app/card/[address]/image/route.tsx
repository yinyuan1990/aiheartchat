import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { isAddress } from "viem";
import type { CardState, CardView } from "@/lib/api";
import { PERSONA_EN, holdTime, latinSymbol, shortWallet, signedPct, signedUsd } from "../../card-format";

const INDEXER = process.env.INDEXER_URL ?? "http://127.0.0.1:3101";
// standalone server.js chdirs into .next/standalone, where public/ is copied next to it
const asset = (f: string) => readFile(join(process.cwd(), "public", f));
const fonts = Promise.all([asset("card/inter-500.woff"), asset("card/inter-800.woff")]);
const logo = asset("brand/logo-arm-dark.png").then((b) => `data:image/png;base64,${b.toString("base64")}`);

const UP = "#3ddc97";
const DOWN = "#ff5c5c";

async function load(address: string): Promise<CardView | null> {
  try {
    const r = await fetch(`${INDEXER}/api/card/${address}`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    const s = (await r.json()) as CardState;
    return s.status === "ready" && s.card.trades > 0 ? s.card : null;
  } catch {
    return null;
  }
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", width: 198, padding: "12px 22px", borderRadius: 18, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.09)" }}>
      <div style={{ fontSize: 17, color: "#8a8a8a", letterSpacing: 1 }}>{label}</div>
      <div style={{ fontSize: 34, fontWeight: 800, color: color ?? "#f2f2f2", marginTop: 2 }}>{value}</div>
    </div>
  );
}

function Pick({ tag, sym, pct, extra, color }: { tag: string; sym: string; pct: string; extra?: string; color: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", width: 408, height: 64, padding: "0 22px", borderRadius: 18, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.09)" }}>
      <div style={{ fontSize: 17, color: "#8a8a8a", width: 78 }}>{tag}</div>
      <div style={{ fontSize: 26, fontWeight: 800, color: "#f2f2f2", flex: 1, overflow: "hidden", whiteSpace: "nowrap" }}>{`$${sym.length > 9 ? `${sym.slice(0, 8)}…` : sym}`}</div>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", marginLeft: 12 }}>
        <div style={{ fontSize: 26, fontWeight: 800, color }}>{pct}</div>
        {extra ? <div style={{ fontSize: 16, color: "#8a8a8a" }}>{extra}</div> : null}
      </div>
    </div>
  );
}

export async function GET(_req: Request, { params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const ok = isAddress(address);
  const card = ok ? await load(address.toLowerCase()) : null;
  const [[f500, f800], logoSrc] = await Promise.all([fonts, logo]);
  const win = card ? card.pnl >= 0 : true;
  const accent = win ? UP : DOWN;
  const [pName, pLine] = PERSONA_EN[card?.persona ?? "newbie"];

  const body = card ? (
    <div style={{ display: "flex", flex: 1, marginTop: 30 }}>
      <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
        <div style={{ fontSize: 20, color: "#8a8a8a", letterSpacing: 4 }}>PERSONA</div>
        <div style={{ fontSize: 66, fontWeight: 800, color: "#ffffff", marginTop: 2, lineHeight: 1.05 }}>{pName}</div>
        <div style={{ fontSize: 26, color: "#a6a6a6", marginTop: 8 }}>{pLine}</div>
        <div style={{ fontSize: 20, color: "#8a8a8a", letterSpacing: 4, marginTop: 44 }}>TOTAL PNL</div>
        <div style={{ display: "flex", alignItems: "flex-end", marginTop: 2 }}>
          <div style={{ fontSize: 88, fontWeight: 800, color: accent, lineHeight: 1, whiteSpace: "nowrap" }}>{signedUsd(card.pnl)}</div>
          <div style={{ fontSize: 34, fontWeight: 800, color: accent, marginLeft: 20, marginBottom: 10, padding: "4px 16px", borderRadius: 999, background: win ? "rgba(61,220,151,0.12)" : "rgba(255,92,92,0.12)" }}>{signedPct(card.pct)}</div>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", width: 408, gap: 12 }}>
        <div style={{ display: "flex", gap: 12 }}>
          <Stat label="WIN RATE" value={`${Math.round(card.winRate * 100)}%`} color={card.winRate >= 0.5 ? UP : "#f2f2f2"} />
          <Stat label="COINS" value={String(card.tokens)} />
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          <Stat label="TRADES" value={String(card.trades)} />
          <Stat label="AVG HOLD" value={holdTime(card.avgHoldSec)} />
        </div>
        {card.best ? <Pick tag="BEST" sym={latinSymbol(card.best.symbol, card.best.address)} pct={signedPct(card.best.pct)} extra={card.best.rank ? `#${card.best.rank} buyer` : undefined} color={UP} /> : null}
        {card.worst ? <Pick tag="WORST" sym={latinSymbol(card.worst.symbol, card.worst.address)} pct={signedPct(card.worst.pct)} color={DOWN} /> : null}
      </div>
    </div>
  ) : (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, justifyContent: "center" }}>
      <div style={{ fontSize: 76, fontWeight: 800, color: "#ffffff", lineHeight: 1.05 }}>Arc Meme PnL Card</div>
      <div style={{ fontSize: 32, color: "#a6a6a6", marginTop: 18 }}>Paste any Arc wallet. Get its meme-coin record.</div>
    </div>
  );

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", padding: "48px 60px 40px", color: "#f2f2f2", fontFamily: "Inter", backgroundColor: "#050505", backgroundImage: `radial-gradient(circle at 88% 0%, ${win ? "rgba(61,220,151,0.20)" : "rgba(255,92,92,0.20)"} 0%, rgba(5,5,5,0) 46%), radial-gradient(circle at 0% 100%, rgba(255,255,255,0.08) 0%, rgba(5,5,5,0) 40%)` }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={logoSrc} height={52} width={158} alt="" />
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
            <div style={{ fontSize: 18, color: "#8a8a8a", letterSpacing: 4 }}>ARC MEME PNL CARD</div>
            {ok ? <div style={{ fontSize: 26, fontWeight: 800, marginTop: 4 }}>{shortWallet(address)}</div> : null}
          </div>
        </div>
        {body}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 20, paddingTop: 18, borderTop: "1px solid rgba(255,255,255,0.1)" }}>
          <div style={{ fontSize: 24, fontWeight: 800 }}>arm.yyheart.com/card</div>
          <div style={{ fontSize: 22, color: "#a6a6a6" }}>Check your wallet →</div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      fonts: [
        { name: "Inter", data: f500, weight: 500, style: "normal" },
        { name: "Inter", data: f800, weight: 800, style: "normal" },
      ],
      headers: { "cache-control": "public, max-age=300" },
    },
  );
}
