import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { COOKIE_MAX_AGE, COOKIE_NAME, isAdminConfigured, verifyAdminSession, createAdmin, loginAdmin, logoutAdmin, changeAdminPassword } from "@/lib/admin-auth";
import { authorizeRequest, checkOrigin, limitRequest, readJsonBody, securityError } from "@/lib/api-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const schema = z.object({
    action: z.enum(["setup", "login", "password", "recover"]).default("login"),
    password: z.string().min(1).max(128),
    proof: z.string().max(256).default(""),
}).strict();
const cookieOptions = { httpOnly: true, sameSite: "strict" as const, secure: process.env.NODE_ENV === "production", path: "/" };

export async function GET(req: NextRequest) {
    try {
        return NextResponse.json({ configured: await isAdminConfigured(), authenticated: await verifyAdminSession(req.cookies.get(COOKIE_NAME)?.value) }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) { return securityError(error); }
}
export async function POST(req: NextRequest) {
    try {
        const blocked = checkOrigin(req) || await limitRequest("authentication", 8, 60_000);
        if (blocked) return blocked;
        const parsed = schema.safeParse(await readJsonBody(req));
        if (!parsed.success) throw new Error("ERR_INVALID_BODY");
        const { action, password, proof } = parsed.data;
        let result: { token: string; recoveryCode?: string };
        if (action === "setup") result = await createAdmin(password, proof);
        else if (action === "recover") result = await changeAdminPassword(password, proof, "recovery");
        else if (action === "password") {
            const denied = await authorizeRequest(req); if (denied) return denied;
            result = await changeAdminPassword(password, proof, "password");
        } else {
            const token = await loginAdmin(password);
            if (!token) throw new Error("ERR_ADMIN_AUTH_FAILED");
            result = { token };
        }
        const response = NextResponse.json({ configured: true, authenticated: true, ...(result.recoveryCode ? { recoveryCode: result.recoveryCode } : {}) }, { headers: { "Cache-Control": "no-store" } });
        response.cookies.set(COOKIE_NAME, result.token, { ...cookieOptions, maxAge: COOKIE_MAX_AGE });
        return response;
    } catch (error) { return securityError(error); }
}
export async function DELETE(req: NextRequest) {
    try {
        const denied = await authorizeRequest(req); if (denied) return denied;
        await logoutAdmin(req.cookies.get(COOKIE_NAME)!.value, req.nextUrl.searchParams.get("all") === "true");
        const response = NextResponse.json({ authenticated: false }, { headers: { "Cache-Control": "no-store" } });
        response.cookies.set(COOKIE_NAME, "", { ...cookieOptions, maxAge: 0 });
        return response;
    } catch (error) { return securityError(error); }
}
