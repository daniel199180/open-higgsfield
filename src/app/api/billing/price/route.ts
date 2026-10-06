import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeRequest, limitRequest, readJsonBody, securityError } from "@/lib/api-security";
import { imageQuote } from "@/billing/pricing";
import { billingStore } from "@/billing/store";
import { priceKey } from "@/billing/usage";
import { getConnectionForProvider } from "@/lib/connection-store";

export const runtime = "nodejs";
const selectionSchema = z.object({
    provider: z.enum(["openrouter", "higgsfield", "api-market", "freepik", "google-ai-studio", "google-vertex", "vercel-ai-gateway"]),
    connectionId: z.string().max(100).optional(),
    model: z.string().min(1).max(300).regex(/^[a-zA-Z0-9_.:/-]+$/).refine(s => !s.split("/").includes("..")),
    resolution: z.string().max(32).optional(), quality: z.string().max(32).optional(), aspectRatio: z.string().max(32).optional(), size: z.string().max(32).optional(),
}).strict();
async function selection(value: unknown) {
    const parsed = selectionSchema.safeParse(value);
    if (!parsed.success) throw new Error("ERR_INVALID_BODY");
    const result = parsed.data;
    if (["openrouter", "higgsfield", "api-market"].includes(result.provider)) {
        const connection = await getConnectionForProvider(result.provider, result.connectionId);
        if (!connection) throw new Error("ERR_CONNECTION_NOT_FOUND");
        result.connectionId = connection.id;
    }
    return result;
}
export async function GET(request: NextRequest) {
    const denied = await authorizeRequest(request); if (denied) return denied;
    const limited = await limitRequest("billing:prices", 90); if (limited) return limited;
    try {
        return NextResponse.json(await imageQuote(await selection(Object.fromEntries(request.nextUrl.searchParams))), { headers: { "Cache-Control": "no-store" } });
    } catch (error) { return securityError(error); }
}
export async function POST(request: NextRequest) {
    const denied = await authorizeRequest(request); if (denied) return denied;
    const limited = await limitRequest("billing:rates", 20); if (limited) return limited;
    try {
        const parsed = z.object({ selection: selectionSchema, usd: z.number().finite().min(0).max(10000).nullable() }).strict().safeParse(await readJsonBody(request));
        if (!parsed.success) throw new Error("ERR_INVALID_BODY");
        const target = await selection(parsed.data.selection);
        await billingStore().setRate(priceKey(target), parsed.data.usd);
        return NextResponse.json(await imageQuote(target), { headers: { "Cache-Control": "no-store" } });
    } catch (error) { return securityError(error); }
}
