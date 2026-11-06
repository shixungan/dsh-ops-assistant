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

test("configuration does not persist a source token or URL-embedded credentials", () => {
  const s = sourceConfig({ ...source, token: "SECRET" });
  assert.equal(s.token, undefined);
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
test("n9e does not silently drop events that started before the window", async () => {
  const result = await collectNightingale(source, 10000, 20000, {
    fetcher: async (url) => {
      assert.equal(url.searchParams.get("stime"), "0");
      assert.ok(Number(url.searchParams.get("etime")) > Date.now() / 1000);
      return json({
        dat: {
          total: 3,
          list: [
            { id: 1, trigger_time: 2, recover_time: 12, rule_name: "old" },
            { id: 2, trigger_time: 15, recover_time: 0 },
            { id: 3, trigger_time: 1, recover_time: 9 },
          ],
        },
      });
    },
  });
  assert.deepEqual(
    result.alerts.map((a) => a.nativeId),
    ["1", "2"],
  );
  assert.equal(result.alerts[0].phase, "窗口内恢复");
});
test("n9e premature pagination termination is marked incomplete", async () => {
  let calls = 0;
  const result = await collectNightingale(source, 10000, 20000, {
    fetcher: async () =>
      json({
        dat: {
          total: 100,
          list: calls++ === 0 ? [{ id: 1, trigger_time: 11 }] : [],
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
    analyze: async () => output(["s:1"]),
    getIm: () => ({
      send: async () => {
        sent++;
      },
    }),
    fetcher: async () =>
      json({ dat: { total: 1, list: [{ id: 1, trigger_time: 12 }] } }),
  });
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
    analyze: async () => output([]),
    getIm: () => ({
      send: async (b, g, value) => {
        text = value;
        return { sent: true };
      },
    }),
    fetcher: async () =>
      json({ dat: { total: 1, list: [{ id: 1, trigger_time: 12 }] } }),
  });
  const r = engine.enqueue(t, 10000, 20000);
  await engine.drainPromise;
  assert.equal(store.run(r.id).status, "failed");
  assert.match(text, /AI 分析未完成/);
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
  assert.match(text, /数据源存在缺失/);
  assert.match(text, /摘要已缩短/);
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
  assert.deepEqual(restriction, { allow: ["read_logs"] });
  assert.equal(guard({ name: "read_logs" }), undefined);
  assert.match(guard({ name: "bash" }), /未授权/);
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
