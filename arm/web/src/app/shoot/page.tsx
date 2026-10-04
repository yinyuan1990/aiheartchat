"use client";

import dynamic from "next/dynamic";

const ShootGame = dynamic(() => import("@/components/shoot/shoot-game"), {
  ssr: false,
  loading: () => <div className="fixed inset-0 z-[100] bg-[#05060d]" />,
});

export default function ShootPage() {
  return <ShootGame />;
}
