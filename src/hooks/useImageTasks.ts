"use client";

import useSWR, { mutate as globalMutate } from "swr";
import type { ImageTask } from "@/types";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function useImageTasks(enabled = true) {
  const { data, error, isLoading, mutate } = useSWR<ImageTask[]>(enabled ? "/api/image-tasks" : null, fetcher, {
    refreshInterval: (data) => data?.some((t) => !t._done) ? 3000 : 0,
    revalidateOnFocus: false,
  });

  return {
    tasks: data ?? [],
    isLoading,
    error,
    mutate,
  };
}

export function revalidateImageTasks() {
  return globalMutate("/api/image-tasks");
}
