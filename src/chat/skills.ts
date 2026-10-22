export interface ChatSkill {
    id: string;
    label: string;
    description: string;
    prompt: string;
}

export const CHAT_SKILLS: ChatSkill[] = [
    {
        id: "general",
        label: "General",
        description: "Respuestas claras y equilibradas.",
        prompt: "Responde con claridad, verifica tus supuestos y separa los hechos de las inferencias.",
    },
    {
        id: "investigacion",
        label: "Investigación",
        description: "Sintetiza información y fuentes.",
        prompt: "Analiza la evidencia disponible, compara perspectivas y señala qué información falta. Si hay fuentes, úsalas de forma explícita.",
    },
    {
        id: "redactor",
        label: "Redactor",
        description: "Mejora textos con intención y tono.",
        prompt: "Prioriza una redacción natural, concreta y adecuada al objetivo y al idioma del usuario. No agregues datos que no estén respaldados.",
    },
    {
        id: "programador",
        label: "Programador",
        description: "Ayuda técnica con soluciones verificables.",
        prompt: "Explica las decisiones técnicas, identifica riesgos y entrega soluciones pequeñas, seguras y comprobables.",
    },
    {
        id: "marketing",
        label: "Marketing",
        description: "Ideas de campañas y mensajes.",
        prompt: "Propón mensajes orientados a una audiencia concreta, con beneficios verificables, llamadas a la acción y alternativas de tono.",
    },
];

export function getChatSkill(id?: string): ChatSkill {
    return CHAT_SKILLS.find((skill) => skill.id === id) ?? CHAT_SKILLS[0];
}
