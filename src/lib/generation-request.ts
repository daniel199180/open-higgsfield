import "server-only";
import crypto from "node:crypto";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { atomicJson, readJson, SECURITY_DIR, withSecurityLock } from "./security-store";
import { authorizeRequest, limitRequest, readLimitedBody, securityError } from "./api-security";

interface Entry { fingerprint: string; at: number; status?: number; body?: unknown }
const file = path.join(SECURITY_DIR, "generation-requests.json");
export async function generationEndpoint(req: NextRequest, handler: (req: NextRequest) => Promise<NextResponse>) {
    try {
        const denied = await authorizeRequest(req) || await limitRequest("generations", 10);
        if (denied) return denied;
        const bytes = await readLimitedBody(req, 32 * 1024 * 1024);
        const fingerprint = crypto.createHash("sha256").update(req.nextUrl.pathname).update(bytes).digest("hex");
        const supplied = req.headers.get("idempotency-key");
        if (supplied && !/^[a-zA-Z0-9_-]{16,100}$/.test(supplied)) throw new Error("ERR_INVALID_BODY");
        const key = crypto.createHash("sha256").update(supplied || fingerprint).digest("hex");
        const existing = await withSecurityLock("generation", async () => {
            const entries = await readJson<Record<string, Entry>>(file) ?? {};
            for (const id of Object.keys(entries)) if (entries[id].at < Date.now() - 24 * 60 * 60 * 1000) delete entries[id];
            if (entries[key]) return entries[key];
            entries[key] = { fingerprint, at: Date.now() };
            await atomicJson(file, entries);
            return undefined;
        });
        if (existing) {
            if (existing.fingerprint !== fingerprint || !existing.status) return NextResponse.json({ error: "Esta solicitud ya está en curso o su resultado es incierto. Revisa el historial antes de generar otra vez." }, { status: 409 });
            return NextResponse.json(existing.body, { status: existing.status });
        }
        let response: NextResponse;
        try {
            response = await handler(new NextRequest(req.url, { method: "POST", headers: req.headers, body: Buffer.from(bytes) }));
        } catch { response = NextResponse.json({ error: "No se pudo completar la generación. Revisa el historial antes de reintentar." }, { status: 500 }); }
        const body = await response.clone().json();
        await withSecurityLock("generation", async () => {
            const entries = await readJson<Record<string, Entry>>(file) ?? {};
            entries[key] = { fingerprint, at: Date.now(), status: response.status, body };
            await atomicJson(file, entries);
        });
        return response;
    } catch (error) { return securityError(error); }
}
