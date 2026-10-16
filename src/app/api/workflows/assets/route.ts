import { NextRequest, NextResponse } from "next/server";
import { authorizeRequest, limitRequest, readLimitedBody } from "@/lib/api-security";
import { saveAsset } from "@/workflows/assets";
import { WorkflowError } from "@/workflows/types";
import { workflowError } from "@/workflows/http";
import { importGalleryImage } from "@/workflows/gallery-import";

export const runtime = "nodejs";
export async function POST(req: NextRequest) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    const limited = await limitRequest("workflow-upload", 12); if (limited) return limited;
    try {
        if (req.headers.get("content-type")?.startsWith("application/json")) {
            const input = JSON.parse(Buffer.from(await readLimitedBody(req, 1024)).toString("utf8")) as { galleryImageId?: unknown };
            if (typeof input.galleryImageId !== "string") throw new WorkflowError("Selecciona una imagen de la galería.");
            return NextResponse.json({ asset: await importGalleryImage(input.galleryImageId) }, { status: 201 });
        }
        if (!/^image\/(png|jpeg|webp|avif)$/.test(req.headers.get("content-type") ?? "")) throw new WorkflowError("Sube una imagen PNG, JPEG, WebP o AVIF.");
        const asset = await saveAsset(Buffer.from(await readLimitedBody(req, 20 * 1024 * 1024)), "image");
        return NextResponse.json({ asset }, { status: 201 });
    } catch (error) { return workflowError(error); }
}
