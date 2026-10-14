import type { Character, CharacterSnapshot } from "./types";

export const MAX_CHARACTER_REFERENCES = 4;

export function characterSnapshot(character: Character): CharacterSnapshot {
    return {
        id: character.id,
        version: character.version,
        name: character.name,
        description: character.description,
        visualRules: character.visualRules,
        referenceAssetIds: [...character.referenceAssetIds],
        soulId: character.soulId,
        soulConnectionId: character.soulConnectionId,
        soulStatus: character.soulStatus,
    };
}

export function characterIdentityPrompt(character: CharacterSnapshot): string {
    return [
        `Personaje recurrente: ${character.name}.`,
        character.description ? `Rasgos constantes: ${character.description}.` : "",
        character.visualRules ? `Reglas del personaje: ${character.visualRules}.` : "",
        "Las referencias del personaje definen su identidad. Mantén rostro, rasgos y estilo reconocibles; adapta pose y escena según el pedido.",
    ].filter(Boolean).join("\n");
}
