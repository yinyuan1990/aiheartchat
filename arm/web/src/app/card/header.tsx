"use client";

import { Sparkles } from "lucide-react";
import { useApp } from "@/components/providers";

export function CardHeader() {
  const { t } = useApp();
  return (
    <div>
      <h1 className="flex items-center gap-2 text-xl font-semibold"><Sparkles className="size-5 text-primary" /> {t("tools.tab.card")}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{t("card.subtitle")}</p>
    </div>
  );
}
