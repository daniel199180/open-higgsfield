import type { EditorSnapshot, EditorTextLayer } from "./editor-document";
import type { ImageLayerSet } from "@/types";

export const editorImageUrl = (taskId: string, index: number) => `/api/download/${encodeURIComponent(taskId)}?index=${index}`;
async function loadImage(url: string): Promise<HTMLImageElement> {
    const image = new Image(); image.src = url;
    await image.decode(); return image;
}
export interface TextBounds { id: string; left: number; top: number; width: number; height: number }
const fontStyles = new Map<string, Promise<void>>();
async function loadFont(text: EditorTextLayer) {
    const family = text.fontFamily.replace(/['"\\]/g, "");
    const key = `editor-font-${family.replace(/[^a-z0-9]/gi, "-")}`;
    if (!fontStyles.has(key)) fontStyles.set(key, (async () => {
        if (document.getElementById(key)) return;
        const link = document.createElement("link"); link.id = key; link.rel = "stylesheet";
        link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}:wght@300;400;500;600;700;800;900&display=swap`;
        await new Promise<void>(resolve => { const timer = setTimeout(resolve, 5000); link.onload = link.onerror = () => { clearTimeout(timer); resolve(); }; document.head.appendChild(link); });
    })());
    await fontStyles.get(key);
    await document.fonts.load(`${text.fontWeight} ${text.fontSize}px '${family}'`).catch(() => undefined);
}
/** Single renderer for preview, downloads and AI input. Guides and selection UI are never included. */
export async function renderEditorSnapshot(snapshot: EditorSnapshot, layerSet?: ImageLayerSet) {
    const source = await loadImage(editorImageUrl(snapshot.taskId, snapshot.index));
    const width = layerSet && snapshot.layerTaskId ? layerSet.canvasWidth ?? layerSet.sourceWidth : source.naturalWidth;
    const height = layerSet && snapshot.layerTaskId ? layerSet.canvasHeight ?? layerSet.sourceHeight : source.naturalHeight;
    if (!width || !height || width * height > 40_000_000) throw new Error("El lienzo supera el tamaño permitido.");
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d"); if (!context) throw new Error("No se pudo preparar el lienzo.");
    if (snapshot.layerTaskId) {
        if (!layerSet) throw new Error("Esperando las capas guardadas…");
        const order = [...snapshot.layerOrder, ...layerSet.layers.slice().sort((a, b) => a.zIndex - b.zIndex).map(item => item.index).filter(index => !snapshot.layerOrder.includes(index))];
        for (const index of order) {
            const layer = layerSet.layers.find(item => item.index === index);
            if (!layer || index === layerSet.referenceIndex || snapshot.deletedLayerIndexes[index] || snapshot.layerVisibility[index] === false) continue;
            const image = await loadImage(editorImageUrl(snapshot.layerTaskId, index));
            const [left, top, right, bottom] = layerSet.version === 2 ? layer.boundingBox.absolute : [0, 0, width, height];
            const transform = snapshot.layerTransforms[index] ?? { x: 0, y: 0, scale: 1 };
            const w = right - left; const h = bottom - top;
            context.drawImage(image, left + transform.x * width / 100 + w * (1 - transform.scale) / 2, top + transform.y * height / 100 + h * (1 - transform.scale) / 2, w * transform.scale, h * transform.scale);
        }
    } else context.drawImage(source, 0, 0);
    const bounds: TextBounds[] = [];
    for (const text of snapshot.textLayers.filter(item => item.visible)) {
        await loadFont(text);
        context.font = `${text.fontWeight} ${text.fontSize}px '${text.fontFamily.replace(/['"\\]/g, "")}', sans-serif`;
        const lines: string[] = [];
        for (const paragraph of text.text.split("\n")) {
            let line = "";
            for (const char of paragraph) { if (line && context.measureText(line + char).width > width * .9) { lines.push(line); line = ""; } line += char; }
            lines.push(line);
        }
        const w = Math.min(width * .9, Math.max(1, ...lines.map(line => context.measureText(line).width)));
        const h = lines.length * text.fontSize * 1.05;
        const left = width * text.x / 100 - w / 2; const top = height * text.y / 100 - h / 2;
        context.fillStyle = text.color; context.textAlign = text.align; context.textBaseline = "top";
        const x = left + (text.align === "center" ? w / 2 : text.align === "right" ? w : 0);
        lines.forEach((line, i) => context.fillText(line, x, top + i * text.fontSize * 1.05, width * .9));
        bounds.push({ id: text.id, left: left / width * 100, top: top / height * 100, width: w / width * 100, height: h / height * 100 });
    }
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("No se pudo exportar la imagen.")), "image/png"));
    return { blob, width, height, bounds };
}
