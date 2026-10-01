import type { Metadata } from "next";
import { PnlCard } from "@/components/tools/pnl-card";
import { CardHeader } from "./header";

const title = "Arc Meme PnL Card";
const description = "Paste any Arc wallet and get its meme-coin PnL card — win rate, best trade, persona. 输入任意 Arc 钱包，生成打狗战绩卡。";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/card" },
  openGraph: { title, description, url: "/card", images: [{ url: "/card/0x0/image", width: 1200, height: 630 }] },
  twitter: { card: "summary_large_image", title, description, images: ["/card/0x0/image"] },
};

export default function CardPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <CardHeader />
      <PnlCard />
    </div>
  );
}
