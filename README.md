# po0fw — po0 防火墙自动加白 Surge 模块

自动把设备当前出口 IP 加入 po0 防火墙白名单，加白后才能连上开启了防火墙的 po0 机器。

📖 **图文教程 / 一键安装：<https://po0fw.rlyio.com/>**

## 特性

- **多机器**：`tokens` 参数分割多个 `pgnfw_` token（逗号；Shadowrocket/QX 模块参数须用 `|`），一台机器一个。
- **无脑 POST**：每次直接上报当前出口 IP，服务端对重复 IP 幂等（不重复占坑、不推进淘汰）。白名单上限 5 个、写满按写入时间先进先出自动淘汰。
- **自动自愈**：被 FIFO 淘汰挤出白名单的设备，由其自身 cron/事件在几分钟内自动补回；蜂窝写入的 IP 在面板上有 📶 标记。
- **即时响应**：network-changed 事件即时触发 + 每 10 分钟 cron 兜底。
- **面板**：显示白名单 IP 与坑位占用（不显示 token），蜂窝加白的 IP 标 📶，当前出口标 ←。
- **安静**：KV 记录状态，仅在失败、限频或消耗新坑位时通知。

## 支持的客户端

| 客户端 | 载体 | token 配置 |
|---|---|---|
| Surge | `po0-firewall-whitelist.sgmodule` | 模块参数 `tokens` |
| Egern | `egern/po0-firewall-whitelist.yaml`（原生模块） | 模块参数 `tokens` |
| Shadowrocket | `shadowrocket/po0-firewall-whitelist.sgmodule` | 模块 → 编辑参数 → `tokens`（多 token 用 `\|` 分割） |
| Loon | `loon/po0-firewall-whitelist.plugin` | 插件设置 `API tokens` |
| Stash | `stash/po0-firewall-whitelist.stoverride` | 覆写内 `argument: tokens=` |
| Quantumult X | `quantumultx/po0-firewall-whitelist.snippet` | 存储 key `po0fw_tokens`（BoxJs）或脚本内 `INLINE_TOKENS` |

Surge/Loon/Stash/Shadowrocket/Quantumult X 共用 `scripts/po0-firewall-whitelist.js`，内置环境兼容层（`$httpClient`/`$task.fetch`、`$persistentStore`/`$prefs`、`$notification`/`$notify`）。不支持 `$network` 的客户端按非蜂窝处理；不支持面板的客户端仅少一个手动刷新入口。**Egern** 运行模型不同（`export default async function(ctx)`，无 `$` 全局），用独立的 `egern/po0-firewall-whitelist.js`（`ctx.http`/`ctx.storage`/`ctx.notify`/`ctx.env`/`ctx.device`），业务逻辑与共享脚本一致。

一键安装入口见教程页 <https://po0fw.rlyio.com/>。token 只保存在你自己的客户端配置里，本仓库不包含、不上传任何 token。
