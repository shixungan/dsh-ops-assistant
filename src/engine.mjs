import { randomUUID, createHash } from "node:crypto";
import { collectSource, pollAlertmanager } from "./collectors.mjs";
import { analyzeRun, deliveryText, reportMarkdown } from "./analysis.mjs";
import { credentialRef } from "./config.mjs";

export class Engine {
  constructor({ store, credentials, analyze, getIm, fetcher, now = Date.now }) {
    Object.assign(this, { store, credentials, analyze, getIm, fetcher, now });
    this.queue = [];
    this.busy = false;
    this.current = null;
    this.lastPoll = 0;
    this.polling = false;
    this.tickBusy = false;
    this.sending = new Set();
    this.closed = false;
    this.lifecycle = new AbortController();
    this.deliveryPromises = new Set();
  }
  initialize() {
    for (const run of this.store.runs(100000)) {
      if (run.status === "queued") this.queue.push(run.id);
      else if (["collecting", "analyzing"].includes(run.status)) {
        run.status = "interrupted";
        run.error =
          "DSH Host 在任务执行期间停止；原文和已完成进度保留，需手动重新分析";
        this.store.putRun(run);
      }
    }
    for (const d of this.store.deliveries())
      if (d.status === "sending") {
        d.status = "unknown";
        d.error = "发送期间 Host 停止，是否已送达未知；不自动重发";
        this.store.putDelivery(d);
      }
  }
  enqueue(task, start, end) {
    const existing = this.store.window(task.id, start, end);
    if (existing) return existing;
    const run = {
      id: randomUUID(),
      taskId: task.id,
      task: structuredClone(task),
      start,
      end,
      status: "queued",
      stage: "等待执行",
      alerts: [],
      sources: [],
      sessions: [],
      analyzed: 0,
      version: 1,
      createdAt: this.now(),
    };
    this.store.putRun(run);
    this.queue.push(run.id);
    this.drain();
    return run;
  }
  manual(taskId) {
    const task = this.store.getSettings().tasks.find((t) => t.id === taskId);
    if (!task) throw new Error("任务不存在");
    const end = Math.floor(this.now() / 1000) * 1000;
    return this.enqueue(task, end - task.intervalMinutes * 60000, end);
  }
  retry(id) {
    const run = this.store.run(id);
    if (!run || ["queued", "collecting", "analyzing"].includes(run.status))
      throw new Error("任务不存在或仍在执行");
    run.version++;
    run.report = null;
    run.error = null;
    run.analyzed = 0;
    run.status = "queued";
    run.stage = "等待重新分析";
    run.reuseRaw = run.sources.length > 0;
    this.store.putRun(run);
    this.queue.push(id);
    this.drain();
    return run;
  }
  async token(source) {
    return (await this.credentials.resolve(credentialRef(source.id)))?.value;
  }
  async tick() {
    if (this.closed || this.tickBusy) return;
    this.tickBusy = true;
    try {
      const config = this.store.getSettings();
      const now = this.now();
      let changed = false;
      for (const task of config.tasks.filter((t) => t.enabled)) {
        const period = task.intervalMinutes * 60000;
        if (task.nextEnd === null) {
          task.nextEnd = Math.floor(now / period) * period;
          changed = true;
        }
        let emitted = 0;
        while (
          task.nextEnd + 120000 <= now &&
          emitted < 48 &&
          this.queue.length < 100
        ) {
          this.enqueue(task, task.nextEnd - period, task.nextEnd);
          task.nextEnd += period;
          emitted++;
          changed = true;
        }
      }
      if (changed) this.store.saveSettings(config);
      if (now - this.lastPoll >= 60000 && !this.polling) {
        this.lastPoll = now;
        this.pollPromise = this.poll();
        this.pollPromise.catch(() => {});
      }
      for (const d of this.store.deliveries())
        if (d.status === "pending" && (d.nextAttempt ?? 0) <= now)
          await this.sendDelivery(d);
      this.drain();
    } finally {
      this.tickBusy = false;
    }
  }
  async poll() {
    this.polling = true;
    try {
      for (const source of this.store
        .getSettings()
        .sources.filter((s) => s.enabled && s.type === "alertmanager")) {
        try {
          await pollAlertmanager(
            source,
            this.store,
            {
              token: await this.token(source),
              signal: this.lifecycle.signal,
              fetcher: this.fetcher,
            },
            this.now(),
          );
          this.pollStatus ??= {};
          this.pollStatus[source.id] = { ok: true, at: this.now() };
        } catch {
          this.pollStatus ??= {};
          this.pollStatus[source.id] = {
            ok: false,
            at: this.now(),
            error: "轮询失败，检查来源连通性及权限",
          };
        }
      }
    } finally {
      this.polling = false;
    }
  }
  drain() {
    if (this.closed || this.busy) return;
    this.busy = true;
    this.drainPromise = (async () => {
      try {
        while (!this.closed && this.queue.length) {
          const run = this.store.run(this.queue.shift());
          if (run?.status === "queued") await this.execute(run);
        }
      } finally {
        this.busy = false;
      }
    })();
    // Fatal persistence errors remain visible on status and do not cause a
    // silent unhandled rejection. No new work starts until a subsequent tick.
    this.drainPromise.catch((error) => {
      this.fatalError = error.message;
    });
  }
  async execute(run) {
    const control = new AbortController();
    this.current = { id: run.id, control };
    const signal = AbortSignal.any([
      control.signal,
      this.lifecycle.signal,
      AbortSignal.timeout(run.task.timeoutMinutes * 60000),
    ]);
    try {
      if (!run.reuseRaw) {
        run.status = "collecting";
        run.stage = "采集原始告警";
        this.store.putRun(run);
        const config = this.store.getSettings();
        for (const id of run.task.sourceIds) {
          signal.throwIfAborted();
          const source = config.sources.find((s) => s.id === id && s.enabled);
          try {
            if (!source) throw new Error("来源已停用或删除");
            if (source.type === "alertmanager")
              await pollAlertmanager(
                source,
                this.store,
                {
                  token: await this.token(source),
                  signal,
                  fetcher: this.fetcher,
                },
                this.now(),
              );
            const result = await collectSource(
              source,
              run.start,
              run.end,
              this.store,
              {
                token: await this.token(source),
                signal,
                fetcher: this.fetcher,
              },
            );
            run.alerts.push(...result.alerts);
            run.sources.push({
              id,
              name: source.name,
              status: result.status,
              note: result.note,
              count: result.alerts.length,
            });
          } catch (error) {
            run.sources.push({
              id,
              name: source?.name ?? id,
              status: "failed",
              count: 0,
              note: error.message,
            });
          }
          this.store.putRun(run);
        }
      }
      signal.throwIfAborted();
      run.status = "analyzing";
      this.store.putRun(run);
      const progress = (data) => {
        Object.assign(run, data);
        this.store.putRun(run);
      };
      progress.session = (id) => {
        run.sessions.push(id);
        this.store.putRun(run);
      };
      run.report = await analyzeRun(
        run,
        run.task,
        this.analyze,
        signal,
        progress,
      );
      run.analyzed = run.report.coveredIds.length;
      run.status = "completed";
      run.stage = "分析完成";
      run.finishedAt = this.now();
      run.error = null;
    } catch (error) {
      run.status = this.lifecycle.signal.aborted
        ? "interrupted"
        : signal.aborted
          ? "cancelled"
          : "failed";
      run.error = error.message;
      run.stage = "分析未完成";
      run.finishedAt = this.now();
    } finally {
      this.current = null;
      this.store.putRun(run);
    }
    if (
      !this.closed &&
      run.task.deliveryMode === "auto" &&
      (run.status === "completed" || run.task.sendDataOnFailure)
    )
      await this.deliver(run.id);
  }
  cancel(id) {
    if (this.current?.id === id) this.current.control.abort();
    else {
      const run = this.store.run(id);
      if (run?.status === "queued") {
        run.status = "cancelled";
        run.error = "手动取消";
        this.store.putRun(run);
        this.queue = this.queue.filter((x) => x !== id);
      }
    }
  }
  async deliver(id) {
    const run = this.store.run(id);
    if (!run || ["queued", "collecting", "analyzing"].includes(run.status))
      throw new Error("报告尚未完成");
    if (run.task.deliveryMode === "off")
      throw new Error("此任务未开启 IM 推送");
    for (const target of run.task.targets) {
      const key = createHash("sha256")
        .update(
          JSON.stringify([run.id, run.version, target.botId, target.targetId]),
        )
        .digest("hex");
      if (this.store.delivery(key)) continue;
      const row = {
        id: key,
        runId: run.id,
        version: run.version,
        ...target,
        text: deliveryText(run),
        status: "pending",
        attempts: 0,
        createdAt: this.now(),
      };
      this.store.putDelivery(row);
      await this.sendDelivery(row);
    }
  }
  sendDelivery(row) {
    const promise = this.sendDeliveryAttempt(row);
    this.deliveryPromises.add(promise);
    promise
      .finally(() => this.deliveryPromises.delete(promise))
      .catch(() => {});
    return promise;
  }
  async sendDeliveryAttempt(row) {
    if (this.closed || this.sending.has(row.id)) return;
    this.sending.add(row.id);
    try {
      const im = this.getIm();
      if (!im?.send) {
        row.status = "pending";
        row.error = "未安装或未启用 DSH-IM";
        row.nextAttempt = this.now() + 60000;
        this.store.putDelivery(row);
        return;
      }
      row.status = "sending";
      row.attempts++;
      row.error = null;
      this.store.putDelivery(row);
      try {
        const result = await im.send(row.botId, row.targetId, row.text, {
          signal: AbortSignal.any([
            this.lifecycle.signal,
            AbortSignal.timeout(30000),
          ]),
        });
        if (result?.sent !== true) throw new Error("发送结果未确认");
        row.status = "accepted";
        row.acceptedAt = this.now();
      } catch (error) {
        if (error.code === "bot-not-connected" && row.attempts < 4) {
          row.status = "pending";
          row.nextAttempt = this.now() + 60000 * row.attempts;
        } else if (
          [
            "unknown-bot",
            "unknown-target",
            "invalid-target",
            "bad-request",
            "target-rejected",
            "bot-not-connected",
          ].includes(error.code)
        )
          row.status = "failed";
        else row.status = "unknown";
        row.error =
          row.status === "unknown"
            ? "发送结果未知，可能已发送；请核实接收端后再手动重试"
            : `IM 投递失败：${error.code}`;
      }
      this.store.putDelivery(row);
    } finally {
      this.sending.delete(row.id);
    }
  }
  async retryDelivery(id, confirmUnknown = false) {
    const row = this.store.delivery(id);
    if (!row || row.status === "accepted" || row.status === "sending")
      throw new Error("无法重试此投递");
    if (row.status === "unknown" && !confirmUnknown)
      throw new Error("可能已发送，请明确确认后重试");
    row.status = "pending";
    row.nextAttempt = this.now();
    await this.sendDelivery(row);
  }
  report(id) {
    const run = this.store.run(id);
    if (!run) throw new Error("报告不存在");
    return { run, markdown: reportMarkdown(run) };
  }
  async close() {
    this.closed = true;
    this.lifecycle.abort();
    await Promise.allSettled(
      [
        this.drainPromise,
        this.tickPromise,
        this.pollPromise,
        ...this.deliveryPromises,
      ].filter(Boolean),
    );
  }
}
