import React, { useId, useRef, useState } from "react";
import { DICTIONARY_PURPOSES, defaultDictionaryRecipe } from "../src/dictionary-defs.mjs";

const names = Object.fromEntries(DICTIONARY_PURPOSES.map((p) => [p.id, p.name]));
const statuses = { verified: "查询验证通过", ready: "验证有效", unverified: "待验证", empty: "查询可执行 · 无样例", failed: "验证失败", stale: "需要重新验证", schema_changed: "工具结构已变化", unavailable: "不可用", ok: "可用" };
const formatTime = (t) => t ? new Date(t).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }) : "尚未验证";
const pretty = (value) => JSON.stringify(value, null, 2);
const blank = (purpose = "assets") => ({ name: "", purpose, tool: "", description: "", dataObjects: "", inputs: "", outputs: "", relationships: "", timeSemantics: "", limitations: "", document: "", recipe: defaultDictionaryRecipe(purpose) });
function Button({ children, primary, danger, ...props }) { return <button type="button" className={`ops-button${primary ? " ops-primary" : ""}${danger ? " ops-danger" : ""}`} {...props}>{children}</button>; }
function Field({ title, hint, children }) { const id = useId(); return <div className="ops-field"><label htmlFor={id}>{title}</label>{React.cloneElement(children, { id })}{hint && <small>{hint}</small>}</div>; }
export function DictionaryStatus({ validation }) {
  const status = validation?.status ?? "unverified";
  return <span className={`ops-badge ops-${status === "verified" ? "ok" : status === "failed" ? "failed" : "partial"}`}>{statuses[status] ?? status}</span>;
}
export function DictionaryBindings({ value = {}, onChange, entries = [] }) {
  return <section className="ops-dictionary-bindings" aria-label="数据字典引用">
    <h3>使用数据字典</h3><p className="ops-muted">为各用途选择已验证条目，复用字段说明与查询模板。留空沿用下方 MCP 绑定和内置模板。</p>
    <div className="ops-form-grid">{DICTIONARY_PURPOSES.filter((p) => p.role).map((purpose) => {
      const selected = value[purpose.id] ?? "", candidates = entries.filter((e) => e.purpose === purpose.id);
      return <Field key={purpose.id} title={`${purpose.name} · 字典`}>
        <select value={selected} onChange={(e) => onChange({ ...value, [purpose.id]: e.target.value })}>
          <option value="">沿用内置模板</option>
          {!!selected && !candidates.some((e) => e.id === selected) && <option value={selected}>原条目不可用，请重新选择</option>}
          {candidates.map((e) => <option key={e.id} value={e.id} disabled={!["verified", "empty"].includes(e.validation?.status) && e.id !== selected}>{e.name} · 修订 {e.revision} · {statuses[e.validation?.status] ?? "待验证"}</option>)}
        </select>
      </Field>;
    })}</div><small>选择字典后，该用途使用字典中的 MCP 与模板；条目失效会报告缺口，不会自动切回旧查询。字典在独立页面维护。</small>
  </section>;
}
export function DictionaryEvidence({ value }) {
  if (!Array.isArray(value) || !value.length) return null;
  return <details open className="ops-dictionary-evidence"><summary>本次使用的数据字典 · {value.length} 项</summary>
    {value.map((entry, i) => <div className="ops-dictionary-snapshot" key={`${entry.id}-${i}`}>
      <strong>{entry.name ?? names[entry.purpose] ?? entry.id} · 修订 {entry.revision ?? "—"}</strong>
      <small>{names[entry.purpose] ?? entry.purpose} · {entry.tool || "未绑定工具"} · {statuses[entry.status] ?? entry.status ?? "已记录"}</small>
      {(entry.note || entry.message) && <p>{entry.note || entry.message}</p>}
      {entry.timeSemantics && <small>时间口径：{entry.timeSemantics}</small>}
    </div>)}<small>这里保留本批次的条目快照。查询验证通过不代表本次故障原因已经确认。</small>
  </details>;
}

export function DictionarySettings({ entries = [], plans = [], call, onChanged, workspace = "/opt/dsh-ops-assistant" }) {
  const [draft, setDraft] = useState(null), [recipe, setRecipe] = useState("");
  const [discovered, setDiscovered] = useState(null), [search, setSearch] = useState("");
  const [importing, setImporting] = useState(false), [importText, setImportText] = useState(""), [importDrafts, setImportDrafts] = useState([]);
  const [deletion, setDeletion] = useState(null), [validation, setValidation] = useState(null), [validationResult, setValidationResult] = useState(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const lock = useRef(false);
  const references = (id) => plans.filter((p) => Object.values(p.config?.dictionaryBindings ?? {}).includes(id));
  async function act(fn, message) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(""); setNotice("");
    try { const result = await fn(); if (message) setNotice(message); return result; }
    catch (e) { setError(e.message); return undefined; }
    finally { lock.current = false; setBusy(false); }
  }
  function edit(entry, copy = false) {
    const data = { ...blank(entry?.purpose), ...structuredClone(entry ?? {}) };
    if (copy) { delete data.id; delete data.revision; data.name += "（副本）"; }
    delete data.validation; delete data.createdAt; delete data.updatedAt;
    setDraft(data); setRecipe(pretty(data.recipe)); setError(""); setNotice("");
  }
  function change(key, next) { setDraft((value) => ({ ...value, [key]: next })); }
  function startValidation(entry) {
    setError(""); setValidationResult(null);
    setValidation({ entry, workspace, agentPreset: "", ips: "", hosts: "", pairs: '[\n  { "src": "", "dst": "" }\n]', start: "", end: "", query: "" });
  }
  const list = discovered?.filter((tool) => `${tool.tool} ${tool.description}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  const fieldDescriptions = [["description", "能回答什么问题", "描述需要查证的业务问题与适用场景。"], ["dataObjects", "数据对象", "填写数据库表、图节点/关系或知识库范围。"], ["inputs", "输入含义", "例如：主机 IP、交换机名称，以及是否需要 VRF。"], ["outputs", "输出字段与含义", "写明关键字段、单位、空值与状态值的解释。"], ["relationships", "关联方式", "例如：将 switch_hostname 作为拓扑节点名称。"], ["timeSemantics", "时间口径", "区分发生、采集、入库时间；注明时区、秒/毫秒和保留期。"], ["limitations", "适用范围与限制", "例如：当前映射不能证明历史窗口状态；空记录不等于正常。"]];
  return <>
    <section className="ops-section" aria-label="MCP 数据字典">
      <div className="ops-section-title"><div><h2>MCP 数据字典</h2><p>集中维护数据含义、关联方式和已验证查法，查询方案按用途引用。</p></div>
        <div className="ops-actions"><Button disabled={busy} onClick={() => act(async () => { setDiscovered(await call("dictionary.discover", {})); setSearch(""); })}>发现 MCP</Button>
          <Button disabled={busy} onClick={() => { setImporting(true); setImportText(""); setImportDrafts([]); setError(""); }}>导入文档</Button>
          <Button primary disabled={busy} onClick={() => edit()}>新建条目</Button></div></div>
      {error && !draft && !deletion && !validation && !importing && !discovered && <div role="alert" className="ops-notice ops-error ops-dictionary-notice">{error}</div>}
      {notice && <div role="status" className="ops-notice ops-dictionary-notice">{notice}</div>}
      <div className="ops-dictionary-intro"><span>1. 发现或导入</span><span>2. 核对字段与模板</span><span>3. 验证查询</span><span>4. 在方案中引用</span></div>
      {entries.map((entry) => {
        const used = references(entry.id);
        return <article key={entry.id} className="ops-task-card ops-plan-card ops-dictionary-card">
          <div><div className="ops-card-top"><h3>{entry.name}</h3><DictionaryStatus validation={entry.validation} /></div>
            <p>{entry.description || names[entry.purpose]}</p><small>{names[entry.purpose]} · 修订 {entry.revision} · {entry.tool || "尚未绑定 MCP"}</small>
            <small>{used.length ? `被 ${used.length} 个方案引用：${used.map((p) => p.name).join("、")}` : "未被方案引用"}</small>
            <small>最近验证：{formatTime(entry.validation?.checkedAt)}{entry.validation?.message ? ` · ${entry.validation.message}` : ""}</small>
          </div><div className="ops-actions"><Button disabled={busy} onClick={() => edit(entry)}>编辑条目</Button>
            <Button disabled={busy || entry.purpose === "reference" || !entry.tool} onClick={() => startValidation(entry)}>验证查询</Button>
            <Button disabled={busy} onClick={() => edit(entry, true)}>复制</Button>
            <Button danger disabled={busy || used.length > 0} title={used.length ? "请先解除查询方案中的引用" : "删除字典条目"} onClick={() => { setError(""); setDeletion(entry); }}>删除</Button></div>
        </article>;
      })}
      {!entries.length && <div className="ops-empty">发现现有 MCP，或导入数据说明，建立第一条查询知识。</div>}
    </section>
    {draft && <div className="ops-overlay"><form className="ops-dialog ops-wide" aria-label="编辑字典条目" onSubmit={async (e) => {
      e.preventDefault(); const result = await act(async () => { let parsed; try { parsed = JSON.parse(recipe); } catch { throw new Error("查询模板不是合法 JSON，请检查后保存"); }
        const value = await call("dictionary.save", { ...draft, recipe: parsed }); await onChanged(); return value; }, "字典已保存，请验证查询后在方案中引用");
      if (result) setDraft(null);
    }}><div className="ops-section-title"><div><h2>{draft.id ? "编辑" : "新建"}字典条目</h2><p>保存字段说明与可复用查法；修改后需重新验证。</p></div><Button disabled={busy} onClick={() => setDraft(null)}>关闭</Button></div>
      {error && <div role="alert" className="ops-notice ops-error">{error}</div>}
      <div className="ops-form-grid"><Field title="条目名称"><input required maxLength={200} value={draft.name} onChange={(e) => change("name", e.target.value)} /></Field>
        <Field title="数据用途" hint="更换用途会重置查询模板，字段说明保留。"><select value={draft.purpose} onChange={(e) => { change("purpose", e.target.value); setRecipe(pretty(defaultDictionaryRecipe(e.target.value))); }}>{DICTIONARY_PURPOSES.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field></div>
      <Field title="MCP 工具标识" hint="填写 DSH 暴露的完整工具名；可先通过“发现 MCP”生成草稿。"><input required={draft.purpose !== "reference"} maxLength={300} value={draft.tool} onChange={(e) => change("tool", e.target.value)} /></Field>
      <div className="ops-form-grid">{fieldDescriptions.map(([key, title, hint]) => <Field key={key} title={title} hint={hint}><textarea rows={key === "outputs" ? 4 : 3} maxLength={2000} value={draft[key] ?? ""} onChange={(e) => change(key, e.target.value)} /></Field>)}</div>
      {draft.purpose !== "reference" && <details className="ops-dictionary-template"><summary>查询模板 · JSON 字段映射</summary><p className="ops-muted">填写表名、列名或图属性，程序按告警对象和时间窗生成查询。这里不接受任意 SQL/Cypher。请按实际结构修改默认示例。</p>
        <Field title="声明式查询模板"><textarea className="ops-code-input" rows={14} spellCheck={false} value={recipe} onChange={(e) => setRecipe(e.target.value)} /></Field>
      </details>}
      <details><summary>原始说明文档</summary><Field title="参考文档（Markdown）" hint="用于保存出处和补充说明；导入文本不会自动授予工具权限。"><textarea rows={8} maxLength={16000} value={draft.document ?? ""} onChange={(e) => change("document", e.target.value)} /></Field></details>
      <div className="ops-sticky-footer"><button className="ops-button ops-primary" disabled={busy}>保存条目</button><small>保存后不会立即查询 MCP。已有批次保留原条目快照。</small></div>
    </form></div>}
    {discovered && <div className="ops-overlay"><section className="ops-dialog ops-wide" role="dialog" aria-modal="true" aria-label="发现 MCP">
      <div className="ops-section-title"><div><h2>发现 MCP</h2><p>仅读取工具描述与参数，不执行查询。选择工具生成待核对的草稿。</p></div><Button disabled={busy} onClick={() => setDiscovered(null)}>关闭</Button></div>
      {error && <div role="alert" className="ops-notice ops-error">{error}</div>}
      <Field title="查找工具"><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="工具名称或描述" /></Field>
      <div className="ops-discovery-list">{list.map((tool) => <article key={tool.tool}><strong>{tool.tool}</strong><p>{tool.description || "无工具说明"}</p>
        <div className="ops-actions">{(tool.purposes?.filter((p) => p !== "reference").length ? tool.purposes.filter((p) => p !== "reference") : ["reference"]).map((purpose) => <Button key={purpose} disabled={busy} onClick={() => {
          const data = blank(purpose); data.tool = tool.tool; data.name = `${names[purpose]} · ${tool.tool}`.slice(0, 200); data.description = (tool.description ?? "").slice(0, 2000); data.inputs = pretty(tool.parameters ?? {}).slice(0, 2000); data.outputs = tool.outputSchema ? pretty(tool.outputSchema).slice(0, 2000) : ""; edit(data); setDiscovered(null);
        }}>建立{names[purpose]}条目</Button>)}</div>
        <details><summary>工具参数结构</summary><pre className="ops-report">{pretty(tool.parameters ?? {})}</pre></details>
      </article>)}</div>{!list.length && <p className="ops-empty">没有匹配工具。</p>}
    </section></div>}
    {importing && <div className="ops-overlay"><section className="ops-dialog ops-wide" role="dialog" aria-modal="true" aria-label="导入字典文档">
      <div className="ops-section-title"><div><h2>导入字典文档</h2><p>先解析为草稿，再检查、修改和保存；导入不会执行查询或保留旧验证状态。</p></div><Button disabled={busy} onClick={() => setImporting(false)}>关闭</Button></div>
      {error && <div role="alert" className="ops-notice ops-error">{error}</div>}
      <Field title="选择文档" hint="支持 UTF-8 的 .md、.txt、.json，最大 64 KB。"><input type="file" accept=".md,.txt,.json,text/markdown,text/plain,application/json" disabled={busy} onChange={(e) => {
        const file = e.target.files?.[0]; if (!file) return;
        act(async () => { if (file.size > 64000) throw new Error("文档超过 64 KB，请拆分后导入"); setImportText(await file.text()); setImportDrafts([]); });
      }} /></Field>
      <Field title="文档内容" hint="结构化 Markdown 使用 # 名称、## 用途/工具/描述/数据对象/输入/输出/关联关系/时间口径/限制/查询模板；普通文档作为参考说明保存。"><textarea rows={10} maxLength={64000} value={importText} onChange={(e) => { setImportText(e.target.value); setImportDrafts([]); }} /></Field>
      <Button primary disabled={busy || !importText.trim()} onClick={() => act(async () => { const value = await call("dictionary.import", { text: importText }); setImportDrafts(value.drafts); })}>解析并预览</Button>
      {importDrafts.map((entry, i) => <article className="ops-import-draft" key={i}><div><strong>{entry.name || `草稿 ${i + 1}`}</strong><small>{names[entry.purpose] ?? entry.purpose} · {entry.tool || "未指定工具"} · 待验证</small><p>{entry.description}</p></div><Button onClick={() => { edit(entry, false); setImporting(false); }}>编辑此草稿</Button></article>)}
    </section></div>}
    {deletion && <div className="ops-overlay"><section className="ops-dialog" role="dialog" aria-modal="true" aria-label="删除字典条目">
      <h2>删除“{deletion.name}”？</h2><p className="ops-delete-description">删除后不再供新方案选择，历史批次的快照保留。</p>
      {references(deletion.id).length > 0 && <p>仍被方案引用：{references(deletion.id).map((p) => p.name).join("、")}</p>}
      {error && <div role="alert" className="ops-notice ops-error">{error}</div>}
      <div className="ops-actions ops-delete-actions"><Button autoFocus disabled={busy} onClick={() => setDeletion(null)}>取消</Button><Button danger disabled={busy || references(deletion.id).length > 0} onClick={() => act(async () => { await call("dictionary.delete", { id: deletion.id, revision: deletion.revision }); await onChanged(); setDeletion(null); }, "字典条目已删除")}>确认删除条目</Button></div>
    </section></div>}
    {validation && <div className="ops-overlay"><form className="ops-dialog ops-wide" aria-label="验证字典查询" onSubmit={async (e) => {
      e.preventDefault(); await act(async () => {
        const purpose = validation.entry.purpose, sample = {};
        const split = (text) => text.split(/[\s,，]+/).filter(Boolean);
        if (purpose === "assets") sample.ips = split(validation.ips);
        if (purpose === "paths") { try { sample.pairs = JSON.parse(validation.pairs); } catch { throw new Error("交换机端点对须为合法 JSON 数组"); } }
        if (purpose === "events") { sample.hosts = split(validation.hosts); sample.start = Date.parse(validation.start); sample.end = Date.parse(validation.end); if (![validation.start, validation.end].every((t) => /(?:Z|[+-]\d{2}:\d{2})$/i.test(t)) || !Number.isFinite(sample.start) || !Number.isFinite(sample.end) || sample.start >= sample.end) throw new Error("请填写带时区且开始早于结束的时间范围"); }
        if (["memory", "knowledge"].includes(purpose)) sample.query = validation.query;
        const result = await call("dictionary.validate", { id: validation.entry.id, revision: validation.entry.revision, workspace: validation.workspace, agentPreset: validation.agentPreset, sample });
        setValidationResult(result); await onChanged();
      });
    }}><div className="ops-section-title"><div><h2>验证查询 · {validation.entry.name}</h2><p>修订 {validation.entry.revision} · {names[validation.entry.purpose]}</p></div><Button disabled={busy} onClick={() => setValidation(null)}>关闭</Button></div>
      <div className="ops-notice">执行一次小范围只读查询，使用 DSH 原有工具策略；不会调用 AI 模型或发送消息。<small>会创建名称为“MCP 字典验证”的会话用于工具执行与追踪。验证通过表示查询和返回结构可用，字段业务含义仍需核对；空结果只表示查询可执行，不验证样例字段。</small></div>
      {error && <div role="alert" className="ops-notice ops-error">{error}</div>}
      <div className="ops-form-grid"><Field title="验证工作目录"><input required value={validation.workspace} onChange={(e) => setValidation({ ...validation, workspace: e.target.value })} /></Field><Field title="验证 Agent Preset"><input value={validation.agentPreset} onChange={(e) => setValidation({ ...validation, agentPreset: e.target.value })} /></Field></div>
      {validation.entry.purpose === "assets" && <Field title="样例主机 IP" hint="最多 2 个已知存在的 IP，以空格或逗号分隔；不会扩大到全表查询。"><textarea required rows={2} value={validation.ips} onChange={(e) => setValidation({ ...validation, ips: e.target.value })} /></Field>}
      {validation.entry.purpose === "paths" && <Field title="样例交换机端点对" hint='仅 1 对交换机名，例如 [{"src":"switch-a","dst":"switch-b"}]。'><textarea required rows={5} value={validation.pairs} onChange={(e) => setValidation({ ...validation, pairs: e.target.value })} /></Field>}
      {validation.entry.purpose === "events" && <><Field title="样例交换机名称" hint="最多 2 台，以空格或逗号分隔；窗口最多 1 小时。"><textarea required rows={2} value={validation.hosts} onChange={(e) => setValidation({ ...validation, hosts: e.target.value })} /></Field><div className="ops-form-grid"><Field title="窗口开始" hint="须含时区，例如 2026-11-13T08:00:00+08:00"><input required value={validation.start} onChange={(e) => setValidation({ ...validation, start: e.target.value })} /></Field><Field title="窗口结束"><input required value={validation.end} onChange={(e) => setValidation({ ...validation, end: e.target.value })} /></Field></div></>}
      {["memory", "knowledge"].includes(validation.entry.purpose) && <Field title="样例检索词" hint="使用具体错误码或已知案例标识核对返回内容。"><input required maxLength={1000} value={validation.query} onChange={(e) => setValidation({ ...validation, query: e.target.value })} /></Field>}
      {validationResult && <div className="ops-notice ops-validation-result"><DictionaryStatus validation={validationResult.validation} /><p>{validationResult.validation?.message}</p><small>返回 {validationResult.validation?.rowCount ?? "—"} 条 · 耗时 {validationResult.validation?.elapsedMs ?? "—"} ms · {formatTime(validationResult.validation?.checkedAt)}</small>{validationResult.validation?.fields?.length > 0 && <small>返回字段：{validationResult.validation.fields.join("、")}</small>}{validationResult.validation?.sessionId && <small>验证会话：{validationResult.validation.sessionId}</small>}</div>}
      <div className="ops-sticky-footer"><button className="ops-button ops-primary" disabled={busy}>{busy ? "正在验证…" : "执行只读验证"}</button></div>
    </form></div>}
  </>;
}
