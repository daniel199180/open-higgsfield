"use client";
import { useEffect, useId, useState } from "react";
import { Eye, EyeOff, KeyRound, Loader2, ShieldCheck } from "lucide-react";

function SecretField({ label, ariaLabel, value, onChange, minLength, maxLength, autoComplete }: {
    label: string;
    ariaLabel?: string;
    value: string;
    onChange: React.ChangeEventHandler<HTMLInputElement>;
    minLength?: number;
    maxLength: number;
    autoComplete: string;
}) {
    const id = useId();
    const [visible, setVisible] = useState(false);
    return <div className="text-sm">
        <label htmlFor={id} className="block">{label}</label>
        <div className="relative mt-2">
            <input id={id} aria-label={ariaLabel} type={visible ? "text" : "password"} className="w-full rounded-xl border border-white/15 bg-white/5 px-3 py-3 pr-12 text-white outline-none focus:border-[#ff4d4d]" value={value} onChange={onChange} required minLength={minLength} maxLength={maxLength} autoComplete={autoComplete} />
            <button type="button" aria-label={`${visible ? "Ocultar" : "Mostrar"} ${ariaLabel ?? label}`} aria-pressed={visible} onClick={() => setVisible(current => !current)} className="absolute inset-y-0 right-0 grid w-11 place-items-center rounded-r-xl text-white/50 transition hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ff4d4d]">
                {visible ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
            </button>
        </div>
    </div>;
}

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
    return <section className="w-full max-w-lg rounded-3xl border border-white/10 bg-[#101010] p-6 text-white shadow-2xl">
        <ShieldCheck className="mb-4 h-8 w-8 text-[#ff4d4d]" />
        <h1 className="text-2xl font-bold">{recoveryCode ? "Guarda tu código de recuperación" : changePassword ? "Cambiar contraseña" : configured === false ? "Crear administrador" : recover ? "Recuperar acceso" : "Acceso de administrador"}</h1>
        {recoveryCode ? <div className="mt-4 space-y-4">
            <p className="text-sm text-white/60">Guárdalo en tu gestor de contraseñas. Permite recuperar el acceso una sola vez y no volverá a mostrarse.</p>
            <code className="block break-all rounded-xl border border-[#ff4d4d]/30 bg-black p-4 select-all">{recoveryCode}</code>
            <button className="w-full rounded-xl bg-[#c62828] p-3 font-semibold text-white" onClick={() => { setRecoveryCode(""); onReady(); }}>He guardado el código · Continuar</button>
        </div> : <form onSubmit={submit} className="mt-4 space-y-4">
            <p className="text-sm text-white/60">{configured === false ? "Crea tu acceso y configura tus APIs desde aquí. El código de instalación está en la terminal donde arrancó la aplicación; en EasyPanel, en los registros del servicio. Caduca a los 30 minutos." : "Tus conexiones y generaciones están protegidas por este acceso."}</p>
            {(configured === false || recover || changePassword) && <SecretField key={changePassword ? "current-password" : recover ? "recovery-code" : "installation-code"} label={changePassword ? "Contraseña actual" : recover ? "Código de recuperación" : "Código de instalación"} value={proof} onChange={(event) => setProof(event.target.value)} maxLength={256} autoComplete={changePassword ? "current-password" : "off"} />}
            <SecretField key={creating ? "new-password" : "login-password"} label={creating ? "Nueva contraseña (mínimo 15 caracteres)" : "Contraseña"} ariaLabel={creating ? "Nueva contraseña" : "Contraseña"} value={password} onChange={(event) => setPassword(event.target.value)} minLength={creating ? 15 : 1} maxLength={128} autoComplete={creating ? "new-password" : "current-password"} />
            {creating && <SecretField label="Confirmar contraseña" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} maxLength={128} autoComplete="new-password" />}
            {error && <p role="alert" className="rounded-xl bg-red-400/10 p-3 text-sm text-red-200">{error}</p>}
            <button disabled={busy || configured === null} className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#c62828] p-3 font-semibold text-white disabled:opacity-50">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}{configured === false ? "Crear administrador" : creating ? "Guardar contraseña" : "Entrar"}</button>
            {configured && !changePassword && <button type="button" onClick={() => { setRecover(!recover); setError(""); setProof(""); setPassword(""); setConfirmation(""); }} className="text-sm text-white/60 underline">{recover ? "Volver al inicio de sesión" : "He olvidado mi contraseña"}</button>}
        </form>}
    </section>;
}
