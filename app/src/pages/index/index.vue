<template>
  <view class="page" :class="{ narrow: !isWide, wide: isWide }">
    <!-- 无学期引导 -->
    <view v-if="!term" class="empty">
      <text class="empty-title">还没设置学期</text>
      <text class="empty-sub">先告诉 App 这学期什么时候开学，才能推算教学周</text>
      <button class="btn-primary" @click="goTerm">设置学期</button>
    </view>

    <block v-else>
      <!-- 周切换 -->
      <view class="week-bar">
        <view class="wk-btn" @click="shiftWeek(-1)">‹ 上一周</view>
        <view class="wk-cur" @click="goTerm">
          <text>第 {{ week }} / {{ term.total_weeks }} 周 · 本周 {{ weekCount }} 门课</text>
          <text v-if="week === term.current_week" class="wk-now">当前</text>
        </view>
        <view class="wk-btn" @click="shiftWeek(1)">下一周 ›</view>
      </view>

      <!-- 工具入口 -->
      <view class="tool-bar">
        <view class="tool-btn" @click="go('/pages/add/add')">➕ 添加日程</view>
        <view class="tool-btn" @click="go('/pages/ddl/ddl')">⏰ DDL<template v-if="ddlOpenCount > 0"> {{ ddlOpenCount }}</template></view>
        <view class="tool-btn" @click="go('/pages/profile/profile')">👤 主页</view>
      </view>

      <!-- FR-51 今日概览：打开即看今天的课 + 临近 DDL + 建议数，单屏 -->
      <view v-if="hasToday" class="today-card">
        <view class="today-head" @click="go('/pages/ddl/ddl')">
          <text>📋 今天 {{ todayText }}</text>
          <text class="today-stat">{{ todayView.courses.length }} 门课<template v-if="todayView.ddls.length"> · ⏰ {{ todayView.ddls.length }} 个 DDL</template></text>
        </view>
        <view v-for="c in todayView.courses.slice(0, 3)" :key="'c' + c.id" class="today-row" @click="onCourse(c)">
          <text class="today-time">{{ courseTimeText(c) }}</text>
          <text class="today-name">{{ c.name }}<text v-if="c.location" class="today-loc"> 📍{{ c.location }}</text></text>
        </view>
        <view v-for="d in todayView.ddls" :key="'d' + d.id" class="today-row ddl" @click="go('/pages/ddl/ddl')">
          <text class="today-time">⏰ {{ String(d.due_at).slice(11, 16) }}</text>
          <text class="today-name">{{ d.title }}</text>
          <text class="today-tag" :class="d.tier">{{ d.remain_text }}</text>
        </view>
      </view>

      <!-- 时间冲突入口：可视化小课表里点哪块删/改哪边 -->
      <view v-if="conflicts.length" class="conflict-card" @click="openConflicts">
        <text class="conflict-head">⚠️ 发现 {{ conflicts.length }} 处时间冲突</text>
        <text class="conflict-go">点这里处理 ›</text>
      </view>

      <!-- 课表头部：星期行（当天有 DDL 的列挂红色小药丸，区别于课/日程块） -->
      <view class="grid-head">
        <view class="col-label"></view>
        <view class="col-day" v-for="d in 7" :key="d">
          <text class="day-name">周{{ DAY_NAMES[d - 1] }}</text>
          <view v-if="ddlChips(d).length" class="ddl-chips" @click="go('/pages/ddl/ddl')">
            <view v-for="(c, i) in ddlChips(d)" :key="i" class="ddl-chip" :class="c.tier">
              {{ c.kind === "exam" ? "📝" : "⏰" }}{{ shortTitle(c.title) }}
            </view>
            <view v-if="ddlMore(d) > 0" class="ddl-chip more">+{{ ddlMore(d) }}</view>
          </view>
        </view>
      </view>

      <!-- 课表网格：节次列 + 7 天。课前/课后的留白区不再强调"无课"，
           时刻直接标在节次列（对齐整时线），不占额外宽度 -->
      <view class="grid-body">
        <view class="col-labels">
          <view v-if="padTopMin > 0" class="pad-cell" :style="{ height: (padTopMin * rowH / 60) + 'rpx' }"></view>
          <view
            v-for="l in hourLines"
            :key="'pt' + l.h"
            class="pad-time"
            :style="{ top: l.y + 'rpx' }"
          >{{ l.h }}:00</view>
          <view v-for="s in SLOT_COUNT" :key="s" class="slot-label">
            <text class="slot-no">{{ s }} <text class="slot-time">{{ SLOT_TIMES[s - 1][0] }}-{{ SLOT_TIMES[s - 1][1] }}</text></text>
            <text v-if="slotGaps[s - 1] > 0" class="slot-gap">课间{{ slotGaps[s - 1] }}分</text>
          </view>
        </view>
        <view class="days">
          <view class="grid-lines">
            <view
              v-for="l in hourLines"
              :key="'gl' + l.h"
              class="grid-line"
              :class="{ strong: l.strong }"
              :style="{ top: l.y + 'rpx' }"
            ></view>
          </view>
          <view v-for="d in 7" :key="d" class="day-col">
            <view v-if="padTopMin > 0" class="slot-cell pad-cell-day" :style="{ height: (padTopMin * rowH / 60) + 'rpx' }"></view>
            <view v-for="s in SLOT_COUNT" :key="s" class="slot-cell"></view>
            <view v-if="padBottomMin > 0" class="slot-cell pad-cell-day" :style="{ height: (padBottomMin * rowH / 60) + 'rpx', borderBottom: 'none' }"></view>
            <view
              v-for="c in rows[d]"
              :key="c.id"
              class="course"
              :style="courseStyle(c)"
              @click="onCourse(c)"
            >
              <text class="course-name" :style="{ color: courseColor(c.name)[1] }">{{ c.name }}</text>
              <text class="course-loc" v-if="c.location">📍 {{ c.location }}</text>
              <text class="course-teacher" v-if="c.teacher">👤 {{ c.teacher }}</text>
            </view>
            <view
              v-for="ev in eventRows[d]"
              :key="'e' + ev.id"
              class="ev-block"
              :style="[eventStyle(ev), evTone(ev)]"
              @click="openEventSheet(ev)"
            >
              <text class="ev-title" :style="{ color: evTone(ev).tt, fontSize: evFont(ev).title + 'rpx' }">{{ ev.icon || defaultIcon }} {{ ev.title }}</text>
              <text class="ev-time" :style="{ color: evTone(ev).tt, fontSize: evFont(ev).sub + 'rpx' }">{{ evRangeText(ev) }}</text>
              <text class="ev-note" v-if="ev.note && evFont(ev).showNote" :style="{ color: evTone(ev).tt, fontSize: evFont(ev).note + 'rpx' }">{{ ev.note }}</text>
            </view>
          </view>
        </view>
      </view>
    </block>

    <!-- 课程详情：点框外直接退出（无关闭按钮），管理收进右上角 ⋯，以后好加项 -->
    <view v-if="showCourse && courseDetail" class="sheet-mask" @click="closeCourse">
      <view class="sheet course-sheet" @click.stop>
        <view class="course-sheet-head">
          <view class="course-sheet-title">
            <view class="course-dot" :style="{ background: courseColor(courseDetail.name)[0] }"></view>
            <text class="course-sheet-name">{{ courseDetail.name }}</text>
          </view>
          <text class="course-menu" @click="courseMenu">⋯</text>
        </view>
        <view class="course-sheet-body">
          <view class="course-row" v-if="courseDetail.teacher">
            <text class="cr-label">教师</text><text class="cr-val">👤 {{ courseDetail.teacher }}</text>
          </view>
          <view class="course-row">
            <text class="cr-label">地点</text><text class="cr-val">📍 {{ courseDetail.location || "地点未知" }}</text>
          </view>
          <view class="course-row">
            <text class="cr-label">时间</text><text class="cr-val">🕐 {{ courseSlotText(courseDetail) }}</text>
          </view>
          <view class="course-row">
            <text class="cr-label">周次</text><text class="cr-val">📅 {{ courseWeeksText(courseDetail) }}</text>
          </view>
          <view class="course-row" v-if="courseDetail.remark">
            <text class="cr-label">备注</text><text class="cr-val">📝 {{ courseDetail.remark }}</text>
          </view>
        </view>
        <view class="course-sheet-tip">点框外退出 · 右上角 ⋯ 管理</view>
      </view>
    </view>

    <!-- 加课弹层 -->
    <view v-if="showAdd" class="sheet-mask" @click="showAdd = false">
      <view class="sheet" @click.stop>
        <view class="sheet-title">{{ addTitle || "添加课程" }}</view>
        <view class="form-row">
          <text class="label">课程名</text>
          <input v-model="form.name" placeholder="如 高等数学" />
        </view>
        <view class="form-row">
          <text class="label">教师</text>
          <input v-model="form.teacher" placeholder="可选" />
        </view>
        <view class="form-row">
          <text class="label">地点</text>
          <input v-model="form.location" placeholder="如 教三-301" />
        </view>
        <view class="form-row">
          <text class="label">周几</text>
          <picker :range="dayRange" :value="form.day_of_week - 1" @change="(e) => (form.day_of_week = e.detail.value + 1)">
            <view class="picker-val">{{ dayRange[form.day_of_week - 1] }} ▾</view>
          </picker>
        </view>
        <view class="form-row">
          <text class="label">节次</text>
          <picker :range="slotRange" :value="form.start_slot - 1" @change="(e) => (form.start_slot = e.detail.value + 1)">
            <view class="picker-val">{{ slotRange[form.start_slot - 1] }}</view>
          </picker>
          <text class="label">至</text>
          <picker :range="slotRange" :value="form.end_slot - 1" @change="(e) => (form.end_slot = e.detail.value + 1)">
            <view class="picker-val">{{ slotRange[form.end_slot - 1] }} ▾</view>
          </picker>
        </view>
        <view class="form-row" v-if="courseFormMode === 'move'">
          <text class="label">原周次</text>
          <input v-model="form.fromWeekText" placeholder="如 10" />
          <text class="to-label">→</text>
          <text class="label">调到</text>
          <input v-model="form.weeksText" placeholder="如 12 或 12,13" />
        </view>
        <view class="form-row" v-else>
          <text class="label">周次</text>
          <input v-model="form.weeksText" :placeholder="weeksPlaceholder" />
        </view>
        <view class="hint-row">{{ courseFormMode === "move" ? "原周次从这门课里移除，新周次生成调课记录（时间地点可改）" : "单双周写 1,3,5，区间写 14-16，留空 = 每周都上" }}</view>
        <view class="sheet-btns">
          <button class="btn-plain" @click="showAdd = false">取消</button>
          <button class="btn-primary" @click="saveCourse">保存</button>
        </view>
      </view>
    </view>

    <!-- 日程详情弹层：只看，改/删去 主页 → 我的日程 -->
    <view v-if="showEvSheet" class="sheet-mask" @click="showEvSheet = false">
      <view class="sheet" @click.stop>
        <view class="sheet-title">日程详情</view>
        <view class="detail-title">{{ evDraft.icon || defaultIcon }} {{ evDraft.title }}</view>
        <view class="detail-row"><text class="d-label">时间</text><text class="d-val">{{ evDetailTime }}</text></view>
        <view class="detail-row"><text class="d-label">状态</text><text class="d-val">{{ evStatusLabel }}</text></view>
        <view v-if="evDraft.loc" class="detail-row"><text class="d-label">地点</text><text class="d-val">{{ evDraft.loc }}</text></view>
        <view v-if="evDraft.note" class="detail-row"><text class="d-label">备注</text><text class="d-val">{{ evDraft.note }}</text></view>
        <view v-if="evSeriesN > 1" class="detail-row"><text class="d-label">重复</text><text class="d-val">🔁 共 {{ evSeriesN }} 条（改/删按单条操作）</text></view>
        <view class="sheet-btns">
          <button class="btn-primary" @click="showEvSheet = false">知道了</button>
        </view>
      </view>
    </view>

    <!-- 已排的 DDL 安排 / 考试本体：轻量确认（不是编辑表单），点框外退出 -->
    <view v-if="showSugEv && sugEv" class="sheet-mask" @click="showSugEv = false">
      <view class="sheet sug-ev-sheet" @click.stop>
        <view class="sheet-title">{{ sugEvMode === "exam" ? "📝 考试" : "📌 已排好的时间" }}</view>
        <view class="sug-ev-body" :class="{ exam: sugEvMode === 'exam' }">
          <text class="sug-ev-title">{{ sugEv.title }}</text>
          <text class="sug-ev-time">🕐 {{ evRangeText(sugEv) }}</text>
          <text v-if="sugEv.location" class="sug-ev-loc">📍 {{ sugEv.location }}</text>
          <text v-if="sugEv.note" class="sug-ev-note">{{ sugEv.note }}</text>
          <text class="sug-ev-hint">{{ sugEvMode === "exam" ? "考试时间/地点/备注在 DDL 页改" : "关联 DDL 的时间安排 · 做完了就点「完成 DDL」打卡" }}</text>
        </view>
        <view class="sheet-btns" v-if="sugEvMode !== 'exam'">
          <button class="btn-plain" @click="delSugEv">删除安排</button>
          <button class="btn-primary" @click="doneSugEv">✓ 完成 DDL</button>
        </view>
        <view class="sheet-btns" v-else>
          <button class="btn-primary" @click="go('/pages/ddl/ddl')">去 DDL 页管理</button>
        </view>
      </view>
    </view>

    <!-- 冲突处理：迷你时间表可视化，点色块选边，再改/删 -->
    <view v-if="showConflicts" class="sheet-mask conflict-mask" @click="showConflicts = false">
      <view class="sheet conflict-sheet" @click.stop>
        <view class="sheet-title">⚠️ 时间冲突（{{ conflicts.length }}）· 点色块选要处理的一侧</view>
        <scroll-view scroll-y class="cf-list">
          <view v-for="(c, i) in conflicts" :key="i" class="cf-item">
            <text class="cf-text">{{ c.text }}</text>
            <view class="cf-axis">
              <view
                v-for="(it, j) in c.items"
                :key="j"
                class="cf-block"
                :class="{ sel: selConflict === i && selItem === j, course: it.type === 'course' }"
                :style="cfBlockStyle(c, it, j)"
                @click="selConflict = i; selItem = j"
              >
                <text class="cf-block-t">{{ it.title }}</text>
                <text class="cf-block-s">{{ cfRange(it) }}</text>
              </view>
            </view>
            <view v-if="selConflict === i && selItem !== null" class="cf-actions">
              <text class="cf-act" @click="cfEdit">✏️ 改时间</text>
              <text class="cf-act danger" @click="cfDelete">🗑 删除</text>
            </view>
          </view>
          <view v-if="!conflicts.length" class="cf-empty">🎉 冲突都处理完了</view>
        </scroll-view>
        <view class="sheet-btns">
          <button class="btn-plain" @click="showConflicts = false">关闭</button>
        </view>
      </view>
    </view>
  </view>
</template>

<script>
import { api, parseWeeks } from "../../utils/api";
import { DAY_NAMES, DEFAULT_EVENT_ICON, EVENT_ICONS, SLOT_COUNT, SLOT_TIMES, TIME_STATUS, courseColor } from "../../utils/slots";

const hms = (t) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};
const SCHOOL_START = () => hms(SLOT_TIMES[0][0]); // 第 1 节开始
const SCHOOL_END = () => hms(SLOT_TIMES[SLOT_TIMES.length - 1][1]); // 末节结束

export default {
  data() {
    return {
      term: null,
      courses: [],
      events: [],
      week: 1,
      rows: {}, // 按周几(1-7)分组的本周课程，applyRows() 生成
      eventRows: {}, // 按周几(1-7)分组的本周速记日程，applyEvents() 生成
      weekDates: [], // 本周 7 天的 "YYYY-MM-DD"，applyEvents() 生成，跨天日程按天切分用
      isWide: true, // 宽屏/横屏=完整信息；竖屏手机=关键信息模式（课名两行，细节点卡片）
      weekCount: 0,
      ddlOpenCount: 0,
      ddls: [], // 表头 DDL 药丸用（loadDdlCount 拉）
      showAdd: false,
      form: { name: "", location: "", day_of_week: 1, start_slot: 1, end_slot: 1, weeksText: "" },
      weeksPlaceholder: "",
      DAY_NAMES,
      SLOT_COUNT,
      SLOT_TIMES,
      slotGaps: SLOT_TIMES.slice(0, -1).map((t, i) => hms(SLOT_TIMES[i + 1][0]) - hms(t[1])),
      courseColor, // 模板里要用，必须挂到实例上
      dayRange: DAY_NAMES.map((d) => "周" + d),
      slotRange: SLOT_TIMES.map((t, i) => `第${i + 1}节 ${t[0]}-${t[1]}`),
      // 网格几何（computeGrid 依据"这一周的日程"重算）：
      //   gridStartMin          网格顶对应的时刻（分钟），event/course 都靠它换算 top
      //   padTopMin / padBottomMin  首节之前 / 末节之后的"无课留白"分钟数
      //   hourLines             只在留白里出现的整时线（有课区已自带每节时间标注，不叠整时线）
      gridStartMin: 480,
      padTopMin: 0,
      padBottomMin: 0,
      hourLines: [],
      evColors: [
        { bg: "#fffbeb", bd: "#f59e0b", tt: "#b45309", nm: "琥珀" },
        { bg: "#fdf2f8", bd: "#db2777", tt: "#be185d", nm: "粉" },
        { bg: "#f0f9ff", bd: "#0284c7", tt: "#0369a1", nm: "天蓝" },
        { bg: "#ecfdf5", bd: "#059669", tt: "#047857", nm: "绿" },
        { bg: "#faf5ff", bd: "#9333ea", tt: "#7e22ce", nm: "紫" },
        { bg: "#f5f6fa", bd: "#94a3b8", tt: "#475569", nm: "灰" },
      ],
      showEvSheet: false,
      _evId: null,
      evDraft: { title: "", note: "", icon: "", loc: "", timeStatus: "exact", sd: "", st: "", ed: "", et: "" },
      evSeriesN: 0, // 详情弹层显示的重复条数（改/删在主页按单条操作）
      eventIcons: EVENT_ICONS,
      defaultIcon: DEFAULT_EVENT_ICON,
      timeStatuses: TIME_STATUS,
      addTitle: "",
      courseFormMode: "add",
      showCourse: false, // 课程详情弹层（点框外退出，管理收在右上角 ⋯）
      courseDetail: null,
      showSugEv: false, // 📌 已排 DDL 安排 / 📝 考试的轻量确认弹层
      sugEv: null,
      sugEvMode: "sug", // sug=批奏折安排 | exam=考试本体
      conflicts: [], // 全量扫描出的时间冲突（主页集中改/删）
      showConflicts: false,
      selConflict: -1,
      selItem: -1,
      todayView: { courses: [], ddls: [], sugCount: 0 }, // FR-51 今日概览
    };
  },
  computed: {
    // 一节课的行高（rpx）：横屏/宽屏用紧凑行高，同屏能看更多节次
    rowH() {
      return this.isWide ? 78 : 100;
    },
    // FR-51：今天日期文案 + 是否值得显示概览卡
    todayText() {
      const n = new Date();
      return `${n.getMonth() + 1}/${n.getDate()} 周${DAY_NAMES[(n.getDay() || 7) - 1]}`;
    },
    hasToday() {
      const v = this.todayView;
      return v.courses.length || v.ddls.length || v.sugCount;
    },
    // 详情弹层：时间一行字（同一天只写一次日期）
    evDetailTime() {
      const d = this.evDraft;
      return d.ed === d.sd
        ? `${d.sd} ${d.st}–${d.et}`
        : `${d.sd} ${d.st} → ${d.ed} ${d.et}`;
    },
    evStatusLabel() {
      const t = TIME_STATUS.find((x) => x.key === (this.evDraft.timeStatus || "exact"));
      return t ? t.label.slice(2) : "准点";
    },
  },
  async onShow() {
    this.updateWide();
    await this.load();
    // 主页「添加课程」跳转过来时自动弹加课表单。
    // 用一次性存储标记而不是网址参数——参数会留在地址栏，浏览器刷新会再触发一次
    const autoAdd = uni.getStorageSync("_autoAdd");
    if (autoAdd) {
      uni.removeStorageSync("_autoAdd");
      if (this.term) this.openAdd(); // 没设学期时不弹，让用户先看到设置学期引导
    }
  },
  mounted() {
    this.updateWide();
    // 横竖屏切换实时响应（H5 + App 通用 API）
    this._onWinResize = () => this.updateWide();
    if (uni.onWindowResize) uni.onWindowResize(this._onWinResize);
  },
  beforeUnmount() {
    if (this._onWinResize && uni.offWindowResize) {
      uni.offWindowResize(this._onWinResize);
    }
  },
  methods: {
    updateWide() {
      try {
        const info = uni.getSystemInfoSync();
        const w = info.windowWidth || info.screenWidth;
        const h = info.windowHeight || info.screenHeight;
        const was = this.isWide;
        this.isWide = w >= 600 || w > h;
        // 横竖屏切换改变行高 → 课程/日程块的坐标全部重算（hourLines 在 applyEvents 里建）
        if (was !== this.isWide && this.term) this.applyRows();
      } catch (e) {
        this.isWide = true;
      }
    },
    async load() {
      try {
        this.term = await api.get("/api/terms");
        this.week = Math.min(Math.max(this.term.current_week, 1), this.term.total_weeks);
      } catch (e) {
        this.term = null;
        return;
      }
      this.courses = await api.get("/api/courses");
      try {
        this.events = await api.get("/api/events");
      } catch (e) {
        this.events = [];
      }
      this.applyRows();
      await this.loadDdlCount();
      this.loadConflicts();
      this.loadTodayView();
    },
    // FR-51 今日概览：今天的课（按真实今天，不受周切换影响）+ 今天/明天截止的 DDL + 建议数
    async loadTodayView() {
      const v = { courses: [], ddls: [], sugCount: 0 };
      try {
        const wd = new Date().getDay() || 7;
        const week = this.term ? this.term.current_week : 0;
        v.courses = this.courses
          .filter((c) => c.day_of_week === wd && (c.weeks || []).includes(week))
          .sort((a, b) => a.start_slot - b.start_slot);
        const now = new Date();
        const tmr = new Date(now.getTime() + 86400000);
        const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const grace = key(new Date(now.getTime() - 3 * 86400000));
        v.ddls = (this.ddls || [])
          .filter((d) => d.status !== "done" && String(d.due_at).slice(0, 10) <= key(tmr)
                         && String(d.due_at).slice(0, 10) >= grace)
          .slice(0, 3);
      } catch (e) { /* 概览失败不影响主页 */ }
      this.todayView = v;
    },
    courseTimeText(c) {
      const t0 = SLOT_TIMES[c.start_slot - 1][0];
      const t1 = SLOT_TIMES[Math.min(c.end_slot, SLOT_TIMES.length) - 1][1];
      return `${t0}-${t1}`;
    },
    async loadConflicts() {
      try {
        const r = await api.get("/api/events/conflicts");
        this.conflicts = r.conflicts || [];
      } catch (e) {
        this.conflicts = [];
      }
    },
    openConflicts() {
      this.selConflict = -1;
      this.selItem = -1;
      this.showConflicts = true;
    },
    _cfAxis(c) {
      // 冲突块时间轴：min(开始) -15分 ~ max(结束) +15分
      let lo = Infinity, hi = -Infinity;
      for (const it of c.items) {
        lo = Math.min(lo, new Date(it.start_at.replace(" ", "T")).getTime());
        hi = Math.max(hi, new Date(it.end_at.replace(" ", "T")).getTime());
      }
      const pad = 15 * 60000;
      return [lo - pad, Math.max(hi + pad, lo + 3600000)];
    },
    cfBlockStyle(c, it, j) {
      const [lo, hi] = this._cfAxis(c);
      const s = new Date(it.start_at.replace(" ", "T")).getTime();
      const e = new Date(it.end_at.replace(" ", "T")).getTime();
      const left = Math.max(0, ((s - lo) / (hi - lo)) * 100);
      const width = Math.max(14, ((e - s) / (hi - lo)) * 100);
      // 车道：与前块时间重叠就降一层，两块互不遮挡、都能点（冲突最多两方）
      let lane = 0;
      for (let k = 0; k < j; k++) {
        const o = c.items[k];
        const os = new Date(o.start_at.replace(" ", "T")).getTime();
        const oe = new Date(o.end_at.replace(" ", "T")).getTime();
        if (s < oe && os < e) lane = k + 1;
      }
      return {
        left: left.toFixed(1) + "%",
        width: Math.min(100 - left, width).toFixed(1) + "%",
        top: 8 + lane * 50 + "rpx",
      };
    },
    cfRange(it) {
      const s = it.start_at.replace("T", " ").slice(5, 16);
      const e = it.end_at.replace("T", " ").slice(5, 16);
      return it.multi_day ? `${s} → ${e}` : `${s.slice(6)} ~ ${e.slice(6)}`;
    },
    _cfSel() {
      if (this.selConflict < 0 || this.selItem < 0) return null;
      const c = this.conflicts[this.selConflict];
      return c ? { c, it: c.items[this.selItem] } : null;
    },
    cfEdit() {
      const sel = this._cfSel();
      if (!sel) return;
      this.showConflicts = false;
      if (sel.it.type === "event") {
        const ev = (this.events || []).find((e) => e.id === sel.it.id);
        if (ev) uni.navigateTo({ url: "/pages/add/add?edit=" + ev.id }); // 编辑移到添加日程页
        else uni.showToast({ title: "该日程不在列表中，试试直接删除后重建", icon: "none" });
      } else {
        const co = (this.courses || []).find((x) => x.id === sel.it.id);
        if (co) this.openCourseForm(co, "edit");
        else uni.showToast({ title: "课程不存在了", icon: "none" });
      }
    },
    cfDelete() {
      const sel = this._cfSel();
      if (!sel) return;
      const { it } = sel;
      if (it.type === "course") {
        const co = (this.courses || []).find((x) => x.id === it.id);
        this.showConflicts = false;
        this.delCourse(co || { id: it.id, name: it.title });
        return;
      }
      // 日程：重复组给"只删这条/整组删"的选择；跨周日程按 id 直接删，不受当前显示周限制
      if (it.series_id) {
        uni.showActionSheet({
          itemList: ["只删这一条", "删除整组重复"],
          success: async (r) => {
            try {
              if (r.tapIndex === 0) await api.del("/api/events/" + it.id);
              else await api.del("/api/events/series/" + it.series_id);
              uni.showToast({ title: "已删除", icon: "none" });
              this.selConflict = -1;
              this.selItem = -1;
              await this.loadConflicts();
              this.load();
            } catch (e) {
              uni.showToast({ title: e.message, icon: "none" });
            }
          },
        });
      } else {
        uni.showModal({
          title: "删除日程",
          content: it.title,
          confirmText: "删除",
          confirmColor: "#dc2626",
          success: async (r) => {
            if (!r.confirm) return;
            try {
              await api.del("/api/events/" + it.id);
              uni.showToast({ title: "已删除", icon: "none" });
              this.selConflict = -1;
              this.selItem = -1;
              await this.loadConflicts();
              this.load();
            } catch (e) {
              uni.showToast({ title: e.message, icon: "none" });
            }
          },
        });
      }
    },
    async loadDdlCount() {
      try {
        this.ddls = await api.get("/api/ddls");
        this.ddlOpenCount = this.ddls.filter((d) => d.status !== "done").length;
      } catch (e) {
        this.ddlOpenCount = 0;
        this.ddls = [];
      }
    },
    // 这一天到期的 DDL（表头小药丸，最多露 2 个，多了折叠 +N）
    ddlChips(d) {
      const date = (this.weekDates || [])[d - 1];
      if (!date) return [];
      return this.ddls
        .filter((x) => x.status !== "done" && String(x.due_at || "").slice(0, 10) === date)
        .sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)))
        .slice(0, 2);
    },
    ddlMore(d) {
      const date = (this.weekDates || [])[d - 1];
      if (!date) return 0;
      const n = this.ddls.filter(
        (x) => x.status !== "done" && String(x.due_at || "").slice(0, 10) === date
      ).length;
      return Math.max(n - 2, 0);
    },
    shortTitle(t) {
      return t && t.length > 5 ? t.slice(0, 5) + "…" : t;
    },
    // 按当前 week 把课程分到 周一~周日（键 1-7），不用 computed：uni-h5 编译后
    // $options.<computed>[下标] 取不到值，data 下标访问才可靠（同 SLOT_TIMES）
    applyRows() {
      const rows = {};
      for (let d = 1; d <= 7; d++) rows[d] = [];
      let count = 0;
      for (const c of this.courses) {
        const weeks = c.weeks || [];
        if (weeks.length && !weeks.includes(this.week)) continue; // 空 = 每周都上
        if (!rows[c.day_of_week]) rows[c.day_of_week] = [];
        rows[c.day_of_week].push(c);
        count++;
      }
      this.rows = rows;
      this.weekCount = count;
      this.applyEvents();
    },
    // 把速记日程挂到当前周的每一天：跨天日程在它覆盖的每一天都显示一段
    applyEvents() {
      const evs = {};
      for (let d = 1; d <= 7; d++) evs[d] = [];
      this.weekDates = [];
      if (this.term && this.term.start_monday) {
        const [y, mo, da] = this.term.start_monday.split("-").map(Number);
        const monday = new Date(y, mo - 1, da + (this.week - 1) * 7);
        const dates = [];
        for (let d = 1; d <= 7; d++) {
          const dt = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + d - 1);
          dates.push(
            `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`
          );
        }
        this.weekDates = dates;
        for (const ev of this.events || []) {
          const sStr = String(ev.start_at || "").slice(0, 10);
          const startIdx = dates.indexOf(sStr);
          if (startIdx === -1) continue;
          // 跨天：从开始日挂到结束日（结束日超出本周就挂到周六）。
          // 每天挂一个带 _spanDay 的副本，evGeom/computeGrid 按"落在当天的那一段"画
          const eStr = String(ev.end_at || "").slice(0, 10);
          const endIdx = dates.indexOf(eStr);
          const lastIdx = endIdx === -1 ? 6 : Math.max(endIdx, startIdx);
          for (let k = startIdx; k <= Math.min(lastIdx, 6); k++) {
            evs[k + 1].push({ ...ev, _spanDay: k + 1 });
          }
        }
      }
      this.eventRows = evs;
      this.computeGrid();
    },
    // 无课区长度跟随日程自适应：
    //   最早开始早于首节 → 顶部留白撑到装下（30 分钟取整，最少 1 小时）
    //   最晚结束晚于末节 → 底部留白撑到装下
    //   整时线只在留白里每 1 小时画一条——有课区维持每节标注，不叠整时线
    computeGrid() {
      const s0 = SCHOOL_START();
      const e0 = SCHOOL_END();
      let minS = Infinity, maxE = -Infinity;
      for (const ev of Object.values(this.eventRows || {}).flat()) {
        // 事件在 _spanDay 这天的可见时段（分钟）：开始日=[开始时刻,24:00)，
        // 结束日=(00:00,结束时刻]，中间日=全天。留白按所有天的可见段一起撑，
        // 跨天日程的尾段（如次日 0-1 点）才不至于被画到网格外
        const dayDate = (this.weekDates || [])[(ev._spanDay || 1) - 1] || "";
        const sMin = hms(String(ev.start_at || "").slice(11, 16) || "08:00");
        let eMin = hms(String(ev.end_at || "").slice(11, 16) || "09:00");
        const isStart = dayDate === String(ev.start_at || "").slice(0, 10);
        const isEnd = dayDate === String(ev.end_at || "").slice(0, 10);
        let v0 = isStart ? sMin : 0;
        let v1 = isEnd ? eMin : 1440;
        if (v1 <= v0) v1 = isStart ? 1440 : Math.min(v0 + 60, 1440);
        if (v0 < minS) minS = v0;
        if (v1 > maxE) maxE = v1;
      }
      const has = minS !== Infinity;
      const padTop = has && minS < s0 ? Math.max(60, Math.ceil((s0 - minS) / 30) * 30) : 0;
      const padBottom = has && maxE > e0 ? Math.max(60, Math.ceil((maxE - e0) / 30) * 30) : 0;
      const g0 = s0 - padTop;
      this.gridStartMin = g0;
      this.padTopMin = padTop;
      this.padBottomMin = padBottom;
      const lines = [];
      if (has) {
        // 顶留白整时线：[网格顶, 首节) 每整点一条（不含网格顶边那条——
        // 网格顶恰逢整点时线会压在卡片边框上，标签也贴不准，宁可不画）
        for (let m = Math.ceil((g0 + 1) / 60 - 1e-6) * 60; m < s0; m += 60)
          lines.push({ h: Math.round(m / 60), y: Math.round(this.minToYrpx(m)), strong: m % 180 === 0 });
        // 底留白整时线：(末节, 网格底) 每整点一条（不含网格底边那条，避免"24时"压在底边上）
        const gEnd = e0 + padBottom;
        for (let m = Math.ceil((e0 + 1) / 60 - 1e-6) * 60; m < gEnd; m += 60)
          lines.push({ h: Math.round(m / 60), y: Math.round(this.minToYrpx(m)), strong: m % 180 === 0 });
      }
      this.hourLines = lines;
    },
    // 分钟数 → 距网格顶的 rpx。课表区是"每节固定 rowH rpx"的节次网格：870 分钟被压进
    // 14×rowH，若全程按 rowH=60min 线性换算，23 点日程会算到列底之外被 overflow
    // 裁掉（不显示），下午日程也会比对应节次低一格。所以分三段：
    //   顶留白线性 → 课表区按节次边界分段线性（课间压缩、节内精确）→ 底留白线性
    minToYrpx(m) {
      const s0 = SCHOOL_START();
      const e0 = SCHOOL_END();
      const H = this.rowH;
      const padTopRpx = (this.padTopMin * H) / 60;
      if (m <= s0) return ((m - this.gridStartMin) / 60) * H;
      if (m >= e0) return padTopRpx + SLOT_COUNT * H + ((m - e0) / 60) * H;
      let i = 0;
      while (i < SLOT_COUNT - 1 && hms(SLOT_TIMES[i + 1][0]) <= m) i++;
      const a = hms(SLOT_TIMES[i][0]);
      const b = i < SLOT_COUNT - 1 ? hms(SLOT_TIMES[i + 1][0]) : e0;
      return padTopRpx + (i + (m - a) / Math.max(b - a, 1)) * H;
    },
    timeToY(t) {
      return this.minToYrpx(hms(t));
    },
    evGeom(ev) {
      const t0 = String(ev.start_at).slice(11, 16) || "08:00";
      const t1 = String(ev.end_at).slice(11, 16) || "09:00";
      const dayDate = (this.weekDates || [])[(ev._spanDay || 1) - 1] || "";
      const isStart = dayDate === String(ev.start_at).slice(0, 10);
      const isEnd = dayDate === String(ev.end_at).slice(0, 10);
      let v0 = hms(t0), v1 = hms(t1);
      if (!isStart || !isEnd) {
        // 跨天日程：只画落在这一天里的那段——开始日画到 24:00，
        // 结束日从 00:00 画到结束时刻，中间日画满全天
        if (!isStart) v0 = 0;
        if (!isEnd) v1 = 1440;
        if (v1 <= v0) v1 = Math.min(v0 + 60, 1440);
      } else if (v1 <= v0) {
        v1 = 1440; // 同一天内时刻倒挂（异常数据）撑到当天末尾，避免算出负高度
      }
      const y0 = this.minToYrpx(v0);
      const y1 = this.minToYrpx(v1);
      return { top: y0, h: Math.max(y1 - y0 - 6, 44) };
    },
    eventStyle(ev) {
      const g = this.evGeom(ev);
      return { top: g.top + "rpx", height: g.h + "rpx" };
    },
    // 日程块字号随时长自适应：块越高字越大；块太矮（<2 小时）放不下备注就隐藏，
    // 避免 20rpx 小字——长日程（如全天活动）能放大到 26-30rpx。
    // 横屏/宽屏 rpx 换算大（整屏宽撑满），整体再乘 0.78 压一档
    evFont(ev) {
      const h = this.evGeom(ev).h;
      const k = this.isWide ? 0.78 : 1;
      const s = (n) => Math.round(n * k);
      if (h >= 200) return { title: s(32), sub: s(28), note: s(28), showNote: true };
      if (h >= 120) return { title: s(29), sub: s(25), note: s(25), showNote: true };
      if (h >= 70) return { title: s(27), sub: s(23), note: 0, showNote: false };
      return { title: s(25), sub: s(21), note: 0, showNote: false };
    },
    evTone(ev) {
      // 考试本体：朱红渐变 + 金边 + 白字，课表上一眼认出（与课程块/日程块完全不同）
      if (ev.type === "exam") {
        return {
          background: "linear-gradient(135deg, #991b1b, #dc2626)",
          border: "3rpx solid #f59e0b",
          tt: "#ffffff",
          boxShadow: "0 4rpx 16rpx rgba(185, 28, 28, 0.4)",
        };
      }
      const c = this.evColors[(ev.color_idx || 0) % this.evColors.length];
      // 大概/待定/想做（非 exact）→ 虚框，和确定的日程视觉上区分开
      const fuzzy = (ev.time_status || "exact") !== "exact";
      return { background: c.bg, border: `2rpx ${fuzzy ? "dashed" : "solid"} ${c.bd}`, tt: c.tt };
    },
    evRangeText(ev) {
      const st = ev.time_status || "exact";
      const sameDay =
        String(ev.start_at).slice(0, 10) === String(ev.end_at).slice(0, 10);
      const plain = sameDay
        ? `${String(ev.start_at).slice(11, 16)}-${String(ev.end_at).slice(11, 16)}`
        : `${String(ev.start_at).slice(11, 16)} → ${String(ev.end_at).slice(5, 16).replace("T", " ")}`;
      if (st === "todo") return "❓ 时间待定";
      if (st === "start_only") return `${String(ev.start_at).slice(11, 16)} 起`;
      if (st === "fuzzy") return `⏰约 ${plain}`;
      return plain;
    },
    openEventSheet(ev) {
      // 考试本体 / 批奏折接受的安排 → 轻量确认；普通日程 → 只读详情（改/删去主页）
      if (ev.type === "exam" || ev.ddl_id || ev.source === "ddl") {
        this.sugEv = ev;
        this.sugEvMode = ev.type === "exam" ? "exam" : "sug";
        this.showSugEv = true;
        return;
      }
      this.evDraft = {
        title: ev.title,
        note: ev.note || "",
        icon: ev.icon || "",
        loc: ev.location || "",
        timeStatus: ev.time_status || "exact",
        sd: String(ev.start_at).slice(0, 10),
        st: String(ev.start_at).slice(11, 16),
        ed: String(ev.end_at).slice(0, 10),
        et: String(ev.end_at).slice(11, 16),
      };
      this.evSeriesN = ev.series_count || (ev.series_id ? 2 : 1);
      this.showEvSheet = true;
    },
    async doneSugEv() {
      if (!this.sugEv) return;
      try {
        await api.post(`/api/ddls/${this.sugEv.ddl_id}/done`);
        this.showSugEv = false;
        this.sugEv = null;
        uni.showToast({ title: "DDL 完成 🎉", icon: "none" });
        this.load();
      } catch (e) {
        uni.showToast({ title: e.message, icon: "none" });
      }
    },
    delSugEv() {
      const ev = this.sugEv;
      if (!ev) return;
      uni.showModal({
        title: "删除安排",
        content: `删掉「${ev.title}」这个已排时间？`,
        confirmText: "删除",
        success: async (r) => {
          if (!r.confirm) return;
          try {
            await api.del("/api/events/" + ev.id);
            this.showSugEv = false;
            this.sugEv = null;
            uni.showToast({ title: "已删除", icon: "none" });
            this.load();
          } catch (e) {
            uni.showToast({ title: e.message, icon: "none" });
          }
        },
      });
    },
    goTerm() {
      uni.navigateTo({ url: "/pages/term/term" });
    },
    go(url) {
      uni.navigateTo({ url });
    },
    shiftWeek(delta) {
      const total = this.term.total_weeks;
      this.week = Math.min(Math.max(this.week + delta, 1), total);
      this.applyRows();
    },
    courseStyle(c) {
      const ROW_H = this.rowH; // rpx，一节课占的行高（竖屏 100 / 宽屏 78）
      // 第 1 节课 在 (SCHOOL_START - gridStartMin) 分钟之后，(start_slot-1) 节之间是一高一低
      const firstSlotY = (SCHOOL_START() - this.gridStartMin) / 60 * ROW_H;
      return {
        top: firstSlotY + (c.start_slot - 1) * ROW_H + "rpx",
        height: (c.end_slot - c.start_slot + 1) * ROW_H - 8 + "rpx",
        background: courseColor(c.name)[0],
      };
    },
    onCourse(c) {
      // 点课卡片 → 详情弹层；管理操作收进右上角 ⋯（以后加项只改 courseMenu 的 itemList）
      this.courseDetail = c;
      this.showCourse = true;
    },
    closeCourse() {
      this.showCourse = false;
    },
    courseSlotText(c) {
      const t = this.SLOT_TIMES;
      return `第 ${c.start_slot}-${c.end_slot} 节 · ${t[c.start_slot - 1][0]}-${t[c.end_slot - 1][1]}`;
    },
    courseWeeksText(c) {
      const w = c.weeks || [];
      if (!w.length) return "周次未知";
      if (w.length === this.term.total_weeks) return "每周都上";
      return `第 ${w[0]}-${w[w.length - 1]} 周`;
    },
    courseMenu() {
      const c = this.courseDetail;
      if (!c) return;
      uni.showActionSheet({
        itemList: ["编辑课程", `第${this.week}周停课`, `第${this.week}周调课`, "删除课程"],
        success: (r) => {
          if (r.tapIndex === 0) { this.showCourse = false; this.openCourseForm(c, "edit"); }
          else if (r.tapIndex === 1) { this.showCourse = false; this.skipWeek(c); }
          else if (r.tapIndex === 2) { this.showCourse = false; this.openCourseForm(c, "move"); }
          else if (r.tapIndex === 3) this.delCourse(c);
        },
      });
    },
    async delCourse(c) {
      const ok = await new Promise((resolve) =>
        uni.showModal({
          title: "删除课程",
          content: `确定删掉《${c.name}》？`,
          confirmText: "删除",
          success: (r) => resolve(r.confirm),
          fail: () => resolve(false),
        })
      );
      if (!ok) return;
      try {
        await api.del("/api/courses/" + c.id);
        uni.showToast({ title: "已删除", icon: "none" });
        this.showCourse = false;
        this.load();
      } catch (e) {
        uni.showToast({ title: e.message, icon: "none" });
      }
    },
    // 调课/停课标记：追加到 remark（"；"分隔，个人主页展示），重复操作不重复记
    addMark(oldMark, mark) {
      if (!oldMark) return mark;
      if (oldMark.includes(mark)) return oldMark;
      const parts = oldMark.split("；");
      parts.push(mark);
      return parts.join("；").slice(-120); // 数据库 128 上限，留余量
    },
    async skipWeek(c) {
      // 本周停课 = 周次数组去掉当前查看周（可再编辑周次恢复）
      const weeks = (c.weeks || []).filter((x) => x !== this.week);
      if (weeks.length === (c.weeks || []).length) {
        uni.showToast({ title: `本来第${this.week}周就没课`, icon: "none" });
        return;
      }
      await api.put("/api/courses/" + c.id, {
        ...c,
        weeks,
        remark: this.addMark(c.remark, `第${this.week}周停课`),
      });
      uni.showToast({ title: `第${this.week}周已停课`, icon: "none" });
      this.load();
    },
    openCourseForm(c, mode) {
      // mode: edit=改这条 | move=调课（原周次移除 + 新周次建记录，可跨周）
      const total = this.term.total_weeks;
      this.courseFormMode = mode;
      this._courseFormId = c ? c.id : null;
      this._editRemark = c ? c.remark || "" : ""; // 编辑时保留调课/停课标记
      this._moveFrom = mode === "move" ? c : null;
      this.form = {
        name: c ? c.name : "",
        location: c ? c.location : "",
        teacher: c ? c.teacher : "",
        day_of_week: c ? c.day_of_week : Math.min(new Date().getDay() || 7, 7),
        start_slot: c ? c.start_slot : 1,
        end_slot: c ? c.end_slot : 1,
        fromWeekText: String(this.week),
        weeksText: mode === "move" ? String(this.week) : c
          ? (c.weeks || []).join(",")
          : `1-${total}`,
      };
      this.weeksPlaceholder = `1-${total}（1-${total} 每周）`;
      this.addTitle = mode === "edit" ? "编辑课程"
        : mode === "move" ? "调课" : "添加课程";
      this.showAdd = true;
    },
    openAdd() {
      this.openCourseForm(null, "add");
    },
    async saveCourse() {
      if (!this.form.name.trim()) {
        uni.showToast({ title: "填个课程名", icon: "none" });
        return;
      }
      if (this.form.end_slot < this.form.start_slot) {
        uni.showToast({ title: "结束节次要 ≥ 开始", icon: "none" });
        return;
      }
      const mode = this.courseFormMode || "add";
      const weeks = parseWeeks(this.form.weeksText, this.term.total_weeks);
      const body = {
        name: this.form.name.trim(),
        location: this.form.location.trim(),
        teacher: (this.form.teacher || "").trim(),
        day_of_week: this.form.day_of_week,
        start_slot: this.form.start_slot,
        end_slot: this.form.end_slot,
        weeks,
      };
      try {
        if (mode === "edit") {
          await api.put("/api/courses/" + this._courseFormId, { ...body, remark: this._editRemark || "" });
          uni.showToast({ title: "已更新", icon: "none" });
        } else if (mode === "move" && this._moveFrom) {
          // 调课：原课移除「原周次」→ 新建「新周次」记录（时间/地点/周几可改，支持跨周）
          const src = this._moveFrom;
          const fromWeeks = parseWeeks(this.form.fromWeekText, this.term.total_weeks);
          const fw = fromWeeks.length ? fromWeeks : [this.week];
          const fromTxt = fw.join("、");
          const remain = (src.weeks || []).filter((x) => !fw.includes(x));
          await api.put("/api/courses/" + src.id, {
            ...src,
            weeks: remain,
            remark: this.addMark(src.remark, `第${fromTxt}周调出`),
          });
          await api.post("/api/courses", {
            ...body,
            weeks: weeks.length ? weeks : fw,
            remark: `第${fromTxt}周调入`,
          });
          uni.showToast({ title: "已调课", icon: "none" });
        } else {
          await api.post("/api/courses", body);
          uni.showToast({ title: "已加课", icon: "none" });
        }
        this.showAdd = false;
        this.load();
      } catch (e) {
        uni.showToast({ title: e.message, icon: "none" });
      }
    },
  },
};
</script>

<style scoped>
.page {
  padding: 16rpx;
  padding-bottom: 140rpx;
}
.empty {
  margin-top: 200rpx;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 20rpx;
}
.empty-title {
  font-size: 36rpx;
  font-weight: 600;
}
.empty-sub {
  color: #8a91a3;
  font-size: 26rpx;
  margin-bottom: 40rpx;
}
.week-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #fff;
  border-radius: 16rpx;
  padding: 16rpx 20rpx;
  margin-bottom: 16rpx;
}
.wk-btn {
  color: #4f46e5;
  font-size: 26rpx;
  padding: 8rpx 0;
}
.wk-cur {
  font-size: 30rpx;
  font-weight: 600;
  display: flex;
  gap: 10rpx;
  align-items: center;
}
.wk-now {
  font-size: 20rpx;
  color: #fff;
  background: #4f46e5;
  border-radius: 8rpx;
  padding: 2rpx 10rpx;
}
.tool-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 16rpx;
  margin-bottom: 16rpx;
}
.tool-btn {
  flex: 1;
  min-width: 158rpx;
  background: #fff;
  color: #4f46e5;
  font-size: 25rpx;
  border-radius: 14rpx;
  padding: 18rpx 0;
  text-align: center;
  font-weight: 500;
  box-sizing: border-box;
  white-space: nowrap;
  overflow: hidden;
}
.grid-head {
  display: flex;
  background: #fff;
  border-radius: 16rpx 16rpx 0 0;
  border-bottom: 1rpx solid #e5e7eb;
}
/* 整时线：只画在无课时段（顶部早段/末节之后），有课区靠每节自己的时间标注 */
.grid-lines {
  position: absolute;
  /* 直接挂在 .days 里，只跨 7 个日期列（左侧小时列 / 节次列不画线） */
  top: 0;
  bottom: 0;
  left: 0;
  right: 0;
  pointer-events: none;
  z-index: 1; /* 课程块 z1 同层但 DOM 在后 → 盖住线；日程块 z2 同理。线永远垫底 */
}
.grid-line {
  position: absolute;
  left: 0;
  right: 0;
  height: 1rpx;
  background: #d6dce6;
}
.grid-line.strong {
  background: #b8c1d0;
}
.col-label {
  width: 132rpx;
  flex-shrink: 0;
}
.col-day {
  flex: 1;
  text-align: center;
  padding: 12rpx 0;
  font-size: 26rpx;
  color: #4b5563;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6rpx;
}
.day-name { font-size: 26rpx; }
/* DDL 到期药丸：和课表块（实色块）/日程块（描边块）都不同形 */
.ddl-chips {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4rpx;
  width: 100%;
}
.ddl-chip {
  max-width: 92%;
  font-size: 18rpx;
  line-height: 1.5;
  color: #fff;
  border-radius: 8rpx;
  padding: 0 10rpx;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ddl-chip.red { background: #dc2626; }
.ddl-chip.yellow { background: #d97706; }
.ddl-chip.green { background: #059669; }
.ddl-chip.overdue { background: #6b7280; }
.ddl-chip.more { background: #eef2ff; color: #4f46e5; }

/* 课程详情弹层：头部色点+课名，右上角 ⋯ 菜单 */
.course-sheet { border-radius: 24rpx; margin: 0 24rpx 80rpx; width: auto; max-width: 620rpx; align-self: center; }
.course-sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 24rpx;
}
.course-sheet-title { display: flex; align-items: center; gap: 16rpx; min-width: 0; }
.course-dot { width: 24rpx; height: 24rpx; border-radius: 8rpx; flex-shrink: 0; }
.course-sheet-name { font-size: 34rpx; font-weight: 700; color: #1f2333; }
.course-menu {
  font-size: 44rpx;
  font-weight: 700;
  color: #6b7280;
  padding: 0 20rpx;
  line-height: 1;
  letter-spacing: 2rpx;
}
.course-menu:active { color: #4f46e5; }
.course-sheet-body {
  background: #f8f9fc;
  border-radius: 16rpx;
  padding: 8rpx 24rpx;
}
.course-row {
  display: flex;
  align-items: baseline;
  gap: 20rpx;
  padding: 18rpx 0;
  border-bottom: 1rpx solid #eef0f5;
}
.course-row:last-child { border-bottom: none; }
.cr-label { width: 64rpx; font-size: 24rpx; color: #8a91a3; flex-shrink: 0; }
.cr-val { font-size: 27rpx; color: #374151; flex: 1; min-width: 0; }
.course-sheet-tip { text-align: center; font-size: 22rpx; color: #b0b5c1; margin-top: 24rpx; }

/* 已排 DDL 安排确认弹层 */
.sug-ev-sheet { border-radius: 24rpx; }
.sug-ev-body {
  background: #f8f9fc;
  border-radius: 16rpx;
  padding: 28rpx 24rpx;
  display: flex;
  flex-direction: column;
  gap: 14rpx;
}
.sug-ev-title { font-size: 32rpx; font-weight: 700; color: #1f2333; }
.sug-ev-time { font-size: 28rpx; color: #4f46e5; font-weight: 600; }
.sug-ev-loc { font-size: 26rpx; color: #374151; }
.sug-ev-note { font-size: 24rpx; color: #8a91a3; }
.sug-ev-hint { font-size: 22rpx; color: #b0b5c1; margin-top: 8rpx; }
.sug-ev-body.exam {
  background: #fef2f2;
  border: 2rpx solid #fca5a5;
}
.sug-ev-body.exam .sug-ev-title { color: #b91c1c; }
.sug-ev-body.exam .sug-ev-time { color: #991b1b; }
.grid-body {
  display: flex;
  background: #fff;
  border-radius: 0 0 16rpx 16rpx;
  overflow: hidden;
  position: relative;
}
.col-labels {
  width: 132rpx;
  flex-shrink: 0;
  position: relative; /* 留白区时刻标签的定位包含块 */
}
.slot-label {
  position: relative;
  height: 100rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  border-bottom: 1rpx solid #e3e7ef;
}
.slot-no {
  font-size: 26rpx;
  font-weight: 600;
  color: #6b7280;
  display: flex;
  gap: 6rpx;
  align-items: baseline;
}
.slot-time {
  font-size: 18rpx;
  color: #8a91a3;
  font-weight: 400;
}
.slot-gap {
  position: absolute;
  bottom: -12rpx;
  left: -8rpx;
  right: -8rpx;
  text-align: center;
  font-size: 16rpx;
  color: #b6bcc9;
  background: #fff;
  line-height: 1.3;
  z-index: 1;
}
/* 小时标尺的线只在 .days 里（.grid-line）；时刻标签由 .pad-time 标在节次列 */
.days {
  display: flex;
  flex: 1;
  position: relative; /* 整时线 absolute 的包含块 */
}
.day-col {
  position: relative;
  flex: 1;
  border-left: 1rpx solid #e3e7ef;
}
.slot-cell {
  height: 100rpx;
  border-bottom: 1rpx solid #e3e7ef;
}
/* 留白区（课前/课后）占位：不着色不强调"无课"，时刻交给 .pad-time 标注 */
/* 留白区时刻标签：贴整时线右对齐，比节次时刻大一档 */
.pad-time {
  position: absolute;
  right: 8rpx;
  transform: translateY(-50%);
  font-size: 26rpx;
  color: #8a91a3;
  font-variant-numeric: tabular-nums;
  z-index: 1;
}
.course {
  position: absolute;
  left: 6rpx;
  right: 6rpx;
  border-radius: 10rpx;
  padding: 10rpx;
  box-sizing: border-box; /* 高度按 JS 指定的整盒算，否则 content-box 会多出 20rpx 压到下一节 */
  display: flex;
  flex-direction: column;
  justify-content: center; /* 单节课的短内容垂直居中，不顶上沿 */
  gap: 4rpx;
  overflow: hidden;
  z-index: 1;
}
.course-name {
  font-size: 29rpx;
  font-weight: 600;
  line-height: 1.25;
}
.course-loc {
  font-size: 23rpx;
  color: #6b7280;
}
.course-teacher {
  font-size: 22rpx;
  color: #8a91a3;
}
.ev-block {
  position: absolute;
  left: 6rpx;
  right: 6rpx;
  border-radius: 10rpx;
  padding: 8rpx 10rpx;
  box-sizing: border-box; /* 同 .course：内边距+边框计入高度，避免压到相邻时段 */
  display: flex;
  flex-direction: column;
  justify-content: center; /* 短日程垂直居中，不顶上沿 */
  gap: 2rpx;
  overflow: hidden;
  z-index: 2;
  border: 2rpx solid #f59e0b; /* 具体颜色由 evTone() 内联覆盖 */
}
.ev-title {
  font-size: 24rpx;
  font-weight: 600;
  line-height: 1.25;
}
.ev-time {
  font-size: 21rpx;
}
.ev-note {
  font-size: 23rpx;
  line-height: 1.35;
}
.color-dots {
  display: flex;
  flex-wrap: wrap;
  gap: 18rpx;
}
.color-dots .dot {
  flex-shrink: 0;
}
.icon-dots {
  display: flex;
  flex-wrap: wrap;
  gap: 10rpx;
}
.icon-dot {
  width: 56rpx;
  height: 56rpx;
  flex-shrink: 0;
  border-radius: 12rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 30rpx;
  background: #f5f6fa;
}
.icon-dot.sel {
  background: #eef2ff;
  box-shadow: 0 0 0 3rpx #4f46e5 inset;
}
.icon-dot.ts-dot {
  width: auto;
  min-width: 96rpx;
  padding: 0 16rpx;
}
.dot {
  width: 52rpx;
  height: 52rpx;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 24rpx;
}
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
}
.sheet-title {
  font-size: 32rpx;
  font-weight: 600;
  margin-bottom: 24rpx;
}
/* 日程详情弹层（只读，改/删在添加日程页） */
.detail-title {
  font-size: 30rpx;
  font-weight: 600;
  margin-bottom: 20rpx;
}
.detail-row {
  display: flex;
  gap: 20rpx;
  padding: 12rpx 0;
  border-bottom: 1rpx solid #f1f2f6;
}
.detail-row:last-of-type {
  border-bottom: none;
}
.d-label {
  width: 76rpx;
  flex-shrink: 0;
  color: #6b7280;
  font-size: 26rpx;
}
.d-val {
  flex: 1;
  font-size: 26rpx;
  overflow-wrap: break-word;
}
.form-row {
  display: flex;
  align-items: center;
  margin-bottom: 20rpx;
}
.form-row.icon-row {
  align-items: flex-start;
  flex-wrap: wrap;
}
.icon-row .label {
  padding-top: 12rpx;
}
.to-label {
  color: #4f46e5;
  font-size: 26rpx;
  margin: 0 4rpx;
}

/* ---------- 窄屏（竖屏手机）关键信息模式 ----------
   只留课名两行截断 + 色块 + 节次号，地点/教师/日程备注藏起来（点卡片弹窗看）。
   横屏 / ≥600px 宽自动恢复完整展示。 */
/* FR-51 今日概览卡片 */
.today-card {
  background: #fff;
  border-radius: 14rpx;
  padding: 18rpx 22rpx;
  margin-bottom: 14rpx;
}
.today-head {
  display: flex;
  align-items: center;
  gap: 14rpx;
  font-size: 27rpx;
  font-weight: 600;
  color: #1f2333;
  padding-bottom: 10rpx;
  border-bottom: 1rpx solid #f1f2f6;
}
.today-stat {
  flex: 1;
  min-width: 0;
  text-align: right;
  font-size: 22rpx;
  font-weight: 400;
  color: #8a91a3;
}
.today-row {
  display: flex;
  align-items: center;
  gap: 14rpx;
  padding: 12rpx 0 0;
}
.today-time {
  flex-shrink: 0;
  font-size: 22rpx;
  color: #6b7280;
  font-variant-numeric: tabular-nums;
}
.today-name {
  flex: 1;
  min-width: 0;
  font-size: 26rpx;
  color: #374151;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.today-loc {
  font-size: 22rpx;
  color: #8a91a3;
}
.today-row.ddl .today-name {
  color: #b91c1c;
}
.today-row.sug .today-name {
  color: #4f46e5;
  font-size: 24rpx;
}
.today-tag {
  flex-shrink: 0;
  font-size: 20rpx;
  border-radius: 999rpx;
  padding: 4rpx 14rpx;
}
.today-tag.red { color: #b91c1c; background: #fee2e2; }
.today-tag.yellow { color: #b45309; background: #fef3c7; }
.today-tag.green { color: #047857; background: #d1fae5; }
.today-tag.overdue { color: #4b5563; background: #e5e7eb; }

/* 时间冲突卡片入口 */
.conflict-card {
  display: flex;
  align-items: center;
  gap: 16rpx;
  background: #fef2f2;
  border: 2rpx solid #fecaca;
  border-radius: 14rpx;
  padding: 20rpx 24rpx;
  margin-bottom: 14rpx;
}
.conflict-head {
  flex: 1;
  min-width: 0;
  font-size: 26rpx;
  font-weight: 600;
  color: #b91c1c;
}
.conflict-go {
  flex-shrink: 0;
  font-size: 24rpx;
  color: #fff;
  background: #dc2626;
  border-radius: 999rpx;
  padding: 8rpx 26rpx;
}

/* 冲突处理弹层：迷你时间表可视化 */
.conflict-sheet {
  max-height: 86vh;
  display: flex;
  flex-direction: column;
}
.cf-list {
  flex: 1;
  min-height: 0;
  max-height: 62vh;
}
.cf-item {
  padding: 20rpx 0;
  border-bottom: 1rpx solid #f1f2f6;
}
.cf-text {
  display: block;
  font-size: 25rpx;
  color: #374151;
  margin-bottom: 12rpx;
  line-height: 1.4;
}
.cf-axis {
  position: relative;
  height: 116rpx;
  background: #f5f6fa;
  border-radius: 10rpx;
  overflow: hidden;
}
.cf-block {
  position: absolute;
  height: 46rpx;
  border-radius: 8rpx;
  background: #fee2e2;
  border: 2rpx solid #f87171;
  box-sizing: border-box;
  padding: 4rpx 10rpx;
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8rpx;
  overflow: hidden;
}
.cf-block.course {
  background: #e0e7ff;
  border-color: #818cf8;
}
.cf-block.sel {
  border: 4rpx solid #dc2626;
  background: #fecaca;
  z-index: 2;
}
.cf-block.course.sel {
  background: #c7d2fe;
  border-color: #4f46e5;
}
.cf-block-t {
  font-size: 22rpx;
  color: #7f1d1d;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cf-block.course .cf-block-t {
  color: #312e81;
}
.cf-block-s {
  font-size: 19rpx;
  color: rgba(0, 0, 0, 0.55);
  white-space: nowrap;
}
.cf-actions {
  display: flex;
  gap: 16rpx;
  margin-top: 12rpx;
}
.cf-act {
  font-size: 25rpx;
  color: #fff;
  background: #4f46e5;
  border-radius: 999rpx;
  padding: 10rpx 32rpx;
}
.cf-act.danger {
  background: #dc2626;
}
.cf-empty {
  padding: 60rpx 0;
  text-align: center;
  font-size: 26rpx;
  color: #8a91a3;
}

/* 表单内的实时冲突提示（只提示不阻断） */
.clash-hint {
  margin: 10rpx 0 4rpx;
  font-size: 24rpx;
  color: #b91c1c;
  background: #fef2f2;
  border-radius: 10rpx;
  padding: 14rpx 18rpx;
  line-height: 1.45;
}
.clash-sub {
  color: #b91c1c;
  opacity: 0.65;
  font-size: 21rpx;
}
.narrow .course-loc,
.narrow .course-teacher,
.narrow .ev-note {
  display: none;
}
.narrow .course-name {
  font-size: 22rpx;
  line-height: 1.25;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}
.narrow .col-day {
  font-size: 24rpx;
}
.narrow .slot-gap {
  display: none;
}
/* 竖屏：节号+时刻是重要信息不丢，改为上下两行的紧凑排布 */
.narrow .slot-no {
  font-size: 22rpx;
  flex-direction: column;
  gap: 2rpx;
  line-height: 1.2;
}
.narrow .slot-time {
  display: block;
  font-size: 20rpx;
}
.narrow .pad-time {
  font-size: 26rpx;
}
.narrow .ev-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: block;
}
.narrow .ev-time {
  font-size: 20rpx;
}

/* ---------- 横屏/宽屏（≥600px 或 w>h）：整屏宽度下 rpx 换算变大，
   整体压一档：紧凑行高 + 小字号 + 小按钮，同屏看更多内容 ---------- */
.wide .slot-cell,
.wide .slot-label {
  height: 78rpx; /* 与 JS rowH 保持一致，改动要同步 */
}
.wide .course-name {
  font-size: 20rpx;
  line-height: 1.25;
}
.wide .course-loc,
.wide .course-teacher {
  font-size: 17rpx;
}
.wide .col-day {
  font-size: 21rpx;
  padding: 8rpx 0;
}
.wide .slot-no {
  font-size: 19rpx;
}
.wide .slot-time {
  font-size: 14rpx;
}
.wide .pad-time {
  font-size: 22rpx;
}
.wide .tool-btn {
  font-size: 21rpx;
  padding: 12rpx 0;
}
.wide .wk-btn,
.wide .wk-cur {
  font-size: 21rpx;
}
.form-row input {
  flex: 1;
  font-size: 28rpx;
  min-width: 0;
}
.label {
  width: 90rpx;
  color: #6b7280;
  font-size: 26rpx;
  flex-shrink: 0;
}
.picker-val {
  flex: 1;
  background: #f5f6fa;
  border-radius: 10rpx;
  padding: 14rpx 18rpx;
  font-size: 26rpx;
}
/* 日期/时间 picker 会垫系统原生输入框盖住文字：文字自绘，picker 透明铺满做点击区 */
.pick-wrap {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.pick-wrap .caret {
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
.hint-row {
  font-size: 20rpx;
  color: #b0b5c1;
  margin: -10rpx 0 16rpx 90rpx;
}
.sheet-btns {
  display: flex;
  gap: 20rpx;
  margin-top: 30rpx;
}
.btn-primary {
  background: #4f46e5;
  color: #fff;
  font-size: 31rpx;
  border-radius: 14rpx;
  padding: 0;
  line-height: 84rpx; /* 行高=按钮高：部分浏览器忽略 button 上的 flex，行高兜底垂直居中 */
  height: 84rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
}
.btn-primary::after {
  border: none;
}
.btn-plain {
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
.sheet-btns button {
  flex: 1;
}
</style>
