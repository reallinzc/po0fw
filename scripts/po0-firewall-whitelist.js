/*
 * po0 防火墙自动加白
 * 兼容：Surge / Stash / Shadowrocket / Egern / Loon / Quantumult X
 *
 * GET  /firewall.php  只读状态：{enabled, whitelist[], limit, currentIp}
 * POST /firewall.php  把"当前请求源 IP"加入白名单（占一个坑位）
 * API 无删除能力（DELETE/PUT 405，POST 不接受指定 IP），坑位只能省着用。
 *
 * 策略：
 * - GET 先查，currentIp 已在白名单则跳过 POST（零坑位消耗）。
 * - WiFi/有线：IP 变了就自动 POST（家宽换 IP 场景，正常使用不受影响）。
 * - 蜂窝（主接口 pdp_ip*，CGNAT IP 频繁变化）：自动触发（cron/事件）在
 *   24h 内最多消耗 CELL_CAP 个新坑位，超限后只通知不 POST；
 *   面板手动刷新不受限。检测不到网络接口的客户端按非蜂窝处理。
 *
 * token 来源（优先级从高到低）：
 * 1. argument: tokens=<pgnfw_xxx>,<pgnfw_yyy>（Surge/Loon/Stash/Egern 模块参数）
 * 2. 持久化存储 key "po0fw_tokens"（Quantumult X 等不支持参数的客户端，
 *    可用 BoxJs 或一次性脚本写入）
 * 3. 下面的 INLINE_TOKENS 常量（自己维护脚本副本时直接填这里）
 */

var INLINE_TOKENS = "";

var API = "https://console.po0.com/modules/servers/penguin/api/firewall.php";
var STORE_PREFIX = "po0_fw_";
var TOKENS_KEY = "po0fw_tokens";
var CELL_CAP = 2; // 24h 内蜂窝自动加白最多消耗的坑位数
var CELL_WINDOW_MS = 24 * 3600 * 1000;

/* ---------- 环境兼容层 ---------- */

var isQX = typeof $task !== "undefined";
var isSurgeLike = typeof $httpClient !== "undefined"; // Surge/Stash/Shadowrocket/Egern/Loon

function storeRead(key) {
  if (isQX) return $prefs.valueForKey(key);
  if (typeof $persistentStore !== "undefined") return $persistentStore.read(key);
  return null;
}

function storeWrite(value, key) {
  if (isQX) return $prefs.setValueForKey(value, key);
  if (typeof $persistentStore !== "undefined") return $persistentStore.write(value, key);
  return false;
}

function notify(title, subtitle, body) {
  if (isQX) $notify(title, subtitle, body);
  else if (typeof $notification !== "undefined") $notification.post(title, subtitle, body);
}

function httpRequest(method, opts) {
  return new Promise(function (resolve) {
    if (isQX) {
      opts.method = method;
      $task.fetch(opts).then(
        function (resp) {
          resolve({ body: resp.body });
        },
        function (err) {
          resolve({ error: String((err && err.error) || err) });
        }
      );
    } else if (isSurgeLike) {
      var fn = method === "POST" ? $httpClient.post : $httpClient.get;
      fn(opts, function (error, response, body) {
        if (error) resolve({ error: String(error) });
        else resolve({ body: body });
      });
    } else {
      resolve({ error: "unsupported client" });
    }
  });
}

function getArgumentTokens() {
  if (typeof $argument === "string" && $argument.length > 0) {
    var pairs = $argument.split("&");
    for (var i = 0; i < pairs.length; i++) {
      var idx = pairs[i].indexOf("=");
      if (idx > 0 && pairs[i].slice(0, idx) === "tokens") {
        return decodeURIComponent(pairs[i].slice(idx + 1));
      }
    }
  }
  return "";
}

function onCellular() {
  try {
    var iface =
      ($network.v4 && $network.v4.primaryInterface) ||
      ($network.v6 && $network.v6.primaryInterface) ||
      "";
    return iface.indexOf("pdp_ip") === 0;
  } catch (e) {
    return false; // 客户端不支持 $network 时按非蜂窝处理
  }
}

function isPanelRun() {
  try {
    return $script.type === "generic"; // Surge/Stash 面板手动刷新
  } catch (e) {
    return false; // 无 $script 的客户端按自动触发处理（保守省坑位）
  }
}

function finish(title, content, allOk) {
  if (isQX) {
    $done();
    return;
  }
  $done({
    title: title,
    content: content,
    icon: allOk ? "checkmark.shield" : "exclamationmark.shield",
    "icon-color": allOk ? "#34C759" : "#FF3B30",
  });
}

/* ---------- 业务逻辑 ---------- */

function readHistory(key) {
  try {
    var h = JSON.parse(storeRead(key) || "[]");
    var cutoff = Date.now() - CELL_WINDOW_MS;
    return h.filter(function (e) {
      return e.ts > cutoff;
    });
  } catch (e) {
    return [];
  }
}

function apiCall(method, token) {
  return httpRequest(method, {
    url: API,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    timeout: 15,
  }).then(function (r) {
    if (r.error) return { error: r.error };
    try {
      var data = JSON.parse(r.body);
      data.applied =
        data.enabled === true &&
        Array.isArray(data.whitelist) &&
        data.whitelist.indexOf(data.currentIp) !== -1;
      return data;
    } catch (e) {
      return { error: "响应异常: " + String(r.body).slice(0, 80) };
    }
  });
}

function ensureWhitelisted(token, index) {
  var kvState = STORE_PREFIX + index;
  var kvHist = STORE_PREFIX + "hist_" + index;
  var cellular = onCellular();
  var panel = isPanelRun();

  return apiCall("GET", token).then(function (st) {
    var ctx = { st: st, kvState: kvState, kvHist: kvHist };
    if (st.error || st.enabled === false || st.applied) return ctx;

    // 需要 POST 占新坑位
    var hist = readHistory(kvHist);
    if (cellular && !panel) {
      var cellUsed = hist.filter(function (e) {
        return e.src === "cell";
      }).length;
      if (cellUsed >= CELL_CAP) {
        st.limited = true; // 蜂窝自动加白限频，面板手动刷新可强制
        return ctx;
      }
    }

    return apiCall("POST", token).then(function (st2) {
      st2.posted = true;
      if (st2.applied) {
        hist.push({ ip: st2.currentIp, src: cellular ? "cell" : "fixed", ts: Date.now() });
        storeWrite(JSON.stringify(hist.slice(-10)), kvHist);
      }
      ctx.st = st2;
      return ctx;
    });
  });
}

// 每 token 一行：不含 token，只含白名单/坑位信息；蜂窝加的 IP 标 📶
function describe(index, ctx) {
  var st = ctx.st;
  var head = "#" + (index + 1) + " ";
  if (st.error) return head + "❌ " + st.error;
  if (st.enabled === false) return head + "⚠️ 防火墙未启用";
  if (st.limited)
    return head + "⏸ 蜂窝自动加白已限频(24h内" + CELL_CAP + "个)，点面板可手动加白";
  if (!st.applied) return head + "❌ 加白未生效 " + st.whitelist.length + "/" + st.limit;

  var hist = readHistory(ctx.kvHist);
  var cellIps = {};
  hist.forEach(function (e) {
    if (e.src === "cell") cellIps[e.ip] = true;
  });
  var ips = st.whitelist
    .map(function (ip) {
      return ip + (cellIps[ip] ? " 📶" : "") + (ip === st.currentIp ? " ←" : "");
    })
    .join("\n    ");
  return (
    head + "✅ " + st.whitelist.length + "/" + st.limit + (st.posted ? " (新加白)" : "") + "\n    " + ips
  );
}

var tokens = (getArgumentTokens() || storeRead(TOKENS_KEY) || INLINE_TOKENS || "")
  .split(",")
  .map(function (s) {
    return s.trim();
  })
  .filter(function (s) {
    return s.length > 0;
  });

if (tokens.length === 0) {
  notify(
    "po0 防火墙加白",
    "未配置 token",
    "模块参数 tokens / 存储 key po0fw_tokens / 脚本内 INLINE_TOKENS 三选一填入 pgnfw_ token"
  );
  finish("po0 加白：未配置 token", "请填入 pgnfw_ token，多个用 , 分割", false);
} else {
  Promise.all(
    tokens.map(function (t, i) {
      return ensureWhitelisted(t, i);
    })
  ).then(function (results) {
    var okCount = 0;
    var exitIp = "?";
    var lines = [];
    var changed = false;
    var anyPosted = false;
    var anyLimited = false;

    for (var i = 0; i < results.length; i++) {
      var st = results[i].st;
      if (st.applied) okCount++;
      if (st.posted) anyPosted = true;
      if (st.limited) anyLimited = true;
      if (st.currentIp) exitIp = st.currentIp;
      lines.push(describe(i, results[i]));

      var state =
        (st.currentIp || "?") + "|" + (st.applied ? "1" : st.limited ? "L" : "0");
      if (storeRead(results[i].kvState) !== state) {
        storeWrite(state, results[i].kvState);
        changed = true;
      }
    }

    var allOk = okCount === results.length;
    var title =
      "po0 加白 " + okCount + "/" + results.length + " · 出口 " + exitIp + (onCellular() ? " 📶" : "");
    var content = lines.join("\n");

    // 失败/限频/消耗新坑位且状态有变化时才通知，例行检查保持安静
    if (changed && (!allOk || anyPosted || anyLimited)) {
      notify("po0 防火墙加白", title, content);
    }
    finish(title, content, allOk && !anyLimited);
  });
}
