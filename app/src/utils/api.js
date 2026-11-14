// 后端地址：自动跟随 H5 打开地址的主机（电脑 localhost / 手机局域网 IP / 公网域名），
// 只要 8000 端口在同一机器上开放即可。部署后如需走 nginx 同域，改为空串 "" 即可。
const host = typeof location !== "undefined" ? location.hostname : "localhost";
const BASE =
  host === "localhost" || host === "127.0.0.1"
    ? "http://localhost:8000"
    : `http://${host}:8000`;

// 轻用户：首次打开生成 user_code 存本地，之后每个请求带 X-User
export function getUser() {
  let u = uni.getStorageSync("user_code");
  if (!u) {
    u = "u" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    uni.setStorageSync("user_code", u);
  }
  return u;
}

// 换设备同步：手机上输入电脑的口令，直接接管那边的全部数据
export function setUserCode(code) {
  uni.setStorageSync("user_code", code);
}

export function request(method, path, data) {
  return new Promise((resolve, reject) => {
    uni.request({
      url: BASE + path,
      method,
      data,
      header: { "Content-Type": "application/json", "X-User": getUser() },
      timeout: 20000,
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.data);
        else
          reject(new Error((res.data && res.data.detail) || `HTTP ${res.statusCode}`));
      },
      fail: (e) => reject(new Error("网络错误：" + e.errMsg)),
    });
  });
}

export const api = {
  get: (p) => request("GET", p),
  post: (p, d) => request("POST", p, d),
  put: (p, d) => request("PUT", p, d),
  del: (p) => request("DELETE", p),
};

// 周次输入解析："1,3,5" / "1,2,3" → 数字数组；"14-20" 区间也支持
export function parseWeeks(text, totalWeeks) {
  const weeks = [];
  for (const chunk of (text || "").split(/[,，]/).map((s) => s.trim()).filter(Boolean)) {
    const m = chunk.match(/^(\d+)\s*[-–~]\s*(\d+)$/);
    if (m) {
      for (let w = +m[1]; w <= +m[2] && w <= totalWeeks; w++) weeks.push(w);
    } else if (/^\d+$/.test(chunk) && +chunk <= totalWeeks) {
      weeks.push(+chunk);
    }
  }
  return [...new Set(weeks)].sort((a, b) => a - b);
}

export function weeksToText(weeks, totalWeeks) {
  if (!weeks.length) return `1-${totalWeeks}`; // 空 = 每周都上
  if (weeks.length === totalWeeks) return `1-${totalWeeks}`;
  return weeks.join(",");
}
