"use client";

import dynamic from "next/dynamic";

const RaceGame = dynamic(() => import("@/components/race/race-game"), {
  ssr: false,
  loading: () => <div className="fixed inset-0 z-[100] bg-[#2b2452]" />,
});

export default function RacePage() {
  return <RaceGame />;
}
