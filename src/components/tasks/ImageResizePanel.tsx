"use client";

/* eslint-disable @next/next/no-img-element -- authenticated local preview */

import { useEffect, useRef, useState } from "react";
import { AlertCircle, Check, Download, Eraser, Loader2, WandSparkles } from "lucide-react";
import { IMAGE_CAPABILITIES_LIST, type ImageModelCapability } from "@/models/capabilities/image";
import { revalidateImageTasks } from "@/hooks/useImageTasks";

interface ImageResizePanelProps {
  sourceTaskId: string;
  sourceIndex: number;
  sourceModelId?: string;
  prompt?: string;
}

function supportedFormats(model: ImageModelCapability): string[] {
  const raw = model.size_ui?.aspect_ratios.map(({ w, h }) => `${w}:${h}`)
    ?? model.custom_fields.find((field) => field.id === "aspect_ratio" && field.type === "select")?.options?.map((option) => {
      const match = option.match(/_(\d+)_(\d+)$/);
      return match ? `${match[1]}:${match[2]}` : option;
    })
    ?? (model.aspect_ratio ? model.aspect_ratio.options?.map(([, value]) => value) : [])
    ?? [];
  return [...new Set(raw.filter((ratio) => /^\d+:\d+$/.test(ratio)))];
}

function cleanSourcePrompt(value: string): string {
  const marker = "\n\nADAPTACIÓN DEL MISMO POST A ";
  const start = value.lastIndexOf(marker);
  return (start >= 0 ? value.slice(0, start) : value).trim();
}

function adaptationPrompt(sourcePrompt: string, ratio: string): string {
  return [
    sourcePrompt,
    `ADAPTACIÓN DEL MISMO POST A ${ratio}. Usa la imagen adjunta como referencia principal. Conserva el mismo contenido, texto visible, personas, producto, colores e identidad visual. Recompón y extiende la escena para el nuevo formato; no estires ni recortes elementos importantes. Mantén márgenes seguros y legibilidad. Genera una sola imagen en ${ratio}.`,
  ].filter(Boolean).join("\n\n");
}

export function ImageResizePanel({ sourceTaskId, sourceIndex, sourceModelId, prompt }: ImageResizePanelProps) {
  const [backgroundModels, setBackgroundModels] = useState<Array<{ id: string; name: string }>>([]);
  const [backgroundModelId, setBackgroundModelId] = useState("");
  const [backgroundMessage, setBackgroundMessage] = useState("");
  const [backgroundResult, setBackgroundResult] = useState("");
  const [backgroundError, setBackgroundError] = useState("");
  const [backgroundBusy, setBackgroundBusy] = useState(false);
  const backgroundInFlight = useRef(false);

  useEffect(() => {
    let active = true;
    fetch("/api/images/remove-background", { cache: "no-store" })
      .then((response) => response.json())
      .then((data: { models?: Array<{ id: string; name: string }>; defaultModelId?: string; message?: string }) => {
        if (!active) return;
        setBackgroundModels(data.models ?? []);
        setBackgroundModelId(data.defaultModelId ?? "");
        setBackgroundMessage(data.message ?? "");
      })
      .catch(() => { if (active) setBackgroundMessage("No se pudo consultar los modelos de OpenRouter."); });
    return () => { active = false; };
  }, []);

  async function removeBackground() {
    if (backgroundInFlight.current || !backgroundModelId) return;
    backgroundInFlight.current = true;
    setBackgroundBusy(true);
    setBackgroundError("");
    try {
      const response = await fetch("/api/images/remove-background", {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ source: { type: "task", taskId: sourceTaskId, index: sourceIndex }, modelId: backgroundModelId }),
      });
      const data = await response.json() as { imageUrl?: string; error?: string };
      if (!response.ok || !data.imageUrl) throw new Error(data.error || "No se pudo quitar el fondo.");
      setBackgroundResult(data.imageUrl);
      await revalidateImageTasks();
    } catch (cause) {
      setBackgroundError(cause instanceof Error ? cause.message : "No se pudo quitar el fondo.");
    } finally { backgroundInFlight.current = false; setBackgroundBusy(false); }
  }

  const compatibleModels = IMAGE_CAPABILITIES_LIST.filter((model) =>
    model.media_slots.some((slot) => slot.kind === "image") && supportedFormats(model).length > 0
  );
  const [modelId, setModelId] = useState(() =>
    compatibleModels.some((model) => model.id === sourceModelId) ? sourceModelId! : compatibleModels[0]?.id ?? ""
  );
  const [formats, setFormats] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const model = compatibleModels.find((item) => item.id === modelId);
  const modelFormats = model ? supportedFormats(model) : [];
  const remaining = formats.filter((format) => !submitted[format]);
  const sourceModelName = IMAGE_CAPABILITIES_LIST.find((item) => item.id === sourceModelId)?.label ?? sourceModelId ?? "No disponible";

  function changeModel(id: string) {
    setModelId(id);
    setFormats([]);
    setSubmitted({});
    setError("");
  }

  function toggleFormat(format: string) {
    if (busy) return;
    setFormats((current) => current.includes(format) ? current.filter((value) => value !== format) : [...current, format]);
    setError("");
  }

  async function resize() {
    if (inFlight.current || !model || !remaining.length) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    const failures: string[] = [];
    try {
      const slot = model.media_slots.find((item) => item.kind === "image" && item.required)
        ?? model.media_slots.find((item) => item.kind === "image");
      if (!slot) throw new Error("Este modelo no admite imágenes de referencia.");
      const sourcePrompt = cleanSourcePrompt(prompt ?? "");
      const prompts = remaining.map((ratio) => [ratio, adaptationPrompt(sourcePrompt, ratio)] as const);
      if (prompts.some(([, text]) => text.length > (model.prompt_max ?? 10000))) {
        throw new Error("El prompt original supera el límite del modelo elegido. Prueba otro modelo.");
      }
      setProgress("Preparando imagen de referencia…");
      const imageResponse = await fetch(`/api/download/${encodeURIComponent(sourceTaskId)}?index=${sourceIndex}`, { cache: "no-store" });
      if (!imageResponse.ok) throw new Error("No se pudo cargar la imagen original.");
      const image = await imageResponse.blob();
      if (!image.type.startsWith("image/") || image.size > 20 * 1024 * 1024) throw new Error("La imagen original no tiene un formato o tamaño válido.");

      for (const [position, [ratio, text]] of prompts.entries()) {
        setProgress(`Enviando ${ratio} (${position + 1}/${prompts.length})…`);
        const body = new FormData();
        body.append("prompt", text);
        body.append("model_id", model.id);
        body.append("size_aspect", ratio);
        body.append("size_resolution", model.size_ui?.default_resolution
          ?? String(model.custom_fields.find((field) => field.id === "resolution")?.default ?? ""));
        body.append("field_values", "{}");
        body.append(`slot_${slot.id}`, image, "imagen-original.png");
        try {
          const response = await fetch("/api/generate-image", {
            method: "POST",
            headers: { "Idempotency-Key": crypto.randomUUID() },
            body,
          });
          const result = await response.json().catch(() => ({})) as { task_id?: string; error?: string };
          if (!response.ok || !result.task_id) throw new Error(result.error || `No se pudo enviar ${ratio}.`);
          setSubmitted((current) => ({ ...current, [ratio]: result.task_id! }));
          await revalidateImageTasks();
        } catch (cause) {
          failures.push(`${ratio}: ${cause instanceof Error ? cause.message : "No se pudo enviar."}`);
        }
      }
      if (failures.length) setError(`Algunos formatos no se enviaron. ${failures.join(" · ")}`);
      else setProgress("Formatos enviados. Puedes seguir el resultado en la galería.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudieron crear las adaptaciones.");
      setProgress("");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 text-white">
      <section>
        <p className="text-[11px] font-bold uppercase tracking-widest text-white/45">Prompt de esta imagen</p>
        <div className="mt-2 max-h-36 overflow-y-auto rounded-xl border border-white/10 bg-white/[.04] p-3 text-sm leading-relaxed whitespace-pre-wrap break-words text-white/80">
          {prompt || "Esta imagen no tiene un prompt guardado."}
        </div>
      </section>

      <section>
        <p className="text-[11px] font-bold uppercase tracking-widest text-white/45">Modelo usado</p>
        <p className="mt-2 rounded-xl border border-white/10 bg-white/[.04] p-3 text-sm font-semibold">{sourceModelName}</p>
      </section>

      <section className="border-t border-white/10 pt-4">
        <div className="flex items-center gap-2 text-[#ff4d4d]"><Eraser className="h-4 w-4" /><h2 className="text-base font-bold">Quitar fondo</h2></div>
        <p className="mt-2 text-xs leading-relaxed text-white/55">Crea una nueva imagen PNG transparente con GPT Image de OpenRouter. La original se conserva; esta edición puede tener costo y conviene revisar los detalles del resultado.</p>
        {backgroundModels.length > 0 ? <>
          <label htmlFor="background-model" className="mt-4 block text-xs font-semibold text-white/75">Modelo de OpenRouter</label>
          <select id="background-model" value={backgroundModelId} disabled={backgroundBusy} onChange={(event) => setBackgroundModelId(event.target.value)} className="mt-2 w-full rounded-xl border border-white/15 bg-[#191919] px-3 py-3 text-sm text-white outline-none focus:border-[#ff4d4d] disabled:opacity-50">
            {backgroundModels.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <button type="button" disabled={backgroundBusy} onClick={() => void removeBackground()} className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-[#c62828] px-4 py-3 text-sm font-bold text-white disabled:opacity-50">
            {backgroundBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eraser className="h-4 w-4" />}{backgroundBusy ? "Quitando fondo…" : "Quitar fondo con GPT"}
          </button>
        </> : <p className="mt-3 text-xs leading-relaxed text-white/50">{backgroundMessage || "Buscando modelos GPT compatibles…"}</p>}
        {backgroundError && <p role="alert" className="mt-3 text-xs leading-relaxed text-red-300">{backgroundError}</p>}
        {backgroundResult && <div className="mt-4 overflow-hidden rounded-xl border border-white/15"><div className="grid min-h-44 place-items-center bg-[linear-gradient(45deg,#242424_25%,transparent_25%,transparent_75%,#242424_75%),linear-gradient(45deg,#242424_25%,transparent_25%,transparent_75%,#242424_75%)] bg-[length:24px_24px] bg-[position:0_0,12px_12px] p-3"><img src={backgroundResult} alt="Imagen con fondo transparente" className="max-h-52 object-contain" /></div><a href={backgroundResult} download="imagen-sin-fondo.png" className="flex items-center justify-center gap-2 border-t border-white/15 px-3 py-2.5 text-xs text-white/80 hover:bg-white/5"><Download className="h-3.5 w-3.5" />Descargar PNG</a></div>}
      </section>

      <section className="border-t border-white/10 pt-4">
        <div className="flex items-center gap-2 text-[#ff4d4d]"><WandSparkles className="h-4 w-4" /><h2 className="text-base font-bold">Adaptar a otros formatos</h2></div>
        <p className="mt-2 text-xs leading-relaxed text-white/55">La imagen abierta será la referencia. Se creará una imagen nueva por cada formato; cada una puede tener coste en la API elegida.</p>

        <label htmlFor="resize-model" className="mt-4 block text-xs font-semibold text-white/75">Modelo para adaptar</label>
        <select
          id="resize-model"
          value={modelId}
          disabled={busy || !compatibleModels.length}
          onChange={(event) => changeModel(event.target.value)}
          className="mt-2 w-full rounded-xl border border-white/15 bg-[#191919] px-3 py-3 text-sm text-white outline-none focus:border-[#ff4d4d] disabled:opacity-50"
        >
          {compatibleModels.length === 0 && <option value="">No hay modelos compatibles</option>}
          {compatibleModels.map((item) => <option key={item.id} value={item.id}>{item.group} · {item.label}</option>)}
        </select>
        <p className="mt-2 text-[11px] text-white/45">Solo aparecen modelos que admiten una imagen de referencia y proporciones definidas.</p>
        {model && !["openrouter", "google-ai-studio", "google-vertex"].includes(model.provider ?? "freepik") && <p className="mt-2 text-[11px] leading-relaxed text-red-200/80">Este proveedor necesita Cloudinary configurado para recibir la imagen de referencia.</p>}

        <p className="mt-4 text-xs font-semibold text-white/75">Formatos de salida</p>
        <div className="mt-2 grid grid-cols-3 gap-2" role="group" aria-label="Formatos de salida">
          {modelFormats.map((format) => {
            const selected = formats.includes(format);
            return <button
              key={format}
              type="button"
              aria-pressed={selected}
              disabled={busy}
              onClick={() => toggleFormat(format)}
              className={`flex min-h-10 items-center justify-center gap-1.5 rounded-xl border px-2 text-sm transition-colors disabled:opacity-50 ${selected ? "border-[#ff4d4d] bg-[#ff4d4d]/10 text-[#ff4d4d]" : "border-white/15 bg-white/[.03] text-white/75 hover:border-white/35"}`}
            >
              {selected && <Check className="h-3.5 w-3.5" />}{format}
            </button>;
          })}
        </div>

        <button
          type="button"
          disabled={busy || remaining.length === 0 || !model}
          onClick={() => void resize()}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-[#c62828] px-4 py-3 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-45"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {busy ? "Enviando formatos…" : remaining.length ? `Generar ${remaining.length} ${remaining.length === 1 ? "formato" : "formatos"}` : formats.length ? "Formatos enviados" : "Elige formatos"}
        </button>
        {progress && <p role="status" className="mt-3 text-xs text-[#ff4d4d]">{progress}</p>}
        {error && <p role="alert" className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-red-300"><AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{error}</p>}
      </section>
    </div>
  );
}
