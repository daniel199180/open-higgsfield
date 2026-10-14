import { z } from "zod";
import type { BrandSystem } from "./types";

export const logoCommand = z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("trace"), brandId: z.uuid().optional(), companyId: z.uuid().optional(), sourceAssetId: z.uuid(), colors: z.number().int().min(2).max(24).default(8) }).strict(),
    z.object({ mode: z.enum(["create", "redraw"]), brandId: z.uuid().optional(), companyId: z.uuid().optional(), modelId: z.string().min(1).max(120), prompt: z.string().trim().min(10).max(2000), count: z.number().int().min(1).max(4), sourceAssetId: z.uuid().optional() }).strict(),
]);

export function buildLogoPrompt(input: { mode: "create" | "redraw"; prompt: string }, brand?: BrandSystem): string {
    return [
        input.prompt,
        brand ? `Brand: ${brand.name}. Palette: ${brand.primaryColor}, ${brand.secondaryColor}, ${brand.accentColor}. Visual rules: ${brand.visualRules}.` : "",
        "Create a clean, scalable vector logo with legible shapes and no photographic textures.",
        input.mode === "redraw" ? "Reinterpret the attached logo as vector art; preserve its recognizable identity, but do not claim exact tracing." : "",
    ].filter(Boolean).join("\n");
}
