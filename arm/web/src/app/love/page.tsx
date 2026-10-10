"use client";

import dynamic from "next/dynamic";

const LoveGame = dynamic(() => import("@/components/love/love-game"), {
  ssr: false,
  loading: () => <div className="fixed inset-0 z-[100] bg-[#160b1d]" />,
});

export default function LovePage() {
  return <LoveGame />;
}
