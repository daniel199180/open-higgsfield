import "server-only";
import sharp from "sharp";
import type { ImageModelCapability } from "@/models/capabilities/image";
import type { MediaSlotCapability } from "@/models/capabilities/types";
import { getEditVariant } from "@/models/capabilities/image-helpers";
import { readAsset } from "@/workflows/assets";
import { uploadToTmpfiles } from "@/lib/upload";
import { WorkflowError } from "@/workflows/types";
import { brandLogoAssetIds } from "./brand";
import type { BrandSystem } from "./types";
import type { CharacterSnapshot } from "./types";

function imageSlots(model: ImageModelCapability): MediaSlotCapability[] {
    return [...model.media_slots, ...(getEditVariant(model)?.slots ?? [])]
        .filter(slot => slot.kind === "image");
}

async function referenceSheet(files: File[]): Promise<File> {
    if (files.length > 12) throw new WorkflowError("Hay demasiadas imágenes para reunir en una referencia. Usa un modelo que admita varias imágenes.");
    const columns = Math.min(3, files.length);
    const rows = Math.ceil(files.length / columns);
    const cell = 512;
    const gap = 24;
    const width = columns * cell + (columns + 1) * gap;
    const height = rows * cell + (rows + 1) * gap;
    const composites = await Promise.all(files.map(async (file, index) => ({
        input: await sharp(Buffer.from(await file.arrayBuffer()), { limitInputPixels: 40_000_000 })
            .rotate().resize(cell, cell, { fit: "contain", background: "#ffffff" }).flatten({ background: "#ffffff" }).jpeg({ quality: 90 }).toBuffer(),
        left: gap + (index % columns) * (cell + gap),
        top: gap + Math.floor(index / columns) * (cell + gap),
    })));
    const data = await sharp({ create: { width, height, channels: 3, background: "#f5f5f5" } })
        .composite(composites).jpeg({ quality: 90 }).toBuffer();
    return new File([new Uint8Array(data)], "brand-reference-sheet.jpg", { type: "image/jpeg" });
}

/** Keep all logos, and optionally the source creative, in one provider input. */
export async function referenceSheetValue(assetIds: string[], provider: string, accept?: string): Promise<string> {
    const files = await Promise.all(assetIds.map(async (id, index) => {
        const { asset, data } = await readAsset(id);
        if (asset.kind !== "image") throw new WorkflowError(`La referencia visual ${index + 1} ya no está disponible.`);
        return new File([new Uint8Array(data)], `reference-${index + 1}.png`, { type: asset.mime });
    }));
    const sheet = await referenceSheet(files);
    const data = Buffer.from(await sheet.arrayBuffer());
    if (accept === "b64_only") return data.toString("base64");
    if (["openrouter", "google-ai-studio", "google-vertex", "vercel-ai-gateway"].includes(provider)) return `data:image/jpeg;base64,${data.toString("base64")}`;
    return uploadToTmpfiles(data, "brand-reference-sheet.jpg", "image/jpeg");
}

/** Add every saved logo before slot processing, including on carousel and format variants. */
export async function attachBrandImageReferences(form: FormData, model: ImageModelCapability, brand?: BrandSystem): Promise<void> {
    if (!brand) return;
    const logoIds = brandLogoAssetIds(brand);
    if (!logoIds.length) return;
    const slots = imageSlots(model);
    if (!slots.length) throw new WorkflowError("El modelo elegido no admite imágenes de referencia. Elige uno que admita los logos del sistema de diseño.");
    const logos = await Promise.all(logoIds.map(async (id, index) => {
        const { asset, data } = await readAsset(id);
        if (asset.kind !== "image") throw new WorkflowError(`El logo ${index + 1} del sistema de diseño ya no está disponible.`);
        return new File([new Uint8Array(data)], `brand-logo-${index + 1}.png`, { type: asset.mime });
    }));

    const multiple = slots.find(slot => slot.multiple);
    if (multiple) {
        for (const logo of logos) form.append(`slot_${multiple.id}`, logo);
        return;
    }

    const overflow: File[] = [];
    for (const logo of logos) {
        const empty = slots.find(slot => !form.getAll(`slot_${slot.id}`).some(value => value instanceof File && value.size > 0));
        if (empty) form.append(`slot_${empty.id}`, logo);
        else overflow.push(logo);
    }
    if (!overflow.length) return;

    const target = slots[0];
    const key = `slot_${target.id}`;
    const existing = form.getAll(key).filter((value): value is File => value instanceof File && value.size > 0);
    form.delete(key);
    form.append(key, await referenceSheet([...existing, ...overflow]));
}

/** Keep character photos separate from logos so the provider can identify their role. */
export async function attachCharacterImageReferences(form: FormData, model: ImageModelCapability, character: CharacterSnapshot): Promise<void> {
    const slots = imageSlots(model);
    if (!slots.length) throw new WorkflowError("Este modelo no admite fotos del personaje. Elige un modelo con imágenes de referencia.", 400);
    const multiple = slots.find(slot => slot.multiple);
    const references = await Promise.all(character.referenceAssetIds.map(async (id, index) => {
        const { asset, data } = await readAsset(id);
        if (asset.kind !== "image") throw new WorkflowError(`La foto ${index + 1} del personaje ya no está disponible.`, 400);
        return new File([new Uint8Array(data)], `character-${index + 1}.png`, { type: asset.mime });
    }));
    if (multiple) {
        const key = `slot_${multiple.id}`;
        const existing = form.getAll(key).filter((item): item is File => item instanceof File && item.size > 0);
        const count = existing.length + references.length;
        if (model.provider?.startsWith("google") && count > 14) throw new WorkflowError("Este modelo admite hasta 14 imágenes entre personaje, logos y otras referencias. Reduce la selección.", 400);
        for (const reference of references) form.append(key, reference);
        return;
    }
    const empty = slots.filter(slot => !form.getAll(`slot_${slot.id}`).some(item => item instanceof File && item.size > 0));
    if (empty.length < references.length) throw new WorkflowError("No hay entradas suficientes para las fotos del personaje y los logos. Elige un modelo con múltiples referencias.", 400);
    references.forEach((reference, index) => form.append(`slot_${empty[index].id}`, reference));
}
