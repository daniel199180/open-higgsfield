import "server-only";
import sharp from "sharp";
import type { ImageModelCapability } from "@/models/capabilities/image";
import type { MediaSlotCapability } from "@/models/capabilities/types";
import { getEditVariant } from "@/models/capabilities/image-helpers";
import { readAsset } from "@/workflows/assets";
import { publishProviderInput } from "@/lib/provider-input";
import { acceptsInlineImageReference } from "@/lib/image-reference";
import { WorkflowError } from "@/workflows/types";
import { brandLogoAssetIds } from "./brand";
import type { BrandSystem } from "./types";
import type { CharacterSnapshot } from "./types";

function imageSlots(model: ImageModelCapability): MediaSlotCapability[] {
    return [...model.media_slots, ...(getEditVariant(model)?.slots ?? [])]
        .filter(slot => slot.kind === "image");
}

export async function referenceSheet(files: File[]): Promise<File> {
    if (!files.length || files.length > 20) throw new WorkflowError("Hay demasiadas imágenes para reunir en una referencia. Usa un modelo que admita varias imágenes.");
    const columns = Math.min(3, files.length);
    const rows = Math.ceil(files.length / columns);
    const cell = 512;
    const gap = 24;
    const width = columns * cell + (columns + 1) * gap;
    const height = rows * cell + (rows + 1) * gap;
    const composites = await Promise.all(files.map(async (file, index) => ({
        input: await sharp(Buffer.from(await file.arrayBuffer()), { limitInputPixels: 40_000_000 })
            .rotate().resize(cell, cell, { fit: "contain", background: "#808080" }).flatten({ background: "#808080" }).png().toBuffer(),
        left: gap + (index % columns) * (cell + gap),
        top: gap + Math.floor(index / columns) * (cell + gap),
    })));
    const data = await sharp({ create: { width, height, channels: 3, background: "#f5f5f5" } })
        .composite(composites).png().toBuffer();
    return new File([new Uint8Array(data)], "brand-reference-sheet.png", { type: "image/png" });
}

/** Visible labels survive providers which discard upload filenames. Originals stay untouched. */
export async function namedReferenceFile(data: Buffer, name: string): Promise<File> {
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(name)) throw new WorkflowError("Nombre de referencia inválido.");
    const image = await sharp(data, { limitInputPixels: 40_000_000 }).rotate().resize(768, 768, { fit: "inside", withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
    const width = Math.max(400, image.info.width);
    const label = Buffer.from(`<svg width="${width}" height="48"><rect width="100%" height="100%" fill="#222"/><text x="12" y="31" fill="white" font-family="sans-serif" font-size="18">@${name}</text></svg>`);
    const result = await sharp({ create: { width, height: image.info.height + 48, channels: 4, background: "#808080" } }).composite([{ input: image.data, left: 0, top: 48 }, { input: label, left: 0, top: 0 }]).png().toBuffer();
    return new File([new Uint8Array(result)], `reference-${name}.png`, { type: "image/png" });
}

/** Keep all logos, and optionally the source creative, in one provider input. */
export async function referenceSheetValue(assetIds: string[], provider: string, accept?: string, labels: Record<string, string> = {}, providerModelId?: string): Promise<string> {
    const files = await Promise.all(assetIds.map(async (id, index) => {
        const { asset, data } = await readAsset(id);
        if (asset.kind !== "image") throw new WorkflowError(`La referencia visual ${index + 1} ya no está disponible.`);
        if (labels[id]) return namedReferenceFile(data, labels[id]);
        return new File([new Uint8Array(data)], `reference-${index + 1}.png`, { type: asset.mime });
    }));
    const sheet = files.length === 1 ? files[0] : await referenceSheet(files);
    const data = Buffer.from(await sheet.arrayBuffer());
    if (accept === "b64_only") return data.toString("base64");
    if (acceptsInlineImageReference(provider, providerModelId)) return `data:${sheet.type};base64,${data.toString("base64")}`;
    return publishProviderInput(data, sheet.type);
}

/** Add every saved logo before slot processing, including on carousel and format variants. */
export async function attachBrandImageReferences(form: FormData, model: ImageModelCapability, brand?: BrandSystem): Promise<void> {
    if (!brand) return;
    const logoIds = brandLogoAssetIds(brand);
    if (!logoIds.length && !brand.references?.length) return;
    const slots = imageSlots(model);
    if (!slots.length) throw new WorkflowError("El modelo elegido no admite imágenes de referencia. Elige uno que admita los logos del sistema de diseño.");
    const logos = await Promise.all(logoIds.map(async (id, index) => {
        const { asset, data } = await readAsset(id);
        if (asset.kind !== "image") throw new WorkflowError(`El logo ${index + 1} del sistema de diseño ya no está disponible.`);
        return new File([new Uint8Array(data)], `brand-logo-${index + 1}.png`, { type: asset.mime });
    }));
    for (const reference of brand.references ?? []) {
        const { asset, data } = await readAsset(reference.assetId);
        if (asset.kind !== "image") throw new WorkflowError(`La referencia @${reference.name} ya no está disponible.`);
        logos.push(await namedReferenceFile(data, reference.name));
    }

    const multiple = slots.find(slot => slot.multiple);
    if (multiple) {
        if (model.provider?.startsWith("google") && form.getAll(`slot_${multiple.id}`).length + logos.length > 14) throw new WorkflowError("Este modelo admite hasta 14 imágenes de referencia. Reduce los logos o las referencias.");
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
