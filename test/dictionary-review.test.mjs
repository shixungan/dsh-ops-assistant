import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { Engine } from "../src/engine.mjs";
import { createHandler } from "../src/host.mjs";
import { normalizeDictionaryRecipe } from "../src/dictionary-defs.mjs";
import { dictionaryFingerprint, compileDictionaryQuery, validateDictionaryRows } from "../src/dictionary-query.mjs";
import { createEvidenceCollector } from "../src/query-evidence.mjs";

const tool = { name: "cmdb-custom-execute_sql", description: "Custom connection", parameters: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] } };
const legacyTool = { ...tool, name: "postgresql-switch-info-execute_sql" };
const editable = (entry) => { const { validation, ...fields } = entry; return fields; };

test("saved dictionary mapping and validated revision are used by newly queued inspections, independently of legacy binding", async (t) => {
  const store = new Store(":memory:"); t.after(() => store.close());
  const engine = new Engine({ store, credentials: {}, getIm: () => null }); engine.drain = () => {};
  store.saveSettings({ sources: [{ id: "s", enabled: true }], tasks: [] });
  const validatorCalls = [], calls = [];
  const handler = createHandler({ store, engine, credentials: {}, getIm: () => null, getTools: () => [tool, legacyTool],
    validateDictionary: async (entry, options) => {
      validatorCalls.push(compileDictionaryQuery(entry, options.sample, { validation: true }));
      return { status: "verified", toolFingerprint: dictionaryFingerprint(tool), rowCount: 1, fields: ["ip_address", "switch_hostname"], message: "结构通过" };
    } });
  const created = await handler("dictionary.save", { name: "Actual inventory", purpose: "assets", tool: tool.name, outputs: "The IP belongs to a host, not a switch", document: "Read specific projected aliases only", recipe: { table: "inventory.endpoints", columns: { ip_address: "host_ip", switch_hostname: "uplink_device" } } });
  const checked = await handler("dictionary.validate", { id: created.id, revision: 1, workspace: "/ops", sample: { ips: ["192.0.2.1"] } });
  const plan = await handler("queryPlan.save", { name: "Plan", config: { dictionaryBindings: { assets: checked.id }, bindings: { postgres: legacyTool.name } } });
  const task = await handler("task.save", { name: "Inspection", sourceIds: ["s"], workspace: "/ops", queryPlanId: plan.id });
  const first = engine.enqueue(task, 1000, 2000);
  first.alerts = [{ alertId: "s:1", title: "ping loss", host: "192.0.2.1" }];
  const collect = createEvidenceCollector({ invoke: async (name, args) => { calls.push({ name, args }); return [{ ip_address: "192.0.2.1", switch_hostname: null }]; } });
  const evidence = await collect({ run: first, task: first.task, schemas: [tool, legacyTool] });
  assert.equal(calls.length, 1); assert.equal(calls[0].name, tool.name);
  assert.match(calls[0].args.sql, /"inventory"\."endpoints"/);
  assert.match(calls[0].args.sql, /"uplink_device" AS "switch_hostname"/);
  assert.match(validatorCalls[0].sql, /LIMIT 5$/);
  assert.match(calls[0].args.sql, /LIMIT 257$/);
  assert.equal(evidence.dictionary[0].outputs, checked.outputs);
  assert.equal(evidence.dictionary[0].revision, 1);

  await handler("dictionary.save", { ...editable(checked), outputs: "Revised meaning" });
  const second = engine.enqueue(task, 2000, 3000); second.alerts = first.alerts;
  const blocked = await collect({ run: second, task: second.task, schemas: [tool, legacyTool] });
  assert.equal(calls.length, 1, "unverified explicit reference must not use legacy connection or cache");
  assert.equal(blocked.dictionary[0].status, "unverified");
  assert.equal(blocked.evidence.find((row) => row.id === "assets").status, "unavailable");
  const historical = await collect({ run: first, task: first.task, schemas: [tool, legacyTool] });
  assert.equal(historical.dictionary[0].outputs, checked.outputs, "queued snapshot stays on its original meaning");
  const changedTool = { ...tool, description: "Different MCP schema revision" };
  const drifted = await collect({ run: first, task: first.task, schemas: [changedTool, legacyTool] });
  assert.equal(drifted.dictionary[0].status, "schema_changed");
  assert.equal(calls.length, 1, "drift must be checked before cached evidence");
});

test("search parameter aliases and prototype keys cannot bypass limits or inject an object prototype", () => {
  for (const key of ["limit", "top_k", "topK", "max_results", "page_size", "offset", "numResults", "keyword", "query_text", "__proto__", "constructor"]) {
    const fixedArgs = JSON.parse(`{"${key}":1000}`);
    assert.throws(() => normalizeDictionaryRecipe("knowledge", { queryKey: "query", limitKey: "", fixedArgs }), /覆盖|凭据/, key);
  }
  assert.equal({}.polluted, undefined);
});

test("field validation refuses misleading assets and events even after a previously successful sample", async () => {
  assert.throws(() => validateDictionaryRows("assets", [{ ip_address: "192.0.2.1", switch_hostname: { name: "EDGE" } }]), /字段/);
  assert.throws(() => validateDictionaryRows("events", [{ kind: "interface", id: "1", host: "EDGE", event_time: "2026-11-13T00:00:00Z" }]), /字段/);
  assert.throws(() => validateDictionaryRows("paths", [{ src: "A", dst: "B", switches: [], links: ["not an object"] }]), /字段/);
});
