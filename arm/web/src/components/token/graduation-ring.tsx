"use client";

import { GraduationCap } from "lucide-react";
import { cn } from "@/lib/utils";

export function GraduationRing({ progress, size = 72, graduated, className }: { progress: number; size?: number; graduated?: boolean; className?: string }) {
  const pct = graduated ? 100 : Math.max(0, Math.min(100, progress));
  const stroke = 6;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = (pct / 100) * c;
  return (
    <div className={cn("relative shrink-0", className)} style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--accent)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={graduated ? "var(--gold)" : "var(--primary)"}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c - dash}`}
          className="transition-[stroke-dasharray] duration-700"
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        {graduated ? <GraduationCap size={size * 0.36} className="text-gold" /> : <span className="font-mono text-sm font-semibold tabular">{pct.toFixed(0)}%</span>}
      </div>
    </div>
  );
}
