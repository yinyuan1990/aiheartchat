"use client";

import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { useReadContract } from "wagmi";
import { useAdminOverview } from "@/lib/api";
import { ADDR, addrUrl, factoryAbi } from "@/lib/web3";
import { useApp } from "@/components/providers";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { DataPanel } from "./data-panel";
import { TokensPanel } from "./tokens-panel";
import { KeeperPanel } from "./keeper-panel";
import { HotPanel } from "./hot-panel";
import { SitePanel } from "./site-panel";
import { BurnsPanel } from "./burns-panel";

type Tab = "data" | "tokens" | "hot" | "keeper" | "burns";

/** Public read-only dashboard: everything shown is public chain data / the public index, so no wallet is needed
 *  to look. Contract parameters are fixed and are not edited from here. The two remaining actions (distribute /
 *  graduate, both permissionless) only render when the connected wallet is the on-chain factory owner. */
export default function AdminPage() {
  const { t, address, wrongChain } = useApp();
  const [tab, setTab] = useState<Tab>("data");

  const ownerQ = useReadContract({ address: ADDR.factory, abi: factoryAbi, functionName: "owner", query: { staleTime: 60_000 } });
  const owner = ownerQ.data;
  const isOwner = !!owner && !!address && owner.toLowerCase() === address.toLowerCase() && !wrongChain;
  const ov = useAdminOverview(true);

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight md:text-3xl">{t("admin.title")}</h1>
          <p className="mt-1 text-sm text-secondary-foreground">{t("admin.subtitle")}</p>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          <div className="flex items-center justify-end gap-2">
            {t("admin.ownerIs")}
            {isOwner && <Badge variant="gold"><ShieldCheck /> {t("admin.ownerMode")}</Badge>}
          </div>
          {owner ? (
            <a href={addrUrl(owner)} target="_blank" rel="noreferrer" className="font-mono text-foreground hover:underline">{owner}</a>
          ) : (
            <Skeleton className="mt-1 h-4 w-72" />
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
          <TabsList>
            <TabsTrigger value="data">{t("admin.tab.data")}</TabsTrigger>
            <TabsTrigger value="tokens">{t("admin.tab.tokens")}</TabsTrigger>
            <TabsTrigger value="hot">{t("admin.tab.hot")}</TabsTrigger>
            <TabsTrigger value="keeper">{t("admin.tab.keeper")}</TabsTrigger>
            <TabsTrigger value="burns">{t("admin.tab.burns")}</TabsTrigger>
          </TabsList>
        </Tabs>
        <SitePanel canAct={isOwner} />
      </div>

      {!ov.data ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}</div>
      ) : tab === "data" ? (
        <DataPanel ov={ov.data} />
      ) : tab === "tokens" ? (
        <TokensPanel ov={ov.data} canAct={isOwner} />
      ) : tab === "hot" ? (
        <HotPanel canAct={isOwner} />
      ) : tab === "burns" ? (
        <BurnsPanel ov={ov.data} canAct={isOwner} />
      ) : (
        <KeeperPanel ov={ov.data} />
      )}
    </div>
  );
}
