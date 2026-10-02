"use client";

// 3D whale-liquidation "mountain range": x = distance from the current price, z = coin, height = notional liquidated there.
// Client-only (three.js); loaded with next/dynamic from perp-radar.

import { useCallback, useEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";

export type LiqRow = { coin: string; mark: number; positions: { side: "long" | "short"; ntl: number; liqPx: number | null }[] };

const SPAN = 0.3;
const BUCKETS = 40;
const WIDTH = 10;
const CELL = WIDTH / BUCKETS;
const ROW_GAP = 2.2;
const MAX_H = 3.2;
const UP = "#26a69a";
const DOWN = "#ef5350";
const WALL = "#facc15";
const TICKS = [-0.3, -0.2, -0.1, 0.1, 0.2, 0.3];

const box = new THREE.BoxGeometry(1, 1, 1);
box.translate(0, 0.5, 0);

const big = (v: number) => (v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${(v / 1e3).toFixed(0)}K`);
const xOf = (i: number) => -WIDTH / 2 + (i + 0.5) * CELL;

type Bucket = { long: number; short: number };

function bucketize(row: LiqRow): Bucket[] {
  const b = Array.from({ length: BUCKETS }, () => ({ long: 0, short: 0 }));
  const lo = row.mark * (1 - SPAN), step = (row.mark * 2 * SPAN) / BUCKETS;
  for (const p of row.positions) {
    if (p.liqPx === null) continue;
    const i = Math.floor((p.liqPx - lo) / step);
    if (i >= 0 && i < BUCKETS) b[i][p.side] += p.ntl;
  }
  return b;
}

/** Gaussian-smoothed ridge behind a row's bars, so sparse whale data still reads as a mountain range. */
function Ridge({ buckets, z, h, dim }: { buckets: Bucket[]; z: number; h: (v: number) => number; dim: boolean }) {
  const shapes = useMemo(() => {
    const raw = buckets.map((b) => b.long + b.short);
    const sigma = 1.6;
    const smooth = raw.map((_, i) => {
      let s = 0, w = 0;
      for (let j = Math.max(0, i - 5); j <= Math.min(BUCKETS - 1, i + 5); j++) {
        const k = Math.exp(-((i - j) ** 2) / (2 * sigma * sigma));
        s += raw[j] * k;
        w += k;
      }
      return s / w;
    });
    // sqrt scaling lifts near-zero tails into flat slabs; fade them out below a small share of the row's peak
    const floor = Math.max(1, ...smooth) * 0.05;
    const half = (from: number, to: number) => {
      const s = new THREE.Shape();
      s.moveTo(xOf(from) - CELL / 2, 0);
      for (let i = from; i <= to; i++) s.lineTo(xOf(i), h(smooth[i]) * 0.85 * Math.min(1, smooth[i] / floor));
      s.lineTo(xOf(to) + CELL / 2, 0);
      s.closePath();
      return new THREE.ShapeGeometry(s);
    };
    return [half(0, BUCKETS / 2 - 1), half(BUCKETS / 2, BUCKETS - 1)];
  }, [buckets, h]);
  useEffect(() => () => shapes.forEach((g) => g.dispose()), [shapes]);
  return (
    <group position={[0, 0, z - 0.3]}>
      {shapes.map((g, i) => (
        <mesh key={i} geometry={g}>
          <meshBasicMaterial color={i ? UP : DOWN} transparent opacity={dim ? 0.08 : 0.24} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      ))}
    </group>
  );
}

/** A bar that grows toward its target height; `delay` staggers the rise when a coin is first shown. */
function Bar({ x, z, base, height, color, dim, delay, onPick }: {
  x: number; z: number; base: number; height: number; color: string; dim: boolean; delay: number; onPick: () => void;
}) {
  const mesh = useRef<THREE.Mesh>(null);
  const born = useRef(-1);
  useFrame(({ clock }, dt) => {
    const m = mesh.current;
    if (!m) return;
    if (born.current < 0) born.current = clock.elapsedTime;
    const target = clock.elapsedTime - born.current < delay ? 0.001 : Math.max(0.001, height);
    m.scale.y += (target - m.scale.y) * Math.min(1, dt * 6);
    m.position.y = base * (m.scale.y / Math.max(0.001, height));
  });
  return (
    <mesh ref={mesh} geometry={box} position={[x, 0, z]} scale={[CELL * 0.78, 0.001, 1.1]} onClick={(e) => { e.stopPropagation(); onPick(); }}>
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={dim ? 0.05 : 0.35} transparent opacity={dim ? 0.28 : 0.95} roughness={0.45} />
    </mesh>
  );
}

function PriceWall({ depth }: { depth: number }) {
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  useFrame(({ clock }) => {
    if (mat.current) mat.current.opacity = 0.16 + Math.sin(clock.elapsedTime * 2.4) * 0.07;
  });
  return (
    <group>
      <mesh position={[0, MAX_H / 2, 0]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[depth, MAX_H]} />
        <meshBasicMaterial ref={mat} color={WALL} transparent opacity={0.18} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <mesh position={[0, 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[0.05, depth]} />
        <meshBasicMaterial color={WALL} />
      </mesh>
    </group>
  );
}

/** Slow sway plus horizontal drag; vertical swipes stay with the page so mobile scrolling keeps working. */
function Rig({ drag, children }: { drag: RefObject<number>; children: ReactNode }) {
  const group = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (group.current) group.current.rotation.y = Math.sin(clock.elapsedTime * 0.22) * 0.22 + drag.current;
  });
  return <group ref={group}>{children}</group>;
}

function Scene({ rows, active, onPick, drag }: { rows: LiqRow[]; active: string; onPick: (coin: string) => void; drag: RefObject<number> }) {
  const data = useMemo(() => rows.map((r) => ({ row: r, buckets: bucketize(r) })), [rows]);
  const max = Math.max(1, ...data.flatMap((d) => d.buckets.map((b) => b.long + b.short)));
  const h = useCallback((v: number) => Math.sqrt(v / max) * MAX_H, [max]);
  const z0 = ((rows.length - 1) * ROW_GAP) / 2;
  const depth = rows.length * ROW_GAP;

  return (
    <Rig drag={drag}>
      <ambientLight intensity={0.55} />
      <directionalLight position={[4, 9, 6]} intensity={1.3} />
      <gridHelper args={[WIDTH + 1, BUCKETS / 2, "#888888", "#888888"]} position={[0, 0, 0]} scale={[1, 1, depth / (WIDTH + 1)]}>
        <lineBasicMaterial attach="material" color="#888888" transparent opacity={0.12} />
      </gridHelper>
      <PriceWall depth={depth} />

      {data.map(({ row, buckets }, r) => {
        const z = z0 - r * ROW_GAP;
        const dim = row.coin !== active;
        const top = buckets.map((b, i) => ({ i, v: b.long + b.short })).filter((x) => x.v > 0).sort((a, b) => b.v - a.v).slice(0, 3);
        return (
          <group key={row.coin}>
            <Ridge buckets={buckets} z={z} h={h} dim={dim} />
            {buckets.map((b, i) => {
              const hl = h(b.long), hs = h(b.long + b.short) - hl;
              const delay = Math.abs(i - BUCKETS / 2) * 0.015 + r * 0.08;
              return (
                <group key={i}>
                  {b.long > 0 && <Bar x={xOf(i)} z={z} base={0} height={hl} color={DOWN} dim={dim} delay={delay} onPick={() => onPick(row.coin)} />}
                  {b.short > 0 && <Bar x={xOf(i)} z={z} base={hl} height={hs} color={UP} dim={dim} delay={delay} onPick={() => onPick(row.coin)} />}
                </group>
              );
            })}
            {dim && (
              <Html position={[WIDTH / 2 - 1.4, 0.05, z + 0.6]} center zIndexRange={[20, 0]}>
                <button type="button" onClick={() => onPick(row.coin)} className="rounded px-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground">
                  {row.coin}
                </button>
              </Html>
            )}
            {!dim && top.map(({ i, v }) => (
              <Html key={i} position={[xOf(i), h(v) + 0.25, z]} center zIndexRange={[20, 0]}>
                <span className="pointer-events-none whitespace-nowrap rounded bg-background/80 px-1 font-mono text-[10px] font-bold tabular-nums">{big(v)}</span>
              </Html>
            ))}
          </group>
        );
      })}

      {TICKS.map((k) => (
        <Html key={k} position={[(k / SPAN) * (WIDTH / 2), 0, z0 + 1.3]} center zIndexRange={[20, 0]}>
          <span className="pointer-events-none font-mono text-[10px] text-muted-foreground">{k > 0 ? "+" : ""}{k * 100}%</span>
        </Html>
      ))}
      <Html position={[0, MAX_H + 0.35, 0]} center zIndexRange={[20, 0]}>
        <span className="pointer-events-none whitespace-nowrap rounded-full bg-yellow-400/90 px-2 py-0.5 text-[10px] font-bold text-black">
          {active} {rows.find((r) => r.coin === active)?.mark.toLocaleString("en-US", { maximumFractionDigits: 2 })}
        </span>
      </Html>
    </Rig>
  );
}

export default function LiqMountains({ rows, active, onPick }: { rows: LiqRow[]; active: string; onPick: (coin: string) => void }) {
  const drag = useRef(0);
  const start = useRef<{ x: number; d: number } | null>(null);
  return (
    <div
      className="h-72 w-full cursor-grab touch-pan-y select-none active:cursor-grabbing"
      onPointerDown={(e) => { start.current = { x: e.clientX, d: drag.current }; }}
      onPointerMove={(e) => {
        if (start.current) drag.current = Math.max(-0.8, Math.min(0.8, start.current.d + (e.clientX - start.current.x) * 0.0035));
      }}
      onPointerUp={() => { start.current = null; }}
      onPointerLeave={() => { start.current = null; }}
      onPointerCancel={() => { start.current = null; }}
    >
      <Canvas camera={{ position: [0, 6.2, 12], fov: 40 }} onCreated={({ camera }) => camera.lookAt(0, 0.4, 0)} dpr={[1, 2]} gl={{ antialias: true, alpha: true }}>
        <Scene rows={rows} active={active} onPick={onPick} drag={drag} />
      </Canvas>
    </div>
  );
}
