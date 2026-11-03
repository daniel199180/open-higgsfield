import type { BrandPaletteColor, BrandSystem, BrandTypography } from "./types";

export const MAX_BRAND_LOGOS = 8;
export const MAX_BRAND_REFERENCES = 6;
export const MAX_BRAND_PALETTE_COLORS = 24;
export const MAX_BRAND_TYPOGRAPHIES = 20;
export const DEFAULT_FONT_WEIGHTS = { heading: 700, subheading: 600, body: 400, secondaryBody: 400 } as const;

export type BrandMentionKind = "texto" | "color" | "imagen" | "logo";
export interface BrandMentionOption {
    token: string;
    label: string;
    detail: string;
    kind: BrandMentionKind;
    instruction: string;
}

/** Whitelist editable fields: persisted timestamps are not accepted by the API. */
export function brandSaveInput(brand: Omit<BrandSystem, "id" | "createdAt" | "updatedAt"> & { id?: string }) {
    const { id, name, primaryColor, secondaryColor, accentColor, headingFont, headingFontWeight, headingFontItalic, subheadingFont, subheadingFontWeight, subheadingFontItalic, bodyFont, bodyFontWeight, bodyFontItalic, secondaryBodyFont, secondaryBodyFontWeight, secondaryBodyFontItalic, paletteColors, additionalTypographies, voice, visualRules, negativePrompt, references, logoAssetId, logoAssetIds, logoVectorAssetId } = brand;
    return { id, name, primaryColor, secondaryColor, accentColor, headingFont, headingFontWeight, headingFontItalic, subheadingFont, subheadingFontWeight, subheadingFontItalic, bodyFont, bodyFontWeight, bodyFontItalic, secondaryBodyFont, secondaryBodyFontWeight, secondaryBodyFontItalic, paletteColors, additionalTypographies, voice, visualRules, negativePrompt, references, logoAssetId, logoAssetIds, logoVectorAssetId };
}

/** Older brands inherit their existing heading/body families without a migration. */
export function brandTypography(brand: Pick<BrandSystem, "headingFont" | "subheadingFont" | "bodyFont" | "secondaryBodyFont">) {
    return { headingFont: brand.headingFont, subheadingFont: brand.subheadingFont || brand.headingFont,
        bodyFont: brand.bodyFont, secondaryBodyFont: brand.secondaryBodyFont || brand.bodyFont };
}

/** Returns the legacy core palette plus any user-defined swatches. */
export function brandPalette(brand: Pick<BrandSystem, "primaryColor" | "secondaryColor" | "accentColor" | "paletteColors">): BrandPaletteColor[] {
    return [
        { id: "primary", name: "Principal", color: brand.primaryColor },
        { id: "secondary", name: "Secundario", color: brand.secondaryColor },
        { id: "accent", name: "Acento", color: brand.accentColor },
        ...(brand.paletteColors ?? []),
    ];
}

/** Returns all typography roles with safe weights for legacy brands. */
export function brandTypographyEntries(brand: Pick<BrandSystem, "headingFont" | "headingFontWeight" | "headingFontItalic" | "subheadingFont" | "subheadingFontWeight" | "subheadingFontItalic" | "bodyFont" | "bodyFontWeight" | "bodyFontItalic" | "secondaryBodyFont" | "secondaryBodyFontWeight" | "secondaryBodyFontItalic" | "additionalTypographies">): BrandTypography[] {
    const fonts = brandTypography(brand);
    return [
        { id: "heading", name: "Título principal", family: fonts.headingFont, weight: brand.headingFontWeight ?? DEFAULT_FONT_WEIGHTS.heading, italic: brand.headingFontItalic ?? false },
        { id: "subheading", name: "Título secundario", family: fonts.subheadingFont, weight: brand.subheadingFontWeight ?? DEFAULT_FONT_WEIGHTS.subheading, italic: brand.subheadingFontItalic ?? false },
        { id: "body", name: "Texto 1 · Cuerpo principal", family: fonts.bodyFont, weight: brand.bodyFontWeight ?? DEFAULT_FONT_WEIGHTS.body, italic: brand.bodyFontItalic ?? false },
        { id: "secondary-body", name: "Texto 2 · Apoyos y notas", family: fonts.secondaryBodyFont, weight: brand.secondaryBodyFontWeight ?? DEFAULT_FONT_WEIGHTS.secondaryBody, italic: brand.secondaryBodyFontItalic ?? false },
        ...(brand.additionalTypographies ?? []),
    ];
}

export function brandPalettePrompt(brand: Pick<BrandSystem, "primaryColor" | "secondaryColor" | "accentColor" | "paletteColors">): string {
    return `Colores de marca: ${brandPalette(brand).map(color => `${color.name} ${color.color}`).join("; ")}.`;
}

export function brandMentionSlug(value: string): string {
    return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "elemento";
}

export function brandMentionCatalog(brand: Pick<BrandSystem, "primaryColor" | "secondaryColor" | "accentColor" | "paletteColors" | "headingFont" | "headingFontWeight" | "headingFontItalic" | "subheadingFont" | "subheadingFontWeight" | "subheadingFontItalic" | "bodyFont" | "bodyFontWeight" | "bodyFontItalic" | "secondaryBodyFont" | "secondaryBodyFontWeight" | "secondaryBodyFontItalic" | "additionalTypographies" | "voice" | "references"> & { logoAssetIds?: string[]; logoAssetId?: string }): BrandMentionOption[] {
    const options: BrandMentionOption[] = [];
    const used = new Set<string>();
    const add = (option: BrandMentionOption) => {
        if (!used.has(option.token)) { used.add(option.token); options.push(option); }
    };
    const typography = brandTypographyEntries(brand);
    if (brand.voice?.trim()) add({ token: "voz-de-marca", label: "Voz de marca", detail: brand.voice.trim(), kind: "texto", instruction: `Usa el tono de marca: ${brand.voice.trim()}.` });
    typography.forEach(entry => add({ token: `texto-${brandMentionSlug(entry.name)}`, label: entry.name, detail: `${entry.family} · peso ${entry.weight}${entry.italic ? " · cursiva" : ""}`, kind: "texto", instruction: `Para ${entry.name.toLowerCase()}, usa la familia ${entry.family} con peso ${entry.weight}${entry.italic ? " y estilo cursivo" : ""}.` }));
    brandPalette(brand).forEach(color => add({ token: `color-${brandMentionSlug(color.name)}`, label: color.name, detail: color.color, kind: "color", instruction: `Usa el color ${color.name} (${color.color}) como se indicó.` }));
    (brand.references ?? []).forEach(reference => add({ token: reference.name, label: reference.name, detail: "Referencia de imagen", kind: "imagen", instruction: `Usa la imagen de referencia @${reference.name} para orientar la composición, fotografía o estilo; no copies textos ni logos salvo que se solicite.` }));
    brandLogoAssetIds(brand).forEach((_, index) => add({ token: `logo-${index + 1}`, label: `Logo ${index + 1}`, detail: "Logo adjunto", kind: "logo", instruction: `Usa el logo adjunto número ${index + 1} sin cambiar su forma, colores ni texto.` }));
    return options;
}

export function brandMentionTokens(brand: Parameters<typeof brandMentionCatalog>[0]): string[] {
    return brandMentionCatalog(brand).map(option => option.token);
}

export function brandMentionPrompt(brand: BrandSystem): string {
    const catalog = new Map(brandMentionCatalog(brand).map(option => [option.token, option]));
    const mentions = [...brand.visualRules.matchAll(/@([a-z][a-z0-9_-]*)/gi)].map(match => match[1].toLowerCase());
    const resolved = [...new Set(mentions)].map(token => catalog.get(token)?.instruction).filter((instruction): instruction is string => Boolean(instruction));
    return resolved.length ? `Menciones específicas usadas en las reglas visuales:\n${resolved.join("\n")}` : "";
}

export function brandTypographyPrompt(brand: BrandSystem): string {
    return `Tipografías: ${brandTypographyEntries(brand).map(font => `${font.name} ${font.family} (peso ${font.weight}${font.italic ? ", cursiva" : ""})`).join("; ")}. Mantén esta jerarquía tipográfica.`;
}

export function brandImageAssetIds(brand: BrandSystem): string[] {
    return [...new Set([...brandLogoAssetIds(brand), ...(brand.references ?? []).map(item => item.assetId)])];
}

/** Include the original single-logo field when reading older design systems. */
export function brandLogoAssetIds(brand: Pick<BrandSystem, "logoAssetId" | "logoAssetIds">): string[] {
    return [...new Set([...(brand.logoAssetIds ?? []), ...(brand.logoAssetId ? [brand.logoAssetId] : [])])];
}

export function brandIdentityPrompt(brand: BrandSystem): string {
    const logoCount = brandLogoAssetIds(brand).length;
    return [
        `Identidad visual de marca: ${brand.name}.`,
        brandPalettePrompt(brand),
        brandTypographyPrompt(brand),
        brand.voice ? `Tono: ${brand.voice}.` : "",
        brand.visualRules ? `Reglas visuales: ${brand.visualRules}.` : "",
        brandMentionPrompt(brand),
        ...(brand.references ?? []).map(item => `@${item.name}: imagen de inspiración adjunta y rotulada @${item.name}. Aplica las reglas que la mencionan; no copies sus textos, logos ni la etiqueta de referencia salvo petición explícita.`),
        brand.negativePrompt?.trim() ? `PROHIBICIONES DE MARCA (aplican a toda la pieza):\n${brand.negativePrompt.trim()}` : "",
        logoCount ? `Usa ${logoCount === 1 ? "el logo adjunto" : `los ${logoCount} logos adjuntos`} como referencias visuales de la marca e incorpóralos en el posteo sin inventar otros ni cambiar sus formas, colores o texto. Si se adjunta una hoja de referencias, no reproduzcas sus divisiones ni márgenes.` : "",
        "Respeta esta identidad de forma coherente. Conserva el idioma y el texto solicitado en el prompt.",
    ].filter(Boolean).join("\n");
}
