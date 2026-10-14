import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeRequest, limitRequest, readLimitedBody } from "@/lib/api-security";
import type { CompanyFolder } from "@/library/types";
import { workflowStore } from "@/workflows/store";
import { WorkflowError } from "@/workflows/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const command = z.discriminatedUnion("action", [
    z.object({ action: z.literal("create"), name: z.string().trim().min(1).max(80) }).strict(),
    z.object({ action: z.literal("rename"), id: z.uuid(), name: z.string().trim().min(1).max(80) }).strict(),
]);

export async function GET(req: NextRequest) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    try {
        const companies = (await workflowStore().list<CompanyFolder>("company:")).sort((a, b) => a.name.localeCompare(b.name, "es"));
        return NextResponse.json({ companies }, { headers: { "Cache-Control": "no-store" } });
    } catch { return NextResponse.json({ error: "No se pudieron cargar las empresas." }, { status: 500 }); }
}

export async function POST(req: NextRequest) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    const limited = await limitRequest("companies", 60); if (limited) return limited;
    try {
        if (!req.headers.get("content-type")?.startsWith("application/json")) throw new WorkflowError("Envía JSON.", 400);
        const input = command.parse(JSON.parse(Buffer.from(await readLimitedBody(req, 4096)).toString("utf8")));
        const company = await workflowStore().transaction(docs => {
            const now = Date.now();
            const previous = input.action === "rename" ? docs.get(`company:${input.id}`) as CompanyFolder | undefined : undefined;
            if (input.action === "rename" && !previous) throw new WorkflowError("No se encontró la empresa.", 404);
            if (input.action === "create" && [...docs.keys()].filter(key => key.startsWith("company:")).length >= 500) throw new WorkflowError("Alcanzaste el límite de empresas.", 409);
            if ([...docs.entries()].some(([key, value]) => key.startsWith("company:") && (value as CompanyFolder).name.toLocaleLowerCase("es") === input.name.toLocaleLowerCase("es") && (value as CompanyFolder).id !== previous?.id)) throw new WorkflowError("Ya existe una empresa con ese nombre.", 409);
            const next: CompanyFolder = { id: previous?.id ?? crypto.randomUUID(), name: input.name, createdAt: previous?.createdAt ?? now, updatedAt: now };
            docs.set(`company:${next.id}`, next);
            return next;
        });
        return NextResponse.json({ company }, { status: input.action === "create" ? 201 : 200 });
    } catch (error) {
        if (error instanceof z.ZodError || error instanceof SyntaxError) return NextResponse.json({ error: "Revisa el nombre de la empresa." }, { status: 400 });
        return NextResponse.json({ error: error instanceof WorkflowError ? error.message : "No se pudo guardar la empresa." }, { status: error instanceof WorkflowError ? error.status : 500 });
    }
}
