// Operator-only recovery of the initial installation code. Does not reset an
// existing administrator and never exposes provider credentials.
try { process.loadEnvFile(".env.local"); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }

async function main() {
    const { initializeAdminSetup, isAdminConfigured } = await import("../src/lib/admin-auth");
    if (await isAdminConfigured()) {
        console.info("El administrador ya existe. Usa el acceso o la recuperación desde la interfaz.");
        return;
    }
    await initializeAdminSetup();
    if (process.env.OPEN_HIGGSFIELD_SETUP_TOKEN) console.info("Usa el código inicial definido en el gestor de secretos del servicio.");
}
main().catch(() => { console.error("No se pudo generar el código. Comprueba el directorio de datos y sus permisos."); process.exitCode = 1; });
