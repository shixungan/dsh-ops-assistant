export function imStatus(im) {
  const available = !!im;
  const missing = ["listBots", "listTargets", "send"].filter(
    (key) => typeof im?.[key] !== "function",
  );
  return {
    available,
    ready: available && missing.length === 0,
    message: !available
      ? "未发现同一 DSH Host 中启用的 DSH-IM；请先在当前 DSH 安装并启用 IM 机器人插件。"
      : missing.length
        ? `DSH-IM 缺少接口：${missing.join("、")}，请升级支持主动投递的版本。`
        : "已连接本机 DSH-IM，可选择渠道、机器人及已保存的群聊或私聊目标。",
  };
}
export function requireIm(im) {
  const status = imStatus(im);
  if (!status.ready) throw new Error(status.message);
  return im;
}
export async function listBots(im) {
  const rows = await requireIm(im).listBots();
  if (!Array.isArray(rows))
    throw new Error("DSH-IM 返回了无法识别的机器人列表");
  return rows.map(({ botId, channel, name }) => ({
    botId,
    channel,
    ...(typeof name === "string" ? { name } : {}),
  }));
}
export async function listTargets(im, botId) {
  const rows = await requireIm(im).listTargets(botId);
  if (!Array.isArray(rows)) throw new Error("DSH-IM 返回了无法识别的目标列表");
  // The UI needs aliases and labels, not platform routing data or credentials.
  return rows.map(({ targetId, name, kind }) => ({ targetId, name, kind }));
}
export async function validateTargets(im, delivery) {
  if (delivery.deliveryMode === "off") return;
  const bots = await listBots(im);
  const grouped = new Map();
  for (const target of delivery.targets) {
    const bot = bots.find((b) => b.botId === target.botId);
    if (!bot) throw new Error("所选机器人已不存在，请刷新 DSH-IM 列表重新选择");
    if (!grouped.has(target.botId))
      grouped.set(target.botId, await listTargets(im, target.botId));
    const saved = grouped
      .get(target.botId)
      .find((t) => t.targetId === target.targetId);
    if (!saved)
      throw new Error(
        `所选投递目标 ${target.targetId} 已不存在，请在 DSH-IM 保存目标后重新选择`,
      );
    Object.assign(target, {
      channel: bot.channel,
      targetName: saved.name || saved.targetId,
    });
  }
}
