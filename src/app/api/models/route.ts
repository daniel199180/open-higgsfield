import { requireAdminRequest } from "@/lib/api-security";
import { NextResponse } from "next/server";
import { getCatalog } from "@/providers/catalog";

export async function GET() {
    const denied = await requireAdminRequest(); if (denied) return denied;
    const models = await getCatalog("video");
    return NextResponse.json({
        models: Object.fromEntries(models.map((model) => [model.id, model])),
        groups: [...new Set(models.map((model) => model.group))],
    });
}
