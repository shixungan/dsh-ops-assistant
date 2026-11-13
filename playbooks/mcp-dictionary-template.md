# 主机 IP 到接入交换机

## 用途
assets

## 工具
postgresql-switch-info-execute_sql

## 描述
根据本批告警中的主机 IP，定位资产、机房和接入交换机。请将工具名替换为 DSH “发现 MCP”页面中实际可用的完整名称。

## 数据对象
public.cmdb_online_ip_switch_port_current。此为示例结构，需核对你的数据库。

## 输入
告警中明确提供的源、目的 IP，去重批量查询；不根据相似主机名称猜测 IP。

## 输出
ip_address：主机 IP；asset_name：资产名称；asset_idc：资产机房；switch_hostname：接入交换机名称；physical_if_name：接入物理接口；ip_vrf：地址所属 VRF；ip_mapping_ambiguous、terminal_location_ambiguous：映射及接入位置是否存在歧义。

## 关联关系
使用 switch_hostname 关联拓扑的交换机身份。主机 IP 不等于交换机管理 IP。相同 IP 存在多个 VRF 或多个接入位置时保留候选，不能取第一条认定唯一路径。

## 时间口径
当前采集快照，仅用于资产定位，不能证明历史告警窗口内的在线状态。cmdb_observed_at 记录映射采集时间，具体时区与更新周期需在本环境核对。

## 限制
找不到映射时保留缺口，不扩大为全库扫描。映射存在不证明链路正常，当前拓扑也不能证明实际业务流量路径。

## 查询模板
```json
{
  "table": "public.cmdb_online_ip_switch_port_current",
  "columns": {
    "ip_address": "ip_address",
    "asset_name": "asset_name",
    "asset_idc": "asset_idc",
    "ip_vrf": "ip_vrf",
    "ip_mapping_ambiguous": "ip_mapping_ambiguous",
    "terminal_location_ambiguous": "terminal_location_ambiguous",
    "switch_hostname": "switch_hostname",
    "physical_if_name": "physical_if_name",
    "cmdb_observed_at": "cmdb_observed_at"
  }
}
```
