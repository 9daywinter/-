// notice.js 规则引擎回归测试（node scripts/test-notice.mjs）
// app 包无 type:module，用 data-URL 动态 import 源码（模块零依赖，可行）
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/utils/notice.js"), "utf8");
const notice = await import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));

// 固定"今天"=2026-11-15(周日) 20:00，全部用例可复现
const NOW = new Date(2026, 10, 15, 20, 0, 0);
let fail = 0;
function check(name, cond, detail) {
  console.log((cond ? "  ✓ " : "  ✗ ") + name + (cond || !detail ? "" : "  ← " + JSON.stringify(detail)));
  if (!cond) fail++;
}

console.log("== looksLikeNotice ==");
check("长文是通知", notice.looksLikeNotice("各位同学：明天下午两点在教学楼201开班会，请准时参加。"));
check("短句不是通知", !notice.looksLikeNotice("明天11叫我"));
check("公文词是通知", notice.looksLikeNotice("明天交作业，要求打印"));

console.log("== parseNotice 群通知 ==");
const n1 = notice.parseNotice(
  "各位同学：\n1. 明天下午2点在教学楼302进行高数期中考试，时长90分钟。\n2. 请带学生证，8:00开始入场，16:00结束。", NOW);
check("标题=高数期中考试", n1 && n1.title === "高数期中考试", n1 && n1.title);
check("标记式起止 exact", n1 && n1.timeStatus === "exact", n1 && n1.timeStatus);
check("开始=明天8:00", n1 && n1.startAt === "2026-11-16T08:00:00", n1 && n1.startAt);
check("结束=明天16:00", n1 && n1.endAt === "2026-11-16T16:00:00", n1 && n1.endAt);
check("地点=教学楼302", n1 && n1.location.includes("教学楼302"), n1 && n1.location);
check("备注含时长", n1 && /90分钟/.test(n1.note || ""), n1 && n1.note);

const n2 = notice.parseNotice("讲座通知：11月21日下午在图书馆报告厅举行考研宣讲会，欢迎大家参加。", NOW);
check("无时刻→fuzzy", n2 && n2.timeStatus === "fuzzy", n2 && n2.timeStatus);
check("下午默认区间13-18", n2 && n2.startAt === "2026-11-21T13:00:00" && n2.endAt === "2026-11-21T18:00:00", n2 && [n2.startAt, n2.endAt]);
check("地点=图书馆报告厅", n2 && n2.location.includes("报告厅"), n2 && n2.location);

const n3 = notice.parseNotice("周五18:00-周日23:59 进行宿舍卫生检查", NOW);
check("跨天时段解析", n3 && n3.startAt.slice(0, 10) === "2026-11-20" && n3.endAt.slice(0, 10) === "2026-11-22", n3 && [n3.startAt, n3.endAt]);

const n4 = notice.parseNotice("今晚19:00开始在wla406上晚自习，请自觉保持安静。", NOW);
check("今晚=今天", n4 && n4.startAt.slice(0, 10) === "2026-11-15", n4 && n4.startAt);
check("仅开始→start_only+1h", n4 && n4.timeStatus === "start_only" && n4.endAt === "2026-11-15T20:00:00", n4 && [n4.timeStatus, n4.endAt]);
check("字母教室 wla406", n4 && n4.location === "wla406", n4 && n4.location);

const n5 = notice.parseNotice("请大家在操场集合体测，入口北门。", NOW);
check("无时间→todo", n5 && n5.timeStatus === "todo", n5 && n5.timeStatus);
check("主地点=操场", n5 && n5.location.includes("操场"), n5 && n5.location);
check("路径细节进备注", n5 && /北门/.test(n5.note || ""), n5 && n5.note);

console.log("== resolveEventTime 速记 ==");
const s1 = notice.resolveEventTime("明天11，叫我，有会到24点", NOW);
check("开始=明天11:00", s1.startAt === "2026-11-16T11:00:00", s1);
check("到24点→23:59", s1.endAt === "2026-11-16T23:59:00", s1);
check("标题去掉叫我", s1.title === "有会", s1.title);

const s2 = notice.resolveEventTime("周六全天志愿者", NOW);
check("全天8-22", s2.startAt.slice(11) === "08:00:00" && s2.endAt.slice(11) === "22:00:00", s2);

const s3 = notice.resolveEventTime("后天下午三点半口语课 一个半小时", NOW);
check("三点半=15:30", s3.startAt === "2026-11-17T15:30:00", s3);
check("时长一个半小时", s3.endAt === "2026-11-17T17:00:00", s3);

const s4 = notice.resolveEventTime("今晚吉他课", NOW);
check("今晚=今天晚上", s4.startAt.slice(0, 13) === "2026-11-15T19", s4);

console.log(fail ? `\n${fail} 项未过` : "\n全部通过");
process.exit(fail ? 1 : 0);
