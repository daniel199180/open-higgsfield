import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openRouterUsage, priceKey, UsageReportedError } from "../src/billing/usage";
import type { UsageRecord, PriceSelection } from "../src/billing/types";
import type { ProviderGenerationRequest, GenerationProvider } from "../src/providers/types";

test("usage parsing preserves real zero and rejects unknown, invalid and ambiguous charges", () => {
    assert.equal(openRouterUsage(null), undefined);
    assert.equal(openRouterUsage({ cost: null, tokens: 90, credits: 12, price: 0.4 }), undefined);
    assert.equal(openRouterUsage({ cost: -1, prompt_tokens: 1.5, completion_tokens: Infinity, total_tokens: "12" }), undefined);
    assert.deepEqual(openRouterUsage({ prompt_tokens: 0, completion_tokens: 1290, cost: 0 }), { inputTokens: 0, outputTokens: 1290, totalTokens: 1290, costUsd: 0 });
    assert.deepEqual(openRouterUsage({ completion_tokens: 1290 }), { inputTokens: undefined, outputTokens: 1290, totalTokens: undefined, costUsd: undefined });
});

test("billing persistence, pricing, auth and tracking with no paid requests", async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "higgs-billing-test-"));
    process.env.OPEN_HIGGSFIELD_STORAGE_DIR = directory;
    delete process.env.WORKFLOWS_DATABASE_URL;
    const { createSqliteBillingStore, billingStore } = await import("../src/billing/store");
    const { quoteEndpoints, imageQuote } = await import("../src/billing/pricing");
    const { trackedSubmit } = await import("../src/billing/tracking");
    const { accountUsage } = await import("../src/billing/accounts");
    const { GET: getSummary } = await import("../src/app/api/billing/route");
    const { GET: getPrice, POST: setPrice } = await import("../src/app/api/billing/price/route");
    const { NextRequest } = await import("next/server");
    t.after(async () => { await fs.rm(directory, { recursive: true, force: true }); });
    const selection: PriceSelection = { provider: "openrouter", connectionId: "connection-a", model: "google/gemini-nano-banana-2.1", resolution: "1K" };

    await t.test("Nano Banana estimates vary by model, resolution and live endpoint tariff", () => {
        const endpoints = [{ pricing: [{ billable: "output_image", unit: "token", cost_usd: 0.00003 }] }];
        const one = quoteEndpoints(selection, endpoints), four = quoteEndpoints({ ...selection, resolution: "4K" }, endpoints);
        assert.equal(one.outputTokens, 1120); assert.equal(one.minUsd, 1120 * 0.00003);
        assert.equal(four.outputTokens, 2520); assert.equal(four.minUsd, 2520 * 0.00003);
        assert.equal(quoteEndpoints({ ...selection, model: "google/gemini-2.5-flash-image" }, endpoints).outputTokens, 1290);
        assert.equal(quoteEndpoints({ ...selection, model: "unknown/token-model" }, endpoints).minUsd, undefined);
        assert.equal(quoteEndpoints({ ...selection, size: "2048x2048" }, endpoints).minUsd, undefined);
        assert.equal(quoteEndpoints({ ...selection, resolution: "8K" }, endpoints).minUsd, undefined);
    });
    await t.test("fixed/variant prices, compatible endpoints and unknown meters never become zero", () => {
        const pricing = [{ billable: "output_image", unit: "image", cost_usd: 0.04, variant: "1k" }, { billable: "output_image", unit: "image", cost_usd: 0.08, variant: "4k" }];
        assert.equal(quoteEndpoints(selection, [{ pricing }]).minUsd, 0.04);
        assert.equal(quoteEndpoints({ ...selection, resolution: "4K" }, [{ pricing }]).minUsd, 0.08);
        assert.equal(quoteEndpoints({ ...selection, resolution: undefined }, [{ pricing }]).minUsd, undefined);
        assert.equal(quoteEndpoints(selection, [{ pricing: [{ billable: "output_image", unit: "image", cost_usd: 0 }] }]).minUsd, 0);
        assert.equal(quoteEndpoints(selection, [{ pricing: [{ billable: "output_image", unit: "image", cost_usd: -1 }] }]).minUsd, undefined);
        assert.equal(quoteEndpoints(selection, [{ pricing }, { pricing: [] }]).minUsd, undefined);
        assert.equal(quoteEndpoints(selection, [{ supported_parameters: { resolution: { values: ["4K"] } }, pricing }]).minUsd, undefined);
    });
    await t.test("ledger is idempotent, cumulative, partial-aware and independent of gallery", async () => {
        const filename = path.join(directory, "ledger/usage.sqlite"), store = createSqliteBillingStore(filename);
        const row: UsageRecord = { id: "task-1", provider: "openrouter", connection: "a", model: "m", label: "Model", media: "image", source: "studio", created: new Date().toISOString(), status: "SUBMITTING", estimateMin: 0.05, estimateMax: 0.05 };
        await store.begin(row); await store.begin(row);
        await store.update(row.id, "IN_PROGRESS", { inputTokens: 10, totalTokens: 10 });
        const usage = { inputTokens: 10, outputTokens: 1290, totalTokens: 1300, costUsd: 0.04 };
        await store.update(row.id, "COMPLETED", usage); await store.update(row.id, "COMPLETED", usage);
        await store.update(row.id, "COMPLETED"); // later empty poll must not erase usage
        await store.begin({ ...row, id: "task-2" }); await store.update("task-2", "COMPLETED");
        await store.begin({ ...row, id: "task-3" }); await store.update("task-3", "UNCONFIRMED");
        await fs.writeFile(path.join(directory, "tasks_history.json"), "[]");
        const result = await createSqliteBillingStore(filename).summary(), group = result.groups[0];
        assert.equal(group.requests, 3); assert.equal(group.costUsd, 0.04); assert.equal(group.totalTokens, 1300);
        assert.equal(group.costKnown, 1); assert.equal(group.estimateMin, 0.05); assert.equal(group.estimated, 1);
        assert.equal(result.recent.length, 3);
        await store.begin({ ...row, id: "free", connection: "b" }); await store.update("free", "COMPLETED", { costUsd: 0, totalTokens: 0 });
        const free = (await store.summary()).groups.find(g => g.connection === "b")!;
        assert.equal(free.costUsd, 0); assert.equal(free.costKnown, 1);
    });
    await t.test("manual prices are scoped to connection/model/settings and do not alter actual usage", async () => {
        const s: PriceSelection = { ...selection, provider: "higgsfield" };
        await billingStore().setRate(priceKey(s), 0.06);
        assert.equal((await imageQuote(s)).source, "manual");
        assert.equal((await imageQuote(s)).minUsd, 0.06);
        assert.equal((await imageQuote({ ...s, connectionId: "another" })).minUsd, undefined);
        assert.equal((await imageQuote({ ...s, resolution: "4K" })).minUsd, undefined);
        await billingStore().setRate(priceKey(s), null);
        assert.equal((await imageQuote(s)).source, "unavailable");
    });
    await t.test("provider charge is durable before assets are processed; errors remain unknown", async () => {
        const provider: GenerationProvider = { id: "freepik", async submit() { return { status: "COMPLETED", assets: [], usage: { totalTokens: 120, costUsd: 0.03 } }; }, async poll() { throw new Error("not used"); } };
        const request = { mediaType: "image", modelId: "test", providerModelId: "test", capabilities: { label: "Test" }, params: { prompt: "not persisted", model_id: "test" }, media: {} } as ProviderGenerationRequest;
        await trackedSubmit("studio:success", "studio", provider, request);
        await assert.rejects(trackedSubmit("studio:timeout", "studio", { ...provider, async submit() { throw new Error("timeout"); } }, request));
        const records = (await billingStore().summary()).recent;
        assert.equal(records.find(r => r.id === "studio:success")?.costUsd, 0.03);
        assert.equal(records.find(r => r.id === "studio:timeout")?.costUsd, null);
        assert.equal(records.find(r => r.id === "studio:timeout")?.status, "UNCONFIRMED");
        assert.equal(JSON.stringify(records).includes("not persisted"), false);
        await assert.rejects(trackedSubmit("studio:bad-asset", "studio", { ...provider, async submit() { throw new UsageReportedError("ERR_NO_IMAGE_GENERATED", { costUsd: 0.07 }); } }, request));
        assert.equal((await billingStore().summary()).recent.find(r => r.id === "studio:bad-asset")?.costUsd, 0.07);
    });
    await t.test("API-key totals are sanitized and never merged into local expenses", async t => {
        t.mock.method(globalThis, "fetch", async (url: URL, options: RequestInit) => {
            assert.equal(url.href, "https://openrouter.ai/api/v1/key"); assert.equal(options.redirect, "error");
            return Response.json({ data: { usage: 0.107055, usage_daily: 0, usage_monthly: 0.1, label: "secret", hash: "secret", organization_id: "secret" } });
        });
        const accounts = await accountUsage([{ id: "a", name: "Test", provider: "openrouter", enabled: true, isDefault: true, credentials: { apiKey: "dummy-secret" }, config: {}, createdAt: "", updatedAt: "" }]);
        assert.equal(accounts[0].totalUsd, 0.107055); assert.equal(accounts[0].todayUsd, 0);
        assert.equal(JSON.stringify(accounts).includes("secret"), false);
        assert.equal((await billingStore().summary()).groups[0].costUsd, 0.1);
    });
    await t.test("billing reads require admin; tariff mutation also enforces origin", async () => {
        assert.equal((await getSummary(new NextRequest("http://localhost:3000/api/billing"))).status, 401);
        assert.equal((await getPrice(new NextRequest("http://localhost:3000/api/billing/price?provider=freepik&model=test"))).status, 401);
        assert.equal((await setPrice(new NextRequest("http://localhost:3000/api/billing/price", { method: "POST", headers: { origin: "https://attacker.invalid", "content-type": "application/json" }, body: "{}" }))).status, 403);
    });
});
