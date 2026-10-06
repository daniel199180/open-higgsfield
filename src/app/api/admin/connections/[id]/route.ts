import { NextRequest, NextResponse } from "next/server";
import { deleteProviderConnection } from "@/lib/connection-store";
import { authorizeRequest, limitRequest, securityError } from "@/lib/api-security";
import { recordSecurityEvent } from "@/lib/admin-auth";
import { z } from "zod";
export const runtime = "nodejs";
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const denied = await authorizeRequest(req) || await limitRequest("connections", 20); if (denied) return denied;
        const { id } = await params;
        if (!z.string().uuid().safeParse(id).success) throw new Error("ERR_INVALID_BODY");
        await deleteProviderConnection(id);
        await recordSecurityEvent(`connection.deleted:${id}`);
        return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) { return securityError(error); }
}
