import { NextRequest, NextResponse } from "next/server";
import { authorizeRequest, limitRequest, readLimitedBody } from "@/lib/api-security";
import { saveAsset } from "@/workflows/assets";
import { WorkflowError } from "@/workflows/types";
import { workflowError } from "@/workflows/http";

export const runtime = "nodejs";
export async function POST(req: NextRequest) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    const limited = await limitRequest("workflow-upload", 12); if (limited) return limited;
    try {
        if (!/^image\/(png|jpeg|webp|avif)$/.test(req.headers.get("content-type") ?? "")) throw new WorkflowError("Sube una imagen PNG, JPEG, WebP o AVIF.");
        const asset = await saveAsset(Buffer.from(await readLimitedBody(req, 20 * 1024 * 1024)), "image");
        return NextResponse.json({ asset }, { status: 201 });
    } catch (error) { return workflowError(error); }
}
