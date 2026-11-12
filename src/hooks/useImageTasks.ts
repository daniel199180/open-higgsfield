"use client";

import useSWR, { mutate as globalMutate } from "swr";
import type { ImageTask } from "@/types";

type ImageTaskPage = { tasks: ImageTask[]; total: number };
const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function useImageTasks(enabled = true, limit?: number, galleryOnly = false) {
  const query = new URLSearchParams();
  if (limit) query.set("limit", String(limit));
  if (galleryOnly) query.set("scope", "gallery");
  const key = enabled ? `/api/image-tasks${query.size ? `?${query}` : ""}` : null;
  const { data, error, isLoading, isValidating, mutate } = useSWR<ImageTask[] | ImageTaskPage>(key, fetcher, {
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

export function revalidateImageTasks() {
  return globalMutate((key) => typeof key === "string" && (key === "/api/image-tasks" || key.startsWith("/api/image-tasks?")));
}
