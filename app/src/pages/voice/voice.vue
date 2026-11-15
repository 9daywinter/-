<template>
  <view class="page">
    <!-- 主操作：手动填日程，一定稳 -->
    <view class="card">
      <view class="card-title">添加日程</view>
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
        <picker mode="date" :value="draft.sd" @change="(e) => (draft.sd = e.detail.value)">
          <view class="val">{{ shortDate(draft.sd) }} ▾</view>
        </picker>
        <picker mode="time" :value="draft.st" @change="(e) => (draft.st = e.detail.value)">
          <view class="val">{{ draft.st }} ▾</view>
        </picker>
      </view>
      <view class="form-row">
        <text class="label">结束</text>
        <picker v-if="draft.repeat === 'none'" mode="date" :value="draft.ed" @change="(e) => (draft.ed = e.detail.value)">
          <view class="val">{{ shortDate(draft.ed) }} ▾</view>
        </picker>
        <picker mode="time" :value="draft.et" @change="(e) => (draft.et = e.detail.value)">
          <view class="val">{{ draft.et }} ▾</view>
        </picker>
      </view>
      <view class="form-row">
        <text class="label">重复</text>
        <view class="rep-chips">
          <text class="chip" :class="{ on: draft.repeat === 'none' }" @click="draft.repeat = 'none'">不重复</text>
          <text class="chip" :class="{ on: draft.repeat === 'daily' }" @click="setRepeat('daily')">每天</text>
          <text class="chip" :class="{ on: draft.repeat === 'weekly' }" @click="setRepeat('weekly')">每周</text>
        </view>
      </view>
      <view v-if="draft.repeat === 'weekly'" class="chips">
        <text class="label">哪天</text>
        <text
          v-for="(w, i) in ['一', '二', '三', '四', '五', '六', '日']"
          :key="i"
          class="chip"
          :class="{ on: draft.rdays.includes(i + 1) }"
          @click="toggleRDay(i + 1)"
        >{{ w }}</text>
      </view>
      <view v-if="draft.repeat !== 'none'" class="form-row">
        <text class="label">重复到</text>
        <picker mode="date" :value="draft.red" @change="(e) => (draft.red = e.detail.value)">
          <view class="val">{{ shortDate(draft.red) }} ▾</view>
        </picker>
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
          :class="{ on: (draft.icon || '') === ic }"
          @click="draft.icon = ic"
        >{{ ic || "🎤" }}</text>
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
      <button class="btn-primary" :disabled="busy" @click="save">
        {{ busy ? "保存中…" : saveBtnText }}
      </button>
    </view>

    <!-- 文字预填：只负责帮你填上面的表单，不满意直接改 -->
    <!-- 语音相关（录音 ASR / 浏览器实时听 / http 提示）先整体隐藏，是否保留待定。
         恢复：删掉下面这行注释和对应的收尾注释即可
    <view class="card">
      <view class="note-banner" v-if="!secure">
        当前用 HTTP 打开，浏览器会禁用麦克风和语音识别 → 直接打字或用手填
      </view>
      <view class="card-title">
        语音/文字预填
        <text class="by-tag" v-if="lastBy">上次解析：{{ lastBy === "llm" ? "AI" : "规则" }}，可随时改</text>
      </view>
      <view class="rec-wrap" :class="{ recording }" @click="toggleRecord">
        <text class="rec-ico">{{ recording ? "⏹" : "🎙" }}</text>
        <text class="rec-txt">{{ recording ? "正在录音，再点一次结束并识别…" : "点一下开始录音，说完再点一次识别" }}</text>
      </view>
      <text class="rec-sub" v-if="recSub">{{ recSub }}</text>
      <view v-if="sr" class="sr-line" @click="toggleListen">
        <text>{{ listening ? "● 正在听…点击停止" : "🎤 浏览器实时听（桌面可用）" }}</text>
      </view>
      <text class="mic-hint" v-else>此浏览器不支持实时语音识别，用上面的录音或打字</text>
      <textarea
        v-model="transcript"
        class="ta"
        placeholder='比如：明天下午三点半开班会，两个小时。点声音解析会填进上方表单（解析错就直接手改）'
        :maxlength="200"
      />
      <button class="btn-ghost" :disabled="busy" @click="parse">
        {{ busy ? "解析中…" : "🔊 声音解析并填入表单" }}
      </button>
    </view>
    -->
    <view class="card">
      <view class="card-title">一句话预填（可选）</view>
      <textarea
        v-model="transcript"
        class="ta"
        placeholder='一句话速记（明天下午三点半开班会，两个小时）或直接粘贴群通知（投票/体测/讲座安排），点解析自动填表'
        :maxlength="2000"
      />
      <button class="btn-ghost" :disabled="busy" @click="parse">
        {{ busy ? "解析中…" : "解析并填入表单" }}
      </button>
    </view>

    <!-- 已有速记 -->
    <view class="card" v-if="events.length">
      <view class="card-title">我的速记（{{ events.length }}）</view>
      <view v-for="ev in events" :key="ev.id" class="ev-row">
        <view class="ev-info">
          <text class="ev-title">{{ ev.icon || "🎤" }} {{ ev.title }}<text v-if="ev.series_id" class="series-tag"> 🔁×{{ seriesCount[ev.series_id] || 1 }}</text></text>
          <text class="ev-time">{{ evTimeText(ev) }}</text>
        </view>
        <text class="ev-del" @click="delEvent(ev.id)">删除</text>
      </view>
    </view>
  </view>
</template>

<script>
import { api } from "../../utils/api";
import { EVENT_ICONS, TIME_STATUS } from "../../utils/slots";

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
      sr: null,
      listening: false,
      secure: true,
      recorder: null,      // uni.getRecorderManager()，H5 / APK 通用
      recording: false,
      recSub: "",
      transcript: "",
      lastBy: "",
      lastVoice: false,
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
      eventIcons: EVENT_ICONS,
      timeStatuses: TIME_STATUS,
      colors: COLORS.map((bd) => ({ bd })),
      clash: null,   // 输入时的实时冲突提示（只提示不阻断）
      _clashT: null,
    };
  },
  onShow() {
    this.initSR();
    this.initRecorder();
    this.loadEvents();
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
    // 重复组 id → 条数（速记列表 🔁×N 用）
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
  onHide() {
    if (this.listening) this.sr && this.sr.stop();
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
          start_at, end_at, time_status: d.timeStatus });
        const has = (r.courses?.length || 0) + (r.events?.length || 0);
        this.clash = has ? r : null;
      } catch (e) {
        this.clash = null; // 检测失败不挡输入
      }
    },
    // 录音 → 上传后端 ASR（H5 / APK 通用）。
    // APK 里 uni.getRecorderManager 是原生录音，最稳；
    // H5 走 Chrome MediaRecorder，能录但产物是 webm/opus，需后端 ffmpeg 转码。
    initRecorder() {
      if (this.recorder || !uni.getRecorderManager) return;
      const mgr = uni.getRecorderManager();
      mgr.onStop((res) => this.onRecordStop(res));
      mgr.onError((e) => {
        this.recording = false;
        uni.showToast({ title: "录音出错了：" + ((e && e.errMsg) || "未知"), icon: "none" });
      });
      this.recorder = mgr;
    },
    toggleRecord() {
      if (!this.recorder) {
        uni.showToast({ title: "当前环境不支持录音，直接打字吧", icon: "none" });
        return;
      }
      if (this.recording) this.recorder.stop();
      else {
        this.recSub = "";
        this.recorder.start({
          duration: 30000,
          sampleRate: 16000,
          numberOfChannels: 1,
          encodeBitRate: 48000,
          format: "mp3",
        });
        this.recording = true;
      }
    },
    onRecordStop(res) {
      this.recording = false;
      if (!res || !res.tempFilePath) {
        uni.showToast({ title: "没录到音频，再说一次", icon: "none" });
        return;
      }
      this.recSub = "识别中…";
      // 读音频为 base64：H5 / APP 各读各的接口，行为一致
      const path = res.tempFilePath;
      const readB64 = (cb) => {
        // #ifdef H5
        const xhr = new XMLHttpRequest();
        xhr.open("GET", path, true);
        xhr.responseType = "blob";
        xhr.onload = () => {
          const fr = new FileReader();
          fr.onload = () => cb(String(fr.result).split(",")[1]);
          fr.readAsDataURL(xhr.response);
        };
        xhr.onerror = () => this.recFail("读取录音失败");
        xhr.send();
        // #endif
        // #ifndef H5
        uni.getFileSystemManager()
          .readFile({
            filePath: path,
            encoding: "base64",
            success: (r) => cb(r.data),
            fail: () => this.recFail("读取录音失败"),
          })
          .catch(() => this.recFail("读取录音失败"));
        // #endif
      };
      const ext = (String(path).split(".").pop() || "mp3").toLowerCase();
      readB64((b64) => {
        if (!b64) return;
        api
          .post("/api/ai/voice-upload", { audio_base64: b64, ext })
          .then((r) => {
            this.recSub = r.text_used ? `听到：${r.text_used}（可改）` : "识别完成，请确认";
            if (r.title) this.draft.title = r.title;
            if (r.note) this.draft.note = r.note;
            if (r.location) this.draft.loc = r.location;
            const s = isoToLocal(r.start_at);
            const e = isoToLocal(r.end_at);
            this.draft.sd = s.d;
            this.draft.st = s.t;
            this.draft.ed = e.d;
            this.draft.et = e.t;
            this.lastBy = r.by || "voice";
            this.lastVoice = true;
            this.transcript = r.text_used || this.transcript;
            uni.showToast({ title: "已填入表单，确认后再保存", icon: "none" });
          })
          .catch((err) => this.recFail(err.message));
      });
    },
    recFail(msg) {
      this.recording = false;
      this.recSub = "";
      uni.showToast({ title: msg || "识别失败", icon: "none", duration: 3000 });
    },
    initSR() {
      try {
        this.secure = window.isSecureContext;
      } catch (e) {
        this.secure = false;
      }
      const SR = typeof window !== "undefined" && (window.SpeechRecognition || window.webkitSpeechRecognition);
      if (!SR) return;
      const sr = new SR();
      sr.lang = "zh-CN";
      sr.interimResults = true;
      sr.continuous = false;
      sr.onresult = (e) => {
        let text = "";
        for (let i = 0; i < e.resultIndex; i++) text += e.results[i][0].transcript;
        this.transcript = (text + (e.results[e.resultIndex] ? e.results[e.resultIndex][0].transcript : "")).trim();
      };
      sr.onend = () => {
        this.listening = false;
        if (this.transcript) this.parse();
      };
      // 之前静默吞错 → 手机上表现为"没反应/结束不了"。把真实原因弹出来。
      sr.onerror = (e) => {
        this.listening = false;
        const msg = {
          NotAllowedError: "麦克风被拒绝了：点地址栏的锁/权限图标，允许麦克风后重试",
          NotSupportedError: "这台设备的浏览器不支持语音，直接用上面的表单或打字",
          AudioCapture: "没检测到麦克风，检查下耳机麦/麦克风",
          NetworkError: "语音服务连不上（多为非 https 环境），直接打字或用手填表单",
          NoSpeechError: "没听清，请靠近麦克风再说一次",
        }[e.error] || "语音出错了：" + e.error;
        if (e.error !== "aborted" && e.error !== "no-speech") {
          uni.showToast({ title: msg, icon: "none", duration: 3500 });
        }
      };
      this.sr = sr;
    },
    toggleListen() {
      if (!this.sr) return;
      if (this.listening) {
        this.sr.stop();
        return;
      }
      this.transcript = "";
      try {
        this.sr.start();
        this.listening = true;
      } catch (e) {
        /* 连续快速点击会抛错，忽略 */
      }
    },
    // 解析结果只用来"预填表单"，不当最终答案——错的直接在上面改
    async parse() {
      if (!this.transcript.trim()) {
        uni.showToast({ title: "先说/写点什么", icon: "none" });
        return;
      }
      this.busy = true;
      try {
        const res = await api.post("/api/ai/parse-voice", { text: this.transcript });
        const s = isoToLocal(res.start_at);
        const e = isoToLocal(res.end_at);
        if (res.title) this.draft.title = res.title;
        if (res.note) this.draft.note = res.note;
        if (res.location) this.draft.loc = res.location;
        if (res.time_status) this.draft.timeStatus = res.time_status;
        this.draft.sd = s.d;
        this.draft.st = s.t;
        this.draft.ed = e.d;
        this.draft.et = e.t;
        this.lastBy = res.by || "";
        this.lastVoice = Boolean(this.sr);
        uni.showToast({ title: "已填入上方表单，确认后再保存", icon: "none" });
      } catch (err) {
        uni.showToast({ title: err.message, icon: "none" });
      } finally {
        this.busy = false;
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
            source: this.lastVoice ? "voice" : "text",
          });
          uni.showToast({
            title: this.clash ? "已记下，冲突见主页 ⚠️" : "已记下 ✓",
            icon: "success",
          });
        }
        this.draft.title = "";
        this.draft.note = "";
        this.draft.loc = "";
        this.lastVoice = false;
        this.transcript = "";
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
        /* 后台没起时静默 */
      }
    },
    async delEvent(id) {
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
              this.loadEvents();
            } catch (e) {
              uni.showToast({ title: e.message, icon: "none" });
            }
          },
        });
        return;
      }
      await api.del("/api/events/" + id);
      this.loadEvents();
    },
    shortDate(d) {
      const l = isoToLocal(d + "T00:00:00");
      return l.d.slice(5).replace("-", "/");
    },
    short(s) {
      const l = isoToLocal(s);
      return `${l.d.slice(5)} ${l.t}`;
    },
    // 速记列表时间文案：按时间确定度标注（仅开始→"起"，大概→"约"，待定→"??"）
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
  padding-bottom: calc(60rpx + env(safe-area-inset-bottom));
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
.by-tag {
  font-size: 20rpx;
  color: #4f46e5;
  background: #eef2ff;
  border-radius: 8rpx;
  padding: 2rpx 10rpx;
  font-weight: 400;
}
.mic-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14rpx;
  margin-bottom: 24rpx;
}
.mic {
  width: 140rpx;
  height: 140rpx;
  border-radius: 50%;
  background: #4f46e5;
  color: #fff;
  font-size: 56rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 8rpx 24rpx rgba(79, 70, 229, 0.35);
}
.mic.listening {
  background: #ef4444;
  animation: pulse 1s infinite;
}
@keyframes pulse {
  50% {
    transform: scale(1.08);
  }
}
.mic-hint {
  font-size: 24rpx;
  color: #8a91a3;
}
.ta {
  width: 100%;
  height: 140rpx;
  background: #f5f6fa;
  border-radius: 12rpx;
  padding: 16rpx;
  font-size: 28rpx;
  box-sizing: border-box;
  margin-bottom: 20rpx;
}
.btn-primary {
  background: #4f46e5;
  color: #fff;
  font-size: 28rpx;
  border-radius: 14rpx;
  height: 84rpx;
  line-height: 1;
  border: none;
}
.btn-primary[disabled] {
  opacity: 0.6;
  color: #fff;
}
.btn-primary::after {
  border: none;
}
.btn-ghost {
  background: #eef2ff;
  color: #4f46e5;
  font-size: 28rpx;
  border-radius: 14rpx;
  height: 84rpx;
  line-height: 1;
  border: none;
}
.btn-ghost[disabled] {
  opacity: 0.6;
}
.btn-ghost::after {
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
.note-banner {
  background: #fef3c7;
  color: #92400e;
  font-size: 24rpx;
  border-radius: 10rpx;
  padding: 16rpx 20rpx;
  margin-bottom: 18rpx;
  line-height: 1.4;
}
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
.ev-info {
  display: flex;
  flex-direction: column;
  gap: 4rpx;
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
  padding: 6rpx 10rpx;
}
</style>
