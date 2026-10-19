import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import crypto from "node:crypto";
import { authorizeRequest, limitRequest, readLimitedBody } from "@/lib/api-security";
import { workflowStore } from "@/workflows/store";
import { WorkflowError, type Asset } from "@/workflows/types";
import type { BrandSystem, SocialProject } from "@/social/types";
import { brandLogoAssetIds, MAX_BRAND_LOGOS, MAX_BRAND_REFERENCES } from "@/social/brand";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const brandSchema = z.object({
    id: z.uuid().optional(),
    name: z.string().trim().min(1).max(80),
    primaryColor: z.string().regex(/^#[\da-fA-F]{6}$/),
    secondaryColor: z.string().regex(/^#[\da-fA-F]{6}$/),
    accentColor: z.string().regex(/^#[\da-fA-F]{6}$/),
    headingFont: z.string().trim().min(1).max(80),
    subheadingFont: z.string().trim().min(1).max(80).optional(),
    bodyFont: z.string().trim().min(1).max(80),
    secondaryBodyFont: z.string().trim().min(1).max(80).optional(),
    voice: z.string().trim().max(500),
    visualRules: z.string().trim().max(1000),
    negativePrompt: z.string().trim().max(2000).optional(),
    references: z.array(z.object({ assetId: z.uuid(), name: z.string().trim().regex(/^[a-z][a-z0-9_-]{0,39}$/) }).strict()).max(MAX_BRAND_REFERENCES).optional(),
    logoAssetId: z.uuid().optional(),
    logoAssetIds: z.array(z.uuid()).max(MAX_BRAND_LOGOS).optional(),
    logoVectorAssetId: z.uuid().optional(),
}).strict();
const commandSchema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("save-brand"), brand: brandSchema }).strict(),
    z.object({ action: z.literal("duplicate-brand"), id: z.uuid() }).strict(),
    z.object({ action: z.literal("delete-brand"), id: z.uuid() }).strict(),
    z.object({ action: z.literal("save-project"), project: z.object({
        id: z.uuid().optional(), name: z.string().trim().min(1).max(100), brandId: z.uuid(),
        format: z.enum(["post-square", "post-portrait", "story", "carousel"]),
        language: z.enum(["Español", "Português (Brasil)", "English"]),
        brief: z.string().trim().min(5).max(2000), modelId: z.string().min(1).max(500),
        slideCount: z.number().int().min(1).max(10), taskIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{6,100}$/)).max(10),
        status: z.enum(["draft", "generating", "completed", "partial"]),
    }).strict() }).strict(),
]);

export async function GET(req: NextRequest) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    try {
        const store = workflowStore();
        const [brands, projects, assets] = await Promise.all([
            store.list<BrandSystem>("brand:"), store.list<SocialProject>("social:"),
            req.nextUrl.searchParams.get("includeAssets") === "0" ? Promise.resolve([] as Asset[]) : store.list<Asset>("asset:"),
        ]);
        return NextResponse.json({
            brands: brands.sort((a, b) => b.updatedAt - a.updatedAt),
            projects: projects.sort((a, b) => b.updatedAt - a.updatedAt),
            assets: assets.sort((a, b) => b.createdAt - a.createdAt).slice(0, 100),
            storage: process.env.WORKFLOWS_DATABASE_URL ? "PostgreSQL" : "SQLite local",
        }, { headers: { "Cache-Control": "no-store" } });
    } catch { return NextResponse.json({ error: "No se pudieron cargar las marcas y proyectos." }, { status: 500 }); }
}

export async function POST(req: NextRequest) {
    const denied = await authorizeRequest(req); if (denied) return denied;
    const limited = await limitRequest("social-design", 60); if (limited) return limited;
    try {
        if (!req.headers.get("content-type")?.startsWith("application/json")) throw new WorkflowError("Envía JSON.");
        const input = commandSchema.parse(JSON.parse(Buffer.from(await readLimitedBody(req, 32 * 1024)).toString("utf8")));
        const store = workflowStore();
        if (input.action === "save-brand") {
            const saved = await store.transaction(docs => {
                const previous = input.brand.id ? docs.get(`brand:${input.brand.id}`) as BrandSystem | undefined : undefined;
                if (input.brand.id && !previous) throw new WorkflowError("No se encontró el sistema de diseño.", 404);
                const references = input.brand.references ?? previous?.references ?? [];
                if (new Set(references.map(item => item.name)).size !== references.length) throw new WorkflowError("Cada referencia debe tener un nombre único.");
                for (const reference of references) {
                    if ((docs.get(`asset:${reference.assetId}`) as Asset | undefined)?.kind !== "image") throw new WorkflowError(`Vuelve a subir la referencia @${reference.name}.`);
                }
                const mentions = [...input.brand.visualRules.matchAll(/@([a-z][a-z0-9_-]*)/gi)].map(match => match[1]);
                if (mentions.some(name => !references.some(item => item.name === name))) throw new WorkflowError("Hay menciones en las reglas visuales que no corresponden a una referencia. Corrígelas antes de guardar.");
                const logoAssetIds = brandLogoAssetIds(input.brand);
                if (logoAssetIds.length > MAX_BRAND_LOGOS) throw new WorkflowError(`Puedes guardar hasta ${MAX_BRAND_LOGOS} logos por sistema de diseño.`);
                for (const id of logoAssetIds) {
                    const asset = docs.get(`asset:${id}`) as Asset | undefined;
                    if (asset?.kind !== "image") throw new WorkflowError("Vuelve a subir los logos que ya no están disponibles.");
                }
                if (input.brand.logoVectorAssetId) {
                    const vector = docs.get(`asset:${input.brand.logoVectorAssetId}`) as Asset | undefined;
                    if (vector?.kind !== "vector") throw new WorkflowError("El SVG seleccionado ya no está disponible.");
                }
                if (!previous && [...docs.keys()].filter(key => key.startsWith("brand:")).length >= 50) throw new WorkflowError("Alcanzaste el límite de sistemas de diseño.", 409);
                const now = Date.now();
                const brand: BrandSystem = { ...input.brand, references, negativePrompt: input.brand.negativePrompt ?? previous?.negativePrompt ?? "", logoAssetIds, logoAssetId: logoAssetIds[0], id: previous?.id ?? crypto.randomUUID(), createdAt: previous?.createdAt ?? now, updatedAt: now };
                brand.subheadingFont = input.brand.subheadingFont ?? previous?.subheadingFont ?? input.brand.headingFont;
                brand.secondaryBodyFont = input.brand.secondaryBodyFont ?? previous?.secondaryBodyFont ?? input.brand.bodyFont;
                docs.set(`brand:${brand.id}`, brand);
                return brand;
            });
            return NextResponse.json({ brand: saved });
        }
        if (input.action === "delete-brand") {
            await store.transaction(docs => {
                if (!docs.has(`brand:${input.id}`)) throw new WorkflowError("No se encontró el sistema de diseño.", 404);
                if ([...docs.values()].some(value => "brandId" in value && value.brandId === input.id)) throw new WorkflowError("Esta marca tiene proyectos o logos vinculados. Puedes editarla, pero no eliminarla.", 409);
                docs.delete(`brand:${input.id}`);
            });
            return NextResponse.json({ ok: true });
        }
        if (input.action === "duplicate-brand") {
            const saved = await store.transaction(docs => {
                const original = docs.get(`brand:${input.id}`) as BrandSystem | undefined;
                if (!original) throw new WorkflowError("No se encontró el sistema de diseño.", 404);
                if ([...docs.keys()].filter(key => key.startsWith("brand:")).length >= 50) throw new WorkflowError("Alcanzaste el límite de sistemas de diseño.", 409);
                const suffix = " (copia)";
                const name = original.name.length + suffix.length <= 80 ? `${original.name}${suffix}` : `${original.name.slice(0, 80 - suffix.length)}${suffix}`;
                const now = Date.now();
                const duplicate: BrandSystem = {
                    ...original,
                    id: crypto.randomUUID(),
                    name,
                    references: original.references?.map(reference => ({ ...reference })),
                    logoAssetIds: original.logoAssetIds ? [...original.logoAssetIds] : undefined,
                    createdAt: now,
                    updatedAt: now,
                };
                docs.set(`brand:${duplicate.id}`, duplicate);
                return duplicate;
            });
            return NextResponse.json({ brand: saved }, { status: 201 });
        }
        if (input.project.format === "carousel" && input.project.slideCount < 2) throw new WorkflowError("Un carrusel necesita al menos dos diapositivas.");
        if (input.project.taskIds.length > input.project.slideCount) throw new WorkflowError("El proyecto contiene más tareas que diapositivas.");
        const saved = await store.transaction(docs => {
            if (!docs.has(`brand:${input.project.brandId}`)) throw new WorkflowError("Selecciona un sistema de diseño válido.");
            const previous = input.project.id ? docs.get(`social:${input.project.id}`) as SocialProject | undefined : undefined;
            if (input.project.id && !previous) throw new WorkflowError("No se encontró el proyecto.", 404);
            if (!previous && [...docs.keys()].filter(key => key.startsWith("social:")).length >= 500) throw new WorkflowError("El historial de proyectos está lleno.", 409);
            const now = Date.now();
            const project: SocialProject = { ...input.project, id: previous?.id ?? crypto.randomUUID(), createdAt: previous?.createdAt ?? now, updatedAt: now };
            docs.set(`social:${project.id}`, project);
            return project;
        });
        return NextResponse.json({ project: saved });
    } catch (error) {
        if (error instanceof z.ZodError) return NextResponse.json({ error: "Revisa los campos del formulario." }, { status: 400 });
        const status = error instanceof WorkflowError ? error.status : 500;
        return NextResponse.json({ error: error instanceof WorkflowError ? error.message : "No se pudo guardar el cambio." }, { status, headers: { "Cache-Control": "no-store" } });
    }
}
