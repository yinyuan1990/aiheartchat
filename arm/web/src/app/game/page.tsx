import type { Metadata } from "next";
import { SellTop } from "@/components/game/sell-top";

const title = "Sell the Top · 卖在山顶";
const description = "One real Arc launch a day. You're the first retail buyer. One tap to sell. 每天一个真实 Arc 新币开盘，你是第一个散户，只能按一次卖出。";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/game" },
  openGraph: { title, description, url: "/game", images: [{ url: "/game/r/today/image", width: 1200, height: 630 }] },
  twitter: { card: "summary_large_image", title, description, images: ["/game/r/today/image"] },
};

export default function GamePage() {
  return (
    <div className="mx-auto max-w-lg">
      <SellTop />
    </div>
  );
}
