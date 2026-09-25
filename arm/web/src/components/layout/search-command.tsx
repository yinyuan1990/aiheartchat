"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeftRight, Plus, Rocket, Search, Trophy } from "lucide-react";
import { useTokens } from "@/lib/api";
import { fmtUsd, shortAddr } from "@/lib/format";
import { useApp } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut } from "@/components/ui/command";
import { PctChange, TokenAvatar } from "@/components/shared";

/** Global ⌘K search: tokens by name / symbol / address, plus quick navigation. */
export function SearchCommand({ className }: { className?: string }) {
  const { t } = useApp();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const tokens = useTokens("volume", "all").data ?? [];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)} className={className}>
        <Search className="text-muted-foreground" />
        <span className="flex-1 text-left font-normal text-muted-foreground">{t("common.search")}</span>
        <kbd className="hidden rounded-md border bg-muted px-1.5 font-mono text-[10px] text-muted-foreground md:inline">⌘K</kbd>
      </Button>

      <CommandDialog open={open} onOpenChange={setOpen} title={t("common.search")} description={t("search.hint")}>
        <Command>
          <CommandInput placeholder={t("search.placeholder")} />
          <CommandList>
            <CommandEmpty>{t("search.empty")}</CommandEmpty>
            <CommandGroup heading={t("search.tokens")}>
              {tokens.map((tok) => (
                <CommandItem key={tok.address} value={`${tok.name} ${tok.symbol} ${tok.address}`} onSelect={() => go(`/token/${tok.address}`)}>
                  <TokenAvatar logo={tok.logo} symbol={tok.symbol} seed={tok.address} size={24} className="rounded-md" />
                  <span className="font-medium">{tok.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">${tok.symbol}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">{shortAddr(tok.address, 6, 4)}</span>
                  <span className="ml-auto flex items-center gap-2 font-mono text-xs tabular">
                    {fmtUsd(tok.price)} <PctChange value={tok.change24h} className="text-[11px]" />
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="Go to">
              <CommandItem onSelect={() => go("/create")}>
                <Plus /> {t("nav.create")} <CommandShortcut>C</CommandShortcut>
              </CommandItem>
              <CommandItem onSelect={() => go("/rank")}>
                <Trophy /> {t("nav.rank")}
              </CommandItem>
              <CommandItem onSelect={() => go("/creator")}>
                <Rocket /> {t("nav.creator")}
              </CommandItem>
              <CommandItem onSelect={() => go("/tools")}>
                <ArrowLeftRight /> {t("nav.tools")}
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}
