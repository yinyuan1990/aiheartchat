"use client";

import dynamic from "next/dynamic";

const HopGame = dynamic(() => import("@/components/hop/hop-game"), {
  ssr: false,
  loading: () => <div className="fixed inset-0 z-[100] bg-[#2f6b3a]" />,
});

export default function HopPage() {
  return <HopGame />;
}
