import { NextRequest, NextResponse } from "next/server";
import { authorizeRequest, readLimitedBody, securityError } from "@/lib/api-security";
import { ImageEditInputError, persistImageEditSource, taskImageForEdit } from "@/lib/image-edit-source";
import { getTask, saveTasks } from "@/lib/task-store";

export const runtime = "nodejs";
/** A local, non-billable rendered source. Never changes the original or calls a provider. */
export async function POST(req: NextRequest) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    try {
        const sourceTaskId = req.nextUrl.searchParams.get("taskId") ?? "";
        const index = Number(req.nextUrl.searchParams.get("index"));
        const parent = await taskImageForEdit(sourceTaskId, index);
        const bytes = Buffer.from(await readLimitedBody(req, 20 * 1024 * 1024));
        const result = await persistImageEditSource(bytes, "Composición del editor");
        const task = getTask(result.taskId)!;
        task.company_id = getTask(sourceTaskId)?.company_id;
        task.reuse_state = { editor_internal: true, edit_root_task_id: parent.rootTaskId, edit_root_index: parent.rootIndex, edit_parent_task_id: sourceTaskId, edit_parent_index: index, edit_mode: "editor-snapshot" };
        await saveTasks();
        return NextResponse.json(result, { status: 201, headers: { "Cache-Control": "private, no-store" } });
    } catch (error) { return error instanceof ImageEditInputError ? NextResponse.json({ error: error.message }, { status: error.status }) : securityError(error); }
}
