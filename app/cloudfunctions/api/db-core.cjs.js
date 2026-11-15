// 自动生成：npm run sync-cf（源：slots.js + notice.js + db-core.js），勿手改
"use strict";
const __slots = (function () {
// 默认节次时刻表（每校作息不同，正式版做成可配置；14 节制覆盖早晚全时段）
const SLOT_TIMES = [
  ["08:00", "08:45"], // 1
  ["08:55", "09:40"], // 2
  ["10:00", "10:45"], // 3
  ["10:55", "11:40"], // 4
  ["11:50", "12:35"], // 5
  ["14:00", "14:45"], // 6
  ["14:55", "15:40"], // 7
  ["15:50", "16:35"], // 8
  ["16:45", "17:30"], // 9
  ["17:40", "18:25"], // 10
  ["19:00", "19:45"], // 11
  ["19:55", "20:40"], // 12
  ["20:50", "21:35"], // 13
  ["21:45", "22:30"], // 14
];

const SLOT_COUNT = SLOT_TIMES.length;
const DAY_NAMES = ["一", "二", "三", "四", "五", "六", "日"];

// 日程小图标（emoji），2026-11-14 定制：删铅笔/箱子/足球(改自行车)/试剂，
// 麦克风改电吉他挪到末位，睡觉排书本后、医院排拉面后。默认（含旧数据兜底）= 🎸
const EVENT_ICONS = [
  "📚", "💤", "🚲", "🎉", "🎂", "🚗", "🍜", "🏥", "🎬", "💼", "🎸",
];
const DEFAULT_EVENT_ICON = "🎸";

// 时间确定度四档：解析通知时自动判定，表单可改
const TIME_STATUS = [
  { key: "exact", label: "✅ 准点" },
  { key: "start_only", label: "▶️ 仅开始" },
  { key: "fuzzy", label: "⏰ 大概" },
  { key: "todo", label: "❓ 待定" },
];

// 课程卡片配色（按名称哈希取色，同一门课颜色稳定）
const PALETTE = [
  ["#EEF2FF", "#4F46E5"],
  ["#ECFDF5", "#059669"],
  ["#FFF7ED", "#EA580C"],
  ["#FDF2F8", "#DB2777"],
  ["#F0F9FF", "#0284C7"],
  ["#FAFAF5", "#65A30D"],
];
function courseColor(name) {
  let h = 0;
  for (const ch of name || "") h = (h * 31 + ch.codePointAt(0)) % 997;
  return PALETTE[h % PALETTE.length];
}

return { SLOT_TIMES, SLOT_COUNT, DAY_NAMES, EVENT_ICONS, DEFAULT_EVENT_ICON, TIME_STATUS, courseColor };
})();
const { SLOT_TIMES, SLOT_COUNT, DAY_NAMES, EVENT_ICONS, DEFAULT_EVENT_ICON, TIME_STATUS, courseColor } = __slots;

const __notice = (function () {
// 群通知解析 + 一句话时间解析（纯规则，零依赖，无 LLM）
// 从 v1 server/app/utils/notice.py(402行) + times.py(270行) 忠实移植为 JS，
// 2026-11 供小程序端与自用版共用。规则细节的"为什么"见各函数注释。
//
// 对外三个入口：
//   looksLikeNotice(text)          判定走"通知解析"还是"速记解析"
//   parseNotice(text, now?)        群通知长文 → {title, note, location, startAt, endAt, timeStatus}
//   resolveEventTime(text, now?)   一句话速记 → {title, startAt, endAt}
// 时间参数 now 仅测试用；输出时间为 "YYYY-MM-DDTHH:mm:00" 字符串（与后端序列化一致）。

// ============================== 公共工具 ==============================

const CN_NUM = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12,
};
const WEEKDAY_IDX = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 }; // 周一=0，同 Python weekday()

function pad(n) { return n < 10 ? "0" + n : "" + n; }
function fmtDT(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}
function pyWeekday(d) { return (d.getDay() + 6) % 7; }        // Mon=0..Sun=6
function isoWeekday(d) { return d.getDay() || 7; }            // Mon=1..Sun=7
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function addMinutes(d, n) { return new Date(d.getTime() + n * 60000); }
function addHours(d, n) { return addMinutes(d, n * 60); }
function dateOnly(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function sameDate(a, b) { return dateOnly(a).getTime() === dateOnly(b).getTime(); }
function isDigitStr(s) { return /^[0-9]+$/.test(s); }
function toInt(tok) {
  if (tok == null) return null;
  if (isDigitStr(tok)) return parseInt(tok, 10);
  return CN_NUM[tok];
}

// ============================== 速记引擎（times.py） ==============================
// 短句：时间即主体，全句扫描 token 自动分主/次（带"到/至"的是结束，第一个裸时间是开始）。

const PERIOD_DEFAULT = {
  凌晨: [1, 0], 清晨: [6, 0], 早上: [8, 0], 早晨: [8, 0],
  上午: [9, 0], 中午: [12, 0], 午后: [14, 0], 下午: [14, 0],
  傍晚: [18, 0], 晚上: [19, 0], 夜里: [21, 0],
};
const PM_WORDS = "凌晨|清晨|早上|早晨|上午|中午|下午|午后|傍晚|晚上|夜里";
const NUM_SRC = "([0-9]{1,2}|[一二两三四五六七八九十]{1,2})";
const CAND_RE = new RegExp(
  NUM_SRC + "(?:\\s*:\\s*([0-9]{1,2})|\\s*[点时]\\s*([0-9]{1,2}|半|一刻|三刻)?)?", "g");
const BARE_BAN_NEXT = "月日号个分节天周年";
const FILLER = /^(请帮我|帮我|麻烦|记得|提醒我|叫我|给我|我要|我|要去|记一下|记一笔|安排一下|安排|订|预约|设置)/;

function minuteOf(tok) {
  if (!tok) return 0;
  if (tok === "半") return 30;
  if (tok === "一刻") return 15;
  if (tok === "三刻") return 45;
  return isDigitStr(tok) && parseInt(tok, 10) < 60 ? parseInt(tok, 10) : 0;
}

function applyPeriod(hour, period) {
  if (["中午", "下午", "午后", "傍晚", "晚上", "夜里"].includes(period) && hour < 12) return hour + 12;
  return hour;
}

function anchorDate(s, now) {
  // 返回 { date, hasDate, spans }
  const spans = [];
  let m = /大后天|后天|明天|今天|今日/.exec(s);
  if (m) {
    const off = { 大后天: 3, 后天: 2, 明天: 1, 今天: 0, 今日: 0 }[m[0]];
    spans.push([m.index, m.index + m[0].length]);
    return { date: addDays(dateOnly(now), off), hasDate: true, spans };
  }
  // (?<!一)下周X：前一字符是"一"（"一下周三"副词）不算——JS 避开 lookbehind，手工判
  const nextW = /下(?:周|星期|礼拜)([一二三四五六日天])/.exec(s);
  if (nextW && s[nextW.index - 1] !== "一") {
    const t = WEEKDAY_IDX[nextW[1]];
    const nextMonday = addDays(dateOnly(now), 7 - pyWeekday(now));
    spans.push([nextW.index, nextW.index + nextW[0].length]);
    return { date: addDays(nextMonday, t), hasDate: true, spans };
  }
  const bareNextSafe = /下(?:周|星期|礼拜)(?![一二三四五六日天])/.exec(s); // 裸"下周" → 下周一
  if (bareNextSafe && s[bareNextSafe.index - 1] !== "一") {
    spans.push([bareNextSafe.index, bareNextSafe.index + bareNextSafe[0].length]);
    return { date: addDays(dateOnly(now), 7 - pyWeekday(now)), hasDate: true, spans };
  }
  m = /(?:周|星期|礼拜)[一二三四五六日天]/.exec(s);
  if (m) {
    const t = WEEKDAY_IDX[m[0].slice(-1)];
    spans.push([m.index, m.index + m[0].length]);
    return { date: addDays(dateOnly(now), (t - pyWeekday(now) + 7) % 7), hasDate: true, spans };
  }
  m = /(\d{1,2})月(\d{1,2})[日号]/.exec(s);
  if (m) {
    const d = new Date(now.getFullYear(), parseInt(m[1], 10) - 1, parseInt(m[2], 10));
    if (!isNaN(d)) {
      spans.push([m.index, m.index + m[0].length]);
      return { date: d, hasDate: true, spans };
    }
  }
  return { date: dateOnly(now), hasDate: false, spans };
}

function scanTokens(s) {
  // [{end, dw, cut:[a,b], period, hour, minute}]
  const out = [];
  CAND_RE.lastIndex = 0;
  let m;
  while ((m = CAND_RE.exec(s))) {
    const tok = m[1];
    const full = m[0];
    const nxt = s.slice(m.index + full.length, m.index + full.length + 1);
    const prv = s.slice(m.index - 1, m.index);
    const hasClock = /[点时:：]/.test(full);
    if (!hasClock && (BARE_BAN_NEXT.includes(nxt) || !isDigitStr(tok))) continue;
    if (prv && "第几".includes(prv)) continue;
    const hour = toInt(tok);
    if (hour == null) continue;
    if (hour === 0 && !hasClock) continue;
    // 时段词：token 前 3 字内的时段词（容忍"下午 2点"的空格）
    const pre = s.slice(Math.max(0, m.index - 3), m.index);
    const p2 = new RegExp(`(${PM_WORDS})\\s*$`).exec(pre);
    const period = p2 ? p2[1] : null;
    const minute = minuteOf(m[2] || m[3]);
    // 结束标记：数字前 8 字内以"到/至"收尾（可带日期词，"开到明天1点"）
    const pre8 = s.slice(Math.max(0, m.index - 8), m.index);
    const em = /[到至]\s*(?:大后天|后天|明天|今天|今日)?\s*$/.exec(pre8);
    const base8 = m.index - pre8.length;
    let dw = null;
    let cutLo;
    if (em) {
      const region = pre8.slice(em.index, em.index + em[0].length);
      const dwm = /(大后天|后天|明天|今天|今日)/.exec(region);
      dw = dwm ? dwm[1] : null;
      cutLo = base8 + em.index;
      // 前置动词（开到/做完到…）一起切掉，标题只留事件
      const vb = /(?:开|完|做|写|赶|上|聊|开完)\s*$/.exec(pre8.slice(0, em.index));
      if (vb) cutLo = Math.min(cutLo, base8 + vb.index);
    } else {
      cutLo = m.index;
    }
    if (period && p2) {
      cutLo = Math.min(cutLo, Math.max(0, m.index - 3) + p2.index);
    }
    out.push({ end: !!em, dw, cut: [cutLo, m.index + full.length], period, hour, minute });
  }
  return out;
}

const DURATIONS = [ // [正则, 分钟数函数]（"一个半小时"排在"半小时"前）
  [/([0-9]{1,2}|[一二两三四五])\s*个\s*半\s*小时/, (g) => toInt(g) * 60 + 30],
  [/半\s*个?\s*小时/, () => 30],
  [/([0-9]{1,2}|[一二两三四五])\s*个?\s*小时/, (g) => toInt(g) * 60],
  [/(\d{1,3})\s*分钟/, (g) => parseInt(g, 10)],
];

function resolveEventTime(text, now = new Date()) {
  let s = String(text || "").trim();
  s = s.replace(/今晚/g, "今天晚上").replace(/明晚/g, "明天晚上")
       .replace(/今早/g, "今天早上").replace(/明早/g, "明天早上");

  const { date: date_, hasDate, spans } = anchorDate(s, now);
  const toks = scanTokens(s);
  const starts = toks.filter((t) => !t.end);
  const ends = toks.filter((t) => t.end);
  let sc = starts.length ? starts[0] : null;
  const ec0 = ends.find((t) => ![0, 24].includes(t.hour));
  const ec = ec0 != null ? ec0 : (ends.length ? ends[0] : null);
  if (sc && [0, 24].includes(sc.hour)) { sc = { ...sc, hour: 23, minute: 59 }; }

  // ---- 开始 ----
  let period, hour, minute;
  if (sc) {
    period = sc.period; hour = sc.hour; minute = sc.minute;
  } else {
    period = null;
    const pm = new RegExp(PM_WORDS).exec(s);
    if (pm) { period = pm[0]; spans.push([pm.index, pm.index + pm[0].length]); }
    [hour, minute] = PERIOD_DEFAULT[period] || [9, 0];
  }
  if (hour != null) hour = applyPeriod(hour, period);
  if (hour != null && hour > 23) { hour = 23; minute = 59; }
  let start = new Date(date_.getFullYear(), date_.getMonth(), date_.getDate(),
    hour != null ? hour : 9, minute || 0, 0, 0);
  // 裸钟点（无时段词无日期）11-21 点歧义：取"离现在最近的未来"
  if (!hasDate && period == null && ![null, 0, 12, 23, 24].includes(hour)) {
    const alt = addHours(start, hour < 12 ? 12 : -12);
    if (alt > now && (start <= now || alt - now < Math.max(start - now, 0))) start = alt;
  }

  // ---- 结束 ----
  let end = null;
  for (const t of toks) spans.push(t.cut);
  if (ec) {
    let eH = ec.hour, eM = ec.minute;
    if (ec.dw) {
      eH = applyPeriod(eH, ec.period);
      const dOff = { 大后天: 3, 后天: 2, 明天: 1, 今天: 0, 今日: 0 }[ec.dw];
      if ([0, 24].includes(eH)) {
        end = new Date(start); end.setHours(23, 59, 0, 0);
        end = addDays(end, dOff);
      } else {
        end = new Date(start); end.setHours(Math.min(eH, 23), eM, 0, 0);
        end = addDays(end, dOff);
      }
      if (end <= start) end = addDays(end, 1);
    } else if ([0, 24].includes(eH)) {
      end = new Date(start); end.setHours(23, 59, 0, 0);
    } else {
      eH = applyPeriod(applyPeriod(eH, ec.period), sc ? sc.period : null);
      end = new Date(start); end.setHours(Math.min(eH, 23), eM, 0, 0);
      if (end <= start) end = addHours(end, 12); // "11点到1点"跨午夜兜底
    }
  }
  if (end == null) {
    let hit = false;
    for (const [pat, mins] of DURATIONS) {
      const dm = pat.exec(s);
      if (dm) {
        const g = dm[1] != null ? dm[1] : "1";
        spans.push([dm.index, dm.index + dm[0].length]);
        end = addMinutes(start, mins(g) || 60);
        hit = true;
        break;
      }
    }
    if (!hit) {
      const dmAll = /全天|一整天/.exec(s);
      if (dmAll) {
        spans.push([dmAll.index, dmAll.index + dmAll[0].length]);
        start = new Date(start); start.setHours(8, 0, 0, 0);
        end = new Date(start); end.setHours(22, 0, 0, 0);
      }
    }
  }
  if (end == null || end <= start) end = addHours(start, 1);

  // ---- 标题：抠掉时间片段与口水词 ----
  let title = s;
  for (const [a, b] of spans.slice().sort((x, y) => y[0] - x[0])) {
    title = title.slice(0, a) + " " + title.slice(b);
  }
  title = title.trim().replace(FILLER, "");
  title = title.replace(/(?:可能|大概|也许|应该|估计|好像|貌似)(?:要|得)?/g, "");
  title = title.replace(/记一下|记一笔|记一个|记个|打个|发个/g, "");
  title = title.replace(/叫我|我叫|咱俩|我们/g, "");
  title = title.replace(/\s*[，,。.·!！~～到至-]\s*/g, " ");
  title = title.replace(/\s+/g, " ").trim();
  title = title.replace(/^(?:要|去|跟|和)\s+/, "");
  title = title.replace(/(?:吧|呗|呢|啊|呀|哈|嘛|哦|噢|啦|喽|了|的|要|去)+$/, "");
  title = title.replace(/\s+/g, " ").trim();
  title = title.replace(/(我的|我)$/, "");
  return { title: (title.slice(0, 30) || "临时安排"), startAt: fmtDT(start), endAt: fmtDT(end) };
}

// ============================== 通知引擎（notice.py） ==============================
// 长文：先找「时间句/地点句/主题句」再重组。拿到高置信时段后裸时间当干扰丢弃。

const RE_AT = /@[^\s，,。:：\n]+/;
const RE_BRACKET = /（[^）]{2,}）|\([^)]{2,}\)/;
const RE_ORD = /^\s*(?:[0-9]{1,2}|[①-⑳]|[一二三四五六七八九十])[.、,，)）]\s*/;

const D_REL = { 大后天: 3, 后天: 2, 明天: 1, 今天: 0, 今日: 0 };
const D_EVE = { 今晚: 0, 明晚: 1, 后晚: 2, 大后晚: 3 };

function findDate(s, now) {
  // 返回 { date, text }，按优先级表取（idx 小者优先，同 idx 取先出现）
  const md = (mo, da) => {
    const d = new Date(now.getFullYear(), mo - 1, da);
    return isNaN(d) ? null : d;
  };
  const rules = [
    // 0) 带标签的时间行（"⏰时间：10.28下午13:30"）值域内的日期 = 活动正主时间，
    //    优先级最高，压过正文里的"今天（25号）报名"之类的子任务日期
    [/[时時]间\s*[：:]\s*([^\n，。；]{2,24})/, (m, full) => {
      const v = m[1];
      let d = /(\d{1,2})月(\d{1,2})[日号]?/.exec(v) && md(+RegExp.$1, +RegExp.$2);
      if (!d) {
        // 点分隔日期（10.28），排除 2.5小时 这类小数
        const dm = /(\d{1,2})[.．](\d{1,2})(?!\s*[小时分%倍万])/.exec(v);
        if (dm && +dm[1] >= 1 && +dm[1] <= 12 && +dm[2] >= 1 && +dm[2] <= 31) d = md(+dm[1], +dm[2]);
      }
      if (!d) {
        const wm = /(?:周|星期|礼拜)([一二三四五六日天])/.exec(v);
        if (wm) d = addDays(dateOnly(now), (WEEKDAY_IDX[wm[1]] - pyWeekday(now) + 7) % 7);
      }
      return d; // null = 标签行里没有日期，落回常规规则
    }],
    [/(大后晚|后晚|明晚|今晚)/, (m) => addDays(dateOnly(now), D_EVE[m[0]])],
    [/(大后天|后天|明天|今天|今日)/, (m) => addDays(dateOnly(now), D_REL[m[0]])],
    [/下(?:周|星期|礼拜)([一二三四五六日天])/, (m) => addDays(addDays(dateOnly(now), 7 - pyWeekday(now)), WEEKDAY_IDX[m[1]])],
    // "本周X/这周X" = 本日历周（周一~周日）的 X，即便已过去（周日读"本周五"=前天）；
    // 裸"周X"才按"最近的未来"算
    [/(?:本|这)(?:周|星期|礼拜)([一二三四五六日天])/, (m) => addDays(dateOnly(now), WEEKDAY_IDX[m[1]] - pyWeekday(now))],
    [/(?:周|星期|礼拜)([一二三四五六日天])/, (m) => addDays(dateOnly(now), (WEEKDAY_IDX[m[1]] - pyWeekday(now) + 7) % 7)],
    [/(\d{1,2})月(\d{1,2})[日号]?/, (m) => md(+m[1], +m[2]) || dateOnly(now)],
    // 点分隔日期（10.28 / 10．28），排除小数/百分比语境
    [/(\d{1,2})[.．](\d{1,2})(?!\s*[小时分%倍万])/, (m) => {
      const mo = +m[1], da = +m[2];
      return mo >= 1 && mo <= 12 && da >= 1 && da <= 31 ? (md(mo, da) || dateOnly(now)) : null;
    }],
  ];
  let best = null;
  rules.forEach(([pat, fn], idx) => {
    const m = pat.exec(s);
    if (!m) return;
    const date = fn(m, s);
    if (!date) return; // 该规则没解出日期（如标签行无日期）
    if (best == null || idx < best.idx || (idx === best.idx && m.index < best.pos)) {
      best = { idx, pos: m.index, date, text: m[0] };
    }
  });
  return best ? { date: best.date, text: best.text } : { date: null, text: "" };
}

const H_SRC = "(?:[0-2]?\\d|[一二两三四五六七八九十]{1,2})";
function tGroup(name) {
  return `(?<${name}_h>${H_SRC})\\s*[:：点时]\\s*(?<${name}_m>[0-5]?\\d|半)?`;
}
const T_START_M = new RegExp(tGroup("s") + "\\s*(?:开始|起|开门|开放|集合|签到)");
const T_END_M = new RegExp(tGroup("e") + "\\s*(?:结束|截止|关门|散场|离场)");
const T_RANGE = new RegExp(
  tGroup("a") + "\\s*(?:开始|起|开门)?\\s*[—–~～至到\\-]\\s*[—–~～至到\\-]?\\s*" + tGroup("b") + "\\s*(?:结束|截止|关门)?");
const CROSS_D_SRC = "(?:大后天|后天|明天|今天|今日|(?:本|这|下)?(?:周|星期|礼拜)[一二三四五六日天])";
const T_RANGE_DAYS = new RegExp(
  tGroup("a") + "\\s*(?:开始|起|开门)?\\s*[—–~～至到\\-]\\s*[—–~～至到\\-]?\\s*(?<mid_d>" + CROSS_D_SRC + ")\\s*" + tGroup("b") + "\\s*(?:结束|截止|关门)?");
const T_ONE = new RegExp(`(?<o_h>${H_SRC})\\s*[:：点时]\\s*(?<o_m>[0-5]?\\d|半)?`, "g");

const PERIOD_RANGE = { // 只说时段没说几点 → 默认区间，time_status=fuzzy
  凌晨: [0, 0, 6, 0], 清晨: [6, 0, 8, 0], 早上: [6, 0, 9, 0], 早晨: [6, 0, 9, 0],
  上午: [8, 0, 12, 0], 中午: [11, 0, 14, 0], 午后: [13, 0, 17, 0], 下午: [13, 0, 18, 0],
  傍晚: [17, 0, 19, 0], 晚上: [18, 0, 23, 0], 夜里: [20, 0, 23, 0],
};
const RE_DURATION = /(?:时长|时间|用时|大约|约)\D{0,2}(\d{1,3})\s*分钟|(\d{1,3})\s*分钟/;
const RE_DUR_SLOTS = /([一二两三四五六七八九\d])\s*节课/;
// 字母数字教室 wla406/WLA-406/N406/j3-301：前后不能紧贴字母数字（老 JSC 不支持后行断言，手工判）
const LOC_ALNUM = /[A-Za-z]{1,4}-?\d{1,4}(?:-\d{1,4})?/g;
function findAlnumRoom(s) {
  LOC_ALNUM.lastIndex = 0;
  let m;
  while ((m = LOC_ALNUM.exec(s))) {
    const before = s.slice(Math.max(0, m.index - 1), m.index);
    const after = s.slice(m.index + m[0].length, m.index + m[0].length + 1);
    if (!/[A-Za-z0-9]/.test(before) && !/[A-Za-z0-9]/.test(after)) return m[0];
  }
  return "";
}
const PM_SET = ["中午", "下午", "午后", "傍晚", "晚上", "夜里"];
const VAGUE_PRE = "多少早晚再稍略挺太更";

function hmOf(m, hName, mName, s) {
  let h = toInt(m.groups[hName]);
  if (h == null) h = 9;
  const mm = m.groups[mName];
  const minute = mm === "半" ? 30 : (mm && isDigitStr(mm) ? parseInt(mm, 10) : 0);
  const pre = s.slice(Math.max(0, m.index - 3), m.index);
  const pm = new RegExp(`(${PM_WORDS})\\s*$`).exec(pre);
  if (pm && PM_SET.includes(pm[1]) && h < 12) h += 12;
  return [h, minute];
}

function skipVague(s, m) {
  const pre = s.slice(m.index - 1, m.index);
  return pre.length > 0 && VAGUE_PRE.includes(pre);
}

function fixEndPM(startHM, endHM) {
  if (endHM && endHM[0] < startHM[0] && endHM[0] < 12) return [endHM[0] + 12, endHM[1]];
  return endHM;
}

function findTimespan(s) {
  // → { startHM, endHM, conf, crossDay }  conf: 2=标记式 1=连接/跨天 0=单时刻 -1=无线索
  // 多段流程（活动议程 13:30-14:00 / 14:00-15:00 / …）→ 整体取最早开始~最晚结束，
  // 优先于标记式（"签到集合"会把首段结尾误认成开始）
  const ranges = [...s.matchAll(new RegExp(T_RANGE.source, "g"))];
  if (ranges.length >= 2) {
    let a = null, b = null;
    for (const mr of ranges) {
      const ta = hmOf(mr, "a_h", "a_m", s);
      const tb = fixEndPM(ta, hmOf(mr, "b_h", "b_m", s));
      if (!a || ta[0] < a[0] || (ta[0] === a[0] && ta[1] < a[1])) a = ta;
      if (!b || tb[0] > b[0] || (tb[0] === b[0] && tb[1] > b[1])) b = tb;
    }
    return { startHM: a, endHM: b, conf: 1, crossDay: null };
  }
  const ms = T_START_M.exec(s);
  const me = T_END_M.exec(s);
  if (ms) {
    const sh = hmOf(ms, "s_h", "s_m", s);
    let endhm = null;
    if (me) endhm = fixEndPM(sh, hmOf(me, "e_h", "e_m", s));
    return { startHM: sh, endHM: endhm, conf: 2, crossDay: null };
  }
  if (me) {
    const eh = hmOf(me, "e_h", "e_m", s);
    return { startHM: [8, 0], endHM: eh, conf: 1, crossDay: null }; // 只写结束 → 开始默认 8 点
  }
  const md = T_RANGE_DAYS.exec(s);
  if (md) {
    return { startHM: hmOf(md, "a_h", "a_m", s), endHM: hmOf(md, "b_h", "b_m", s), conf: 1, crossDay: md.groups.mid_d };
  }
  const mr = T_RANGE.exec(s);
  if (mr) {
    const a = hmOf(mr, "a_h", "a_m", s);
    return { startHM: a, endHM: fixEndPM(a, hmOf(mr, "b_h", "b_m", s)), conf: 1, crossDay: null };
  }
  T_ONE.lastIndex = 0;
  let mo;
  while ((mo = T_ONE.exec(s))) {
    if (skipVague(s, mo)) continue;
    const hh = toInt(mo.groups.o_h);
    if (hh == null) continue;
    const mm = mo.groups.o_m;
    const minute = mm === "半" ? 30 : (mm && isDigitStr(mm) ? parseInt(mm, 10) : 0);
    return { startHM: [hh, minute], endHM: null, conf: 0, crossDay: null };
  }
  return { startHM: null, endHM: null, conf: -1, crossDay: null };
}

// ---------- 标题 ----------

const TITLE_SUFFIX = ("投票|选举|考试|章测|测验|测试|考察|月考|模拟考|统考|补考|缓考|体检|体测|班会|开会|" +
  "会议|讲座|报告|答辩|培训|比赛|竞赛|大赛|讲堂|运动会|招聘会|宣讲会|晚会|演出|展览|" +
  "报名|打卡|实验|实习|采集|普查|测评|四六级|期末|选课|评教|缴费|注册|报到|返校|放假|集合|" +
  "分享会|见面会|开放日|外拍|活动");
const TITLE_VP = new RegExp(`(?:进行|开展|举行|举办|组织|召开|参加|是|开)([^，。,;；:：\\n]{0,14}?)的?\\s*(${TITLE_SUFFIX})`);
const TITLE_MOD_NOISE = /咱们|我们|咱|你|我|各位|全体|同学|大家的?|一个|这个|那个/g;
const RE_SALUT = /^(各位同学|同学们|全体同学|各位|大家|所有人|亲们)/;

function findTitle(s) {
  // 公告类标题：【昇腾AI算子训练营重磅来袭】→ 括号内直接当标题
  let m = /【([^】]{2,16})】/.exec(s);
  if (m) return m[1].slice(0, 16);
  m = TITLE_VP.exec(s);
  if (m) {
    let mod = m[1].replace(TITLE_MOD_NOISE, "").replace(/[的即将了将有要把]/g, "").trim();
    return (mod + m[2]).slice(0, 16);
  }
  m = new RegExp(TITLE_SUFFIX).exec(s);
  if (m) return m[0];
  const first = s.trim().split("\n")[0];
  for (const seg0 of first.split(/[，,:：]/)) {
    let seg = seg0.replace(RE_SALUT, "").trim();
    seg = seg.replace(/通知|注意|重要|@|[:：].*$/g, "").trim();
    seg = seg.replace(/^(请|麻烦|大家|记得|明天|后天|今天|本周|下周)[\s的]*/g, "");
    if (seg.length >= 2 && !/\d/.test(seg)) return seg.slice(0, 12);
  }
  return "群通知事项";
}

// ---------- 地点 ----------

const LOC_STRONG = /校区|体育馆|体育场|运动场|图书馆|教学楼|实验楼|实训楼|食堂|礼堂|会堂|报告厅|会议室|教室|广场|操场|活动中心|游泳馆|机房|大厅|门厅|剧场|剧院|音乐厅|旗舰店|门店|体验店|商场|大厦/;
const LOC_MID = /[馆楼厅室]|中心|基地/;
const LOC_STOP_R = /[\s，,。、;；:：（）()\-—【】]|举行|举办|开展|进行|召开|参加|记得|开始|结束|开门|关门|进入|找|开|请/;
const LOC_STOP_L = /[\s，,。、;；:：（）()\-—【】]|就在|在|于|从|去|到|和|与|及|的|找|至/;

function locWindow(s, pat) {
  const m = pat.exec(s);
  if (!m) return "";
  let lo = 0;
  const reL = new RegExp(LOC_STOP_L.source, "g");
  let lm;
  while ((lm = reL.exec(s))) {
    if (lm.index >= m.index) break;
    if (lm.index + lm[0].length <= m.index) lo = lm.index + lm[0].length;
    if (lm[0].length === 0) reL.lastIndex++;
  }
  const reR = new RegExp(LOC_STOP_R.source, "g");
  reR.lastIndex = m.index + m[0].length;
  const rm = reR.exec(s);
  const hi = rm ? rm.index : s.length;
  return s.slice(lo, hi).replace(/^[\s的在于从去到至和与及]+|[\s的在于从去到至和与及]+$/g, "").slice(0, 30);
}

const PATH_TOKEN_OK = /^(?:北|南|东|西|左|右|前|后|中间?|\d+|[一二三四五六七八九十]+|左侧|右侧)?[\w一-鿿]{0,6}?(?:[东西南北]门|通道|入口|窗口|站台|号口)$/;
const PATH_TOKEN_BAD = /肯定|情况|存在|大家|同学|投票|时间|地点|通知/;

function findLocation(s) {
  let main = locWindow(s, LOC_STRONG);
  if (!main) main = locWindow(s, LOC_MID);
  if (!main) main = findAlnumRoom(s);
  const path = [];
  for (let t0 of s.split(/[\s，,。、;；:：（）()\-—]+/)) {
    const t = t0.replace(/^(?:找到|沿着?|经过|进入|从|由)/, "").trim();
    if (t.length >= 2 && t.length <= 14 && PATH_TOKEN_OK.test(t) && !PATH_TOKEN_BAD.test(t) && t !== main) {
      path.push(t);
    }
  }
  return [String(main).slice(0, 30), path.slice(0, 4).join(" ").slice(0, 60)];
}

// ---------- 主流程 ----------

function crossDate(word, startDate, now) {
  let m = /^(?:本|这)?(?:周|星期|礼拜)([一二三四五六日天])$/.exec(word);
  if (m) {
    return addDays(startDate, (WEEKDAY_IDX[m[1]] - pyWeekday(startDate) + 7) % 7);
  }
  m = /^下(?:周|星期|礼拜)([一二三四五六日天])$/.exec(word);
  if (m) {
    return addDays(addDays(dateOnly(now), 7 - pyWeekday(now)), WEEKDAY_IDX[m[1]]);
  }
  const d = findDate(word, now).date;
  return d || startDate;
}

function parseNotice(text, now = new Date()) {
  const raw = String(text || "").trim();
  let s = raw.replace(RE_AT, " ").replace(RE_BRACKET, " ");
  s = s.split("\n").map((ln) => ln.replace(RE_ORD, " ")).join("\n");
  if (s.trim().length < 8) return null;

  let { date: date_ } = findDate(s, now);
  let { startHM, endHM, crossDay } = findTimespan(s);

  let sh, sm, eh, em, status;
  if (startHM) {
    [sh, sm] = startHM;
    if (endHM) { [eh, em] = endHM; status = "exact"; }
    else { eh = sh + 1; em = sm; status = "start_only"; } // 仅开始 → 结束 +1h
  } else {
    const pm = new RegExp(PM_WORDS).exec(s);
    if (pm) { [sh, sm, eh, em] = PERIOD_RANGE[pm[0]]; status = "fuzzy"; }
    else if (date_) { sh = 9; sm = 0; eh = 18; em = 0; status = "fuzzy"; }
    else { sh = 9; sm = 0; eh = 10; em = 0; date_ = dateOnly(now); status = "todo"; }
  }

  const start = new Date(date_.getFullYear(), date_.getMonth(), date_.getDate(), Math.min(sh, 23), sm, 0, 0);
  let end;
  if (crossDay) {
    const endDate = crossDate(crossDay, dateOnly(start), now);
    end = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate(), Math.min(eh, 23), em, 0, 0);
  } else {
    end = new Date(start); end.setHours(Math.min(eh, 23), em, 0, 0);
  }
  if (end <= start) end = addHours(start, 1);

  const title = findTitle(s);
  const [location, path] = findLocation(s);
  let note = path;
  const dm = RE_DURATION.exec(raw);
  if (dm) {
    const mins = parseInt(dm[1] || dm[2], 10);
    if (mins >= 10 && mins <= 600) note = (`时长约${mins}分钟 ` + note).trim();
  }
  const dm2 = RE_DUR_SLOTS.exec(raw);
  if (dm2 && !(note || "").includes("节课")) {
    const n = toInt(dm2[1]) || 2;
    note = (`约${n}节课 ` + note).trim();
  }
  return { title, note, location, startAt: fmtDT(start), endAt: fmtDT(end), timeStatus: status };
}

function looksLikeNotice(text) {
  const t = String(text || "").trim();
  if (t.length > 30 || t.includes("\n")) return true;
  if (/^\s*[0-9]{1,2}[.、,，)）]/m.test(t)) return true;
  if (t.split(/[。；;]/).length > 2) return true;
  if (/通知|定于|将于|拟于|举办|开展|组织|安排|请(?:大家|同学|各位)|各位同学|全体同学|要求/.test(t)) return true;
  return false;
}

return { resolveEventTime, parseNotice, looksLikeNotice };
})();
const { resolveEventTime, parseNotice, looksLikeNotice } = __notice;

const __suggest = (function () {
// v1 建议引擎移植（源：server/app/routers/ddls.py 的 sug_router，FR-33 规则版）。
// 批奏折卡片 = 空闲池（活动窗 − 课程 − 日程 − 饭点）× 紧迫度 × 时段匹配 × 偏好修正，
// 每张卡片三键——接受/换时间/忽略。产品铁律：绝不自动写日程，
// 只有 accept / review-plan 两个入口落库，其余只读或只记反馈。
//
// 打分公式（概要设计 M3，与 py 一致）：
//   score = 紧迫度(weight×48h/剩余小时，考试按 4 计、封顶 12)
//           × 时段匹配度(空闲段长 vs 预估时长，段不够长按比例打折)
//           × 偏好修正(0.6^该时段被忽略次数，换时间算半次，只看近两周)
//           × 越早越好(1/(1+0.2×距今天数))
//
// 数据访问全走注入的 ctx = { load(key, dflt), save(key, val), now }：
// 键名与 db-core.js 的 K 表一致（db_term/db_courses/db_events/db_ddls/db_seq）。
// v1 的 DdlFeedback 是独立数据表，v2 KV 没有对应键 → 新增 "db_ddl_feedback"（同一命名风格），
// 只有本模块读写。本模块只 import "./slots"（scripts/sync-cf.mjs 的 IIFE 拼接会剥掉这行
// import，拼接后 SLOT_TIMES 由外层 slots 段提供），其余依赖一律通过 ctx 注入。
//
// 时间约定与 db-core.js 相同：产出统一 "YYYY-MM-DD HH:mm:ss"；比较必须先转 Date——
// 存量数据里 due_at 有带秒和不带秒两种（ddl 表单存 "YYYY-MM-DD HH:MM"），字符串比较不可靠。

const K = {
  term: "db_term",
  courses: "db_courses",
  events: "db_events",
  ddls: "db_ddls",
  feedback: "db_ddl_feedback", // v1 ddl_feedback 表的 KV 落点（本模块私有）
  seq: "db_seq",
};

// ---------- 引擎参数（ddls.py「推荐引擎 v1」段，逐行照搬） ----------

const ACTIVE = [8 * 60, 22 * 60 + 30]; // 日活动窗 08:00-22:30（睡眠不推）
const MEALS = [ // 饭点：可能有事，不推
  [12 * 60, 13 * 60 + 40],
  [17 * 60 + 30, 18 * 60 + 50],
];
const HORIZON_DAYS = 7; // 只看未来 7 天
const GRID = 30; // 30 分钟粒度起排
const MIN_SEG = 40; // 碎片小于 40 分钟不推
const EST_BY_WEIGHT = { 1: 60, 2: 90, 3: 120 }; // 预估时长（分钟）
const PLAN_CAP = 8; // 考前复习最多排 4 个周末（8 个半天）
const WEEKDAY_CN = "一二三四五六日"; // py 同名常量，按 Mon=0 索引

// ---------- 时间工具（db-core.js 同款私有实现，不能跨 IIFE 共享） ----------

const pad = (n) => (n < 10 ? "0" + n : "" + n);
const fmtD = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtDT = (d) =>
  `${fmtD(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
// "YYYY-MM-DD HH:mm[:ss]" → Date（本地时区；兼容 "T" 分隔）
const toDate = (s) => new Date(String(s).replace(" ", "T").replace("Z", ""));
const dateOnly = (s) => String(s).slice(0, 10);
function dayStart(dstr) {
  const [y, m, d] = String(dstr).slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
}
function addDays(dstr, n) {
  const d = dayStart(dstr);
  d.setDate(d.getDate() + n);
  return fmtD(d);
}
const hms = (t) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};
// 某天处于第几教学周（week.py current_week：开学前 0，超总周数封顶）
function weekOn(term, day) {
  const days = Math.round((dayStart(day) - dayStart(term.start_monday)) / 86400000);
  if (days < 0) return 0;
  return Math.min(Math.floor(days / 7) + 1, term.total_weeks);
}
// 倒计时文案（py _remain_text）：<1小时→分钟，<24小时→小时，再上→天+小时
function remainText(dueAt, now) {
  const sec = (toDate(dueAt) - now) / 1000;
  const past = sec < 0;
  const hours = Math.abs(sec) / 3600;
  let txt;
  if (hours < 1) txt = `${Math.floor(Math.abs(sec) / 60)}分钟`;
  else if (hours < 24) txt = `${Math.floor(hours)}小时`;
  else {
    const days = Math.floor(hours / 24), rh = Math.floor(hours) % 24;
    txt = `${days}天` + (rh ? `${rh}小时` : "");
  }
  return (past ? "逾期" : "剩") + txt;
}
// 倒计时墙分档（py _tier）：剩余小时/权重 ≤12 红、≤72 黄、否则绿；过期/完成另算
function tierOf(dueAt, weight, status, now) {
  if (status === "done") return "done";
  const hours = (toDate(dueAt) - now) / 3600000;
  if (hours <= 0) return "overdue";
  const eff = hours / (weight || 2);
  if (eff <= 12) return "red";
  if (eff <= 72) return "yellow";
  return "green";
}
// 时段桶（py _bucket）：<12 早，<18 午，其余晚
function bucketOf(dt) {
  const h = dt.getHours();
  return h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
}

// ---------- 空闲池（py _day_busy / _free_segments / _merge） ----------

function mergeIvs(ivs) {
  const out = [];
  for (const [lo, hi] of [...ivs].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    if (out.length && lo <= out[out.length - 1][1])
      out[out.length - 1][1] = Math.max(out[out.length - 1][1], hi);
    else out.push([lo, hi]);
  }
  return out;
}

// 某天的忙碌区间（分钟）：饭点 + 课表节次（命中教学周）+ 精确/仅开始日程。
// 仅开始(start_only)有确定开始和 +1h 预估结束，必须算忙——否则建议会排到它头上。
// 跨天日程截断到当天：开始早于当天 0 点 → lo=0，结束晚于当天末 → hi=1440。
function dayBusy(term, courses, events, day) {
  const ivs = MEALS.slice();
  if (term) {
    const week = weekOn(term, day);
    if (week >= 1) {
      const dow = dayStart(day).getDay() || 7; // 1=周一…7=周日
      for (const c of courses) {
        if (c.day_of_week !== dow || !(c.weeks || []).includes(week)) continue;
        ivs.push([
          hms(SLOT_TIMES[c.start_slot - 1][0]),
          hms(SLOT_TIMES[Math.min(c.end_slot, SLOT_TIMES.length) - 1][1]),
        ]);
      }
    }
  }
  const dayLo = dayStart(day);
  const dayHi = new Date(dayLo); // py time.max ≈ 23:59:59.999999；秒级数据下等价
  dayHi.setHours(23, 59, 59, 999);
  for (const e of events) {
    if (e.status !== "ok" || (e.time_status !== "exact" && e.time_status !== "start_only"))
      continue;
    const st = toDate(e.start_at), en = toDate(e.end_at);
    if (st > dayHi || en < dayLo) continue; // py 条件：start<=day_hi 且 end>=day_lo
    ivs.push([
      st < dayLo ? 0 : st.getHours() * 60 + st.getMinutes(),
      en > dayHi ? 24 * 60 : en.getHours() * 60 + en.getMinutes(),
    ]);
  }
  return mergeIvs(ivs);
}

// 活动窗 − 忙碌 → 空闲段；碎片 < MIN_SEG 丢弃
function freeSegments(busy) {
  const segs = [];
  let cur = ACTIVE[0];
  for (const [lo, hi] of busy) {
    if (hi <= cur || lo >= ACTIVE[1]) continue;
    if (lo > cur) segs.push([cur, Math.min(lo, ACTIVE[1])]);
    cur = Math.max(cur, hi);
  }
  if (cur < ACTIVE[1]) segs.push([cur, ACTIVE[1]]);
  return segs.filter(([a, b]) => b - a >= MIN_SEG);
}

// ---------- 落库（与 db-core.js 的 newEvent/nextId 同构，隔离在 IIFE 内不能直接调） ----------

function nextId(ctx) {
  const n = (ctx.load(K.seq, 0) || 0) + 1;
  ctx.save(K.seq, n);
  return n;
}

// 事件形状 = v1 EventOut：id/title/start_at/end_at/note/location/icon/color_idx/
// time_status/type/source/status/ddl_id/series_id
function newEventRow(ctx, f) {
  const ev = {
    id: nextId(ctx),
    title: f.title,
    start_at: f.start_at,
    end_at: f.end_at,
    note: f.note || "",
    location: f.location || "",
    icon: f.icon || "",
    color_idx: f.color_idx || 0,
    time_status: f.time_status || "exact",
    type: f.type || "temp",
    source: f.source || "text",
    status: "ok",
    ddl_id: f.ddl_id ?? null,
    series_id: f.series_id ?? null,
  };
  const evs = ctx.load(K.events, []) || [];
  evs.push(ev);
  ctx.save(K.events, evs);
  return { ...ev };
}

// 反馈流水（v1 DdlFeedback 表）：偏好修正的数据源，created_at 供 14 天窗口过滤
function addFeedback(ctx, now, ddlId, action, bucket, reason) {
  const rows = ctx.load(K.feedback, []) || [];
  rows.push({
    id: nextId(ctx),
    ddl_id: ddlId,
    action,
    bucket: bucket || "",
    reason: String(reason || "").slice(0, 64),
    created_at: fmtDT(now),
  });
  ctx.save(K.feedback, rows);
}

// 偏好修正（py _pref_factor）：近两周该时段被忽略 1 次/换时间 0.5 次 → 0.6^次 降权
function prefFactor(ctx, now) {
  const counts = { morning: 0, afternoon: 0, evening: 0 };
  const since = new Date(now.getTime() - 14 * 86400000);
  for (const f of ctx.load(K.feedback, []) || []) {
    if (!(f.bucket in counts) || (f.action !== "ignore" && f.action !== "change")) continue;
    if (toDate(f.created_at) < since) continue;
    counts[f.bucket] += f.action === "ignore" ? 1 : 0.5;
  }
  const out = {};
  for (const k of Object.keys(counts)) out[k] = Math.pow(0.6, counts[k]);
  return out;
}

function examTitle(d) {
  if (!d.course_name || d.title.startsWith(d.course_name)) return d.title;
  return `${d.course_name}·${d.title}`;
}

// 两个候选离得够远吗（py _far_enough）：不同天直接算远；同天起点隔 ≥3 小时
function farEnough(a, b) {
  if (dateOnly(a.start_at) !== dateOnly(b.start_at)) return true;
  return Math.abs(toDate(a.start_at) - toDate(b.start_at)) >= 3 * 3600000;
}

// ---------- GET /api/suggestions → {cards:[...]}（py get_suggestions） ----------

function getSuggestions(ctx, now) {
  const term = ctx.load(K.term, null);
  const courses = ctx.load(K.courses, []) || [];
  const events = ctx.load(K.events, []) || [];
  const ddls = (ctx.load(K.ddls, []) || []).filter((d) => d.status !== "done" && !d.muted);
  if (!ddls.length) return { cards: [] };
  // 已接受过推荐且时段还没过去的 → 不再重复推（考试本体/复习安排也占 ddl_id，同样算已排）
  const scheduled = new Set(
    events
      .filter((e) => e.status === "ok" && e.ddl_id != null && toDate(e.end_at) > now)
      .map((e) => e.ddl_id)
  );
  const prefs = prefFactor(ctx, now);
  const today = fmtD(now);
  const horizonDay = addDays(today, HORIZON_DAYS);
  const cards = [];

  for (const d of ddls) {
    const due = toDate(d.due_at);
    if (scheduled.has(d.id) || due <= new Date(now.getTime() - 3 * 86400000))
      continue; // 已排期 / 逾期超过 3 天的陈年旧账不推
    const isExam = d.kind === "exam";
    const weight = d.weight ?? 2;
    const est = isExam ? 240 : (EST_BY_WEIGHT[weight] ?? 90); // 考试固定 4 小时预估
    const hoursLeft = Math.max((due - now) / 3600000, 0.5); // 最低按半小时算，防除零
    const urgency = Math.min((isExam ? 4 : weight) * 48 / hoursLeft, 12);
    // 截止日 vs 地平线取早者；逾期未超 3 天的 endDay 在过去 → 循环不跑 → 无卡（py 同）
    const dueDay = fmtD(due);
    const endDay = dueDay < horizonDay ? dueDay : horizonDay;
    const cands = [];
    let day = today;
    let daysAhead = 0;
    while (day <= endDay && cands.length < 48) {
      const segs = freeSegments(dayBusy(term, courses, events, day));
      const nm = day === today ? now.getHours() * 60 + now.getMinutes() : 0; // py _now_min
      for (const [lo, hi] of segs) {
        // 起排点：max(段起点, 当前时刻) 向上取整到 30 分钟网格
        let startMin = Math.ceil(Math.max(lo, nm) / GRID) * GRID;
        if (day === today && startMin < nm + 15)
          startMin = Math.ceil((nm + 15) / GRID) * GRID; // 今天至少留 15 分钟缓冲
        if (startMin >= hi) continue;
        // 同一空档产出两种时长：短（约 1 小时）/ 长（约 2.5-3/4 小时），保证建议差异度
        for (let dur of [Math.min(60, est), Math.min(Math.max(est, 180), 240)]) {
          if (dur < 45 || startMin + dur > hi) continue;
          let slotEnd = startMin + dur;
          if (day === dueDay) { // 截止当天的时段必须赶在截止前
            const dueMin = due.getHours() * 60 + due.getMinutes();
            if (slotEnd > dueMin) {
              dur = dueMin - startMin;
              if (dur < 45) continue;
              slotEnd = startMin + dur;
            }
          }
          const s = new Date(dayStart(day).getTime() + startMin * 60000);
          const e = new Date(dayStart(day).getTime() + slotEnd * 60000);
          const b = bucketOf(s);
          const fit = hi - lo >= est ? 1 : (hi - lo) / est; // 段不够长按比例打折
          const score = (urgency * fit * prefs[b]) / (1 + 0.2 * daysAhead);
          const weekend = (dayStart(day).getDay() || 7) >= 6;
          const longBlock = slotEnd - startMin >= 120;
          // 差异度分桶：ws 工作日短时 / wl 周末长时 / dl 工作日长时 / fs 周末短时
          const cat = longBlock ? (weekend ? "wl" : "dl") : weekend ? "fs" : "ws";
          const wd = "周" + WEEKDAY_CN[(dayStart(day).getDay() + 6) % 7];
          const mins = slotEnd - startMin;
          const durTxt = mins >= 60 ? `${Math.floor(mins / 60)}小时` : `${mins}分钟`;
          let style;
          if (cat === "ws") style = `工作日抽 ${durTxt} 小块`;
          else if (cat === "wl") style = `周末整块 ${durTxt}，适合${isExam ? "考前集中" : "赶工"}`;
          else if (cat === "fs") style = `周末 ${durTxt} 轻量推进`;
          else style = `工作日大块 ${durTxt} 沉浸做`;
          const hm = (dt) => `${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
          const reason =
            (due <= now
              ? `已逾期，越早补越好；${style}`
              : `距截止${remainText(d.due_at, now)}；${style}`) +
            `，${wd}${hm(s)}-${hm(e)} 没课也没安排`;
          cands.push({
            start_at: fmtDT(s),
            end_at: fmtDT(e),
            bucket: b,
            score: Math.round(score * 1000) / 1000, // py round(score, 3)
            reason,
            cat,
          });
        }
      }
      day = addDays(day, 1);
      daysAhead++;
    }
    // 差异化选 slot：ws/wl/dl 三桶各取一个最高分，不足 3 个再用剩余高分补齐
    cands.sort((a, b) => b.score - a.score);
    const picked = [];
    for (const cat of ["ws", "wl", "dl"]) {
      if (picked.length >= 3) break;
      for (const c of cands) {
        if (c.cat === cat && picked.every((p) => farEnough(c, p))) {
          picked.push(c);
          break;
        }
      }
    }
    for (const c of cands) {
      if (picked.length >= 3) break;
      if (picked.every((p) => farEnough(c, p))) picked.push(c);
    }
    if (picked.length) {
      cards.push({
        ddl_id: d.id,
        title: d.title,
        course_name: d.course_name || "",
        weight,
        kind: d.kind || "task",
        due_at: d.due_at, // 原样透传（与 db-core ddlOut 一致；前端两种格式都兼容）
        remain_text: remainText(d.due_at, now),
        tier: tierOf(d.due_at, weight, d.status, now),
        slots: picked,
      });
    }
  }
  cards.sort((a, b) => (b.slots[0] ? b.slots[0].score : 0) - (a.slots[0] ? a.slots[0].score : 0));
  return { cards: cards.slice(0, 5) }; // 最多 5 张卡
}

// ---------- POST /api/suggestions/accept → EventOut（py accept_suggestion） ----------

function acceptSuggestion(ctx, now, body) {
  const start = fmtDT(toDate(body.start_at)); // 归一化成带秒的统一格式再落库
  const end = fmtDT(toDate(body.end_at));
  if (!(toDate(end) > toDate(start))) throw new Error("结束时间要晚于开始时间");
  const rows = ctx.load(K.ddls, []) || [];
  const d = rows.find((x) => x.id === Number(body.ddl_id));
  if (!d) throw new Error("DDL 不存在");
  // 标题本身已带课名就不重复拼（py 同逻辑）
  const title = (!d.course_name || d.title.startsWith(d.course_name)
    ? d.title : `${d.course_name}·${d.title}`).slice(0, 60);
  const ev = newEventRow(ctx, {
    title,
    icon: "📌",
    location: d.location || "",
    note: d.note || "来自 DDL 建议",
    start_at: start,
    end_at: end,
    time_status: "exact",
    type: "suggestion",
    source: "ddl",
    ddl_id: d.id,
  });
  addFeedback(ctx, now, d.id, "accept", bucketOf(toDate(start)), "");
  return ev;
}

// ---------- POST /api/suggestions/feedback → {ok:true}（py feedback_suggestion） ----------

// 忽略/换时间：只记反馈降权，绝不写日程。忽略 = 该 DDL 永久静音（muted），
// 推荐引擎永不再推；换时间不静音。前端另有本地 24h dismiss 缓存兜底展示层。
function feedbackSuggestion(ctx, now, body) {
  if (body.action !== "ignore" && body.action !== "change")
    throw new Error("action 只能是 ignore 或 change");
  addFeedback(ctx, now, Number(body.ddl_id), body.action, body.bucket || "", body.reason);
  if (body.action === "ignore") {
    const rows = ctx.load(K.ddls, []) || [];
    const d = rows.find((x) => x.id === Number(body.ddl_id));
    if (d) {
      d.muted = true;
      ctx.save(K.ddls, rows);
    }
  }
  return { ok: true };
}

// ---------- GET /api/suggestions/free → {days:[...]}（py free_slots） ----------

// 空闲格查询：批奏折自定义时间的点选网格用。每天的空闲段（分钟对 [lo,hi]），
// 已扣掉课程/精确日程/饭点；今天额外扣掉已过去的时刻（留 15 分钟缓冲，按 30 分钟上取整）。
function freeSlots(ctx, now, query) {
  // 非法 start py 会 422，这里兜底今天（前端只传 date picker 的合法日期，走不到分支）
  const start = /^\d{4}-\d{2}-\d{2}$/.test(query.start || "") ? query.start : fmtD(now);
  const n = parseInt(query.days, 10);
  const days = Math.max(1, Math.min(Number.isFinite(n) ? n : 7, 21));
  const term = ctx.load(K.term, null);
  const courses = ctx.load(K.courses, []) || [];
  const events = ctx.load(K.events, []) || [];
  const today = fmtD(now);
  const out = [];
  let day = start;
  for (let i = 0; i < days; i++) {
    let segs = freeSegments(dayBusy(term, courses, events, day));
    if (day === today) {
      const nm = now.getHours() * 60 + now.getMinutes() + 15;
      segs = segs
        .map(([lo, hi]) => [Math.max(lo, Math.ceil(nm / 30) * 30), hi])
        .filter(([lo, hi]) => hi - lo >= 30);
    }
    out.push({ date: day, weekday: dayStart(day).getDay() || 7, segs });
    day = addDays(day, 1);
  }
  return { days: out };
}

// ---------- POST /api/suggestions/review-plan → EventOut[]（py review_plan） ----------

// 批奏折·考前复习计划：从今天起每个周末（周六/日）排一段整块复习，
// 避开课程/日程/饭点，能排 3 小时就 3 小时，一直到考试前（考试当天不排）。
// 复习事件挂 ddl_id → 考试被视为已安排，推荐卡自动消停。
function reviewPlan(ctx, now, body) {
  const rows = ctx.load(K.ddls, []) || [];
  const d = rows.find((x) => x.id === Number(body.ddl_id));
  if (!d) throw new Error("DDL 不存在");
  const term = ctx.load(K.term, null);
  const courses = ctx.load(K.courses, []) || [];
  // 忙闲用开工前的快照：本次新排的复习段不该影响后续周末的计算（py 同——commit 前查询看不到）
  const events = ctx.load(K.events, []) || [];
  const created = [];
  const dueDay = fmtD(toDate(d.due_at));
  let day = fmtD(now);
  while (day < dueDay && created.length < PLAN_CAP) {
    const dow = dayStart(day).getDay(); // 0=周日 6=周六
    if (dow === 0 || dow === 6) {
      const segs = freeSegments(dayBusy(term, courses, events, day))
        .filter(([lo, hi]) => hi - lo >= 120);
      if (segs.length) {
        let [lo, hi] = segs[0];
        for (const s of segs) if (s[1] - s[0] > hi - lo) [lo, hi] = s; // 取最长空档（并列取先）
        const dur = Math.min(180, hi - lo);
        const s0 = new Date(dayStart(day).getTime() + lo * 60000);
        created.push(newEventRow(ctx, {
          title: `${examTitle(d)}·复习`.slice(0, 60),
          icon: "📚",
          note: `考前复习 · ${d.title}`.slice(0, 120),
          time_status: "exact",
          type: "review",
          source: "ddl",
          ddl_id: d.id,
          start_at: fmtDT(s0),
          end_at: fmtDT(new Date(s0.getTime() + dur * 60000)),
        }));
      }
    }
    day = addDays(day, 1);
  }
  if (!created.length)
    throw new Error("考试前的周末没有 ≥2 小时的空闲整块（可能被课占满了）");
  addFeedback(ctx, now, d.id, "plan", "");
  return created;
}

// ---------- 路由分发：不认识的 suggestions 路径返回 null（调用方落回默认） ----------

function handleSuggestionRoute(method, path, body, ctx) {
  const [p, qstr] = String(path).split("?");
  body = body || {};
  const now = ctx && ctx.now != null ? new Date(ctx.now) : new Date();
  if (method === "GET" && p === "/api/suggestions") return getSuggestions(ctx, now);
  if (method === "POST" && p === "/api/suggestions/accept")
    return acceptSuggestion(ctx, now, body);
  if (method === "POST" && p === "/api/suggestions/feedback")
    return feedbackSuggestion(ctx, now, body);
  if (method === "GET" && p === "/api/suggestions/free") {
    const query = {};
    for (const kv of (qstr || "").split("&")) {
      if (!kv) continue;
      const [k, v] = kv.split("=");
      query[k] = decodeURIComponent(v || "");
    }
    return freeSlots(ctx, now, query);
  }
  if (method === "POST" && p === "/api/suggestions/review-plan")
    return reviewPlan(ctx, now, body);
  return null;
}

return { handleSuggestionRoute };
})();
const { handleSuggestionRoute } = __suggest;

const __core = (function () {
// v2 数据核心：原 FastAPI 后端（terms/courses/events/ddls/conflict/profile 六域）
// 移植为"可注入键值存储"的纯逻辑——uni storage（单机版）与云函数 KV（小程序版）
// 跑同一套代码，行为永不漂移。接口签名/返回结构与后端保持一致，页面层零改动。
//
// 时间格式约定：统一 "YYYY-MM-DD HH:mm:ss"（与后端 pydantic 序列化等价，
// 前端已有代码按 slice(0,10)/slice(11,16)/replace(" ","T") 解析，两种格式都兼容）。

const K = {
  term: "db_term",
  courses: "db_courses",
  events: "db_events",
  ddls: "db_ddls",
  profile: "db_profile",
  seq: "db_seq",
};

// ---------- 存取（存储注入） ----------

let KV = null;
// 绑定键值存储适配器：{ get(key), set(key, val) }。不绑定时回落 uni storage。
function bindStorage(kv) {
  KV = kv;
}

function load(key, dflt) {
  try {
    const v = KV ? KV.get(key) : uni.getStorageSync(key);
    return v === "" || v === null || v === undefined ? dflt : v;
  } catch (e) {
    return dflt;
  }
}
function save(key, val) {
  if (KV) KV.set(key, val);
  else uni.setStorageSync(key, val);
}
function nextId() {
  const n = (load(K.seq, 0) || 0) + 1;
  save(K.seq, n);
  return n;
}

// ---------- 时间工具 ----------

const pad = (n) => (n < 10 ? "0" + n : "" + n);
const fmtD = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtDT = (d) =>
  `${fmtD(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
// "YYYY-MM-DD HH:mm:ss" → Date（本地时区；iOS WKWebView 不认 "-" + "T" 混合，统一替换）
const toDate = (s) => new Date(String(s).replace(" ", "T").replace("Z", ""));
const dateOnly = (s) => String(s).slice(0, 10);
const dayStart = (dstr) => new Date(...dateParts(dstr));
function dateParts(dstr) {
  const [y, m, d] = dstr.split("-").map(Number);
  return [y, m - 1, d];
}
function addDays(dstr, n) {
  const d = dayStart(dstr);
  d.setDate(d.getDate() + n);
  return fmtD(d);
}
// 冲突可视化条目用的分钟精度 ISO（后端 isoformat(timespec="minutes") 的等价物）
function isoMin(dt) {
  return `${fmtD(dt)}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

// 教学周：全 App 时间计算的基石（week.py 移植）
function currentWeek(startMonday, totalWeeks = 20) {
  const days = Math.round((dayStart(fmtD(new Date())) - dayStart(startMonday)) / 86400000);
  if (days < 0) return 0;
  return Math.min(Math.floor(days / 7) + 1, totalWeeks);
}

const hms = (t) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};
const courseRange = (c) => [
  hms(SLOT_TIMES[c.start_slot - 1][0]),
  hms(SLOT_TIMES[Math.min(c.end_slot, SLOT_TIMES.length) - 1][1]),
];

// ---------- 学期 ----------

function termOut(t) {
  return {
    id: t.id,
    name: t.name,
    start_monday: t.start_monday,
    total_weeks: t.total_weeks,
    current_week: currentWeek(t.start_monday, t.total_weeks),
  };
}
function getTerm() {
  return load(K.term, null);
}

// ---------- 课程 ----------

const COURSE_KEYS = ["name", "teacher", "location", "day_of_week", "start_slot", "end_slot", "weeks", "remark"];

function listCourses() {
  return load(K.courses, [])
    .slice()
    .sort((a, b) => a.day_of_week - b.day_of_week || a.start_slot - b.start_slot);
}

// ---------- 日程 ----------

const EVENT_KEYS = ["title", "start_at", "end_at", "note", "location", "icon",
  "color_idx", "time_status", "type", "source"];
const RECUR_CAP = 120; // 单次重复日程的实例上限（一学期每天 1 条约 140，留余量）

function listEvents() {
  return load(K.events, []).slice().sort((a, b) => (a.start_at < b.start_at ? 1 : -1));
}

// 重复日程展开（events.py /recurring 移植）：跨天时长 = 结束早于开始
function createRecurring(body) {
  if (body.repeat !== "daily" && body.repeat !== "weekly")
    throw new Error("repeat 只能是 daily（每天）或 weekly（每周）");
  if (body.repeat === "weekly" && !(body.days || []).length)
    throw new Error("每周重复至少选一天");
  if (body.end_date < body.start_date) throw new Error("结束日期不能早于开始日期");
  const parseT = (t) => {
    const m = /^\d{1,2}:\d{2}$/.test(t || "") ? t.split(":").map(Number) : null;
    if (!m) throw new Error("时间格式不对");
    return m;
  };
  const [sh, sm] = parseT(body.start_time);
  const [eh, em] = parseT(body.end_time);
  let dur = eh * 60 + em - (sh * 60 + sm);
  if (dur <= 0) dur += 1440; // 跨天：23:00 → 次日 02:00
  if (dur < 15 || dur >= 1440)
    throw new Error("单次时长要在 15 分钟 ~ 24 小时之间（结束早于开始=跨到次日）");
  const daysSet = body.repeat === "weekly" ? new Set(body.days) : new Set([1, 2, 3, 4, 5, 6, 7]);
  const seriesId = load(K.events, []).reduce((mx, e) => Math.max(mx, e.series_id || 0), 0) + 1;
  const rows = [];
  let d = body.start_date;
  while (d <= body.end_date && rows.length < RECUR_CAP) {
    const dow = dayStart(d).getDay() || 7; // 1=周一…7=周日
    if (daysSet.has(dow)) {
      const startAt = `${d} ${body.start_time}:00`;
      const endDT = toDate(`${d} ${body.end_time}:00`);
      endDT.setDate(endDT.getDate() + (hms(body.end_time) <= hms(body.start_time) ? 1 : 0));
      rows.push(newEvent({
        title: body.title, note: body.note || "", location: body.location || "",
        icon: body.icon || "", color_idx: body.color_idx || 0,
        time_status: body.time_status || "exact", type: "temp", source: "text",
        start_at: startAt, end_at: fmtDT(endDT), series_id: seriesId,
      }));
    }
    d = addDays(d, 1);
  }
  if (!rows.length) throw new Error("这个时间段内没有匹配的日期");
  return rows;
}

function newEvent(fields) {
  const ev = {
    id: nextId(),
    title: fields.title,
    start_at: fields.start_at,
    end_at: fields.end_at,
    note: fields.note || "",
    location: fields.location || "",
    icon: fields.icon || "",
    color_idx: fields.color_idx || 0,
    time_status: fields.time_status || "exact",
    type: fields.type || "temp",
    source: fields.source || "text",
    status: "ok",
    ddl_id: fields.ddl_id ?? null,
    series_id: fields.series_id ?? null,
  };
  const evs = load(K.events, []);
  evs.push(ev);
  save(K.events, evs);
  return { ...ev };
}

// ---------- 冲突检测（conflict.py 移植） ----------

// 时段与课表的冲突：逐天截断到当天分钟区间，与该天命中教学周的课程节次比对
function findCourseConflicts(startAt, endAt, term, courses) {
  term = term || getTerm();
  if (!term) return [];
  courses = courses || load(K.courses, []);
  if (!courses.length) return [];
  const out = [];
  let day = dateOnly(startAt);
  const last = dateOnly(endAt);
  while (day <= last && out.length < 20) {
    const week = currentWeekOn(term, day);
    if (week >= 1) {
      const sMin = day === dateOnly(startAt)
        ? toDate(startAt).getHours() * 60 + toDate(startAt).getMinutes() : 0;
      const eMin = day === last
        ? toDate(endAt).getHours() * 60 + toDate(endAt).getMinutes() + 1 : 24 * 60;
      for (const c of courses) {
        if (c.day_of_week !== (dayStart(day).getDay() || 7) || !(c.weeks || []).includes(week))
          continue;
        for (let slot = c.start_slot; slot <= Math.min(c.end_slot, SLOT_TIMES.length); slot++) {
          const [t0, t1] = SLOT_TIMES[slot - 1];
          const a = hms(t0), b = hms(t1);
          if (a < eMin && sMin < b) {
            const [first] = [SLOT_TIMES[c.start_slot - 1][0]];
            const lastT = SLOT_TIMES[Math.min(c.end_slot, SLOT_TIMES.length) - 1][1];
            out.push({
              name: c.name, location: c.location || "", date: day,
              slots_text: `第${c.start_slot}-${c.end_slot}节`,
              time_text: `${first}-${lastT}`, course_id: c.id,
            });
            break;
          }
        }
      }
    }
    day = addDays(day, 1);
  }
  return out;
}

// 教学周（指定某天）：开学前 0，超总周数封顶
function currentWeekOn(term, day) {
  const days = Math.round((dayStart(day) - dayStart(term.start_monday)) / 86400000);
  if (days < 0) return 0;
  return Math.min(Math.floor(days / 7) + 1, term.total_weeks);
}

// 时段与已有日程的重叠（排除自身/已取消；精确与仅开始占位，大概/待定不算）
function findEventConflicts(startAt, endAt, excludeEventId) {
  return load(K.events, [])
    .filter((e) => e.status === "ok" && (e.time_status === "exact" || e.time_status === "start_only"))
    .filter((e) => e.id !== excludeEventId && e.start_at < endAt && startAt < e.end_at)
    .map((e) => ({ id: e.id, title: e.title, start_at: e.start_at, end_at: e.end_at }));
}

// 全量扫描未来 30 天：日程×课程 / 日程×日程 / 课程×课程（list_conflicts 移植）
function listConflicts() {
  const now = new Date();
  const nowStr = fmtDT(now);
  const horizon = fmtDT(new Date(now.getTime() + 30 * 86400000));
  const term = getTerm();
  const courses = load(K.courses, []);
  const events = load(K.events, []).filter(
    (e) => e.status === "ok" && (e.time_status === "exact" || e.time_status === "start_only")
      && e.end_at > nowStr && e.start_at < horizon
  );

  const evItem = (e) => ({
    type: "event", id: e.id, title: String(e.title).slice(0, 24),
    start_at: isoMin(toDate(e.start_at)), end_at: isoMin(toDate(e.end_at)),
    series_id: e.series_id, multi_day: dateOnly(e.start_at) !== dateOnly(e.end_at),
  });
  const courseItem = (c, day) => {
    const t0 = SLOT_TIMES[c.start_slot - 1][0];
    const t1 = SLOT_TIMES[Math.min(c.end_slot, SLOT_TIMES.length) - 1][1];
    return {
      type: "course", id: c.id, title: String(c.name).slice(0, 24),
      start_at: `${day}T${t0}`, end_at: `${day}T${t1}`,
      series_id: null, multi_day: false,
    };
  };
  const nextDayOf = (dow) => {
    const now2 = new Date();
    return fmtD(new Date(now2.getFullYear(), now2.getMonth(), now2.getDate() + ((dow - (now2.getDay() || 7) + 7) % 7)));
  };

  const items = [];
  for (const e of events) { // 日程 × 课程
    for (const cc of findCourseConflicts(e.start_at, e.end_at, term, courses)) {
      const co = courses.find((x) => x.id === cc.course_id) || null;
      const day = cc.date || dateOnly(e.start_at);
      items.push({
        kind: "event_course",
        text: `《${e.title}》撞上课 ${cc.name}（${cc.slots_text} ${cc.time_text}）`,
        event_id: e.id, course_id: cc.course_id || null,
        items: co ? [evItem(e), courseItem(co, day)] : [evItem(e)],
      });
    }
  }
  for (let i = 0; i < events.length; i++) { // 日程 × 日程
    for (let j = i + 1; j < events.length; j++) {
      const a = events[i], b = events[j];
      if (a.start_at >= b.end_at || b.start_at >= a.end_at) continue;
      if (a.ddl_id && a.ddl_id === b.ddl_id) continue; // 同一 DDL 的多段安排
      if (a.series_id && a.series_id === b.series_id) continue; // 同一重复组
      items.push({
        kind: "event_event",
        text: `《${a.title}》与《${b.title}》时间重叠`,
        event_id: a.id, other_event_id: b.id,
        items: [evItem(a), evItem(b)],
      });
    }
  }
  for (let i = 0; i < courses.length; i++) { // 课程 × 课程（手动录入错位常见）
    for (let j = i + 1; j < courses.length; j++) {
      const a = courses[i], b = courses[j];
      if (a.day_of_week !== b.day_of_week) continue;
      const wa = new Set(a.weeks || []), wb = new Set(b.weeks || []);
      if (![...wa].some((w) => wb.has(w))) continue;
      const [la, ha] = courseRange(a), [lb, hb] = courseRange(b);
      if (la < hb && lb < ha) {
        const day = nextDayOf(a.day_of_week);
        items.push({
          kind: "course_course",
          text: `《${a.name}》与《${b.name}》节次重叠（周${a.day_of_week}）`,
          course_id: a.id, other_course_id: b.id,
          items: [courseItem(a, day), courseItem(b, day)],
        });
      }
    }
  }
  const seen = new Set();
  const uniq = [];
  for (const it of items) {
    if (seen.has(it.text)) continue;
    seen.add(it.text);
    uniq.push(it);
  }
  return { conflicts: uniq.slice(0, 20) };
}

// ---------- DDL（ddls.py 倒计时墙部分移植；推荐引擎随 v2 砍掉） ----------

const TIER_ORDER = { red: 0, yellow: 1, green: 2, overdue: 3, done: 4 };

function remainText(dueAt, now) {
  const sec = (toDate(dueAt) - now) / 1000;
  const past = sec < 0;
  const hours = Math.abs(sec) / 3600;
  let txt;
  if (hours < 1) txt = `${Math.floor(Math.abs(sec) / 60)}分钟`;
  else if (hours < 24) txt = `${Math.floor(hours)}小时`;
  else {
    const days = Math.floor(hours / 24), rh = Math.floor(hours) % 24;
    txt = `${days}天` + (rh ? `${rh}小时` : "");
  }
  return (past ? "逾期" : "剩") + txt;
}

function tierOf(dueAt, weight, status, now) {
  if (status === "done") return "done";
  const hours = (toDate(dueAt) - now) / 3600000;
  if (hours <= 0) return "overdue";
  const eff = hours / weight; // 权重高 → 同样剩余时间更紧迫
  if (eff <= 12) return "red";
  if (eff <= 72) return "yellow";
  return "green";
}

function ddlOut(d, now) {
  const due = toDate(d.due_at);
  return {
    id: d.id, title: d.title, course_name: d.course_name || "",
    due_at: d.due_at, weight: d.weight, status: d.status,
    kind: d.kind || "task", location: d.location || "", note: d.note || "",
    exam_end: d.exam_end || null, muted: !!d.muted,
    remind: d.kind !== "exam" && d.status !== "done" && 0 < due - now && due - now <= 24 * 3600000,
    tier: tierOf(d.due_at, d.weight, d.status, now),
    remain_text: remainText(d.due_at, now),
  };
}

function examTitle(d) {
  if (!d.course_name || d.title.startsWith(d.course_name)) return d.title;
  return `${d.course_name}·${d.title}`;
}

// 考试 DDL ↔ 日程表事件同步：考试本体按醒目样式上表；改时间/地点随 DDL 更新，删 DDL 连带删
function syncExamEvent(d) {
  const evs = load(K.events, []);
  const ev = evs.find((e) => e.ddl_id === d.id && e.type === "exam") || null;
  if (d.kind !== "exam") {
    if (ev) save(K.events, evs.filter((e) => e !== ev));
    return;
  }
  const start = d.due_at;
  let end;
  if (d.exam_end && d.exam_end > start) {
    end = d.exam_end;
  } else {
    // 没填结束时间默认 +2h，但封顶当天 23:59——due 23:59 的考试不再拖到次日凌晨
    // （跨天事件会把网格撑到底边，看起来像被裁掉）
    const cand = new Date(toDate(start).getTime() + 2 * 3600000);
    const dayEnd = new Date(toDate(start));
    dayEnd.setHours(23, 59, 0, 0);
    end = fmtDT(cand > dayEnd ? dayEnd : cand);
  }
  if (ev) {
    ev.title = examTitle(d).slice(0, 60);
    ev.location = d.location || "";
    ev.note = d.note || "";
    ev.start_at = start;
    ev.end_at = end;
    save(K.events, evs);
  } else {
    newEvent({
      title: examTitle(d).slice(0, 60), icon: "📝", location: d.location || "",
      note: d.note || "", start_at: start, end_at: end, time_status: "exact",
      type: "exam", source: "ddl", ddl_id: d.id,
    });
  }
}

function listDdls() {
  const now = new Date();
  const rows = load(K.ddls, []);
  let dirty = false;
  for (const d of rows) {
    if (d.status === "open" && d.due_at <= fmtDT(now)) {
      d.status = "overdue"; // 真过了时间没完成 → 灰档
      dirty = true;
    }
    if (d.kind === "exam" && d.status !== "done") {
      const end = d.exam_end && d.exam_end > d.due_at
        ? d.exam_end : fmtDT(new Date(toDate(d.due_at).getTime() + 2 * 3600000));
      if (end <= fmtDT(now)) {
        d.status = "done"; // 考试结束自动算完成，事件保留归属
        dirty = true;
      }
    }
  }
  if (dirty) save(K.ddls, rows);
  const out = rows.map((d) => ddlOut(d, now));
  out.sort((a, b) => (TIER_ORDER[a.tier] ?? 9) - (TIER_ORDER[b.tier] ?? 9) || (a.due_at < b.due_at ? -1 : 1));
  return out;
}

// ---------- 个人主页（profile.py 移植；群组随 v2 砍掉） ----------

function getProfile() {
  let p = load(K.profile, null);
  if (!p) {
    p = { user_code: "local", nickname: "", created_at: fmtDT(new Date()) };
    save(K.profile, p);
  }
  return { ...p };
}

function profileSummary() {
  const profile = getProfile();
  const term = getTerm();
  const courses = listCourses();
  const events = load(K.events, [])
    .filter((e) => e.status === "ok")
    .sort((a, b) => (a.start_at < b.start_at ? 1 : -1))
    .slice(0, 200); // 多取一些，重复组折叠后凑满 50 条展示位
  // 长时间重复日程归为一项：同 series 只留最近一条代表，带上总条数
  const seriesCount = {};
  for (const e of events) {
    if (e.series_id) seriesCount[e.series_id] = (seriesCount[e.series_id] || 0) + 1;
  }
  const seenSeries = new Set();
  const grouped = [];
  for (const e of events) {
    if (e.series_id) {
      if (seenSeries.has(e.series_id)) continue;
      seenSeries.add(e.series_id);
    }
    grouped.push({
      id: e.id, title: e.title, icon: e.icon || "", location: e.location || "",
      time_status: e.time_status, type: e.type, start_at: e.start_at, end_at: e.end_at,
      series_id: e.series_id, series_count: e.series_id ? (seriesCount[e.series_id] || 1) : 1,
    });
    if (grouped.length >= 50) break;
  }
  const changes = courses
    .filter((c) => String(c.remark || "").trim())
    .map((c) => ({
      id: c.id, name: c.name, remark: c.remark, day_of_week: c.day_of_week,
      start_slot: c.start_slot, end_slot: c.end_slot, weeks: c.weeks || [],
    }));
  return {
    profile,
    term: term ? termOut(term) : null,
    stats: { courses: courses.length, events: events.length, changes: changes.length },
    events: grouped,
    changes,
  };
}

// ---------- 备份（v2 新增：本机数据 ↔ JSON 字符串） ----------

function exportAll() {
  return JSON.stringify({
    app: "pintime", version: 2, exported_at: fmtDT(new Date()),
    term: getTerm(), courses: load(K.courses, []), events: load(K.events, []),
    ddls: load(K.ddls, []), profile: getProfile(),
  });
}

// 导入 = 整体替换；返回计数。格式不对抛错，不动原数据。
function importAll(json) {
  let data;
  try {
    data = typeof json === "string" ? JSON.parse(json) : json;
  } catch (e) {
    throw new Error("不是合法的 JSON");
  }
  if (!data || data.app !== "pintime" || !Array.isArray(data.courses) || !Array.isArray(data.events) || !Array.isArray(data.ddls)) {
    throw new Error("不是「无闲日程表」的备份文件");
  }
  save(K.term, data.term || null);
  save(K.courses, data.courses);
  save(K.events, data.events);
  save(K.ddls, data.ddls);
  if (data.profile) save(K.profile, data.profile);
  const maxId = [...data.courses, ...data.events, ...data.ddls]
    .reduce((mx, x) => Math.max(mx, x.id || 0), 0);
  save(K.seq, maxId);
  return {
    courses: data.courses.length, events: data.events.length, ddls: data.ddls.length,
  };
}

// 换学期专用：只替换课程（scripts/import_timetable.py 生成的 JSON），
// 日程 / DDL / 学期设置 / 昵称全部保留。周次按当前学期的总周数做双保险裁剪。
function importTimetable(json) {
  let data;
  try {
    data = typeof json === "string" ? JSON.parse(json) : json;
  } catch (e) {
    throw new Error("不是合法的 JSON");
  }
  if (!data || data.app !== "pintime" || data.kind !== "timetable" || !Array.isArray(data.courses)) {
    throw new Error("不是课表导入文件（应由 PC 端 import_timetable.py 生成）");
  }
  const total = (getTerm() || {}).total_weeks || data.total_weeks || 20;
  const allWeeks = Array.from({ length: total }, (_, i) => i + 1);
  const cleaned = [];
  for (const c of data.courses) {
    if (!c || !c.name || !(c.day_of_week >= 1 && c.day_of_week <= 7)) continue;
    const s = Math.max(1, Math.min(c.start_slot || 1, SLOT_TIMES.length));
    const e = Math.max(1, Math.min(c.end_slot || 1, SLOT_TIMES.length));
    const weeks = [...new Set((c.weeks || []).filter((w) => w >= 1 && w <= total))].sort((a, b) => a - b);
    cleaned.push({
      id: nextId(),
      name: String(c.name).slice(0, 60),
      teacher: String(c.teacher || "").slice(0, 30),
      location: String(c.location || "").slice(0, 60),
      day_of_week: c.day_of_week,
      start_slot: Math.min(s, e),
      end_slot: Math.max(s, e),
      weeks: weeks.length ? weeks : allWeeks,
      remark: "",
    });
  }
  if (!cleaned.length) throw new Error("文件里没有有效课程");
  save(K.courses, cleaned);
  return cleaned.length;
}

// ---------- 路由表（与原 FastAPI 接口一一对应） ----------

function get(arr, id) {
  return arr.find((x) => x.id === id) || null;
}

// 建 DDL（单条 /api/ddls 与批量 /api/ddls/batch 共用）
function createDdl(body) {
  const d = {
    id: nextId(), title: body.title, course_name: body.course_name || "",
    due_at: body.due_at, weight: body.weight || 2, kind: body.kind || "task",
    location: body.location || "", note: body.note || "", exam_end: body.exam_end || null,
    muted: false, status: "open",
  };
  const rows = load(K.ddls, []);
  rows.push(d);
  save(K.ddls, rows);
  syncExamEvent(d); // 考试 → 醒目事件上日程表
  return ddlOut(d, new Date());
}

// 群通知长文 → 多条 DDL 候选（v1 /api/ddls/parse 形状：{ddls:[...]}）。
// 分段策略：换行 → 句号/分号，每段独立跑规则引擎。
// 没有日期线索的段（"请大家诚信考试""预祝好成绩"这类嘱咐/署名）直接丢弃，
// 速记引擎只兜底"带日期的短截止句"（"实验报告周五前交"）。
function parseDdlsFromNotice(text) {
  const DATE_HINT = /周[一二三四五六日天]|星期[一二三四五六日天]|礼拜[一二三四五六日天]|明天|后天|大后天|今天|今晚|明晚|\d{1,2}月\d{1,2}/;
  const segs = String(text || "")
    .split(/\n+/)
    .flatMap((ln) => ln.split(/[。；;]+/))
    .map((s) => s.trim())
    .filter((s) => s.length >= 6);
  const out = [];
  const seen = new Set();
  for (const seg of segs) {
    if (!DATE_HINT.test(seg)) continue; // 无日期 = 嘱咐/署名段，不产 DDL
    let p = looksLikeNotice(seg) ? parseNotice(seg) : null;
    if (!p || p.timeStatus === "todo") {
      const r = resolveEventTime(seg);
      if (!r || r.title === "临时安排") continue;
      p = { title: r.title, note: "", location: "", startAt: r.startAt, endAt: r.endAt };
    }
    const title = (p.title || "").trim();
    if (!title || title === "群通知事项") continue;
    const isExam = /考|测试|测验|四六级|答辩/.test(title + seg);
    // DDL 是"截止"语义：考试/窗口型取时段末尾（周五18:00-周日23:59 → 截止周日23:59），
    // 交作业型取开始（"周五24:00前交" → 周五深夜）
    const due_at = (isExam ? p.endAt : p.startAt).replace("T", " ");
    const key = title + "|" + due_at;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title: title.slice(0, 30),
      course_name: "",
      due_at,
      weight: isExam ? 3 : /交|提交|上交|截止|due/.test(seg) ? 2 : 1,
      kind: isExam ? "exam" : "task",
    });
    if (out.length >= 8) break;
  }
  return { ddls: out };
}

function localRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    try {
      resolve(route(method, path, body || {}));
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

function route(method, path, body) {
  let m;
  // ---- 学期 ----
  if (method === "GET" && path === "/api/terms") {
    const t = getTerm();
    if (!t) throw new Error("未设置学期，请先填写开学日期");
    return termOut(t);
  }
  if (method === "PUT" && path === "/api/terms") {
    // 开学日期必须是周一：填了周中任意一天，自动对齐到那一周的周一
    const d = dayStart(body.start_monday);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const t = getTerm() || { id: nextId() };
    t.name = body.name || "本学期";
    t.start_monday = fmtD(d);
    t.total_weeks = Math.max(1, Math.min(30, body.total_weeks || 20));
    save(K.term, t);
    return termOut(t);
  }
  // ---- 课程 ----
  if (method === "GET" && path === "/api/courses") return listCourses();
  if (method === "POST" && path === "/api/courses") {
    if (!getTerm()) throw new Error("请先设置学期");
    const c = { id: nextId() };
    for (const k of COURSE_KEYS) c[k] = body[k] ?? (k === "weeks" ? [] : "");
    c.day_of_week = body.day_of_week;
    c.start_slot = body.start_slot;
    c.end_slot = body.end_slot;
    const cs = load(K.courses, []);
    cs.push(c);
    save(K.courses, cs);
    return { ...c };
  }
  if ((m = path.match(/^\/api\/courses\/(\d+)$/))) {
    const cs = load(K.courses, []);
    const c = get(cs, Number(m[1]));
    if (!c) throw new Error("课程不存在");
    if (method === "PUT") {
      for (const k of COURSE_KEYS) if (k in body) c[k] = body[k];
      save(K.courses, cs);
      return { ...c };
    }
    if (method === "DELETE") {
      save(K.courses, cs.filter((x) => x !== c));
      return { ok: true };
    }
  }
  // ---- 日程 ----
  if (method === "GET" && path === "/api/events") return listEvents();
  if (method === "POST" && path === "/api/events") {
    if (body.end_at <= body.start_at) throw new Error("结束时间要晚于开始时间");
    return newEvent(pick(body, EVENT_KEYS));
  }
  if ((m = path.match(/^\/api\/events\/(\d+)$/))) {
    const evs = load(K.events, []);
    const ev = get(evs, Number(m[1]));
    if (!ev) throw new Error("日程不存在");
    if (method === "PUT") {
      if (body.end_at <= body.start_at) throw new Error("结束时间要晚于开始时间");
      for (const k of EVENT_KEYS) if (k in body) ev[k] = body[k];
      save(K.events, evs);
      return { ...ev };
    }
    if (method === "DELETE") {
      save(K.events, evs.filter((x) => x !== ev));
      return { ok: true };
    }
  }
  if (method === "POST" && path === "/api/events/recurring") return createRecurring(body);
  if ((m = path.match(/^\/api\/events\/series\/(\d+)$/)) && method === "DELETE") {
    const evs = load(K.events, []);
    const rows = evs.filter((e) => e.series_id === Number(m[1]));
    if (!rows.length) throw new Error("日程组不存在");
    save(K.events, evs.filter((e) => e.series_id !== Number(m[1])));
    return { ok: true, deleted: rows.length };
  }
  if (method === "POST" && path === "/api/events/conflict") {
    // 只报告不阻断——大概/待定不做检测；仅开始按预估结束检测
    if (body.time_status !== "exact" && body.time_status !== "start_only")
      return { courses: [], events: [] };
    return {
      courses: findCourseConflicts(body.start_at, body.end_at),
      events: findEventConflicts(body.start_at, body.end_at, body.exclude_event_id),
    };
  }
  if (method === "GET" && path === "/api/events/conflicts") return listConflicts();
  // ---- DDL ----
  if (method === "GET" && path === "/api/ddls") return listDdls();
  if (method === "POST" && path === "/api/ddls") return createDdl(body);
  if ((m = path.match(/^\/api\/ddls\/(\d+)(\/(done|reopen))?$/))) {
    const rows = load(K.ddls, []);
    const d = get(rows, Number(m[1]));
    if (!d) throw new Error("DDL 不存在");
    if (method === "PUT" && !m[2]) {
      const keys = ["title", "course_name", "due_at", "weight", "kind", "location", "note", "exam_end"];
      for (const k of keys) if (k in body) d[k] = body[k];
      if (d.status === "overdue") d.status = "open"; // 改了截止时间，逾期状态重算
      save(K.ddls, rows);
      syncExamEvent(d); // 考试改时间/地点 → 日程表事件跟着改
      return ddlOut(d, new Date());
    }
    if (method === "DELETE" && !m[2]) {
      // 事件不悬空：考试事件随 DDL 删；已排安排解除归属，变普通日程保留
      const evs = load(K.events, []);
      for (const e of evs) {
        if (e.ddl_id === d.id) {
          if (e.type === "exam") e._del = true;
          else e.ddl_id = null;
        }
      }
      save(K.events, evs.filter((e) => !e._del));
      save(K.ddls, rows.filter((x) => x !== d));
      return { ok: true };
    }
    if (method === "POST" && m[3] === "done") {
      d.status = "done";
      save(K.ddls, rows);
      return ddlOut(d, new Date());
    }
    if (method === "POST" && m[3] === "reopen") {
      d.status = d.due_at <= fmtDT(new Date()) ? "overdue" : "open";
      save(K.ddls, rows);
      return ddlOut(d, new Date());
    }
    if (method === "POST" && m[3] === "unmute") {
      d.muted = false;
      save(K.ddls, rows);
      return ddlOut(d, new Date());
    }
  }
  // ---- 个人主页 ----
  if (method === "GET" && path === "/api/profile/summary") return profileSummary();
  if (method === "PUT" && path === "/api/profile") {
    const p = getProfile();
    p.nickname = String(body.nickname || "").trim();
    save(K.profile, p);
    return { ...p };
  }
  if (method === "POST" && path === "/api/profile/reset") {
    if (!["courses", "events", "all"].includes(body.scope))
      throw new Error("scope 只能是 courses/events/all");
    const deleted = { courses: 0, events: 0 };
    if (body.scope === "courses" || body.scope === "all") {
      deleted.courses = load(K.courses, []).length;
      save(K.courses, []);
    }
    if (body.scope === "events" || body.scope === "all") {
      deleted.events = load(K.events, []).length;
      save(K.events, []);
    }
    return { ok: true, deleted };
  }
  // ---- v1 完全体端点：群通知批量抽取 / 批量入库 / 速记解析 / 课表导入 ----
  if (method === "POST" && path === "/api/ddls/parse") return parseDdlsFromNotice(body.text);
  if (method === "POST" && path === "/api/ddls/batch") {
    if (!Array.isArray(body.ddls) || !body.ddls.length) throw new Error("没有可入库的 DDL");
    for (const d of body.ddls) createDdl(d);
    return { ok: true, count: body.ddls.length };
  }
  if (method === "POST" && path === "/api/courses/batch") {
    if (!getTerm()) throw new Error("请先设置学期");
    if (!Array.isArray(body.courses) || !body.courses.length) throw new Error("没有可导入的课程");
    const cs = load(K.courses, []);
    for (const b of body.courses) {
      const c = { id: nextId() };
      for (const k of COURSE_KEYS) c[k] = b[k] ?? (k === "weeks" ? [] : "");
      cs.push(c);
    }
    save(K.courses, cs);
    return { ok: true, count: body.courses.length };
  }
  if (method === "POST" && path === "/api/ai/parse-voice") {
    // 速记解析（规则引擎）：文本 → 日程草稿，v1 voice 页形状
    const t = String(body.text || "").trim();
    if (!t) throw new Error("没内容可解析");
    let p = looksLikeNotice(t) ? parseNotice(t) : null;
    if (!p) {
      const r = resolveEventTime(t);
      p = { title: r.title, note: "", location: "", startAt: r.startAt, endAt: r.endAt, timeStatus: "exact" };
    }
    return {
      title: p.title, note: p.note || "", location: p.location || "",
      start_at: p.startAt, end_at: p.endAt, time_status: p.timeStatus, by: "rule",
    };
  }
  if (method === "POST" && path === "/api/ai/parse-timetable-text") {
    // 手机端课表导入：认 PC 脚本（import_timetable.py）生成的 JSON；
    // 自由文本/截图的 AI 解析按 v2 决策不开（个人主体深度合成类目过不了）
    let data;
    try {
      data = typeof body.text === "string" ? JSON.parse(body.text) : body.text;
    } catch (e) {
      throw new Error("手机端先支持粘贴 PC 脚本生成的课表 JSON；自由文字解析请等后续版本");
    }
    if (!data || data.app !== "pintime" || data.kind !== "timetable" || !Array.isArray(data.courses)) {
      throw new Error("不是课表导入 JSON（应由 PC 端 import_timetable.py 生成，粘贴其全文）");
    }
    return { by: "rule", courses: data.courses };
  }
  if (method === "POST" && (path === "/api/ai/voice-upload" || path === "/api/ai/parse-timetable" || path === "/api/ai/parse-timetable-file")) {
    throw new Error("语音转文字/截图/文件解析走微信插件与 AI 能力，v1.1 开放；速记可用打字模式");
  }
  // ---- 建议引擎（批奏折，v1 规则移植：权重×紧迫度×空闲段） ----
  const sug = handleSuggestionRoute(method, path, body, { load, save, now: new Date() });
  if (sug !== null) return sug;
  // ---- 群组：云端共享集合实现（见 cloudfunctions/api/groups.js）；单机版仅列表可用 ----
  if (method === "GET" && path === "/api/groups") return { groups: [] };
  if (path.startsWith("/api/groups")) throw new Error("拼时间是云端功能，请在微信小程序里用");
  // ---- 备份（走统一数据路径：小程序云端模式下备份读写云端文档） ----
  if (method === "GET" && path === "/api/backup") return exportAll();
  if (method === "POST" && path === "/api/backup") return importAll(body.json !== undefined ? body.json : body);
  if (method === "POST" && path === "/api/timetable/import") return importTimetable(body.json !== undefined ? body.json : body);
  throw new Error(`没有这个接口：${method} ${path}`);
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = obj[k];
  return out;
}

return { bindStorage, exportAll, importAll, importTimetable, localRequest };
})();
const { bindStorage, exportAll, importAll, importTimetable, localRequest } = __core;

module.exports = { bindStorage, localRequest, exportAll, importAll, importTimetable, SLOT_TIMES };