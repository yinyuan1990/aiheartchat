"use client";

import dynamic from "next/dynamic";

const BoatGame = dynamic(() => import("@/components/boat/boat-game"), {
  ssr: false,
  loading: () => <div className="fixed inset-0 z-[100] bg-[#cdeef5]" />,
});

export default function BoatPage() {
  return <BoatGame />;
}
