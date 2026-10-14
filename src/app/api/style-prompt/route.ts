import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { authorizeRequest, limitRequest } from "@/lib/api-security";
import { getConnectionForProvider } from "@/lib/connection-store";
import { providerFetch } from "@/providers/secure-fetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AnalysisResult = {
    title: string;
    prompt: string;
    negativePrompt: string;
    tags: string[];
    palette: string[];
    mode: "vision" | "local";
};

function hex(value: number): string {
    return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0").toUpperCase();
}

async function localAnalysis(buffer: Buffer): Promise<AnalysisResult> {
    const image = sharp(buffer, { limitInputPixels: 40_000_000 });
    const metadata = await image.metadata();
    const stats = await image.stats();
    const channels = stats.channels;
    const rgb = channels.slice(0, 3).map(channel => channel.mean);
    const average = rgb.reduce((sum, value) => sum + value, 0) / Math.max(1, rgb.length);
    const orientation = (metadata.width ?? 1) > (metadata.height ?? 1) ? "horizontal" : (metadata.width ?? 1) < (metadata.height ?? 1) ? "vertical" : "cuadrada";
    const mood = average < 70 ? "oscura y dramática" : average > 185 ? "luminosa y aireada" : "equilibrada, con contraste medio";
    const dominant = `#${hex(rgb[0] ?? 0)}${hex(rgb[1] ?? 0)}${hex(rgb[2] ?? 0)}`;
    const prompt = [
        "Recrear la imagen de referencia manteniendo su dirección de arte y composición.",
        `Estética ${mood}, formato ${orientation}, proporción visual ${metadata.width ?? "auto"}:${metadata.height ?? "auto"}.`,
        `Paleta principal aproximada ${dominant}; conservar la temperatura de color, el contraste y la relación entre luces y sombras.`,
        "Describir y preservar el sujeto principal, la profundidad, la perspectiva, la textura, el encuadre y el lenguaje fotográfico o ilustrativo de la referencia.",
        "Resultado de alta calidad, detalles limpios, composición intencional y sin elementos aleatorios.",
    ].join(" ");
    return {
        title: "Estilo extraído de la imagen",
        prompt,
        negativePrompt: "deformaciones, texto ilegible, marcas de agua, artefactos, duplicación de sujetos, cambios de paleta, baja resolución",
        tags: [orientation, average < 70 ? "dramático" : average > 185 ? "luminoso" : "equilibrado", "referencia visual"],
        palette: [dominant],
        mode: "local",
    };
}

function parseVisionContent(value: unknown): string {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(item => typeof item === "string" ? item : (item && typeof item === "object" && "text" in item ? String((item as { text?: unknown }).text ?? "") : "")).join(" ");
    return "";
}

async function visionAnalysis(buffer: Buffer): Promise<AnalysisResult | null> {
    const connection = await getConnectionForProvider("openrouter");
    if (!connection?.credentials.apiKey) return null;
    const jpeg = await sharp(buffer, { limitInputPixels: 40_000_000 }).jpeg({ quality: 88 }).toBuffer();
    const model = process.env.OPEN_HIGGSFIELD_STYLE_MODEL || "google/gemini-2.5-flash";
    const response = await providerFetch("openrouter", `${(connection.config.baseUrl || "https://openrouter.ai/api/v1").replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${connection.credentials.apiKey}`, "Content-Type": "application/json", ...(connection.config.httpReferer ? { "HTTP-Referer": connection.config.httpReferer } : {}), ...(connection.config.appTitle ? { "X-OpenRouter-Title": connection.config.appTitle } : {}) },
        body: JSON.stringify({
            model,
            temperature: 0.2,
            messages: [{ role: "user", content: [
                { type: "text", text: "Analiza esta imagen y crea un prompt detallado en español para recrear su estilo visual en otra imagen. Separa sujeto, composición, cámara, iluminación, color, materiales, textura, atmósfera y restricciones. Devuelve SOLO JSON válido con las claves title, prompt, negativePrompt, tags (array de strings) y palette (array de colores hex). No describas una marca registrada ni copies texto visible; describe la dirección de arte." },
                { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}` } },
            ] }],
        }),
    });
    if (!response.ok) return null;
    const data = await response.json().catch(() => null) as { choices?: Array<{ message?: { content?: unknown } }> } | null;
    const content = parseVisionContent(data?.choices?.[0]?.message?.content);
    if (!content) return null;
    try {
        const cleaned = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
        const parsed = JSON.parse(cleaned) as Partial<AnalysisResult>;
        if (typeof parsed.prompt !== "string" || !parsed.prompt.trim()) return null;
        return {
            title: typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim().slice(0, 120) : "Estilo extraído de la imagen",
            prompt: parsed.prompt.trim().slice(0, 12000),
            negativePrompt: typeof parsed.negativePrompt === "string" ? parsed.negativePrompt.trim().slice(0, 4000) : "",
            tags: Array.isArray(parsed.tags) ? parsed.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 20) : [],
            palette: Array.isArray(parsed.palette) ? parsed.palette.filter((color): color is string => typeof color === "string").slice(0, 12) : [],
            mode: "vision",
        };
    } catch { return null; }
}

export async function POST(req: NextRequest) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    const limited = await limitRequest("style-analysis", 12); if (limited) return limited;
    try {
        const form = await req.formData();
        const file = form.get("image");
        if (!(file instanceof File) || file.size === 0 || file.size > 20 * 1024 * 1024) return NextResponse.json({ error: "Selecciona una imagen de hasta 20 MB." }, { status: 400 });
        const buffer = Buffer.from(await file.arrayBuffer());
        const local = await localAnalysis(buffer);
        let result = local;
        try { result = await visionAnalysis(buffer) ?? local; } catch { /* La extracción local mantiene disponible la función sin proveedor. */ }
        return NextResponse.json({ analysis: result });
    } catch (error) {
        return NextResponse.json({ error: error instanceof Error ? error.message : "No se pudo analizar la imagen." }, { status: 400 });
    }
}
