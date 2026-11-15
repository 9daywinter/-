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
import { SLOT_TIMES } from "./slots";

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

export function handleSuggestionRoute(method, path, body, ctx) {
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
