"use client";

import { useEffect, useState } from "react";
import { Bug, Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { buildDebugReport, copyText, installDebugLog } from "@/lib/debuglog";

// Floating bug icon (bottom-right). Click → copies the debug report and shows it in a dialog so it can also be
// selected by hand in wallet browsers where the clipboard API is blocked.
export function BugButton({ extra }: { extra?: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState("");
  const [copied, setCopied] = useState<boolean | null>(null);
  const zh = typeof window !== "undefined" && localStorage.getItem("arm.locale") === "zh";

  useEffect(() => { installDebugLog(); }, []);

  const grab = async () => {
    const r = buildDebugReport(extra);
    setReport(r);
    setOpen(true);
    setCopied(await copyText(r));
  };

  return (
    <>
      <button
        type="button"
        onClick={grab}
        title={zh ? "复制错误报告" : "Copy bug report"}
        className="fixed right-3 bottom-20 z-50 flex size-9 items-center justify-center rounded-full border border-foreground/15 bg-background/90 text-foreground/60 shadow-md backdrop-blur hover:text-foreground md:bottom-4"
      >
        <Bug size={16} />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Bug size={16} /> {zh ? "错误报告" : "Bug report"}</DialogTitle>
            <DialogDescription>
              {copied === true ? (zh ? "已复制到剪贴板，直接粘贴给开发即可。" : "Copied to clipboard — paste it to the developer.") : copied === false ? (zh ? "自动复制失败，请长按下面文字全选复制。" : "Auto-copy failed — long-press the text below to copy.") : "…"}
            </DialogDescription>
          </DialogHeader>
          <textarea readOnly value={report} onFocus={(e) => e.currentTarget.select()} className="h-64 w-full resize-none rounded-md border border-input bg-muted p-2 font-mono text-[10px] leading-tight outline-none" />
          <Button onClick={async () => setCopied(await copyText(report))} className="w-full">
            {copied ? <Check /> : <Copy />} {zh ? "再复制一次" : "Copy again"}
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
