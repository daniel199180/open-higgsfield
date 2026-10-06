import { IMAGE_CAPABILITIES, IMAGE_CAPABILITIES_LIST, IMAGE_CAPABILITY_GROUPS, type ImageModelCapability } from "@/models/capabilities/image";
import { VIDEO_CAPABILITIES, VIDEO_CAPABILITY_GROUPS } from "@/models/capabilities/video";
import type { ModelCapabilities } from "@/models/capabilities/types";

export function mergeRuntimeCatalog(models: ModelCapabilities[]): void {
    const runtime = (id: string) => /^(openrouter|higgsfield|api-market):/.test(id);
    for (const id of Object.keys(IMAGE_CAPABILITIES)) if (runtime(id)) delete IMAGE_CAPABILITIES[id];
    for (const id of Object.keys(VIDEO_CAPABILITIES)) if (runtime(id)) delete VIDEO_CAPABILITIES[id];
    for (let index = IMAGE_CAPABILITIES_LIST.length - 1; index >= 0; index--) if (runtime(IMAGE_CAPABILITIES_LIST[index].id)) IMAGE_CAPABILITIES_LIST.splice(index, 1);
    for (const groups of [IMAGE_CAPABILITY_GROUPS, VIDEO_CAPABILITY_GROUPS]) {
        for (let index = groups.length - 1; index >= 0; index--) if (/^(OpenRouter|Higgsfield|API.market)/.test(groups[index])) groups.splice(index, 1);
    }
    for (const model of models) {
        if (model.provider === "openrouter" || model.provider === "higgsfield" || model.provider === "api-market") {
            if (model.id.includes(":image:")) {
                const imageModel = { ...model, has_edit_variant: false } as ImageModelCapability;
                IMAGE_CAPABILITIES[model.id] = imageModel;
                if (!IMAGE_CAPABILITIES_LIST.some((item) => item.id === model.id)) IMAGE_CAPABILITIES_LIST.push(imageModel);
                if (!IMAGE_CAPABILITY_GROUPS.includes(model.group)) IMAGE_CAPABILITY_GROUPS.push(model.group);
            } else if (model.id.includes(":video:")) {
                VIDEO_CAPABILITIES[model.id] = model;
                if (!VIDEO_CAPABILITY_GROUPS.includes(model.group)) VIDEO_CAPABILITY_GROUPS.push(model.group);
            }
        }
    }
}
