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
    <view class="paste-row" @click="openPaste">📋 粘贴群通知批量抽取 <text class="arrow">›</text></view>
    <view v-if="reviewList.length" class="review-entry" @click="openReview">
      📜 批奏折：{{ reviewList.length }} 份建议待批 <text class="arrow">›</text>
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
            <text class="op" @click="toggleDone(d)">✓</text>
            <text class="op" @click="openEdit(d)">✎</text>
            <text class="op danger" @click="del(d)">🗑</text>
          </view>
        </view>
        <!-- 考试关键信息：醒大红框，地点/备注一眼看到 -->
        <view v-if="d.location || d.note" class="exam-box">
          <view v-if="d.location" class="exam-box-row">📍 地点：<text class="exam-box-val">{{ d.location }}</text></view>
          <view v-if="d.note" class="exam-box-row">📝 备注：<text class="exam-box-val">{{ d.note }}</text></view>
        </view>
        <view class="sug" v-if="sugOf(d.id) && !dismissed[d.id]">
          <view class="sug-title">💡 {{ sugOf(d.id).slots[viewSlot(d.id)].reason }}</view>
          <view class="slot-chips">
            <view v-for="(s, i) in sugOf(d.id).slots" :key="i" class="slot-chip"
              :class="{ on: i === viewSlot(d.id) }" @click="viewSlotIdx[d.id] = i">{{ slotText(s) }}</view>
          </view>
          <view class="sug-btns">
            <button class="sug-accept" @click="accept(d)">接受这个时段</button>
            <button class="sug-plain" @click="changeSlot(d)">换时间</button>
            <button class="sug-plain" @click="ignore(d)">忽略</button>
          </view>
        </view>
      </view>
    </block>

    <!-- 倒计时墙（考试单独在上面分区） -->
    <block v-if="!wall.length && !examList.length && !doneList.length">
      <view class="empty">
        <text class="empty-title">还没有 DDL</text>
        <text class="empty-sub">手动加一个，或粘贴课程群通知自动抽取</text>
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
          <text v-if="d.muted" class="muted-tag" @click="unmute(d)">🔕 已忽略 · 点我恢复建议</text>
        </view>
        <view class="ddl-ops">
          <text class="op" @click="toggleDone(d)">{{ d.status === "done" ? "↩" : "✓" }}</text>
          <text class="op" @click="openEdit(d)">✎</text>
          <text class="op danger" @click="del(d)">🗑</text>
        </view>
      </view>

      <!-- 建议卡片（FR-33）：三个候选时段 + 三键（接受/换时间/忽略） -->
      <view class="sug" v-if="d.status !== 'done' && sugOf(d.id) && !dismissed[d.id]">
        <view class="sug-title">💡 建议投入：{{ sugOf(d.id).slots[viewSlot(d.id)].reason }}</view>
        <view class="slot-chips">
          <view
            v-for="(s, i) in sugOf(d.id).slots"
            :key="i"
            class="slot-chip"
            :class="{ on: i === viewSlot(d.id) }"
            @click="viewSlotIdx[d.id] = i"
          >{{ slotText(s) }}</view>
        </view>
        <view class="sug-btns">
          <button class="sug-accept" @click="accept(d)">接受这个时段</button>
          <button class="sug-plain" @click="changeSlot(d)">换时间</button>
          <button class="sug-plain" @click="ignore(d)">忽略</button>
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
          <text class="op" @click="toggleDone(d)">↩</text>
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
        <view v-if="form.kind === 'exam'" class="exam-tip">📝 考试自动按最高重要度处理，会单独分区并优先推荐整块时间</view>
        <view class="sheet-btns">
          <button class="btn-plain" @click="showForm = false">取消</button>
          <button class="btn-primary" @click="saveForm">{{ form.id ? "保存" : "添加" }}</button>
        </view>
      </view>
    </view>

    <!-- 粘贴通知抽取 -->
    <view v-if="showPaste" class="sheet-mask" @click="showPaste = false">
      <view class="sheet tall" @click.stop>
        <view class="sheet-title">📋 粘贴群通知抽 DDL</view>
        <textarea
          v-model="pasteText"
          class="ta"
          placeholder="把课程群/班级群里布置作业的通知整段粘进来，如：&#10;@所有人 数据结构的实验报告本周五24:00前交&#10;同学们的课程论文 12月30日前提交"
          :maxlength="2000"
        />
        <view class="btn-row">
          <button class="btn-primary" :disabled="pasteBusy" @click="parsePaste">
            {{ pasteBusy ? "抽取中…" : "智能抽取" }}
          </button>
        </view>

        <block v-if="parseRows.length">
          <view class="result-head">
            <text>抽到 {{ parseRows.length }} 个（校对后入库）</text>
            <text class="toggle-all" @click="toggleParseAll">{{ parseAll ? "全不选" : "全选" }}</text>
          </view>
          <view v-for="(r, i) in parseRows" :key="i" class="row-card" :class="{ off: !r.checked }">
            <view class="row-top">
              <view class="ck" :class="{ on: r.checked }" @click="r.checked = !r.checked"><text v-if="r.checked">✓</text></view>
              <input v-model="r.title" class="name-input" placeholder="任务名" />
              <text class="del" @click="parseRows.splice(i, 1)">✕</text>
            </view>
            <view class="row-mid">
              <text class="due-tag">截止 {{ dueText(r.due) }}<text v-if="r.kind === 'exam'" class="exam-tag"> 📝考试</text></text>
              <view class="w-chips mini">
                <text class="w-mini" :class="{ on: r.weight === 1 }" @click="r.kind !== 'exam' && (r.weight = 1)">低</text>
                <text class="w-mini" :class="{ on: r.weight === 2 }" @click="r.kind !== 'exam' && (r.weight = 2)">中</text>
                <text class="w-mini" :class="{ on: r.weight === 3 }" @click="r.kind !== 'exam' && (r.weight = 3)">高</text>
              </view>
            </view>
            <input v-model="r.course_name" class="loc-input" placeholder="关联课程（可空）" />
          </view>
          <view class="btn-row save-row">
            <button class="btn-primary" :disabled="pasteBusy" @click="saveParse">保存所选（{{ parseCheckedCount }} 个）</button>
          </view>
        </block>
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
        <view class="help-row">同样的剩余时间，重要度越高越靠前推荐</view>
        <view class="help-row">📝 考试自动归最高档，单独分区，优先推整块长时间</view>
        <button class="btn-primary help-ok" @click="showTierHelp = false">知道了</button>
      </view>
    </view>

    <!-- 批奏折：整屏滑动审批（右滑接受 / 左滑忽略 / 上滑自定义），方向提示在两侧和顶部 -->
    <view v-if="showReview" class="review-mask">
      <view class="review-head">
        <text class="review-title">📜 批奏折</text>
        <text class="review-count">剩 {{ rsQueue.length }} / {{ rsTotal }} 份</text>
        <text class="review-close" @click="closeReview">✕</text>
      </view>
      <view class="review-stage" @touchstart="rsStart" @touchmove.prevent="rsMove" @touchend="rsEnd">
        <view class="rs-flag left" :class="{ hot: rsDir === 'ignore' }">
          <text class="rs-flag-ico">🙅</text><text class="rs-flag-txt">忽略</text>
        </view>
        <view class="rs-flag right" :class="{ hot: rsDir === 'accept' }">
          <text class="rs-flag-ico">👌</text><text class="rs-flag-txt">接受</text>
        </view>
        <view class="rs-flag top" :class="{ hot: rsDir === 'custom' }">
          <text class="rs-flag-ico">🕐</text><text class="rs-flag-txt">自选时间</text>
        </view>
        <view v-if="rsCur && rsCur.kind === 'exam'" class="rs-flag bottom" :class="{ hot: rsDir === 'plan' }">
          <text class="rs-flag-ico">📚</text><text class="rs-flag-txt">周末复习到考前</text>
        </view>
        <view v-if="rsCur" class="rs-card" :class="[rsCur.tier, rsDir]"
          :style="{ transform: 'translate(' + dragX + 'px,' + dragY + 'px) rotate(' + dragX * 0.06 + 'deg)' }">
          <view class="rs-tier-row">
            <view class="badge rs-tier" :class="rsCur.tier">{{ tierLabel(rsCur.tier) }}</view>
            <text v-if="rsCur.kind === 'exam'" class="rs-exam-tag">📝 考试</text>
          </view>
          <view class="rs-title">{{ rsCur.title }} <text class="weight" :class="'w' + rsCur.weight">{{ weightText(rsCur.weight) }}</text></view>
          <view class="rs-sub" v-if="rsCur.course_name">📚 {{ rsCur.course_name }}</view>
          <view class="rs-sub rs-due">⏰ 截止 {{ dueText(rsCur.due_at) }}</view>
          <view class="rs-remain" :class="rsCur.tier">{{ rsCur.remain_text }}</view>
          <view class="rs-divider"></view>
          <view class="rs-slot-label">建议投入（点选时段，或直接滑动审批）</view>
          <view class="slot-chips rs-chips">
            <view v-for="(s, i) in rsCur.slots" :key="i" class="slot-chip"
              :class="{ on: i === rsSlotIdx }" @click="rsSlotIdx = i">{{ slotText(s) }}</view>
          </view>
          <view class="rs-reason">💡 {{ rsCur.slots[rsSlotIdx] ? rsCur.slots[rsSlotIdx].reason : "" }}</view>
        </view>
        <view v-else class="rs-empty">
          <text class="rs-empty-icon">🎉</text>
          <text class="rs-empty-title">全部批完</text>
          <text class="rs-empty-sub">接受的时段已写进日程表</text>
        </view>
      </view>
      <view class="review-btns" v-if="rsCur">
        <button class="rs-btn ignore" @click="rsDo('ignore')">🙅 忽略</button>
        <button class="rs-btn custom" @click="rsOpenCustom">🕐 自选</button>
        <button v-if="rsCur.kind === 'exam'" class="rs-btn plan" @click="rsPlan">📚 周末复习</button>
        <button class="rs-btn accept" @click="rsDo('accept')">👌 接受</button>
      </view>
      <view class="review-tip" v-if="rsCur">
        👉 按住屏幕滑动：右 👌 接受 · 左 🙅 忽略 · 上 🕐 自选{{ rsCur.kind === "exam" ? " · 下 📚 每周末复习到考前" : "" }}
      </view>
    </view>

    <!-- 批奏折·自选时间：点空格子即可，可跨周、可一次选多段 -->
    <view v-if="picker.show" class="sheet-mask picker-mask" @click="picker.show = false">
      <view class="sheet picker-sheet" @click.stop>
        <view class="sheet-title">🕐 点空格子选时间 · {{ rsCustomTitle }}</view>
        <view class="picker-week">
          <text class="pw-nav" :class="{ off: picker.offset <= 0 }" @click="pickerWeek(-1)">‹ 上一周</text>
          <text class="pw-label">{{ pickerWeekLabel }}</text>
          <text class="pw-nav" :class="{ off: picker.offset >= 2 }" @click="pickerWeek(1)">下一周 ›</text>
        </view>
        <scroll-view scroll-y class="picker-grid-wrap">
          <view class="picker-grid">
            <view class="pg-corner"></view>
            <view v-for="d in picker.days" :key="d.date" class="pg-head"
              :class="{ today: d.date === todayStr, past: d.date < todayStr }">
              <text>周{{ DAY[d.weekday % 7] }}</text>
              <text class="pg-date">{{ d.date.slice(5).replace("-", "/") }}</text>
            </view>
            <block v-for="m in pickerHours" :key="m">
              <view class="pg-hour">{{ fmtMin(m) }}</view>
              <view v-for="d in picker.days" :key="d.date + '_' + m"
                class="pg-cell" :class="cellClass(d, m)"
                @click="toggleCell(d, m)"></view>
            </block>
          </view>
        </scroll-view>
        <view class="picker-sum">已选 {{ pickerRanges.length }} 段 · 共 {{ pickerTotalMin }} 分钟（绿色=有空，紫色=已选，再点取消）</view>
        <view class="sheet-btns">
          <button class="btn-plain" @click="picker.show = false">取消</button>
          <button class="btn-primary" :disabled="pickerBusy || !pickerRanges.length" @click="rsSavePicks">
            {{ pickerBusy ? "安排中…" : "就这些，排进日程" }}
          </button>
        </view>
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
      suggestions: [],
      filter: "",
      dismissed: {}, // 本地忽略卡片的 ddl_id
      viewSlotIdx: {}, // 每卡显示第几个候选时段
      showDone: false, // 已完成折叠区
      // 手动/编辑表单
      showForm: false,
      form: { id: null, title: "", course_name: "", d: "", t: "23:59", weight: 2, kind: "task", location: "", note: "", examEnd: "11:00" },
      // 档位说明
      showTierHelp: false,
      // 批奏折（滑动审批）
      showReview: false,
      rsQueue: [], // 待批队列（快照，批一张少一张）
      rsTotal: 0,
      rsSlotIdx: 0,
      dragX: 0,
      dragY: 0,
      rsDir: "", // 滑动方向高亮：accept | ignore | custom
      dragging: false,
      rsCustomShow: false,
      rsCustom: { d: "", t: "09:00", dur: 60 },
      // 自选时间的空闲格点选器（跨周 + 多段）
      picker: { show: false, offset: 0, days: [], sel: {} },
      pickerBusy: false,
      // 完成仪式感
      celebrate: null,
      // 粘贴抽取
      showPaste: false,
      pasteText: "",
      pasteBusy: false,
      parseRows: [],
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
    // 批奏折入口：按档位紧急→从容排，同档按截止时间
    reviewList() {
      const order = { red: 0, yellow: 1, green: 2, overdue: 3 };
      return this.suggestions
        .filter((c) => !this.dismissed[c.ddl_id] && this.wall.concat(this.examList).some((d) => d.id === c.ddl_id))
        .slice()
        .sort((a, b) => (order[a.tier] ?? 9) - (order[b.tier] ?? 9) || String(a.due_at).localeCompare(String(b.due_at)));
    },
    rsCur() {
      return this.rsQueue[0] || null;
    },
    rsCustomTitle() {
      return this.rsCur ? this.rsCur.title : "";
    },
    // 截止前 24h 内还没完成的任务 DDL → 前一天提醒
    remindList() {
      return this.ddls.filter((d) => d.remind && d.status !== "done");
    },
    remindText() {
      return this.remindList.map((x) => x.title).join("、");
    },
    // ---- 空闲格点选器 ----
    todayStr() {
      const n = new Date();
      return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
    },
    pickerMonday() {
      const d = new Date();
      const dow = (d.getDay() + 6) % 7; // 周一=0
      d.setDate(d.getDate() - dow + this.picker.offset * 7);
      d.setHours(0, 0, 0, 0);
      return d;
    },
    pickerWeekLabel() {
      const mon = this.pickerMonday;
      const sun = new Date(mon);
      sun.setDate(sun.getDate() + 6);
      const f = (x) => `${x.getMonth() + 1}/${x.getDate()}`;
      return this.picker.offset === 0 ? `本周 ${f(mon)}-${f(sun)}` : `${f(mon)} - ${f(sun)}`;
    },
    pickerHours() {
      const arr = [];
      for (let m = 8 * 60; m < 22 * 60 + 30; m += 30) arr.push(m);
      return arr;
    },
    // 点选的格子按天合并成连续时间段
    pickerRanges() {
      const ranges = [];
      for (const date of Object.keys(this.picker.sel)) {
        const sorted = [...this.picker.sel[date]].sort((a, b) => a - b);
        if (!sorted.length) continue;
        let lo = sorted[0], prev = sorted[0];
        for (const m of sorted.slice(1)) {
          if (m === prev + 30) { prev = m; continue; }
          ranges.push({ date, lo, hi: prev + 30 });
          lo = m; prev = m;
        }
        ranges.push({ date, lo, hi: prev + 30 });
      }
      return ranges;
    },
    pickerTotalMin() {
      return this.pickerRanges.reduce((s, r) => s + (r.hi - r.lo), 0);
    },
    parseAll() {
      return this.parseRows.length > 0 && this.parseRows.every((r) => r.checked);
    },
    parseCheckedCount() {
      return this.parseRows.filter((r) => r.checked).length;
    },
  },
  onShow() {
    this.loadDismissed();
    this.load();
  },
  methods: {
    async load() {
      try {
        this.ddls = await api.get("/api/ddls");
        const s = await api.get("/api/suggestions");
        this.suggestions = s.cards || [];
      } catch (e) {
        uni.showToast({ title: e.message, icon: "none" });
      }
    },
    sugOf(id) {
      return this.suggestions.find((c) => c.ddl_id === id) || null;
    },
    viewSlot(id) {
      const c = this.sugOf(id);
      if (!c) return 0;
      return (this.viewSlotIdx[id] || 0) < c.slots.length ? this.viewSlotIdx[id] || 0 : 0;
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
    slotText(s) {
      const d = new Date(s.start_at.replace(" ", "T").replace("Z", ""));
      const d2 = new Date(s.end_at.replace(" ", "T").replace("Z", ""));
      const hh = (x) => `${String(x.getHours()).padStart(2, "0")}:${String(x.getMinutes()).padStart(2, "0")}`;
      const day = d2.getMonth() === d.getMonth() && d2.getDate() === d.getDate()
        ? "" : `${d2.getMonth() + 1}/${d2.getDate()} `;
      return `${day}${hh(d)}-${hh(d2)}`;
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
        this.$emit("changed");
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
    async unmute(d) {
      try {
        await api.post(`/api/ddls/${d.id}/unmute`);
        uni.showToast({ title: "已恢复建议 💡", icon: "none" });
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
    // ---- 建议三键（FR-33：接受/换时间/忽略；绝不自动写日程） ----
    async accept(d) {
      const c = this.sugOf(d.id);
      const s = c.slots[this.viewSlot(d.id)];
      if (!s) return;
      try {
        await api.post("/api/suggestions/accept", {
          ddl_id: d.id, start_at: s.start_at, end_at: s.end_at,
        });
        uni.showToast({ title: `已排到 ${this.slotText(s)}`, icon: "none" });
        await this.load();
      } catch (e) {
        uni.showToast({ title: e.message, icon: "none" });
      }
    },
    async changeSlot(d) {
      const c = this.sugOf(d.id);
      if (!c || c.slots.length < 1) return;
      const cur = this.viewSlot(d.id);
      const next = (cur + 1) % c.slots.length;
      // 「换时间」对当前时段记一次降权反馈，其余时段照常展示
      try {
        await api.post("/api/suggestions/feedback", {
          ddl_id: d.id, action: "change", bucket: c.slots[cur].bucket,
        });
      } catch (e) { /* 反馈失败不打断 */ }
      this.viewSlotIdx[d.id] = next;
    },
    async ignore(d) {
      const c = this.sugOf(d.id);
      const s = c ? c.slots[this.viewSlot(d.id)] : null;
      try {
        await api.post("/api/suggestions/feedback", {
          ddl_id: d.id, action: "ignore", bucket: s ? s.bucket : "",
        });
      } catch (e) { /* ignore 失败也不拦 */ }
      this.dismiss(d.id); // 忽略=今天别再烦我（本地记 24 小时）
    },
    // ---- 忽略持久化：存本地 24 小时，刷新/重进页面不再复活 ----
    dismissKey() {
      return "ddl_dismissed_" + (uni.getStorageSync("user_code") || "");
    },
    loadDismissed() {
      try {
        const raw = uni.getStorageSync(this.dismissKey());
        const obj = raw ? JSON.parse(raw) : {};
        const now = Date.now();
        const alive = {};
        for (const k of Object.keys(obj)) {
          if (now - obj[k] < 24 * 3600 * 1000) alive[k] = obj[k];
        }
        this.dismissed = alive;
      } catch (e) {
        this.dismissed = {};
      }
    },
    dismiss(id) {
      this.dismissed = { ...this.dismissed, [id]: Date.now() };
      try {
        uni.setStorageSync(this.dismissKey(), JSON.stringify(this.dismissed));
      } catch (e) { /* 存不下也不影响当次 */ }
    },
    // ---- 批奏折：滑动审批（右滑接受 / 左滑忽略 / 上滑自定义） ----
    openReview() {
      if (!this.reviewList.length) {
        uni.showToast({ title: "没有待批的建议", icon: "none" });
        return;
      }
      this.rsQueue = this.reviewList.slice();
      this.rsTotal = this.rsQueue.length;
      this.rsSlotIdx = 0;
      this.dragX = 0;
      this.dragY = 0;
      this.rsDir = "";
      this.showReview = true;
    },
    closeReview() {
      this.showReview = false;
      this.dragX = 0;
      this.dragY = 0;
      this.rsDir = "";
      this.load();
    },
    rsStart(e) {
      if (!e.touches || !e.touches.length) return;
      this.dragging = true;
      this.dragX0 = e.touches[0].clientX;
      this.dragY0 = e.touches[0].clientY;
    },
    rsMove(e) {
      if (!this.dragging || !e.touches || !e.touches.length) return;
      this.dragX = e.touches[0].clientX - this.dragX0;
      this.dragY = e.touches[0].clientY - this.dragY0;
      if (this.dragX > 40) this.rsDir = "accept";
      else if (this.dragX < -40) this.rsDir = "ignore";
      else if (this.dragY < -40 && Math.abs(this.dragX) < 60) this.rsDir = "custom";
      else if (this.dragY > 40 && Math.abs(this.dragX) < 60
               && this.rsCur && this.rsCur.kind === "exam") this.rsDir = "plan";
      else this.rsDir = "";
    },
    rsEnd() {
      this.dragging = false;
      const dir = this.rsDir;
      this.dragX = 0;
      this.dragY = 0;
      this.rsDir = "";
      if (dir === "accept") this.rsDo("accept");
      else if (dir === "ignore") this.rsDo("ignore");
      else if (dir === "custom") this.rsOpenCustom();
      else if (dir === "plan") this.rsPlan();
    },
    async rsDo(action) {
      const c = this.rsCur;
      if (!c) return;
      const s = c.slots[Math.min(this.rsSlotIdx, c.slots.length - 1)];
      try {
        if (action === "accept" && s) {
          await api.post("/api/suggestions/accept", {
            ddl_id: c.ddl_id, start_at: s.start_at, end_at: s.end_at,
          });
          uni.showToast({ title: `已排到 ${this.slotText(s)}`, icon: "none" });
        } else if (action === "ignore") {
          await api.post("/api/suggestions/feedback", {
            ddl_id: c.ddl_id, action: "ignore", bucket: s ? s.bucket : "",
          });
          this.dismiss(c.ddl_id); // 本地立即消失；后端已永久静音，不会再跳回来
        }
      } catch (e) {
        uni.showToast({ title: e.message, icon: "none" });
      }
      this.rsNext();
    },
    rsNext() {
      this.rsQueue.shift();
      this.rsSlotIdx = 0;
      if (!this.rsQueue.length) {
        this.showReview = false;
        uni.showToast({ title: "批完啦 🎉", icon: "none" });
        this.load();
      }
    },
    rsOpenCustom() {
      if (!this.rsCur) return;
      this.picker = { show: true, offset: 0, days: [], sel: {} };
      this.loadPickerWeek();
    },
    async loadPickerWeek() {
      try {
        const mon = this.pickerMonday;
        const start = `${mon.getFullYear()}-${String(mon.getMonth() + 1).padStart(2, "0")}-${String(mon.getDate()).padStart(2, "0")}`;
        const r = await api.get(`/api/suggestions/free?start=${start}&days=7`);
        this.picker.days = r.days || [];
      } catch (e) {
        uni.showToast({ title: e.message, icon: "none" });
      }
    },
    pickerWeek(delta) {
      const next = this.picker.offset + delta;
      if (next < 0) return; // 不看过去
      if (next > 2) {
        uni.showToast({ title: "最多往后看三周", icon: "none" });
        return;
      }
      this.picker.offset = next;
      this.loadPickerWeek();
    },
    fmtMin(m) {
      return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    },
    cellFree(d, m) {
      return d.segs && d.segs.some(([lo, hi]) => lo <= m && m + 30 <= hi);
    },
    cellClass(d, m) {
      if (d.date < this.todayStr) return { busy: true, past: true };
      const sel = this.picker.sel[d.date];
      return { free: this.cellFree(d, m), busy: !this.cellFree(d, m), sel: !!(sel && sel.includes(m)) };
    },
    toggleCell(d, m) {
      if (d.date < this.todayStr || !this.cellFree(d, m)) return;
      const sel = { ...this.picker.sel };
      const arr = sel[d.date] ? [...sel[d.date]] : [];
      const i = arr.indexOf(m);
      if (i >= 0) arr.splice(i, 1);
      else arr.push(m);
      if (arr.length) sel[d.date] = arr;
      else delete sel[d.date];
      this.picker.sel = sel;
    },
    // 把点选的若干段全部写进日程（每段一个事件，都挂这个 DDL）
    async rsSavePicks() {
      const c = this.rsCur;
      if (!c || !this.pickerRanges.length) return;
      this.pickerBusy = true;
      try {
        for (const r of this.pickerRanges) {
          await api.post("/api/suggestions/accept", {
            ddl_id: c.ddl_id,
            start_at: `${r.date} ${this.fmtMin(r.lo)}:00`,
            end_at: `${r.date} ${this.fmtMin(r.hi)}:00`,
          });
        }
        uni.showToast({
          title: `已排 ${this.pickerRanges.length} 段，共 ${this.pickerTotalMin} 分钟`,
          icon: "none",
        });
        this.picker.show = false;
        this.dismiss(c.ddl_id);
        this.rsNext();
      } catch (e) {
        uni.showToast({ title: e.message, icon: "none" });
      } finally {
        this.pickerBusy = false;
      }
    },
    // 考试专属：每个周末排一段整块复习，一直到考前
    async rsPlan() {
      const c = this.rsCur;
      if (!c) return;
      try {
        const evs = await api.post("/api/suggestions/review-plan", { ddl_id: c.ddl_id });
        uni.showToast({ title: `已排 ${evs.length} 个周末复习 📚`, icon: "none" });
        this.dismiss(c.ddl_id);
        this.rsNext();
      } catch (e) {
        uni.showToast({ title: e.message, icon: "none" });
      }
    },
    // ---- 粘贴抽取 ----
    openPaste() {
      this.pasteText = "";
      this.parseRows = [];
      this.showPaste = true;
    },
    async parsePaste() {
      if (!this.pasteText.trim()) {
        uni.showToast({ title: "先粘贴点通知文字", icon: "none" });
        return;
      }
      this.pasteBusy = true;
      try {
        const res = await api.post("/api/ddls/parse", { text: this.pasteText });
        this.parseRows = (res.ddls || []).map((x) => ({
          checked: true,
          title: x.title,
          course_name: x.course_name || "",
          due: x.due_at.replace(" ", "T").replace("Z", ""),
          weight: x.weight,
          kind: x.kind || "task",
        }));
        if (!this.parseRows.length) uni.showToast({ title: "没抽到 DDL，检查下有没有带日期", icon: "none" });
      } catch (e) {
        uni.showToast({ title: e.message, icon: "none" });
      } finally {
        this.pasteBusy = false;
      }
    },
    toggleParseAll() {
      const t = !this.parseAll;
      this.parseRows.forEach((r) => (r.checked = t));
    },
    async saveParse() {
      const picked = this.parseRows.filter((r) => r.checked);
      if (!picked.length) {
        uni.showToast({ title: "至少选一个", icon: "none" });
        return;
      }
      this.pasteBusy = true;
      try {
        await api.post("/api/ddls/batch", {
          ddls: picked.map((r) => ({
            title: r.title.trim(),
            course_name: (r.course_name || "").trim(),
            due_at: r.due.replace("T", " "),
            weight: r.weight,
            kind: r.kind || "task",
          })),
        });
        uni.showToast({ title: `已加 ${picked.length} 个 DDL`, icon: "success" });
        this.showPaste = false;
        await this.load();
      } catch (e) {
        uni.showToast({ title: e.message, icon: "none" });
      } finally {
        this.pasteBusy = false;
      }
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

.paste-row {
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 20rpx;
  font-size: 26rpx;
  color: #374151;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.arrow { color: #c7cbd6; font-size: 30rpx; }

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
.muted-tag {
  display: inline-block;
  margin-top: 8rpx;
  font-size: 21rpx;
  color: #6b7280;
  background: #f3f4f6;
  border-radius: 999rpx;
  padding: 6rpx 16rpx;
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
.sub { font-size: 22rpx; color: #8a91a3; overflow-wrap: break-word; }
.remain { font-size: 24rpx; font-weight: 600; }
.remain.red, .remain.overdue { color: #dc2626; }
.remain.yellow { color: #d97706; }
.remain.green { color: #059669; }

.ddl-ops { flex-shrink: 0; display: flex; gap: 10rpx; align-items: center; }
.op {
  font-size: 22rpx;
  color: #4f46e5;
  background: #eef2ff;
  padding: 8rpx 16rpx;
  border-radius: 999rpx;
}
.op.danger { color: #dc2626; background: #fee2e2; }

/* 建议块 */
.sug {
  margin-top: 20rpx;
  background: #f5f7ff;
  border-radius: 12rpx;
  padding: 20rpx;
}
.sug-title { font-size: 24rpx; color: #4338ca; margin-bottom: 16rpx; }
.slot-chips { display: flex; gap: 12rpx; flex-wrap: wrap; margin-bottom: 16rpx; }
.slot-chip {
  font-size: 22rpx;
  color: #4b5563;
  background: #fff;
  border: 2rpx solid #e5e7eb;
  border-radius: 999rpx;
  padding: 8rpx 20rpx;
}
.slot-chip.on {
  color: #fff;
  background: #4f46e5;
  border-color: #4f46e5;
  font-weight: 600;
}
.sug-btns { display: flex; gap: 12rpx; }
.sug-accept {
  flex: 2;
  margin: 0;
  background: #4f46e5;
  color: #fff;
  font-size: 24rpx;
  border-radius: 10rpx;
  height: 68rpx;
  line-height: 68rpx;
  border: none;
}
.sug-plain {
  flex: 1;
  margin: 0;
  background: #eef2ff;
  color: #4f46e5;
  font-size: 24rpx;
  border-radius: 10rpx;
  height: 68rpx;
  line-height: 68rpx;
  border: none;
}
.sug-accept::after, .sug-plain::after { border: none; }

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
.sheet.tall { overflow-y: auto; max-height: 88vh; }
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
.w-chips.mini { flex: none; gap: 8rpx; }
.w-mini {
  font-size: 22rpx;
  color: #6b7280;
  background: #f5f6fa;
  padding: 6rpx 20rpx;
  border-radius: 999rpx;
}
.w-mini.on { color: #fff; background: #4f46e5; }

/* 粘贴抽取 */
.ta {
  width: 100%;
  height: 240rpx;
  background: #f5f6fa;
  border-radius: 12rpx;
  padding: 20rpx;
  font-size: 26rpx;
  box-sizing: border-box;
}
.btn-row { margin-top: 24rpx; }
.result-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin: 32rpx 0 16rpx;
  font-size: 26rpx;
  color: #4b5563;
}
.toggle-all { color: #4f46e5; }
.row-card {
  background: #f5f6fa;
  border-radius: 12rpx;
  padding: 20rpx;
  margin-bottom: 16rpx;
  display: flex;
  flex-direction: column;
  gap: 14rpx;
}
.row-card.off { opacity: 0.5; }
.row-top { display: flex; align-items: center; gap: 14rpx; }
.ck {
  width: 40rpx; height: 40rpx;
  border: 2rpx solid #c7cbdb;
  border-radius: 10rpx;
  display: flex; align-items: center; justify-content: center;
  color: #fff; font-size: 24rpx; flex-shrink: 0;
}
.ck.on { background: #4f46e5; border-color: #4f46e5; }
.name-input { flex: 1; font-size: 28rpx; font-weight: 600; min-width: 0; }
.del { color: #b0b5c1; padding: 4rpx 8rpx; }
.row-mid { display: flex; align-items: center; justify-content: space-between; }
.due-tag { font-size: 24rpx; color: #d97706; }
.loc-input { background: #fff; border-radius: 10rpx; padding: 12rpx 16rpx; font-size: 24rpx; }
.save-row { margin-top: 12rpx; }

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

/* 批奏折入口 */
.review-entry {
  background: linear-gradient(135deg, #4f46e5, #7c3aed);
  color: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 20rpx;
  font-size: 27rpx;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: space-between;
  box-shadow: 0 6rpx 18rpx rgba(79, 70, 229, 0.25);
}
.review-entry .arrow { color: rgba(255, 255, 255, 0.7); }

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
.exam-tag { color: #b91c1c; font-weight: 600; }
.w-chips.lock { opacity: 0.55; }

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

/* 批奏折：朱红鎏金奏折风 */
.review-mask {
  position: fixed;
  inset: 0;
  background: linear-gradient(180deg, #7f1d1d, #450a0a 70%, #290505);
  z-index: 110;
  display: flex;
  flex-direction: column;
  padding: 40rpx 32rpx 60rpx;
  box-sizing: border-box;
}
.review-head {
  display: flex;
  align-items: center;
  gap: 20rpx;
  margin-bottom: 20rpx;
}
.review-title { color: #fde68a; font-size: 38rpx; font-weight: 800; flex: 1; letter-spacing: 4rpx; }
.review-count { color: rgba(253, 230, 138, 0.75); font-size: 24rpx; }
.review-close { color: rgba(255, 255, 255, 0.75); font-size: 36rpx; padding: 0 12rpx; }
/* 整屏都是滑动区：在屏幕任意处按住拖都行 */
.review-stage {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  touch-action: none;
}
/* 三个方向指示：贴边常驻半透，拖向该方向时放大点亮，防划错 */
.rs-flag {
  position: absolute;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8rpx;
  opacity: 0.45;
  transition: opacity 0.12s, transform 0.12s;
  z-index: 3;
}
.rs-flag.hot { opacity: 1; transform: scale(1.18); }
.rs-flag-ico { font-size: 72rpx; line-height: 1; }
.rs-flag-txt { font-size: 30rpx; font-weight: 700; padding: 6rpx 22rpx; border-radius: 999rpx; }
.rs-flag.left { left: 10rpx; top: 50%; margin-top: -90rpx; }
.rs-flag.left .rs-flag-txt { color: #fecaca; background: rgba(220, 38, 38, 0.4); }
.rs-flag.left.hot .rs-flag-ico { filter: drop-shadow(0 0 18rpx rgba(239, 68, 68, 0.9)); }
.rs-flag.right { right: 10rpx; top: 50%; margin-top: -90rpx; }
.rs-flag.right .rs-flag-txt { color: #bbf7d0; background: rgba(5, 150, 105, 0.4); }
.rs-flag.right.hot .rs-flag-ico { filter: drop-shadow(0 0 18rpx rgba(16, 185, 129, 0.9)); }
.rs-flag.top { left: 50%; top: 6rpx; margin-left: -80rpx; }
.rs-flag.top .rs-flag-txt { color: #ddd6fe; background: rgba(124, 58, 237, 0.4); }
.rs-flag.top.hot .rs-flag-ico { filter: drop-shadow(0 0 18rpx rgba(139, 92, 246, 0.9)); }
.rs-flag.bottom { left: 50%; bottom: 6rpx; margin-left: -110rpx; }
.rs-flag.bottom .rs-flag-txt { color: #fde68a; background: rgba(217, 119, 6, 0.45); }
.rs-flag.bottom.hot .rs-flag-ico { filter: drop-shadow(0 0 18rpx rgba(245, 158, 11, 0.95)); }
/* 竖长方形奏折卡：大、挺括，顶部按档位着色 */
.rs-card {
  width: 560rpx;
  min-height: 720rpx;
  background: #fffdf7;
  border-radius: 20rpx;
  padding: 44rpx 40rpx;
  box-sizing: border-box;
  box-shadow: 0 24rpx 70rpx rgba(0, 0, 0, 0.5);
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  transition: transform 0.15s ease-out;
}
.rs-card::before {
  content: "";
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 14rpx;
}
.rs-card.red::before { background: linear-gradient(90deg, #dc2626, #ef4444); }
.rs-card.yellow::before { background: linear-gradient(90deg, #d97706, #f59e0b); }
.rs-card.green::before { background: linear-gradient(90deg, #059669, #10b981); }
.rs-card.overdue::before { background: #6b7280; }
.rs-card.accept { box-shadow: 0 24rpx 80rpx rgba(16, 185, 129, 0.55); }
.rs-card.ignore { box-shadow: 0 24rpx 80rpx rgba(220, 38, 38, 0.55); }
.rs-card.custom { box-shadow: 0 24rpx 80rpx rgba(124, 58, 237, 0.55); }
.rs-tier-row { display: flex; align-items: center; gap: 14rpx; margin-top: 8rpx; }
.rs-tier { display: inline-block; }
.rs-exam-tag {
  font-size: 22rpx;
  color: #b91c1c;
  background: #fee2e2;
  border-radius: 999rpx;
  padding: 6rpx 18rpx;
  font-weight: 700;
}
.rs-title { font-size: 38rpx; font-weight: 800; margin: 22rpx 0 12rpx; color: #1f2333; line-height: 1.4; }
.rs-sub { font-size: 26rpx; color: #8a91a3; margin-top: 8rpx; }
.rs-due { color: #4b5563; }
.rs-remain { font-size: 30rpx; font-weight: 700; margin-top: 12rpx; }
.rs-remain.red, .rs-remain.overdue { color: #dc2626; }
.rs-remain.yellow { color: #d97706; }
.rs-remain.green { color: #059669; }
.rs-divider { height: 1rpx; background: #f0e9d8; margin: 30rpx 0 24rpx; }
.rs-slot-label { font-size: 25rpx; color: #6b7280; margin-bottom: 16rpx; }
.rs-chips { margin-bottom: 18rpx; }
.rs-chips .slot-chip { font-size: 25rpx; padding: 12rpx 24rpx; }
.rs-reason { font-size: 25rpx; color: #4338ca; line-height: 1.6; }
.rs-empty { display: flex; flex-direction: column; align-items: center; gap: 14rpx; }
.rs-empty-icon { font-size: 100rpx; }
.rs-empty-title { color: #fde68a; font-size: 40rpx; font-weight: 800; }
.rs-empty-sub { color: rgba(253, 230, 138, 0.65); font-size: 26rpx; }
.review-btns { display: flex; gap: 20rpx; margin-top: 24rpx; }
.rs-btn {
  flex: 1;
  margin: 0;
  border-radius: 16rpx;
  height: 92rpx;
  line-height: 92rpx;
  font-size: 29rpx;
  font-weight: 700;
  border: none;
  color: #fff;
}
.rs-btn::after { border: none; }
.rs-btn.ignore { background: rgba(220, 38, 38, 0.9); }
.rs-btn.custom { background: rgba(124, 58, 237, 0.92); }
.rs-btn.plan { background: rgba(217, 119, 6, 0.92); }
.rs-btn.accept { background: rgba(5, 150, 105, 0.92); }
.review-tip { text-align: center; color: rgba(253, 230, 138, 0.55); font-size: 23rpx; margin-top: 18rpx; }

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

/* 自选时间·空闲格点选器 */
.picker-mask { align-items: flex-end; }
.picker-sheet { max-height: 92vh; display: flex; flex-direction: column; }
.picker-mask { z-index: 140; } /* 批奏折全屏层 z110 之上，否则自选时间不跳转 */
.picker-week {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16rpx;
}
.pw-nav { font-size: 26rpx; color: #4f46e5; font-weight: 600; padding: 8rpx 16rpx; }
.pw-nav.off { color: #c7cbd6; }
.pw-label { font-size: 27rpx; font-weight: 700; color: #1f2333; }
.picker-grid-wrap { flex: 1; height: 560rpx; }
.picker-grid {
  display: grid;
  grid-template-columns: 64rpx repeat(7, 1fr);
  gap: 3rpx;
}
.pg-corner { position: sticky; top: 0; }
.pg-head {
  position: sticky;
  top: 0;
  z-index: 2;
  background: #f5f6fa;
  border-radius: 8rpx;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8rpx 0;
  font-size: 22rpx;
  color: #4b5563;
}
.pg-head.today { background: #eef2ff; color: #4f46e5; font-weight: 700; }
.pg-head.past { opacity: 0.4; }
.pg-date { font-size: 20rpx; color: #8a91a3; }
.pg-hour {
  font-size: 18rpx;
  color: #b0b5c1;
  text-align: right;
  padding-right: 6rpx;
  height: 34rpx;
  line-height: 34rpx;
  position: sticky;
  left: 0;
  background: #fff;
}
.pg-cell {
  height: 34rpx;
  border-radius: 6rpx;
  background: #f1f2f6; /* 忙/无空 */
}
.pg-cell.free { background: #d1fae5; } /* 有空：浅绿 */
.pg-cell.free:active { background: #a7f3d0; }
.pg-cell.sel { background: #7c3aed; } /* 已选：紫 */
.pg-cell.past { background: #e5e7eb; }
.picker-sum {
  font-size: 24rpx;
  color: #6b7280;
  padding: 16rpx 4rpx 0;
}

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
