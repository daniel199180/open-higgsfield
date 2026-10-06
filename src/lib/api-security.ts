import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { COOKIE_NAME, takeRateLimit, verifyAdminSession } from "./admin-auth";

export function securityError(error: unknown): NextResponse {
    const code = error instanceof Error ? error.message : "";
    const allowed: Record<string, [number, string]> = {
        ERR_PASSWORD_LENGTH: [400, "Usa una contraseña de 15 a 128 caracteres."],
        ERR_SETUP_TOKEN_INVALID: [401, "Código de instalación incorrecto o caducado. Reinicia el servicio para obtener uno nuevo."],
        ERR_ADMIN_ALREADY_CONFIGURED: [409, "El administrador ya está configurado."],
        ERR_ADMIN_AUTH_FAILED: [401, "Las credenciales no son válidas."],
        ERR_SECURITY_STORE_BUSY: [503, "El almacenamiento está ocupado. Reintenta en unos segundos."],
        ERR_BODY_TOO_LARGE: [413, "La petición supera el tamaño permitido."],
        ERR_INVALID_BODY: [400, "Revisa los campos enviados."],
        ERR_PROVIDER_URL_NOT_ALLOWED: [400, "Solo se admiten los servidores oficiales del proveedor."],
        ERR_CONNECTION_NOT_FOUND: [404, "La conexión ya no existe."],
        ERR_CONNECTION_PROVIDER_MISMATCH: [400, "No puedes cambiar el proveedor de una conexión existente."],
        ERR_PROVIDER_API_KEY_REQUIRED: [400, "Introduce la clave de API."],
        ERR_API_MARKET_PRODUCT_NOT_CONFIGURED: [400, "Completa workspace y slug del producto."],
        ERR_LEGACY_VAULT_KEY_REQUIRED: [503, "Hace falta la clave original para migrar las conexiones existentes. No se han modificado."],
        ERR_VAULT_KEY_MISSING: [503, "Falta la clave de cifrado. Restaura la copia de seguridad del servidor."],
    };
    const [status, message] = allowed[code] ?? [500, "No se pudo completar la operación. Verifica la configuración del servicio."];
    return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}
function localDevelopmentOrigin(req: NextRequest): string {
    if (process.env.NODE_ENV !== "development") return "";
    // Next can normalize the internal URL to its bind address (0.0.0.0).
    // Use only a literal loopback Host, never forwarded headers or Origin itself.
    const host = req.headers.get("host") || "";
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/i.test(host)) return "";
    if (!["http:", "https:"].includes(req.nextUrl.protocol)) return "";
    try { return new URL(`${req.nextUrl.protocol}//${host}`).origin; }
    catch { return ""; }
}
export function checkOrigin(req: NextRequest): NextResponse | null {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return null;
    const expected = process.env.OPEN_HIGGSFIELD_APP_ORIGIN || localDevelopmentOrigin(req);
    const origin = req.headers.get("origin");
    if (!expected || origin !== expected || req.headers.get("sec-fetch-site") === "cross-site") {
        const error = !expected && process.env.NODE_ENV === "production"
            ? "Configura OPEN_HIGGSFIELD_APP_ORIGIN con la URL pública del servicio."
            : "Origen de solicitud no permitido. Abre el panel desde la dirección autorizada del servicio.";
        return NextResponse.json({ error }, { status: 403, headers: { "Cache-Control": "no-store" } });
    }
    return null;
}
export async function authorizeRequest(req: NextRequest): Promise<NextResponse | null> {
    const originError = checkOrigin(req);
    if (originError) return originError;
    if (!await verifyAdminSession(req.cookies.get(COOKIE_NAME)?.value)) {
        return NextResponse.json({ error: "Inicia sesión como administrador." }, { status: 401 });
    }
    return null;
}
export async function requireAdminRequest(): Promise<NextResponse | null> {
    const { headers } = await import("next/headers");
    const h = await headers();
    const cookie = h.get("cookie")?.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1);
    return await verifyAdminSession(cookie) ? null : NextResponse.json({ error: "Inicia sesión como administrador." }, { status: 401 });
}
export async function limitRequest(bucket: string, count = 8, duration = 60_000) {
    if (await takeRateLimit(bucket, count, duration)) return null;
    return NextResponse.json({ error: "Demasiados intentos. Espera y vuelve a intentarlo." }, { status: 429, headers: { "Retry-After": String(Math.ceil(duration / 1000)) } });
}
export async function readLimitedBody(req: Request, maximum: number): Promise<Uint8Array> {
    if (Number(req.headers.get("content-length") || 0) > maximum) throw new Error("ERR_BODY_TOO_LARGE");
    const reader = req.body?.getReader();
    if (!reader) return new Uint8Array();
    const chunks: Uint8Array[] = []; let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maximum) { await reader.cancel(); throw new Error("ERR_BODY_TOO_LARGE"); }
            chunks.push(value);
        }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks, total);
}
export async function readJsonBody(req: Request) {
    if (!req.headers.get("content-type")?.startsWith("application/json")) throw new Error("ERR_INVALID_BODY");
    const bytes = await readLimitedBody(req, 16 * 1024);
    try { return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown; }
    catch { throw new Error("ERR_INVALID_BODY"); }
}
