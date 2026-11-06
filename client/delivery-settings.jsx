import React, { useEffect, useState } from "react";

const channels = {
  feishu: "飞书 / Lark",
  lark: "飞书 / Lark",
  wechat: "微信",
  dingtalk: "钉钉",
  wecom: "企业微信",
  qq: "QQ",
  slack: "Slack",
  telegram: "Telegram",
  discord: "Discord",
  whatsapp: "WhatsApp",
  matrix: "Matrix",
  email: "邮件",
};
const kinds = {
  user: "私聊",
  group: "群聊",
  conversation: "会话",
  thread: "话题",
  chat: "聊天",
  topic: "话题",
  channel: "频道",
};
function SelectField({ title, children, ...props }) {
  const id = React.useId();
  return (
    <div className="ops-field">
      <label htmlFor={id}>{title}</label>
      <select id={id} {...props}>
        {children}
      </select>
    </div>
  );
}

export function DeliverySettings({ value, onChange, call, im, disabled }) {
  const [bots, setBots] = useState([]);
  const [targets, setTargets] = useState([]);
  const [channel, setChannel] = useState("");
  const [botId, setBotId] = useState("");
  const [revision, setRevision] = useState(0);
  const [loadingBots, setLoadingBots] = useState(false);
  const [loadingTargets, setLoadingTargets] = useState(false);
  const [botError, setBotError] = useState("");
  const [targetError, setTargetError] = useState("");
  useEffect(() => {
    let active = true;
    setBots([]);
    setBotError("");
    if (!im?.ready) {
      setLoadingBots(false);
      return;
    }
    setLoadingBots(true);
    call("im.bots", {})
      .then((rows) => {
        if (active) setBots(rows);
      })
      .catch((error) => {
        if (active) setBotError(error.message);
      })
      .finally(() => {
        if (active) setLoadingBots(false);
      });
    return () => {
      active = false;
    };
  }, [call, im?.ready, revision]);
  useEffect(() => {
    let active = true;
    setTargets([]);
    setTargetError("");
    if (!botId || !im?.ready) {
      setLoadingTargets(false);
      return;
    }
    setLoadingTargets(true);
    call("im.targets", { botId })
      .then((rows) => {
        if (active) setTargets(rows);
      })
      .catch((error) => {
        if (active) setTargetError(error.message);
      })
      .finally(() => {
        if (active) setLoadingTargets(false);
      });
    return () => {
      active = false;
    };
  }, [call, botId, im?.ready, revision]);
  const update = (key, next) => onChange({ ...value, [key]: next });
  const knownChannels = [...new Set(bots.map((b) => b.channel))];
  return (
    <div className="ops-delivery-settings">
      <SelectField
        title="报告投递"
        value={value.deliveryMode}
        disabled={disabled}
        onChange={(e) => update("deliveryMode", e.target.value)}
      >
        <option value="off">关闭：只保存在运维平台</option>
        <option value="manual">手动：查看报告后点击推送</option>
        <option value="auto">自动：完成后推送到选定目标</option>
      </SelectField>
      <div className="ops-notice">{im?.message ?? "正在检测 DSH-IM…"}</div>
      <div className="ops-actions" style={{ marginBottom: 16 }}>
        <button
          type="button"
          className="ops-button"
          disabled={disabled || loadingBots || loadingTargets}
          onClick={() => setRevision((n) => n + 1)}
        >
          刷新渠道与目标
        </button>
        {value.deliveryMode === "off" && (
          <small>可先选好接收目标；保持关闭时不会发送消息。</small>
        )}
      </div>
      {botError && (
        <div role="alert" className="ops-notice ops-error">
          {botError}
        </div>
      )}
      <SelectField
        title="DSH-IM 投递渠道"
        value={channel}
        disabled={disabled || !im?.ready || loadingBots}
        onChange={(e) => {
          setChannel(e.target.value);
          setBotId("");
        }}
      >
        <option value="">
          {loadingBots ? "正在读取渠道…" : "选择已接入的渠道"}
        </option>
        {knownChannels.map((c) => (
          <option key={c} value={c}>
            {channels[c] ?? c}
          </option>
        ))}
      </SelectField>
      <SelectField
        title="本地 IM 机器人"
        value={botId}
        disabled={disabled || !channel || loadingBots}
        onChange={(e) => setBotId(e.target.value)}
      >
        <option value="">选择机器人</option>
        {bots
          .filter((b) => b.channel === channel)
          .map((b) => (
            <option key={b.botId} value={b.botId}>
              {b.name || b.botId}
            </option>
          ))}
      </SelectField>
      {targetError && (
        <div role="alert" className="ops-notice ops-error">
          {targetError}
        </div>
      )}
      <SelectField
        title="添加接收目标"
        value=""
        disabled={disabled || !botId || loadingTargets}
        onChange={(e) => {
          const target = targets.find((t) => t.targetId === e.target.value);
          if (
            target &&
            !value.targets.some(
              (t) => t.botId === botId && t.targetId === target.targetId,
            )
          )
            update("targets", [
              ...value.targets,
              {
                botId,
                targetId: target.targetId,
                channel,
                targetName: target.name || target.targetId,
              },
            ]);
        }}
      >
        <option value="">
          {loadingTargets ? "正在读取接收目标…" : "选择已保存的群聊或私聊目标"}
        </option>
        {targets.map((t) => (
          <option
            key={t.targetId}
            value={t.targetId}
            disabled={value.targets.some(
              (v) => v.botId === botId && v.targetId === t.targetId,
            )}
          >
            {t.name || t.targetId} · {kinds[t.kind] ?? t.kind}
          </option>
        ))}
      </SelectField>
      {im?.ready && !loadingBots && !botError && !bots.length && (
        <p className="ops-warn">
          DSH-IM 已启用，但尚未发现机器人。请先在“设置 → IM机器人”接入渠道。
        </p>
      )}
      {botId && !loadingTargets && !targetError && !targets.length && (
        <p className="ops-warn">
          此机器人尚无已保存的投递目标。请在“设置 → IM机器人 → 机器人齿轮 →
          新建目标”中保存群聊或私聊目标，再刷新。
        </p>
      )}
      <div className="ops-targets">
        {value.targets.map((t) => (
          <div key={JSON.stringify([t.botId, t.targetId])}>
            <span>
              {t.targetName || t.targetId}
              <small>
                {channels[t.channel] ?? t.channel ?? "DSH-IM"} · {t.botId} ·{" "}
                {t.targetId}
              </small>
            </span>
            <button
              type="button"
              className="ops-button"
              disabled={disabled}
              onClick={() =>
                update(
                  "targets",
                  value.targets.filter((x) => x !== t),
                )
              }
            >
              移除
            </button>
          </div>
        ))}
      </div>
      <small>
        机器人凭据和接收目标由本机 DSH-IM
        管理；这里选择目标并保存到巡检任务，不会创建新的机器人。
      </small>
      <label className="ops-check">
        <input
          type="checkbox"
          checked={value.sendDataOnFailure}
          disabled={disabled}
          onChange={(e) => update("sendDataOnFailure", e.target.checked)}
        />
        分析失败时发送标明“AI 未完成”的数据汇总
      </label>
    </div>
  );
}
