"use client";

import dynamic from "next/dynamic";

const TowerGame = dynamic(() => import("@/components/tower/tower-game"), {
  ssr: false,
  loading: () => <div className="fixed inset-0 z-[100] bg-[#f95240]" />,
});

export default function TowerPage() {
  return <TowerGame />;
}
