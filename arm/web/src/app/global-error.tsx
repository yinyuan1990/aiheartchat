"use client";

import { useEffect, useState } from "react";
import { buildDebugReport, copyText, logDebug } from "@/lib/debuglog";

// Last-resort boundary (root layout crashed, so no providers / styles beyond globals are guaranteed).
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  useEffect(() => { logDebug("layout.crash", error, error.digest ?? ""); }, [error]);
  const report = () => buildDebugReport({ crash: `${error.name}: ${error.message}`, digest: error.digest ?? "", stack: error.stack?.split("\n").slice(0, 8).join("\n") ?? "" });
  return (
    <html lang="zh">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: 24, maxWidth: 560, margin: "0 auto" }}>
        <h2>页面出错了 / Something went wrong</h2>
        <p style={{ fontFamily: "monospace", fontSize: 12, wordBreak: "break-all", opacity: 0.7 }}>{error.name}: {error.message}</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={() => location.reload()} style={{ padding: "8px 14px" }}>重新加载 / Reload</button>
          <button onClick={async () => setCopied(await copyText(report()))} style={{ padding: "8px 14px" }}>
            {copied === true ? "已复制 ✓" : copied === false ? "复制失败，见下方" : "复制错误报告 / Copy bug report"}
          </button>
        </div>
        {copied === false && <textarea readOnly value={report()} style={{ width: "100%", height: 240, marginTop: 12, fontFamily: "monospace", fontSize: 10 }} />}
      </body>
    </html>
  );
}
