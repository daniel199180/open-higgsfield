import { requireAdminRequest } from "@/lib/api-security";
import { NextResponse } from "next/server";
import { getVideoTasks, initStore } from "@/lib/task-store";

export const runtime = "nodejs";

export async function GET() {
    const denied = await requireAdminRequest(); if (denied) return denied;
  await initStore();
  const tasks = getVideoTasks();
  return NextResponse.json(tasks);
}
