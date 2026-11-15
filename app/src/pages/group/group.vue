<template>
  <view class="page">
    <!-- ===== 无口令：我的群组 + 建组/进组 ===== -->
    <block v-if="!code">
      <view class="card">
        <view class="card-title">🔑 建个组</view>
        <input class="inp" v-model="form.name" placeholder="组名，如：数模竞赛队" />
        <input class="inp" v-model="form.nickname" placeholder="你的昵称（组员看到的名字）" />
        <view class="btn primary" @click="createGroup">创建小组 · 生成进组口令</view>
      </view>
      <view class="card">
        <view class="card-title">🚪 口令进组</view>
        <input class="inp" v-model="joinCode" placeholder="输入 4-6 位进组口令" />
        <input class="inp" v-model="joinNick" placeholder="你的昵称" />
        <view class="btn" @click="joinGroup">加入小组</view>
      </view>
      <view class="card">
        <view class="card-title">👥 我的群组（{{ groups.length }}）</view>
        <view v-if="!groups.length" class="empty-tip">还没有组 · 创建或输入口令加入</view>
        <view v-for="g in groups" :key="g.code" class="grp-row" @click="openGroup(g.code)">
          <text class="grp-icon">👥</text>
          <view class="grp-mid">
            <text class="grp-name">{{ g.name }}</text>
            <text class="grp-sub">{{ g.members.length }} 人 · 口令 {{ g.code }}</text>
          </view>
          <text class="grp-go">›</text>
        </view>
      </view>
    </block>

    <!-- ===== 有口令：组详情 ===== -->
    <block v-else>
      <view class="card">
        <view class="grp-head">
          <view class="grp-mid">
            <text class="grp-name big">{{ group.name || "加载中…" }}</text>
            <text class="grp-sub" @click="copyCode">进组口令 {{ code }} · 点我复制</text>
          </view>
          <text class="leave" @click="leaveGroup">退出</text>
        </view>
        <view class="mem-line">
          <text v-for="m in group.members" :key="m.user_code" class="mem-chip">{{ m.nickname }}{{ m.is_me ? "（我）" : "" }}</text>
        </view>
        <view class="priv-row">
          <text class="priv-text">🔓 向组员开放我的日程细节（默认只显示忙/闲）</text>
          <switch :checked="group.my_share_detail" color="#4F46E5" @change="togglePrivacy" />
        </view>
      </view>

      <!-- 待确认定档 -->
      <view class="card" v-if="pending.length">
        <view class="card-title">📩 待确认（{{ pending.length }}）</view>
        <view v-for="p in pending" :key="p.batch" class="pend-row">
          <view class="grp-mid">
            <text class="grp-name">{{ p.title }}</text>
            <text class="grp-sub">{{ fmtDay(p.start_at) }} {{ fmtClock(p.start_at) }}-{{ fmtClock(p.end_at) }}</text>
          </view>
          <view class="pend-acts">
            <text class="pend-btn ok" @click="respond(p, true)">✓ 有空</text>
            <text class="pend-btn no" @click="respond(p, false)">✗ 冲突</text>
          </view>
        </view>
      </view>

      <!-- FR-42 共同空闲 Top3 -->
      <view class="card">
        <view class="card-title">🎯 共同空闲 Top3 <text class="card-sub">未来 7 天 · 全员都有空</text></view>
        <view v-if="!freeSlots.length" class="empty-tip">找不到全员空闲的整段，试试下面自定义查</view>
        <view v-for="(s, i) in freeSlots" :key="s.date + s.start_min" class="slot-row">
          <view class="slot-badge" :class="'top' + (i + 1)">{{ i + 1 }}</view>
          <view class="grp-mid">
            <text class="grp-name">{{ fmtDay(s.date) }} {{ fmtMin(s.start_min) }}-{{ fmtMin(s.end_min) }}</text>
            <text class="grp-sub">{{ s.members.map((m) => m.nickname).join(" · ") }} 都有空</text>
          </view>
          <text class="settle-btn" @click="quickSettle(s)">定档</text>
        </view>
      </view>

      <!-- 本周/下周 组员空闲一览表 -->
      <view class="card">
        <view class="card-title">
          📅 组员空闲一览
          <view class="wk-seg">
            <text :class="{ on: weekOff === 0 }" @click="setWeek(0)">本周</text>
            <text :class="{ on: weekOff === 1 }" @click="setWeek(1)">下周</text>
            <text :class="{ on: weekOff === 2 }" @click="setWeek(2)">第3周</text>
            <text :class="{ on: weekOff === 3 }" @click="setWeek(3)">第4周</text>
          </view>
        </view>
        <view class="mx">
          <view class="mx-row mx-head">
            <text class="mx-time"></text>
            <text v-for="(d, i) in mxDays" :key="d" class="mx-day" :class="{ today: d === todayStr }">{{ mxDayLabels[i] }}</text>
          </view>
          <scroll-view scroll-y class="mx-body">
            <view v-for="(lo, si) in mxSlots" :key="lo" class="mx-row">
              <text class="mx-time">{{ si % 2 === 0 ? fmtMin(lo) : "" }}</text>
              <view v-for="(d, di) in mxDays" :key="d" class="mx-cell" :class="cellClass(di, si)" @click="tapCell(di, si)">
                <text v-if="cellClass(di, si) === 'some'" class="mx-n">{{ freeCount(di, si) }}</text>
              </view>
            </view>
          </scroll-view>
        </view>
        <view class="mx-legend">🟩 全空闲 · 🟨 可能有事 · 灰 全忙 · 数字 = 空闲人数 · 点格子看每人</view>
        <view v-if="cellDetail.length" class="check-list">
          <view class="mx-detail-head">{{ cellDetailTitle }}</view>
          <view v-for="m in cellDetail" :key="m.nickname" class="check-row">
            <text class="check-dot" :class="m.status"></text>
            <text class="check-nick">{{ m.nickname }}{{ m.is_me ? "（我）" : "" }}</text>
            <text class="check-status" :class="m.status">{{ statusText(m.status) }}</text>
            <text v-if="m.details && m.details.length" class="check-detail">{{ m.details.join("；") }}</text>
          </view>
        </view>
      </view>

      <!-- FR-43 指定时间查忙闲 -->
      <view class="card">
        <view class="card-title">🔍 指定时间查忙闲</view>
        <view class="pick-row">
          <picker :range="dayOpts" :value="dayIdx" @change="dayIdx = $event.detail.value">
            <view class="pick-chip">{{ dayOpts[dayIdx] }}</view>
          </picker>
          <picker :range="timeOpts" :value="loIdx" @change="loIdx = $event.detail.value">
            <view class="pick-chip">{{ timeOpts[loIdx] }}</view>
          </picker>
          <text class="pick-to">至</text>
          <picker :range="timeOpts" :value="hiIdx" @change="hiIdx = $event.detail.value">
            <view class="pick-chip">{{ timeOpts[hiIdx] }}</view>
          </picker>
        </view>
        <view class="btn" @click="checkTime">查询全员状态</view>
        <view v-if="checkResult.length" class="check-list">
          <view v-for="m in checkResult" :key="m.nickname" class="check-row">
            <text class="check-dot" :class="m.status"></text>
            <text class="check-nick">{{ m.nickname }}{{ m.is_me ? "（我）" : "" }}</text>
            <text class="check-status" :class="m.status">{{ statusText(m.status) }}</text>
            <text v-if="m.details.length" class="check-detail">{{ m.details.join("；") }}</text>
          </view>
        </view>
      </view>

      <!-- FR-44 定档 -->
      <view class="card">
        <view class="card-title">📌 共同定档</view>
        <input class="inp" v-model="settleTitle" placeholder="活动名，如：组会 / 打球" />
        <view class="pick-row">
          <picker :range="dayOpts" :value="sDayIdx" @change="sDayIdx = $event.detail.value">
            <view class="pick-chip">{{ dayOpts[sDayIdx] }}</view>
          </picker>
          <picker :range="timeOpts" :value="sLoIdx" @change="sLoIdx = $event.detail.value">
            <view class="pick-chip">{{ timeOpts[sLoIdx] }}</view>
          </picker>
          <text class="pick-to">至</text>
          <picker :range="timeOpts" :value="sHiIdx" @change="sHiIdx = $event.detail.value">
            <view class="pick-chip">{{ timeOpts[sHiIdx] }}</view>
          </picker>
        </view>
        <view class="btn primary" @click="settle">发出定档 · 等全员确认</view>
        <view class="hint">确认后才会写进每个人的日程；有人标冲突则批次作废</view>
      </view>
    </block>
  </view>
</template>

<script>
import { api } from "../../utils/api";

const DAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function fmtD(d) {
  return `${d.getMonth() + 1}/${d.getDate()} ${DAY_NAMES[d.getDay()]}`;
}
function pad(n) {
  return n < 10 ? "0" + n : "" + n;
}

export default {
  data() {
    // 未来 28 天选项
    const days = [];
    const dayVals = [];
    for (let i = 0; i < 28; i++) {
      const d = new Date(Date.now() + i * 86400000);
      days.push(fmtD(d));
      dayVals.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
    }
    // 30 分钟粒度 08:00-23:00
    const times = [];
    const timeVals = [];
    for (let m = 8 * 60; m <= 23 * 60; m += 30) {
      times.push(`${pad(m / 60 | 0)}:${pad(m % 60)}`);
      timeVals.push(m);
    }
    return {
      code: "",
      groups: [],
      group: { members: [], my_share_detail: false, is_creator: false, name: "" },
      form: { name: "", nickname: "" },
      joinCode: "",
      joinNick: "",
      freeSlots: [],
      pending: [],
      dayOpts: days,
      dayVals,
      dayIdx: 0,
      loIdx: 8, // 12:00
      hiIdx: 10, // 13:00
      timeOpts: times,
      timeVals,
      checkResult: [],
      settleTitle: "",
      sDayIdx: 0,
      sLoIdx: 16, // 16:00
      sHiIdx: 18, // 17:00
      weekOff: 0,
      mxDays: [],
      mxDayLabels: [],
      mxSlots: [],
      mxMembers: [],
      mxGrid: [],
      cellDetail: [],
      cellDetailTitle: "",
    };
  },
  computed: {
    todayStr() {
      const d = new Date();
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    },
  },
  onLoad(q) {
    this.code = (q && q.code) || "";
    if (this.code) this.loadDetail();
    else this.loadMine();
  },
  onShow() {
    if (this.code) this.loadDetail();
  },
  methods: {
    async loadMine() {
      try {
        const r = await api.get("/api/groups");
        this.groups = r.groups || [];
      } catch (e) {
        uni.showToast({ title: e.message, icon: "none" });
      }
    },
    openGroup(code) {
      this.code = code;
      this.loadDetail();
      uni.setNavigationBarTitle({ title: "小组" });
    },
    async loadDetail() {
      try {
        const [mine, f, p] = await Promise.all([
          api.get("/api/groups"),
          api.get(`/api/groups/${this.code}/free`),
          api.get(`/api/groups/${this.code}/pending`),
        ]);
        this.group =
          (mine.groups || []).find((x) => x.code === this.code) || this.group;
        this.freeSlots = f.slots || [];
        this.pending = p.pending || [];
        this.loadMatrix();
      } catch (e) {
        uni.showToast({ title: e.message, icon: "none" });
      }
    },
    async loadMatrix() {
      try {
        const r = await api.get(`/api/groups/${this.code}/matrix?week=${this.weekOff}`);
        this.mxDays = r.days || [];
        this.mxDayLabels = (r.days || []).map((d) => {
          const dt = new Date(d.replace(/-/g, "/"));
          return `${DAY_NAMES[dt.getDay()].slice(1)}${dt.getMonth() + 1}/${dt.getDate()}`;
        });
        this.mxSlots = r.slots || [];
        this.mxMembers = r.members || [];
        this.mxGrid = r.grid || [];
        this.cellDetail = [];
      } catch (e) {
        uni.showToast({ title: e.message, icon: "none" });
      }
    },
    setWeek(w) {
      if (this.weekOff === w) return;
      this.weekOff = w;
      this.loadMatrix();
    },
    freeCount(di, si) {
      let n = 0;
      for (let mi = 0; mi < this.mxMembers.length; mi++) {
        if (this.mxGrid[di][mi][si] === 0) n++;
      }
      return n;
    },
    cellClass(di, si) {
      let free = 0, maybe = 0;
      for (let mi = 0; mi < this.mxMembers.length; mi++) {
        const s = this.mxGrid[di][mi][si];
        if (s === 0) free++;
        else if (s === 1) maybe++;
      }
      const total = this.mxMembers.length || 1;
      if (free === total) return "all";
      if (free > 0) return "some";
      if (maybe > 0) return "maybe";
      return "busy";
    },
    async tapCell(di, si) {
      const day = this.mxDays[di];
      const lo = this.mxSlots[si];
      this.cellDetailTitle = `${this.fmtDay(day)} ${this.fmtMin(lo)}-${this.fmtMin(lo + 30)}`;
      try {
        const r = await api.post(`/api/groups/${this.code}/check`, {
          day, start_min: lo, end_min: lo + 30,
        });
        this.cellDetail = r.members || [];
      } catch (e) {
        // 离线兜底：用矩阵状态
        this.cellDetail = this.mxMembers.map((m, mi) => ({
          nickname: m.nickname,
          is_me: m.is_me,
          status: ["free", "maybe", "busy"][this.mxGrid[di][mi][si]],
          details: [],
        }));
      }
    },
    async createGroup() {
      const name = (this.form.name || "").trim();
      const nickname = (this.form.nickname || "").trim();
      if (!name || !nickname) {
        uni.showToast({ title: "填组名和昵称", icon: "none" });
        return;
      }
      try {
        const g = await api.post("/api/groups", { name, nickname });
        uni.showToast({ title: "组已创建", icon: "none" });
        this.openGroup(g.code);
      } catch (e) {
        uni.showToast({ title: e.message, icon: "none" });
      }
    },
    async joinGroup() {
      const code = (this.joinCode || "").trim().toUpperCase();
      const nickname = (this.joinNick || "").trim();
      if (!code || !nickname) {
        uni.showToast({ title: "填口令和昵称", icon: "none" });
        return;
      }
      try {
        const g = await api.post("/api/groups/join", { code, nickname });
        uni.showToast({ title: "已进组", icon: "none" });
        this.openGroup(g.code);
      } catch (e) {
        uni.showToast({ title: e.message, icon: "none" });
      }
    },
    async leaveGroup() {
      uni.showModal({
        title: "退出小组",
        content: "退出后不再共享忙闲，组里没人时小组会解散",
        success: async (r) => {
          if (!r.confirm) return;
          await api.post(`/api/groups/${this.code}/leave`);
          this.code = "";
          this.loadMine();
        },
      });
    },
    copyCode() {
      uni.setClipboardData({ data: this.code });
    },
    async togglePrivacy() {
      const next = !this.group.my_share_detail;
      try {
        await api.post(`/api/groups/${this.code}/privacy`, { share_detail: next });
        this.group.my_share_detail = next;
        uni.showToast({
          title: next ? "已开放细节" : "已关闭细节（只看忙闲）",
          icon: "none",
        });
      } catch (e) {
        uni.showToast({ title: e.message, icon: "none" });
      }
    },
    async checkTime() {
      const day = this.dayVals[this.dayIdx];
      const lo = this.timeVals[this.loIdx];
      const hi = this.timeVals[this.hiIdx];
      if (hi <= lo) {
        uni.showToast({ title: "结束要晚于开始", icon: "none" });
        return;
      }
      try {
        const r = await api.post(`/api/groups/${this.code}/check`, { day, start_min: lo, end_min: hi });
        this.checkResult = r.members || [];
      } catch (e) {
        uni.showToast({ title: e.message, icon: "none" });
      }
    },
    statusText(s) {
      return s === "busy" ? "确定忙" : s === "maybe" ? "可能有事" : "应该空闲";
    },
    async quickSettle(s) {
      this.settleTitle = "";
      this.sDayIdx = this.dayVals.indexOf(s.date);
      this.sLoIdx = this.timeVals.indexOf(s.start_min);
      this.sHiIdx = this.timeVals.indexOf(s.end_min);
      uni.pageScrollTo({ selector: ".card:last-child", duration: 300 });
      uni.showToast({ title: "已填入下方定档表单", icon: "none" });
    },
    async settle() {
      const title = (this.settleTitle || "").trim();
      if (!title) {
        uni.showToast({ title: "填活动名", icon: "none" });
        return;
      }
      const lo = this.timeVals[this.sLoIdx];
      const hi = this.timeVals[this.sHiIdx];
      if (hi <= lo) {
        uni.showToast({ title: "结束要晚于开始", icon: "none" });
        return;
      }
      try {
        await api.post(`/api/groups/${this.code}/settle`, {
          title,
          day: this.dayVals[this.sDayIdx],
          start_min: lo,
          end_min: hi,
        });
        uni.showToast({ title: "已定档，等组员确认", icon: "none" });
      } catch (e) {
        uni.showToast({ title: e.message, icon: "none" });
      }
    },
    async respond(p, ok) {
      try {
        const r = await api.post(`/api/groups/${this.code}/respond`, { batch: p.batch, ok });
        if (r.settled) uni.showToast({ title: "全员确认 ✅ 已进日程", icon: "none" });
        else if (r.conflict) uni.showToast({ title: "有人冲突，批次作废", icon: "none" });
        else uni.showToast({ title: `已确认 ${r.confirmed}/${r.total}`, icon: "none" });
        this.loadDetail();
      } catch (e) {
        uni.showToast({ title: e.message, icon: "none" });
      }
    },
    fmtDay(s) {
      const d = new Date((s || "").replace(/-/g, "/").slice(0, 10));
      return isNaN(d) ? s : fmtD(d);
    },
    fmtClock(s) {
      return (s || "").slice(11, 16);
    },
    fmtMin(m) {
      return `${pad((m / 60) | 0)}:${pad(m % 60)}`;
    },
  },
};
</script>

<style scoped>
.page {
  min-height: 100vh;
  background: #f5f6fa;
  padding: 24rpx;
  padding-bottom: calc(60rpx + env(safe-area-inset-bottom));
  box-sizing: border-box;
}
.card {
  background: #fff;
  border-radius: 20rpx;
  padding: 28rpx;
  margin-bottom: 24rpx;
}
.card-title {
  font-size: 30rpx;
  font-weight: 700;
  color: #1f2937;
  margin-bottom: 20rpx;
}
.card-sub {
  font-size: 22rpx;
  color: #9ca3af;
  font-weight: 400;
  margin-left: 12rpx;
}
.empty-tip {
  font-size: 24rpx;
  color: #9ca3af;
  padding: 24rpx 0;
  text-align: center;
}
.inp {
  background: #f5f6fa;
  border-radius: 12rpx;
  padding: 20rpx 24rpx;
  font-size: 28rpx;
  margin-bottom: 20rpx;
}
.btn {
  text-align: center;
  background: #eef2ff;
  color: #4f46e5;
  font-size: 28rpx;
  font-weight: 600;
  border-radius: 999rpx;
  padding: 22rpx 0;
}
.btn.primary {
  background: #4f46e5;
  color: #fff;
}
.grp-row {
  display: flex;
  align-items: center;
  padding: 20rpx 0;
  border-bottom: 1rpx solid #f3f4f6;
}
.grp-row:last-child {
  border-bottom: none;
}
.grp-icon {
  font-size: 40rpx;
  margin-right: 20rpx;
}
.grp-mid {
  flex: 1;
  display: flex;
  flex-direction: column;
}
.grp-name {
  font-size: 28rpx;
  color: #1f2937;
  font-weight: 600;
}
.grp-name.big {
  font-size: 34rpx;
}
.grp-sub {
  font-size: 22rpx;
  color: #9ca3af;
  margin-top: 6rpx;
}
.grp-go {
  color: #c7c9d1;
  font-size: 40rpx;
}
.grp-head {
  display: flex;
  align-items: flex-start;
}
.leave {
  font-size: 24rpx;
  color: #dc2626;
  padding: 8rpx 20rpx;
  border: 1rpx solid #fecaca;
  border-radius: 999rpx;
}
.mem-line {
  display: flex;
  flex-wrap: wrap;
  gap: 12rpx;
  margin-top: 20rpx;
}
.mem-chip {
  font-size: 22rpx;
  color: #4b5563;
  background: #f3f4f6;
  border-radius: 999rpx;
  padding: 8rpx 20rpx;
}
.priv-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 24rpx;
  padding-top: 20rpx;
  border-top: 1rpx solid #f3f4f6;
}
.priv-text {
  flex: 1;
  font-size: 24rpx;
  color: #6b7280;
  margin-right: 16rpx;
}
.slot-row {
  display: flex;
  align-items: center;
  padding: 20rpx 0;
  border-bottom: 1rpx solid #f3f4f6;
}
.slot-row:last-child {
  border-bottom: none;
}
.slot-badge {
  width: 44rpx;
  height: 44rpx;
  border-radius: 50%;
  background: #e5e7eb;
  color: #6b7280;
  font-size: 26rpx;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-right: 20rpx;
}
.slot-badge.top1 {
  background: #fef3c7;
  color: #b45309;
}
.slot-badge.top2 {
  background: #e0e7ff;
  color: #4338ca;
}
.slot-badge.top3 {
  background: #fce7f3;
  color: #be185d;
}
.settle-btn {
  font-size: 24rpx;
  color: #4f46e5;
  background: #eef2ff;
  border-radius: 999rpx;
  padding: 10rpx 28rpx;
}
.pick-row {
  display: flex;
  align-items: center;
  gap: 14rpx;
  margin-bottom: 20rpx;
  flex-wrap: wrap;
}
.pick-chip {
  font-size: 26rpx;
  color: #374151;
  background: #f5f6fa;
  border-radius: 12rpx;
  padding: 16rpx 24rpx;
}
.pick-to {
  font-size: 24rpx;
  color: #9ca3af;
}
.check-list {
  margin-top: 20rpx;
}
.check-row {
  display: flex;
  align-items: center;
  padding: 16rpx 0;
  border-bottom: 1rpx solid #f3f4f6;
  flex-wrap: wrap;
}
.check-row:last-child {
  border-bottom: none;
}
.check-dot {
  width: 16rpx;
  height: 16rpx;
  border-radius: 50%;
  margin-right: 14rpx;
}
.check-dot.busy {
  background: #ef4444;
}
.check-dot.maybe {
  background: #f59e0b;
}
.check-dot.free {
  background: #10b981;
}
.check-nick {
  font-size: 27rpx;
  color: #1f2937;
}
.check-status {
  font-size: 24rpx;
  margin-left: 16rpx;
}
.check-status.busy {
  color: #dc2626;
}
.check-status.maybe {
  color: #b45309;
}
.check-status.free {
  color: #059669;
}
.check-detail {
  width: 100%;
  font-size: 22rpx;
  color: #9ca3af;
  margin-top: 6rpx;
  margin-left: 30rpx;
}
.pend-row {
  display: flex;
  align-items: center;
  padding: 18rpx 0;
  border-bottom: 1rpx solid #f3f4f6;
}
.pend-row:last-child {
  border-bottom: none;
}
.pend-acts {
  display: flex;
  gap: 14rpx;
}
.pend-btn {
  font-size: 24rpx;
  border-radius: 999rpx;
  padding: 10rpx 26rpx;
}
.pend-btn.ok {
  background: #d1fae5;
  color: #047857;
}
.pend-btn.no {
  background: #fee2e2;
  color: #b91c1c;
}
.hint {
  font-size: 22rpx;
  color: #9ca3af;
  text-align: center;
  margin-top: 16rpx;
}

/* 整周忙闲矩阵 */
.wk-seg {
  display: inline-flex;
  background: #f3f4f6;
  border-radius: 999rpx;
  padding: 4rpx;
  margin-left: 14rpx;
  vertical-align: middle;
}
.wk-seg text {
  font-size: 22rpx;
  color: #6b7280;
  padding: 6rpx 22rpx;
  border-radius: 999rpx;
  font-weight: 400;
}
.wk-seg text.on {
  background: #4f46e5;
  color: #fff;
}
.mx {
  border: 1rpx solid #f3f4f6;
  border-radius: 14rpx;
  overflow: hidden;
}
.mx-body {
  max-height: 620rpx;
}
.mx-row {
  display: flex;
  align-items: stretch;
}
.mx-head {
  background: #f9fafb;
}
.mx-time {
  width: 64rpx;
  flex: none;
  font-size: 18rpx;
  color: #9ca3af;
  text-align: right;
  padding-right: 8rpx;
  line-height: 34rpx;
  box-sizing: border-box;
}
.mx-day {
  flex: 1;
  font-size: 20rpx;
  color: #6b7280;
  text-align: center;
  padding: 10rpx 0;
  border-left: 1rpx solid #f3f4f6;
}
.mx-day.today {
  color: #4f46e5;
  font-weight: 700;
}
.mx-cell {
  flex: 1;
  height: 34rpx;
  border-left: 1rpx solid #f3f4f6;
  border-top: 1rpx solid #f6f7f9;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
}
.mx-cell.all {
  background: #6ee7b7;
}
.mx-cell.some {
  background: #d1fae5;
}
.mx-cell.maybe {
  background: #fde68a;
}
.mx-cell.busy {
  background: #eef0f3;
}
.mx-n {
  font-size: 18rpx;
  color: #059669;
  font-weight: 600;
}
.mx-legend {
  font-size: 20rpx;
  color: #9ca3af;
  margin-top: 14rpx;
}
.mx-detail-head {
  font-size: 26rpx;
  font-weight: 600;
  color: #1f2937;
  padding: 14rpx 0 4rpx;
}
</style>
