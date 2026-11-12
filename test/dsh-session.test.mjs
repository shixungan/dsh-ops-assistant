import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { createDshAnalyzer } from "../src/dsh.mjs";

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
  return { ctx, agents, listeners, creates, prompts, renames, cancels, emit, complete, run, guard, analyze };
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
  assert.deepEqual(policies.restrictions, [{ allow: [] }]);
  assert.equal(policies.released, 0, "opening the completed Session must not lift its read-only policy");
  assert.equal(f.listeners.size, 0);
  assert.equal(context.toolCallsUsed, 0);
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

test("legacy selections no longer expose raw tools, transport or session controls", async () => {
  const f = fixture(), context = {};
  await f.run("inspect", { analysisContext: context, allowedTools: ["read_logs", "bash", "subagent", "run_code"], maxToolCalls: 50 });
  for (const name of ["read_logs", "bash", "subagent", "run_code", "ops_lookup"])
    assert.equal(typeof f.guard()({ name, agent: f.agents.get("session-1"), token: Symbol(name) }), "string", name);
  assert.deepEqual(f.agents.get("session-1").policies.restrictions, [{ allow: [] }]);
  assert.equal(context.toolCallsUsed, 0);
});

test("evidence preparation and sequential analysis share one owned session", async () => {
  const f = fixture(), context = {}, ids = [], options = { ...task, analysisContext: context };
  const run = { id: "batch", start: 0, end: 1000, alerts: [{ title: "ping loss", host: "unknown" }] };
  const evidence = await f.analyze.prepare(run, options, new AbortController().signal, (id) => ids.push(id));
  assert.equal(f.prompts.length, 0, "prefetch does not ask the model to discover tools");
  assert.equal(evidence.evidence[0].status, "unavailable");
  await f.run("analysis", options, undefined, (id) => ids.push(id));
  assert.equal(f.creates.length, 1);
  assert.deepEqual(ids, ["session-1", "session-1"]);
});

test("empty preparation never opens a session", async () => {
  const f = fixture();
  assert.equal(await f.analyze.prepare({ alerts: [] }, task, new AbortController().signal), null);
  assert.equal(f.creates.length, 0);
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
