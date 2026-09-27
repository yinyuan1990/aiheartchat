import type { ReactNode } from "react";

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|\[(.+?)\]\((.+?)\)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<strong key={m.index} className="font-semibold text-foreground">{m[1]}</strong>);
    else
      out.push(
        <a key={m.index} href={m[3]} target={m[3].startsWith("http") ? "_blank" : undefined} rel="noopener" className="text-primary hover:underline">
          {m[2]}
        </a>,
      );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Renders the small markup subset documented in src/content/blog.ts. */
export function Prose({ body }: { body: string }) {
  const nodes: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const Tag = list.ordered ? "ol" : "ul";
    nodes.push(
      <Tag key={nodes.length} className={`${list.ordered ? "list-decimal" : "list-disc"} space-y-1.5 pl-6`}>
        {list.items.map((it, i) => <li key={i}>{inline(it)}</li>)}
      </Tag>,
    );
    list = null;
  };
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    const ol = /^\d+\.\s+(.*)$/.exec(line);
    if (!line) flush();
    else if (line.startsWith("## ")) {
      flush();
      nodes.push(<h2 key={nodes.length} className="pt-4 text-lg font-bold tracking-tight text-foreground md:text-xl">{line.slice(3)}</h2>);
    } else if (line.startsWith("- ") || ol) {
      const ordered = !!ol;
      if (list && list.ordered !== ordered) flush();
      list ??= { ordered, items: [] };
      list.items.push(ol ? ol[1] : line.slice(2));
    } else {
      flush();
      nodes.push(<p key={nodes.length}>{inline(line)}</p>);
    }
  }
  flush();
  return <div className="space-y-4 text-[15px] leading-7 text-secondary-foreground">{nodes}</div>;
}
