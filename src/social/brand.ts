import type { BrandSystem } from "./types";

export const MAX_BRAND_LOGOS = 8;

/** Include the original single-logo field when reading older design systems. */
export function brandLogoAssetIds(brand: Pick<BrandSystem, "logoAssetId" | "logoAssetIds">): string[] {
    return [...new Set([...(brand.logoAssetIds ?? []), ...(brand.logoAssetId ? [brand.logoAssetId] : [])])];
}

export function brandIdentityPrompt(brand: BrandSystem): string {
    const logoCount = brandLogoAssetIds(brand).length;
    return [
        `Identidad visual de marca: ${brand.name}.`,
        `Colores: principal ${brand.primaryColor}; secundario ${brand.secondaryColor}; acento ${brand.accentColor}.`,
        `Tipografías: títulos ${brand.headingFont}; cuerpo ${brand.bodyFont}.`,
        brand.voice ? `Tono: ${brand.voice}.` : "",
        brand.visualRules ? `Reglas visuales: ${brand.visualRules}.` : "",
        logoCount ? `Usa ${logoCount === 1 ? "el logo adjunto" : `los ${logoCount} logos adjuntos`} como referencias visuales de la marca e incorpóralos en el posteo sin inventar otros ni cambiar sus formas, colores o texto. Si se adjunta una hoja de referencias, no reproduzcas sus divisiones ni márgenes.` : "",
        "Respeta esta identidad de forma coherente. Conserva el idioma y el texto solicitado en el prompt.",
    ].filter(Boolean).join("\n");
}
