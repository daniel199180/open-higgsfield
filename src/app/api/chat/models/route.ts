import { NextRequest, NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/api-security";
import { listTextModels } from "@/chat/provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    try {
        return NextResponse.json({ models: await listTextModels() }, { headers: { "Cache-Control": "private, no-store" } });
    } catch {
        return NextResponse.json({ models: [], error: "No se pudieron cargar los modelos de texto." }, { status: 502 });
    }
}
