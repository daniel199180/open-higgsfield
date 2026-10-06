import { NextRequest, NextResponse } from "next/server";
import { authorizeRequest, limitRequest, securityError } from "@/lib/api-security";
import { billingStore } from "@/billing/store";
import { accountUsage, billingConnections } from "@/billing/accounts";

export const runtime = "nodejs";
export async function GET(request: NextRequest) {
    const denied = await authorizeRequest(request); if (denied) return denied;
    const sync = request.nextUrl.searchParams.get("accounts") === "1";
    const limited = await limitRequest(sync ? "billing:accounts" : "billing:summary", sync ? 4 : 60); if (limited) return limited;
    try {
        const connections = await billingConnections();
        return NextResponse.json({ ...await billingStore().summary(), connections: connections.map(c => ({ id: c.id, name: c.name, provider: c.provider })),
            ...(sync ? { accounts: await accountUsage(connections) } : {}) }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) { return securityError(error); }
}
