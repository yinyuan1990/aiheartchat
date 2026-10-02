import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import type { GameResult, GameToday } from "@/lib/api";
import { latinSymbol } from "@/app/card/card-format";
import { PERSONA_EN, personaOf, strip, times } from "@/components/game/format";

const INDEXER = process.env.INDEXER_URL ?? "http://127.0.0.1:3101";
const asset = (f: string) => readFile(join(process.cwd(), "public", f));
const fonts = Promise.all([asset("card/inter-500.woff"), asset("card/inter-800.woff")]);
const logo = asset("brand/logo-arm-dark.png").then((b) => `data:image/png;base64,${b.toString("base64")}`);

const UP = "#3ddc97";
const DOWN = "#ff5c5c";
const GOLD = "#f5c451";

async function load<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(`${INDEXER}${path}`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

function Spark({ r }: { r: GameResult }) {
  const path = r.reveal?.path ?? [];
  if (path.length < 2 || r.x === null || r.peak === null || r.soldT === null) return null;
  const W = 420, H = 230, pad = 10;
  const t0 = path[0][0], t1 = Math.max(path.at(-1)![0], r.T);
  const ys = path.map((p) => Math.log(Math.max(p[1], 1e-6)));
  const lo = Math.min(...ys, 0), hi = Math.max(...ys, Math.log(r.peak.x));
  const px = (t: number) => pad + ((Math.sqrt(Math.max(0, t - t0)) / Math.sqrt(Math.max(1, t1 - t0))) * (W - pad * 2));
  const py = (x: number) => H - pad - ((Math.log(Math.max(x, 1e-6)) - lo) / Math.max(1e-6, hi - lo)) * (H - pad * 2);
  const d = path.map((p, i) => `${i ? "L" : "M"}${px(p[0]).toFixed(1)},${py(p[1]).toFixed(1)}`).join(" ");
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      <line x1={pad} x2={W - pad} y1={py(1)} y2={py(1)} stroke="rgba(255,255,255,0.18)" strokeDasharray="6 6" />
      <path d={d} fill="none" stroke="#e8e8e8" strokeWidth={3} />
      <circle cx={px(r.peak.t)} cy={py(r.peak.x)} r={9} fill={GOLD} />
      <circle cx={px(r.soldT)} cy={py(r.x)} r={9} fill={r.x >= 1 ? UP : DOWN} />
    </svg>
  );
}

function Strip({ r }: { r: GameResult }) {
  const s = strip(r);
  return (
    <div style={{ display: "flex", gap: 10 }}>
      {Array.from({ length: 10 }, (_, i) => (
        <div key={i} style={{ width: 40, height: 40, borderRadius: 8, background: i < s.filled ? (s.up ? UP : DOWN) : "rgba(255,255,255,0.12)" }} />
      ))}
    </div>
  );
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const valid = /^[\w-]{8,16}$/.test(id);
  const [play, today] = await Promise.all([
    valid ? load<GameResult>(`/api/game/play/${id}`) : Promise.resolve(null),
    load<GameToday>("/api/game/today"),
  ]);
  const r = play && typeof play.capture === "number" ? play : null;
  const [[f500, f800], logoSrc] = await Promise.all([fonts, logo]);
  const n = r?.n ?? (today?.status === "ready" ? today.n : null);
  const accent = r ? (r.up ? UP : DOWN) : UP;
  const coin = r?.reveal?.coin;

  const body = r ? (
    <div style={{ display: "flex", flex: 1, marginTop: 26, alignItems: "center" }}>
      <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
        <div style={{ fontSize: 20, color: "#8a8a8a", letterSpacing: 4 }}>{coin ? `$${latinSymbol(coin.symbol, coin.token)}`.toUpperCase() : "TODAY'S ROUND"}</div>
        <div style={{ fontSize: 64, fontWeight: 800, color: accent, marginTop: 4, lineHeight: 1.05 }}>{PERSONA_EN[personaOf(r)]}</div>
        {r.x !== null && r.peak ? (
          <div style={{ display: "flex", alignItems: "flex-end", marginTop: 18 }}>
            <div style={{ fontSize: 104, fontWeight: 800, color: accent, lineHeight: 1 }}>{times(r.x)}</div>
            <div style={{ fontSize: 30, color: "#a6a6a6", marginLeft: 22, marginBottom: 14 }}>{`top was ${times(r.peak.x)}`}</div>
          </div>
        ) : (
          <div style={{ fontSize: 30, color: "#a6a6a6", marginTop: 18 }}>Score hidden until the round closes</div>
        )}
        <div style={{ display: "flex", marginTop: 28 }}><Strip r={r} /></div>
        <div style={{ fontSize: 24, color: "#a6a6a6", marginTop: 18 }}>
          {r.beat != null && r.others > 0 ? `Beat ${Math.round(r.beat * 100)}% of ${r.others} players` : "First rounds in · be the benchmark"}
        </div>
      </div>
      {r.reveal && r.x !== null ? (
        <div style={{ display: "flex", padding: 14, borderRadius: 22, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.09)" }}>
          <Spark r={r} />
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", width: 420, height: 258, borderRadius: 22, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.09)" }}>
          <div style={{ fontSize: 30, fontWeight: 800 }}>Chart hidden</div>
          <div style={{ fontSize: 22, color: "#8a8a8a", marginTop: 8 }}>No spoilers until the day ends</div>
        </div>
      )}
    </div>
  ) : (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, justifyContent: "center" }}>
      <div style={{ fontSize: 84, fontWeight: 800, color: "#ffffff", lineHeight: 1.05 }}>Sell the Top</div>
      <div style={{ fontSize: 34, color: "#a6a6a6", marginTop: 18 }}>One real Arc launch a day. You are the first retail buyer.</div>
      <div style={{ fontSize: 34, color: "#a6a6a6", marginTop: 6 }}>45 seconds. One tap to sell. How close to the top?</div>
    </div>
  );

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", padding: "48px 60px 40px", color: "#f2f2f2", fontFamily: "Inter", backgroundColor: "#050505", backgroundImage: `radial-gradient(circle at 88% 0%, ${accent === UP ? "rgba(61,220,151,0.20)" : "rgba(255,92,92,0.20)"} 0%, rgba(5,5,5,0) 46%), radial-gradient(circle at 0% 100%, rgba(245,196,81,0.10) 0%, rgba(5,5,5,0) 40%)` }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={logoSrc} height={52} width={158} alt="" />
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
            <div style={{ fontSize: 18, color: "#8a8a8a", letterSpacing: 4 }}>SELL THE TOP · DAILY</div>
            {n ? <div style={{ fontSize: 26, fontWeight: 800, marginTop: 4 }}>{`Round #${n}`}</div> : null}
          </div>
        </div>
        {body}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 20, paddingTop: 18, borderTop: "1px solid rgba(255,255,255,0.1)" }}>
          <div style={{ fontSize: 24, fontWeight: 800 }}>arm.yyheart.com/game</div>
          <div style={{ fontSize: 22, color: "#a6a6a6" }}>Real Arc mainnet data · free to play →</div>
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
      headers: { "cache-control": r && !r.live ? "public, max-age=86400" : "public, max-age=120" },
    },
  );
}
