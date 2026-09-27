import type { Metadata } from "next";
import Link from "next/link";
import { POSTS } from "@/content/blog";

export const metadata: Metadata = {
  title: "文章",
  description: "Arm 与 Arc 生态的文章：meme 发射台、创作者手续费、合约安全自查。",
  alternates: { canonical: "/blog" },
};

export default function BlogIndex() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-bold tracking-tight md:text-3xl">文章</h1>
      <ul className="space-y-3">
        {POSTS.map((p) => (
          <li key={p.slug}>
            <Link href={`/blog/${p.slug}`} className="block rounded-xl border bg-card p-4 transition-colors hover:border-primary/50">
              <div className="text-base font-semibold leading-snug md:text-lg">{p.title}</div>
              <p className="mt-1.5 text-sm text-secondary-foreground">{p.summary}</p>
              <div className="mt-2 text-xs text-muted-foreground">{p.date}</div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
