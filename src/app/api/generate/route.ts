import { requireAdminRequest } from "@/lib/api-security";
import { generationEndpoint } from "@/lib/generation-request";
import { NextRequest, NextResponse } from "next/server";
import { getVideoAdapter } from "@/models/adapters/video";
import { findCapability } from "@/providers/catalog";
import { submitGeneration } from "@/lib/generation-service";
import { requireCompany } from "@/library/server";
import { WorkflowError } from "@/workflows/types";
import { processImageUpload, processFileUpload, resolveUrl } from "@/lib/media-upload";
import { publicErrorMessage } from "@/lib/public-error";
import type { CanonicalParams, CanonicalMediaInputs } from "@/models/canonical";
import { workflowStore } from "@/workflows/store";
import { readAsset } from "@/workflows/assets";
import type { Character } from "@/social/types";
import { characterIdentityPrompt, characterSnapshot } from "@/social/characters";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  return generationEndpoint(req, generate);
}
async function generate(req: NextRequest) {
    const denied = await requireAdminRequest(); if (denied) return denied;
  const form = await req.formData();
  let companyId: string | undefined;
  try { companyId = await requireCompany(String(form.get("company_id") ?? "") || undefined); }
  catch (error) { return NextResponse.json({ error: error instanceof WorkflowError ? error.message : "Carpeta inválida." }, { status: error instanceof WorkflowError ? error.status : 400 }); }

  // ── Parse canonical params from FormData ─────────────────────────────────
  const modelId = String(form.get("model_id") ?? "").trim();
  const caps = await findCapability("video", modelId);
  if (!caps) {
    return NextResponse.json({ error: `ERR_UNKNOWN_MODEL: ${modelId}` }, { status: 400 });
  }
  const adapter = (caps.provider ?? "freepik") === "freepik" ? getVideoAdapter(modelId) : undefined;
  if ((caps.provider ?? "freepik") === "freepik" && !adapter) {
    return NextResponse.json({ error: `ERR_NO_ADAPTER: ${modelId}` }, { status: 400 });
  }

  const settingsRaw = String(form.get("settings") ?? "{}");
  let settings: Record<string, unknown> = {};
  try { settings = JSON.parse(settingsRaw); } catch { }

  let prompt = String(form.get("prompt") ?? "").trim();
  let character: Character | undefined;
  if (form.has("character_id")) {
    const id = String(form.get("character_id") ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Identificador de personaje inválido." }, { status: 400 });
    character = await workflowStore().read<Character>(`character:${id}`);
    if (!character || character.archivedAt) return NextResponse.json({ error: "El personaje ya no está disponible." }, { status: 404 });
    if (!caps.elements) {
      const slot = caps.media_slots.find(item => item.kind === "image" && !form.has(`file_${item.id}`) && !form.has(`url_${item.id}`));
      if (!slot) return NextResponse.json({ error: "Este modelo no dispone de una entrada libre para el personaje. Elige otro modelo o quita la imagen que ocupa esa entrada." }, { status: 400 });
      const { asset, data } = await readAsset(character.coverAssetId);
      form.append(`file_${slot.id}`, new File([new Uint8Array(data)], "character-cover.png", { type: asset.mime }));
    }
    prompt = [prompt, characterIdentityPrompt(characterSnapshot(character))].filter(Boolean).join("\n\n");
  }
  if (caps.prompt_required && !prompt) {
    return NextResponse.json({ error: "ERR_PROMPT_REQUIRED" }, { status: 400 });
  }
  const promptMax = caps.prompt_max ?? 2500;
  if (prompt && prompt.length > promptMax) {
    return NextResponse.json({ error: "ERR_PROMPT_TOO_LONG" }, { status: 400 });
  }

  // Build canonical params from settings
  const fieldValues = (settings.fieldValues as Record<string, unknown>) ?? {};
  const canonicalParams: CanonicalParams = {
    model_id: modelId,
    prompt,
    negative_prompt: caps.negative_prompt ? String(settings.negativePrompt ?? "").trim() || undefined : undefined,
    duration: caps.duration ? String(settings.duration ?? (caps.duration as { default?: string }).default ?? "") : undefined,
    aspect_ratio: caps.aspect_ratio ? String(settings.aspectRatio ?? "") || undefined : undefined,
    resolution: caps.resolution_variant ? String(form.get("variant_id") ?? (caps.resolution_variant as { default?: string }).default ?? "") || undefined : undefined,
    size: String(settings.size ?? "") || undefined,
    cfg_scale: caps.cfg_scale ? Number(settings.cfgScale ?? 0.5) : undefined,
    seed: (() => { const s = parseInt(String(settings.seed ?? "-1"), 10); return !isNaN(s) && s !== -1 ? s : undefined; })(),
    style: caps.style ? String(settings.style ?? "") || undefined : undefined,
    expand_prompt: caps.prompt_expansion ? Boolean(settings.expandPrompt) : undefined,
    shot_type: caps.shot_type ? String(settings.shotType ?? "") || undefined : undefined,
    field_values: fieldValues,
  };

  // ── Validate params against capabilities ─────────────────────────────────
  const validationErrors = adapter?.validate(modelId, canonicalParams, caps) ?? [];
  if (validationErrors.length > 0) {
    return NextResponse.json({ error: validationErrors[0] }, { status: 400 });
  }

  // ── Process media uploads ────────────────────────────────────────────────
  const images: Record<string, string> = {};
  let videoUrl: string | undefined;
  let audioUrl: string | undefined;

  for (const slot of caps.media_slots) {
    const file = form.get(`file_${slot.id}`) as File | null;
    let url = String(form.get(`url_${slot.id}`) ?? "").trim();

    if (file && file.size > 0) {
      try {
        const buf = Buffer.from(await file.arrayBuffer());
        if (slot.kind === "image") {
          const result = await processImageUpload(buf);
          url = result.remoteUrl;
        } else {
          const mimeType = file.type || (slot.kind === "video" ? "video/mp4" : "application/octet-stream");
          const result = await processFileUpload(buf, file.name, mimeType);
          url = result.remoteUrl;
        }
      } catch {
        return NextResponse.json({ error: "No se pudo procesar el archivo de referencia." }, { status: 400 });
      }
    } else if (url) {
      try {
        const resolved = await resolveUrl(url);
        url = resolved.remoteUrl;
      } catch {
        return NextResponse.json({ error: "La URL de referencia no es válida o no está disponible." }, { status: 400 });
      }
    }

    if (url) {
      if (slot.kind === "video") videoUrl = url;
      else if (slot.kind === "audio") audioUrl = url;
      else images[slot.id] = url;
    } else if (slot.required) {
      return NextResponse.json({ error: `Missing required attachment: ${slot.label}` }, { status: 400 });
    }
  }

  // ── Handle elements ──────────────────────────────────────────────────────
  const elementsPayload: Array<{ frontal_image_url?: string; reference_image_urls?: string[] }> = [];
  if (caps.elements) {
    if (character) {
      try {
        const urls = await Promise.all(character.referenceAssetIds.map(async id => {
          const { data } = await readAsset(id);
          return (await processImageUpload(data)).remoteUrl;
        }));
        elementsPayload.push({ frontal_image_url: urls[0], reference_image_urls: urls.slice(1) });
      } catch { return NextResponse.json({ error: "No se pudieron preparar las referencias del personaje." }, { status: 400 }); }
    }
    const elemCount = parseInt(String(form.get("elem_count") ?? "0"), 10);
    for (let i = 0; i < elemCount; i++) {
      const frontalFile = form.get(`file_elem_${i}_frontal`) as File | null;
      let frontalUrl = String(form.get(`url_elem_${i}_frontal`) ?? "").trim();

      if (frontalFile && frontalFile.size > 0) {
        const buf = Buffer.from(await frontalFile.arrayBuffer());
        const result = await processImageUpload(buf);
        frontalUrl = result.remoteUrl;
      } else if (frontalUrl.startsWith("/api/uploaded/")) {
        try { frontalUrl = (await resolveUrl(frontalUrl)).remoteUrl; } catch { frontalUrl = ""; }
      }

      const refCount = parseInt(String(form.get(`elem_${i}_ref_count`) ?? "0"), 10);
      const refUrls: string[] = [];
      for (let j = 0; j < refCount; j++) {
        const refFile = form.get(`file_elem_${i}_ref_${j}`) as File | null;
        let refUrl = String(form.get(`url_elem_${i}_ref_${j}`) ?? "").trim();
        if (refFile && refFile.size > 0) {
          const buf = Buffer.from(await refFile.arrayBuffer());
          const result = await processImageUpload(buf);
          refUrl = result.remoteUrl;
        } else if (refUrl.startsWith("/api/uploaded/")) {
          try { refUrl = (await resolveUrl(refUrl)).remoteUrl; } catch { refUrl = ""; }
        }
        if (refUrl) refUrls.push(refUrl);
      }

      const elem: { frontal_image_url?: string; reference_image_urls?: string[] } = {};
      if (frontalUrl) elem.frontal_image_url = frontalUrl;
      if (refUrls.length > 0) elem.reference_image_urls = refUrls;
      if (frontalUrl || refUrls.length > 0) elementsPayload.push(elem);
    }
  }

  const media: CanonicalMediaInputs = {
    images: Object.keys(images).length > 0 ? images : undefined,
    video: videoUrl,
    audio: audioUrl,
    elements: elementsPayload.length > 0 ? elementsPayload : undefined,
  };

  // ── Submit through the selected provider ─────────────────────────────────
  try {
    const taskId = await submitGeneration({
      mediaType: "video",
      companyId,
      modelId,
      capabilities: caps,
      params: canonicalParams,
      media,
      reuseState: { settings },
    });
    return NextResponse.json({ task_id: taskId });
  } catch (err) {
    const msg = publicErrorMessage(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
