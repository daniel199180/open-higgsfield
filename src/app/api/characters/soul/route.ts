import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeRequest, limitRequest, readLimitedBody } from "@/lib/api-security";
import { getConnectionForProvider } from "@/lib/connection-store";
import { providerFetch } from "@/providers/secure-fetch";
import { readAsset } from "@/workflows/assets";
import { uploadToTmpfiles } from "@/lib/upload";
import { workflowStore } from "@/workflows/store";
import { WorkflowError } from "@/workflows/types";
import type { Character } from "@/social/types";

export const runtime = "nodejs";
const schema = z.object({ action: z.enum(["train", "refresh", "delete"]), characterId: z.uuid() }).strict();
type SoulResponse = { id?: string; status?: string };

export async function POST(req: NextRequest) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    const limited = await limitRequest("character-soul", 12); if (limited) return limited;
    try {
        if (!req.headers.get("content-type")?.startsWith("application/json")) throw new WorkflowError("Envía JSON.", 400);
        const input = schema.parse(JSON.parse(Buffer.from(await readLimitedBody(req, 2048)).toString("utf8")));
        const store = workflowStore();
        const character = await store.read<Character>(`character:${input.characterId}`);
        if (!character || character.archivedAt) throw new WorkflowError("No se encontró el personaje.", 404);
        const connection = await getConnectionForProvider("higgsfield", character.soulConnectionId);
        if (!connection?.credentials.apiKey) throw new WorkflowError("Conecta tu cuenta de Higgsfield antes de entrenar Soul ID.", 400);
        const headers = { Authorization: `Key ${connection.credentials.apiKey}`, "Content-Type": "application/json" };
        let result: SoulResponse;
        if (input.action === "train") {
            if (character.soulId && character.soulStatus !== "failed") throw new WorkflowError("Este personaje ya tiene un Soul ID. Actualiza su estado o cambia las referencias.", 409);
            const inputImages = await Promise.all(character.referenceAssetIds.map(async id => {
                const { asset, data } = await readAsset(id);
                if (asset.kind !== "image") throw new WorkflowError("Una foto del personaje ya no está disponible.", 400);
                return { type: "image_url", image_url: await uploadToTmpfiles(data, `${id}.png`, asset.mime) };
            }));
            const response = await providerFetch("higgsfield", "https://api.higgsfield.ai/v1/custom-references", { method: "POST", headers, body: JSON.stringify({ name: character.name, model_version: "v2", input_images: inputImages }) });
            if (!response.ok) throw new WorkflowError(`Higgsfield rechazó el entrenamiento (${response.status}).`, 502);
            result = await response.json() as SoulResponse;
            if (!result.id || !/^[0-9a-f-]{36}$/i.test(result.id)) throw new WorkflowError("Higgsfield no devolvió el identificador de Soul ID.", 502);
        } else {
            if (!character.soulId) throw new WorkflowError("Este personaje no tiene un Soul ID.", 400);
            const response = await providerFetch("higgsfield", `https://api.higgsfield.ai/v1/custom-references/${character.soulId}`, { method: input.action === "delete" ? "DELETE" : "GET", headers });
            if (!response.ok) throw new WorkflowError(`No se pudo consultar Soul ID (${response.status}).`, 502);
            result = input.action === "delete" ? {} : await response.json() as SoulResponse;
        }
        const updated = await store.transaction(docs => {
            const current = docs.get(`character:${character.id}`) as Character | undefined;
            if (!current || current.archivedAt || current.version !== character.version) throw new WorkflowError("El personaje cambió durante la operación. Recarga la ficha.", 409);
            const status = ["completed", "failed", "queued", "in_progress"].includes(result.status ?? "") ? result.status as Character["soulStatus"] : "queued";
            const next: Character = { ...current, soulId: input.action === "delete" ? undefined : result.id ?? current.soulId,
                soulConnectionId: input.action === "delete" ? undefined : connection.id,
                soulStatus: input.action === "delete" ? undefined : status, updatedAt: Date.now() };
            docs.set(`character:${next.id}`, next);
            return next;
        });
        return NextResponse.json({ character: updated }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
        if (error instanceof z.ZodError || error instanceof SyntaxError) return NextResponse.json({ error: "Solicitud inválida." }, { status: 400 });
        return NextResponse.json({ error: error instanceof WorkflowError ? error.message : "No se pudo completar la operación con Soul ID." }, { status: error instanceof WorkflowError ? error.status : 500 });
    }
}
