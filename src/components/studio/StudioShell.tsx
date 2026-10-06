"use client";

import { useCallback, useEffect, useState } from "react";
import { Settings2, Workflow, CircleDollarSign } from "lucide-react";
import dynamic from "next/dynamic";
import { CommandBar } from "@/components/command-bar/CommandBar";
import { ResultsGrid } from "@/components/tasks/ResultsGrid";
import { AdminConnectionsPanel } from "@/components/studio/AdminConnectionsPanel";
import { mergeRuntimeCatalog } from "@/lib/runtime-catalog";
import { AdminAccess } from "./AdminAccess";
import { UsagePanel } from "./UsagePanel";

const WorkflowStudio = dynamic(() => import("@/components/workflows/WorkflowStudio").then(module => module.WorkflowStudio), { ssr: false });

export function StudioShell() {
  const [mode, setMode] = useState<"video" | "image">("image");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [workspace, setWorkspace] = useState<"studio" | "workflows">("studio");
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const checkSession = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/auth", { cache: "no-store" });
      const data = await response.json();
      setAuthenticated(response.ok && data.authenticated === true);
    } catch { setAuthenticated(false); }
  }, []);
  const [, setCatalogVersion] = useState(0);

  const loadCatalog = useCallback(async () => {
    const [images, videos] = await Promise.all([
      fetch("/api/catalog?mediaType=image", { cache: "no-store" }).then((response) => response.json()).catch(() => ({ models: [] })),
      fetch("/api/catalog?mediaType=video", { cache: "no-store" }).then((response) => response.json()).catch(() => ({ models: [] })),
    ]);
    mergeRuntimeCatalog([...(images.models ?? []), ...(videos.models ?? [])]);
    setCatalogVersion((version) => version + 1);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (new URLSearchParams(window.location.search).get("workspace") === "workflows") setWorkspace("workflows");
      void checkSession();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [checkSession]);

  useEffect(() => {
    if (!authenticated) return;
    window.addEventListener("focus", checkSession);
    window.addEventListener("open-higgsfield:auth-updated", checkSession);
    const interval = window.setInterval(checkSession, 60_000);
    return () => { window.clearInterval(interval); window.removeEventListener("focus", checkSession); window.removeEventListener("open-higgsfield:auth-updated", checkSession); };
  }, [checkSession, authenticated]);

  useEffect(() => {
    if (!authenticated) return;
    let cancelled = false;
    const refresh = () => { if (!cancelled) void loadCatalog(); };
    const timer = window.setTimeout(() => { void loadCatalog(); }, 0);
    window.addEventListener("open-higgsfield:connections-updated", refresh);
    return () => { cancelled = true; window.clearTimeout(timer); window.removeEventListener("open-higgsfield:connections-updated", refresh); };
  }, [loadCatalog, authenticated]);

  if (!authenticated) return <main className="grid min-h-screen place-items-center bg-[#060606] p-4 text-white">{authenticated === null ? <p>Comprobando acceso…</p> : <AdminAccess onReady={() => { setAuthenticated(true); setSettingsOpen(true); }} />}</main>;

  if (workspace === "workflows") return <WorkflowStudio onBack={() => {
    setWorkspace("studio");
    const url = new URL(window.location.href);
    for (const key of ["workspace", "workflow", "run"]) url.searchParams.delete(key);
    window.history.replaceState(null, "", url);
  }} />;

  return (
    <div className="relative h-screen overflow-hidden" style={{ background: "#060606" }}>
      {/* Workspace — full screen, scrolls naturally */}
      <ResultsGrid mode={mode} />

      <button type="button" onClick={() => {
        setWorkspace("workflows");
        const url = new URL(window.location.href); url.searchParams.set("workspace", "workflows"); window.history.replaceState(null, "", url);
      }} className="fixed left-5 top-5 z-30 flex items-center gap-2 rounded-full border border-[#d5ff47]/25 bg-black/70 px-4 py-2 text-xs text-[#d5ff47] shadow-lg backdrop-blur-md">
        <Workflow className="h-3.5 w-3.5" /> Workflows
      </button>

      <button type="button" onClick={() => setUsageOpen(true)} className="fixed right-20 top-5 z-30 flex items-center gap-2 rounded-full border border-[#d5ff47]/25 bg-black/70 px-3 py-2 text-xs text-[#d5ff47] shadow-lg backdrop-blur-md sm:right-28"><CircleDollarSign className="h-3.5 w-3.5" />Consumo</button>
      <button
        type="button"
        onClick={() => setSettingsOpen(true)}
        className="fixed right-5 top-5 z-30 flex items-center gap-2 rounded-full border border-white/10 bg-black/60 px-3 py-2 text-xs text-white/70 shadow-lg backdrop-blur-md transition hover:border-[#d5ff47]/50 hover:text-white"
        title="Configurar APIs"
      >
        <Settings2 className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">APIs</span>
      </button>

      {/* Bottom composer */}
      <CommandBar mode={mode} onModeChange={setMode} />
      <AdminConnectionsPanel open={settingsOpen} onOpenChange={setSettingsOpen} />
      <UsagePanel open={usageOpen} onOpenChange={setUsageOpen} />
    </div>
  );
}
