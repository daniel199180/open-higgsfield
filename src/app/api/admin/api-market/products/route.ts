import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeRequest, limitRequest, readJsonBody, securityError } from "@/lib/api-security";
import { getStoredConnection } from "@/lib/connection-store";
import { apiMarketSubscriptions } from "@/providers/api-market-subscriptions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({ id: z.string().uuid().optional(), apiKey: z.string().trim().min(1).max(4096).regex(/^[\x21-\x7e]+$/).optional() }).strict();

export async function POST(req: NextRequest) {
    try {
        const denied = await authorizeRequest(req) || await limitRequest("api-market-discovery", 6);
        if (denied) return denied;
        const parsed = requestSchema.safeParse(await readJsonBody(req));
        if (!parsed.success) throw new Error("ERR_INVALID_BODY");
        const stored = parsed.data.id ? await getStoredConnection(parsed.data.id) : undefined;
        if (parsed.data.id && (!stored || stored.provider !== "api-market")) throw new Error("ERR_CONNECTION_NOT_FOUND");
        const apiKey = parsed.data.apiKey || stored?.credentials.apiKey;
        if (!apiKey) throw new Error("ERR_PROVIDER_API_KEY_REQUIRED");
        const products = await apiMarketSubscriptions(apiKey);
        return NextResponse.json({ products }, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) { return securityError(error); }
}
