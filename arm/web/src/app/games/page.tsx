import type { Metadata } from "next";
import { GamesExplore } from "@/components/games/games-explore";

const title = "Games · 游戏探索";
const description = "Small games on Arc: earn $BOAT with the speedboat, the race car, the neon shooter or the tower crane, or try Sell the Top. 在 Arc 上玩小游戏：快艇、赛车、霓虹射击、盖楼赚 $BOAT。";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/games" },
  openGraph: { title, description, url: "/games" },
};

export default function GamesPage() {
  return <GamesExplore />;
}
