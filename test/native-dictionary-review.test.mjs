import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { Engine } from "../src/engine.mjs";
import { createHandler } from "../src/host.mjs";
import { createDshAnalyzer } from "../src/dsh.mjs";
import { createQueryRuntime } from "../src/query-runtime.mjs";
import { defaultDictionaryRecipe } from "../src/dictionary-defs.mjs";

// Synthetic definitions exercise the entire RPC -> verification -> queued
// snapshot -> scoped model lookup path; no real MCP service is contacted.
const trace = { name: "fixture_trace_path", description: "Route between observed endpoints",
  parameters: { type: "object", properties: { src_ip: { type: "string", format: "ipv4" }, dst_ip: { type: "string", format: "ipv4" } }, required: ["src_ip", "dst_ip"], additionalProperties: false } };
const metrics = { name: "fixture_get_metrics", parameters: { type: "object", properties: { ip: { type: "string", format: "ipv4" }, from: { type: "integer" } }, required: ["ip", "from"], additionalProperties: false } };
const pg = { name: "postgresql-switch-info-execute_sql", parameters: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] } };
const neo = { name: "neo4j_readonly-read-cypher", parameters: { type: "object", properties: { query: { type: "string" }, params: { type: "object" } }, required: ["query", "params"] } };
const sample = { src_ip: "192.0.2.10", dst_ip: "198.51.100.20" };
const assets = [{ ip_address: sample.src_ip, switch_hostname: "EDGE-A" }, { ip_address: sample.dst_ip, switch_hostname: "EDGE-B" }];
const signal = () => new AbortController().signal;

function fixture(t) {
  const store = new Store(":memory:"); t.after(() => store.close());
  const engine = new Engine({ store, credentials: {}, getIm: () => null }); engine.drain = () => {};
  store.saveSettings({ sources: [{ id: "source", enabled: true }], tasks: [] });
  const schemas = structuredClone([trace, metrics, pg, neo]), agents = new Map(), dispatched = [], prepared = [], completed = [], prompts = [];
  let denied = false;
  const ctx = { tools: { schemas: () => schemas, get: (name) => schemas.find((s) => s.name === name) }, agents: { get: (id) => agents.get(id) }, sessionController: {
    async create() {
      const sessionId = `review-${agents.size + 1}`, registered = new Map(), agent = { ctx: {}, inject() {} };
      agent.ctx.tools = { restrict: (value) => { agent.restriction = value; }, guard: (fn) => { agent.guard = fn; }, register: (d) => registered.set(d.name, d), setExecutor: (e) => { agent.executor = e; } };
      agent.registered = registered; agents.set(sessionId, agent); return { sessionId };
    }, async rename() {}, async prompt(p) { prompts.push(p); },
  } };
  class Pipeline {
    async prepare(input) {
      const exec = { ...input, token: Symbol("policy-execution") };
      assert.equal(input.agent.guard(exec), undefined, "only plugin-issued arguments receive a permit");
      prepared.push(exec);
      if (denied) return { kind: "blocked", exec, isError: true, error: { message: "fixture policy denied" }, content: [] };
      return { kind: "dispatch", exec };
    }
    async dispatch(exec) {
      dispatched.push(exec);
      const value = exec.name === pg.name ? (exec.arguments.sql.includes("ip_address") ? assets : [])
        : exec.name === neo.name ? [{ src: "EDGE-A", dst: "EDGE-B", switches: [{ hostname: "EDGE-A" }, { hostname: "EDGE-B" }], links: [] }]
        : { observed: true, result: ["REDACTED"] };
      return { content: [{ type: "text", text: JSON.stringify(value) }], value: { private: "must-not-be-rendered" } };
    }
    async complete(exec, outcome) { completed.push(exec); return outcome; }
  }
  const sdk = { ToolExecutionPipeline: Pipeline, projectToolSchema: (x) => x, async executeToolBatch(input, pipeline) {
    const results = [];
    for (const call of input.calls) {
      const p = await pipeline.prepare({ agent: input.agent, name: call.name, arguments: JSON.parse(call.arguments), callId: call.id, signal: input.signal });
      results.push({ callId: call.id, result: await pipeline.complete(p.exec, p.kind === "dispatch" ? await pipeline.dispatch(p.exec) : p) });
    }
    return { results };
  } };
  const analyze = createDshAnalyzer(ctx, { loadSdk: async () => sdk });
  const handler = createHandler({ store, engine, credentials: {}, getIm: () => null, getTools: () => schemas, validateDictionary: analyze.validateDictionary });
  async function saveAndVerify(tool = trace, recipe) {
    const entry = await handler("dictionary.save", { name: tool.name, tool: tool.name, ...(recipe ? { recipe } : {}) });
    const checked = await handler("dictionary.validate", { id: entry.id, revision: entry.revision, workspace: "/ops", sample: { arguments: tool.name === metrics.name ? { ip: sample.dst_ip, from: 1000 } : sample } });
    assert.equal(checked.validation.status, "verified"); return checked;
  }
  async function queued(config) {
    const plan = await handler("queryPlan.save", { name: "review plan", config });
    const task = await handler("task.save", { name: "review task", sourceIds: ["source"], workspace: "/ops", queryPlanId: plan.id });
    const run = engine.enqueue(task, 1000, 1801000);
    run.alerts = [
      { alertId: "source:1", title: "ping loss", host: "probe", raw: { tags: [`srcip=${sample.src_ip}`, `dstip=${sample.dst_ip}`] } },
      { alertId: "source:2", title: "ping loss", host: "probe", raw: { labels: { srcip: "192.0.2.11", dstip: "198.51.100.21" } } },
    ];
    return { plan, task, run };
  }
  async function start(run) {
    const { sessionId } = await ctx.sessionController.create(), agent = agents.get(sessionId), context = { toolCallsUsed: 0 };
    const record = await createQueryRuntime(ctx, { loadSdk: async () => sdk })(agent, run.task, context);
    await record.prepare(run, signal()); record.running = true;
    const exec = { agent, token: Symbol("outer"), callId: "outer", toolSet: {}, signal: signal(), deferContext() {}, concludeTurn() {} };
    return { agent, record, lookup: (args) => agent.registered.get("ops_lookup").execute(args, exec) };
  }
  return { handler, store, engine, schemas, dispatched, prepared, completed, prompts, saveAndVerify, queued, start, deny: () => { denied = true; } };
}

test("saved category-free entries verify and freeze before model lookup fills the chosen alert", async (t) => {
  const h = fixture(t), route = await h.saveAndVerify(), metric = await h.saveAndVerify(metrics, { arguments: { ip: "{{alert.dstip}}", from: "{{window.start}}" } });
  assert.equal(route.purpose, "tool"); assert.deepEqual(route.inputSchema, trace.parameters);
  assert.equal(h.prompts.length, 0, "verification must not run a model");
  const { run } = await h.queued({ dictionaryIds: [metric.id, route.id], maxSupplementaryCalls: 3 });
  assert.deepEqual(run.task.queryDictionary.map((e) => e.id), [metric.id, route.id]);
  await h.handler("dictionary.save", { id: route.id, revision: route.revision, description: "later edit" });
  assert.equal(run.task.queryDictionary[1].revision, 1, "queued run keeps its verified revision");
  h.dispatched.length = 0;
  const f = await h.start(run); assert.equal(h.dispatched.length, 0, "native-only plan never prefetches legacy data");
  const result = await f.lookup({ entryId: route.id, alertId: "source:2" });
  await f.lookup({ entryId: metric.id, alertId: "source:1" });
  assert.deepEqual(h.dispatched.map((e) => [e.name, e.arguments]), [[trace.name, { src_ip: "192.0.2.11", dst_ip: "198.51.100.21" }], [metrics.name, { ip: sample.dst_ip, from: 1000 }]]);
  assert.equal(result.status, "ok"); assert.doesNotMatch(JSON.stringify(result), /must-not-be-rendered/);
  assert.deepEqual(f.agent.executor.describe([...h.schemas, ...f.agent.registered.values()]).schemas.map((s) => s.name), ["ops_lookup"]);
});

test("an explicit empty selection suppresses existing fallback tools and a nonempty selection excludes other entries", async (t) => {
  const h = fixture(t), route = await h.saveAndVerify(), metric = await h.saveAndVerify(metrics, { arguments: { ip: "{{alert.dstip}}", from: "{{window.start}}" } });
  h.dispatched.length = 0;
  const empty = await h.queued({ dictionaryIds: [] }), emptyRuntime = await h.start(empty.run);
  assert.equal(h.dispatched.length, 0); assert.deepEqual(emptyRuntime.agent.restriction.allow, []);
  assert.deepEqual(emptyRuntime.agent.executor.describe([...emptyRuntime.agent.registered.values()]).schemas, []);
  const selected = await h.queued({ dictionaryIds: [route.id] }), selectedRuntime = await h.start(selected.run);
  await assert.rejects(selectedRuntime.lookup({ entryId: metric.id, alertId: "source:1" }), /未被.*选中/);
  assert.equal(h.dispatched.length, 0); assert.deepEqual(selectedRuntime.agent.restriction.allow, [trace.name]);
});

test("a legacy path slot converted to native keeps its plan and other fallback queries without executing old Cypher", async (t) => {
  const h = fixture(t);
  const path = await h.handler("dictionary.save", { name: "legacy path", purpose: "paths", tool: neo.name, recipe: defaultDictionaryRecipe("paths") });
  const verified = await h.handler("dictionary.validate", { id: path.id, revision: path.revision, workspace: "/ops", sample: { pairs: [{ src: "EDGE-A", dst: "EDGE-B" }] } });
  assert.equal(verified.validation.status, "verified");
  const { plan, task } = await h.queued({ dictionaryBindings: { paths: path.id } });
  const converted = await h.handler("dictionary.save", { id: path.id, revision: path.revision, tool: trace.name });
  assert.equal(converted.purpose, "tool"); assert.equal(converted.validation.status, "unverified");
  await h.handler("dictionary.validate", { id: path.id, revision: converted.revision, workspace: "/ops", sample: { arguments: sample } });
  const livePlan = h.store.getSettings().queryPlans.find((p) => p.id === plan.id);
  assert.deepEqual(livePlan, plan, "changing an entry does not rewrite the plan or its revision");
  const run = h.engine.enqueue(task, 2000000, 3800000);
  run.alerts = [{ alertId: "source:3", title: "ping loss", host: "probe", raw: { labels: { srcip: sample.src_ip, dstip: sample.dst_ip } } }];
  assert.equal(Object.hasOwn(run.task.queryPlan, "dictionaryIds"), false);
  h.dispatched.length = 0;
  const f = await h.start(run);
  assert.ok(h.dispatched.some((e) => e.name === pg.name), "untouched legacy slots retain fallback behavior");
  assert.equal(h.dispatched.some((e) => e.name === neo.name), false);
  assert.equal((await f.lookup({ entryId: path.id, alertId: "source:3" })).status, "ok");
  assert.equal(h.dispatched.at(-1).name, trace.name);
});

test("schema drift blocks a saved snapshot and native lookup still obeys the DSH policy stages", async (t) => {
  const h = fixture(t), route = await h.saveAndVerify(), { run } = await h.queued({ dictionaryIds: [route.id] });
  h.dispatched.length = 0; h.prepared.length = 0; h.completed.length = 0;
  h.schemas[0].parameters.required.push("new_parameter");
  const stale = await h.start(run);
  assert.equal((await stale.lookup({ entryId: route.id, alertId: "source:1" })).status, "unavailable");
  assert.equal(h.prepared.length, 0, "schema fingerprint failure never reaches the tool pipeline");
  h.schemas[0] = structuredClone(trace);
  const current = await h.start(run); h.deny();
  const result = await current.lookup({ entryId: route.id, alertId: "source:1" });
  assert.equal(result.status, "failed"); assert.match(result.note, /policy denied/);
  assert.equal(h.prepared.length, 1); assert.equal(h.completed.length, 1); assert.equal(h.dispatched.length, 0);
  assert.match(current.agent.guard(h.prepared[0]), /固定/, "a completed call no longer has an execution permit");
});
