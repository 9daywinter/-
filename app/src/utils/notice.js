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

export function resolveEventTime(text, now = new Date()) {
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
  const rules = [
    [/(大后晚|后晚|明晚|今晚)/, (m) => addDays(dateOnly(now), D_EVE[m[0]])],
    [/(大后天|后天|明天|今天|今日)/, (m) => addDays(dateOnly(now), D_REL[m[0]])],
    [/下(?:周|星期|礼拜)([一二三四五六日天])/, (m) => addDays(addDays(dateOnly(now), 7 - pyWeekday(now)), WEEKDAY_IDX[m[1]])],
    [/(?:本|这)?(?:周|星期|礼拜)([一二三四五六日天])/, (m) => addDays(dateOnly(now), (WEEKDAY_IDX[m[1]] - pyWeekday(now) + 7) % 7)],
    [/(\d{1,2})月(\d{1,2})[日号]?/, (m) => {
      const d = new Date(now.getFullYear(), parseInt(m[1], 10) - 1, parseInt(m[2], 10));
      return isNaN(d) ? dateOnly(now) : d;
    }],
  ];
  let best = null;
  rules.forEach(([pat, fn], idx) => {
    const m = pat.exec(s);
    if (!m) return;
    if (best == null || idx < best.idx || (idx === best.idx && m.index < best.pos)) {
      best = { idx, pos: m.index, date: fn(m), text: m[0] };
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
  let m = TITLE_VP.exec(s);
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

export function parseNotice(text, now = new Date()) {
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

export function looksLikeNotice(text) {
  const t = String(text || "").trim();
  if (t.length > 30 || t.includes("\n")) return true;
  if (/^\s*[0-9]{1,2}[.、,，)）]/m.test(t)) return true;
  if (t.split(/[。；;]/).length > 2) return true;
  if (/通知|定于|将于|拟于|举办|开展|组织|安排|请(?:大家|同学|各位)|各位同学|全体同学|要求/.test(t)) return true;
  return false;
}
