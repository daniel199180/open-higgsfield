import { MousePointerClick, Type, Upload, ImageIcon, Film, Mic2, Layers3, CircleCheck, Download, type LucideIcon } from "lucide-react";
import type { NodeKind } from "@/workflows/types";

export const nodeIcons: Record<NodeKind, LucideIcon> = {
    manualTrigger: MousePointerClick,
    prompt: Type,
    asset: Upload,
    image: ImageIcon,
    video: Film,
    audio: Mic2,
    salesAngles: Layers3,
    approval: CircleCheck,
    output: Download,
};
