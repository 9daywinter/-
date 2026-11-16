// 默认节次时刻表（每校作息不同，正式版做成可配置；14 节制覆盖早晚全时段）
// 2026-11-16 按用户教务系统实际时间修正
export const SLOT_TIMES = [
  ["08:00", "08:45"], // 1
  ["08:50", "09:35"], // 2
  ["09:50", "10:35"], // 3
  ["10:40", "11:25"], // 4
  ["11:30", "12:15"], // 5
  ["13:30", "14:15"], // 6
  ["14:20", "15:05"], // 7
  ["15:20", "16:05"], // 8
  ["16:10", "16:55"], // 9
  ["17:00", "17:45"], // 10
  ["18:30", "19:15"], // 11
  ["19:20", "20:05"], // 12
  ["20:10", "20:55"], // 13
  ["21:00", "21:45"], // 14
];

export const SLOT_COUNT = SLOT_TIMES.length;
export const DAY_NAMES = ["一", "二", "三", "四", "五", "六", "日"];

// 日程小图标（emoji），2026-11-14 定制：删铅笔/箱子/足球(改自行车)/试剂，
// 麦克风改电吉他挪到末位，睡觉排书本后、医院排拉面后。默认（含旧数据兜底）= 🎸
export const EVENT_ICONS = [
  "📚", "💤", "🚲", "🎉", "🎂", "🚗", "🍜", "🏥", "🎬", "💼", "🎸",
];
export const DEFAULT_EVENT_ICON = "🎸";

// 时间确定度四档：解析通知时自动判定，表单可改
export const TIME_STATUS = [
  { key: "exact", label: "✅ 准点" },
  { key: "start_only", label: "▶️ 仅开始" },
  { key: "fuzzy", label: "⏰ 大概" },
  { key: "todo", label: "❓ 待定" },
];

// 课程卡片配色（按名称哈希取色，同一门课颜色稳定）
const PALETTE = [
  ["#EEF2FF", "#4F46E5"],
  ["#ECFDF5", "#059669"],
  ["#FFF7ED", "#EA580C"],
  ["#FDF2F8", "#DB2777"],
  ["#F0F9FF", "#0284C7"],
  ["#FAFAF5", "#65A30D"],
];
export function courseColor(name) {
  let h = 0;
  for (const ch of name || "") h = (h * 31 + ch.codePointAt(0)) % 997;
  return PALETTE[h % PALETTE.length];
}
