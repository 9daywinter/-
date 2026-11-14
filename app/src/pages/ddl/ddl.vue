<template>
  <view class="page">
    <!-- 统计条 -->
    <view class="stat-bar">
      <view class="stat" :class="{ on: filter === 'red' }" @click="filter = filter === 'red' ? '' : 'red'">
        <text class="num red">{{ tierCount.red }}</text><text class="lbl">紧急</text>
      </view>
      <view class="stat" :class="{ on: filter === 'yellow' }" @click="filter = filter === 'yellow' ? '' : 'yellow'">
        <text class="num yellow">{{ tierCount.yellow }}</text><text class="lbl">较紧</text>
      </view>
      <view class="stat" :class="{ on: filter === 'green' }" @click="filter = filter === 'green' ? '' : 'green'">
        <text class="num green">{{ tierCount.green }}</text><text class="lbl">从容</text>
      </view>
      <view class="hint-btn" @click="showTierHelp = true">?</view>
      <view class="add-btn" @click="openAdd">＋ 加 DDL</view>
    </view>
    <!-- 截止前一天提醒：还没完成的任务 DDL -->
    <view v-if="remindList.length" class="remind-bar" @click="filter = filter === 'red' ? '' : 'red'">
      ⏰ <text class="remind-strong">明天截止：</text>{{ remindText }}
    </view>

    <!-- 考试单独分区：命中考试词自动归入，最高重要度 -->
    <block v-if="examList.length">
      <view class="sec-title">📝 考试（{{ examList.length }}）</view>
      <view v-for="d in examList" :key="'exam' + d.id" class="card ddl-card exam" :class="d.tier">
        <view class="ddl-top">
          <view class="badge exam">考试</view>
          <view class="ddl-mid">
            <text class="title">{{ d.title }} <text class="weight w3">★★★ 高</text></text>
            <text class="sub" v-if="d.course_name">📚 {{ d.course_name }} · </text>
            <text class="sub">{{ dueText(d.due_at) }}</text>
            <text class="remain" :class="d.tier">{{ d.remain_text }}</text>
          </view>
          <view class="ddl-ops">
            <text class="op" @click="toggleDone(d)">✓ 完成</text>
            <text class="op" @click="openEdit(d)">✎</text>
            <text class="op danger" @click="del(d)">🗑</text>
          </view>
        </view>
        <!-- 考试关键信息：醒大红框，地点/备注一眼看到 -->
        <view v-if="d.location || d.note" class="exam-box">
          <view v-if="d.location" class="exam-box-row">📍 地点：<text class="exam-box-val">{{ d.location }}</text></view>
          <view v-if="d.note" class="exam-box-row">📝 备注：<text class="exam-box-val">{{ d.note }}</text></view>
        </view>
      </view>
    </block>

    <!-- 倒计时墙（考试单独在上面分区） -->
    <block v-if="!wall.length && !examList.length && !doneList.length">
      <view class="empty">
        <text class="empty-title">还没有 DDL</text>
        <text class="empty-sub">点右上角「＋ 加 DDL」手动记一个</text>
      </view>
    </block>
    <block v-else-if="!wall.length && !examList.length && !showDone">
      <view class="empty">
        <text class="empty-title">🎉 全部完成</text>
        <text class="empty-sub">完成的 DDL 收在下面，点「显示已完成」可查看/撤销</text>
      </view>
    </block>
    <block v-else-if="!wallShown.length && !showDone">
      <view class="empty"><text class="empty-sub">这一档没有 DDL</text></view>
    </block>

    <view v-for="d in wallShown" :key="d.id" class="card ddl-card" :class="d.tier">
      <view class="ddl-top">
        <view class="badge" :class="d.tier">{{ tierLabel(d.tier) }}</view>
        <view class="ddl-mid">
          <text class="title">{{ d.title }} <text class="weight" :class="'w' + d.weight">{{ weightText(d.weight) }}</text></text>
          <text class="sub" v-if="d.course_name">📚 {{ d.course_name }} · </text>
          <text class="sub">{{ dueText(d.due_at) }}</text>
          <text class="remain" :class="d.tier">{{ d.remain_text }}</text>
        </view>
        <view class="ddl-ops">
          <text class="op" @click="toggleDone(d)">{{ d.status === "done" ? "↩ 撤销" : "✓ 完成" }}</text>
          <text class="op" @click="openEdit(d)">✎</text>
          <text class="op danger" @click="del(d)">🗑</text>
        </view>
      </view>
    </view>

    <!-- 已完成折叠区：不丢弃记录，可撤销 -->
    <view v-if="doneList.length" class="done-head" @click="showDone = !showDone">
      <text>✅ 已完成（{{ doneList.length }}）</text>
      <text class="arrow">{{ showDone ? "▾" : "▸" }}</text>
    </view>
    <view v-if="showDone" v-for="d in doneList" :key="'done' + d.id" class="card ddl-card done">
      <view class="ddl-top">
        <view class="badge done">完成</view>
        <view class="ddl-mid">
          <text class="title">{{ d.title }}</text>
          <text class="sub">{{ dueText(d.due_at) }} · 已完成</text>
        </view>
        <view class="ddl-ops">
          <text class="op" @click="toggleDone(d)">↩ 撤销</text>
          <text class="op danger" @click="del(d)">🗑</text>
        </view>
      </view>
    </view>

    <!-- 手动/编辑 DDL 弹层 -->
    <view v-if="showForm" class="sheet-mask" @click="showForm = false">
      <view class="sheet" @click.stop>
        <view class="sheet-title">{{ form.id ? "改 DDL" : "加 DDL" }}</view>
        <view class="form-row">
          <text class="label">任务</text>
          <input v-model="form.title" placeholder="如 交实验报告" />
        </view>
        <view class="form-row">
          <text class="label">课程</text>
          <input v-model="form.course_name" placeholder="可选，如 高等数学" />
        </view>
        <view class="form-row">
          <text class="label">{{ form.kind === 'exam' ? '开考' : '截止' }}</text>
          <picker mode="date" :value="form.d" @change="(e) => (form.d = e.detail.value)">
            <view class="picker-val">{{ form.d }} ▾</view>
          </picker>
          <picker mode="time" :value="form.t" @change="(e) => (form.t = e.detail.value)">
            <view class="picker-val">{{ form.t }} ▾</view>
          </picker>
        </view>
        <view v-if="form.kind === 'exam'" class="form-row">
          <text class="label">结束</text>
          <picker mode="time" :value="form.examEnd" @change="(e) => (form.examEnd = e.detail.value)">
            <view class="picker-val">{{ form.examEnd }} ▾</view>
          </picker>
        </view>
        <view class="form-row">
          <text class="label">类型</text>
          <view class="w-chips">
            <view class="w-chip" :class="{ on: form.kind !== 'exam' }" @click="setKind('task')">📋 任务</view>
            <view class="w-chip exam" :class="{ on: form.kind === 'exam' }" @click="setKind('exam')">📝 考试</view>
          </view>
        </view>
        <view class="form-row">
          <text class="label">重要度</text>
          <view class="w-chips" :class="{ lock: form.kind === 'exam' }">
            <view class="w-chip" :class="{ on: form.weight === 1 }" @click="form.kind !== 'exam' && (form.weight = 1)">低</view>
            <view class="w-chip" :class="{ on: form.weight === 2 }" @click="form.kind !== 'exam' && (form.weight = 2)">中</view>
            <view class="w-chip" :class="{ on: form.weight === 3 }" @click="form.kind !== 'exam' && (form.weight = 3)">高</view>
          </view>
        </view>
        <view v-if="form.kind === 'exam'" class="form-row">
          <text class="label">考试地点</text>
          <input v-model="form.location" placeholder="如 教三-301（会标在课表上）" />
        </view>
        <view v-if="form.kind === 'exam'" class="form-row">
          <text class="label">备注</text>
          <input v-model="form.note" placeholder="范围 / 开闭卷 / 带什么，可选" />
        </view>
        <view v-if="form.kind === 'exam'" class="exam-tip">📝 考试自动按最高重要度处理，单独分区，时间和地点会标到课表上</view>
        <view class="sheet-btns">
          <button class="btn-plain" @click="showForm = false">取消</button>
          <button class="btn-primary" @click="saveForm">{{ form.id ? "保存" : "添加" }}</button>
        </view>
      </view>
    </view>

    <!-- 档位说明 -->
    <view v-if="showTierHelp" class="help-mask" @click="showTierHelp = false">
      <view class="help-sheet" @click.stop>
        <view class="sheet-title">⏰ 档位是怎么算的</view>
        <view class="help-row"><text class="dot red"></text>紧急 —— 剩余时间 ÷ 重要度 ≤ 12 小时</view>
        <view class="help-row"><text class="dot yellow"></text>较紧 —— 剩余时间 ÷ 重要度 ≤ 3 天</view>
        <view class="help-row"><text class="dot green"></text>从容 —— 其余；过期的自动灰显</view>
        <view class="help-divider"></view>
        <view class="help-row">重要度：★ 低 / ★★ 中 / ★★★ 高</view>
        <view class="help-row">📝 考试自动归最高档，单独分区展示</view>
        <button class="btn-primary help-ok" @click="showTierHelp = false">知道了</button>
      </view>
    </view>

    <!-- 完成仪式感 -->
    <view v-if="celebrate" class="celebrate-mask">
      <view class="celebrate-inner">
        <view v-for="i in 14" :key="i" class="confetti" :class="'c' + (i % 7)"></view>
        <view class="celebrate-circle">✓</view>
        <view class="celebrate-title">完成！</view>
        <view class="celebrate-sub">「{{ celebrate.title }}」搞定，又少一件事</view>
      </view>
    </view>
  </view>
</template>

<script>
import { api } from "../../utils/api";

const DAY = ["日", "一", "二", "三", "四", "五", "六"];

export default {
  data() {
    return {
      ddls: [],
      filter: "",
      showDone: false, // 已完成折叠区
      // 手动/编辑表单
      showForm: false,
      form: { id: null, title: "", course_name: "", d: "", t: "23:59", weight: 2, kind: "task", location: "", note: "", examEnd: "11:00" },
      // 档位说明
      showTierHelp: false,
      // 完成仪式感
      celebrate: null,
    };
  },
  computed: {
    // 未完成、非考试（考试单独分区）
    wall() {
      return this.ddls.filter((d) => d.status !== "done" && d.kind !== "exam");
    },
    // 未完成考试：独立分区，最高重要度
    examList() {
      return this.ddls.filter((d) => d.status !== "done" && d.kind === "exam");
    },
    doneList() {
      return this.ddls.filter((d) => d.status === "done");
    },
    wallShown() {
      return this.filter ? this.wall.filter((d) => d.tier === this.filter) : this.wall;
    },
    tierCount() {
      const c = { red: 0, yellow: 0, green: 0 };
      for (const d of this.wall) if (c[d.tier] !== undefined) c[d.tier]++;
      return c;
    },
    // 截止前 24h 内还没完成的任务 DDL → 前一天提醒
    remindList() {
      return this.ddls.filter((d) => d.remind && d.status !== "done");
    },
    remindText() {
      return this.remindList.map((x) => x.title).join("、");
    },
  },
  onShow() {
    this.load();
  },
  methods: {
    async load() {
      try {
        this.ddls = await api.get("/api/ddls");
      } catch (e) {
        uni.showToast({ title: e.message, icon: "none" });
      }
    },
    tierLabel(t) {
      return { red: "紧急", yellow: "较紧", green: "从容", overdue: "逾期" }[t] || "";
    },
    weightText(w) {
      return { 1: "★ 低", 2: "★★ 中", 3: "★★★ 高" }[w] || "";
    },
    dueText(dt) {
      if (!dt) return "";
      const d = new Date(dt.replace(" ", "T").replace("Z", ""));
      return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} 周${DAY[d.getDay()]} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    },
    // ---- 手动/编辑 ----
    setKind(k) {
      this.form.kind = k;
      if (k === "exam") this.form.weight = 3; // 考试固定最高重要度
    },
    openAdd() {
      const now = new Date();
      this.form = {
        id: null, title: "", course_name: "",
        d: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
        t: "23:59", weight: 2, kind: "task", location: "", note: "", examEnd: "11:00",
      };
      this.showForm = true;
    },
    openEdit(d) {
      const t = new Date(d.due_at.replace(" ", "T").replace("Z", ""));
      let examEnd = "11:00";
      if (d.exam_end) {
        const e = new Date(d.exam_end.replace(" ", "T").replace("Z", ""));
        examEnd = `${String(e.getHours()).padStart(2, "0")}:${String(e.getMinutes()).padStart(2, "0")}`;
      }
      this.form = {
        id: d.id, title: d.title, course_name: d.course_name,
        d: `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`,
        t: `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`,
        weight: d.weight, kind: d.kind || "task", location: d.location || "", note: d.note || "",
        examEnd,
      };
      this.showForm = true;
    },
    async saveForm() {
      if (!this.form.title.trim()) {
        uni.showToast({ title: "任务名不能为空", icon: "none" });
        return;
      }
      const body = {
        title: this.form.title.trim(),
        course_name: (this.form.course_name || "").trim(),
        due_at: `${this.form.d} ${this.form.t}`,
        weight: this.form.kind === "exam" ? 3 : this.form.weight,
        kind: this.form.kind,
        location: this.form.kind === "exam" ? (this.form.location || "").trim() : "",
        note: (this.form.note || "").trim(),
        exam_end: this.form.kind === "exam" ? `${this.form.d} ${this.form.examEnd}:00` : null,
      };
      try {
        if (this.form.id) await api.put(`/api/ddls/${this.form.id}`, body);
        else await api.post("/api/ddls", body);
        this.showForm = false;
        await this.load();
      } catch (e) {
        uni.showToast({ title: e.message, icon: "none" });
      }
    },
    // ---- 完成打卡 / 删除（完成有仪式感） ----
    async toggleDone(d) {
      try {
        if (d.status === "done") await api.post(`/api/ddls/${d.id}/reopen`);
        else {
          await api.post(`/api/ddls/${d.id}/done`);
          this.celebrate = { title: d.title };
          setTimeout(() => (this.celebrate = null), 1500);
        }
        await this.load();
      } catch (e) {
        uni.showToast({ title: e.message, icon: "none" });
      }
    },
    del(d) {
      uni.showModal({
        title: "删除 DDL",
        content: `确定删掉「${d.title}」？`,
        success: async (r) => {
          if (!r.confirm) return;
          try {
            await api.del(`/api/ddls/${d.id}`);
            await this.load();
          } catch (e) {
            uni.showToast({ title: e.message, icon: "none" });
          }
        },
      });
    },
  },
};
</script>

<style scoped>
.page {
  padding: 24rpx;
  padding-bottom: 80rpx;
  max-width: 950px;
  margin: 0 auto;
  box-sizing: border-box;
}

/* 统计条 */
.stat-bar {
  display: flex;
  align-items: stretch;
  gap: 16rpx;
  margin-bottom: 16rpx;
}
.stat {
  flex: 1;
  background: #fff;
  border-radius: 16rpx;
  padding: 20rpx 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4rpx;
  border: 2rpx solid transparent;
}
.stat.on {
  border-color: #4f46e5;
}
.num {
  font-size: 44rpx;
  font-weight: 700;
  color: #1f2333;
}
.num.red { color: #dc2626; }
.num.yellow { color: #d97706; }
.num.green { color: #059669; }
.lbl {
  font-size: 22rpx;
  color: #8a91a3;
}
.add-btn {
  flex: 1;
  background: #4f46e5;
  color: #fff;
  border-radius: 16rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 28rpx;
  font-weight: 600;
}

.empty {
  margin-top: 80rpx;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16rpx;
}
.empty-title { font-size: 30rpx; color: #6b7280; }
.empty-sub { font-size: 24rpx; color: #b0b5c1; }

/* DDL 卡片 */
.card {
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 20rpx;
  border-left: 8rpx solid #e5e7eb;
}
.ddl-card.red { border-left-color: #dc2626; }
.ddl-card.yellow { border-left-color: #d97706; }
.ddl-card.green { border-left-color: #059669; }
.ddl-card.overdue { border-left-color: #6b7280; opacity: 0.7; }
.ddl-card.done { border-left-color: #10b981; opacity: 0.6; }

.ddl-top { display: flex; align-items: flex-start; gap: 16rpx; }
.badge {
  flex-shrink: 0;
  font-size: 22rpx;
  padding: 6rpx 16rpx;
  border-radius: 999rpx;
  margin-top: 4rpx;
}
.badge.red { color: #fff; background: #dc2626; }
.badge.yellow { color: #fff; background: #d97706; }
.badge.green { color: #fff; background: #059669; }
.badge.overdue { color: #fff; background: #6b7280; }
.badge.done { color: #fff; background: #10b981; }

/* 已完成折叠区 */
.done-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20rpx 8rpx;
  font-size: 26rpx;
  color: #6b7280;
}
.done-head .arrow { color: #c7cbd6; }

.ddl-mid {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6rpx;
}
.title { font-size: 30rpx; font-weight: 600; }
.sub { font-size: 22rpx; color: #8a91a3; }
.remain { font-size: 24rpx; font-weight: 600; }
.remain.red, .remain.overdue { color: #dc2626; }
.remain.yellow { color: #d97706; }
.remain.green { color: #059669; }

.ddl-ops { flex-shrink: 0; display: flex; gap: 16rpx; align-items: center; }
.op {
  font-size: 22rpx;
  color: #4f46e5;
  background: #eef2ff;
  padding: 8rpx 16rpx;
  border-radius: 999rpx;
}
.op.danger { color: #dc2626; background: #fee2e2; }

/* 表单 */
.sheet-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: flex-end;
  z-index: 99;
}
.sheet {
  width: 100%;
  max-width: 950px;
  margin: 0 auto;
  background: #fff;
  border-radius: 24rpx 24rpx 0 0;
  padding: 32rpx;
  box-sizing: border-box;
}
.sheet-title { font-size: 32rpx; font-weight: 600; margin-bottom: 24rpx; }
.form-row {
  display: flex;
  align-items: center;
  gap: 16rpx;
  padding: 18rpx 0;
  border-bottom: 1rpx solid #f1f2f6;
}
.label { width: 120rpx; color: #6b7280; font-size: 28rpx; flex-shrink: 0; }
.form-row input { flex: 1; font-size: 28rpx; min-width: 0; }
.picker-val { background: #f5f6fa; border-radius: 10rpx; padding: 14rpx 20rpx; font-size: 26rpx; }
.sheet-btns { display: flex; gap: 16rpx; margin-top: 32rpx; }
.btn-plain {
  flex: 1;
  background: #f5f6fa;
  color: #6b7280;
  font-size: 28rpx;
  border-radius: 12rpx;
  height: 84rpx;
  line-height: 1;
  border: none;
}
.btn-primary {
  flex: 2;
  background: #4f46e5;
  color: #fff;
  font-size: 28rpx;
  border-radius: 12rpx;
  height: 84rpx;
  line-height: 1;
  border: none;
}
.btn-primary[disabled] { opacity: 0.6; }
.btn-plain::after, .btn-primary::after { border: none; }

.w-chips { display: flex; gap: 12rpx; }
.w-chip {
  flex: 1;
  text-align: center;
  font-size: 26rpx;
  color: #6b7280;
  background: #f5f6fa;
  border-radius: 10rpx;
  padding: 14rpx 0;
}
.w-chip.on { color: #fff; background: #4f46e5; font-weight: 600; }
.w-chips.lock { opacity: 0.55; }

/* 「?」档位说明按钮 */
.hint-btn {
  width: 56rpx;
  border-radius: 16rpx;
  background: #eef2ff;
  color: #4f46e5;
  font-size: 30rpx;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 考试分区 */
.sec-title {
  font-size: 28rpx;
  font-weight: 700;
  color: #b91c1c;
  margin: 8rpx 0 16rpx;
  padding-left: 8rpx;
}
.ddl-card.exam {
  border-left-color: #b91c1c;
  background: linear-gradient(180deg, #fff5f5, #fff);
  box-shadow: 0 4rpx 14rpx rgba(185, 28, 28, 0.08);
}
.badge.exam { color: #fff; background: #b91c1c; }

/* 重要度 */
.weight { font-size: 20rpx; font-weight: 600; vertical-align: 4rpx; }
.weight.w1 { color: #8a91a3; }
.weight.w2 { color: #d97706; }
.weight.w3 { color: #dc2626; }
.exam-tip {
  font-size: 22rpx;
  color: #b91c1c;
  background: #fef2f2;
  border-radius: 10rpx;
  padding: 14rpx 20rpx;
  margin-top: 8rpx;
}

/* 档位说明弹层 */
.help-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 120;
  padding: 40rpx;
  box-sizing: border-box;
}
.help-sheet {
  width: 100%;
  max-width: 620rpx;
  background: #fff;
  border-radius: 24rpx;
  padding: 36rpx;
  box-sizing: border-box;
}
.help-row {
  font-size: 26rpx;
  color: #374151;
  display: flex;
  align-items: center;
  gap: 14rpx;
  padding: 10rpx 0;
  line-height: 1.5;
}
.help-divider { height: 1rpx; background: #f1f2f6; margin: 16rpx 0; }
.dot { width: 18rpx; height: 18rpx; border-radius: 50%; flex-shrink: 0; }
.dot.red { background: #dc2626; }
.dot.yellow { background: #d97706; }
.dot.green { background: #059669; }
.help-ok { margin-top: 28rpx; }

/* 前一天提醒条 */
.remind-bar {
  background: #fef3c7;
  border: 2rpx solid #f59e0b;
  color: #92400e;
  border-radius: 16rpx;
  padding: 20rpx 24rpx;
  margin-bottom: 20rpx;
  font-size: 25rpx;
  line-height: 1.5;
}
.remind-strong { font-weight: 800; }

/* 考试关键信息：醒目大红框 */
.exam-box {
  margin-top: 18rpx;
  background: #fef2f2;
  border: 3rpx solid #fca5a5;
  border-radius: 14rpx;
  padding: 18rpx 22rpx;
  display: flex;
  flex-direction: column;
  gap: 10rpx;
}
.exam-box-row { font-size: 26rpx; color: #7f1d1d; font-weight: 600; }
.exam-box-val { font-weight: 800; color: #b91c1c; }

/* 完成仪式感 */
.celebrate-mask {
  position: fixed;
  inset: 0;
  background: rgba(255, 255, 255, 0.92);
  z-index: 130;
  display: flex;
  align-items: center;
  justify-content: center;
}
.celebrate-inner {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 20rpx;
}
.celebrate-circle {
  width: 180rpx;
  height: 180rpx;
  border-radius: 50%;
  background: linear-gradient(135deg, #10b981, #059669);
  color: #fff;
  font-size: 100rpx;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 16rpx 50rpx rgba(16, 185, 129, 0.45);
  animation: pop 0.5s cubic-bezier(0.2, 1.6, 0.4, 1);
}
.celebrate-title { font-size: 44rpx; font-weight: 800; color: #065f46; animation: fadeup 0.5s 0.15s both; }
.celebrate-sub { font-size: 26rpx; color: #059669; animation: fadeup 0.5s 0.3s both; }
.confetti {
  position: absolute;
  top: -100rpx;
  width: 16rpx;
  height: 28rpx;
  border-radius: 4rpx;
  animation: fall 1.4s ease-in forwards;
}
.confetti.c0 { left: -180rpx; background: #f59e0b; animation-delay: 0s; }
.confetti.c1 { left: -120rpx; background: #4f46e5; animation-delay: 0.1s; }
.confetti.c2 { left: -60rpx; background: #ec4899; animation-delay: 0.05s; }
.confetti.c3 { left: 0rpx; background: #10b981; animation-delay: 0.15s; }
.confetti.c4 { left: 60rpx; background: #3b82f6; animation-delay: 0.08s; }
.confetti.c5 { left: 120rpx; background: #ef4444; animation-delay: 0.12s; }
.confetti.c6 { left: 180rpx; background: #8b5cf6; animation-delay: 0.02s; }
@keyframes fall {
  0% { transform: translateY(0) rotate(0deg); opacity: 1; }
  100% { transform: translateY(90vh) rotate(720deg); opacity: 0; }
}
@keyframes pop {
  0% { transform: scale(0); }
  100% { transform: scale(1); }
}
@keyframes fadeup {
  0% { transform: translateY(24rpx); opacity: 0; }
  100% { transform: translateY(0); opacity: 1; }
}
</style>
