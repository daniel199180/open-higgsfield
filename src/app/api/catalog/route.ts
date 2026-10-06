import { requireAdminRequest } from "@/lib/api-security";
import { NextRequest, NextResponse } from "next/server";
import { getCatalog } from "@/providers/catalog";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
    const denied = await requireAdminRequest(); if (denied) return denied;
    const mediaType = req.nextUrl.searchParams.get("mediaType") === "video" ? "video" : "image";
    const models = await getCatalog(mediaType);
    return NextResponse.json({ models, groups: [...new Set(models.map((model) => model.group))] });
}
