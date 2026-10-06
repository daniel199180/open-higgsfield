import { requireAdminRequest } from "@/lib/api-security";
import { NextResponse } from "next/server";
import { getCatalog } from "@/providers/catalog";

export async function GET() {
    const denied = await requireAdminRequest(); if (denied) return denied;
    const models = await getCatalog("image");
    return NextResponse.json({
        models,
        groups: [...new Set(models.map((model) => model.group))],
    });
}
