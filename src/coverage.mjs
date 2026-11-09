// Only the sources selected by this inspection participate in coverage checks.
// Supported platform types are alternatives, not required connections.
export function coverageWarning(source) {
  if (source.status === "ok") return null;
  const name = source.name || source.id || "所选来源";
  const coverage = source.coverage;
  if (coverage?.kind === "snapshot")
    return `${name}：快照来源，历史覆盖有限`;
  if (coverage?.kind === "initial")
    return `${name}：尚未完成首次采集`;
  const gaps = [];
  if (coverage?.missingHeadSeconds > 0)
    gaps.push(`窗口前段未覆盖 ${coverage.missingHeadSeconds} 秒`);
  if (coverage?.missingTailSeconds > 0)
    gaps.push(`窗口末尾待采集 ${coverage.missingTailSeconds} 秒`);
  if (coverage?.kind === "failed") gaps.unshift("后台采集失败");
  if (coverage?.kind === "partial") gaps.unshift("后台采集结果不完整");
  if (gaps.length) return `${name}：${gaps.join("，")}`;
  return `${name}：${source.status === "failed" ? "来源不可用" : "窗口覆盖不足"}，详见报告`;
}

export function coverageWarnings(sources) {
  return sources.map(coverageWarning).filter(Boolean);
}
