import createMiddleware from "next-intl/middleware";
import { routing } from "@/i18n/routing";
import { NextRequest, NextResponse } from "next/server";
import { authorizeRequest, checkOrigin, securityError } from "@/lib/api-security";

const intl = createMiddleware(routing);
export default async function proxy(request: NextRequest) {
    const pathname = request.nextUrl.pathname;
    if (pathname.startsWith("/api/")) {
        try {
            if (pathname !== "/api/health") {
                const denied = pathname === "/api/admin/auth" ? checkOrigin(request) : await authorizeRequest(request);
                if (denied) { denied.headers.set("Cache-Control", "no-store"); return denied; }
            }
            const response = NextResponse.next();
            response.headers.set("Cache-Control", "no-store");
            return response;
        } catch (error) { return securityError(error); }
    }
    const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
    const policy = [
        "default-src 'self'", "base-uri 'self'", "object-src 'none'", "frame-ancestors 'none'", "form-action 'self'",
        `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${process.env.NODE_ENV !== "production" ? " 'unsafe-eval'" : ""}`,
        "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob: https:", "media-src 'self' blob: https:",
        "font-src 'self'", `connect-src 'self' https:${process.env.NODE_ENV !== "production" ? " ws: wss:" : ""}`,
    ].join("; ");
    const headers = new Headers(request.headers);
    headers.set("x-nonce", nonce);
    headers.set("Content-Security-Policy", policy);
    const response = intl(new NextRequest(request, { headers }));
    response.headers.set("Content-Security-Policy", policy);
    response.headers.set("Cache-Control", "no-store");
    return response;
}

export const config = {
    matcher: ["/api/:path*", "/((?!api|_next|_vercel|.*\\..*).*)"],
};
