import { NextRequest, NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/api-security";
import { CHAT_SKILLS } from "@/chat/skills";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    return NextResponse.json({ skills: CHAT_SKILLS.map(({ id, label, description }) => ({ id, label, description })) }, { headers: { "Cache-Control": "private, max-age=300" } });
}
