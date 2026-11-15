// v2 纯单机：不再有后端。api.get/post/put/del 直接走路由表（utils/db.js），
// 数据存 uni storage，飞行模式全功能可用。
// 将来若重启服务端/小程序版，把 request() 换回 uni.request 即可，页面层不用动。
import { localRequest } from "./db";

// 轻用户标识（v2 仅用于本地存储命名空间，无登录体系）
export function getUser() {
  let u = uni.getStorageSync("user_code");
  if (!u) {
    u = "u" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    uni.setStorageSync("user_code", u);
  }
  return u;
}

// 解析类端点是纯函数（不碰存储），一律本地跑：省云函数往返，
// 规则引擎调优也不用重新部署云函数
const LOCAL_PARSE_PATHS = ["/api/ddls/parse", "/api/ai/parse-voice", "/api/ai/parse-timetable-text"];

export function request(method, path, data) {
  if (LOCAL_PARSE_PATHS.includes(path)) return localRequest(method, path, data);
  // #ifdef MP-WEIXIN
  // 小程序线：走云函数（cloudfunctions/api，同一套 db-core 逻辑 + 云端 KV）
  return uni.cloud
    .callFunction({ name: "api", data: { method, path, body: data || {} } })
    .then((r) => {
      const res = r && r.result;
      if (!res || !res.ok) throw new Error((res && res.error) || "云函数调用失败");
      return res.data;
    });
  // #endif
  // #ifndef MP-WEIXIN
  return localRequest(method, path, data);
  // #endif
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
