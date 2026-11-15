<template>
  <view class="page">
    <!-- 模式切换 -->
    <view class="tabs">
      <view :class="['tab', mode === 'file' && 'on']" @click="mode = 'file'">📄 课表文件</view>
      <view :class="['tab', mode === 'text' && 'on']" @click="mode = 'text'">📋 粘贴文本</view>
      <view :class="['tab', mode === 'image' && 'on']" @click="mode = 'image'">📷 截图</view>
    </view>

    <!-- 课表文件模式（推荐：教务系统导出的 docx/xlsx） -->
    <block v-if="mode === 'file'">
      <view class="drop" @click="pickFile">
        <text class="drop-icon">📄</text>
        <text v-if="!fileName">选教务系统导出的课表文件</text>
        <text v-else class="file-name">{{ fileName }}</text>
        <text class="drop-sub">支持 .docx / .xlsx，本地解析，又快又准</text>
      </view>
      <view class="btn-row" v-if="fileName">
        <button class="btn-primary" :disabled="busy" @click="parseFile">
          {{ busy ? "解析中…" : "解析课表" }}
        </button>
      </view>
      <view class="clear-row">
        重新导入会叠加旧课？先
        <text class="clear-link" @click="clearCourses">清空现有课表</text>
      </view>
    </block>

    <!-- 截图模式 -->
    <block v-if="mode === 'image'">
      <view v-if="!imgSrc" class="drop" @click="chooseImage">
        <text class="drop-icon">📷</text>
        <text>点这里选课表截图</text>
        <text class="drop-sub">教务系统课表页截图，识别后可逐条校对</text>
      </view>
      <block v-else>
        <image :src="imgSrc" mode="widthFix" class="preview" @click="chooseImage" />
        <view class="btn-row">
          <button class="btn-primary" :disabled="busy" @click="recognize">
            {{ busy ? "识别中…" : "开始识别" }}
          </button>
        </view>
      </block>
    </block>

    <!-- 文本模式 -->
    <block v-else>
      <textarea
        v-model="pasted"
        class="ta"
        placeholder="一行一门课，例如：&#10;高等数学 周一 1-2节 1-16周 教三301&#10;大学英语 周三 3-4节 教四402"
        :maxlength="4000"
      />
      <view class="btn-row">
        <button class="btn-primary" :disabled="busy" @click="parseText">
          {{ busy ? "解析中…" : "解析文本" }}
        </button>
      </view>
    </block>

    <!-- 校对列表 -->
    <block v-if="rows.length">
      <view class="result-head">
        <text>识别到 {{ rows.length }} 门课（来自{{ by === "llm" ? "AI 识图" : by === "file" ? "课表文件" : "文本规则" }}，请核对）</text>
        <text class="toggle-all" @click="toggleAll">{{ allChecked ? "全不选" : "全选" }}</text>
      </view>
      <view v-for="(r, i) in rows" :key="i" class="row-card" :class="{ off: !r.checked }">
        <view class="row-top">
          <view class="ck" :class="{ on: r.checked }" @click="r.checked = !r.checked">
            <text v-if="r.checked">✓</text>
          </view>
          <input v-model="r.name" class="name-input" placeholder="课程名" />
          <text class="del" @click="rows.splice(i, 1)">✕</text>
        </view>
        <view class="row-mid">
          <picker :range="dayRange" :value="r.day_of_week - 1" @change="(e) => (r.day_of_week = e.detail.value + 1)">
            <view class="mini-val">周{{ DAY_NAMES[r.day_of_week - 1] }} ▾</view>
          </picker>
          <picker :range="slotRange" :value="r.start_slot - 1" @change="(e) => (r.start_slot = +e.detail.value + 1)">
            <view class="mini-val">第{{ r.start_slot }}节 ▾</view>
          </picker>
          <text class="to">至</text>
          <picker :range="slotRange" :value="r.end_slot - 1" @change="(e) => (r.end_slot = +e.detail.value + 1)">
            <view class="mini-val">第{{ r.end_slot }}节 ▾</view>
          </picker>
        </view>
        <view class="row-bot">
          <input v-model="r.location" class="loc-input" placeholder="地点（可空）" />
          <input v-model="r.weeksText" class="weeks-input" placeholder="周次，如 1-16" />
        </view>
      </view>
      <view class="btn-row save-row">
        <button class="btn-primary" :disabled="busy" @click="saveSelected">
          保存所选（{{ checkedCount }} 门）
        </button>
      </view>
    </block>
  </view>
</template>

<script>
import { api, parseWeeks } from "../../utils/api";
import { DAY_NAMES, SLOT_TIMES } from "../../utils/slots";

export default {
  data() {
    return {
      mode: "file",
      fileName: "",
      fileBase64: "",
      imgSrc: "",
      imgBase64: "",
      pasted: "",
      rows: [],
      by: "rule",
      busy: false,
      DAY_NAMES,
      dayRange: DAY_NAMES.map((d) => "周" + d),
      slotRange: SLOT_TIMES.map((t, i) => `第${i + 1}节 ${t[0]}`),
    };
  },
  computed: {
    allChecked() {
      return this.rows.length > 0 && this.rows.every((r) => r.checked);
    },
    checkedCount() {
      return this.rows.filter((r) => r.checked).length;
    },
  },
  methods: {
    pickFile() {
      // #ifdef H5
      // 手机 H5 没有 uni.chooseFile（仅 PC/App 支持），用浏览器原生 file input。
      // 关键：安卓 Chrome 要求 input 必须挂在 DOM 里才能拉起文件选择器
      // （微信 X5 对游离元素宽容，所以之前微信能用 Chrome 不能）
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".docx,.xlsx";
      input.style.cssText = "position:fixed;left:-9999px;top:0;"; // 挂载但不可见
      const cleanup = () => input.remove();
      input.onchange = () => {
        const f = input.files && input.files[0];
        cleanup();
        if (!f) return;
        const fr = new FileReader();
        fr.onload = () => {
          this.fileName = f.name;
          this.fileBase64 = fr.result;
        };
        fr.onerror = () => uni.showToast({ title: "读文件失败，重试一下", icon: "none" });
        fr.readAsDataURL(f);
      };
      input.oncancel = cleanup; // 部分浏览器支持：取消选择时回收
      document.body.appendChild(input); // 必须先进 DOM 再 click
      input.click();
      // #endif
      // #ifdef MP-WEIXIN
      // 小程序：从微信聊天里选文件（先把教务文件发给"文件传输助手"），
      // 本地解压抽 XML，解析走规则引擎（parse-timetable-file 本地直跑）
      wx.chooseMessageFile({
        count: 1,
        type: "file",
        extension: ["docx", "xlsx", "json"],
        success: (r) => {
          const f = r.tempFiles && r.tempFiles[0];
          if (!f) return;
          const name = f.name || "课表文件";
          if (/\.json$/i.test(name)) {
            // PC 脚本产物：直接走文本通道
            uni.getFileSystemManager().readFile({
              path: f.path,
              encoding: "utf8",
              success: (rr) => {
                this.pasted = String(rr.data || "");
                uni.showToast({ title: "已读入，点「解析文本」", icon: "none" });
              },
            });
            return;
          }
          this.busy = true;
          // 小程序 FileSystemManager.unzip 有兼容 bug（真机也 parameter error），
          // 改走云端解压：文件读 base64 → 云函数 adm-zip → XML 回来
          const fs = uni.getFileSystemManager();
          fs.readFile({
            path: f.path,
            encoding: "base64",
            success: async (rr) => {
              try {
                const isDocx = /\.docx$/i.test(name);
                const paths = isDocx
                  ? ["word/document.xml"]
                  : ["xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml", "xl/sharedStrings.xml"];
                const res = await uni.cloud.callFunction({
                  name: "api",
                  data: { method: "POST", path: "/api/unzip-file", body: { file_base64: rr.data, paths } },
                });
                const r = res && res.result;
                if (!r || !r.ok) throw new Error((r && r.error) || "云端解压失败");
                this.mpKind = isDocx ? "docx" : "xlsx";
                this.mpXml = isDocx ? r.data.files["word/document.xml"] : (r.data.files["xl/worksheets/sheet1.xml"] || r.data.files["xl/worksheets/sheet2.xml"]);
                this.mpStrings = isDocx ? undefined : r.data.files["xl/sharedStrings.xml"] || "";
                this.fileName = name;
                this.busy = false;
                uni.showToast({ title: "文件就绪，点「解析文件」", icon: "none" });
              } catch (e) {
                this.busy = false;
                uni.showToast({ title: e.message, icon: "none", duration: 4000 });
              }
            },
            fail: (err) => { this.busy = false; uni.showToast({ title: "读取:" + ((err && err.errMsg) || "未知"), icon: "none", duration: 4000 }); },
          });
        },
      });
      // #endif
      // #ifdef APP-PLUS
      uni.chooseFile({
        count: 1,
        extension: [".docx", ".xlsx"],
        success: (res) => {
          const name = (res.tempFiles && res.tempFiles[0] && res.tempFiles[0].name) || "课表文件";
          const path = res.tempFilePaths && res.tempFilePaths[0];
          if (!path) return;
          plus.io.resolveLocalFileSystemURL(path, (entry) => {
            entry.file((file) => {
              const fr = new FileReader();
              fr.onload = () => {
                this.fileName = name;
                this.fileBase64 = fr.result;
              };
              fr.readAsDataURL(file);
            });
          });
        },
      });
      // #endif
    },
    // #ifdef MP-WEIXIN
    // 从解压目录里抽出 docx/xlsx 的 XML，存起来等 parseFile 用
    readTimetableXml(fs, out, name) {
      const read = (p) => {
        try { return fs.readFileSync(`${out}/${p}`, "utf8"); } catch (e) { return ""; }
      };
      if (/\.docx$/i.test(name)) {
        const xml = read("word/document.xml");
        if (!xml) { this.busy = false; uni.showToast({ title: "不是有效的 docx", icon: "none" }); return; }
        this.mpKind = "docx";
        this.mpXml = xml;
      } else {
        let sheet = read("xl/worksheets/sheet1.xml") || read("xl/worksheets/sheet2.xml");
        const strings = read("xl/sharedStrings.xml");
        if (!sheet) { this.busy = false; uni.showToast({ title: "不是有效的 xlsx", icon: "none" }); return; }
        this.mpKind = "xlsx";
        this.mpXml = sheet;
        this.mpStrings = strings;
      }
      this.fileName = name;
      this.busy = false;
      uni.showToast({ title: "文件就绪，点「解析文件」", icon: "none" });
    },
    // #endif
    async parseFile() {
      // #ifdef MP-WEIXIN
      if (!this.mpKind) {
        uni.showToast({ title: "先选一个文件", icon: "none" });
        return;
      }
      this.busy = true;
      try {
        const res = await api.post("/api/ai/parse-timetable-file", {
          kind: this.mpKind,
          xml: this.mpXml,
          sheet: this.mpKind === "xlsx" ? this.mpXml : undefined,
          strings: this.mpKind === "xlsx" ? this.mpStrings : undefined,
        });
        this.applyRows(res);
      } catch (e) {
        uni.showModal({ title: "解析失败", content: e.message, showCancel: false });
      } finally {
        this.busy = false;
      }
      return;
      // #endif
      // #ifndef MP-WEIXIN
      if (!this.fileBase64) {
        uni.showToast({ title: "先选一个文件", icon: "none" });
        return;
      }
      this.busy = true;
      try {
        const res = await api.post("/api/ai/parse-timetable-file", {
          file_base64: this.fileBase64,
        });
        this.applyRows(res);
      } catch (e) {
        uni.showModal({ title: "解析失败", content: e.message, showCancel: false });
      } finally {
        this.busy = false;
      }
      // #endif
    },
    chooseImage() {
      uni.chooseImage({
        count: 1,
        sizeType: ["compressed"],
        success: (res) => {
          this.imgSrc = res.tempFilePaths[0];
          // H5：blob URL → dataURL；App 打包时换 plus.io（D4 处理）
          fetch(this.imgSrc)
            .then((r) => r.blob())
            .then(
              (blob) =>
                new Promise((resolve) => {
                  const fr = new FileReader();
                  fr.onload = () => resolve(fr.result);
                  fr.readAsDataURL(blob);
                })
            )
            .then((b64) => (this.imgBase64 = b64))
            .catch(() => uni.showToast({ title: "读图失败", icon: "none" }));
        },
      });
    },
    async recognize() {
      if (!this.imgBase64) {
        uni.showToast({ title: "先选一张截图", icon: "none" });
        return;
      }
      this.busy = true;
      try {
        const res = await api.post("/api/ai/parse-timetable", {
          image_base64: this.imgBase64,
        });
        this.applyRows(res);
      } catch (e) {
        uni.showModal({ title: "识别失败", content: e.message, showCancel: false });
      } finally {
        this.busy = false;
      }
    },
    async parseText() {
      if (!this.pasted.trim()) {
        uni.showToast({ title: "先粘贴点课表文字", icon: "none" });
        return;
      }
      this.busy = true;
      try {
        const res = await api.post("/api/ai/parse-timetable-text", { text: this.pasted });
        this.applyRows(res);
      } catch (e) {
        uni.showModal({ title: "解析失败", content: e.message, showCancel: false });
      } finally {
        this.busy = false;
      }
    },
    applyRows(res) {
      this.by = res.by || "rule";
      this.rows = (res.courses || []).map((c) => ({
        checked: true,
        name: c.name,
        teacher: c.teacher || "",
        location: c.location || "",
        day_of_week: c.day_of_week,
        start_slot: c.start_slot,
        end_slot: c.end_slot,
        weeksText: c.weeks && c.weeks.length ? String(c.weeks[0]) + (c.weeks.length > 1 ? "-" + c.weeks[c.weeks.length - 1] : "") : "",
      }));
      if (!this.rows.length) uni.showToast({ title: "没解析出课程，检查下格式", icon: "none" });
    },
    toggleAll() {
      const target = !this.allChecked;
      this.rows.forEach((r) => (r.checked = target));
    },
    clearCourses() {
      uni.showModal({
        title: "清空课表",
        content: "删掉所有已导入的课程，速记日程不受影响",
        confirmText: "清空",
        success: async (res) => {
          if (res.confirm) {
            await api.del("/api/courses");
            uni.showToast({ title: "已清空", icon: "none" });
          }
        },
      });
    },
    async saveSelected() {
      const picked = this.rows.filter((r) => r.checked);
      if (!picked.length) {
        uni.showToast({ title: "至少选一门", icon: "none" });
        return;
      }
      const total = 30; // 后端会按学期 total_weeks 再清洗
      const body = {
        courses: picked.map((r) => ({
          name: (r.name || "").trim(),
          teacher: (r.teacher || "").trim(),
          location: (r.location || "").trim(),
          day_of_week: r.day_of_week,
          start_slot: r.start_slot,
          end_slot: r.end_slot,
          weeks: r.weeksText.trim()
            ? parseWeeks(r.weeksText, total)
            : [],
        })),
      };
      if (body.courses.some((c) => !c.name)) {
        uni.showToast({ title: "有课程名是空的", icon: "none" });
        return;
      }
      this.busy = true;
      try {
        await api.post("/api/courses/batch", body);
        uni.showToast({ title: `已导入 ${body.courses.length} 门课`, icon: "success" });
        setTimeout(() => uni.navigateBack(), 700);
      } catch (e) {
        uni.showToast({ title: e.message, icon: "none" });
      } finally {
        this.busy = false;
      }
    },
  },
};
</script>

<style scoped>
.page {
  padding: 24rpx;
  padding-bottom: calc(60rpx + env(safe-area-inset-bottom));
  max-width: 950px; /* 电脑端居中限宽 */
  margin: 0 auto;
  box-sizing: border-box;
}
.tabs {
  display: flex;
  background: #fff;
  border-radius: 14rpx;
  padding: 8rpx;
  margin-bottom: 24rpx;
}
.tab {
  flex: 1;
  text-align: center;
  padding: 16rpx 0;
  font-size: 28rpx;
  color: #6b7280;
  border-radius: 10rpx;
}
.tab.on {
  background: #4f46e5;
  color: #fff;
  font-weight: 600;
}
.drop {
  background: #fff;
  border: 2rpx dashed #c7cbdb;
  border-radius: 16rpx;
  padding: 80rpx 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12rpx;
  color: #6b7280;
  font-size: 28rpx;
}
.drop-icon {
  font-size: 60rpx;
}
.drop-sub {
  font-size: 22rpx;
  color: #b0b5c1;
}
.file-name {
  color: #4f46e5;
  font-weight: 600;
  word-break: break-all;
  padding: 0 24rpx;
}
.clear-row {
  margin-top: 20rpx;
  font-size: 24rpx;
  color: #9aa1b2;
  text-align: center;
}
.clear-link {
  color: #ef4444;
  padding: 4rpx 8rpx;
}
.preview {
  width: 100%;
  border-radius: 16rpx;
  background: #fff;
}
.ta {
  width: 100%;
  height: 320rpx;
  background: #fff;
  border-radius: 16rpx;
  padding: 20rpx;
  font-size: 26rpx;
  box-sizing: border-box;
}
.btn-row {
  margin-top: 24rpx;
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
.result-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin: 32rpx 0 16rpx;
  font-size: 26rpx;
  color: #4b5563;
}
.toggle-all {
  color: #4f46e5;
}
.row-card {
  background: #fff;
  border-radius: 14rpx;
  padding: 20rpx;
  margin-bottom: 16rpx;
}
.row-card.off {
  opacity: 0.55;
}
.row-top {
  display: flex;
  align-items: center;
  gap: 14rpx;
}
.ck {
  width: 40rpx;
  height: 40rpx;
  border: 2rpx solid #c7cbdb;
  border-radius: 10rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 24rpx;
  flex-shrink: 0;
}
.ck.on {
  background: #4f46e5;
  border-color: #4f46e5;
}
.name-input {
  flex: 1;
  font-size: 30rpx;
  font-weight: 600;
  min-width: 0;
}
.del {
  color: #b0b5c1;
  padding: 4rpx 8rpx;
}
.row-mid {
  display: flex;
  align-items: center;
  gap: 10rpx;
  margin-top: 16rpx;
}
.mini-val {
  background: #f5f6fa;
  border-radius: 10rpx;
  padding: 10rpx 16rpx;
  font-size: 24rpx;
}
.to {
  color: #9aa1b2;
  font-size: 24rpx;
}
.row-bot {
  display: flex;
  gap: 12rpx;
  margin-top: 14rpx;
}
.loc-input {
  flex: 1;
  background: #f5f6fa;
  border-radius: 10rpx;
  padding: 10rpx 16rpx;
  font-size: 24rpx;
  min-width: 0;
}
.weeks-input {
  width: 180rpx;
  background: #f5f6fa;
  border-radius: 10rpx;
  padding: 10rpx 16rpx;
  font-size: 24rpx;
}
.save-row {
  margin-top: 12rpx;
}
</style>
