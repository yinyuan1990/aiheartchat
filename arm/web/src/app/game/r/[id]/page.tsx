import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SellTop } from "@/components/game/sell-top";

type Props = { params: Promise<{ id: string }> };
const valid = (id: string) => /^[\w-]{8,16}$/.test(id);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  if (!valid(id)) return {};
  const title = "Sell the Top · 卖在山顶";
  const description = "Can you sell closer to the top? One real Arc launch a day, one tap. 你能卖得比我更接近山顶吗？";
  const image = `/game/r/${id}/image`;
  return {
    title,
    description,
    alternates: { canonical: "/game" },
    openGraph: { title, description, url: `/game/r/${id}`, images: [{ url: image, width: 1200, height: 630 }] },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

export default async function SharedPlayPage({ params }: Props) {
  const { id } = await params;
  if (!valid(id) && id !== "today") notFound();
  return (
    <div className="mx-auto max-w-lg">
      <SellTop shared={valid(id) ? id : undefined} />
    </div>
  );
}
