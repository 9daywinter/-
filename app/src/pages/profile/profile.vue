<template>
  <view class="page">
    <!-- 头部：头像 + 昵称 + 口令 -->
    <view class="hero card">
      <view class="hero-top">
        <view class="avatar">{{ avatarChar }}</view>
        <view class="hero-info">
          <view class="nick-row" @click="editing = true">
            <text class="nick">{{ profile.nickname || "同学" }}</text>
            <text class="nick-edit">✏️</text>
          </view>
          <text class="since">{{ sinceText }}</text>
        </view>
      </view>
      <!-- 昵称编辑 -->
      <view class="nick-editor" v-if="editing">
        <input v-model="nickDraft" placeholder="起个名字" maxlength="16" :focus="true" />
        <button class="mini" @click="saveNick">保存</button>
        <button class="mini ghost" @click="editing = false">取消</button>
      </view>
    </view>

    <!-- 数据概览 -->
    <view class="stats">
      <view class="stat"><text class="num">{{ stats.courses }}</text><text class="lbl">课程</text></view>
      <view class="stat"><text class="num">{{ stats.events }}</text><text class="lbl">日程</text></view>
      <view class="stat"><text class="num">{{ stats.changes }}</text><text class="lbl">课表改动</text></view>
    </view>

    <!-- 学期与课表管理 -->
    <view class="card">
      <view class="card-title">📋 课表管理</view>
      <view class="row" @click="goDdl">
        <text class="label">DDL 倒计时</text>
        <text class="val">手动记 deadline，红黄绿倒计时</text>
        <text class="arrow">›</text>
      </view>
      <view class="row" @click="goTerm">
        <text class="label">本学期</text>
        <text class="val">{{ termText }}</text>
        <text class="arrow">›</text>
      </view>
      <view class="row" @click="resetCourses">
        <text class="label">新学期重置</text>
        <text class="val danger">清空全部课程，重设开学日期</text>
        <text class="arrow">›</text>
      </view>
      <view class="row" @click="resetEvents">
        <text class="label">清空日程</text>
        <text class="val danger">删除全部日程</text>
        <text class="arrow">›</text>
      </view>
    </view>

    <!-- 我的日程 -->
    <view class="card">
      <view class="card-title">🗓️ 我的日程（{{ stats.events }}）</view>
      <view v-if="!events.length" class="empty-tip">还没有日程，去课表页「➕ 添加日程」</view>
      <view v-for="e in events" :key="e.id" class="ev-row">
        <text class="ev-icon">{{ e.icon || "🎤" }}</text>
        <view class="ev-mid">
          <text class="ev-title">{{ e.title }}<text v-if="e.series_count > 1" class="series-tag"> 🔁×{{ e.series_count }}</text></text>
          <text class="ev-sub">{{ evTime(e) }}<template v-if="e.location"> · {{ e.location }}</template></text>
        </view>
        <text class="ev-status">{{ statusLabel(e.time_status) }}</text>
      </view>
    </view>

    <!-- 课表改动：调课/停课记录 -->
    <view class="card">
      <view class="card-title">🔄 课表改动（{{ stats.changes }}）</view>
      <view v-if="!changes.length" class="empty-tip">没有调课/停课记录</view>
      <view v-for="c in changes" :key="c.id" class="ev-row">
        <text class="ev-icon">📚</text>
        <view class="ev-mid">
          <text class="ev-title">{{ c.name }}</text>
          <text class="ev-sub">周{{ dayName(c.day_of_week) }} 第{{ c.start_slot }}-{{ c.end_slot }}节</text>
        </view>
        <text class="ev-remark">{{ c.remark }}</text>
      </view>
    </view>

  </view>
</template>

<script>
import { api, getUser } from "../../utils/api";
import { DAY_NAMES, TIME_STATUS } from "../../utils/slots";

export default {
  data() {
    return {
      profile: { user_code: getUser(), nickname: "", created_at: "" },
      term: null,
      stats: { courses: 0, events: 0, changes: 0 },
      events: [],
      changes: [],
      editing: false,
      nickDraft: "",
    };
  },
  computed: {
    avatarChar() {
      const n = this.profile.nickname || "";
      return n ? Array.from(n)[0] : "👤";
    },
    sinceText() {
      if (!this.profile.created_at) return "";
      const d = this.profile.created_at.slice(0, 10);
      return `${d} 开始使用`;
    },
    termText() {
      if (!this.term) return "未设置 ›";
      return `${this.term.name} · 第${this.term.current_week}/${this.term.total_weeks}周`;
    },
  },
  onShow() {
    this.load();
  },
  methods: {
    async load() {
      try {
        const s = await api.get("/api/profile/summary");
        this.profile = s.profile;
        this.term = s.term;
        this.stats = s.stats;
        this.events = s.events;
        this.changes = s.changes;
      } catch (e) {
        uni.showToast({ title: e.message, icon: "none" });
      }
    },
    async saveNick() {
      const name = (this.nickDraft || "").trim();
      if (!name) {
        uni.showToast({ title: "名字不能为空", icon: "none" });
        return;
      }
      try {
        this.profile = await api.put("/api/profile", { nickname: name });
        this.editing = false;
        uni.showToast({ title: "已保存", icon: "none" });
      } catch (e) {
        uni.showToast({ title: e.message, icon: "none" });
      }
    },
    goTerm() {
      uni.navigateTo({ url: "/pages/term/term" });
    },
    goDdl() {
      uni.navigateTo({ url: "/pages/ddl/ddl" });
    },
    // 新学期：清空课程 → 跳学期页改开学日期 → 重新导入
    resetCourses() {
      uni.showModal({
        title: "新学期重置",
        content: `将清空全部 ${this.stats.courses} 门课程（日程保留），然后去设置新学期开学日期`,
        confirmText: "重置",
        success: async (res) => {
          if (!res.confirm) return;
          await api.post("/api/profile/reset", { scope: "courses" });
          uni.showToast({ title: "已清空课程", icon: "none" });
          setTimeout(() => uni.navigateTo({ url: "/pages/term/term" }), 500);
        },
      });
    },
    resetEvents() {
      uni.showModal({
        title: "清空日程",
        content: `将删除全部 ${this.stats.events} 个日程，不可恢复`,
        confirmText: "删除",
        confirmColor: "#dc2626",
        success: async (res) => {
          if (!res.confirm) return;
          await api.post("/api/profile/reset", { scope: "events" });
          uni.showToast({ title: "已清空", icon: "none" });
          this.load();
        },
      });
    },
    statusLabel(key) {
      const t = TIME_STATUS.find((x) => x.key === key);
      return t ? t.label.replace(/^\S+\s/, "") : "准点";
    },
    dayName(d) {
      return DAY_NAMES[d - 1] || "?";
    },
    evTime(e) {
      const s = (e.start_at || "").replace("T", " ").slice(5, 16);
      if (e.time_status === "todo") return "时间待定";
      if (e.time_status === "fuzzy") return `约 ${s}`;
      if (e.time_status === "start_only") return `${s} 起`;
      return `${s} ~ ${(e.end_at || "").replace("T", " ").slice(5, 16)}`;
    },
  },
};
</script>

<style scoped>
.page {
  padding: 24rpx;
  padding-bottom: 80rpx;
  max-width: 950px; /* 电脑端居中限宽 */
  margin: 0 auto;
  box-sizing: border-box;
}
.card {
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 24rpx;
}
.card-title {
  font-size: 30rpx;
  font-weight: 600;
  margin-bottom: 8rpx;
}
.btn {
  text-align: center;
  background: #eef2ff;
  color: #4f46e5;
  font-size: 28rpx;
  font-weight: 600;
  border-radius: 999rpx;
  padding: 22rpx 0;
  margin-top: 20rpx;
}
.btn.primary {
  background: #4f46e5;
  color: #fff;
}
.btn.danger {
  background: #fff;
  color: #dc2626;
  border: 1rpx solid #fecaca;
}

/* 头部 */
.hero-top {
  display: flex;
  align-items: center;
  gap: 24rpx;
}
.avatar {
  width: 108rpx;
  height: 108rpx;
  border-radius: 50%;
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
  color: #fff;
  font-size: 48rpx;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.hero-info {
  flex: 1;
  min-width: 0;
}
.nick-row {
  display: flex;
  align-items: center;
  gap: 12rpx;
}
.nick {
  font-size: 36rpx;
  font-weight: 600;
  max-width: 400rpx;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nick-edit {
  font-size: 24rpx;
}
.since {
  font-size: 22rpx;
  color: #b0b5c1;
  margin-top: 6rpx;
}
.nick-editor {
  display: flex;
  align-items: center;
  gap: 12rpx;
  margin-top: 20rpx;
}
.nick-editor input {
  flex: 1;
  min-width: 0;
  background: #f5f6fa;
  border-radius: 10rpx;
  padding: 12rpx 18rpx;
  font-size: 28rpx;
}
.mini {
  flex-shrink: 0;
  margin: 0;
  padding: 0 26rpx;
  height: 62rpx;
  line-height: 62rpx;
  font-size: 24rpx;
  color: #fff;
  background: #4f46e5;
  border-radius: 10rpx;
}
.mini.ghost {
  color: #6b7280;
  background: #f5f6fa;
}
.mini::after {
  border: none;
}

/* 口令 */
.code-box {
  margin-top: 24rpx;
  background: #eef2ff;
  border-radius: 14rpx;
  padding: 20rpx 24rpx;
}
.code-line {
  display: flex;
  align-items: center;
  gap: 16rpx;
}
.code-label {
  font-size: 24rpx;
  color: #6b7280;
  flex-shrink: 0;
}
.code {
  flex: 1;
  min-width: 0;
  font-size: 30rpx;
  font-weight: 600;
  color: #4f46e5;
  word-break: break-all;
}
.copy {
  flex-shrink: 0;
  color: #fff;
  font-size: 24rpx;
  padding: 10rpx 28rpx;
  background: #4f46e5;
  border-radius: 999rpx;
}
.code-tip {
  display: block;
  margin-top: 12rpx;
  font-size: 22rpx;
  color: #8a91a3;
}

/* 概览 */
.stats {
  display: flex;
  gap: 16rpx;
  margin-bottom: 24rpx;
}
.stat {
  flex: 1;
  background: #fff;
  border-radius: 14rpx;
  padding: 22rpx 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6rpx;
}
.num {
  font-size: 36rpx;
  font-weight: 700;
  color: #1f2333;
}
.lbl {
  font-size: 22rpx;
  color: #8a91a3;
}

/* 管理行 */
.row {
  display: flex;
  align-items: center;
  padding: 26rpx 0;
  border-bottom: 1rpx solid #f1f2f6;
}
.row:last-child {
  border-bottom: none;
}
.label {
  width: 190rpx;
  color: #374151;
  font-size: 28rpx;
  flex-shrink: 0;
}
.val {
  flex: 1;
  min-width: 0;
  color: #6b7280;
  font-size: 25rpx;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.val.danger {
  color: #dc2626;
}
.arrow {
  color: #c7cbd6;
  font-size: 30rpx;
  flex-shrink: 0;
}

/* 列表行（日程/改动/群组共用） */
.ev-row {
  display: flex;
  align-items: center;
  gap: 18rpx;
  padding: 22rpx 0;
  border-bottom: 1rpx solid #f1f2f6;
}
.ev-row:last-child {
  border-bottom: none;
}
.ev-icon {
  font-size: 38rpx;
  flex-shrink: 0;
}
.ev-mid {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6rpx;
}
.ev-title {
  font-size: 28rpx;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ev-sub {
  font-size: 22rpx;
  color: #8a91a3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ev-status {
  flex-shrink: 0;
  font-size: 22rpx;
  color: #4f46e5;
  background: #eef2ff;
  border-radius: 999rpx;
  padding: 6rpx 16rpx;
  max-width: 170rpx;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.series-tag { font-size: 20rpx; color: #4f46e5; font-weight: 700; }
.ev-remark {
  flex-shrink: 0;
  font-size: 22rpx;
  color: #ea580c;
  background: #fff7ed;
  border-radius: 999rpx;
  padding: 6rpx 16rpx;
  max-width: 300rpx;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.empty-tip {
  padding: 30rpx 0;
  font-size: 24rpx;
  color: #b0b5c1;
  text-align: center;
}
</style>
