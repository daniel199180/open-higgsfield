import { NextRequest, NextResponse } from "next/server";
import { readProviderInput } from "@/lib/provider-input";

export const runtime = "nodejs";

async function serve(req: NextRequest, { params }: { params: Promise<{ filename: string }> }, head: boolean) {
    const { filename } = await params;
    const media = await readProviderInput(filename, req.nextUrl.searchParams.get("expires"), req.nextUrl.searchParams.get("signature"));
    if (!media) return new NextResponse(null, { status: 404, headers: { "Cache-Control": "no-store" } });
    return new NextResponse(head ? null : new Uint8Array(media.data), {
        headers: {
            "Content-Type": media.mimeType,
            "Content-Length": String(media.data.length),
            "Cache-Control": "private, no-store",
            "Content-Disposition": "inline",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
            "X-Robots-Tag": "noindex, nofollow",
        },
    });
}

export async function GET(req: NextRequest, context: { params: Promise<{ filename: string }> }) {
    return serve(req, context, false);
}

export async function HEAD(req: NextRequest, context: { params: Promise<{ filename: string }> }) {
    return serve(req, context, true);
}
