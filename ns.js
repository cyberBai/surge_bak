/******************************
脚本功能：NodeSeek 论坛每日签到（领取鸡腿）
适用环境：Surge / Loon / QuantumultX
更新时间：2026-06-27

使用说明：
1. 在 Surge 中给 www.nodeseek.com 开启 MITM。
2. 用 Surge 打开/刷新一次 NodeSeek 网站任意页面（比如首页或论坛列表），
   脚本会自动从请求头里截取登录 Cookie 并保存。
3. cron 会在设定的时间窗口内被多次唤起（例如每 5 分钟一次），脚本内部用
   “抽签”方式保证当天只有一次会真正执行签到，且每天命中的时间点都不一样。
   这样避免了用 sleep 长时间挂起脚本而被系统判超时强杀的问题。

参考实现：
- 签到逻辑参考 xinycai/nodeseek_signin（直接用已登录 Cookie 调用签到接口）
- 真实签到接口：POST https://www.nodeseek.com/api/attendance?random=true
*******************************/

var isQX = typeof $task !== "undefined";
var isLoon = typeof $loon !== "undefined";
var isSurge = typeof $httpClient !== "undefined" && !isLoon;

var $http = {
  fetch: function (opts) {
    if (isQX) return $task.fetch(opts);
    return new Promise(function (resolve, reject) {
      var method = (opts.method || "GET").toUpperCase();
      var handler = function (err, resp, data) {
        if (err) reject(err);
        else resolve({ statusCode: resp.statusCode || resp.status, headers: resp.headers, body: data });
      };
      if (method === "POST") $httpClient.post(opts, handler);
      else $httpClient.get(opts, handler);
    });
  }
};

var $store = {
  read: function (key) {
    return isQX ? $prefs.valueForKey(key) : $persistentStore.read(key);
  },
  write: function (val, key) {
    return isQX ? $prefs.setValueForKey(val, key) : $persistentStore.write(val, key);
  }
};

var notify = isQX
  ? function (t, s, b) { $notify(t, s, b); }
  : function (t, s, b) { $notification.post(t, s, b); };

var COOKIE_KEY = "NodeSeek_Cookie";
var LAST_DONE_DATE_KEY = "NodeSeek_LastDoneDate";   // 今天是否已经处理完（成功/已签到/Cookie失效）
var TRIGGER_DATE_KEY = "NodeSeek_TriggerDate";       // 当前计数所属的日期
var TRIGGER_COUNT_KEY = "NodeSeek_TriggerCount";     // 当前日期下已触发次数

var isGetHeader = typeof $request !== "undefined";

// random=true 表示随机鸡腿奖励（论坛默认收益更高也更随机），改成 false 则为固定档位
var SIGN_RANDOM = true;
// 单次任务最大重试次数（遇到网络错误/签到失败时）
var MAX_RETRY = 3;

// 时间窗口内 cron 一共会触发多少次，必须和 sgmodule 里 cron 表达式的触发次数保持一致！
// 例如 cronexp="*/5 8 * * *" 表示 8:00~8:55 每 5 分钟触发一次，一共 12 次，这里就填 12。
var TOTAL_SLOTS_PER_WINDOW = 12;

var COMMON_HEADERS = {
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "origin": "https://www.nodeseek.com",
  "referer": "https://www.nodeseek.com/board",
  "Content-Type": "application/json"
};

function pad(n) { return n < 10 ? "0" + n : String(n); }

function todayStr() {
  var d = new Date();
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

function getStoredCookie() {
  try {
    var cookie = $store.read(COOKIE_KEY);
    return cookie ? String(cookie).trim() : "";
  } catch (e) {
    console.log("[NodeSeek] 读取 Cookie 出错: " + e);
    return "";
  }
}

function saveCookie(cookie) {
  try {
    if (!cookie) return false;
    var oldCookie = getStoredCookie();
    if (oldCookie !== cookie) {
      $store.write(cookie, COOKIE_KEY);
      console.log("[NodeSeek] Cookie 已保存/更新");
      return true;
    }
    return false;
  } catch (e) {
    console.log("[NodeSeek] 保存 Cookie 出错: " + e);
    return false;
  }
}

function getErrMsg(e) {
  if (!e) return "未知错误";
  if (typeof e === "string") return e;
  if (e.error) return String(e.error);
  if (e.message) return String(e.message);
  return String(e);
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function buildHeaders(cookie) {
  var h = {};
  for (var k in COMMON_HEADERS) { h[k] = COMMON_HEADERS[k]; }
  h["Cookie"] = cookie;
  return h;
}

function signIn(headers) {
  var url = "https://www.nodeseek.com/api/attendance?random=" + (SIGN_RANDOM ? "true" : "false");
  return $http
    .fetch({ url: url, headers: headers, method: "POST", body: "{}" })
    .then(function (resp) {
      var status = resp.statusCode || 0;
      var body = resp.body || "{}";
      console.log("[NodeSeek] attendance -> HTTP " + status + " " + body);

      var data = {};
      try { data = JSON.parse(body); } catch (e) {}
      var msg = data.message || "";

      if (status === 401 || data.status === 404 || /未登录|登录已过期|请先登录/.test(msg)) {
        return { result: "invalid", msg: msg || "Cookie 已失效，请重新获取" };
      }
      if (msg.indexOf("鸡腿") !== -1 || data.success === true) {
        return { result: "success", msg: msg || "签到成功" };
      }
      if (msg.indexOf("已完成签到") !== -1 || msg.indexOf("已签到") !== -1) {
        return { result: "already", msg: msg || "今日已签到" };
      }
      return { result: "fail", msg: msg || ("HTTP " + status) };
    });
}

// 返回 Promise<{result, msg}>，不在内部调用 $done，由调用者统一处理收尾
function doCheckin(attempt, maxRetry, headers) {
  console.log("[NodeSeek] 第 " + (attempt + 1) + "/" + maxRetry + " 次尝试签到");
  return signIn(headers)
    .then(function (info) {
      if (info.result === "fail" && attempt + 1 < maxRetry) {
        console.log("[NodeSeek] 签到失败，3 秒后重试: " + info.msg);
        return sleep(3000).then(function () {
          return doCheckin(attempt + 1, maxRetry, headers);
        });
      }
      return info;
    })
    .catch(function (e) {
      console.log("[NodeSeek] 请求出错: " + getErrMsg(e));
      if (attempt + 1 < maxRetry) {
        console.log("[NodeSeek] 3 秒后重试...");
        return sleep(3000).then(function () {
          return doCheckin(attempt + 1, maxRetry, headers);
        });
      }
      return { result: "error", msg: getErrMsg(e) };
    });
}

if (isGetHeader) {
  // ===== 抓包模式：从请求头里截取并保存 Cookie =====
  var allHeaders = $request.headers || {};
  var cookie = allHeaders.Cookie || allHeaders.cookie || "";
  if (!cookie || cookie.length < 20) {
    console.log("[NodeSeek] 未在请求头中找到有效 Cookie");
  } else {
    var saved = saveCookie(cookie);
    if (saved) {
      notify("NodeSeek", "Cookie 已更新 🍪", "后续将自动用于每日签到");
    }
  }
  $done({});
} else {
  // ===== 定时任务模式 =====
  // 通过“抽签”方式在窗口内的多次触发中随机选中一次真正执行签到，
  // 命中前的触发只做极快的计数判断，不会有长时间挂起，因此不会被系统判超时。
  (function () {
    var today = todayStr();

    var lastDone = $store.read(LAST_DONE_DATE_KEY);
    if (lastDone === today) {
      console.log("[NodeSeek] 今天已经处理过签到，跳过本次触发");
      $done({});
      return;
    }

    var triggerDate = $store.read(TRIGGER_DATE_KEY);
    var triggerCount = parseInt($store.read(TRIGGER_COUNT_KEY) || "0", 10);
    if (triggerDate !== today) {
      triggerCount = 0;
    }
    triggerCount += 1;
    $store.write(today, TRIGGER_DATE_KEY);
    $store.write(String(triggerCount), TRIGGER_COUNT_KEY);

    var remaining = Math.max(TOTAL_SLOTS_PER_WINDOW - triggerCount + 1, 1);
    var hit = remaining <= 1 || Math.random() < 1 / remaining;

    console.log(
      "[NodeSeek] 第 " + triggerCount + "/" + TOTAL_SLOTS_PER_WINDOW + " 次触发，本次" +
      (hit ? "命中，开始签到" : "未命中，跳过等下一次")
    );

    if (!hit) {
      $done({});
      return;
    }

    console.log("[NodeSeek] ===== 签到开始 =====");
    var storedCookie = getStoredCookie();
    if (!storedCookie) {
      console.log("[NodeSeek] 未找到已保存的 Cookie");
      notify("NodeSeek", "未获取到 Cookie ⚠️", "请先用 Surge 打开一次 NodeSeek 网站完成抓包");
      $done({});
      return;
    }

    var headers = buildHeaders(storedCookie);
    doCheckin(0, MAX_RETRY, headers).then(function (info) {
      if (info.result === "invalid") {
        console.log("[NodeSeek] " + info.msg);
        notify("NodeSeek 签到", "Cookie 已失效 ⚠️", "请用 Surge 重新打开 NodeSeek 网站以更新 Cookie");
        $store.write(today, LAST_DONE_DATE_KEY);
      } else if (info.result === "already") {
        console.log("[NodeSeek] 今日已签到: " + info.msg);
        notify("NodeSeek 今日已签到 ✅", "", info.msg);
        $store.write(today, LAST_DONE_DATE_KEY);
      } else if (info.result === "success") {
        console.log("[NodeSeek] 签到成功: " + info.msg);
        notify("NodeSeek 签到成功 🍗", "", info.msg);
        $store.write(today, LAST_DONE_DATE_KEY);
      } else {
        // fail / error：不标记为已处理，留给下一个触发点重试；
        // 若这是窗口内最后一次触发，则提示失败，今天不会再有机会了
        console.log("[NodeSeek] 本次未签到成功: " + info.msg);
        if (triggerCount >= TOTAL_SLOTS_PER_WINDOW) {
          notify("NodeSeek 签到失败 ❌", "", (info.msg || "未知错误") + "（已是今日最后一次机会）");
          $store.write(today, LAST_DONE_DATE_KEY);
        } else {
          console.log("[NodeSeek] 将在下一个触发点重试");
        }
      }
      console.log("[NodeSeek] ===== 签到结束 =====");
      $done({});
    });
  })();
}