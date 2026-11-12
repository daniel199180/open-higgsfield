"use client";

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { CommandBar } from "@/components/command-bar/CommandBar";
import { ResultsGrid } from "@/components/tasks/ResultsGrid";
import type { StudioMode } from "@/components/studio/StudioModePill";
import { mergeRuntimeCatalog } from "@/lib/runtime-catalog";
import { AdminAccess } from "./AdminAccess";
import { StudioNavigation } from "./StudioNavigation";
import { UsagePanel } from "./UsagePanel";

const WorkflowStudio = lazy(() => import("@/components/workflows/WorkflowStudio").then(module => ({ default: module.WorkflowStudio })));
const SocialStudio = lazy(() => import("@/components/social/SocialStudio").then(module => ({ default: module.SocialStudio })));
const CarouselResults = lazy(() => import("@/components/social/CarouselResults").then(module => ({ default: module.CarouselResults })));
const LogoResults = lazy(() => import("@/components/studio/LogoResults").then(module => ({ default: module.LogoResults })));
const AudioStudio = lazy(() => import("@/components/studio/AudioStudio").then(module => ({ default: module.AudioStudio })));
const ImageEditingStudio = lazy(() => import("@/components/studio/ImageEditingStudio").then(module => ({ default: module.ImageEditingStudio })));
const CharacterStudio = lazy(() => import("@/components/characters/CharacterStudio").then(module => ({ default: module.CharacterStudio })));
const CompanyLibrary = lazy(() => import("@/components/studio/CompanyLibrary").then(module => ({ default: module.CompanyLibrary })));
const PromptLibraryStudio = lazy(() => import("@/components/prompts/PromptLibraryStudio").then(module => ({ default: module.PromptLibraryStudio })));
const AdminConnectionsPanel = lazy(() => import("@/components/studio/AdminConnectionsPanel").then(module => ({ default: module.AdminConnectionsPanel })));
const TextChatStudio = lazy(() => import("./TextChatStudio").then(module => ({ default: module.TextChatStudio })));
const McpServersPanel = lazy(() => import("./McpServersPanel").then(module => ({ default: module.McpServersPanel })));

export function StudioShell({ initialAuthenticated, initialAdminConfigured }: { initialAuthenticated: boolean; initialAdminConfigured: boolean }) {
  const [mode, setMode] = useState<StudioMode>("image");
  const [usageOpen, setUsageOpen] = useState(false);
  const [workspace, setWorkspace] = useState<"studio" | "chat" | "workflows" | "social" | "editor" | "characters" | "companies" | "prompts" | "apis" | "mcps">("studio");
  const [authenticated, setAuthenticated] = useState(initialAuthenticated);
  const [adminConfigured, setAdminConfigured] = useState(initialAdminConfigured);
  const beforeLeaveWorkflow = useRef<(() => Promise<boolean>) | null>(null);
  const beforeLeaveEditor = useRef<(() => Promise<boolean>) | null>(null);
  const registerEditorGuard = useCallback((guard: (() => Promise<boolean>) | null) => { beforeLeaveEditor.current = guard; }, []);
  const registerWorkflowGuard = useCallback((guard: (() => Promise<boolean>) | null) => { beforeLeaveWorkflow.current = guard; }, []);
  const navigateWorkspace = useCallback((next: "studio" | "chat" | "workflows" | "social" | "editor" | "characters" | "companies" | "prompts" | "apis" | "mcps") => {
    window.scrollTo(0, 0);
    setWorkspace(next);
    const url = new URL(window.location.href);
    if (next === "studio") url.searchParams.delete("workspace");
    else url.searchParams.set("workspace", next);
    if (next !== "workflows") { url.searchParams.delete("workflow"); url.searchParams.delete("run"); }
    window.history.replaceState(null, "", url);
  }, []);
  const selectNavigation = useCallback(async (destination: "studio" | "chat" | "workflows" | "social" | "editor" | "characters" | "companies" | "prompts" | "usage" | "apis" | "mcps") => {
    if (destination === "usage") { setUsageOpen(true); return; }
    if (destination === workspace) return;
    if (workspace === "workflows" && beforeLeaveWorkflow.current && !await beforeLeaveWorkflow.current()) return;
    if (workspace === "editor" && beforeLeaveEditor.current && !await beforeLeaveEditor.current()) return;
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
      setAdminConfigured(data.configured === true);
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
      if (requestedWorkspace === "chat" || requestedWorkspace === "workflows" || requestedWorkspace === "social" || requestedWorkspace === "editor" || requestedWorkspace === "characters" || requestedWorkspace === "companies" || requestedWorkspace === "prompts" || requestedWorkspace === "apis" || requestedWorkspace === "mcps") setWorkspace(requestedWorkspace);
      const requestedMode = new URLSearchParams(window.location.search).get("mode");
      if (requestedMode === "carousel" || requestedMode === "logo" || requestedMode === "audio") setMode(requestedMode);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

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
    const openPrompt = (event: Event) => {
      const prompt = (event as CustomEvent<{ prompt?: string }>).detail?.prompt;
      if (!prompt) return;
      navigateWorkspace("studio");
      window.setTimeout(() => window.dispatchEvent(new CustomEvent("open-higgsfield:prompt-selected", { detail: { prompt } })), 0);
    };
    window.addEventListener("open-higgsfield:use-prompt", openPrompt);
    return () => window.removeEventListener("open-higgsfield:use-prompt", openPrompt);
  }, [navigateWorkspace]);

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

  if (!authenticated) return <main className="grid min-h-screen place-items-center bg-black p-4 text-white"><AdminAccess initialConfigured={adminConfigured} onReady={() => setAuthenticated(true)} /></main>;

  const viewportWorkspace = workspace === "studio" || workspace === "chat" || workspace === "workflows" || workspace === "social" || workspace === "editor" || workspace === "apis" || workspace === "mcps";

  return (
    <div className={viewportWorkspace ? "relative h-dvh overflow-hidden bg-black" : "relative min-h-dvh bg-black"}>
      <Suspense fallback={<main className="grid h-dvh place-items-center bg-black text-white"><p>Cargando espacio…</p></main>}>
        {workspace === "chat" ? <TextChatStudio /> : workspace === "workflows" ? <WorkflowStudio onBack={() => navigateWorkspace("studio")} registerBeforeLeave={registerWorkflowGuard} /> :
          workspace === "social" ? <SocialStudio onBack={() => navigateWorkspace("studio")} /> :
          workspace === "characters" ? <CharacterStudio onBack={() => navigateWorkspace("studio")} /> :
          workspace === "companies" ? <CompanyLibrary onBack={() => navigateWorkspace("studio")} /> :
          workspace === "prompts" ? <PromptLibraryStudio onBack={() => navigateWorkspace("studio")} /> :
          workspace === "editor" ? <ImageEditingStudio onBack={() => navigateWorkspace("studio")} registerBeforeLeave={registerEditorGuard} /> :
          workspace === "apis" ? <AdminConnectionsPanel onBack={() => navigateWorkspace("studio")} /> :
          workspace === "mcps" ? <McpServersPanel onBack={() => navigateWorkspace("studio")} /> :
            <div className="relative h-dvh overflow-hidden">
              {mode === "audio" ? <AudioStudio onModeChange={changeMode} /> : <>
                {mode === "logo" ? <LogoResults /> : mode === "carousel" ? <CarouselResults /> : <ResultsGrid mode={mode} />}
                <CommandBar mode={mode} onModeChange={changeMode} />
              </>}
            </div>}
      </Suspense>
      <StudioNavigation workspace={workspace} onSelect={(destination) => { void selectNavigation(destination); }} />
      <UsagePanel open={usageOpen} onOpenChange={setUsageOpen} />
    </div>
  );
}
