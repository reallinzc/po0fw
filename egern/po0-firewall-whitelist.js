/*
 * po0 防火墙自动加白 · Egern 原生脚本
 *
 * Egern 的脚本运行模型与 Surge 系不同：入口是 `export default async function(ctx)`，
 * 且没有 $httpClient/$persistentStore/$notification/$done 等全局，只能用 ctx.* API。
 * 因此 Egern 不复用共享脚本 scripts/po0-firewall-whitelist.js，而是本独立文件。
 * 两者业务逻辑保持一致——改动加白/槽位/通知策略时请同步修改两份。
 *
 * 行为：POST https://124.221.69.228/api/firewall/<token>/add[?slot=N]，把本机当前
 *   出口 IP 加白。token 走 URL 路径；服务端对已在白名单的 IP 幂等；写满 5 个后按
 *   写入时间 FIFO 淘汰（带 slot 的行永不淘汰）。token 来自模块参数 tokens
 *   （ctx.env.tokens），可带 @槽位 后缀（pgnfw_xxx@0）钉固定坑位。
 */

const API_BASE = "https://124.221.69.228/api/firewall/"; // + <token> + "/add"
const STORE_PREFIX = "po0_fw_";
const HIST_WINDOW_MS = 24 * 3600 * 1000; // 📶 标记的记账窗口

// tokens 分隔符兼容 , | ; 、 空白；每段可带 @槽位 后缀
function parseTokens(raw) {
  return String(raw || "")
    .split(/[,|;、\s]+/)
    .map(function (s) {
      return s.trim();
    })
    .filter(function (s) {
      return s.indexOf("pgnfw_") === 0;
    })
    .map(function (s) {
      const at = s.indexOf("@");
      if (at === -1) return { token: s, slot: null };
      const n = parseInt(s.slice(at + 1), 10);
      return { token: s.slice(0, at), slot: isNaN(n) ? null : n };
    });
}

// WiFi 有 ssid 视为非蜂窝；否则若有蜂窝载波/制式则视为蜂窝（仅用于 📶 标记）
function onCellular(ctx) {
  try {
    const d = ctx.device || {};
    const onWifi = !!(d.wifi && d.wifi.ssid);
    const hasCell = !!(d.cellular && (d.cellular.carrier || d.cellular.radio));
    return !onWifi && hasCell;
  } catch (e) {
    return false;
  }
}

function readHistory(ctx, key) {
  let h;
  try {
    h = ctx.storage.getJSON(key) || [];
  } catch (e) {
    h = [];
  }
  if (!Array.isArray(h)) h = [];
  const cutoff = Date.now() - HIST_WINDOW_MS;
  return h.filter(function (e) {
    return e && e.ts > cutoff;
  });
}

async function apiCall(ctx, token, slot) {
  let url = API_BASE + encodeURIComponent(token) + "/add";
  if (slot !== null && slot !== undefined && slot !== "") {
    url += "?slot=" + encodeURIComponent(slot);
  }
  let resp;
  try {
    resp = await ctx.http.post(url, {
      headers: { "Content-Type": "application/json" },
      body: "",
      timeout: 15000,
    });
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
  let text = "";
  try {
    text = await resp.text();
  } catch (e) {}
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (e) {}
  // 带槽位写入且本机 IP 已占用别的槽位 → 服务端 403 冲突，需去 UI 删旧槽位
  if (resp.status === 403) {
    return {
      error: "槽位冲突：本机 IP 已在其它槽位，请先去 UI 删除",
      conflict: true,
      currentIp: data && data.currentIp,
    };
  }
  if (!data) return { error: "响应异常: " + String(text).slice(0, 80) };
  // whitelist 元素为 {ip, slot} 对象：记下 ip→slot 再摊平成 IP 数组
  const raw = Array.isArray(data.whitelist) ? data.whitelist : [];
  data.slotOf = {};
  raw.forEach(function (e) {
    if (e && typeof e === "object" && e.slot !== null && e.slot !== undefined) {
      data.slotOf[e.ip] = e.slot;
    }
  });
  data.whitelist = raw.map(function (e) {
    return e && typeof e === "object" ? e.ip : e;
  });
  data.applied = data.enabled === true && data.whitelist.indexOf(data.currentIp) !== -1;
  return data;
}

async function ensure(ctx, item, index, cellular) {
  const kvState = STORE_PREFIX + index;
  const kvHist = STORE_PREFIX + "hist_" + index;
  const st = await apiCall(ctx, item.token, item.slot);
  if (st.applied) {
    const hist = readHistory(ctx, kvHist);
    const last = hist.length ? hist[hist.length - 1] : null;
    if (!last || last.ip !== st.currentIp) {
      hist.push({ ip: st.currentIp, src: cellular ? "cell" : "fixed", ts: Date.now() });
      ctx.storage.setJSON(kvHist, hist.slice(-10));
    }
  }
  return { kvState: kvState, kvHist: kvHist, slot: item.slot, st: st };
}

// 每 token 一行：不含 token，只含白名单/坑位信息；钉住的槽位标 📌，蜂窝加的 IP 标 📶
function describe(ctx, index, c) {
  const st = c.st;
  const pin = c.slot !== null && c.slot !== undefined && c.slot !== "" ? " 📌" + c.slot : "";
  const head = "#" + (index + 1) + pin + " ";
  if (st.error) return head + "❌ " + st.error;
  if (st.enabled === false) return head + "⚠️ 防火墙未启用";
  if (!st.applied) return head + "❌ 加白未生效 " + ((st.whitelist && st.whitelist.length) || 0) + "/" + st.limit;

  const hist = readHistory(ctx, c.kvHist);
  const cellIps = {};
  hist.forEach(function (e) {
    if (e.src === "cell") cellIps[e.ip] = true;
  });
  const slotOf = st.slotOf || {};
  const ips = st.whitelist
    .map(function (ip) {
      const slotTag = slotOf[ip] !== undefined ? " 📌" + slotOf[ip] : "";
      return ip + slotTag + (cellIps[ip] ? " 📶" : "") + (ip === st.currentIp ? " ←" : "");
    })
    .join("\n    ");
  return head + "✅ " + st.whitelist.length + "/" + st.limit + "\n    " + ips;
}

export default async function (ctx) {
  const tokens = parseTokens(ctx.env && ctx.env.tokens);
  if (tokens.length === 0) {
    ctx.notify({
      title: "po0 防火墙加白",
      subtitle: "未配置 token",
      body: "模块参数 tokens 填入 pgnfw_ token，多个用英文逗号分割",
    });
    return;
  }

  const cellular = onCellular(ctx);
  const results = [];
  for (let i = 0; i < tokens.length; i++) {
    results.push(await ensure(ctx, tokens[i], i, cellular));
  }

  let okCount = 0;
  let exitIp = "?";
  let changed = false;
  const lines = [];
  for (let i = 0; i < results.length; i++) {
    const st = results[i].st;
    if (st.applied) okCount++;
    if (st.currentIp) exitIp = st.currentIp;
    lines.push(describe(ctx, i, results[i]));

    const state = (st.currentIp || "?") + "|" + (st.applied ? "1" : "0");
    if (ctx.storage.get(results[i].kvState) !== state) {
      ctx.storage.set(results[i].kvState, state);
      changed = true;
    }
  }

  const title =
    "po0 加白 " + okCount + "/" + results.length + " · 出口 " + exitIp + (cellular ? " 📶" : "");
  // 仅在出口 IP 或加白状态较上次变化时通知，例行 cron 保持安静
  if (changed) {
    ctx.notify({ title: "po0 防火墙加白", subtitle: title, body: lines.join("\n") });
  }
}
