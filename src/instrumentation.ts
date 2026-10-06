export async function register() {
    if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build") {
        const { initializeAdminSetup } = await import("./lib/admin-auth");
        await initializeAdminSetup();
        if (process.env.WORKFLOWS_EXTERNAL_WORKER !== "1") {
            const { startWorkflowEngine } = await import("./workflows/engine");
            startWorkflowEngine();
        }
    }
}
