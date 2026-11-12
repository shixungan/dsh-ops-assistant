import test from "node:test";
import assert from "node:assert/strict";
import { createQueryRuntime } from "../src/query-runtime.mjs";
import { normalizeQueryPlan } from "../src/query-plan.mjs";

const schema = (name, properties) => ({ name, parameters: { type: "object", properties } });
const pg = schema("postgresql-switch-info-execute_sql", { sql: { type: "string" } });
const neo = schema("neo4j_readonly-read-cypher", { query: { type: "string" }, params: { type: "object" } });
const memory = schema("mcp__memos__search_memory", { query: { type: "string" }, limit: { type: "integer" } });
const knowledge = schema("enterprise-knowledge-base-search_knowledge", { query: { type: "string" }, limit: { type: "integer" } });
const fixtures = [pg, neo, memory, knowledge];
const assets = [{ ip_address: "192.0.2.10", switch_hostname: "EDGE", asset_name: "server", ip_mapping_ambiguous: false, terminal_location_ambiguous: false }];
const task = { id: "task", workspace: "/ops", queryPlan: normalizeQueryPlan() };
const run = { id: "run", start: 1794474000000, end: 1794475800000, alerts: [{ alertId: "s:1", host: "server", title: "ping ERR_LINK_FAILURE", raw: { tags: ["srcip=192.0.2.10", "dstip=198.51.100.20"] } }] };
const text = (value) => [{ type: "text", text: JSON.stringify(value) }];

function host(options = {}) {
  const definitions = new Map((options.schemas ?? fixtures).map((entry) => [entry.name, entry]));
  const calls = [], injected = [];
  const ctx = { tools: { schemas: () => [...definitions.values()], get: (name) => definitions.get(name) } };
  const rawResult = (name, args) => name === pg.name ? args.sql.includes("cmdb_online_ip_switch_port_current") ? assets : [] : [{ title: "confirmed case", content: "bounded evidence" }];
  let seenExecution;
  class Pipeline {
    constructor(context) { this.context = context; }
    async prepare(input) {
      const execution = { ...input, token: Symbol(input.callId) };
      const guard = this.context.testGuard;
      assert.equal(guard(execution), undefined);
      assert.equal(guard(execution), undefined, "rechecking the same execution is idempotent");
      assert.match(guard({ ...execution, token: Symbol("replay") }), /使用|许可|固定/);
      assert.match(guard({ ...execution, arguments: { ...execution.arguments, sql: "DROP TABLE assets" } }), /固定|方案/);
      assert.match(guard({ ...execution, agent: {} }), /当前巡检/);
      seenExecution = execution;
      return { kind: "dispatch", exec: execution };
    }
    async dispatch(exec) {
      calls.push({ name: exec.name, args: exec.arguments, signal: exec.signal, parent: exec.parent, rootCallId: exec.rootCallId, toolSet: exec.toolSet });
      const value = options.response ? await options.response(exec.name, exec.arguments, exec.signal) : rawResult(exec.name, exec.arguments);
      const rendered = options.rendered ? await options.rendered(exec.name, exec.arguments, value) : value;
      return { value, content: text(rendered), isError: false };
    }
    async complete(_exec, outcome) { return outcome; }
  }
  const sdk = {
    ToolExecutionPipeline: Pipeline,
    projectToolSchema: (definition) => ({ name: definition.name, parameters: definition.parameters }),
    executeToolBatch: async (input, pipeline) => {
      const results = [];
      for (const call of input.calls) {
        const prepared = await pipeline.prepare({ name: call.name, callId: call.id, arguments: JSON.parse(call.arguments), agent: input.agent, signal: input.signal });
        results.push({ callId: call.id, result: await pipeline.complete(prepared.exec, await pipeline.dispatch(prepared.exec)) });
      }
      if (options.batchThrow) throw options.batchThrow;
      return { results, ...(options.batchExtra ?? {}) };
    },
  };
  const attach = createQueryRuntime(ctx, { loadSdk: async () => sdk });
  const create = async (overrides = {}) => {
    const registered = new Map(), agent = { ctx: {}, inject: (message) => injected.push(message) };
    if (options.noInject) delete agent.inject;
    agent.ctx.tools = {
      restrict: (value) => { agent.restriction = value; },
      guard: (fn) => { agent.ctx.testGuard = fn; },
      register: (definition) => { registered.set(definition.name, definition); },
      setExecutor: (value) => { agent.executor = value; },
    };
    agent.registered = registered;
    const context = { toolCallsUsed: 0 }, signal = new AbortController().signal;
    const record = await attach(agent, { ...task, ...overrides }, context);
    const outer = { signal, agent, token: Symbol("outer"), callId: "outer-call", rootCallId: "root-call", toolSet: {}, deferContext() {}, concludeTurn() {} };
    return { agent, record, context, signal, outer, prepare: (changes = {}) => record.prepare({ ...run, ...changes }, signal, () => {}), lookup: (args, exec = {}) => registered.get("ops_lookup").execute(args, { ...outer, ...exec }) };
  };
  return { create, calls, injected, definitions, get seenExecution() { return seenExecution; } };
}

test("model sees only scoped lookup, fixed permits bind identity and are removed after use", async () => {
  const h = host(), f = await h.create();
  assert.deepEqual(f.agent.executor.describe([...fixtures, ...f.agent.registered.values()]).schemas.map((s) => s.name), ["ops_lookup"]);
  for (const name of [pg.name, "bash", "subagent", "schedule_create", "run_code"]) {
    assert.match(f.agent.ctx.testGuard({ name, agent: f.agent, token: Symbol(), callId: "guess", arguments: { sql: "SELECT * FROM secrets" } }), /固定|方案/);
  }
  await f.prepare();
  assert.ok(h.calls[0].args.sql.startsWith("SELECT"));
  assert.match(f.agent.ctx.testGuard(h.seenExecution), /固定|方案/);
  await assert.rejects(f.lookup({ kind: "memory" }), /当前巡检/);
  f.record.running = true;
  await assert.rejects(f.lookup({ kind: "memory", sql: "SELECT * FROM secrets" }), /无效/);
  assert.equal(h.calls.length, 2);
});

test("zero supplemental budget and format-only mode expose no model lookup capability", async () => {
  const h = host();
  const zero = await h.create({ queryPlan: { ...task.queryPlan, maxSupplementaryCalls: 0 } });
  assert.deepEqual(zero.agent.executor.describe([...zero.agent.registered.values()]).schemas, []);
  const format = await h.create({ formatOnly: true });
  assert.deepEqual(format.agent.executor.describe([...format.agent.registered.values()]).schemas, []);
  format.record.running = true;
  assert.match(format.agent.ctx.testGuard({ name: "ops_lookup", agent: format.agent, token: Symbol() }), /格式修正|结束/);
});

test("fixed evidence honors redacted final content instead of raw result.value", async () => {
  const h = host({
    response: async (_name, args) => args.sql?.includes("cmdb_online_ip_switch_port_current") ? [{ ...assets[0], asset_name: "RAW_SECRET" }] : [],
    rendered: async (_name, args) => args.sql?.includes("cmdb_online_ip_switch_port_current") ? [{ ...assets[0], asset_name: "REDACTED" }] : [],
  });
  const f = await h.create(), evidence = await f.prepare();
  assert.equal(JSON.stringify(evidence).includes("RAW_SECRET"), false);
  assert.equal(evidence.evidence[0].rows[0].asset_name, "REDACTED");
});

test("lookup renderer follows DSH render(args,value) and emits evidence", async () => {
  const h = host(), f = await h.create();
  const value = { id: "lookup-memory", status: "ok", rows: [{ text: "evidence" }] };
  assert.deepEqual(JSON.parse(f.agent.registered.get("ops_lookup").output.render({ kind: "memory" }, value)[0].text), value);
});

test("supplemental lookup derives bounded searches, preserves parent execution, reuses evidence and enforces budget", async () => {
  const h = host(), f = await h.create({ queryPlan: { ...task.queryPlan, maxSupplementaryCalls: 1 } });
  await f.prepare(); f.record.running = true;
  assert.equal((await f.lookup({ kind: "memory" })).status, "ok");
  const actual = h.calls.find((c) => c.name === memory.name);
  assert.match(actual.args.query, /server/); assert.equal(actual.args.limit, 3);
  assert.equal(actual.parent, f.outer.token); assert.equal(actual.rootCallId, "root-call"); assert.equal(actual.toolSet, f.outer.toolSet);
  assert.equal(f.context.toolCallsUsed, 1);
  assert.equal((await f.lookup({ kind: "memory" })).reused, true);
  assert.equal(h.calls.filter((c) => c.name === memory.name).length, 1);
  assert.match((await f.lookup({ kind: "knowledge" })).note, /用完/);
});

test("plain ping does not query manuals and missing required scopes are not guessed", async () => {
  const h = host(), f = await h.create();
  await f.prepare({ alerts: [{ ...run.alerts[0], title: "ping 丢包" }] }); f.record.running = true;
  assert.match((await f.lookup({ kind: "knowledge" })).note, /错误码/);
  assert.equal(h.calls.some((c) => c.name === knowledge.name), false);
  const scoped = { ...knowledge, parameters: { ...knowledge.parameters, required: ["query", "account_id"] } };
  const h2 = host({ schemas: [pg, neo, scoped] }), f2 = await h2.create();
  await f2.prepare(); f2.record.running = true;
  assert.match((await f2.lookup({ kind: "knowledge" })).note, /未配置的参数/);
  assert.equal(h2.calls.some((c) => c.name === knowledge.name), false);
});

test("asset cache crosses runs but actual connector replacement invalidates it", async () => {
  const h = host(); const f1 = await h.create(); await f1.prepare();
  const f2 = await h.create(); assert.equal((await f2.prepare({ id: "run-2" })).queries[0].cacheHit, true);
  assert.equal(h.calls.filter((c) => c.args.sql?.includes("cmdb_online_ip_switch_port_current")).length, 1);
  h.definitions.set(pg.name, { ...pg });
  const f3 = await h.create(); assert.equal((await f3.prepare({ id: "run-3" })).queries[0].cacheHit, false);
  assert.equal(h.calls.filter((c) => c.args.sql?.includes("cmdb_online_ip_switch_port_current")).length, 2);
});

test("prefetch policy messages are preserved, and absent context channel or conclude stops analysis", async () => {
  const message = { type: "text", text: "policy notice" };
  const h = host({ batchExtra: { additionalContexts: [message] } }), f = await h.create();
  await f.prepare(); assert.deepEqual(h.injected[0], message);
  const again = await h.create();
  assert.equal((await again.prepare({ id: "next-run" })).queries[0].cacheHit, false, "policy contexts must be evaluated again on later runs");
  const blocked = host({ noInject: true, batchExtra: { additionalContexts: [message] } }), b = await blocked.create();
  await assert.rejects(b.prepare(), /额外上下文/);
  const ended = host({ batchExtra: { concluded: true } }), e = await ended.create();
  await assert.rejects(e.prepare(), /结束本轮/);
});

test("failed prefetch preserves policy messages from its partial batch result", async () => {
  const message = { type: "text", text: "partial policy notice" };
  const error = Object.assign(new Error("batch interrupted"), { partial: { additionalContexts: [message] } });
  const h = host({ batchThrow: error }), f = await h.create();
  const result = await f.prepare();
  assert.deepEqual(h.injected[0], message);
  assert.equal(result.queries[0].status, "failed");
  assert.match(result.queries[0].note, /batch interrupted/);
});
