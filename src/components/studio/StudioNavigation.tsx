"use client";

import { useEffect, useRef, useState } from "react";
import { Bot, CircleDollarSign, Folder, House, Images, Menu, Palette, Settings2, UserRound, WandSparkles, Workflow, X } from "lucide-react";

type Workspace = "studio" | "chat" | "workflows" | "social" | "editor" | "characters" | "companies" | "prompts" | "apis";
type Destination = Workspace | "usage";

export function StudioNavigation({ workspace, onSelect }: { workspace: Workspace; onSelect: (destination: Destination) => void }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setOpen(false); return; }
      if (event.key !== "Tab") return;
      const focusable = Array.from(drawerRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      if (!document.querySelector('[role="dialog"][aria-modal="true"]')) trigger?.focus();
    };
  }, [open]);

  const select = (destination: Destination) => {
    setOpen(false);
    onSelect(destination);
  };
  const items = [
    { id: "studio" as const, label: "Inicio", description: "Imagen, video, carruseles y logos", icon: House },
    { id: "chat" as const, label: "Chat IA", description: "Modelos de texto, sesiones e historial", icon: Bot },
    { id: "editor" as const, label: "Editar imágenes", description: "Galería, retoques e historial", icon: Images },
    { id: "companies" as const, label: "Empresas", description: "Carpetas y biblioteca de generaciones", icon: Folder },
    { id: "usage" as const, label: "Consumo", description: "Tokens, solicitudes y dólares", icon: CircleDollarSign },
    { id: "apis" as const, label: "APIs", description: "Conexiones y credenciales", icon: Settings2 },
    { id: "workflows" as const, label: "Workflows", description: "Procesos creativos", icon: Workflow },
    { id: "social" as const, label: "Sistemas de diseño", description: "Marcas y proyectos guardados", icon: Palette },
    { id: "characters" as const, label: "Personajes", description: "Identidades visuales reutilizables", icon: UserRound },
    { id: "prompts" as const, label: "Prompt Lab", description: "Extraer estilos y guardar prompts", icon: WandSparkles },
  ];

  return <>
    <button ref={triggerRef} type="button" aria-label="Abrir menú" aria-expanded={open} aria-controls="studio-navigation" onClick={() => setOpen(true)} className="fixed left-4 top-4 z-40 grid h-11 w-11 place-items-center rounded-2xl border border-white/15 bg-[#111111]/95 text-[#ff4d4d] shadow-xl backdrop-blur transition hover:border-[#ff4d4d]/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ff4d4d]">
      <Menu size={20} aria-hidden="true" />
    </button>
    {open && <>
      <button type="button" aria-label="Cerrar menú" onClick={() => setOpen(false)} className="fixed inset-0 z-60 bg-black/70 backdrop-blur-[3px]" />
      <aside ref={drawerRef} id="studio-navigation" role="dialog" aria-modal="true" aria-label="Menú principal" className="fixed inset-y-0 left-0 z-70 flex w-[min(340px,calc(100vw-36px))] flex-col overflow-y-auto border-r border-white/10 bg-[#101010] p-5 text-white shadow-[25px_0_80px_rgba(0,0,0,.55)]">
        <div className="mb-8 flex items-start justify-between gap-3 border-b border-white/10 pb-5">
          <div><p className="text-[10px] font-extrabold uppercase tracking-[.16em] text-[#ff4d4d]">Open-Higgsfield</p><h2 className="mt-2 text-xl font-semibold">Menú</h2></div>
          <button ref={closeRef} type="button" onClick={() => setOpen(false)} aria-label="Cerrar menú" className="grid h-9 w-9 place-items-center rounded-xl border border-white/10 text-white/65 transition hover:text-white focus-visible:outline-2 focus-visible:outline-[#ff4d4d]"><X size={18} /></button>
        </div>
        <nav aria-label="Navegación principal" className="space-y-2">
          {items.map(({ id, label, description, icon: Icon }) => {
            const active = id === workspace;
            return <button key={id} type="button" onClick={() => select(id)} aria-current={active ? "page" : undefined} className={`flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left transition focus-visible:outline-2 focus-visible:outline-[#ff4d4d] ${active ? "border-[#ff4d4d]/35 bg-[#ff4d4d]/10 text-[#ff4d4d]" : "border-transparent text-white/75 hover:border-white/10 hover:bg-white/5 hover:text-white"}`}>
              <Icon size={19} className="shrink-0" aria-hidden="true" />
              <span className="min-w-0"><span className="block text-sm font-semibold">{label}</span><span className="mt-0.5 block text-[11px] text-white/45">{description}</span></span>
            </button>;
          })}
        </nav>
        <p className="mt-auto border-t border-white/10 pt-5 text-xs leading-relaxed text-white/40">Elige una sección. El menú se cerrará automáticamente.</p>
      </aside>
    </>}
  </>;
}
