import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeRequest, limitRequest, readLimitedBody } from "@/lib/api-security";
import { getImageTasks, getTask, getVideoTasks, initStore, saveTasks } from "@/lib/task-store";
import { requireCompany } from "@/library/server";
import type { CompanyFolder, LibraryKind } from "@/library/types";
import type { SocialProject, LogoResult } from "@/social/types";
import type { AudioResult } from "@/audio/types";
import type { WorkflowRun, Asset, NodeRun } from "@/workflows/types";
import { workflowStore } from "@/workflows/store";
import { WorkflowError } from "@/workflows/types";
import { isLayerTask } from "@/lib/image-layer-task";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const assignment = z.object({ kind: z.enum(["image", "video", "carousel", "logo", "audio", "workflow"]), id: z.string().min(1).max(100), companyId: z.uuid().nullable() }).strict();

function outputAssets(node: NodeRun): string[] {
    return [...(node.value?.assetIds ?? []), ...Object.values(node.angles ?? {}).flatMap(outputAssets), ...Object.values(node.formats ?? {}).flatMap(outputAssets)];
}

export async function GET(req: NextRequest) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    try {
        await initStore();
        const store = workflowStore();
        const [companies, carousels, logos, audios, runs, assets] = await Promise.all([
            store.list<CompanyFolder>("company:"), store.list<SocialProject>("social:"),
            store.list<LogoResult>("logo:"), store.list<AudioResult>("audio:"), store.list<WorkflowRun>("run:"), store.list<Asset>("asset:"),
        ]);
        const runSummaries = runs.map(run => ({ id: run.id, workflowId: run.workflowId, companyId: run.companyId, name: run.name, status: run.status, createdAt: run.createdAt, assetIds: [...new Set(Object.values(run.nodes).flatMap(outputAssets))] }));
        return NextResponse.json({ companies, images: getImageTasks().filter((task) => !isLayerTask(task)), videos: getVideoTasks(), carousels, logos, audios, runs: runSummaries, assets }, { headers: { "Cache-Control": "private, no-store" } });
    } catch { return NextResponse.json({ error: "No se pudo cargar la biblioteca." }, { status: 500 }); }
}

export async function POST(req: NextRequest) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    const limited = await limitRequest("library-assignment", 120); if (limited) return limited;
    try {
        if (!req.headers.get("content-type")?.startsWith("application/json")) throw new WorkflowError("Envía JSON.", 400);
        const input = assignment.parse(JSON.parse(Buffer.from(await readLimitedBody(req, 4096)).toString("utf8")));
        const companyId = await requireCompany(input.companyId ?? undefined);
        if (input.kind === "image" || input.kind === "video") {
            await initStore();
            const task = getTask(input.id);
            if (!task || task.media_type !== input.kind) throw new WorkflowError("No se encontró la generación.", 404);
            task.company_id = companyId;
            await saveTasks();
        } else {
            const prefix: Record<Exclude<LibraryKind, "image" | "video">, string> = { carousel: "social", logo: "logo", audio: "audio", workflow: "run" };
            const key = `${prefix[input.kind]}:${input.id}`;
            const updated = await workflowStore().transaction(docs => {
                const previous = docs.get(key) as SocialProject | LogoResult | AudioResult | WorkflowRun | undefined;
                if (!previous || input.kind === "carousel" && !("format" in previous && previous.format === "carousel")) throw new WorkflowError("No se encontró la generación.", 404);
                const next = { ...previous, companyId };
                docs.set(key, next);
                return next;
            });
            if (input.kind === "carousel") {
                await initStore();
                const project = updated as SocialProject;
                for (const id of project.slides?.flatMap(slide => slide.taskIds) ?? project.taskIds) {
                    const task = getTask(id);
                    if (task?.media_type === "image") task.company_id = companyId;
                }
                await saveTasks();
            }
        }
        return NextResponse.json({ ok: true });
    } catch (error) {
        if (error instanceof z.ZodError || error instanceof SyntaxError) return NextResponse.json({ error: "Revisa la generación y la empresa." }, { status: 400 });
        return NextResponse.json({ error: error instanceof WorkflowError ? error.message : "No se pudo mover la generación." }, { status: error instanceof WorkflowError ? error.status : 500 });
    }
}
