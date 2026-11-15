// v2 数据核心：原 FastAPI 后端（terms/courses/events/ddls/conflict/profile 六域）
// 移植为"可注入键值存储"的纯逻辑——uni storage（单机版）与云函数 KV（小程序版）
// 跑同一套代码，行为永不漂移。接口签名/返回结构与后端保持一致，页面层零改动。
//
// 时间格式约定：统一 "YYYY-MM-DD HH:mm:ss"（与后端 pydantic 序列化等价，
// 前端已有代码按 slice(0,10)/slice(11,16)/replace(" ","T") 解析，两种格式都兼容）。
import { SLOT_TIMES } from "./slots";
import { looksLikeNotice, parseNotice, resolveEventTime } from "./notice";
import { handleSuggestionRoute } from "./suggest";
import { parseDocxXml, parseXlsxParts } from "./timetableFile";

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
export function bindStorage(kv) {
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

export function exportAll() {
  return JSON.stringify({
    app: "pintime", version: 2, exported_at: fmtDT(new Date()),
    term: getTerm(), courses: load(K.courses, []), events: load(K.events, []),
    ddls: load(K.ddls, []), profile: getProfile(),
  });
}

// 导入 = 整体替换；返回计数。格式不对抛错，不动原数据。
export function importAll(json) {
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
export function importTimetable(json) {
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

export function localRequest(method, path, body) {
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
  if (method === "POST" && (path === "/api/ai/voice-upload" || path === "/api/ai/parse-timetable")) {
    throw new Error("语音转文字/截图解析走微信插件与 AI 能力，v1.1 开放；速记可用打字模式");
  }
  if (method === "POST" && path === "/api/ai/parse-timetable-file") {
    // 文件课表：调用方（小程序）已解压出 XML，这里规则解析（import_timetable.py 移植）
    if (body.kind === "docx") {
      const r = parseDocxXml(String(body.xml || ""));
      if (!r.courses.length) throw new Error("没解析出课程：确认是教务导出的 docx 课表");
      return { by: "rule", courses: r.courses };
    }
    if (body.kind === "xlsx") {
      const r = parseXlsxParts(String(body.sheet || ""), String(body.strings || ""));
      if (!r.courses.length) throw new Error("没解析出课程：确认是教务导出的 xlsx 课表");
      return { by: "rule", courses: r.courses };
    }
    throw new Error("kind 只能是 docx 或 xlsx");
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
