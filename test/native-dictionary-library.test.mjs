import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { Engine } from "../src/engine.mjs";
import { createHandler } from "../src/host.mjs";
import { normalizeQueryPlan, queryPlanPrompt } from "../src/query-plan.mjs";
import { dictionaryEntryIds, normalizeNativeArguments, nativeToolCompatibility, defaultDictionaryRecipe } from "../src/dictionary-defs.mjs";
import { dictionaryFingerprint } from "../src/dictionary-query.mjs";
import { importDictionary } from "../src/mcp-dictionary.mjs";

const trace = { name: "mcp_route_info_mcp_trace_path", description: "Trace between two observed endpoints", parameters: { type: "object", properties: { src_ip: { type: "string" }, dst_ip: { type: "string" }, max_hops: { type: "integer", minimum: 1 } }, required: ["src_ip", "dst_ip"] }, outputSchema: { type: "object", properties: { hops: { type: "array" } } }, annotations: { readOnlyHint: true } };
const other = { ...trace, name: "another_trace_path" };
const pg = { name: "pg_execute_sql", parameters: { type: "object", properties: { sql: { type: "string" } } } };
function fixture(t) {
  const store = new Store(":memory:"); t.after(() => store.close());
  const engine = new Engine({ store, credentials: {}, getIm: () => null }); engine.drain = () => {};
  store.saveSettings({ sources: [{ id: "source", enabled: true }], tasks: [] });
  const tools = [trace, other, pg];
  const handler = createHandler({ store, engine, credentials: {}, getIm: () => null, getTools: () => tools,
    validateDictionary: async (entry) => ({ status: "verified", toolFingerprint: dictionaryFingerprint(tools.find((tool) => tool.name === entry.tool)), rowCount: 1, fields: ["hops"], message: "fixture", elapsedMs: 1 }) });
  const create = async (tool = trace) => {
    const entry = await handler("dictionary.save", { name: tool.name, tool: tool.name });
    return await handler("dictionary.validate", { id: entry.id, revision: entry.revision, workspace: "/ops", sample: { arguments: { src_ip: "192.0.2.1", dst_ip: "198.51.100.2" } } });
  };
  return { store, engine, handler, tools, create };
}

test("discover and describe load native parameters without categories or MCP execution", async (t) => {
  const { handler, store } = fixture(t), before = store.getSettings();
  const found = await handler("dictionary.discover");
  assert.equal(found[0].purposes, undefined);
  assert.equal(found[0].nativeCompatible, true);
  assert.equal(found[2].nativeCompatible, false, "raw SQL requires the existing typed adapter");
  const detail = await handler("dictionary.describe", { tool: trace.name });
  assert.deepEqual(detail.inputSchema, trace.parameters);
  assert.deepEqual(detail.recipe.arguments, { src_ip: "{{alert.srcip}}", dst_ip: "{{alert.dstip}}" });
  assert.deepEqual(store.getSettings(), before);
  await assert.rejects(handler("dictionary.describe", { tool: "missing" }), /不可用/);
});

test("native saves infer execution mode and preserve only server-owned schema", async (t) => {
  const { handler } = fixture(t);
  const entry = await handler("dictionary.save", { name: "Route", tool: trace.name, inputSchema: { properties: { malicious: {} } }, outputSchema: { secret: true } });
  assert.equal(entry.purpose, "tool");
  assert.equal(entry.validation.status, "unverified");
  assert.deepEqual(entry.inputSchema, trace.parameters);
  assert.deepEqual(entry.outputSchema, trace.outputSchema);
  assert.deepEqual(entry.recipe.arguments, { src_ip: "{{alert.srcip}}", dst_ip: "{{alert.dstip}}" });
  const notes = await handler("dictionary.save", { name: "Data meanings", document: "human reviewed description" });
  assert.equal(notes.purpose, "reference");
  const updated = await handler("dictionary.save", { id: notes.id, revision: 1, tool: trace.name });
  assert.equal(updated.purpose, "tool");
  const offline = await handler("dictionary.save", { name: "Offline", tool: "offline_get_inventory", inputSchema: trace.parameters });
  assert.equal(offline.inputSchema, undefined, "unknown tool cannot inherit client-supplied schema");
});

test("flat selections allow multiple native entries and freeze their ordered snapshots", async (t) => {
  const { handler, store, engine, create } = fixture(t);
  const first = await create(trace), second = await create(other);
  const notes = await handler("dictionary.save", { name: "notes", document: "current snapshot only" });
  const plan = await handler("queryPlan.save", { name: "Route checks", config: { dictionaryIds: [second.id, notes.id, first.id] } });
  assert.deepEqual(plan.config.dictionaryIds, [second.id, notes.id, first.id]);
  await assert.rejects(handler("dictionary.delete", { id: second.id, revision: 1 }), /引用/);
  const task = await handler("task.save", { name: "routes", sourceIds: ["source"], workspace: "/ops", queryPlanId: plan.id });
  const run = engine.enqueue(task, 0, 1800000);
  assert.deepEqual(run.task.queryDictionary.map((entry) => entry.id), plan.config.dictionaryIds);
  await handler("dictionary.save", { id: first.id, revision: first.revision, description: "new interpretation" });
  assert.equal(store.run(run.id).task.queryDictionary[2].revision, 1);
  await handler("queryPlan.save", { id: plan.id, revision: plan.revision, name: "still selected", config: plan.config });
  await assert.rejects(handler("queryPlan.save", { name: "new reference", config: { dictionaryIds: [first.id] } }), /先通过/);
});

test("explicit empty selection differs from untouched legacy plans and removes forced template instructions", () => {
  const legacy = normalizeQueryPlan({ dictionaryBindings: { paths: "legacy-route" } });
  assert.equal(Object.hasOwn(legacy, "dictionaryIds"), false);
  assert.deepEqual(dictionaryEntryIds(legacy), ["legacy-route"]);
  const selected = normalizeQueryPlan({ dictionaryIds: [], dictionaryBindings: legacy.dictionaryBindings });
  assert.deepEqual(dictionaryEntryIds(selected), []);
  assert.match(queryPlanPrompt(selected), /字典为空时仅分析告警原文/);
  assert.doesNotMatch(queryPlanPrompt(selected), /先从本批告警提取源/);
  assert.match(queryPlanPrompt(legacy), /先从本批告警提取源/);
  const changed = normalizeQueryPlan({ instructions: "keep selection" }, { ...selected, dictionaryIds: ["a"] });
  assert.deepEqual(changed.dictionaryIds, ["a"]);
  assert.throws(() => normalizeQueryPlan({ dictionaryIds: ["a", "a"] }), /重复/);
});

test("changing a legacy tool to a native MCP clears stale templates but keeps task references and old runs", async (t) => {
  const { handler, store, engine } = fixture(t);
  const original = await handler("dictionary.save", { name: "old assets", purpose: "assets", tool: pg.name, recipe: defaultDictionaryRecipe("assets") });
  const checked = await handler("dictionary.validate", { id: original.id, revision: 1, workspace: "/ops", sample: { ips: ["192.0.2.1"] } });
  const plan = await handler("queryPlan.save", { name: "legacy plan", config: { dictionaryBindings: { assets: checked.id } } });
  const task = await handler("task.save", { name: "legacy task", sourceIds: ["source"], workspace: "/ops", queryPlanId: plan.id });
  const run = engine.enqueue(task, 0, 1800000);
  const changed = await handler("dictionary.save", { id: checked.id, revision: 1, purpose: "assets", tool: trace.name, recipe: checked.recipe });
  assert.equal(changed.purpose, "tool");
  assert.deepEqual(changed.recipe.arguments, { src_ip: "{{alert.srcip}}", dst_ip: "{{alert.dstip}}" });
  assert.equal(changed.validation.status, "unverified");
  assert.deepEqual(changed.inputSchema, trace.parameters);
  assert.equal(store.run(run.id).task.queryDictionary[0].purpose, "assets");
  assert.equal(Object.hasOwn(store.getSettings().queryPlans.find((p) => p.id === plan.id).config, "dictionaryIds"), false);
  await handler("queryPlan.save", { id: plan.id, revision: 1, name: plan.name, config: plan.config });
});

test("category-free documents import typed parameter templates and discard prior identity or schemas", () => {
  const source = '# Route\n\n## 工具\nmcp_route_info_mcp_trace_path\n\n## 调用参数\n```json\n{"src_ip":"{{alert.srcip}}","dst_ip":"{{alert.dstip}}"}\n```';
  const draft = importDictionary(source).drafts[0];
  assert.equal(draft.purpose, "tool");
  assert.deepEqual(draft.recipe.arguments, { src_ip: "{{alert.srcip}}", dst_ip: "{{alert.dstip}}" });
  const imported = importDictionary(JSON.stringify({ ...draft, id: "foreign", inputSchema: trace.parameters, validation: { status: "verified" } })).drafts[0];
  assert.equal(imported.id, undefined); assert.equal(imported.inputSchema, undefined); assert.equal(imported.validation, undefined);
});

test("native query descriptions and bounded arguments never grant command, SQL or credential capability", () => {
  for (const name of ["delete_records", "exec_shell", "read_cypher", "mcp_send_message", "restart_host"])
    assert.equal(nativeToolCompatibility({ ...trace, name }).compatible, false);
  assert.equal(nativeToolCompatibility({ ...trace, annotations: { readOnlyHint: false } }).compatible, false);
  assert.equal(nativeToolCompatibility({ ...trace, parameters: { type: "object", properties: { code: { type: "string" } } } }).compatible, false);
  assert.equal(nativeToolCompatibility({ name: "get_data", parameters: { type: "object", properties: { query: { type: "string", description: "SQL query to execute" } } } }).compatible, false);
  assert.equal(nativeToolCompatibility({ ...trace, description: "Execute arbitrary Cypher expressions" }).compatible, false);
  for (const value of [{ sql: "SELECT 1" }, { sqlQuery: "SELECT 1" }, { shell_command: "id" }, { query: { command: "id" } }, { token: "s" }, JSON.parse('{"__proto__":{"x":1}}'), { ips: Array(33).fill("192.0.2.1") }])
    assert.throws(() => normalizeNativeArguments(value), /参数|脚本|凭据/);
  assert.deepEqual(normalizeNativeArguments({ endpoints: [{ ip: "{{alert.ip}}" }], hops: 8 }), { endpoints: [{ ip: "{{alert.ip}}" }], hops: 8 });
});
