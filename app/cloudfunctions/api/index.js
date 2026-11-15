// 云函数 api：小程序线的全部后端。
// 数据模型：collection userData 每用户（OPENID）一个文档，store 字段存整份
// {db_term, db_courses, db_events, db_ddls, db_profile, db_seq} —— 与单机版
// uni storage 的键完全一致，跑的是同一份 db-core 逻辑（sync-cf.mjs 同步生成）。
// 个人规模下全量读写一个 <100KB 的 JSON 文档，性能与一致性都够用。
const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV }); // 跟随函数部署的环境
const db = cloud.database();
const COL = "userData";

// db-core.cjs.js 由 scripts/sync-cf.mjs 从 src/utils/db-core.js + slots.js 生成
const { bindStorage, localRequest, SLOT_TIMES } = require("./db-core.cjs");
const { handleGroupsRoute } = require("./groups");

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const method = event.method || "GET";
  const path = event.path || "";
  const body = event.body || {};

  // 首次调用时确保集合存在（已存在会抛错，忽略）
  for (const col of [COL, "groups"]) {
    try { await db.createCollection(col); } catch (e) { /* 已存在 */ }
  }

  // 读用户文档 → 内存 KV → 跑路由
  let doc = null;
  try {
    const found = await db.collection(COL).where({ _openid: OPENID }).limit(1).get();
    doc = (found.data && found.data[0]) || null;
  } catch (e) { /* 读失败按空数据继续，返回层会带错误 */ }
  const store = doc && doc.store ? { ...doc.store } : {};
  bindStorage({
    get: (k) => store[k],
    set: (k, v) => { store[k] = v; },
  });

  // 组队（拼时间）：跨用户共享数据，走 groups 集合，不进个人 KV
  if (path.startsWith("/api/groups")) {
    const loadUserData = async (openid) => {
      try {
        const f = await db.collection(COL).where({ _openid: openid }).limit(1).get();
        const st = (f.data && f.data[0] && f.data[0].store) || {};
        return {
          term: st.db_term || null,
          courses: st.db_courses || [],
          events: st.db_events || [],
          ddls: st.db_ddls || [],
        };
      } catch (e) {
        return { term: null, courses: [], events: [], ddls: [] };
      }
    };
    try {
      const out = await handleGroupsRoute(method, path, body, {
        db, openid: OPENID, loadUserData, SLOT_TIMES,
      });
      if (out !== null) {
        // 定档全员确认 → 写回各成员个人日程（batch.written 防重复写：
        // 改口撤销后再全员确认不会重复生成事件）
        if (out.settled && /\/api\/groups\/[^/]+\/respond$/.test(path)) {
          try {
            await writeSettledToCalendars(db, path.split("/")[3], String(body.batch || ""));
          } catch (e) { /* 写回失败不影响确认结果 */ }
        }
        return { ok: true, data: out };
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  let ok = true;
  let out;
  try {
    out = await localRequest(method, path, body);
  } catch (e) {
    ok = false;
    out = e instanceof Error ? e.message : String(e);
  }

  // 写回（整份 store 落库；失败不影响本次结果，下次调用重放）
  try {
    if (doc) {
      await db.collection(COL).doc(doc._id).update({ data: { store, updated_at: Date.now() } });
    } else {
      await db.collection(COL).add({ data: { _openid: OPENID, store, updated_at: Date.now() } });
    }
  } catch (e) { /* 静默：个人规模下可接受 */ }

  return ok ? { ok: true, data: out } : { ok: false, error: out };
};

// 定档写回：给批次的每个成员日程里加一条 👥 事件（云函数有管理员权限，
// 可直写他人的 userData 文档；分钟→HH:MM，1440 封顶 23:59）
async function writeSettledToCalendars(db, code, batchKey) {
  const g = await db.collection("groups").where({ code }).limit(1).get();
  const gdoc = g.data && g.data[0];
  const b = gdoc && gdoc.settle && gdoc.settle.batches && gdoc.settle.batches[batchKey];
  if (!b || b.written) return;
  const hhmm = (min) => {
    const m = Math.min(min, 1439);
    return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00`;
  };
  const startAt = `${b.day} ${hhmm(b.start_min)}`;
  const endAt = `${b.day} ${hhmm(b.end_min)}`;
  const col = db.collection(COL);
  for (const openid of b.members || []) {
    const f = await col.where({ _openid: openid }).limit(1).get();
    const ud = f.data && f.data[0];
    if (!ud) continue; // 没用过 App 的成员跳过
    const store = { ...(ud.store || {}) };
    const events = store.db_events || [];
    const seq = (store.db_seq || 0) + 1;
    events.push({
      id: seq,
      title: b.title,
      note: "拼时间定档",
      location: "",
      icon: "👥",
      color_idx: 0,
      time_status: "exact",
      type: "group",
      source: "group",
      status: "ok",
      start_at: startAt,
      end_at: endAt,
      series_id: null,
    });
    store.db_events = events;
    store.db_seq = seq;
    await col.doc(ud._id).update({ data: { store, updated_at: Date.now() } });
  }
  // 批次标记已写（整 settle 字段写回，不依赖 SDK 的点路径更新语义）
  gdoc.settle.batches[batchKey].written = true;
  await db.collection("groups").doc(gdoc._id).update({ data: { settle: gdoc.settle } });
}
