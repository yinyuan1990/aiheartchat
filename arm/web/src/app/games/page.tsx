import type { Metadata } from "next";
import { GamesExplore } from "@/components/games/games-explore";

const title = "Games · 游戏探索";
const description = "Small games on Arc: earn $BOAT with the speedboat, or try Sell the Top. 在 Arc 上玩小游戏：快艇跑多远赚多少 $BOAT。";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/games" },
  openGraph: { title, description, url: "/games" },
};

export default function GamesPage() {
  return <GamesExplore />;
}
