import "server-only";
import { workflowStore } from "@/workflows/store";
import type { AudioResult, SavedVoice, VoicePreview } from "./types";

export async function listAudio() {
    const [voices, results] = await Promise.all([
        workflowStore().list<SavedVoice>("voice:"),
        workflowStore().list<AudioResult>("audio:"),
    ]);
    return { voices: voices.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), results: results.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
}
export async function getVoice(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
    return workflowStore().read<SavedVoice>(`voice:${id}`);
}
export async function saveVoice(voice: SavedVoice) {
    await workflowStore().transaction(docs => { docs.set(`voice:${voice.id}`, voice); });
}
export async function saveAudioResult(result: AudioResult) {
    await workflowStore().transaction(docs => { docs.set(`audio:${result.id}`, result); });
}
export async function savePreview(preview: VoicePreview) {
    await workflowStore().transaction(docs => { docs.set(`voice-preview:${preview.id}`, preview); });
}
export async function getPreview(id: string) {
    if (!/^[A-Za-z0-9_-]{5,100}$/.test(id)) return undefined;
    return workflowStore().read<VoicePreview>(`voice-preview:${id}`);
}
