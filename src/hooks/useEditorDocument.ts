"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { appendEditorRevision, blankEditorSnapshot, currentEditorSnapshot, editorHistorySchema, forkEditorHistory, type EditorDocument, type EditorHistory, type EditorSnapshot } from "@/lib/editor-document";

function initialHistory(taskId: string, index: number): EditorHistory {
    const entry = { id: crypto.randomUUID(), parentId: "", label: "Original", createdAt: new Date().toISOString(), snapshot: blankEditorSnapshot(taskId, index) };
    return { cursor: entry.id, entries: [entry] };
}
export function useEditorDocument(sourceTaskId: string, sourceIndex: number, documentId?: string, initialTitle = "Edición de imagen") {
    const [copy, setCopy] = useState({ id: "", sourceTaskId, sourceIndex });
    const id = (copy.sourceTaskId === sourceTaskId && copy.sourceIndex === sourceIndex ? copy.id : "") || documentId || (sourceTaskId ? `${sourceTaskId}-${sourceIndex}` : "");
    const [history, setHistory] = useState(() => initialHistory(sourceTaskId, sourceIndex));
    const [title, setTitleState] = useState(initialTitle.slice(0, 160) || "Edición de imagen");
    const [ready, setReady] = useState(false);
    const [status, setStatus] = useState("Cargando edición…");
    const [saveError, setSaveError] = useState("");
    const [dirty, setDirty] = useState(false);
    const current = useRef({ history, title, sourceTaskId, sourceIndex });
    const revision = useRef(0);
    const saved = useRef("");
    const pending = useRef<Promise<boolean> | null>(null);
    const blocked = useRef(false);
    const mounted = useRef(true);
    const key = `open-higgsfield:editor-document:${id}`;

    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    useEffect(() => {
        let active = true;
        // Hydrating a different persistent document must gate edits until the fetch completes.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setReady(false); blocked.current = false; revision.current = 0; saved.current = "";
        if (!id) { setStatus("Agrega una imagen"); setReady(true); return; }
        fetch(`/api/images/documents?id=${encodeURIComponent(id)}`, { cache: "no-store" })
            .then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error || "No se pudo abrir la edición guardada."); return data as { document: EditorDocument | null }; })
            .then(({ document: doc }) => {
                if (!active) return;
                let next = doc ? { history: editorHistorySchema.parse(doc.history), title: doc.title, sourceTaskId: doc.sourceTaskId, sourceIndex: doc.sourceIndex } : { history: initialHistory(sourceTaskId, sourceIndex), title: initialTitle.slice(0, 160) || "Edición de imagen", sourceTaskId, sourceIndex };
                revision.current = doc?.revision ?? 0;
                saved.current = doc ? JSON.stringify(next) : "";
                let recovered = false;
                try {
                    const backup = JSON.parse(localStorage.getItem(key) || "null");
                    if (backup && backup.revision === revision.current && backup.value?.sourceTaskId === next.sourceTaskId && backup.value?.sourceIndex === next.sourceIndex) {
                        const parsed = editorHistorySchema.safeParse(backup.value.history);
                        if (parsed.success && typeof backup.value.title === "string") { next = { ...next, history: parsed.data, title: backup.value.title.slice(0, 160) }; recovered = JSON.stringify(next) !== saved.current; }
                    }
                } catch { /* Server copy remains authoritative if backup cannot be read. */ }
                current.current = next; setHistory(next.history); setTitleState(next.title); setReady(true);
                setDirty(JSON.stringify(next) !== saved.current); setStatus(recovered ? "Borrador recuperado" : doc ? "Edición guardada" : "Nueva edición");
            }).catch(error => { if (active) { setSaveError(error.message); setStatus("No se pudo abrir la edición"); } });
        return () => { active = false; };
        // A document is loaded only when its identity changes, never on a task polling refresh.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id]);

    const backup = useCallback(() => {
        try { localStorage.setItem(key, JSON.stringify({ revision: revision.current, value: current.current })); } catch { /* Server save still works when browser quota is exhausted. */ }
    }, [key]);
    const update = useCallback((patch: Partial<EditorSnapshot> | ((state: EditorSnapshot) => EditorSnapshot), label = "Editar imagen", coalesce = true) => {
        if (!ready || blocked.current) return;
        const prev = current.current.history;
        const state = currentEditorSnapshot(prev);
        const next = appendEditorRevision(prev, typeof patch === "function" ? patch(state) : { ...state, ...patch }, label, coalesce);
        if (next === prev) return;
        current.current = { ...current.current, history: next }; setHistory(next); setDirty(true); setStatus("Cambios sin guardar"); backup();
    }, [ready, backup]);
    const selectRevision = useCallback((cursor: string) => {
        if (!ready || blocked.current || !current.current.history.entries.some(entry => entry.id === cursor)) return;
        const next = { ...current.current.history, cursor };
        current.current = { ...current.current, history: next }; setHistory(next); setDirty(true); backup();
    }, [ready, backup]);
    const setTitle = useCallback((value: string) => { const next = value.slice(0, 160); current.current = { ...current.current, title: next }; setTitleState(next); setDirty(true); backup(); }, [backup]);
    const save = useCallback(async (): Promise<boolean> => {
        if (!id) return true;
        if (!ready || blocked.current) return false;
        if (pending.current) return pending.current;
        const run = async () => {
            try {
                while (JSON.stringify(current.current) !== saved.current) {
                    const value = current.current; const encoded = JSON.stringify(value);
                    if (mounted.current) setStatus("Guardando…");
                    const response = await fetch("/api/images/documents", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, expectedRevision: revision.current, ...value, title: value.title.trim() || "Edición de imagen" }) });
                    const data = await response.json();
                    if (!response.ok) { if (response.status === 409) blocked.current = true; throw new Error(data.error || "No se pudo guardar. Conserva esta pestaña abierta."); }
                    revision.current = data.revision; saved.current = encoded; backup();
                }
                if (mounted.current) { setDirty(false); setSaveError(""); setStatus("Edición guardada"); }
                return true;
            } catch (error) { if (mounted.current) { setSaveError(error instanceof Error ? error.message : "No se pudo guardar."); setStatus("Pendiente de guardar"); } return false; }
        };
        pending.current = run();
        try { return await pending.current; } finally { pending.current = null; }
    }, [id, ready, backup]);
    const saveCopy = useCallback(async (mode: "duplicate" | "fork" = "duplicate"): Promise<string | null> => {
        if (!ready || !id) return null;
        if (pending.current) await pending.current;
        if (!blocked.current && JSON.stringify(current.current) !== saved.current) await save();
        try {
            const newId = crypto.randomUUID();
            const value = current.current;
            const suffix = mode === "fork" ? " (nueva edición)" : " (copia)";
            const response = await fetch("/api/images/documents", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...value, history: mode === "fork" ? forkEditorHistory(value.history) : structuredClone(value.history), title: `${value.title.slice(0, 160 - suffix.length)}${suffix}`, id: newId, expectedRevision: 0 }) });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || "No se pudo guardar la copia.");
            setSaveError(""); setCopy({ id: newId, sourceTaskId, sourceIndex });
            return newId;
        } catch (error) { setSaveError(error instanceof Error ? error.message : "No se pudo guardar la copia."); return null; }
    }, [ready, id, sourceTaskId, sourceIndex, save]);
    useEffect(() => { if (!ready || !dirty || !id) return; const timer = setTimeout(() => void save(), 800); return () => clearTimeout(timer); }, [history, title, ready, dirty, id, save]);
    useEffect(() => {
        if (!dirty) return;
        const warn = (event: BeforeUnloadEvent) => { backup(); event.preventDefault(); event.returnValue = ""; };
        window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
    }, [dirty, backup]);
    return { id, ready, history, snapshot: currentEditorSnapshot(history), update, selectRevision, title, setTitle, save, saveCopy, status, saveError, dirty };
}
