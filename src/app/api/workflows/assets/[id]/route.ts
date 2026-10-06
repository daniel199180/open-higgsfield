import { NextRequest, NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/api-security";
import { readAsset } from "@/workflows/assets";
import { workflowError } from "@/workflows/http";

export const runtime = "nodejs";
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    try {
        const { asset, data } = await readAsset((await params).id);
        const extension = asset.mime === "video/mp4" ? "mp4" : asset.mime === "video/webm" ? "webm" : "png";
        const headers: Record<string, string> = {
            "Content-Type": asset.mime, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox", "Accept-Ranges": "bytes",
            "Content-Disposition": `${req.nextUrl.searchParams.get("download") === "1" ? "attachment" : "inline"}; filename="${asset.id}.${extension}"`,
        };
        const range = req.headers.get("range");
        if (range) {
            const match = /^bytes=(\d+)-(\d*)$/.exec(range);
            const start = match ? Number(match[1]) : -1, end = match?.[2] ? Number(match[2]) : data.length - 1;
            if (start < 0 || start > end || end >= data.length) return new NextResponse(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${data.length}` } });
            return new NextResponse(data.subarray(start, end + 1), { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${data.length}`, "Content-Length": String(end - start + 1) } });
        }
        return new NextResponse(data, { headers: { ...headers, "Content-Length": String(data.length) } });
    } catch (error) { return workflowError(error); }
}
