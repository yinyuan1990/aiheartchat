import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { POSTS, postBySlug } from "@/content/blog";
import { Prose } from "@/components/blog/prose";

type Props = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return POSTS.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const post = postBySlug((await params).slug);
  if (!post) return {};
  return {
    title: post.title,
    description: post.summary,
    alternates: { canonical: `/blog/${post.slug}` },
    openGraph: { type: "article", title: post.title, description: post.summary, publishedTime: post.date },
    twitter: { card: "summary_large_image", title: post.title, description: post.summary },
  };
}

export default async function BlogPost({ params }: Props) {
  const post = postBySlug((await params).slug);
  if (!post) notFound();
  return (
    <article className="mx-auto max-w-3xl space-y-6">
      <Link href="/blog" className="text-sm text-muted-foreground hover:text-foreground">← 全部文章</Link>
      <header className="space-y-2">
        <h1 className="text-2xl font-bold leading-snug tracking-tight md:text-3xl">{post.title}</h1>
        <div className="text-xs text-muted-foreground">{post.date} · Arm</div>
      </header>
      <Prose body={post.body} />
      <p className="border-t pt-4 text-xs leading-relaxed text-muted-foreground">
        风险提示：本文仅为信息分享，不构成任何投资建议。meme 币价格波动极大，可能归零，请只使用你能承受损失的资金参与。
      </p>
    </article>
  );
}
