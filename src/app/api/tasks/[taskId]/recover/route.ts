import { NextRequest, NextResponse } from "next/server";
import { authorizeRequest, limitRequest } from "@/lib/api-security";
import { publicErrorMessage } from "@/lib/public-error";
import { recoverOpenRouterVideoTask, VideoRecoveryError } from "@/lib/recover-video";

export const runtime = "nodejs";

/** Re-poll and download an existing OpenRouter job. Never calls submit/generate. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    const { taskId } = await params;
    if (!/^[a-zA-Z0-9_-]{6,100}$/.test(taskId)) return NextResponse.json({ error: "Tarea inválida." }, { status: 400 });
    const limited = await limitRequest(`recover-video:${taskId}`, 1, 30_000); if (limited) return limited;
    try {
        const downloadUrl = await recoverOpenRouterVideoTask(taskId);
        return NextResponse.json({ ok: true, downloadUrl });
    } catch (error) {
        return error instanceof VideoRecoveryError
            ? NextResponse.json({ error: error.message }, { status: error.status })
            : NextResponse.json({ error: publicErrorMessage(error, "ERR_VIDEO_RECOVERY_FAILED") }, { status: 502 });
    }
}
