"use client";

import useSWR, { mutate as globalMutate } from "swr";
import type { VideoTask } from "@/types";

type VideoTaskPage = { tasks: VideoTask[]; total: number };
const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function useVideoTasks(enabled = true, limit?: number) {
  const key = enabled ? (limit ? `/api/tasks?limit=${limit}` : "/api/tasks") : null;
  const { data, error, isLoading, isValidating, mutate } = useSWR<VideoTask[] | VideoTaskPage>(key, fetcher, {
    refreshInterval: (payload) => {
      const tasks = Array.isArray(payload) ? payload : payload?.tasks ?? [];
      return tasks.some((task) => !task._done) ? 3000 : 0;
    },
    revalidateOnFocus: false,
    keepPreviousData: true,
  });
  const tasks = Array.isArray(data) ? data : data?.tasks ?? [];
  const total = Array.isArray(data) ? data.length : data?.total ?? 0;

  return {
    tasks,
    total,
    hasMore: tasks.length < total,
    isLoading,
    isValidating,
    error,
    mutate,
  };
}

export function revalidateVideoTasks() {
  return globalMutate((key) => typeof key === "string" && (key === "/api/tasks" || key.startsWith("/api/tasks?")));
}
