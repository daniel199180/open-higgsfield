import { loadEnvConfig } from "@next/env";

async function main() {
    loadEnvConfig(process.cwd());
    const { processWorkflowStep } = await import("../src/workflows/engine");
    let stopping = false;
    process.on("SIGTERM", () => { stopping = true; });
    process.on("SIGINT", () => { stopping = true; });
    console.info("Workflow worker listo. Concurrencia: 1; las solicitudes ambiguas no se reenvían.");
    while (!stopping) {
        try { await processWorkflowStep(); }
        catch { console.warn("Workflow worker: almacenamiento temporalmente no disponible."); }
        if (!stopping) await new Promise(resolve => setTimeout(resolve, 1000));
    }
    process.exit(0);
}
void main();
