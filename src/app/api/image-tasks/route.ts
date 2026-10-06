import { requireAdminRequest } from "@/lib/api-security";
import { NextResponse } from "next/server";
import { getImageTasks, initStore } from "@/lib/task-store";

export const runtime = "nodejs";

export async function GET() {
    const denied = await requireAdminRequest(); if (denied) return denied;
  await initStore();
  const tasks = getImageTasks();
  return NextResponse.json(tasks);
}
