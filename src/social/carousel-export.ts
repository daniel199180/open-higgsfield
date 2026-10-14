import "server-only";
import fs from "node:fs/promises";
import sharp from "sharp";
import { getTask, initStore } from "@/lib/task-store";
import type { SocialProject } from "./types";

export function carouselDimensions(ratio: string): { width: number; height: number } {
    const match = /^(\d{1,2}):(\d{1,2})$/.exec(ratio);
    if (!match) throw new Error("Formato de carrusel inválido.");
    const width = 1080;
    const height = Math.round(width * Number(match[2]) / Number(match[1]));
    if (!Number.isFinite(height) || height < 320 || height > 4096) throw new Error("La proporción del carrusel excede el tamaño de exportación permitido.");
    return { width, height };
}

export async function finishedCarouselImages(project: SocialProject): Promise<Array<{ name: string; jpeg: Buffer }>> {
    if (!project.slides?.length) throw new Error("No hay diapositivas en este carrusel.");
    await initStore();
    const { width, height } = carouselDimensions(project.aspectRatio ?? "");
    const images: Array<{ name: string; jpeg: Buffer }> = [];
    for (const [index, slide] of project.slides.entries()) {
        const taskId = slide.taskIds.at(-1);
        const task = taskId ? getTask(taskId) : undefined;
        if (!task || task.media_type !== "image" || task.status !== "COMPLETED") throw new Error(`La diapositiva ${index + 1} todavía no está terminada.`);
        const path = task.result_paths?.[0];
        const dataUrl = task.result_urls?.[0];
        const data = path ? await fs.readFile(path).catch(() => null) : null;
        const encoded = !data && dataUrl?.match(/^data:image\/(?:jpeg|png|webp|avif);base64,([\s\S]+)$/);
        const input = data ?? (encoded ? Buffer.from(encoded[1], "base64") : null);
        if (!input) throw new Error(`No se encontró la imagen de la diapositiva ${index + 1}.`);
        // Contain avoids losing text or subjects if a provider ignores the requested ratio.
        const jpeg = await sharp(input).rotate().resize(width, height, { fit: "contain", background: "#ffffff" }).flatten({ background: "#ffffff" }).toColourspace("srgb").jpeg({ quality: 92 }).toBuffer();
        images.push({ name: `pagina-${String(index + 1).padStart(2, "0")}.jpg`, jpeg });
    }
    return images;
}

function crc32(bytes: Buffer): number {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

export function imagesZip(files: Array<{ name: string; jpeg: Buffer }>): Buffer {
    const locals: Buffer[] = [], directory: Buffer[] = [];
    let offset = 0;
    for (const { name, jpeg } of files) {
        const filename = Buffer.from(name, "utf8");
        const checksum = crc32(jpeg);
        const local = Buffer.alloc(30 + filename.length);
        local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
        local.writeUInt32LE(checksum, 14); local.writeUInt32LE(jpeg.length, 18); local.writeUInt32LE(jpeg.length, 22);
        local.writeUInt16LE(filename.length, 26); filename.copy(local, 30);
        locals.push(local, jpeg);
        const central = Buffer.alloc(46 + filename.length);
        central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
        central.writeUInt32LE(checksum, 16); central.writeUInt32LE(jpeg.length, 20); central.writeUInt32LE(jpeg.length, 24);
        central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42); filename.copy(central, 46);
        directory.push(central);
        offset += local.length + jpeg.length;
    }
    const directoryLength = directory.reduce((sum, part) => sum + part.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(directoryLength, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, ...directory, end]);
}

export function imagesPdf(images: Array<{ jpeg: Buffer }>, width: number, height: number): Buffer {
    const objects: Buffer[] = [];
    const pageIds = images.map((_, index) => 3 + index * 3);
    objects.push(Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"));
    objects.push(Buffer.from(`<< /Type /Pages /Count ${images.length} /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] >>`));
    for (const [index, image] of images.entries()) {
        const pageId = pageIds[index];
        objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im${index + 1} ${pageId + 2} 0 R >> >> /Contents ${pageId + 1} 0 R >>`));
        const commands = Buffer.from(`q ${width} 0 0 ${height} 0 0 cm /Im${index + 1} Do Q`);
        objects.push(Buffer.concat([Buffer.from(`<< /Length ${commands.length} >>\nstream\n`), commands, Buffer.from("\nendstream")]));
        objects.push(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.jpeg.length} >>\nstream\n`), image.jpeg, Buffer.from("\nendstream")]));
    }
    const output: Buffer[] = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "binary")];
    const offsets = [0];
    let size = output[0].length;
    for (const [index, object] of objects.entries()) {
        offsets.push(size);
        const item = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n")]);
        output.push(item); size += item.length;
    }
    const xrefOffset = size;
    output.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`));
    return Buffer.concat(output);
}
