import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isAddress } from "viem";
import { PnlCard } from "@/components/tools/pnl-card";
import { CardHeader } from "../header";
import { shortWallet } from "../card-format";

type Props = { params: Promise<{ address: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { address } = await params;
  if (!isAddress(address)) return {};
  const a = address.toLowerCase();
  // X caches card images per URL: bucket by 10 minutes so a re-shared card picks up fresh numbers
  const image = `/card/${a}/image?v=${Math.floor(Date.now() / 600_000)}`;
  const title = `${shortWallet(address)} · Arc Meme PnL Card`;
  const description = "Paste any Arc wallet and get its meme-coin PnL card — win rate, best trade, persona. 输入任意 Arc 钱包，生成打狗战绩卡。";
  return {
    title,
    description,
    alternates: { canonical: `/card/${a}` },
    openGraph: { title, description, url: `/card/${a}`, images: [{ url: image, width: 1200, height: 630 }] },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

export default async function WalletCardPage({ params }: Props) {
  const { address } = await params;
  if (!isAddress(address)) notFound();
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <CardHeader />
      <PnlCard initial={address} />
    </div>
  );
}
