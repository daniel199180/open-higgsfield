import { NextRequest, NextResponse } from "next/server";
import { getStoredConnection, listProviderConnections, upsertProviderConnection, markConnectionTested, type ProviderConnection } from "@/lib/connection-store";
import { authorizeRequest, limitRequest, readJsonBody, securityError } from "@/lib/api-security";
import { connectionSchema, validateConnectionConfig } from "@/lib/connection-validation";
import { recordSecurityEvent } from "@/lib/admin-auth";
import { testProviderConnection } from "@/providers/test-connection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
    try {
        const denied = await authorizeRequest(req); if (denied) return denied;
        return NextResponse.json({ connections: await listProviderConnections() }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) { return securityError(error); }
}
export async function POST(req: NextRequest) {
    try {
        const denied = await authorizeRequest(req) || await limitRequest("connections", 20);
        if (denied) return denied;
        const parsed = connectionSchema.safeParse(await readJsonBody(req));
        if (!parsed.success) throw new Error("ERR_INVALID_BODY");
        const body = parsed.data;
        const stored = body.id ? await getStoredConnection(body.id) : undefined;
        if (body.id && !stored) throw new Error("ERR_CONNECTION_NOT_FOUND");
        if (stored && stored.provider !== body.provider) throw new Error("ERR_CONNECTION_PROVIDER_MISMATCH");
        const config = { ...stored?.config, ...body.config };
        validateConnectionConfig({ ...body, config });
        const credentials = { ...stored?.credentials, ...body.credentials };
        if (!credentials.apiKey) throw new Error("ERR_PROVIDER_API_KEY_REQUIRED");
        if (body.test) {
            const temporary: ProviderConnection = { id: body.id ?? "temporary", provider: body.provider, name: body.name, config, credentials, enabled: true, isDefault: false, createdAt: "", updatedAt: "" };
            try {
                const result = await testProviderConnection(temporary);
                if (body.id) await markConnectionTested(temporary);
                return NextResponse.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
            } catch {
                return NextResponse.json({ error: "El proveedor no confirmó la conexión. Revisa clave, permisos y producto. No se ha ejecutado una generación." }, { status: 422 });
            }
        }
        const connection = await upsertProviderConnection({ ...body, config, credentials });
        await recordSecurityEvent(`connection.saved:${connection.id}`);
        return NextResponse.json({ connection }, { status: body.id ? 200 : 201, headers: { "Cache-Control": "no-store" } });
    } catch (error) { return securityError(error); }
}
