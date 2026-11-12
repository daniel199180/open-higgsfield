import { requireAdminRequest } from "@/lib/api-security";
import { NextRequest, NextResponse } from "next/server";
import { getVideoTasks, initStore } from "@/lib/task-store";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
    const denied = await requireAdminRequest(); if (denied) return denied;
  await initStore();
  const tasks = getVideoTasks();
  const requestedLimit = request.nextUrl.searchParams.get("limit");
  if (requestedLimit !== null) {
    const parsedLimit = Number.parseInt(requestedLimit, 10);
    const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 100) : 24;
    return NextResponse.json({ tasks: tasks.slice(0, limit), total: tasks.length });
  }
  return NextResponse.json(tasks);
}
