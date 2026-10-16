import { NextRequest, NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/api-security";
import { FALLBACK_GOOGLE_FONTS, googleFontFamilies } from "@/lib/google-fonts";

let cache: { families: string[]; fallback: boolean; until: number } | undefined;
let pending: Promise<NonNullable<typeof cache>> | undefined;

async function catalogue() {
    if (cache && cache.until > Date.now()) return cache;
    if (!pending) pending = (async () => {
        try {
            // Same public metadata catalogue used by the image editor; fixed URL, no user-supplied host.
            const response = await fetch("https://fonts.google.com/metadata/fonts", { signal: AbortSignal.timeout(5000), next: { revalidate: 86400 } });
            if (!response.ok) throw new Error("Catalogue unavailable");
            const families = googleFontFamilies(await response.json());
            if (!families.length) throw new Error("Empty catalogue");
            cache = { families, fallback: false, until: Date.now() + 86400000 };
        } catch {
            cache = { families: cache?.families ?? FALLBACK_GOOGLE_FONTS, fallback: true, until: Date.now() + 60000 };
        }
        return cache;
    })().finally(() => { pending = undefined; });
    return pending;
}

export async function GET(req: NextRequest) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    const { families, fallback } = await catalogue();
    return NextResponse.json({ families, fallback }, { headers: { "Cache-Control": `private, max-age=${fallback ? 60 : 3600}` } });
}
