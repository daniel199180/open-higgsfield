import "server-only";
import sharp from "sharp";
import { DOMImplementation, DOMParser, XMLSerializer, type Node as XmlNode, type Element as XmlElement } from "@xmldom/xmldom";
import { imageTracer } from "imagetracer";
import { WorkflowError } from "@/workflows/types";

const SVG_NS = "http://www.w3.org/2000/svg";
const tags = new Set(["svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "defs", "linearGradient", "radialGradient", "stop", "clipPath", "mask", "text", "tspan"]);
const attributes = new Set(["id", "width", "height", "viewBox", "preserveAspectRatio", "x", "y", "x1", "x2", "y1", "y2", "cx", "cy", "r", "rx", "ry", "d", "points", "transform", "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "opacity", "clip-path", "mask", "offset", "stop-color", "stop-opacity", "gradientUnits", "gradientTransform", "spreadMethod", "font-family", "font-size", "font-weight", "text-anchor", "dominant-baseline", "letter-spacing", "vector-effect"]);

/** Rebuild SVG from allowlisted XML nodes: no script, CSS, links, images or external references. */
export function sanitizeVectorSvg(input: string): Buffer {
    if (!input || Buffer.byteLength(input) > 3 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(input)) throw new WorkflowError("El SVG contiene contenido no permitido.");
    const errors: string[] = [];
    const source = new DOMParser({ onError: (_level, message) => { errors.push(message); } }).parseFromString(input, "image/svg+xml");
    if (errors.length || source.documentElement?.tagName !== "svg") throw new WorkflowError("El proveedor no devolvió un SVG válido.");
    const output = new DOMImplementation().createDocument(SVG_NS, "svg", null);
    const root = output.documentElement;
    let count = 0;
    function copy(from: XmlNode, to: XmlNode) {
        for (let child = from.firstChild; child; child = child.nextSibling) {
            if (++count > 30_000) throw new WorkflowError("El SVG contiene demasiados elementos.");
            if (child.nodeType === 3) {
                if (to.nodeName === "text" || to.nodeName === "tspan") to.appendChild(output.createTextNode((child.nodeValue ?? "").slice(0, 2000)));
                continue;
            }
            if (child.nodeType !== 1 || !tags.has(child.nodeName)) continue;
            const element = child as XmlElement;
            const safe = output.createElementNS(SVG_NS, child.nodeName);
            for (let index = 0; index < element.attributes.length; index++) {
                const attribute = element.attributes.item(index)!;
                const value = attribute.value.trim();
                if (!attributes.has(attribute.name) || value.length > 8192) continue;
                if (/javascript:|data:|https?:|@import|expression\s*\(|[<>]|url\s*\(\s*(?!#[\w-]+\s*\))/i.test(value)) continue;
                safe.setAttribute(attribute.name, value);
            }
            to.appendChild(safe);
            copy(child, safe);
        }
    }
    for (let index = 0; index < source.documentElement.attributes.length; index++) {
        const attribute = source.documentElement.attributes.item(index)!;
        if (attributes.has(attribute.name) && !/[<>]|url\s*\(|javascript:|data:|https?:/i.test(attribute.value) && attribute.value.length < 200) root.setAttribute(attribute.name, attribute.value);
    }
    copy(source.documentElement, root);
    const svg = new XMLSerializer().serializeToString(output);
    if (Buffer.byteLength(svg) > 3 * 1024 * 1024) throw new WorkflowError("El SVG es demasiado grande.");
    return Buffer.from(svg);
}

export async function previewVector(svg: Buffer): Promise<Buffer> {
    try {
        const image = sharp(svg, { density: 144, limitInputPixels: 16_000_000 });
        const metadata = await image.metadata();
        if (!metadata.width || !metadata.height || metadata.width > 4096 || metadata.height > 4096) throw new Error("dimensions");
        return await image.png().toBuffer();
    } catch { throw new WorkflowError("No se pudo crear una vista previa segura del SVG."); }
}

export async function traceLogoImage(input: Buffer, colors: number): Promise<Buffer> {
    const { data, info } = await sharp(input, { limitInputPixels: 12_000_000 }).rotate().resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const svg = imageTracer.imageDataToSVG({ data: new Uint8ClampedArray(data), width: info.width, height: info.height, colorSpace: "srgb" }, {
        numberofcolors: colors, colorsampling: 2, colorquantcycles: 3, ltres: 1, qtres: 1,
        pathomit: 8, viewbox: true, scale: 1, strokewidth: 0, roundcoords: 2,
    });
    return sanitizeVectorSvg(svg);
}
