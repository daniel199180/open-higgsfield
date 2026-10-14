"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { CommandBar } from "@/components/command-bar/CommandBar";
import { ResultsGrid } from "@/components/tasks/ResultsGrid";
import { CarouselResults } from "@/components/social/CarouselResults";
import { LogoResults } from "@/components/studio/LogoResults";
import { AudioStudio } from "@/components/studio/AudioStudio";
import { ImageEditingStudio } from "@/components/studio/ImageEditingStudio";
import { CharacterStudio } from "@/components/characters/CharacterStudio";
import { CompanyLibrary } from "@/components/studio/CompanyLibrary";
import type { StudioMode } from "@/components/studio/StudioModePill";
import { AdminConnectionsPanel } from "@/components/studio/AdminConnectionsPanel";
import { mergeRuntimeCatalog } from "@/lib/runtime-catalog";
import { AdminAccess } from "./AdminAccess";
import { StudioNavigation } from "./StudioNavigation";
import { UsagePanel } from "./UsagePanel";

const WorkflowStudio = dynamic(() => import("@/components/workflows/WorkflowStudio").then(module => module.WorkflowStudio), { ssr: false });
const SocialStudio = dynamic(() => import("@/components/social/SocialStudio").then(module => module.SocialStudio), { ssr: false });

export function StudioShell() {
  const [mode, setMode] = useState<StudioMode>("image");
  const [usageOpen, setUsageOpen] = useState(false);
  const [workspace, setWorkspace] = useState<"studio" | "workflows" | "social" | "editor" | "characters" | "companies" | "apis">("studio");
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const beforeLeaveWorkflow = useRef<(() => Promise<boolean>) | null>(null);
  const registerWorkflowGuard = useCallback((guard: (() => Promise<boolean>) | null) => { beforeLeaveWorkflow.current = guard; }, []);
  const navigateWorkspace = useCallback((next: "studio" | "workflows" | "social" | "editor" | "characters" | "companies" | "apis") => {
    setWorkspace(next);
    const url = new URL(window.location.href);
    if (next === "studio") url.searchParams.delete("workspace");
    else url.searchParams.set("workspace", next);
    if (next !== "workflows") { url.searchParams.delete("workflow"); url.searchParams.delete("run"); }
    window.history.replaceState(null, "", url);
  }, []);
  const selectNavigation = useCallback(async (destination: "studio" | "workflows" | "social" | "editor" | "characters" | "companies" | "usage" | "apis") => {
    if (destination === "usage") { setUsageOpen(true); return; }
    if (destination === workspace) return;
    if (workspace === "workflows" && beforeLeaveWorkflow.current && !await beforeLeaveWorkflow.current()) return;
    navigateWorkspace(destination);
  }, [navigateWorkspace, workspace]);
  const changeMode = useCallback((next: StudioMode) => {
    setMode(next);
    const url = new URL(window.location.href);
    if (next === "carousel" || next === "logo" || next === "audio") url.searchParams.set("mode", next);
    else { url.searchParams.delete("mode"); url.searchParams.delete("carousel"); }
    window.history.replaceState(null, "", url);
  }, []);
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
      const requestedWorkspace = new URLSearchParams(window.location.search).get("workspace");
      if (requestedWorkspace === "workflows" || requestedWorkspace === "social" || requestedWorkspace === "editor" || requestedWorkspace === "characters" || requestedWorkspace === "companies" || requestedWorkspace === "apis") setWorkspace(requestedWorkspace);
      const requestedMode = new URLSearchParams(window.location.search).get("mode");
      if (requestedMode === "carousel" || requestedMode === "logo" || requestedMode === "audio") setMode(requestedMode);
      void checkSession();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [checkSession]);

  useEffect(() => {
    const openSocial = () => {
      void selectNavigation("social");
    };
    window.addEventListener("open-higgsfield:open-social", openSocial);
    return () => window.removeEventListener("open-higgsfield:open-social", openSocial);
  }, [selectNavigation]);

  useEffect(() => {
    const openCharacters = () => { void selectNavigation("characters"); };
    window.addEventListener("open-higgsfield:open-characters", openCharacters);
    return () => window.removeEventListener("open-higgsfield:open-characters", openCharacters);
  }, [selectNavigation]);

  useEffect(() => {
    const openCompanies = () => { void selectNavigation("companies"); };
    window.addEventListener("open-higgsfield:open-companies", openCompanies);
    return () => window.removeEventListener("open-higgsfield:open-companies", openCompanies);
  }, [selectNavigation]);

  useEffect(() => {
    const openConnections = () => { void selectNavigation("apis"); };
    window.addEventListener("open-higgsfield:open-connections", openConnections);
    return () => window.removeEventListener("open-higgsfield:open-connections", openConnections);
  }, [selectNavigation]);

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

  if (!authenticated) return <main className="grid min-h-screen place-items-center bg-black p-4 text-white">{authenticated === null ? <p>Comprobando acceso…</p> : <AdminAccess onReady={() => setAuthenticated(true)} />}</main>;

  return (
    <div className="relative min-h-screen bg-black">
      {workspace === "workflows" ? <WorkflowStudio onBack={() => navigateWorkspace("studio")} registerBeforeLeave={registerWorkflowGuard} /> :
        workspace === "social" ? <SocialStudio onBack={() => navigateWorkspace("studio")} /> :
        workspace === "characters" ? <CharacterStudio onBack={() => navigateWorkspace("studio")} /> :
        workspace === "companies" ? <CompanyLibrary onBack={() => navigateWorkspace("studio")} /> :
        workspace === "editor" ? <ImageEditingStudio onBack={() => navigateWorkspace("studio")} /> :
        workspace === "apis" ? <AdminConnectionsPanel onBack={() => navigateWorkspace("studio")} /> :
          <div className="relative h-screen overflow-hidden">
            {mode === "audio" ? <AudioStudio onModeChange={changeMode} /> : <>
              {mode === "logo" ? <LogoResults /> : mode === "carousel" ? <CarouselResults /> : <ResultsGrid mode={mode} />}
              <CommandBar mode={mode} onModeChange={changeMode} />
            </>}
          </div>}
      <StudioNavigation workspace={workspace} onSelect={(destination) => { void selectNavigation(destination); }} />
      <UsagePanel open={usageOpen} onOpenChange={setUsageOpen} />
    </div>
  );
}
