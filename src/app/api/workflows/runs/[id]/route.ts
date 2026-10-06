import { NextRequest, NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/api-security";
import { workflowStore } from "@/workflows/store";
import { publicRun, type WorkflowRun } from "@/workflows/types";
import { workflowError } from "@/workflows/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    try {
        const { id } = await params;
        const run = await workflowStore().read<WorkflowRun>(`run:${id}`);
        if (!run) return NextResponse.json({ error: "Ejecución no encontrada." }, { status: 404 });
        return NextResponse.json({ run: publicRun(run) }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) { return workflowError(error); }
}
