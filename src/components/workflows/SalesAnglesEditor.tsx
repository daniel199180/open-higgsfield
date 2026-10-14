"use client";
/* eslint-disable @next/next/no-img-element -- Private authenticated workflow assets must not use the shared image optimizer. */
import { useState } from "react";
import { ArrowDown, ArrowUp, Copy, Download, Plus, Trash2 } from "lucide-react";
import type { ModelCapabilities } from "@/models/capabilities/types";
import type { BrandSystem } from "@/social/types";
import { angleFormatOptions, angleFormats, angleFormatKey, angleGenerationCount, rasterAngleModel } from "@/workflows/sales-angles";
import { MAX_GENERATIONS, statusLabels, type AngleFormat, type NodeRun, type SalesAngle } from "@/workflows/types";
import { GenerationPrice } from "@/components/studio/GenerationPrice";

type Props = {
    angles: SalesAngle[];
    models: ModelCapabilities[];
    brands: BrandSystem[];
    state?: NodeRun;
    disabled: boolean;
    busy: boolean;
    onChange: (angles: SalesAngle[]) => void;
    onAction: (action: "resume" | "retry") => void;
};

export function SalesAnglesEditor({ angles, models, brands, state, disabled, busy, onChange, onAction }: Props) {
    const [priceId, setPriceId] = useState<string | null>(null);
    const requestCount = angles.reduce((total, angle) => total + angleGenerationCount(angle), 0);
    const update = (id: string, patch: Partial<SalesAngle>) => onChange(angles.map(angle => angle.id === id ? { ...angle, ...patch } : angle));
    const setFormats = (angle: SalesAngle, formats: AngleFormat[]) => update(angle.id, {
        formatField: formats[0]?.formatField ?? "aspect_ratio",
        format: formats[0]?.format ?? "",
        additionalFormats: formats.slice(1),
    });
    const move = (index: number, direction: number) => {
        const target = index + direction;
        if (target < 0 || target >= angles.length) return;
        const next = [...angles]; [next[index], next[target]] = [next[target], next[index]]; onChange(next);
    };
    const add = () => onChange([...angles, { id: crypto.randomUUID(), text: "", modelId: "", formatField: "aspect_ratio", format: "" }]);
    return <div className="wf-angles-editor">
        <p className="wf-muted">Elige varios formatos dentro de un ángulo. Se genera una imagen por formato y se conserva el mismo mensaje y sistema de diseño. Si el modelo admite referencias, las variantes usan la primera imagen para mantener la composición.</p>
        {angles.map((angle, index) => {
            const model = models.find(item => item.id === angle.modelId);
            const formats = model ? angleFormatOptions(model) : [];
            const selectedFormats = angleFormats(angle).filter(item => !!item.format);
            const resolutions = model?.resolution_variant && model.resolution_variant.options?.length ? model.resolution_variant.options : model?.custom_fields.find(field => field.id === "resolution" && field.type === "select")?.options ?? [];
            const result = state?.angles?.[angle.id];
            return <div className="wf-angle-card" key={angle.id}>
                <div className="wf-angle-card-header"><strong>Ángulo {index + 1}</strong>{!disabled && <div className="wf-angle-actions">
                    <button type="button" title="Mover arriba" aria-label={`Mover ángulo ${index + 1} arriba`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={13} /></button>
                    <button type="button" title="Mover abajo" aria-label={`Mover ángulo ${index + 1} abajo`} disabled={index === angles.length - 1} onClick={() => move(index, 1)}><ArrowDown size={13} /></button>
                    <button type="button" title="Duplicar" aria-label={`Duplicar ángulo ${index + 1}`} disabled={requestCount + angleGenerationCount(angle) > MAX_GENERATIONS} onClick={() => onChange([...angles.slice(0, index + 1), { ...angle, id: crypto.randomUUID() }, ...angles.slice(index + 1)])}><Copy size={13} /></button>
                    <button type="button" title="Eliminar" aria-label={`Eliminar ángulo ${index + 1}`} disabled={angles.length === 1} onClick={() => onChange(angles.filter(item => item.id !== angle.id))}><Trash2 size={13} /></button>
                </div>}</div>
                <label>Ángulo de venta<textarea rows={3} maxLength={2000} disabled={disabled} value={angle.text} placeholder="Ej.: Ahorra tiempo sin perder calidad" onChange={event => update(angle.id, { text: event.target.value })} /></label>
                <label>Modelo de imagen<select disabled={disabled} value={angle.modelId} onChange={event => {
                    const selected = models.find(item => item.id === event.target.value);
                    const first = selected && angleFormatOptions(selected)[0];
                    update(angle.id, { modelId: event.target.value, formatField: first?.field ?? "aspect_ratio", format: first?.value ?? "", additionalFormats: [], resolution: undefined });
                }}><option value="">Elige un modelo</option>{models.filter(item => ["openrouter", "higgsfield", "apimart"].includes(item.provider ?? "") && rasterAngleModel(item)).map(item => <option value={item.id} key={item.id}>{item.group} · {item.label}</option>)}</select></label>
                {model && <div className="wf-format-group"><span>Formatos/tamaños · {selectedFormats.length} seleccionado{selectedFormats.length === 1 ? "" : "s"}</span><div className="wf-format-options" role="group" aria-label={`Formatos del ángulo ${index + 1}`}>{formats.map(option => {
                    const selected = selectedFormats.some(item => item.formatField === option.field && item.format === option.value);
                    return <label className={`wf-format-choice ${selected ? "wf-format-selected" : ""}`} key={`${option.field}:${option.value}`}><input type="checkbox" disabled={disabled || (!selected && requestCount >= MAX_GENERATIONS)} checked={selected} onChange={event => {
                        const next = event.target.checked ? [...selectedFormats, { formatField: option.field, format: option.value }] : selectedFormats.filter(item => angleFormatKey(item) !== angleFormatKey({ formatField: option.field, format: option.value }));
                        setFormats(angle, next);
                    }} />{option.label}</label>;
                })}</div></div>}
                {!!resolutions.length && <label>Resolución<select disabled={disabled} value={angle.resolution ?? ""} onChange={event => update(angle.id, { resolution: event.target.value || undefined })}><option value="">Predeterminada del modelo</option>{resolutions.map(item => <option value={item} key={item}>{item}</option>)}</select></label>}
                <label>Sistema de diseño<select disabled={disabled} value={angle.brandId ?? ""} onChange={event => update(angle.id, { brandId: event.target.value || undefined })}><option value="">Sin sistema de diseño</option>{brands.map(brand => <option value={brand.id} key={brand.id}>{brand.name}</option>)}</select></label>
                {angle.brandId && <p className="wf-muted">La paleta, tipografía y reglas de marca se aplican al prompt. El logo se adjunta si el modelo admite imagen de referencia.</p>}
                {model && angle.format && !disabled && <div className="wf-angle-actions"><button type="button" onClick={() => setPriceId(priceId === angle.id ? null : angle.id)}>Ver precio por formato</button></div>}
                {model && priceId === angle.id && !disabled && selectedFormats.map(format => <div key={angleFormatKey(format)} className="wf-format-price"><strong>{format.format}</strong><GenerationPrice model={model} aspectRatio={format.formatField === "aspect_ratio" ? format.format : undefined} size={format.formatField === "size" ? format.format : undefined} resolution={angle.resolution} /></div>)}
                {result && <div className={`wf-status wf-status-${result.status}`} role="status">{statusLabels[result.status]}</div>}
                {result?.error && <p className="wf-warning">{result.error}</p>}
                {result?.formats ? selectedFormats.map(format => {
                    const formatState = result.formats?.[angleFormatKey(format)];
                    return <div className="wf-format-result" key={angleFormatKey(format)}><strong>{format.format}</strong><span className={`wf-status wf-status-${formatState?.status ?? "pending"}`}>{statusLabels[formatState?.status ?? "pending"]}</span>{formatState?.error && <p className="wf-warning">{formatState.error}</p>}{formatState?.value?.assetIds?.map(id => <div className="wf-result" key={id}><img src={`/api/workflows/assets/${id}`} alt={`Ángulo ${index + 1} en ${format.format}`} /><a className="wf-button" href={`/api/workflows/assets/${id}?download=1`}><Download size={14} />Descargar {format.format}</a></div>)}</div>;
                }) : result?.value?.assetIds?.map(id => <div className="wf-result" key={id}><img src={`/api/workflows/assets/${id}`} alt={`Resultado de ángulo ${index + 1}`} /><a className="wf-button" href={`/api/workflows/assets/${id}?download=1`}><Download size={14} />Descargar</a></div>)}
            </div>;
        })}
        {!disabled && <button type="button" className="wf-button" disabled={requestCount >= MAX_GENERATIONS} onClick={add}><Plus size={15} />Añadir ángulo</button>}
        {!disabled && <p className="wf-muted">{requestCount} solicitud{requestCount === 1 ? "" : "es"} para este bloque · máximo {MAX_GENERATIONS} por ejecución, incluyendo otros bloques generativos.</p>}
        {state?.canResume && <button className="wf-button" disabled={busy} onClick={() => onAction("resume")}>Consultar resultado sin generar de nuevo</button>}
        {state?.canRetry && <button className="wf-button" disabled={busy} onClick={() => onAction("retry")}>Reintentar ángulo fallido</button>}
    </div>;
}
