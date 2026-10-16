/** Small offline catalogue; the complete catalogue is loaded only when a picker opens. */
export const FALLBACK_GOOGLE_FONTS = ["Inter", "Montserrat", "Roboto", "Open Sans", "Lato", "Poppins", "Manrope", "Space Grotesk", "Playfair Display", "Merriweather", "Lora", "Oswald", "Bebas Neue", "Anton", "DM Sans", "Outfit", "Nunito", "Raleway", "Work Sans", "Rubik", "Figtree", "Source Sans 3", "Noto Sans", "Noto Serif", "Caveat", "Dancing Script", "Pacifico", "Libre Baskerville"];

export function validFontFamily(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= 80 && /^[\p{L}\p{N} .'-]+$/u.test(value);
}

export function googleFontFamilies(metadata: unknown): string[] {
    const rows = (metadata as { familyMetadataList?: unknown[] } | null)?.familyMetadataList;
    if (!Array.isArray(rows)) return [];
    return [...new Set(rows.map(item => (item as { family?: unknown } | null)?.family).filter(validFontFamily))].sort((a, b) => a.localeCompare(b));
}

export function googleFontCssUrl(family: string): string | null {
    if (!validFontFamily(family)) return null;
    // Default style avoids requesting weights that some display families do not support.
    return `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}&display=swap`;
}

export function fontFamilyStyle(family: string): string {
    return validFontFamily(family) ? `${JSON.stringify(family)}, system-ui, sans-serif` : "system-ui, sans-serif";
}
