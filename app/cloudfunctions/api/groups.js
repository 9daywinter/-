"use strict";
// 组队/拼时间后端 —— v1 FastAPI server/app/routers/groups.py（443 行）的微信云函数移植。
//
// 数据模型（共享集合 groups，每组一个文档）：
//   { code, name, owner, members:[{openid, nickname, joined_at}],
//     privacy: { [openid]: true/false },          // FR-45 细节开放开关，默认关
//     settle:  { batches: { [batch]: { title, day, start_min, end_min,
//                                     members:[openid...], responses:{[openid]:"ok"|"conflict"},
//                                     settled, created_at } } },
//     created_at }
//
// 与 v1 的两点结构差异（算法/语义不变）：
// 1) 成员忙闲不冗余进组文档：调 ctx.loadUserData(openid) 拿该用户 db-core 形状的
//    {term, courses, events} 实时算（时间串 "YYYY-MM-DD HH:mm:ss"，字典序即时间序，
//    与 v1 的 datetime 比较等价）。
// 2) v1 定档是给每个成员写一条 Event(type=group, status=pending, note=batch)，确认后
//    转 ok 落各自日程；云函数侧只有调用者能写自己的文档，批次改收在组文档
//    settle.batches 里。responses 缺省 = v1 的 pending 事件；全员 ok → settled
//    （= v1 整批转 ok）；有人 conflict → 冲突（可再改口，同 v1 重复 respond 语义）。
//    check/free/matrix 已把本组批次按 v1 的 ok/pending 可见性叠进忙闲。
//
// 出入口：async handleGroupsRoute(method, path, body, {db, openid, loadUserData, SLOT_TIMES})
//   命中 /api/groups* → 返回与 v1 前端逐字段一致的对象（出错 throw Error(中文提示)）；
//   path 不是 /api/groups 开头 → 返回 null（交回调用方）。

const COL = "groups";

const BUSY_WINDOW = [8 * 60, 23 * 60];   // 共同空闲只在 8:00-23:00 里找
const ACTIVE = [8 * 60, 22 * 60 + 30];   // 活动窗（睡眠不排）
const MEALS = [[720, 820], [1050, 1130]]; // 12:00-13:40 / 17:30-18:50 饭点：可能有事
const GRID = 30;                          // 30 分钟粒度（FR-42）
const TOP_N = 3;
const MIN_SEG = 40;                       // 碎片小于 40 分钟不算整段空闲
const CODE_CHARS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // 4-6 位口令，去掉易混 0/O/1/I/L

// ---------- 时间工具（db-core 同款约定："YYYY-MM-DD HH:mm:ss"） ----------

const pad = (n) => (n < 10 ? "0" + n : "" + n);
const fmtD = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtDT = (d) =>
  `${fmtD(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

function dayStart(dstr) {
  const [y, m, d] = String(dstr).slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
}
function addDays(dstr, n) {
  const d = dayStart(dstr);
  d.setDate(d.getDate() + n);
  return fmtD(d);
}
function isoWeekday(dstr) {
  return dayStart(dstr).getDay() || 7; // 1=周一 … 7=周日
}
function daysBetween(a, b) {
  return Math.round((dayStart(b) - dayStart(a)) / 86400000);
}
// 教学周（week.py current_week 的"指定某天"版）：开学前 0，超总周数封顶
function currentWeekOn(term, dayStr) {
  const days = daysBetween(term.start_monday, dayStr);
  if (days < 0) return 0;
  return Math.min(Math.floor(days / 7) + 1, term.total_weeks);
}
// "HH:mm" → 分钟数（_hms）
const hms = (t) => {
  const [h, m] = String(t).split(":");
  return Number(h) * 60 + Number(m);
};
// "YYYY-MM-DD HH:mm:ss" → 当天分钟数（只看时分）
const minutesOf = (dtStr) =>
  Number(String(dtStr).slice(11, 13)) * 60 + Number(String(dtStr).slice(14, 16));
const minToHHMM = (m) => `${pad((m / 60) | 0)}:${pad(m % 60)}`;

// ---------- 组文档读写（wx-server-sdk 基本面：where/get/add/doc().update/remove） ----------

async function findGroup(db, code) {
  const r = await db.collection(COL).where({ code }).limit(1).get();
  return (r && r.data && r.data[0]) || null;
}
async function saveGroup(db, g, fields) {
  const data = {};
  for (const f of fields) data[f] = g[f];
  await db.collection(COL).doc(g._id).update({ data });
}
async function mustGroup(db, code) {
  const g = await findGroup(db, String(code).trim().toUpperCase());
  if (!g) throw new Error("组不存在");
  return g;
}
function mustMember(g, openid) {
  if (!(g.members || []).some((m) => m.openid === openid)) throw new Error("先加入这个组");
}

// 4-6 位口令：生成后查重，冲突重试 3 次
function genCode() {
  const len = 4 + Math.floor(Math.random() * 3);
  let s = "";
  for (let i = 0; i < len; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}
async function newCode(db) {
  for (let i = 0; i < 3; i++) {
    const code = genCode();
    const hit = await db.collection(COL).where({ code }).limit(1).get();
    if (!hit.data || !hit.data.length) return code;
  }
  throw new Error("口令生成冲突，请再试一次");
}

// ---------- 输出形状（与 v1 _group_out / _member_out 逐字段一致） ----------

function groupOut(g, openid) {
  const members = g.members || [];
  const me = members.find((m) => m.openid === openid) || null;
  return {
    code: g.code,
    name: g.name,
    creator_code: g.owner,
    is_creator: g.owner === openid,
    members: members.map((m) => ({
      user_code: m.openid,
      nickname: m.nickname || "同学",
      share_detail: !!(g.privacy && g.privacy[m.openid]),
      is_me: m.openid === openid,
    })),
    my_share_detail: me ? !!(g.privacy && g.privacy[openid]) : false,
  };
}

// ---------- 忙闲核心（groups.py + ddls.py _day_busy/_free_segments 移植） ----------

function batchesOf(g) {
  return g.settle && g.settle.batches ? Object.values(g.settle.batches) : [];
}
// 我在某批定档里的有效状态（= v1 各人日程表里那条群组事件的 status）
function myBatchStatus(g, openid, b) {
  if (!b.members || !b.members.includes(openid)) return null; // 定档后才入组 → 没我的事件
  return b.responses && b.responses[openid] !== undefined ? b.responses[openid] : "pending";
}

// 课程节次区间：教学周命中才返回（groups.py 的课程部分）[{lo, hi, name}]
function courseIntervals(term, courses, dayStr, SLOT_TIMES) {
  if (!term) return [];
  const week = currentWeekOn(term, dayStr);
  if (week < 1) return [];
  const dow = isoWeekday(dayStr);
  const out = [];
  for (const c of courses || []) {
    if (c.day_of_week !== dow || !(c.weeks || []).includes(week)) continue;
    out.push({
      lo: hms(SLOT_TIMES[c.start_slot - 1][0]),
      hi: hms(SLOT_TIMES[Math.min(c.end_slot, SLOT_TIMES.length) - 1][1]),
      name: c.name,
    });
  }
  return out;
}

// 区间合并（ddls.py _merge）
function mergeIntervals(ivs) {
  const sorted = ivs.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [lo, hi] of sorted) {
    if (out.length && lo <= out[out.length - 1][1]) {
      out[out.length - 1][1] = Math.max(out[out.length - 1][1], hi);
    } else {
      out.push([lo, hi]);
    }
  }
  return out;
}

// 某天的忙碌区间（ddls.py _day_busy）：饭点 + 课表节次 + ok 精确/仅开始日程 + 已确认定档
function dayBusy(g, m, dayStr, ud, SLOT_TIMES) {
  const ivs = MEALS.slice();
  for (const c of courseIntervals(ud.term, ud.courses, dayStr, SLOT_TIMES))
    ivs.push([c.lo, c.hi]);
  const dayLo = dayStr + " 00:00:00";
  const dayHi = dayStr + " 23:59:59";
  for (const e of ud.events || []) {
    if (e.status !== "ok" || (e.time_status !== "exact" && e.time_status !== "start_only")) continue;
    if (e.end_at < dayLo || e.start_at > dayHi) continue;
    ivs.push([
      e.start_at < dayLo ? 0 : minutesOf(e.start_at),
      e.end_at > dayHi ? 24 * 60 : minutesOf(e.end_at),
    ]);
  }
  for (const b of batchesOf(g)) {
    if (myBatchStatus(g, m.openid, b) === "ok" && b.day === dayStr)
      ivs.push([b.start_min, b.end_min]);
  }
  return mergeIntervals(ivs);
}

// 活动窗 − 忙碌 → 空闲段（ddls.py _free_segments，≥40 分钟才算）
function freeSegments(busy) {
  const [lo0, hi0] = ACTIVE;
  const segs = [];
  let cur = lo0;
  for (const [lo, hi] of busy) {
    if (hi <= cur || lo >= hi0) continue;
    if (lo > cur) segs.push([cur, Math.min(lo, hi0)]);
    cur = Math.max(cur, hi);
  }
  if (cur < hi0) segs.push([cur, hi0]);
  return segs.filter(([a, b]) => b - a >= MIN_SEG);
}

// 成员在 [lo,hi) 的三档状态 + 细节（groups.py _member_status）：
// busy 确定忙 / maybe 可能有事（饭点、模糊日程整天罩住）/ free 应该空闲。
// 细节（上课/安排/挡时间 + 标题）仅在本人开放 privacy 时返回。
function memberStatus(g, m, dayStr, lo, hi, ud, SLOT_TIMES) {
  const details = [];
  // 课程
  for (const c of courseIntervals(ud.term, ud.courses, dayStr, SLOT_TIMES)) {
    if (c.lo < hi && lo < c.hi) details.push(`上课 ${c.name}`);
  }
  // 日程：ok/pending 都算；exact/start_only 占时间，fuzzy/todo 要整天罩住才算"可能有事"
  const dayLo = dayStr + " 00:00:00";
  const dayHi = dayStr + " 23:59:59";
  let fuzzyHit = false;
  for (const e of ud.events || []) {
    if ((e.status !== "ok" && e.status !== "pending") || e.end_at < dayLo || e.start_at > dayHi)
      continue;
    const eLo = e.start_at < dayLo ? 0 : minutesOf(e.start_at);
    const eHi = e.end_at > dayHi ? 24 * 60 - 1 : minutesOf(e.end_at);
    if (e.time_status === "exact" || e.time_status === "start_only") {
      if (eLo < hi && lo < eHi)
        details.push(`${e.type === "block" ? "挡时间" : "安排"} ${e.title}`);
    } else if (eLo <= lo && eHi >= hi) {
      fuzzyHit = true;
    }
  }
  // 本组定档批次（= v1 各人日程表里的 pending/ok 群组事件，这里收在组文档）
  for (const b of batchesOf(g)) {
    const st = myBatchStatus(g, m.openid, b);
    if ((st === "ok" || st === "pending") && b.day === dayStr) {
      if (b.start_min < hi && lo < b.end_min) details.push(`安排 ${b.title}`);
    }
  }
  // 饭点深夜 → 可能有事
  const mealHit = MEALS.some(([a, b]) => a < hi && lo < b);
  const hard = details.some(
    (d) => d.startsWith("上课") || d.startsWith("安排") || d.startsWith("挡时间")
  );
  if (hard) return { status: "busy", details: g.privacy && g.privacy[m.openid] ? details : [] };
  if (fuzzyHit || mealHit) return { status: "maybe", details: [] };
  return { status: "free", details: [] };
}

// 成员某天的 (确定忙, 可能有事) 区间（groups.py _member_day_intervals）：
// 每天每成员只扫一遍，供整周矩阵复用。与 _member_status 的差异：
// 只认 status=ok（已确认定档才算忙，待确认不占格子）、maybe = 饭点 + 模糊日程。
function memberDayIntervals(g, m, dayStr, ud, SLOT_TIMES) {
  const busy = courseIntervals(ud.term, ud.courses, dayStr, SLOT_TIMES).map((c) => [c.lo, c.hi]);
  const fuzzy = [];
  const dayLo = dayStr + " 00:00:00";
  const dayHi = dayStr + " 23:59:59";
  for (const e of ud.events || []) {
    if (e.status !== "ok" || e.end_at < dayLo || e.start_at > dayHi) continue;
    const lo = e.start_at < dayLo ? 0 : minutesOf(e.start_at);
    const hi = e.end_at > dayHi ? 24 * 60 : minutesOf(e.end_at);
    if (e.time_status === "exact" || e.time_status === "start_only") busy.push([lo, hi]);
    else fuzzy.push([lo, hi]); // fuzzy/todo 任何重叠都标"可能有事"
  }
  for (const b of batchesOf(g)) {
    if (myBatchStatus(g, m.openid, b) === "ok" && b.day === dayStr)
      busy.push([b.start_min, b.end_min]);
  }
  return { busy, maybe: MEALS.concat(fuzzy) };
}

const overlap = (ivs, lo, hi) => ivs.some(([a, b]) => a < hi && lo < b);

// ---------- 11 个端点 ----------

// POST /api/groups {name, nickname} → _group_out
async function createGroup(db, openid, body) {
  const name = String(body.name || "").trim().slice(0, 64);
  const nickname = String(body.nickname || "").trim().slice(0, 32);
  if (!name || !nickname) throw new Error("组名和昵称不能为空");
  const code = await newCode(db);
  const now = fmtDT(new Date());
  const doc = {
    code,
    name,
    owner: openid,
    members: [{ openid, nickname, joined_at: now }],
    privacy: {},
    settle: { batches: {} },
    created_at: now,
  };
  const r = await db.collection(COL).add({ data: doc });
  doc._id = r._id;
  return groupOut(doc, openid);
}

// POST /api/groups/join {code, nickname} → _group_out（重复进组 = 改昵称）
async function joinGroup(db, openid, body) {
  const code = String(body.code || "").trim().toUpperCase();
  const nickname = String(body.nickname || "").trim().slice(0, 32);
  if (!code) throw new Error("口令不对，找组长核对一下");
  if (!nickname) throw new Error("昵称不能为空");
  const g = await findGroup(db, code);
  if (!g) throw new Error("口令不对，找组长核对一下");
  g.members = g.members || [];
  const me = g.members.find((m) => m.openid === openid);
  if (me) {
    me.nickname = nickname;
  } else {
    g.members.push({ openid, nickname, joined_at: fmtDT(new Date()) });
  }
  await saveGroup(db, g, ["members"]);
  return groupOut(g, openid);
}

// GET /api/groups → {groups:[_group_out...]}
async function myGroups(db, openid) {
  const r = await db.collection(COL).where({ "members.openid": openid }).get();
  return { groups: ((r && r.data) || []).map((g) => groupOut(g, openid)) };
}

// POST /{code}/leave → {ok:true}（组空了顺手删组，同 v1）
async function leaveGroup(db, g, openid) {
  const idx = (g.members || []).findIndex((m) => m.openid === openid);
  if (idx < 0) throw new Error("你不在这个组");
  g.members.splice(idx, 1);
  if (!g.members.length) {
    await db.collection(COL).doc(g._id).remove();
  } else {
    await saveGroup(db, g, ["members"]);
  }
  return { ok: true };
}

// POST /{code}/privacy {share_detail} → {ok, share_detail}（FR-45）
async function setPrivacy(db, g, openid, body) {
  mustMember(g, openid);
  g.privacy = g.privacy || {};
  g.privacy[openid] = !!body.share_detail;
  await saveGroup(db, g, ["privacy"]);
  return { ok: true, share_detail: g.privacy[openid] };
}

// GET /{code}/free?days=7 → 共同空闲 Top3（groups.py common_free）：
// 逐 30 分钟格求全员空闲交集 → 连续格合并 → 打分（越早越大段越靠前）→ Top3 + 全员状态
async function commonFree(g, openid, daysParam, ud, SLOT_TIMES) {
  mustMember(g, openid);
  const members = g.members || [];
  if (!members.length) return { slots: [] };
  const days = Math.max(1, Math.min(parseInt(daysParam, 10) || 7, 14));
  const today = fmtD(new Date());
  const now = new Date();
  const cands = [];
  let day = today;
  for (let i = 0; i < days; i++) {
    const segsPerM = [];
    for (const m of members) {
      segsPerM.push(freeSegments(dayBusy(g, m, day, await ud(m.openid), SLOT_TIMES)));
    }
    const [lo0, hi0] = BUSY_WINDOW;
    const gridLo = Math.ceil(Math.max(lo0, day === today ? now.getHours() * 60 + now.getMinutes() : 0) / GRID) * GRID;
    const cells = [];
    for (let t = gridLo; t + GRID <= Math.min(hi0, 23 * 60); t += GRID) {
      if (segsPerM.every((segs) => segs.some(([a, b]) => a <= t && t + GRID <= b)))
        cells.push([t, t + GRID]);
    }
    // 连续格合并成段（groups.py _merge）
    const merged = [];
    for (const [a, b] of cells) {
      if (merged.length && a === merged[merged.length - 1][1]) merged[merged.length - 1][1] = b;
      else merged.push([a, b]);
    }
    for (const [a, b] of merged) cands.push({ day, lo: a, hi: b });
    day = addDays(day, 1);
  }
  const score = (c) => (c.hi - c.lo) / (1 + 0.5 * daysBetween(today, c.day));
  const top = cands
    .map((c, i) => ({ c, i }))
    .sort((x, y) => score(y.c) - score(x.c) || x.i - y.i)
    .slice(0, TOP_N);
  const out = [];
  for (const { c } of top) {
    const states = [];
    for (const m of members) {
      const st = memberStatus(g, m, c.day, c.lo, c.hi, await ud(m.openid), SLOT_TIMES);
      states.push({ nickname: m.nickname || "同学", status: st.status, details: st.details });
    }
    out.push({ date: c.day, start_min: c.lo, end_min: c.hi, members: states });
  }
  return { slots: out };
}

// GET /{code}/matrix?week=0|1 → 周一至周日 × 30 分钟格 × 全员（groups.py busy_matrix）
// 0 空闲 / 1 可能有事 / 2 确定忙；隐私同 FR-45：只给状态，细节走 /check
async function busyMatrix(g, openid, weekParam, ud, SLOT_TIMES) {
  mustMember(g, openid);
  const week = parseInt(weekParam, 10) ? 1 : 0;
  const today = fmtD(new Date());
  const monday = addDays(today, -(isoWeekday(today) - 1) + 7 * week);
  const days = [];
  for (let i = 0; i < 7; i++) days.push(addDays(monday, i));
  const slots = [];
  for (let t = BUSY_WINDOW[0]; t < BUSY_WINDOW[1]; t += GRID) slots.push(t);
  const members = g.members || [];
  const grid = [];
  for (const day of days) {
    const perMember = [];
    for (const m of members) {
      const { busy, maybe } = memberDayIntervals(g, m, day, await ud(m.openid), SLOT_TIMES);
      const col = [];
      for (const lo of slots) {
        const hi = lo + GRID;
        if (overlap(busy, lo, hi)) col.push(2);
        else if (overlap(maybe, lo, hi)) col.push(1);
        else col.push(0);
      }
      perMember.push(col);
    }
    grid.push(perMember);
  }
  return {
    days,
    slots,
    members: members.map((m) => ({ nickname: m.nickname || "同学", is_me: m.openid === openid })),
    grid,
  };
}

// POST /{code}/check {day, start_min, end_min} → 每成员三档状态（groups.py check_time）
async function checkTime(g, openid, body, ud, SLOT_TIMES) {
  mustMember(g, openid);
  const day = String(body.day || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("日期格式不对");
  const lo = Number(body.start_min);
  const hi = Number(body.end_min);
  if (!(lo >= 0 && lo <= 1439 && hi >= 1 && hi <= 1440)) throw new Error("时间要在 0-1440 分钟内");
  if (hi <= lo) throw new Error("结束要晚于开始");
  const out = [];
  for (const m of g.members || []) {
    const st = memberStatus(g, m, day, lo, hi, await ud(m.openid), SLOT_TIMES);
    out.push({ nickname: m.nickname || "同学", is_me: m.openid === openid, status: st.status, details: st.details });
  }
  return { members: out };
}

// POST /{code}/settle {title, day, start_min, end_min} → {ok, batch, count}（FR-44）
// 组长定档：批次收进组文档，全员各有一条待确认记录（= v1 给每人写 pending 事件）
async function settle(db, g, openid, body) {
  if (g.owner !== openid) throw new Error("只有组长能定档");
  const title = String(body.title || "").trim().slice(0, 64);
  const day = String(body.day || "").slice(0, 10);
  const lo = Number(body.start_min);
  const hi = Number(body.end_min);
  if (!title) throw new Error("活动名不能为空");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("日期格式不对");
  if (!(lo >= 0 && lo <= 1439 && hi >= 1 && hi <= 1440)) throw new Error("时间要在 0-1440 分钟内");
  if (hi <= lo) throw new Error("结束要晚于开始");
  const members = g.members || [];
  if (!members.length) throw new Error("组里没人");
  const batch = `group:${g.code}:${Date.now()}`;
  g.settle = g.settle || { batches: {} };
  g.settle.batches = g.settle.batches || {};
  g.settle.batches[batch] = {
    title,
    day,
    start_min: lo,
    end_min: hi,
    members: members.map((m) => m.openid), // 定档时成员快照（此后入组者无确认义务）
    responses: {},
    settled: false,
    created_at: fmtDT(new Date()),
  };
  await saveGroup(db, g, ["settle"]);
  return { ok: true, batch, count: members.length };
}

// POST /{code}/respond {batch, ok}（groups.py respond）
// ✓/✗；全员 ok → settled（v1 整批转 ok 正式进日程）；有人 ✗ → conflict；
// 未齐 → {confirmed, total}。重复 respond 会改口（同 v1 事件 status 直接覆盖）
async function respond(db, g, openid, body) {
  mustMember(g, openid);
  const key = String(body.batch || "");
  const b = g.settle && g.settle.batches ? g.settle.batches[key] : null;
  if (!b || !b.members || !b.members.includes(openid))
    throw new Error("这档不存在或已处理");
  const okFlag = body.ok === undefined ? true : !!body.ok;
  b.responses[openid] = okFlag ? "ok" : "conflict";
  const vals = b.members.map((id) => (b.responses[id] !== undefined ? b.responses[id] : "pending"));
  // 每次重算（同 v1 按事件 status 现算）：全员 ok 才算定下，有人改口 ✗ 会撤销
  b.settled = vals.every((v) => v === "ok");
  await saveGroup(db, g, ["settle"]);
  if (b.settled) return { ok: true, settled: true };
  if (vals.includes("conflict")) return { ok: true, settled: false, conflict: true };
  return {
    ok: true,
    settled: false,
    confirmed: vals.filter((v) => v === "ok").length,
    total: vals.length,
  };
}

// GET /{code}/pending → 我的待确认定档（groups.py pending_settles）
async function pendingSettles(g, openid) {
  mustMember(g, openid);
  const out = [];
  const batches = (g.settle && g.settle.batches) || {};
  for (const batch of Object.keys(batches)) {
    const b = batches[batch];
    const st = myBatchStatus(g, openid, b);
    if (st !== "pending") continue; // 已确认/已冲突/定档后才入组 → 不显示
    out.push({
      batch,
      title: b.title,
      start_at: `${b.day}T${minToHHMM(b.start_min)}`,
      end_at: `${b.day}T${minToHHMM(b.end_min)}`,
    });
  }
  return { pending: out };
}

// ---------- 路由 ----------

const ACTIONS = {
  leave: "POST",
  privacy: "POST",
  free: "GET",
  matrix: "GET",
  check: "POST",
  settle: "POST",
  respond: "POST",
  pending: "GET",
};

async function handleGroupsRoute(method, path, body, ctx) {
  if (!path || !path.startsWith("/api/groups")) return null;
  const { db, openid, loadUserData, SLOT_TIMES } = ctx || {};
  if (!db || !openid || !loadUserData) throw new Error("groups: 缺少上下文参数");
  body = body || {};

  // path 可能带查询串（?days=7 / ?week=1），自己拆
  const qi = path.indexOf("?");
  const p = qi >= 0 ? path.slice(0, qi) : path;
  const q = {};
  if (qi >= 0) {
    for (const kv of path.slice(qi + 1).split("&")) {
      if (!kv) continue;
      const eq = kv.indexOf("=");
      const k = decodeURIComponent(eq >= 0 ? kv.slice(0, eq) : kv);
      q[k] = eq >= 0 ? decodeURIComponent(kv.slice(eq + 1)) : "";
    }
  }

  // 每请求每人只 loadUserData 一次（free/matrix 多天复用同一份）
  const cache = new Map();
  const ud = async (id) => {
    if (!cache.has(id)) {
      const d = await loadUserData(id);
      cache.set(id, {
        term: d && d.term ? d.term : null,
        courses: (d && d.courses) || [],
        events: (d && d.events) || [],
      });
    }
    return cache.get(id);
  };

  if (p === "/api/groups") {
    if (method === "POST") return createGroup(db, openid, body);
    if (method === "GET") return myGroups(db, openid);
    throw new Error(`没有这个接口：${method} ${path}`);
  }
  if (method === "POST" && p === "/api/groups/join") return joinGroup(db, openid, body);

  const segs = p.split("/").filter(Boolean).slice(2); // ["api","groups", code?, action?]
  if (segs.length === 2 && ACTIONS[segs[1]] === method) {
    const g = await mustGroup(db, segs[0]);
    switch (segs[1]) {
      case "leave": return leaveGroup(db, g, openid);
      case "privacy": return setPrivacy(db, g, openid, body);
      case "free": return commonFree(g, openid, q.days, ud, SLOT_TIMES);
      case "matrix": return busyMatrix(g, openid, q.week, ud, SLOT_TIMES);
      case "check": return checkTime(g, openid, body, ud, SLOT_TIMES);
      case "settle": return settle(db, g, openid, body);
      case "respond": return respond(db, g, openid, body);
      case "pending": return pendingSettles(g, openid);
    }
  }
  throw new Error(`没有这个接口：${method} ${path}`);
}

module.exports = { handleGroupsRoute };
