<template>
  <view class="page">
    <!-- 手动添加日程（v2：纯单机版，语音/AI 预填已随 v1 冻结） -->
    <view class="card">
      <view class="card-title-row">
        <text class="card-title">{{ editingId ? "编辑日程" : "添加日程" }}</text>
        <text v-if="editingId" class="cancel-edit" @click="cancelEdit">× 放弃修改</text>
      </view>
      <view v-if="editingId && editingSeries > 1" class="series-edit-tip">
        🔁 这是重复日程中的一条（共 {{ editingSeries }} 条），只改这一条
      </view>
      <view class="form-row">
        <text class="label">标题</text>
        <input v-model="draft.title" placeholder="要干什么，必填" />
      </view>
      <view class="form-row">
        <text class="label">地点</text>
        <input v-model="draft.loc" placeholder="可选，如 教三-301" />
      </view>
      <view class="form-row">
        <text class="label">备注</text>
        <input v-model="draft.note" placeholder="补充细节，可不填" />
      </view>
      <view class="form-row">
        <text class="label">开始</text>
        <view class="val pick-val">
          <text>{{ shortDate(draft.sd) }}</text>
          <text class="caret">▾</text>
          <picker class="cover" mode="date" :value="draft.sd" @change="(e) => (draft.sd = e.detail.value)"></picker>
        </view>
        <view class="val pick-val">
          <text>{{ draft.st }}</text>
          <text class="caret">▾</text>
          <picker class="cover" mode="time" :value="draft.st" @change="(e) => (draft.st = e.detail.value)"></picker>
        </view>
      </view>
      <view class="form-row">
        <text class="label">结束</text>
        <view v-if="draft.repeat === 'none'" class="val pick-val">
          <text>{{ shortDate(draft.ed) }}</text>
          <text class="caret">▾</text>
          <picker class="cover" mode="date" :value="draft.ed" @change="(e) => (draft.ed = e.detail.value)"></picker>
        </view>
        <view class="val pick-val">
          <text>{{ draft.et }}</text>
          <text class="caret">▾</text>
          <picker class="cover" mode="time" :value="draft.et" @change="(e) => (draft.et = e.detail.value)"></picker>
        </view>
      </view>
      <view v-if="!editingId" class="form-row">
        <text class="label">重复</text>
        <view class="rep-chips">
          <text class="chip" :class="{ on: draft.repeat === 'none' }" @click="draft.repeat = 'none'">不重复</text>
          <text class="chip" :class="{ on: draft.repeat === 'daily' }" @click="setRepeat('daily')">每天</text>
          <text class="chip" :class="{ on: draft.repeat === 'weekly' }" @click="setRepeat('weekly')">每周</text>
        </view>
      </view>
      <view v-if="!editingId && draft.repeat === 'weekly'" class="chips">
        <text class="label">哪天</text>
        <text
          v-for="(w, i) in ['一', '二', '三', '四', '五', '六', '日']"
          :key="i"
          class="chip"
          :class="{ on: draft.rdays.includes(i + 1) }"
          @click="toggleRDay(i + 1)"
        >{{ w }}</text>
      </view>
      <view v-if="!editingId && draft.repeat !== 'none'" class="form-row">
        <text class="label">重复到</text>
        <view class="val pick-val">
          <text>{{ shortDate(draft.red) }}</text>
          <text class="caret">▾</text>
          <picker class="cover" mode="date" :value="draft.red" @change="(e) => (draft.red = e.detail.value)"></picker>
        </view>
      </view>
      <view v-if="clash" class="clash-hint">
        ⚠️ 与{{ clashText }}时间重叠<text class="clash-sub">（可保存，冲突会列在主页供改/删）</text>
      </view>
      <view v-if="draft.repeat !== 'none'" class="rep-note">
        🔁 每次时长 = 开始→结束时刻（<text class="rep-cross">结束早于开始 = 跨到次日</text>，如 23:00→02:00），一直排到「重复到」{{ repeatCountText }}
      </view>
      <view class="chips">
        <text class="chip" @click="shiftDay(1)">明天</text>
        <text class="chip" @click="shiftDay(2)">后天</text>
        <text class="chip" @click="extendEnd(30)">+30分钟</text>
        <text class="chip" @click="extendEnd(60)">+1小时</text>
        <text class="chip" @click="extendEnd(1440)">+1天</text>
      </view>
      <view class="chips icon-chips">
        <text class="label">图标</text>
        <text
          v-for="(ic, i) in eventIcons"
          :key="i"
          class="icon-pick"
          :class="{ on: (draft.icon || defaultIcon) === ic }"
          @click="draft.icon = ic"
        >{{ ic }}</text>
      </view>
      <view class="chips icon-chips">
        <text class="label">时间</text>
        <text
          v-for="ts in timeStatuses"
          :key="ts.key"
          class="icon-pick ts-pick"
          :class="{ on: (draft.timeStatus || 'exact') === ts.key }"
          @click="draft.timeStatus = ts.key"
        >{{ ts.label }}</text>
      </view>
      <view class="chips color-chips">
        <text class="label">颜色</text>
        <view
          v-for="(c, i) in colors"
          :key="i"
          class="dot"
          :class="{ on: i === draft.colorIdx }"
          :style="{ background: c.bd }"
          @click="draft.colorIdx = i"
        ></view>
      </view>
      <view v-if="editingId" class="sheet-btns">
        <button class="btn-plain" @click="delEvent(editingId)">删除</button>
        <button class="btn-primary" :disabled="busy" @click="save">
          {{ busy ? "保存中…" : "保存修改" }}
        </button>
      </view>
      <button v-else class="btn-primary" :disabled="busy" @click="save">
        {{ busy ? "保存中…" : saveBtnText }}
      </button>
    </view>

    <!-- 已有日程：点一条载入上方表单修改 -->
    <view class="card" v-if="events.length">
      <view class="card-title">我的日程（{{ events.length }}）</view>
      <view v-for="ev in events" :key="ev.id" class="ev-row" :class="{ editing: editingId === ev.id }" @click="startEdit(ev)">
        <view class="ev-info">
          <text class="ev-title">{{ ev.icon || defaultIcon }} {{ ev.title }}<text v-if="ev.series_id" class="series-tag"> 🔁×{{ seriesCount[ev.series_id] || 1 }}</text></text>
          <text class="ev-time">{{ evTimeText(ev) }}</text>
        </view>
        <text class="ev-del" @click.stop="delEvent(ev.id)">删除</text>
      </view>
    </view>
  </view>
</template>

<script>
import { api } from "../../utils/api";
import { DEFAULT_EVENT_ICON, EVENT_ICONS, TIME_STATUS } from "../../utils/slots";

// 颜色与日程块配色一致（和 index 页 evColors 同源，此处只取描边色）
const COLORS = ["#f59e0b", "#db2777", "#0284c7", "#059669", "#9333ea", "#94a3b8"];

function pad(n) {
  return n < 10 ? "0" + n : "" + n;
}
function dateOffset(days, time) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const t = time || `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return {
    d: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    t: t,
  };
}
function isoToLocal(s) {
  // "2026-11-08T15:30:00" → { d: "2026-11-08", t: "15:30" }
  const [d, t = "09:00"] = String(s).replace("T", " ").split(" ");
  return { d, t: t.slice(0, 5) };
}
// 跨浏览器稳的本地时间构造："2026/11/08 18:30:00"（iOS WKWebView/微信 X5 不认 "2026/11/08T18:30"）
function toDate(dStr, tStr) {
  const d = dStr.replace(/-/g, "/");
  return new Date(tStr ? `${d} ${tStr}:00` : d);
}
function fmtDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function fmtTime(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default {
  data() {
    const now = dateOffset(0);
    const end = new Date();
    end.setMinutes(end.getMinutes() + 60);
    return {
      draft: {
        title: "",
        note: "",
        loc: "",
        icon: "",
        timeStatus: "exact",
        colorIdx: 0,
        sd: now.d,
        st: now.t,
        ed: now.d,
        et: `${pad(end.getHours())}:${pad(end.getMinutes())}`,
        repeat: "none", // none | daily | weekly
        rdays: [],      // weekly 有效：1=周一…7=周日
        red: "",        // 重复截止日期
      },
      events: [],
      busy: false,
      editingId: null,     // 非空 = 正在编辑这条日程（点列表载入）
      editingSeries: 0,    // 编辑中日程的重复组条数（>1 显示"只改这一条"提示）
      eventIcons: EVENT_ICONS,
      defaultIcon: DEFAULT_EVENT_ICON,
      timeStatuses: TIME_STATUS,
      colors: COLORS.map((bd) => ({ bd })),
      clash: null,   // 输入时的实时冲突提示（只提示不阻断）
      _clashT: null,
    };
  },
  onLoad(opts) {
    // 主页「我的日程」/ 冲突处理跳转过来：?edit=<id> 自动载入该条进编辑
    this._pendingEdit = opts && opts.edit ? String(opts.edit) : "";
  },
  async onShow() {
    await this.loadEvents();
    if (this._pendingEdit) {
      const ev = this.events.find((e) => String(e.id) === this._pendingEdit);
      this._pendingEdit = "";
      if (ev) this.startEdit(ev);
    }
    this.checkClash();
  },
  watch: {
    // 时间一改就查冲突，400ms 防抖，提示不打断输入
    "draft.sd": "_clashTick",
    "draft.st": "_clashTick",
    "draft.ed": "_clashTick",
    "draft.et": "_clashTick",
    "draft.timeStatus": "_clashTick",
  },
  computed: {
    // 重复组 id → 条数（日程列表 🔁×N 用）
    seriesCount() {
      const m = {};
      for (const e of this.events || []) {
        if (e.series_id) m[e.series_id] = (m[e.series_id] || 0) + 1;
      }
      return m;
    },
    repeatCount() {
      if (this.draft.repeat === "none") return 0;
      const s = new Date(this.draft.sd.replace(/-/g, "/"));
      const e = new Date((this.draft.red || this.draft.sd).replace(/-/g, "/"));
      if (e < s) return 0;
      let n = 0;
      for (let d = new Date(s); d <= e && n < 200; d.setDate(d.getDate() + 1)) {
        if (this.draft.repeat === "daily" || this.draft.rdays.includes(d.getDay() || 7)) n++;
      }
      return n;
    },
    repeatCountText() {
      const n = this.repeatCount;
      return n > 0 ? `，共 ${n} 次` : "";
    },
    saveBtnText() {
      if (this.draft.repeat === "none") return "保存日程";
      const n = this.repeatCount;
      return n > 0 ? `保存日程（共 ${n} 次）` : "保存日程";
    },
    clashText() {
      if (!this.clash) return "";
      const parts = [];
      if (this.clash.courses?.length)
        parts.push("课程" + this.clash.courses.slice(0, 2).map((c) => `《${c.name}》${c.slots_text}`).join("、"));
      if (this.clash.events?.length)
        parts.push("日程" + this.clash.events.slice(0, 2).map((e) => `《${e.title}》`).join("、"));
      return parts.join("、");
    },
  },
  methods: {
    _clashTick() {
      clearTimeout(this._clashT);
      this._clashT = setTimeout(() => this.checkClash(), 400);
    },
    // 时间冲突实时检测：大概/待定时间不查；仅开始按预估结束查
    async checkClash() {
      const d = this.draft;
      if ((d.timeStatus || "exact") === "fuzzy" || d.timeStatus === "todo") {
        this.clash = null;
        return;
      }
      const start_at = `${d.sd} ${d.st}:00`;
      const end_at = `${d.repeat !== "none" ? d.sd : d.ed} ${d.et}:00`;
      if (!d.sd || !d.st || !d.et || end_at <= start_at) {
        this.clash = null;
        return;
      }
      try {
        const r = await api.post("/api/events/conflict", {
          start_at, end_at, time_status: d.timeStatus,
          // 编辑已有日程时排除它自己，否则必然"与自己冲突"
          exclude_event_id: this.editingId || undefined });
        const has = (r.courses?.length || 0) + (r.events?.length || 0);
        this.clash = has ? r : null;
      } catch (e) {
        this.clash = null; // 检测失败不挡输入
      }
    },
    shiftDay(days) {
      // 整体平移一天；当天若开始时间已过则变成明天这点
      const s = dateOffset(days, this.draft.st);
      const en = toDate(this.draft.ed, this.draft.et);
      en.setDate(en.getDate() + days);
      this.draft.sd = s.d;
      this.draft.st = s.t;
      this.draft.ed = this.draft.repeat !== "none" ? s.d : fmtDate(en);
      this.draft.et = fmtTime(en);
    },
    extendEnd(minutes) {
      // 重复模式下只动结束时刻（日期恒跟开始日），支持跨天时长
      const base = this.draft.repeat !== "none" ? this.draft.sd : this.draft.ed;
      const end = toDate(base, this.draft.et);
      end.setMinutes(end.getMinutes() + minutes);
      this.draft.ed = fmtDate(end);
      this.draft.et = fmtTime(end);
      if (this.draft.repeat !== "none") this.draft.ed = this.draft.sd;
    },
    setRepeat(r) {
      this.draft.repeat = r;
      if (r !== "none") this.draft.ed = this.draft.sd; // 重复日程只看时刻，日期恒跟开始日
      // 默认重复两周；每周默认选上开始那天
      if (!this.draft.red) {
        const dft = new Date(this.draft.sd.replace(/-/g, "/"));
        dft.setDate(dft.getDate() + 13);
        this.draft.red = `${dft.getFullYear()}-${pad(dft.getMonth() + 1)}-${pad(dft.getDate())}`;
      }
      if (r === "weekly" && !this.draft.rdays.length) {
        this.draft.rdays = [new Date(this.draft.sd.replace(/-/g, "/")).getDay() || 7];
      }
    },
    toggleRDay(d) {
      const i = this.draft.rdays.indexOf(d);
      if (i >= 0) this.draft.rdays.splice(i, 1);
      else this.draft.rdays.push(d);
      this.draft.rdays.sort();
    },
    // 点列表里的日程 → 载入表单编辑（改的是这一条；重复组只动单条）
    startEdit(ev) {
      this.editingId = ev.id;
      this.editingSeries = ev.series_id ? this.seriesCount[ev.series_id] || 1 : 0;
      this.draft = {
        title: ev.title,
        note: ev.note || "",
        loc: ev.location || "",
        icon: ev.icon || "",
        timeStatus: ev.time_status || "exact",
        colorIdx: (ev.color_idx || 0) % this.colors.length,
        sd: String(ev.start_at).slice(0, 10),
        st: String(ev.start_at).slice(11, 16),
        ed: String(ev.end_at).slice(0, 10),
        et: String(ev.end_at).slice(11, 16),
        repeat: "none",
        rdays: [],
        red: "",
      };
      this.clash = null;
      uni.pageScrollTo({ scrollTop: 0, duration: 200 });
    },
    cancelEdit() {
      this.editingId = null;
      this.editingSeries = 0;
      this.resetDraft();
    },
    resetDraft() {
      const now = dateOffset(0);
      const end = new Date();
      end.setMinutes(end.getMinutes() + 60);
      this.draft = {
        title: "", note: "", loc: "", icon: "", timeStatus: "exact", colorIdx: 0,
        sd: now.d, st: now.t, ed: now.d,
        et: `${pad(end.getHours())}:${pad(end.getMinutes())}`,
        repeat: "none", rdays: [], red: "",
      };
      this.clash = null;
    },
    async save() {
      const { title, note, loc, icon, timeStatus, sd, st, ed, et, colorIdx, repeat, rdays, red } = this.draft;
      if (!title.trim()) {
        uni.showToast({ title: "给日程起个名", icon: "none" });
        return;
      }
      const recurring = repeat !== "none";
      if (recurring) {
        if (repeat === "weekly" && !rdays.length) {
          uni.showToast({ title: "每周重复要先选星期", icon: "none" });
          return;
        }
        if (!red || red < sd) {
          uni.showToast({ title: "「重复到」不能早于开始日期", icon: "none" });
          return;
        }
        // 时长：结束早于开始 = 跨到次日（23:00→02:00），须在 15 分钟 ~ 24 小时
        const hm = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
        let durMin = hm(et) - hm(st);
        if (durMin <= 0) durMin += 1440;
        if (durMin < 15 || durMin >= 1440) {
          uni.showToast({ title: "单次时长要在 15 分钟~24 小时（结束早于开始=跨到次日）", icon: "none" });
          return;
        }
      } else {
        const start_at = `${sd} ${st}:00`;
        const end_at = `${ed} ${et}:00`;
        if (end_at <= start_at) {
          uni.showToast({ title: "结束要晚于开始", icon: "none" });
          return;
        }
      }
      this.busy = true;
      try {
        // 冲突已在输入时实时提示（clash），这里不再弹窗；保存后冲突会在主页集中列出
        // 编辑已有日程：只更新这一条的字段（重复属性不参与修改）
        if (this.editingId) {
          const start_at = `${sd} ${st}:00`;
          const end_at = `${ed} ${et}:00`;
          await api.put("/api/events/" + this.editingId, {
            title: title.trim(),
            note: note.trim(),
            location: (loc || "").trim(),
            icon: icon || "",
            time_status: timeStatus || "exact",
            color_idx: colorIdx,
            start_at,
            end_at,
          });
          uni.showToast({ title: this.clash ? "已更新，冲突见主页 ⚠️" : "已更新 ✓", icon: "success" });
          this.cancelEdit();
          this.loadEvents();
          return;
        }
        const start_at = `${sd} ${st}:00`;
        const end_at = recurring ? `${sd} ${et}:00` : `${ed} ${et}:00`;
        if (recurring) {
          await api.post("/api/events/recurring", {
            title: title.trim(),
            note: note.trim(),
            location: (loc || "").trim(),
            icon: icon || "",
            color_idx: colorIdx,
            start_time: st,
            end_time: et,
            repeat,
            days: repeat === "weekly" ? rdays : [],
            start_date: sd,
            end_date: red,
            time_status: timeStatus || "exact",
          });
          uni.showToast({
            title: this.clash ? `已排 ${this.repeatCount} 次，冲突见主页 ⚠️` : `已排 ${this.repeatCount} 次 ✓`,
            icon: "success",
          });
        } else {
          await api.post("/api/events", {
            title: title.trim(),
            note: note.trim(),
            location: (loc || "").trim(),
            icon: icon || "",
            time_status: timeStatus || "exact",
            color_idx: colorIdx,
            start_at,
            end_at,
            type: "temp",
            source: "text",
          });
          uni.showToast({
            title: this.clash ? "已记下，冲突见主页 ⚠️" : "已记下 ✓",
            icon: "success",
          });
        }
        this.draft.title = "";
        this.draft.note = "";
        this.draft.loc = "";
        this.loadEvents();
      } catch (e) {
        uni.showToast({ title: e.message, icon: "none" });
      } finally {
        this.busy = false;
      }
    },
    async loadEvents() {
      try {
        this.events = await api.get("/api/events");
      } catch (e) {
        /* 静默 */
      }
    },
    async delEvent(id) {
      const afterDel = () => {
        if (this.editingId === id) this.cancelEdit();
        this.loadEvents();
      };
      const ev = this.events.find((e) => e.id === id);
      if (ev && ev.series_id) {
        const n = this.seriesCount[ev.series_id] || 1;
        uni.showActionSheet({
          itemList: ["只删这一条", `删除整组（${n} 条）`],
          success: async (r) => {
            try {
              if (r.tapIndex === 0) await api.del("/api/events/" + id);
              else if (r.tapIndex === 1) {
                await api.del("/api/events/series/" + ev.series_id);
                uni.showToast({ title: `已删整组 ${n} 条`, icon: "none" });
              } else return;
              afterDel();
            } catch (e) {
              uni.showToast({ title: e.message, icon: "none" });
            }
          },
        });
        return;
      }
      await api.del("/api/events/" + id);
      afterDel();
    },
    shortDate(d) {
      const l = isoToLocal(d + "T00:00:00");
      return l.d.slice(5).replace("-", "/");
    },
    short(s) {
      const l = isoToLocal(s);
      return `${l.d.slice(5)} ${l.t}`;
    },
    // 日程列表时间文案：按时间确定度标注（仅开始→"起"，大概→"约"，待定→"??"）
    evTimeText(ev) {
      const st = ev.time_status || "exact";
      const loc = ev.location ? ` · ${ev.location}` : "";
      if (st === "todo") return `❓ 时间待定${loc}`;
      if (st === "start_only") return `${this.short(ev.start_at)} 起${loc}`;
      if (st === "fuzzy") return `⏰ 约 ${this.short(ev.start_at)} ~ ${this.short(ev.end_at)}${loc}`;
      return `${this.short(ev.start_at)} ~ ${this.short(ev.end_at)}${loc}`;
    },
  },
};
</script>

<style scoped>
.page {
  padding: 24rpx;
  padding-bottom: 60rpx;
  max-width: 950px;  /* 电脑端居中限宽，手机不受影响 */
  margin: 0 auto;
  box-sizing: border-box;
}
.card {
  background: #fff;
  border-radius: 16rpx;
  padding: 28rpx;
  margin-bottom: 24rpx;
}
.card-title {
  font-size: 30rpx;
  font-weight: 600;
  margin-bottom: 20rpx;
  display: flex;
  align-items: center;
  gap: 12rpx;
}
.btn-primary {
  background: #4f46e5;
  color: #fff;
  font-size: 31rpx;
  border-radius: 14rpx;
  height: 84rpx;
  line-height: 84rpx; /* 行高=按钮高，兜底垂直居中 */
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
}
.btn-primary[disabled] {
  opacity: 0.6;
  color: #fff;
}
.btn-primary::after {
  border: none;
}
.form-row {
  display: flex;
  align-items: center;
  gap: 12rpx;
  margin-bottom: 18rpx;
}
.label {
  width: 76rpx;
  color: #6b7280;
  font-size: 26rpx;
  flex-shrink: 0;
}
.form-row input {
  flex: 1;
  font-size: 28rpx;
  min-width: 0;
}
.val {
  flex: 1;
  background: #f5f6fa;
  border-radius: 10rpx;
  padding: 12rpx 16rpx;
  font-size: 26rpx;
}
/* 手机浏览器上 picker(日期/时间) 会垫一层系统原生输入框，
   原生文字（如 2026/11/14、空时间）盖住我们写的字。
   改为：文字自己画，picker 透明铺满做点击区 */
.pick-val {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.pick-val .caret {
  color: #9ca3af;
  margin-left: 8rpx;
}
.cover {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  opacity: 0;
}
.chips {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 14rpx;
  margin-bottom: 20rpx;
}
.chip {
  font-size: 24rpx;
  color: #4f46e5;
  background: #eef2ff;
  border-radius: 999rpx;
  padding: 8rpx 22rpx;
}
.chip.on {
  color: #fff;
  background: #4f46e5;
  font-weight: 600;
}
.rep-chips { display: flex; gap: 14rpx; flex: 1; }
/* 实时冲突提示：只提示不阻断，主页集中改/删 */
.clash-hint {
  margin: 12rpx 0 4rpx;
  font-size: 24rpx;
  color: #b91c1c;
  background: #fef2f2;
  border: 2rpx solid #fecaca;
  border-radius: 10rpx;
  padding: 16rpx 18rpx;
  line-height: 1.45;
}
.clash-sub {
  color: #b91c1c;
  opacity: 0.65;
  font-size: 21rpx;
}
.rep-note {
  font-size: 22rpx;
  color: #6b7280;
  background: #f5f6fa;
  border-radius: 10rpx;
  padding: 14rpx 18rpx;
  line-height: 1.5;
}
.rep-cross { color: #b45309; font-weight: 600; }
.series-tag { font-size: 20rpx; color: #4f46e5; font-weight: 600; }
.icon-chips {
  flex-wrap: wrap;
}
.icon-chips .icon-pick {
  font-size: 30rpx;
  width: 56rpx;
  height: 56rpx;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 12rpx;
  background: #f5f6fa;
}
.icon-chips .icon-pick.ts-pick {
  width: auto;        /* 文字标签不适用 emoji 方块的固定宽 */
  min-width: 120rpx;
  padding: 0 20rpx;
  font-size: 24rpx;
  white-space: nowrap;
}
.icon-chips .icon-pick.on {
  background: #eef2ff;
  box-shadow: 0 0 0 3rpx #4f46e5 inset;
}
.color-chips {
  flex-wrap: wrap;
}
.color-chips .dot {
  width: 48rpx;
  height: 48rpx;
  flex-shrink: 0;
  border-radius: 50%;
  border: 4rpx solid transparent;
  box-sizing: border-box;
}
.color-chips .dot.on {
  border-color: #1f2937;
}
.card-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.cancel-edit {
  font-size: 24rpx;
  color: #6b7280;
  padding: 6rpx 12rpx;
}
.series-edit-tip {
  background: #fff7ed;
  color: #b45309;
  font-size: 22rpx;
  border-radius: 10rpx;
  padding: 10rpx 16rpx;
  margin-bottom: 16rpx;
}
.sheet-btns {
  display: flex;
  gap: 16rpx;
}
.btn-plain {
  flex: 1;
  background: #f1f2f6;
  color: #4b5563;
  font-size: 31rpx;
  border-radius: 14rpx;
  height: 84rpx;
  line-height: 84rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
}
.btn-plain::after {
  border: none;
}
.sheet-btns .btn-primary {
  flex: 2;
}
.ev-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16rpx 0;
  border-bottom: 1rpx solid #f1f2f6;
}
.ev-row:last-child {
  border-bottom: none;
}
.ev-row.editing {
  background: #eef2ff;
  border-radius: 10rpx;
  padding-left: 12rpx;
  padding-right: 12rpx;
}
.ev-info {
  display: flex;
  flex-direction: column;
  gap: 4rpx;
  flex: 1;
  min-width: 0; /* 长标题/时间不被右侧按钮挤到裁字 */
}
.ev-title {
  font-size: 28rpx;
  font-weight: 500;
}
.ev-time {
  font-size: 22rpx;
  color: #8a91a3;
}
.ev-del {
  color: #b0b5c1;
  font-size: 24rpx;
  flex-shrink: 0;
  margin-left: 12rpx;
  padding: 6rpx 10rpx;
}
</style>
