"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { BugButton } from "@/components/layout/bug-button";
import { logDebug } from "@/lib/debuglog";

// Boss 9.12: a tab left open across a deploy fails when it lazily loads a chunk / server action that no longer
// exists ("此页面无法加载"). Those errors are fixed by a plain reload, so do it once automatically; anything else
// gets a bilingual retry card (with the bug-report button) instead of Next's bare English "Application error".
const STALE_BUILD = /ChunkLoadError|Loading chunk|Failed to fetch dynamically imported module|Server Reference|Importing a module script failed|Unexpected token '<'/i;
const RELOAD_KEY = "arcl:stale-reload";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const [zh] = useState(() => typeof window !== "undefined" && localStorage.getItem("arm.locale") === "zh");

  useEffect(() => {
    logDebug("page.crash", error, error.digest ?? "");
    const stale = STALE_BUILD.test(`${error.name} ${error.message}`);
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (stale && Date.now() - last > 30_000) {
      sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
      location.reload();
    }
  }, [error]);

  return (
    <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
      <h2 className="text-lg font-semibold">{zh ? "页面出错了" : "Something went wrong"}</h2>
      <p className="text-sm text-foreground/60">
        {zh ? "点右下角的虫子图标复制错误报告发给开发。" : "Tap the bug icon (bottom-right) to copy a report for the developer."}
      </p>
      <p className="max-w-full break-all font-mono text-xs text-foreground/50">{error.name}: {error.message}{error.digest ? ` (${error.digest})` : ""}</p>
      <div className="flex gap-2">
        <Button onClick={() => location.reload()}>{zh ? "重新加载" : "Reload"}</Button>
        <Button variant="outline" onClick={reset}>{zh ? "重试" : "Retry"}</Button>
        <Button variant="ghost" onClick={() => location.assign(location.origin + "/")}>{zh ? "返回首页" : "Home"}</Button>
      </div>
      <BugButton extra={{ crash: `${error.name}: ${error.message}`, digest: error.digest ?? "", stack: error.stack?.split("\n").slice(0, 8).join("\n") ?? "" }} />
    </div>
  );
}
