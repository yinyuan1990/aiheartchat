"use client";

import { useState } from "react";
import { CornerDownRight, Heart, Send, X } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { useSignMessage } from "wagmi";
import { commentMessage, likeMessage, postComment, postLike, useComments, type Comment, type TokenView } from "@/lib/api";
import { shortAddr } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useApp } from "@/components/providers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Pager, usePage } from "@/components/ui/pagination";
import { TimeAgo, WalletDot, errMsg } from "@/components/shared";

/** Wallet-signed comment thread (EIP-191). Stored off-chain by the indexer; anyone can verify the signature. */
export function Thread({ token }: { token: TokenView }) {
  const { t, connected, address, toggleConnect } = useApp();
  const { signMessageAsync } = useSignMessage();
  const qc = useQueryClient();
  const { data: comments = [], isLoading } = useComments(token.address, address);
  const [text, setText] = useState("");
  const [replyTo, setReplyTo] = useState<Comment | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => qc.invalidateQueries({ queryKey: ["comments", token.address] });

  const submit = async () => {
    if (!address || !text.trim()) return;
    setBusy(true);
    try {
      const ts = Date.now();
      const body = text.trim();
      const signature = await signMessageAsync({ message: commentMessage(token.address, body, ts, replyTo?.id ?? null) });
      await postComment(token.address, { author: address, text: body, replyTo: replyTo?.id ?? null, ts, signature });
      setText("");
      setReplyTo(null);
      toast.success(t("token.postReply"));
      void refresh();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const like = async (c: Comment) => {
    if (!address) {
      toggleConnect();
      return;
    }
    try {
      const ts = new Date().getTime();
      const signature = await signMessageAsync({ message: likeMessage(c.id, ts) });
      await postLike(c.id, { author: address, ts, signature });
      void refresh();
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  const byId = new Map(comments.map((c) => [c.id, c]));
  const pg = usePage(comments, 20);

  return (
    <div className="p-4">
      <div className="flex gap-3">
        {address ? <WalletDot address={address} size={32} className="mt-1" /> : <div className="mt-1 size-8 rounded-full bg-muted" />}
        <div className="flex-1">
          {replyTo && (
            <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
              <CornerDownRight size={11} /> {shortAddr(replyTo.author, 4, 4)}: <span className="truncate">{replyTo.text.slice(0, 60)}</span>
              <button className="ml-auto hover:text-foreground" onClick={() => setReplyTo(null)}><X size={12} /></button>
            </div>
          )}
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={280} placeholder={t("token.replyPlaceholder")} className="resize-none" disabled={!connected} />
          <div className="mt-2 flex items-center justify-between">
            <span className="font-mono text-[11px] text-muted-foreground">{text.length}/280 · {t("thread.signed")}</span>
            <Button size="sm" disabled={connected && (text.trim().length === 0 || busy)} onClick={connected ? submit : toggleConnect}>
              <Send /> {connected ? (busy ? t("tx.confirming") : t("token.postReply")) : t("common.connect")}
            </Button>
          </div>
        </div>
      </div>

      <div className="mt-5 space-y-4">
        {isLoading && <div className="text-center text-xs text-muted-foreground">{t("common.loading")}</div>}
        {!isLoading && comments.length === 0 && <div className="py-6 text-center text-xs text-muted-foreground">{t("thread.empty")}</div>}
        {pg.pageItems.map((c) => {
          const parent = c.replyTo ? byId.get(c.replyTo) : null;
          return (
            <div key={c.id} className={cn("flex gap-3", c.replyTo && "ml-8")}>
              <WalletDot address={c.author} size={32} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-mono">{shortAddr(c.author, 4, 4)}</span>
                  {c.isCreator && <Badge variant="gold">{t("token.creatorTag")}</Badge>}
                  <span className="text-muted-foreground"><TimeAgo ts={c.time} /> ago</span>
                  {parent && <span className="inline-flex items-center gap-1 text-muted-foreground"><CornerDownRight size={11} /> {shortAddr(parent.author, 4, 4)}</span>}
                </div>
                <p className="mt-1 text-sm whitespace-pre-wrap break-words text-secondary-foreground">{c.text}</p>
                <div className="mt-1.5 flex items-center gap-3 text-[11px] text-muted-foreground">
                  <button className={cn("inline-flex items-center gap-1 hover:text-down", c.liked && "text-down")} onClick={() => like(c)}>
                    <Heart size={12} fill={c.liked ? "currentColor" : "none"} /> {c.likes}
                  </button>
                  <button className="hover:text-foreground" onClick={() => setReplyTo(c)}>{t("thread.reply")}</button>
                </div>
              </div>
            </div>
          );
        })}
        <Pager page={pg.page} pageCount={pg.pageCount} onChange={pg.setPage} total={pg.total} pageSize={pg.pageSize} />
      </div>
    </div>
  );
}
