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
      <view class="row" @click="goAddCourse">
        <text class="label">添加课程</text>
        <text class="val">手动加一门课，保存后跳回课表</text>
        <text class="arrow">›</text>
      </view>
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
      <view class="row" @click="go('/pages/import/import')">
        <text class="label">导入课表</text>
        <text class="val">粘贴 PC 脚本 JSON → 勾选预览 → 批量入库</text>
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

    <!-- 我的日程：点一条去「添加日程」页修改 -->
    <view class="card">
      <view class="card-title">🗓️ 我的日程（{{ stats.events }}）</view>
      <view v-if="!events.length" class="empty-tip">还没有日程，去课表页「➕ 添加日程」</view>
      <view v-for="e in events" :key="e.id" class="ev-row" @click="goEditEvent(e.id)">
        <text class="ev-icon">{{ e.icon || defaultIcon }}</text>
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

    <!-- 备份与恢复：v2 数据全在本机，换机/防丢靠 JSON -->
    <view class="card">
      <view class="card-title">💾 备份与恢复</view>
      <view class="row" @click="exportBackup">
        <text class="label">导出备份</text>
        <text class="val">全部数据复制成 JSON 文本，存到备忘录/文件</text>
        <text class="arrow">›</text>
      </view>
      <view class="row" @click="showImport = true">
        <text class="label">导入备份</text>
        <text class="val">粘贴备份 JSON，整体替换本机数据</text>
        <text class="arrow">›</text>
      </view>
    </view>

    <!-- 导入弹层 -->
    <view v-if="showImport" class="sheet-mask" @click="showImport = false">
      <view class="sheet" @click.stop>
        <view class="sheet-title">导入备份</view>
        <textarea
          v-model="importText"
          class="import-ta"
          placeholder="把之前导出的备份 JSON 整段粘贴到这里"
          :maxlength="-1"
        />
        <view class="import-tip">⚠️ 导入会整体替换本机的课程、日程、DDL 和学期设置</view>
        <view class="sheet-btns">
          <button class="mini ghost-btn" @click="showImport = false">取消</button>
          <button class="mini solid-btn" @click="doImport">替换本机数据</button>
        </view>
      </view>
    </view>

    <!-- 课表导入弹层（换学期）：只替换课程 -->
    <view v-if="showTtImport" class="sheet-mask" @click="showTtImport = false">
      <view class="sheet" @click.stop>
        <view class="sheet-title">从文件导入课表</view>
        <textarea
          v-model="ttText"
          class="import-ta"
          placeholder="电脑上运行 scripts/import_timetable.py（教务导出的 docx/xlsx）生成 timetable.json，把内容整段粘贴到这里"
          :maxlength="-1"
        />
        <view class="import-tip">🔄 只替换课程，日程 / DDL / 学期设置都保留。换学期记得先到「本学期」改开学日期</view>
        <view class="sheet-btns">
          <button class="mini ghost-btn" @click="showTtImport = false">取消</button>
          <button class="mini solid-btn" @click="doImportTt">替换课表</button>
        </view>
      </view>
    </view>
  </view>
</template>

<script>
import { api, getUser } from "../../utils/api";
import { exportAll, importAll, importTimetable } from "../../utils/db";
import { DAY_NAMES, DEFAULT_EVENT_ICON, TIME_STATUS } from "../../utils/slots";

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
      defaultIcon: DEFAULT_EVENT_ICON,
      showImport: false,
      importText: "",
      showTtImport: false,
      ttText: "",
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
    goAddCourse() {
      // 跳回课表页并自动弹加课表单（index.vue 读一次性标记 _autoAdd，
      // 不用网址参数：参数留在地址栏，刷新会再弹一次）
      uni.setStorageSync("_autoAdd", 1);
      uni.reLaunch({ url: "/pages/index/index" });
    },
    goEditEvent(id) {
      // 跳到添加日程页，自动载入这条日程进编辑（add.vue 读 ?edit=）
      uni.navigateTo({ url: "/pages/add/add?edit=" + id });
    },
    go(url) {
      uni.navigateTo({ url });
    },
    // ---- 备份与恢复（走统一数据通道：单机版=本地，小程序云端=云文档） ----
    async exportBackup() {
      try {
        const json = await api.request("GET", "/api/backup");
        uni.setClipboardData({
          data: json,
          success: () => {
            uni.showModal({
              title: "已复制到剪贴板",
              content: `备份共 ${json.length} 字符。打开备忘录/微信文件传输助手粘贴保存，换机或重装时用「导入备份」恢复。`,
              showCancel: false,
            });
          },
        });
      } catch (e) {
        uni.showToast({ title: e.message, icon: "none" });
      }
    },
    async doImport() {
      const text = (this.importText || "").trim();
      if (!text) {
        uni.showToast({ title: "先粘贴备份内容", icon: "none" });
        return;
      }
      let counts;
      try {
        counts = await api.request("POST", "/api/backup", { json: text });
      } catch (e) {
        uni.showToast({ title: e.message, icon: "none" });
        return;
      }
      this.showImport = false;
      this.importText = "";
      uni.showToast({ title: `已导入 ${counts.courses} 课/${counts.events} 程/${counts.ddls} DDL`, icon: "none" });
      setTimeout(() => uni.reLaunch({ url: "/pages/index/index" }), 800);
    },
    // 换学期：只替换课程（教务文件 → PC 脚本 → 粘贴）
    async doImportTt() {
      const text = (this.ttText || "").trim();
      if (!text) {
        uni.showToast({ title: "先粘贴课表 JSON", icon: "none" });
        return;
      }
      let n;
      try {
        n = await api.request("POST", "/api/timetable/import", { json: text });
      } catch (e) {
        uni.showToast({ title: e.message, icon: "none" });
        return;
      }
      this.showTtImport = false;
      this.ttText = "";
      uni.showToast({ title: `已导入 ${n} 门课`, icon: "none" });
      this.load();
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
  padding-bottom: calc(80rpx + env(safe-area-inset-bottom));
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
.card-sub {
  font-size: 20rpx;
  font-weight: 400;
  color: #9ca3af;
  margin-left: 12rpx;
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
  overflow-wrap: break-word; /* 时间放不下折行，不裁省略号 */
}
.ev-status {
  flex-shrink: 0;
  font-size: 22rpx;
  color: #4f46e5;
  background: #eef2ff;
  border-radius: 999rpx;
  padding: 6rpx 16rpx;
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

/* 导入备份弹层 */
.sheet-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: 10;
  display: flex;
  align-items: flex-end;
}
.sheet {
  width: 100%;
  background: #fff;
  border-radius: 24rpx 24rpx 0 0;
  padding: 32rpx 28rpx calc(32rpx + env(safe-area-inset-bottom));
  box-sizing: border-box;
}
.sheet-title {
  font-size: 32rpx;
  font-weight: 600;
  margin-bottom: 24rpx;
}
.import-ta {
  width: 100%;
  height: 260rpx;
  background: #f5f6fa;
  border-radius: 12rpx;
  padding: 16rpx;
  font-size: 24rpx;
  box-sizing: border-box;
}
.import-tip {
  font-size: 22rpx;
  color: #b45309;
  background: #fef3c7;
  border-radius: 10rpx;
  padding: 14rpx 18rpx;
  margin-top: 16rpx;
}
.sheet-btns {
  display: flex;
  gap: 16rpx;
  margin-top: 24rpx;
}
.ghost-btn {
  flex: 1;
  color: #6b7280;
  background: #f5f6fa;
}
.solid-btn {
  flex: 2;
  color: #fff;
  background: #4f46e5;
}
</style>
