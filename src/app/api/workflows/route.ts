import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeRequest, limitRequest, readLimitedBody } from "@/lib/api-security";
import { workflowStore } from "@/workflows/store";
import { startRun, saveWorkflow, runAction } from "@/workflows/service";
import { graphSchema, idSchema, publicRun, WorkflowError, type Workflow, type WorkflowRun, type Asset } from "@/workflows/types";
import { workflowError } from "@/workflows/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const commandSchema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("save"), id: z.uuid().optional(), revision: z.number().int().nonnegative().optional(), name: z.string().trim().min(1).max(100), graph: graphSchema }).strict(),
    z.object({ action: z.literal("run"), workflowId: z.uuid(), revision: z.number().int().positive(), key: z.uuid(), targetId: idSchema.optional(), acknowledgeCost: z.literal(true) }).strict(),
    z.object({ action: z.enum(["approve", "cancel", "resume"]), runId: z.uuid(), nodeId: idSchema.optional() }).strict(),
]);

export async function GET(req: NextRequest) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    try {
        const store = workflowStore();
        const [workflows, runs, assets] = await Promise.all([store.list<Workflow>("workflow:"), store.list<WorkflowRun>("run:"), store.list<Asset>("asset:")]);
        return NextResponse.json({
            workflows: workflows.sort((a, b) => b.updatedAt - a.updatedAt),
            runs: runs.sort((a, b) => b.createdAt - a.createdAt).map(({ id, workflowId, name, revision, status, createdAt }) => ({ id, workflowId, name, revision, status, createdAt })),
            assets: assets.sort((a, b) => b.createdAt - a.createdAt).slice(0, 100),
            storage: process.env.WORKFLOWS_DATABASE_URL ? "PostgreSQL" : "SQLite local",
        }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) { return workflowError(error); }
}
export async function POST(req: NextRequest) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    try {
        if (!req.headers.get("content-type")?.startsWith("application/json")) throw new WorkflowError("Envía JSON.");
        const input = commandSchema.parse(JSON.parse(Buffer.from(await readLimitedBody(req, 128 * 1024)).toString("utf8")));
        const limited = await limitRequest(input.action === "run" ? "workflow-start" : "workflow-edit", input.action === "run" ? 6 : 60); if (limited) return limited;
        if (input.action === "save") return NextResponse.json({ workflow: await saveWorkflow(input) });
        if (input.action === "run") return NextResponse.json({ run: publicRun(await startRun(input)) }, { status: 202 });
        return NextResponse.json({ run: publicRun(await runAction(input.runId, input.action, input.nodeId)) });
    } catch (error) { return workflowError(error); }
}
