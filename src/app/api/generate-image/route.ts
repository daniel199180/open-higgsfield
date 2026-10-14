import { requireAdminRequest } from "@/lib/api-security";
import { generationEndpoint } from "@/lib/generation-request";
import { toJpeg } from "@/lib/media-upload";
import { NextRequest, NextResponse } from "next/server";
import { getImageAdapter } from "@/models/adapters/image";
import { getImageAspectRatios, requiresImageAspectRatio } from "@/models/capabilities/image-helpers";
import { findCapability } from "@/providers/catalog";
import type { ImageModelCapability } from "@/models/capabilities/image";
import { saveInputLocally } from "@/lib/upload";
import { imageReferenceForProvider } from "@/lib/image-reference";
import { submitGeneration } from "@/lib/generation-service";
import { publicErrorMessage } from "@/lib/public-error";
import type { CanonicalParams, CanonicalMediaInputs } from "@/models/canonical";
import { attachCarouselTask, prepareCarouselSlide } from "@/social/carousel-server";
import { brandIdentityPrompt } from "@/social/brand";
import { attachBrandImageReferences, attachCharacterImageReferences } from "@/social/references";
import { characterIdentityPrompt, characterSnapshot } from "@/social/characters";
import type { BrandSystem, Character, CharacterSnapshot } from "@/social/types";
import { workflowStore } from "@/workflows/store";
import { WorkflowError } from "@/workflows/types";
import { requireCompany } from "@/library/server";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  return generationEndpoint(req, generate);
}
async function generate(req: NextRequest) {
    const denied = await requireAdminRequest(); if (denied) return denied;
  const form = await req.formData();

  // ── Model lookup ──────────────────────────────────────────────────────────
  const modelId = String(form.get("model_id") ?? "").trim();
  const caps = await findCapability("image", modelId);
  if (!caps) {
    return NextResponse.json({ error: `ERR_UNKNOWN_IMAGE_MODEL: ${modelId}` }, { status: 400 });
  }
  const imageCaps = caps as ImageModelCapability;

  const adapter = (caps.provider ?? "freepik") === "freepik" ? getImageAdapter(modelId) : undefined;
  if ((caps.provider ?? "freepik") === "freepik" && !adapter) {
    return NextResponse.json({ error: `ERR_NO_ADAPTER: ${modelId}` }, { status: 400 });
  }

  // ── Build canonical params ────────────────────────────────────────────────
  const carouselProjectId = String(form.get("social_project_id") ?? "");
  const carouselSlideId = String(form.get("social_slide_id") ?? "");
  if (Boolean(carouselProjectId) !== Boolean(carouselSlideId)) return NextResponse.json({ error: "Indica el carrusel y su diapositiva." }, { status: 400 });
  let prompt = String(form.get("prompt") ?? "").trim();
  let brand: BrandSystem | undefined;
  let character: CharacterSnapshot | undefined;
  let companyId: string | undefined;
  if (carouselProjectId) {
    if (!/^[0-9a-f-]{36}$/i.test(carouselProjectId) || !/^[0-9a-f-]{36}$/i.test(carouselSlideId)) return NextResponse.json({ error: "Identificador de carrusel inválido." }, { status: 400 });
    try {
      const slide = await prepareCarouselSlide(carouselProjectId, carouselSlideId, modelId, String(form.get("size_aspect") ?? "").trim(), String(form.get("size_resolution") ?? ""));
      prompt = slide.prompt;
      brand = slide.brand;
      character = slide.character;
      companyId = slide.companyId;
    } catch (error) {
      return NextResponse.json({ error: error instanceof WorkflowError ? error.message : "No se pudo preparar la diapositiva." }, { status: error instanceof WorkflowError ? error.status : 500 });
    }
  } else if (form.has("brand_id")) {
    const brandId = String(form.get("brand_id") ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(brandId)) return NextResponse.json({ error: "Identificador de sistema de diseño inválido." }, { status: 400 });
    brand = await workflowStore().read<BrandSystem>(`brand:${brandId}`);
    if (!brand) return NextResponse.json({ error: "El sistema de diseño ya no está disponible." }, { status: 404 });
    prompt = [prompt, brandIdentityPrompt(brand)].filter(Boolean).join("\n\n");
  }
  if (!carouselProjectId) {
    try { companyId = await requireCompany(String(form.get("company_id") ?? "") || undefined); }
    catch (error) { return NextResponse.json({ error: error instanceof WorkflowError ? error.message : "Carpeta inválida." }, { status: error instanceof WorkflowError ? error.status : 400 }); }
  }
  if (!carouselProjectId && form.has("character_id")) {
    const characterId = String(form.get("character_id") ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(characterId)) return NextResponse.json({ error: "Identificador de personaje inválido." }, { status: 400 });
    const saved = await workflowStore().read<Character>(`character:${characterId}`);
    if (!saved || saved.archivedAt) return NextResponse.json({ error: "El personaje ya no está disponible." }, { status: 404 });
    character = characterSnapshot(saved);
  }
  if (character) prompt = [prompt, characterIdentityPrompt(character)].filter(Boolean).join("\n\n");
  if (caps.prompt_required && !prompt) {
    return NextResponse.json({ error: "ERR_PROMPT_REQUIRED" }, { status: 400 });
  }
  if (prompt.length > (caps.prompt_max ?? 10000)) return NextResponse.json({ error: "ERR_PROMPT_TOO_LONG" }, { status: 400 });

  let fieldValues: Record<string, unknown> = {};
  try { fieldValues = JSON.parse(String(form.get("field_values") ?? "{}")); } catch { }

  const requestedAspect = String(form.get("size_aspect") ?? "").trim();
  const supportedAspects = getImageAspectRatios(imageCaps).map(([value]) => value);
  if (requiresImageAspectRatio(imageCaps) && !requestedAspect) {
    return NextResponse.json({ error: "ERR_IMAGE_ASPECT_RATIO_REQUIRED" }, { status: 400 });
  }
  if (requestedAspect && requiresImageAspectRatio(imageCaps) && !supportedAspects.includes(requestedAspect)) {
    return NextResponse.json({ error: "ERR_INVALID_IMAGE_ASPECT_RATIO" }, { status: 400 });
  }

  const params: CanonicalParams = {
    model_id: modelId,
    prompt,
    aspect_ratio: requestedAspect,
    resolution: String(form.get("size_resolution") ?? imageCaps.size_ui?.default_resolution ?? ""),
    seed: Number.isFinite(Number(fieldValues.seed)) ? Number(fieldValues.seed) : undefined,
    field_values: fieldValues,
  };

  try {
    await attachBrandImageReferences(form, imageCaps, brand);
    if (character) {
      if (caps.provider === "higgsfield" && caps.provider_model_id === "higgsfield-ai/soul/v2/standard" && character.soulId && character.soulStatus === "completed" && character.soulConnectionId === caps.provider_connection_id) {
        fieldValues.custom_reference_id = character.soulId;
        fieldValues.custom_reference_strength = 1;
        params.field_values = fieldValues;
      } else {
        await attachCharacterImageReferences(form, imageCaps, character);
      }
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof WorkflowError ? error.message : "No se pudieron preparar las referencias del sistema de diseño." }, { status: error instanceof WorkflowError ? error.status : 500 });
  }

  // ── Slot processing ───────────────────────────────────────────────────────
  const media: CanonicalMediaInputs = {};
  const slotLocalUrls: Record<string, string[]> = {};

  // Determine active slots — check both base media_slots and edit_variant slots
  const allSlotIds = [
    ...caps.media_slots.map((s) => s.id),
    ...(imageCaps.has_edit_variant ? ["reference_images"] : []),
  ];

  for (const slotId of allSlotIds) {
    const files: File[] = [];
    const formEntries = form.getAll(`slot_${slotId}`);
    for (const entry of formEntries) {
      if (entry instanceof File && entry.size > 0) files.push(entry);
    }
    if (files.length === 0) continue;

    const slot = caps.media_slots.find((s) => s.id === slotId);
    const converted: string[] = [];
    for (const file of files) {
      const buf = await toJpeg(Buffer.from(await file.arrayBuffer()));
      const ext = ".jpg";
      const localUrl = await saveInputLocally(buf, ext);
      slotLocalUrls[slotId] = [...(slotLocalUrls[slotId] ?? []), localUrl];
      const remoteUrl = await imageReferenceForProvider(caps.provider, buf);
      converted.push(remoteUrl);
    }

    media.images = {
      ...media.images,
      [slotId]: (slot?.multiple || (!slot && converted.length > 1))
        ? converted as unknown as string
        : converted[0],
    };
  }

  // Validate required slots
  for (const slot of caps.media_slots) {
    if (slot.required && (!media.images || !media.images[slot.id])) {
      return NextResponse.json({ error: `ERR_SLOT_REQUIRED: ${slot.label}` }, { status: 400 });
    }
  }

  // ── Submit ────────────────────────────────────────────────────────────────
  try {
    const taskId = await submitGeneration({
      mediaType: "image",
      companyId,
      modelId,
      capabilities: caps,
      params,
      media,
      reuseState: { fieldValues, slotLocalUrls },
    });
    if (carouselProjectId) await attachCarouselTask(carouselProjectId, carouselSlideId, taskId);
    return NextResponse.json({ task_id: taskId });
  } catch (err) {
    if (err instanceof WorkflowError) return NextResponse.json({ error: err.message }, { status: err.status });
    const msg = publicErrorMessage(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
