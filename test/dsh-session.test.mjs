import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { createDshAnalyzer } from "../src/dsh.mjs";
import { taskConfig } from "../src/config.mjs";

const source = { id: "s", enabled: true };
const task = { name: "测试巡检", sourceIds: ["s"], workspace: "/opt/ops", allowedTools: ["read_logs", "read_assets"] };
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function fixture() {
  const agents = new Map(), listeners = new Set();
  const creates = [], prompts = [], renames = [], cancels = [];
  const emit = (sessionId, type, data) => {
    for (const listener of [...listeners]) listener({ id: sessionId }, { type, data });
  };
  const complete = (sessionId, text = "final") => {
    emit(sessionId, "assistant/message", { stream: [{ type: "text-chunks", texts: [text] }] });
    emit(sessionId, "turn/end", { reason: { kind: "completed" } });
  };
  const ctx = {
    on: (_name, listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    agents: { get: (id) => agents.get(id) },
    sessionController: {
      create: async (options) => {
        creates.push(options);
        const sessionId = `session-${creates.length}`;
        const policies = { guards: [], restrictions: [], released: 0 };
        const agent = { policies, ctx: { tools: {
          restrict: (value) => { policies.restrictions.push(value); return () => policies.released++; },
          guard: (value) => { policies.guards.push(value); return () => policies.released++; },
        } } };
        agents.set(sessionId, agent);
        return { sessionId };
      },
      rename: async (request) => { renames.push(request); },
      cancel: async (request) => { cancels.push(request); },
      prompt: async (request) => {
        prompts.push(request);
        complete(request.sessionId, request.content[0].text);
        return { accepted: true };
      },
    },
  };
  const analyze = createDshAnalyzer(ctx);
  const run = (prompt, options = {}, signal = new AbortController().signal, onSession = () => {}) =>
    analyze(prompt, { ...task, ...options }, signal, onSession);
  const guard = (id = "session-1") => agents.get(id).policies.guards[0];
  return { ctx, agents, listeners, creates, prompts, renames, cancels, emit, complete, run, guard };
}

test("one inspection context reuses its Session and policies across sequential prompts", async () => {
  const f = fixture(), context = { title: "运维巡检｜测试任务｜批次一" }, ids = [];
  for (const prompt of ["batch 1", "batch 2", "merge"])
    assert.equal(await f.run(prompt, { analysisContext: context }, undefined, (id) => ids.push(id)), prompt);
  assert.equal(f.creates.length, 1);
  assert.equal(f.prompts.length, 3);
  assert.equal(new Set(f.prompts.map((p) => p.requestId)).size, 3);
  assert.deepEqual(ids, ["session-1", "session-1", "session-1"]);
  assert.deepEqual(f.renames, [{ sessionId: "session-1", title: context.title }]);
  const policies = f.agents.get("session-1").policies;
  assert.equal(policies.guards.length, 1);
  assert.deepEqual(policies.restrictions, [{ allow: task.allowedTools }]);
  assert.equal(policies.released, 0, "opening the completed Session must not lift its read-only policy");
  assert.equal(f.listeners.size, 0);
  assert.equal(context.callLimit, 8);
});

test("different runs, retries and callers without a context create separate owned Sessions", async () => {
  const f = fixture();
  await f.run("first", { analysisContext: {} });
  await f.run("retry", { analysisContext: {} });
  await f.run("legacy", { analysisSessionId: "foreign-session" });
  await f.run("legacy again");
  assert.equal(f.creates.length, 4);
  assert.deepEqual(f.prompts.map((p) => p.sessionId), ["session-1", "session-2", "session-3", "session-4"]);
  assert.ok(f.creates.every((options) => !Object.hasOwn(options, "sessionId")));
});

test("query budget spans all prompts, counts inner executions and never counts PTC transport or unauthorized calls", async () => {
  const f = fixture(), context = {};
  await f.run("first", { analysisContext: context, maxToolCalls: 2 });
  const guard = f.guard();
  const parent = { name: "run_code", token: Symbol("parent"), callId: "parent" };
  assert.equal(guard(parent), undefined);
  assert.match(guard({ name: "write_device", token: Symbol("forbidden") }), /未授权/);
  assert.equal(context.toolCallsUsed, 0);
  const first = { name: "read_logs", token: Symbol("first"), callId: "child", rootCallId: "parent" };
  assert.equal(guard(first), undefined);
  assert.equal(guard(first), undefined, "checking the same execution again does not spend budget twice");
  assert.equal(context.toolCallsUsed, 1);
  await f.run("merge", { analysisContext: context, maxToolCalls: 2 });
  assert.equal(guard({ name: "read_assets", token: Symbol("second"), callId: "child", rootCallId: "parent" }), undefined);
  assert.equal(context.toolCallsUsed, 2, "distinct execution tokens count even when call ids match");
  assert.match(guard({ name: "read_logs", token: Symbol("third") }), /用完 2 次查询预算/);
  assert.match(guard(parent), /直接输出最终 JSON/);
  assert.equal(context.toolCallsUsed, 2);
  assert.equal(f.creates.length, 1);
});

test("zero budget and legacy format-only mode refuse both queries and run_code", async () => {
  const f = fixture();
  const zero = {};
  await f.run("zero", { analysisContext: zero, maxToolCalls: 0 });
  for (const name of ["read_logs", "run_code"])
    assert.match(f.guard()({ name, token: Symbol(name) }), /用完 0 次查询预算/);
  assert.equal(zero.toolCallsUsed, 0);
  await f.run("format", { formatOnly: true });
  for (const name of ["read_logs", "run_code"])
    assert.match(f.guard("session-2")({ name }), /格式修正会话不允许调用工具/);
  assert.deepEqual(f.agents.get("session-2").policies.restrictions, [{ allow: [] }]);
});

test("tool execution identity falls back to callId without charging repeated guard checks", async () => {
  const f = fixture(), context = {};
  await f.run("first", { analysisContext: context, maxToolCalls: 1 });
  assert.equal(f.guard()({ name: "read_logs", callId: "same" }), undefined);
  assert.equal(f.guard()({ name: "read_logs", callId: "same" }), undefined);
  assert.match(f.guard()({ name: "read_logs", callId: "different" }), /查询预算/);
  assert.equal(context.toolCallsUsed, 1);
});

test("missing or failing title support does not fail the analysis", async () => {
  for (const mode of ["missing", "fails"]) {
    const f = fixture();
    if (mode === "missing") delete f.ctx.sessionController.rename;
    else f.ctx.sessionController.rename = async () => { throw new Error("no title service"); };
    assert.equal(await f.run("final", { analysisContext: { title: "巡检" } }), "final");
  }
});

test("a live Session cannot be silently resumed with its restrictions lost", async () => {
  const f = fixture(), context = {};
  await f.run("first", { analysisContext: context });
  f.agents.delete("session-1");
  await assert.rejects(f.run("next", { analysisContext: context }), /受限会话/);
  assert.equal(f.prompts.length, 1);
  await assert.rejects(f.run("again", { analysisContext: context }), /已中断/);
});

test("cancellation removes event and abort listeners and never reuses the interrupted context", { timeout: 5000 }, async () => {
  const f = fixture(), context = {}, entered = deferred(), control = new AbortController();
  f.ctx.sessionController.prompt = async (request) => { f.prompts.push(request); entered.resolve(); };
  f.ctx.sessionController.cancel = async (request) => { f.cancels.push(request); throw new Error("already ended"); };
  const running = f.run("first", { analysisContext: context }, control.signal);
  await entered.promise;
  assert.equal(f.listeners.size, 1);
  control.abort();
  await assert.rejects(running, /取消或超时/);
  assert.deepEqual(f.cancels, [{ sessionId: "session-1" }]);
  assert.equal(f.listeners.size, 0);
  assert.equal(getEventListeners(control.signal, "abort").length, 0);
  await assert.rejects(f.run("next", { analysisContext: context }), /已中断/);
});

test("concurrent calls cannot race prompts into one inspection Session", { timeout: 5000 }, async () => {
  const f = fixture(), context = {}, entered = deferred();
  f.ctx.sessionController.prompt = async (request) => { f.prompts.push(request); entered.resolve(); };
  const first = f.run("first", { analysisContext: context });
  await entered.promise;
  await assert.rejects(f.run("second", { analysisContext: context }), /不能并发/);
  f.complete("session-1", "first");
  assert.equal(await first, "first");
  assert.equal(f.creates.length, 1);
  assert.equal(f.prompts.length, 1);
});

test("only the owned Session's final committed answer settles a prompt", async () => {
  const f = fixture();
  f.ctx.sessionController.prompt = async (request) => {
    f.complete("foreign", "wrong answer");
    f.emit(request.sessionId, "assistant/message", { stream: [{ type: "text-chunks", texts: ["before query"] }] });
    f.emit(request.sessionId, "tool/call", {});
    f.complete(request.sessionId, "final");
  };
  assert.equal(await f.run("question"), "final");
  assert.equal(f.listeners.size, 0);
});

test("synchronous prompt failures clean up listeners and are not mistaken for a completed turn", async () => {
  const f = fixture(), control = new AbortController();
  f.ctx.sessionController.prompt = () => { throw new Error("admission failed"); };
  await assert.rejects(f.run("question", {}, control.signal), /admission failed/);
  assert.equal(f.listeners.size, 0);
  assert.equal(getEventListeners(control.signal, "abort").length, 0);
});

test("query limit configuration defaults, preserves saved values and rejects out-of-range budgets", () => {
  assert.equal(taskConfig(task, [source]).maxToolCalls, 8);
  assert.equal(taskConfig({ ...task, maxToolCalls: 0 }, [source]).maxToolCalls, 0);
  assert.equal(taskConfig({ ...task, maxToolCalls: 50 }, [source]).maxToolCalls, 50);
  const existing = taskConfig({ ...task, maxToolCalls: 4 }, [source]);
  assert.equal(taskConfig(task, [source], existing).maxToolCalls, 4);
  for (const limit of [-1, 51, 1.5, "8"])
    assert.throws(() => taskConfig({ ...task, maxToolCalls: limit }, [source]), /补查工具调用上限/);
});
