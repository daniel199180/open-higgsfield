import { NextRequest, NextResponse } from "next/server";
import { authorizeRequest, limitRequest, readLimitedBody, securityError } from "@/lib/api-security";
import { ImageEditInputError, persistImageEditSource } from "@/lib/image-edit-source";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
    const denied = await authorizeRequest(req) || await limitRequest("image-uploads", 20);
    if (denied) return denied;
    try {
        const bytes = await readLimitedBody(req, 21 * 1024 * 1024);
        const input = new Request(req.url, { method: "POST", headers: req.headers, body: Buffer.from(bytes) });
        const form = await input.formData();
        const file = form.get("image");
        if (!(file instanceof File) || file.size > 20 * 1024 * 1024) throw new ImageEditInputError("Sube una imagen de hasta 20 MB.", 413);
        const saved = await persistImageEditSource(Buffer.from(await file.arrayBuffer()));
        return NextResponse.json(saved, { status: 201, headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
        if (error instanceof ImageEditInputError) return NextResponse.json({ error: error.message }, { status: error.status });
        return securityError(error);
    }
}
