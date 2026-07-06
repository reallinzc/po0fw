# po0fw — po0 防火墙自动加白 Surge 模块

自动把设备当前出口 IP 加入 po0 防火墙白名单，加白后才能连上开启了防火墙的 po0 机器。

📖 **图文教程 / 一键安装：<https://po0fw.rlyio.com/>**

## 特性

- **多机器**：`tokens` 参数英文逗号分割多个 `pgnfw_` token，一台机器一个。
- **省坑位**：GET 先查，当前出口已在白名单则不 POST（白名单上限 5 个，API 无删除能力）。
- **蜂窝优化**：蜂窝（CGNAT）下自动加白 24h 内最多消耗 2 个坑位，超限只通知；面板手动刷新不受限。
- **即时响应**：network-changed 事件即时触发 + 每 2 分钟 cron 兜底。
- **面板**：显示白名单 IP 与坑位占用（不显示 token），蜂窝加白的 IP 标 📶，当前出口标 ←。
- **安静**：KV 记录状态，仅在失败、限频或消耗新坑位时通知。

## 支持的客户端

| 客户端 | 载体 | token 配置 |
|---|---|---|
| Surge | `po0-firewall-whitelist.sgmodule` | 模块参数 `tokens` |
| Egern / Shadowrocket | 同上（导入 Surge 模块） | 模块参数 `tokens` |
| Loon | `loon/po0-firewall-whitelist.plugin` | 插件设置 `API tokens` |
| Stash | `stash/po0-firewall-whitelist.stoverride` | 覆写内 `argument: tokens=` |
| Quantumult X | `quantumultx/po0-firewall-whitelist.snippet` | 存储 key `po0fw_tokens`（BoxJs）或脚本内 `INLINE_TOKENS` |

同一份 `scripts/po0-firewall-whitelist.js`，内置环境兼容层（`$httpClient`/`$task.fetch`、`$persistentStore`/`$prefs`、`$notification`/`$notify`）。不支持 `$network` 的客户端按非蜂窝处理；不支持面板的客户端仅少一个手动刷新入口。

一键安装入口见教程页 <https://po0fw.rlyio.com/>。token 只保存在你自己的客户端配置里，本仓库不包含、不上传任何 token。
