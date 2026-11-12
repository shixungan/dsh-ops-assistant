import test from "node:test";
import assert from "node:assert/strict";
import { normalizeQueryPlan, resolveQueryBindings, compatibleQueryTool, queryPlanPrompt } from "../src/query-plan.mjs";
import { createEvidenceCollector, parseEvidenceRows, assetQuery, eventQuery, pathQuery } from "../src/query-evidence.mjs";

const pg = { name: "mcp__postgresql_switch_info__execute_sql", parameters: { properties: { sql: { type: "string" } } } };
const neo = { name: "mcp__neo4j_readonly__read_cypher", parameters: { properties: { query: { type: "string" }, params: { type: "object" } } } };
const kb = { name: "enterprise-knowledge-base-search_knowledge", inputSchema: { properties: { query: { type: "string" } } } };
const schemas = [pg, neo, kb];
const ping = { alertId: "s:1", title: "IDC ping 丢包", raw: { tags: ["srcip=192.0.2.10", "dstip=198.51.100.20"] } };
const run = { id: "r1", start: 1794474000000, end: 1794475800000, alerts: [ping, { ...ping, alertId: "s:2" }] };
const task = { id: "t1", workspace: "/ops", queryCacheScope: "one", queryPlan: normalizeQueryPlan() };
const assets = [
  { ip_address: "192.0.2.10", asset_name: "src", switch_hostname: "SRC", ip_mapping_ambiguous: false, terminal_location_ambiguous: false, cmdb_observed_at: "2026-11-12 17:00:00+08", arp_online: true },
  { ip_address: "198.51.100.20", asset_name: "dst", switch_hostname: "DST", ip_mapping_ambiguous: false, terminal_location_ambiguous: false },
];
function fixture(options = {}) {
  const calls = [];
  const collect = createEvidenceCollector({
    now: options.now,
    invoke: async (name, args, signal) => {
      calls.push({ name, args, signal });
      if (options.invoke) return options.invoke(name, args, signal);
      if (args.sql?.includes("cmdb_online_ip_switch_port_current")) return { content: [{ type: "text", text: JSON.stringify(options.assets ?? assets) }] };
      if (name === neo.name) return [{ src: "SRC", dst: "DST", switches: [{ hostname: "SRC" }, { hostname: "MID" }, { hostname: "DST" }], links: [] }];
      return [];
    },
  });
  const execute = (overrides = {}) => collect({ run, task, schemas, signal: new AbortController().signal, ...overrides });
  return { calls, execute };
}

test("query plans normalize defaults and reject invalid budgets, versions and bindings", () => {
  assert.equal(task.queryPlan.id, "network-ping");
  assert.equal(task.queryPlan.assetCacheSeconds, 300);
  for (const patch of [{ id: "arbitrary-sql" }, { version: 2 }, { queryTimeoutSeconds: 0 }, { maxSupplementaryCalls: 7 }, { assetCacheSeconds: -1 }, { bindings: { postgres: "x\ny" } }])
    assert.throws(() => normalizeQueryPlan(patch));
  assert.match(queryPlanPrompt({ instructions: "" }), /先从本批告警提取源/);
  assert.match(queryPlanPrompt({ instructions: "仅关注网络" }), /先从本批告警提取源[\s\S]+用户补充排查规则：[\s\S]+仅关注网络/);
});

test("purpose bindings prefer known connectors, reject incorrect schemas and do not guess ambiguous tools", () => {
  const resolved = resolveQueryBindings(task.queryPlan, schemas);
  assert.equal(resolved.bindings.postgres, pg.name);
  assert.equal(resolved.bindings.neo4j, neo.name);
  assert.equal(resolved.bindings.knowledge, kb.name);
  assert.equal(resolved.bindings.memory, "");
  assert.equal(compatibleQueryTool("postgres", { name: pg.name }), false);
  assert.equal(compatibleQueryTool("neo4j", { ...neo, name: "neo4j-write-cypher" }), false);
  const other = { ...pg, name: "other-execute_sql" };
  assert.equal(resolveQueryBindings({}, [pg, other]).bindings.postgres, pg.name);
  assert.equal(resolveQueryBindings({}, [other, { ...other, name: "another-execute_sql" }]).bindings.postgres, "");
  assert.equal(resolveQueryBindings({ bindings: { postgres: "bash" } }, schemas).bindings.postgres, "");
  assert.equal(resolveQueryBindings({ bindings: { postgres: other.name } }, [pg, other]).bindings.postgres, other.name);
});

test("MCP parser supports JSON envelopes and real PostgreSQL Python literals without executing code", () => {
  const expected = [{ name: "a'b", active: true, missing: null, negative: -1, text: "line\n二" }];
  assert.deepEqual(parseEvidenceRows({ structuredContent: { result: [{ type: "text", text: "[{'name': 'a\\'b', 'active': True, 'missing': None, 'negative': -1, 'text': 'line\\n二'}]" }] } }), expected);
  assert.deepEqual(parseEvidenceRows({ content: [{ type: "text", text: '{"rows":[]}' }] }), []);
  assert.deepEqual(parseEvidenceRows("[{'ok': False, 'n': 0, 'f': 1.25}]"), [{ ok: false, n: 0, f: 1.25 }]);
  for (const bad of ["__import__('os').system('bad')", "[{'x': datetime.datetime(2026,1,1)}]", "<html>login</html>", "[{'x': 'unterminated}]", "null", "{}", { isError: true, content: [] }])
    assert.throws(() => parseEvidenceRows(bad));
});

test("fixed templates scope validated IPs, bound multi-hop paths and half-open window events", () => {
  assert.throws(() => assetQuery(["x'); DROP TABLE x;--"]));
  assert.match(assetQuery(["::1"]).sql, /::inet/);
  const query = eventQuery(["a'b\\c"], run.start, run.end).sql;
  assert.match(query, /E'a''b\\\\c'/);
  assert.match(query, /observed_at >= '2026-11-12T09:00:00.000Z'/);
  assert.match(query, /observed_at < '2026-11-12T09:30:00.000Z'/);
  assert.match(query, /text_truncated/);
  assert.match(pathQuery([{ src: "a", dst: "b" }]).query, /CONNECTED_TO\*0\.\.8/);
});

test("empty runs perform no MCP calls and preserve the versioned plan identity", async () => {
  const f = fixture(); const result = await f.execute({ run: { ...run, alerts: [] } });
  assert.equal(f.calls.length, 0);
  assert.equal(result.plan.name, "Ping 丢包与跨机房路径");
});

test("ping batches deduplicate endpoints, query mapped multi-hop devices, and expose timing", async () => {
  const f = fixture(); const result = await f.execute();
  assert.equal(f.calls.length, 3);
  assert.equal((f.calls[0].args.sql.match(/192\.0\.2\.10/g) ?? []).length, 1);
  assert.deepEqual(f.calls[1].args.params.pairs, [{ src: "SRC", dst: "DST" }]);
  assert.match(f.calls[2].args.sql, /E'MID'/);
  assert.equal(result.queries.length, 3);
  assert.ok(result.queries.every((q) => q.status === "ok" && Number.isFinite(q.elapsedMs)));
  assert.equal(result.evidence[0].rows[0].arp_online, undefined, "cached mappings must not cache live online status");
  assert.match(result.evidence.find((e) => e.id === "paths").note, /不等于真实流量路径/);
  assert.match(result.evidence.find((e) => e.id === "events").note, /入库时间/);
});

test("only stable asset mappings are cached, expiry and task/connector scope changes invalidate them", async () => {
  let clock = 0; const f = fixture({ now: () => clock });
  await f.execute(); clock += 1000;
  const hit = await f.execute({ run: { ...run, id: "r2" } });
  assert.equal(hit.queries[0].cacheHit, true);
  assert.equal(f.calls.length, 5, "path and event evidence must refresh for every run");
  clock += 301000;
  assert.equal((await f.execute()).queries[0].cacheHit, false);
  assert.equal((await f.execute({ task: { ...task, id: "other" } })).queries[0].cacheHit, false);
  assert.equal((await f.execute({ task: { ...task, queryCacheScope: "changed" } })).queries[0].cacheHit, false);
});

test("ambiguous asset mappings are retained and never silently used as a unique route", async () => {
  const f = fixture({ assets: [...assets, { ...assets[0], switch_hostname: "OTHER", ip_mapping_ambiguous: true }] });
  const result = await f.execute();
  assert.equal(result.evidence[0].rows.length, 3);
  assert.ok(result.evidence.some((e) => /歧义/.test(e.note)));
  assert.equal(f.calls.some((c) => c.name === neo.name), false);
});

test("policy-dependent asset responses explicitly opt out of cross-run caching", async () => {
  const f = fixture({ invoke: async (_name, args) => ({
    content: [{ type: "text", text: JSON.stringify(args.sql?.includes("cmdb_online_ip_switch_port_current") ? assets : []) }],
    cacheable: false,
  }) });
  const first = await f.execute();
  const second = await f.execute({ run: { ...run, id: "another-run" } });
  assert.equal(first.queries[0].status, "ok");
  assert.equal(second.queries[0].cacheHit, false);
  assert.equal(f.calls.filter((call) => call.args.sql?.includes("cmdb_online_ip_switch_port_current")).length, 2);
});

test("unknown formats, missing tools and query errors remain visible gaps rather than no-alarm evidence", async () => {
  const f = fixture({ invoke: async () => "<html>login</html>" });
  const result = await f.execute();
  assert.equal(result.evidence[0].status, "failed");
  assert.equal(result.evidence.at(-1).status, "unavailable");
  await f.execute(); assert.equal(f.calls.length, 2, "failures must never be cached");
  const missing = fixture(); const unavailable = await missing.execute({ schemas: [] });
  assert.equal(missing.calls.length, 0); assert.equal(unavailable.evidence[0].status, "unavailable");
  const mismatched = fixture({ invoke: async () => [{ unexpected: 1 }] });
  assert.equal((await mismatched.execute()).evidence[0].status, "failed");
});

test("oversized rows are visibly partial and never cached or used to resolve unique paths", async () => {
  const f = fixture({ assets: [{ ...assets[0], asset_name: "x".repeat(7000) }, assets[1]] });
  const result = await f.execute();
  assert.equal(result.evidence[0].status, "partial");
  assert.match(result.evidence[0].note, /6000 字符/);
  assert.equal(f.calls.some((c) => c.name === neo.name), false);
  assert.equal((await f.execute()).queries[0].cacheHit, false);
});

test("non-ping alerts remain explicitly outside the network template and are not dropped", async () => {
  const f = fixture(); const other = { alertId: "s:3", title: "CPU high", host: "10.0.0.1" };
  const mixed = await f.execute({ run: { ...run, alerts: [ping, other] } });
  assert.match(mixed.evidence[0].note, /1 条非 ping/);
  const only = fixture(); const result = await only.execute({ run: { ...run, alerts: [other] } });
  assert.equal(only.calls.length, 0); assert.ok(result.evidence.some((e) => e.status === "partial"));
});

test("query timeout cooperatively aborts and drains the owned tool invocation", async () => {
  let completed = false;
  const f = fixture({ invoke: async (_name, _args, signal) => new Promise((resolve) => {
    signal.addEventListener("abort", () => setTimeout(() => { completed = true; resolve([]); }, 20), { once: true });
  }) });
  const result = await f.execute({ task: { ...task, queryPlan: { ...task.queryPlan, queryTimeoutSeconds: 1 } } });
  assert.equal(completed, true);
  assert.equal(result.queries[0].status, "timeout");
});

test("cancelling the run aborts query work and cannot cache a late response", async () => {
  const controller = new AbortController(); let started;
  const entered = new Promise((resolve) => { started = resolve; });
  const f = fixture({ invoke: async (_name, _args, signal) => new Promise((resolve) => {
    started(); signal.addEventListener("abort", () => resolve(assets), { once: true });
  }) });
  const pending = f.execute({ signal: controller.signal });
  await entered; controller.abort(new Error("stop"));
  await assert.rejects(pending, /stop/);
});
