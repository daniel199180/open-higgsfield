import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ImageTask } from "../src/types";

test("company assignments survive task persistence and old images remain unassigned", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "higgsfield-company-"));
    const previous = process.env.OPEN_HIGGSFIELD_STORAGE_DIR;
    process.env.OPEN_HIGGSFIELD_STORAGE_DIR = directory;
    try {
        const oldTask: ImageTask = { task_id: "older-image", status: "COMPLETED", model_id: "test", created_at: "2026-01-01T00:00:00Z", media_type: "image", result_paths: [] };
        await fs.writeFile(path.join(directory, "tasks_history.json"), JSON.stringify([oldTask]));
        const { initStore, getTask, setTask, saveTasks } = await import("../src/lib/task-store");
        await initStore();
        assert.equal(getTask(oldTask.task_id)?.company_id, undefined);
        const companyId = "91ac21ea-7f87-4ab9-91cc-275302391222";
        const assigned = getTask(oldTask.task_id)!;
        assigned.company_id = companyId;
        setTask(assigned);
        await saveTasks();
        const saved = JSON.parse(await fs.readFile(path.join(directory, "tasks_history.json"), "utf8")) as ImageTask[];
        assert.equal(saved.find(task => task.task_id === oldTask.task_id)?.company_id, companyId);
        assert.equal(saved.find(task => task.task_id === oldTask.task_id)?.media_type, "image");
    } finally {
        if (previous === undefined) delete process.env.OPEN_HIGGSFIELD_STORAGE_DIR;
        else process.env.OPEN_HIGGSFIELD_STORAGE_DIR = previous;
        await fs.rm(directory, { recursive: true, force: true });
    }
});
