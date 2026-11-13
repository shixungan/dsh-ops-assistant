import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Store } from "../src/store.mjs";
import { Engine } from "../src/engine.mjs";
import { createHandler } from "../src/host.mjs";
import { createEvidenceCollector } from "../src/query-evidence.mjs";
import { dictionaryFingerprint } from "../src/dictionary-query.mjs";
import { analyzeRun, reportMarkdown } from "../src/analysis.mjs";

test("document import, verified plan selection and frozen semantics reach the actual analysis prompt and report", async (t) => {
  const store = new Store(":memory:"); t.after(() => store.close());
  const engine = new Engine({ store, credentials: {}, getIm: () => null }); engine.drain = () => {};
  const tool = { name: "fixture-execute_sql", description: "CMDB fixture", parameters: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] } };
  const handler = createHandler({ store, engine, credentials: {}, getIm: () => null, getTools: () => [tool],
    validateDictionary: async () => ({ status: "verified", toolFingerprint: dictionaryFingerprint(tool), rowCount: 1, fields: ["ip_address", "switch_hostname"], message: "fixture sample", elapsedMs: 1 }) });
  const imported = await handler("dictionary.import", { text: readFileSync(new URL("../playbooks/mcp-dictionary-template.md", import.meta.url), "utf8") });
  const draft = imported.drafts[0];
  assert.equal(draft.purpose, "assets");
  assert.equal(draft.recipe.table, "public.cmdb_online_ip_switch_port_current");
  assert.match(draft.timeSemantics, /当前采集快照/);
  assert.match(draft.relationships, /主机 IP 不等于交换机管理 IP/);
  const entry = await handler("dictionary.save", { ...draft, tool: tool.name });
  await handler("dictionary.validate", { id: entry.id, revision: entry.revision, workspace: "/ops", sample: { ips: ["192.0.2.10"] } });
  const plan = await handler("queryPlan.save", { name: "字典集成方案", config: { id: "general-evidence", dictionaryBindings: { assets: entry.id } } });
  const settings = store.getSettings(); settings.sources = [{ id: "source", enabled: true }]; store.saveSettings(settings);
  const task = await handler("task.save", { name: "集成巡检", sourceIds: ["source"], workspace: "/ops", queryPlanId: plan.id });
  const queued = engine.enqueue(task, 0, 1800000);
  const frozen = store.run(queued.id);
  assert.equal(frozen.task.queryDictionary[0].revision, 1);
  await handler("dictionary.save", { id: entry.id, revision: entry.revision, timeSemantics: "NEW_REVISION_SHOULD_NOT_LEAK" });
  frozen.alerts = [{ alertId: "source:1", host: "sample-host", title: "资产告警", raw: { ip_address: "192.0.2.10" } }];
  frozen.sources = [{ name: "source", status: "ok", count: 1 }];
  const calls = [];
  const collect = createEvidenceCollector({ invoke: async (name, args) => {
    calls.push({ name, args });
    if (args.sql.includes('"cmdb_online_ip_switch_port_current"')) return [{ ip_address: "192.0.2.10", switch_hostname: "EDGE-A", asset_name: "sample-host" }];
    return [];
  } });
  const prompts = [];
  const analyze = async (prompt) => {
    prompts.push(prompt);
    return JSON.stringify({ summary: "资产告警，原因尚未确认。", incidents: [{ title: "资产事件", alertIds: ["source:1"], assessment: "仅确认资产位置", evidence: ["本轮资产映射"], unknowns: ["根因未确认"], actions: ["核对本窗口指标"] }] });
  };
  analyze.prepare = (run, task, signal) => collect({ run, task, signal, schemas: [tool] });
  frozen.report = await analyzeRun(frozen, frozen.task, analyze, new AbortController().signal, () => {});
  assert.equal(prompts.length, 1, "dictionary knowledge does not add a model round");
  assert.match(prompts[0], /主机 IP 不等于交换机管理 IP/);
  assert.match(prompts[0], /当前采集快照/);
  assert.doesNotMatch(prompts[0], /NEW_REVISION_SHOULD_NOT_LEAK/);
  assert.equal(calls.length, 2, "one asset query plus the compatible legacy window query");
  assert.deepEqual(frozen.report.coveredIds, ["source:1"]);
  assert.match(reportMarkdown(frozen), /本次 MCP 数据字典/);
  assert.match(reportMarkdown(frozen), /主机 IP 到接入交换机 · 修订 1/);
  assert.equal(frozen.queryEvidence.dictionary[0].id, entry.id);
  assert.equal(store.getSettings().mcpDictionary.find((item) => item.id === entry.id).revision, 2);
});
