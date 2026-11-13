import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { Engine } from "../src/engine.mjs";
import { createHandler } from "../src/host.mjs";
import { dictionaryDraft, dictionaryEntry, importDictionary, migrateMcpDictionary, checkedValidation } from "../src/mcp-dictionary.mjs";
import { defaultDictionaryRecipe, normalizeDictionaryRecipe, normalizeDictionaryBindings } from "../src/dictionary-defs.mjs";

const tool = { name: "postgres_execute_sql", parameters: { type: "object", properties: { sql: { type: "string" } } } };
const valid = { status: "verified", toolFingerprint: "a".repeat(64), rowCount: 1, fields: ["ip_address", "switch_hostname"], elapsedMs: 5, message: "结构通过，语义须核对" };
const draft = { name: "CMDB", purpose: "assets", tool: tool.name, description: "资产定位", outputs: "ip_address 是主机 IP", recipe: { table: "public.assets", columns: { ip_address: "host_ip", switch_hostname: "leaf_name" } } };
const options = (entry) => ({ id: entry.id, revision: entry.revision, workspace: "/ops", sample: { ips: ["192.0.2.1"] } });
function fixture(t, validator = async () => valid) {
  const store = new Store(":memory:");
  const engine = new Engine({ store, credentials: {}, getIm: () => null }); engine.drain = () => {};
  store.saveSettings({ sources: [{ id: "source", enabled: true }], tasks: [] });
  t.after(() => store.close());
  const handler = createHandler({ store, engine, credentials: {}, getIm: () => null, getTools: () => [tool, { name: "command", parameters: {} }], validateDictionary: validator });
  return { store, engine, handler };
}
const edit = (entry, fields = {}) => { const { validation, ...rest } = entry; return { ...rest, ...fields }; };

test("dictionary migration is persistent, idempotent and preserves explicit emptiness and unrelated settings", (t) => {
  const { store } = fixture(t);
  const settings = store.getSettings();
  assert.equal(settings.mcpDictionary.length, 5);
  assert.equal(settings.mcpDictionary.every((entry) => entry.validation.status === "unverified" && !entry.tool), true);
  assert.deepEqual(store.getSettings(), settings);
  store.saveSettings({ sources: [], tasks: [] });
  assert.deepEqual(store.getSettings().mcpDictionary, settings.mcpDictionary);
  store.saveSettings({ sources: [], tasks: [], mcpDictionary: [] });
  store.saveSettings({ sources: [], tasks: [] });
  assert.deepEqual(store.getSettings().mcpDictionary, []);
  const migrated = migrateMcpDictionary({ sources: ["a"], custom: 7 }, { now: 50 });
  assert.equal(migrated.custom, 7);
  assert.deepEqual(migrateMcpDictionary(migrated, { now: 100 }), migrated);
  assert.throws(() => migrateMcpDictionary({ mcpDictionary: [ { id: "x" }, { id: "x" } ] }), /重复/);
});

test("dictionary CRUD rejects forged validation, stale revisions and referenced deletion/purpose changes", async (t) => {
  const { handler } = fixture(t);
  await assert.rejects(handler("dictionary.save", { ...draft, validation: valid }), /服务端/);
  const created = await handler("dictionary.save", draft);
  await assert.rejects(handler("queryPlan.save", { name: "bound", config: { dictionaryBindings: { assets: created.id } } }), /先通过/);
  const verified = await handler("dictionary.validate", options(created));
  assert.equal(verified.validation.status, "verified"); assert.equal(verified.validation.revision, 1);
  const plan = await handler("queryPlan.save", { name: "bound", config: { dictionaryBindings: { assets: created.id } } });
  await assert.rejects(handler("dictionary.delete", { id: created.id, revision: 1 }), /引用/);
  await assert.rejects(handler("dictionary.save", edit(verified, { purpose: "reference", recipe: {} })), /不能改变用途/);
  const changed = await handler("dictionary.save", edit(verified, { description: "修正字段语义" }));
  assert.equal(changed.validation.status, "unverified"); assert.equal(changed.revision, 2);
  await assert.rejects(handler("dictionary.save", edit(verified)), /刷新/);
  await handler("queryPlan.save", { ...plan, name: "保留原引用" });
  await assert.rejects(handler("queryPlan.save", { name: "another", config: { dictionaryBindings: { assets: changed.id } } }), /先通过/);
  await assert.rejects(handler("queryPlan.save", { name: "wrong", config: { dictionaryBindings: { events: changed.id } } }), /用途/);
  await handler("queryPlan.delete", { id: plan.id, revision: 2 });
  await assert.rejects(handler("dictionary.delete", { id: changed.id, revision: 1 }), /刷新/);
  await handler("dictionary.delete", { id: changed.id, revision: 2 });
  await assert.rejects(handler("dictionary.save", edit(changed)), /不存在/);
});

test("declarative recipes reject executable expressions, unknown fields, credential parameters and oversize inputs", () => {
  assert.throws(() => dictionaryDraft({ ...draft, document: "x".repeat(16001) }), /16000/);
  assert.throws(() => normalizeDictionaryRecipe("assets", { ...draft.recipe, table: "public.assets; DROP TABLE users" }), /标识符/);
  assert.throws(() => normalizeDictionaryRecipe("assets", { ...draft.recipe, columns: { ...draft.recipe.columns, ip_address: "ip::inet" } }), /标识符/);
  assert.throws(() => normalizeDictionaryRecipe("assets", { ...draft.recipe, sql: "select * from x" }), /无效字段/);
  assert.throws(() => normalizeDictionaryRecipe("events", { sources: [] }), /1—4/);
  assert.throws(() => normalizeDictionaryRecipe("paths", { ...defaultDictionaryRecipe("paths"), nodeLabel: "Switch) DELETE n" }), /标识符/);
  assert.throws(() => normalizeDictionaryRecipe("knowledge", { queryKey: "query", fixedArgs: { api_key: "secret" } }), /凭据/);
  assert.throws(() => normalizeDictionaryRecipe("memory", { queryKey: "query", fixedArgs: { query: "override" } }), /覆盖/);
  assert.throws(() => normalizeDictionaryBindings({ commands: "x" }), /无效字段/);
  assert.deepEqual(normalizeDictionaryRecipe("memory", { queryKey: "query_text", fixedArgs: { knowledge_base_id: "kb", tags: ["ops"] } }).fixedArgs, { knowledge_base_id: "kb", tags: ["ops"] });
});

test("document import only produces reviewable drafts and never imports IDs or verification", async (t) => {
  const { handler, store } = fixture(t);
  const before = store.getSettings();
  const json = await handler("dictionary.import", { text: JSON.stringify({ ...draft, id: "injected", revision: 80, validation: valid }) });
  assert.equal(json.drafts[0].id, undefined); assert.equal(json.drafts[0].validation, undefined);
  assert.deepEqual(json.drafts[0].recipe, draft.recipe);
  const markdown = "# My assets\n\n## 用途\nassets\n\n## 工具\npostgres_execute_sql\n\n## 数据对象\npublic.assets\n\n## 查询模板\n```json\n" + JSON.stringify(draft.recipe) + "\n```\n";
  const md = importDictionary(markdown).drafts[0];
  assert.equal(md.name, "My assets"); assert.equal(md.dataObjects, "public.assets"); assert.deepEqual(md.recipe, draft.recipe);
  assert.equal(md.document, markdown.trim());
  assert.equal(importDictionary("这是一份普通参考文档").drafts[0].purpose, "reference");
  assert.throws(() => importDictionary('{"x":'), /JSON/);
  assert.throws(() => importDictionary("x".repeat(64001)), /64000/);
  assert.deepEqual(store.getSettings(), before);
  const discovered = await handler("dictionary.discover");
  assert.equal(discovered[0].purposes, undefined);
  assert.deepEqual(discovered[0].inputSchema, tool.parameters);
  assert.equal(discovered[1].nativeCompatible, false);
  assert.equal(discovered[1].tool, "command");
});

test("empty validation is explicit and can be referenced without claiming sample semantics", async (t) => {
  const { handler } = fixture(t, async () => ({ ...valid, status: "empty", rowCount: 0, fields: [], message: "执行通过，样例为空，未验证行结构" }));
  const created = await handler("dictionary.save", draft);
  const validated = await handler("dictionary.validate", options(created));
  assert.equal(validated.validation.status, "empty");
  const plan = await handler("queryPlan.save", { name: "empty", config: { dictionaryBindings: { assets: created.id } } });
  assert.equal(plan.config.dictionaryBindings.assets, created.id);
  assert.throws(() => checkedValidation({ status: "verified", rowCount: 1 }, created), /结构指纹/);
});

test("validation cannot overwrite concurrent edits, unrelated settings, deletions or a second validation", async (t) => {
  let finish;
  const { handler, store } = fixture(t, () => new Promise((resolve) => { finish = resolve; }));
  const created = await handler("dictionary.save", draft);
  const pending = handler("dictionary.validate", options(created)); await Promise.resolve();
  await assert.rejects(handler("dictionary.validate", options(created)), /正在验证/);
  const changed = await handler("dictionary.save", edit(created, { name: "concurrent" }));
  finish(valid);
  await assert.rejects(pending, /期间.*变更/);
  assert.equal(store.getSettings().mcpDictionary.find((x) => x.id === created.id).validation.status, "unverified");
  const second = handler("dictionary.validate", options(changed)); await Promise.resolve();
  const unrelated = await handler("dictionary.save", { ...draft, name: "unrelated" });
  finish(valid); await second;
  assert.ok(store.getSettings().mcpDictionary.some((x) => x.id === unrelated.id));
  const third = handler("dictionary.validate", options(changed)); await Promise.resolve();
  await handler("dictionary.delete", { id: changed.id, revision: changed.revision });
  finish(valid); await assert.rejects(third, /期间.*变更/);
  assert.ok(!store.getSettings().mcpDictionary.some((x) => x.id === changed.id));
});

test("validation errors are recorded, cancellation preserves prior state, and invalid scope never invokes MCP", async (t) => {
  let called = 0;
  const { handler, store } = fixture(t, async (_entry, _opts, signal) => { called++; signal.throwIfAborted(); throw Error("permission denied"); });
  const created = await handler("dictionary.save", draft);
  await assert.rejects(handler("dictionary.validate", { ...options(created), workspace: "relative" }), /绝对/);
  await assert.rejects(handler("dictionary.validate", { ...options(created), revision: 9 }), /刷新/);
  assert.equal(called, 0);
  const failed = await handler("dictionary.validate", options(created));
  assert.equal(failed.validation.status, "failed"); assert.match(failed.validation.message, /permission denied/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(handler("dictionary.validate", options(created), abort.signal));
  assert.equal(called, 1);
  assert.deepEqual(store.getSettings().mcpDictionary.find((x) => x.id === created.id).validation, failed.validation);
});

test("run snapshots include selected dictionary revisions while list polling omits full documents and retries retain snapshots", async (t) => {
  const { handler, engine, store } = fixture(t);
  let entry = await handler("dictionary.save", { ...draft, document: "原始数据字典文档" });
  entry = await handler("dictionary.validate", options(entry));
  const plan = await handler("queryPlan.save", { name: "dict plan", config: { dictionaryBindings: { assets: entry.id } } });
  const task = await handler("task.save", { name: "task", sourceIds: ["source"], workspace: "/ops", queryPlanId: plan.id });
  const run = engine.enqueue(task, 1000, 2000);
  assert.equal(run.task.queryDictionary.length, 1); assert.equal(run.task.queryDictionary[0].document, "原始数据字典文档");
  await handler("dictionary.save", edit(entry, { document: "新文档" }));
  assert.equal(store.run(run.id).task.queryDictionary[0].revision, 1);
  assert.equal(engine.enqueue(task, 2000, 3000).task.queryDictionary[0].validation.status, "unverified");
  const state = await handler("state"); assert.equal(state.runs[0].task.queryDictionary, undefined);
  const historical = store.run(run.id); historical.status = "completed"; store.putRun(historical);
  const retry = engine.retry(run.id); assert.equal(retry.task.queryDictionary[0].document, "原始数据字典文档");
});
