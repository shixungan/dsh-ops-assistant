import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { sourceConfig, taskConfig } from "../src/config.mjs";
import {
  chunksBySize,
  parseAnalysis,
  analyzeRun,
  deliveryText,
} from "../src/analysis.mjs";
import {
  collectZabbix,
  collectNightingale,
  collectAlertmanager,
  pollAlertmanager,
  requestJson,
} from "../src/collectors.mjs";
import { Engine } from "../src/engine.mjs";
import { createDshAnalyzer } from "../src/dsh.mjs";
import { createHandler } from "../src/host.mjs";

const source = {
  id: "s",
  name: "测试夜莺",
  type: "nightingale",
  enabled: true,
  url: "https://n9e.invalid",
};
const task = taskConfig(
  {
    name: "巡检",
    sourceIds: ["s"],
    workspace: "/opt/ops",
    deliveryMode: "off",
  },
  [source],
);
const a = (id) => ({
  alertId: id,
  host: "sw1",
  raw: { alert: "interface down" },
});
const output = (ids) =>
  JSON.stringify({
    summary: "检测到链路异常；仍需验证上下游关系",
    incidents: [
      {
        title: "链路异常",
        alertIds: ids,
        assessment: "相关性待验证",
        evidence: ["接口告警原文"],
        unknowns: ["缺少拓扑"],
        actions: ["查询接口状态"],
      },
    ],
  });
const run = (id = "r") => ({
  id,
  taskId: task.id,
  task,
  start: 1000,
  end: 2000,
  status: "completed",
  stage: "完成",
  sources: [{ id: "s", name: "夜莺", status: "ok", count: 1 }],
  alerts: [a("a")],
  report: parseAnalysis(output(["a"]), ["a"]),
  sessions: [],
  version: 1,
});
const credentials = { resolve: async () => ({ value: "SECRET" }) };
const json = (data) =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
const n9eEvent = (id, lastEvalTime, overrides = {}) => ({
  id,
  hash: "same-alert",
  rule_name: "接口异常",
  first_trigger_time: 2,
  trigger_time: lastEvalTime,
  last_eval_time: lastEvalTime,
  is_recovered: 0,
  recover_time: 0,
  ...overrides,
});

test("configuration does not persist a source token or URL-embedded credentials", () => {
  const s = sourceConfig({ ...source, token: "SECRET" });
  assert.equal(s.token, undefined);
  assert.equal(s.authMode, "user-token");
  assert.throws(() =>
    sourceConfig({ ...source, url: "https://u:secret@host" }),
  );
  assert.throws(() =>
    taskConfig({ ...task, sourceIds: ["missing"] }, [source]),
  );
  assert.throws(() =>
    taskConfig({ ...task, deliveryMode: "auto", targets: [] }, [source]),
  );
});
test("raw alert chunks retain every byte and reject oversized single records", () => {
  const alerts = Array.from({ length: 40 }, (_, i) => a(String(i)));
  const chunks = chunksBySize(alerts, 500);
  assert.ok(chunks.length > 1);
  assert.deepEqual(chunks.flat(), alerts);
  assert.throws(() => chunksBySize([a("x".repeat(500))], 200), /未截断/);
});
test("coverage uses actual ID sets rather than model counters", () => {
  assert.throws(() => parseAnalysis(output(["a"]), ["a", "b"]), /覆盖不完整/);
  assert.throws(
    () => parseAnalysis(output(["a", "invented"]), ["a"]),
    /不存在/,
  );
  assert.deepEqual(parseAnalysis(output(["a", "a"]), ["a"]).coveredIds, ["a"]);
});
test("empty failed sources never produce a healthy verdict", async () => {
  const result = await analyzeRun(
    { alerts: [], sources: [{ status: "failed" }] },
    task,
    () => {
      throw Error("must not call");
    },
  );
  assert.match(result.summary, /不能判定无异常/);
});
test("multi-part analysis merges across partitions and validates all IDs", async () => {
  const alerts = [a("a"), a("b"), a("c")].map((x) => ({
    ...x,
    raw: { detail: "x".repeat(600) },
  }));
  let calls = 0;
  const progress = () => {};
  progress.session = () => {};
  const answer = await analyzeRun(
    { alerts, sources: [], start: 0, end: 1000 },
    { ...task, maxBatchChars: 1000 },
    async (prompt) => {
      calls++;
      const ids = [
        ...new Set(
          [...prompt.matchAll(/"alertId":"([abc])"/g)].map((m) => m[1]),
        ),
      ];
      return output(ids.length ? ids : ["a", "b", "c"]);
    },
    new AbortController().signal,
    progress,
  );
  assert.equal(calls, 4);
  assert.deepEqual(new Set(answer.coveredIds), new Set(["a", "b", "c"]));
});
test("Zabbix uses overlapping problem window and preserves recovery original", async () => {
  const problems = [
    {
      eventid: "90071992547409931",
      objectid: "t",
      name: "link down",
      value: "1",
      severity: "4",
      clock: "2",
      r_eventid: "999",
      tags: [],
    },
  ];
  const recovered = { eventid: "999", clock: "12", value: "0" };
  const calls = [];
  const result = await collectZabbix(
    { ...source, type: "zabbix", url: "https://z.invalid/api_jsonrpc.php" },
    10000,
    20000,
    {
      token: "SECRET",
      fetcher: async (_, options) => {
        const body = JSON.parse(options.body);
        calls.push(body);
        return json({ result: body.params.eventids ? [recovered] : problems });
      },
    },
  );
  assert.equal(calls[0].params.problem_time_from, 10);
  assert.equal(calls[0].params.problem_time_till, 19);
  assert.equal(result.alerts[0].phase, "窗口内恢复");
  assert.deepEqual(result.alerts[0].raw, problems[0]);
  assert.deepEqual(result.alerts[0].recoveryRaw, recovered);
});
test("Zabbix paginates large event IDs without precision loss", async () => {
  const rows = Array.from({ length: 500 }, (_, i) => ({
    eventid: String(90071992547409930n + BigInt(i)),
    clock: "12",
    r_eventid: "0",
    objectid: "t",
  }));
  let calls = 0;
  const result = await collectZabbix(
    { ...source, type: "zabbix" },
    10000,
    20000,
    {
      fetcher: async (_, options) => {
        const p = JSON.parse(options.body).params;
        if (calls++ === 0) return json({ result: rows });
        assert.equal(p.eventid_from, "90071992547410430");
        return json({ result: [] });
      },
    },
  );
  assert.equal(result.alerts.length, 500);
  assert.equal(result.status, "ok");
});
test("n9e requests only the half-hour window with personal-token auth and excludes recovery", async () => {
  const rows = [
    n9eEvent(1, 1799),
    n9eEvent(2, 1800, { tags: ["instance=sw1:9100", "job=network"] }),
    n9eEvent(3, 2500, { is_recovered: false }),
    n9eEvent(4, 3599),
    n9eEvent(5, 3600),
    n9eEvent(6, 2700, { is_recovered: 1, recover_time: 2700 }),
    n9eEvent(7, 2800, { is_recovered: true, recover_time: 2800 }),
  ];
  let calls = 0;
  const result = await collectNightingale(
    { ...source, url: "https://n9e.invalid/monitor", authMode: "bearer" },
    1800000,
    3600000,
    {
      token: "PERSONAL_TOKEN",
      fetcher: async (url, options) => {
        calls++;
        assert.equal(url.pathname, "/monitor/api/n9e/alert-his-events/list");
        assert.equal(options.method, "GET");
        assert.equal(options.headers["X-User-Token"], "PERSONAL_TOKEN");
        assert.equal(options.headers.Authorization, undefined);
        assert.equal(url.searchParams.get("stime"), "1800");
        assert.equal(url.searchParams.get("etime"), "3599");
        assert.equal(url.searchParams.get("is_recovered"), "0");
        assert.equal(url.searchParams.get("severity"), "-1");
        assert.equal(url.searchParams.get("limit"), "500");
        assert.equal(url.searchParams.get("p"), "1");
        return json({ dat: { total: rows.length, list: rows }, err: "" });
      },
    },
  );
  assert.deepEqual(
    result.alerts.map((a) => a.nativeId),
    ["2", "3", "4"],
  );
  assert.deepEqual(
    result.alerts.map((a) => a.eventTime),
    [1800000, 2500000, 3599000],
  );
  // Different historical IDs are distinct reminders, even for one alert hash.
  assert.deepEqual(result.alerts.map((a) => a.raw), [rows[1], rows[2], rows[3]]);
  assert.equal(result.alerts[0].first, 2000);
  assert.equal(result.alerts[0].host, "sw1:9100");
  for (const alert of result.alerts) {
    assert.equal(alert.last, null);
    assert.equal(alert.phase, "窗口内告警记录（未查询恢复状态）");
    assert.equal(alert.recoveryRaw, undefined);
  }
  assert.equal(result.status, "ok");
  assert.equal(calls, 1);
});
test("n9e applies half-open windows to second-resolution event timestamps", async () => {
  const rows = [10, 11, 20, 21].map((time) => n9eEvent(time, time));
  const result = await collectNightingale(source, 10500, 20500, {
    fetcher: async (url) => {
      assert.equal(url.searchParams.get("stime"), "11");
      assert.equal(url.searchParams.get("etime"), "20");
      return json({ dat: { total: rows.length, list: rows } });
    },
  });
  assert.deepEqual(result.alerts.map((a) => a.nativeId), ["11", "20"]);
});
test("n9e does not carry an old trigger into later windows after a separate recovery", async () => {
  const rows = [
    n9eEvent(1, 2),
    n9eEvent(2, 12, { is_recovered: 1, recover_time: 12 }),
  ];
  const result = await collectNightingale(source, 30000, 40000, {
    fetcher: async () => json({ dat: { total: rows.length, list: rows } }),
  });
  assert.deepEqual(result.alerts, []);
  assert.equal(result.status, "ok");
});
test("n9e paginates the same bounded window and deduplicates repeated event IDs", async () => {
  const rows = Array.from({ length: 501 }, (_, i) => n9eEvent(i + 1, 12));
  let calls = 0;
  const result = await collectNightingale(source, 10000, 20000, {
    fetcher: async (url) => {
      calls++;
      assert.equal(url.searchParams.get("p"), String(calls));
      assert.equal(url.searchParams.get("stime"), "10");
      assert.equal(url.searchParams.get("etime"), "19");
      assert.equal(url.searchParams.get("is_recovered"), "0");
      return json({
        dat: {
          total: 501,
          list: calls === 1 ? rows.slice(0, 500) : rows.slice(499),
        },
      });
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.status, "ok");
  assert.equal(result.alerts.length, 501);
  assert.equal(new Set(result.alerts.map((a) => a.alertId)).size, 501);
});
test("n9e rejects records whose identity, event time or recovery state cannot be trusted", async () => {
  const invalid = [
    { ...n9eEvent(1, 12), id: undefined },
    { ...n9eEvent(1, 12), id: null },
    { ...n9eEvent(1, 12), last_eval_time: undefined },
    { ...n9eEvent(1, 12), last_eval_time: null },
    { ...n9eEvent(1, 12), last_eval_time: "invalid" },
    { ...n9eEvent(1, 12), is_recovered: undefined },
    { ...n9eEvent(1, 12), is_recovered: 2 },
  ];
  for (const row of invalid)
    await assert.rejects(
      collectNightingale(source, 10000, 20000, {
        fetcher: async () => json({ dat: { total: 1, list: [row] } }),
      }),
      /格式|字段/,
      `Invalid row must fail: ${JSON.stringify(row)}`,
    );
});
test("n9e premature pagination termination is marked incomplete", async () => {
  let calls = 0;
  const result = await collectNightingale(source, 10000, 20000, {
    fetcher: async () =>
      json({
        dat: {
          total: 100,
          list: calls++ === 0 ? [n9eEvent(1, 11)] : [],
        },
      }),
  });
  assert.equal(result.status, "partial");
});
test("Alertmanager disappearance is not fabricated as recovery", async () => {
  const store = new Store(":memory:");
  const s = { ...source, type: "alertmanager" };
  await pollAlertmanager(
    s,
    store,
    {
      fetcher: async () =>
        json([
          {
            fingerprint: "f",
            startsAt: "2026-01-01T00:00:00Z",
            endsAt: "2026-01-01T01:00:00Z",
            labels: { alertname: "A" },
          },
        ]),
    },
    Date.parse("2026-01-01T00:01:00Z"),
  );
  await pollAlertmanager(
    s,
    store,
    { fetcher: async () => json([]) },
    Date.parse("2026-01-01T00:02:00Z"),
  );
  const result = collectAlertmanager(
    s,
    Date.parse("2026-01-01T00:00:00Z"),
    Date.parse("2026-01-01T00:30:00Z"),
    store,
  );
  assert.equal(result.status, "partial");
  assert.equal(result.alerts[0].last, null);
  store.close();
});
test("HTTP redirects are disallowed to protect platform tokens", async () => {
  await requestJson("https://x.invalid", {
    token: "secret",
    fetcher: async (_, opts) => {
      assert.equal(opts.redirect, "error");
      assert.equal(opts.headers.Authorization, "Bearer secret");
      assert.equal(opts.headers["X-User-Token"], undefined);
      return json({ ok: true });
    },
  });
});
test("same window is queued once, and IM-off never invokes a bot", async () => {
  const store = new Store(":memory:");
  store.saveSettings({ sources: [source], tasks: [task] });
  let sent = 0;
  const engine = new Engine({
    store,
    credentials,
    now: () => 20000,
    analyze: async () => output(["s:1"]),
    getIm: () => ({
      send: async () => {
        sent++;
      },
    }),
    fetcher: async () =>
      json({ dat: { total: 1, list: [n9eEvent(1, 12)] } }),
  });
  await engine.poll();
  const first = engine.enqueue(task, 10000, 20000);
  const second = engine.enqueue(task, 10000, 20000);
  await engine.drainPromise;
  assert.equal(first.id, second.id);
  assert.equal(store.run(first.id).status, "completed");
  assert.equal(sent, 0);
  await engine.close();
  store.close();
});
test("missing output IDs fail analysis and auto-deliver explicitly labelled data", async () => {
  const store = new Store(":memory:");
  const t = {
    ...task,
    deliveryMode: "auto",
    targets: [{ botId: "b", targetId: "g" }],
  };
  store.saveSettings({ sources: [source], tasks: [t] });
  let text;
  const engine = new Engine({
    store,
    credentials,
    now: () => 20000,
    analyze: async () => output([]),
    getIm: () => ({
      send: async (b, g, value) => {
        text = value;
        return { sent: true };
      },
    }),
    fetcher: async () =>
      json({ dat: { total: 1, list: [n9eEvent(1, 12)] } }),
  });
  await engine.poll();
  const r = engine.enqueue(t, 10000, 20000);
  await engine.drainPromise;
  assert.equal(store.run(r.id).status, "failed");
  assert.match(text, /分析未完成/);
  assert.equal(store.deliveries()[0].status, "accepted");
  await engine.close();
  store.close();
});
test("delivery is idempotent across repeated clicks; uncertain outcomes are not retried automatically", async () => {
  const store = new Store(":memory:");
  const r = run();
  r.task = {
    ...task,
    deliveryMode: "manual",
    targets: [{ botId: "b", targetId: "g" }],
  };
  store.putRun(r);
  let calls = 0;
  const engine = new Engine({
    store,
    credentials,
    analyze: async () => "",
    getIm: () => ({
      send: async () => {
        calls++;
        throw new Error("socket timeout");
      },
    }),
  });
  await engine.deliver("r");
  await engine.deliver("r");
  await engine.tick();
  assert.equal(calls, 1);
  assert.equal(store.deliveries()[0].status, "unknown");
  await assert.rejects(engine.retryDelivery(store.deliveries()[0].id), /确认/);
  await engine.close();
  store.close();
});
test("restart preserves interrupted analysis and turns an inflight send into unknown", () => {
  const store = new Store(":memory:");
  const r = run();
  r.status = "analyzing";
  store.putRun(r);
  store.putDelivery({ id: "d", status: "sending" });
  const engine = new Engine({ store });
  engine.initialize();
  assert.equal(store.run("r").status, "interrupted");
  assert.equal(store.delivery("d").status, "unknown");
  store.close();
});
test("summary messages are bounded and clearly label incompleteness", () => {
  const r = run();
  r.report.summary = "长".repeat(6000);
  r.sources[0].status = "partial";
  const text = deliveryText(r);
  assert.ok(text.length <= 3500);
  assert.match(text, /本次数据不完整，结论仅针对已收到的告警/);
  assert.match(text, /结论较长，请按巡检 ID 查看完整判断/);
});
test("host handler never returns saved tokens to browser state", async () => {
  const store = new Store(":memory:");
  let secret;
  const handler = createHandler({
    store,
    engine: {},
    credentials: {
      set: async (_, value) => {
        secret = value;
      },
    },
    getIm: () => null,
  });
  await handler("source.save", { ...source, id: undefined, token: "SECRET" });
  const result = await handler("state", {});
  assert.equal(secret, "SECRET");
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
  store.close();
});
test("DSH adapter subscribes before prompt and accepts only committed completed output", async () => {
  let listener;
  let restriction;
  let guard;
  const ctx = {
    on: (_, f) => {
      listener = f;
      return () => {
        listener = null;
      };
    },
    agents: {
      get: () => ({
        ctx: {
          tools: {
            restrict: (x) => {
              restriction = x;
            },
            guard: (x) => {
              guard = x;
            },
          },
        },
      }),
    },
    sessionController: {
      create: async () => ({ sessionId: "session1" }),
      cancel: () => {},
      prompt: async (req) => {
        assert.equal(req.mode, "queue");
        listener(
          { id: "other" },
          { type: "turn/end", data: { reason: { kind: "completed" } } },
        );
        listener(
          { id: "session1" },
          {
            type: "assistant/message",
            data: { stream: [{ type: "text-chunks", texts: ["final"] }] },
          },
        );
        listener(
          { id: "session1" },
          { type: "turn/end", data: { reason: { kind: "completed" } } },
        );
      },
    },
  };
  const result = await createDshAnalyzer(ctx)(
    "prompt",
    { ...task, allowedTools: ["read_logs"] },
    new AbortController().signal,
    () => {},
  );
  assert.equal(result, "final");
  assert.deepEqual(restriction, { allow: [] });
  assert.equal(typeof guard({ name: "read_logs" }), "string");
  assert.equal(typeof guard({ name: "bash" }), "string");
  assert.equal(listener, null);
});
test("DSH cancellation propagates to owned session", async () => {
  let cancelled = false;
  const c = new AbortController();
  const ctx = {
    on: () => () => {},
    agents: { get: () => ({ ctx: { tools: { restrict() {}, guard() {} } } }) },
    sessionController: {
      create: async () => ({ sessionId: "s" }),
      cancel: () => {
        cancelled = true;
      },
      prompt: async () => {
        c.abort();
      },
    },
  };
  await assert.rejects(
    createDshAnalyzer(ctx)("x", task, c.signal, () => {}),
    /取消或超时/,
  );
  assert.equal(cancelled, true);
});
