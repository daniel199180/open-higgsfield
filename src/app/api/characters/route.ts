import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeRequest, limitRequest, readLimitedBody } from "@/lib/api-security";
import { characterSnapshot, MAX_CHARACTER_REFERENCES } from "@/social/characters";
import type { BrandSystem, Character } from "@/social/types";
import { workflowStore } from "@/workflows/store";
import { WorkflowError, type Asset } from "@/workflows/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("save"), character: z.object({
        id: z.uuid().optional(), name: z.string().trim().min(1).max(80),
        description: z.string().trim().min(10).max(1200), visualRules: z.string().trim().max(1000),
        brandId: z.uuid().optional(), referenceAssetIds: z.array(z.uuid()).min(1).max(MAX_CHARACTER_REFERENCES),
        coverAssetId: z.uuid(),
    }).strict() }).strict(),
    z.object({ action: z.literal("archive"), id: z.uuid() }).strict(),
    z.object({ action: z.literal("restore"), id: z.uuid() }).strict(),
]);

export async function GET(req: NextRequest) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    try {
        const all = await workflowStore().list<Character>("character:");
        const characters = all.filter(item => !item.archivedAt).sort((a, b) => b.updatedAt - a.updatedAt);
        const archivedCharacters = all.filter(item => item.archivedAt).sort((a, b) => b.updatedAt - a.updatedAt);
        return NextResponse.json({ characters, archivedCharacters }, { headers: { "Cache-Control": "no-store" } });
    } catch { return NextResponse.json({ error: "No se pudieron cargar los personajes." }, { status: 500 }); }
}

export async function POST(req: NextRequest) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    const limited = await limitRequest("characters", 60); if (limited) return limited;
    try {
        if (!req.headers.get("content-type")?.startsWith("application/json")) throw new WorkflowError("Envía JSON.", 400);
        const input = schema.parse(JSON.parse(Buffer.from(await readLimitedBody(req, 32 * 1024)).toString("utf8")));
        const saved = await workflowStore().transaction(docs => {
            const previous = docs.get(`character:${input.action === "save" ? input.character.id : input.id}`) as Character | undefined;
            if (input.action === "archive" || input.action === "restore") {
                if (!previous || (input.action === "archive" ? Boolean(previous.archivedAt) : !previous.archivedAt)) throw new WorkflowError("No se encontró el personaje.", 404);
                const changed = { ...previous, archivedAt: input.action === "archive" ? Date.now() : undefined, updatedAt: Date.now() };
                docs.set(`character:${previous.id}`, changed);
                return changed;
            }
            if (input.character.id && (!previous || previous.archivedAt)) throw new WorkflowError("No se encontró el personaje.", 404);
            if (!previous && [...docs.keys()].filter(key => key.startsWith("character:")).length >= 200) throw new WorkflowError("Alcanzaste el límite de personajes.", 409);
            const ids = input.character.referenceAssetIds;
            if (new Set(ids).size !== ids.length || !ids.includes(input.character.coverAssetId)) throw new WorkflowError("La portada debe ser una de las referencias del personaje.", 400);
            for (const id of ids) {
                const asset = docs.get(`asset:${id}`) as Asset | undefined;
                if (asset?.kind !== "image") throw new WorkflowError("Una referencia ya no está disponible. Vuelve a subirla.", 400);
            }
            if (input.character.brandId && !(docs.get(`brand:${input.character.brandId}`) as BrandSystem | undefined)) throw new WorkflowError("El sistema de diseño ya no está disponible.", 400);
            const now = Date.now();
            const character: Character = { ...input.character, id: previous?.id ?? crypto.randomUUID(), version: (previous?.version ?? 0) + 1,
                createdAt: previous?.createdAt ?? now, updatedAt: now };
            // A trained identity belongs to the exact reference set used for training.
            if (previous && ids.join(",") === previous.referenceAssetIds.join(",")) {
                Object.assign(character, { soulId: previous.soulId, soulConnectionId: previous.soulConnectionId, soulStatus: previous.soulStatus });
            }
            docs.set(`character:${character.id}`, character);
            return character;
        });
        return NextResponse.json({ character: saved, snapshot: characterSnapshot(saved) });
    } catch (error) {
        if (error instanceof z.ZodError || error instanceof SyntaxError) return NextResponse.json({ error: "Revisa los datos del personaje." }, { status: 400 });
        return NextResponse.json({ error: error instanceof WorkflowError ? error.message : "No se pudo guardar el personaje." }, { status: error instanceof WorkflowError ? error.status : 500 });
    }
}
