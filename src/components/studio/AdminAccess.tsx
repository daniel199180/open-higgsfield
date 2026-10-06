"use client";
import { useEffect, useState } from "react";
import { KeyRound, Loader2, ShieldCheck } from "lucide-react";

export function AdminAccess({ onReady, changePassword = false }: { onReady: () => void; changePassword?: boolean }) {
    const [configured, setConfigured] = useState<boolean | null>(changePassword ? true : null);
    const [recover, setRecover] = useState(false);
    const [password, setPassword] = useState("");
    const [confirmation, setConfirmation] = useState("");
    const [proof, setProof] = useState("");
    const [recoveryCode, setRecoveryCode] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const action = changePassword ? "password" : !configured ? "setup" : recover ? "recover" : "login";
    const creating = action !== "login";
    useEffect(() => {
        if (changePassword) return;
        let active = true;
        fetch("/api/admin/auth", { cache: "no-store" }).then(async (response) => {
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || "No se pudo comprobar el acceso.");
            if (active) setConfigured(data.configured);
        }).catch((error) => { if (active) setError(error.message); });
        return () => { active = false; };
    }, [changePassword]);

    async function submit(event: React.FormEvent) {
        event.preventDefault();
        if (creating && password !== confirmation) { setError("Las contraseñas no coinciden."); return; }
        setBusy(true); setError("");
        try {
            const response = await fetch("/api/admin/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, password, proof }) });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || "No se pudo iniciar sesión.");
            setPassword(""); setConfirmation(""); setProof("");
            if (data.recoveryCode) setRecoveryCode(data.recoveryCode);
            else onReady();
        } catch (error) { setError(error instanceof Error ? error.message : "No se pudo conectar con el servidor."); }
        finally { setBusy(false); }
    }
    const inputClass = "mt-2 w-full rounded-xl border border-white/15 bg-white/5 px-3 py-3 text-white outline-none focus:border-[#d5ff47]";
    return <section className="w-full max-w-lg rounded-3xl border border-white/10 bg-[#101010] p-6 text-white shadow-2xl">
        <ShieldCheck className="mb-4 h-8 w-8 text-[#d5ff47]" />
        <h1 className="text-2xl font-bold">{recoveryCode ? "Guarda tu código de recuperación" : changePassword ? "Cambiar contraseña" : configured === false ? "Crear administrador" : recover ? "Recuperar acceso" : "Acceso de administrador"}</h1>
        {recoveryCode ? <div className="mt-4 space-y-4">
            <p className="text-sm text-white/60">Guárdalo en tu gestor de contraseñas. Permite recuperar el acceso una sola vez y no volverá a mostrarse.</p>
            <code className="block break-all rounded-xl border border-[#d5ff47]/30 bg-black p-4 select-all">{recoveryCode}</code>
            <button className="w-full rounded-xl bg-[#d5ff47] p-3 font-semibold text-black" onClick={() => { setRecoveryCode(""); onReady(); }}>He guardado el código · Continuar</button>
        </div> : <form onSubmit={submit} className="mt-4 space-y-4">
            <p className="text-sm text-white/60">{configured === false ? "Crea tu acceso y configura tus APIs desde aquí. El código de instalación está en la terminal donde arrancó la aplicación; en EasyPanel, en los registros del servicio. Caduca a los 30 minutos." : "Tus conexiones y generaciones están protegidas por este acceso."}</p>
            {(configured === false || recover || changePassword) && <label className="block text-sm">{changePassword ? "Contraseña actual" : recover ? "Código de recuperación" : "Código de instalación"}<input aria-label={changePassword ? "Contraseña actual" : recover ? "Código de recuperación" : "Código de instalación"} type="password" className={inputClass} value={proof} onChange={(event) => setProof(event.target.value)} required maxLength={256} autoComplete={changePassword ? "current-password" : "off"} /></label>}
            <label className="block text-sm">{creating ? "Nueva contraseña (mínimo 15 caracteres)" : "Contraseña"}<input aria-label="Contraseña" type="password" className={inputClass} value={password} onChange={(event) => setPassword(event.target.value)} required minLength={creating ? 15 : 1} maxLength={128} autoComplete={creating ? "new-password" : "current-password"} /></label>
            {creating && <label className="block text-sm">Confirmar contraseña<input aria-label="Confirmar contraseña" type="password" className={inputClass} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required maxLength={128} autoComplete="new-password" /></label>}
            {error && <p role="alert" className="rounded-xl bg-red-400/10 p-3 text-sm text-red-200">{error}</p>}
            <button disabled={busy || configured === null} className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#d5ff47] p-3 font-semibold text-black disabled:opacity-50">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}{configured === false ? "Crear administrador" : creating ? "Guardar contraseña" : "Entrar"}</button>
            {configured && !changePassword && <button type="button" onClick={() => { setRecover(!recover); setError(""); setProof(""); setPassword(""); setConfirmation(""); }} className="text-sm text-white/60 underline">{recover ? "Volver al inicio de sesión" : "He olvidado mi contraseña"}</button>}
        </form>}
    </section>;
}
