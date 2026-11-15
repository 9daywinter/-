// 课表文件解析（纯规则，零依赖）——scripts/import_timetable.py 的忠实 JS 移植，
// 供微信小程序在手机端直接解析教务系统导出的 .docx/.xlsx（解压读文件由调用方
// FileSystemManager 完成，这里只吃 XML 字符串）。规则与 PC 脚本 / v1 后端
// timetable_file.py 逐条对齐，已验证真实教务格式。
//
// 对外两个入口：
//   parseDocxXml(xmlText, total = 20)                      word/document.xml 全文 → { courses, rows, skipped }
//   parseXlsxParts(sheetXml, sharedStringsXml, total = 20) xl/worksheets/sheetN.xml + xl/sharedStrings.xml → 同上
// courses 元素与 PC 脚本 timetable.json 完全一致：
//   { name, teacher, location, day_of_week(1-7), start_slot, end_slot(1-14 越界裁剪), weeks(数字数组) }
// rows = 表头后实际解析的数据行数（首格「第N节」）；skipped = 表头后跳过的行数
// （"合并展示课程 / 未排具体节次课程"等杂项区、空行）。total = 学期总周数（默认 20
// 同 PC 脚本）：周次越界裁掉、空周次补满 1..total。
// 注意：本文件会被 app/scripts/sync-cf.mjs 以 IIFE segment 拼进云函数 CJS（同
// notice.js 机制），因此不得 import 任何东西——SLOT_COUNT 硬编码 14（与 slots.js 一致）。

const SLOT_COUNT = 14; // 节次上限，勿 import slots.js（见上），改作息时两处同步改
const WEEK_TITLE = [ // 表头星期标题 → day_of_week（py dict 同序；同格命中多个时后者覆盖）
  ["星期一", 1], ["星期二", 2], ["星期三", 3], ["星期四", 4],
  ["星期五", 5], ["星期六", 6], ["星期日", 7], ["周日", 7],
];
const WEEK_CHARS = "0123456789,，" + "-－" + "~～" + "至周 \t"; // 周次前缀合法字符（含全角连字符/波浪线）

// ============================== XML 基础（正则/字符串，不引库） ==============================

function unescapeXml(s) {
  if (!s || s.indexOf("&") === -1) return s;
  const map = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return s.replace(/&(amp|lt|gt|quot|apos|#x[0-9a-fA-F]+|#\d+);/g, (all, g) => {
    if (map[g]) return map[g];
    const hex = g[1] === "x"; // "#x1F" 取十六进制，"#19968" 取十进制（注意 slice 起点）
    return String.fromCodePoint(parseInt(hex ? g.slice(2) : g.slice(1), hex ? 16 : 10));
  });
}

// [from,to) 内 <w:tag> 直接子元素的 [内容起, 内容止) 区间。同名标签按出现次数配深度
// （w:tbl 经 w:tc 嵌套、w:tc 经嵌套表格间接嵌套，开/闭计数配对即可还原"直接子级"，
// 等价于 ElementTree 的 findall(W+tag)）。自闭合标签（<w:p/>）产出空区间。
function childRegions(xml, from, to, tag) {
  const out = [];
  const re = new RegExp("<(/?)w:" + tag + "\\b[^>]*>", "g");
  re.lastIndex = from;
  let depth = 0;
  let start = -1;
  let m;
  while ((m = re.exec(xml)) && m.index < to) {
    const closing = m[1] === "/";
    if (!closing && m[0].endsWith("/>")) {
      if (depth === 0) out.push([m.index + m[0].length, m.index + m[0].length]);
    } else if (!closing) {
      if (depth === 0) start = m.index + m[0].length;
      depth++;
    } else {
      depth--;
      if (depth === 0) out.push([start, m.index]);
      if (depth < 0) depth = 0; // 容错：残缺标签
    }
  }
  return out;
}

// ============================== docx：document.xml → 网格 ==============================

// 全文所有 <w:tbl>（含嵌套，按开标签文档序，等价 root.iter(w:tbl)）
function collectTables(xml) {
  const out = [];
  const stack = [];
  const re = /<w:tbl\b[^>]*>|<\/w:tbl\s*>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[0][1] === "/") {
      const open = stack.pop();
      if (open) out[open.order] = { start: open.contentStart, end: m.index };
    } else if (m[0].endsWith("/>")) {
      out.push({ start: m.index + m[0].length, end: m.index + m[0].length });
    } else {
      stack.push({ contentStart: m.index + m[0].length, order: out.length });
      out.push(null); // 占位，闭标签就位后回填
    }
  }
  return out.filter(Boolean);
}

// 一段 <w:p> 的文本：所有 <w:t> 按序拼接，<w:br/>/<w:cr/> 记为换行
// （软换行必须断行，否则课名和详情粘在一行——py p.iter() 同款）
function paragraphText(xml, from, to) {
  let text = "";
  const re = /<w:(t|br|cr)\b([^>]*)>/g;
  re.lastIndex = from;
  let m;
  while ((m = re.exec(xml)) && m.index < to) {
    if (m[1] !== "t") {
      text += "\n";
    } else if (!m[2].endsWith("/")) {
      const close = xml.indexOf("</w:t>", re.lastIndex);
      const end = close === -1 || close >= to ? to : close;
      text += unescapeXml(xml.slice(re.lastIndex, end));
      if (close === -1 || close >= to) break;
      re.lastIndex = close + 6;
    }
  }
  return text;
}

// 一个 <w:tc> 的文本：各直属 <w:p> 的非空行以 \n 拼（嵌套表格内的段落不算本格内容）
function docxCellText(xml, from, to) {
  const nested = childRegions(xml, from, to, "tbl");
  const lines = [];
  for (const [ps, pe] of childRegions(xml, from, to, "p")) {
    if (nested.some(([ts, te]) => ps < te && ts < pe)) continue;
    for (const seg of paragraphText(xml, ps, pe).split("\n")) {
      const t = seg.trim();
      if (t) lines.push(t);
    }
  }
  return lines.join("\n");
}

// 表格 → [[单元格文本, ...], ...]（只取直属 tr/tc；gridSpan/vMerge 不展开，与 py 一致）
function docxTableRows(xml, tbl) {
  const rows = [];
  for (const [rs, rEnd] of childRegions(xml, tbl.start, tbl.end, "tr")) {
    const cells = [];
    for (const [cs, cEnd] of childRegions(xml, rs, rEnd, "tc")) {
      cells.push(docxCellText(xml, cs, cEnd));
    }
    rows.push(cells);
  }
  return rows;
}

// ============================== xlsx：sheet.xml + sharedStrings.xml → 网格 ==============================

// xl/sharedStrings.xml → 字符串数组（富文本 <r><t>… 拼接），索引即 <c t="s"><v>i</v> 的 i
function parseSharedStrings(xml) {
  const out = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si\s*>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    let s = "";
    const tRe = /<t\b[^>]*?\/>|<t\b([^>]*)>([\s\S]*?)<\/t\s*>/g;
    let tm;
    while ((tm = tRe.exec(m[1]))) s += tm[2] === undefined ? "" : unescapeXml(tm[2]);
    out.push(s);
  }
  return out;
}

// 列字母 → 序号（A=1，AA=27）
function colToIdx(letters) {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n;
}

// 一个 <c> 的值：t="s" → 共享字符串；t="inlineStr" → <is> 内 <t> 拼接；否则 <v> 原文（数字即字符串）
function xlsxCellText(body, attrs, sst) {
  const tM = /\bt="([^"]*)"/.exec(attrs);
  const type = tM ? tM[1] : "";
  if (type === "inlineStr") {
    const isM = /<is\b[^>]*>([\s\S]*?)<\/is\s*>/.exec(body);
    if (!isM) return "";
    let s = "";
    const tRe = /<t\b[^>]*?\/>|<t\b([^>]*)>([\s\S]*?)<\/t\s*>/g;
    let tm;
    while ((tm = tRe.exec(isM[1]))) s += tm[2] === undefined ? "" : unescapeXml(tm[2]);
    return s;
  }
  const vM = /<v\b[^>]*>([\s\S]*?)<\/v\s*>/.exec(body);
  if (!vM) return "";
  const raw = unescapeXml(vM[1]);
  if (type === "s") {
    const i = parseInt(raw, 10);
    return sst[i] != null ? sst[i] : "";
  }
  return raw;
}

// sheet XML → 二维字符串网格（openpyxl 的 ws.cell(r,c).value 等价；缺格补 ""，行/列号
// 缺失时按上一格 +1 兜底）。末尾全空行裁掉——只为 rows/skipped 计数不被样式空行灌水，
// 空行本就匹配不上「第N节」，不影响课程。
function sheetToGrid(xml, sst) {
  const cellsByRow = new Map();
  let maxRow = 0;
  let maxCol = 0;
  let rowFallback = 0;
  const rowRe = /<row\b([^>]*?)\/>|<row\b([^>]*)>([\s\S]*?)<\/row\s*>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const attrs = rm[1] !== undefined ? rm[1] : rm[2];
    const body = rm[1] !== undefined ? "" : rm[3];
    const rAttr = /\br="(\d+)"/.exec(attrs);
    const rowNum = rAttr ? parseInt(rAttr[1], 10) : rowFallback + 1;
    rowFallback = rowNum;
    if (rowNum > maxRow) maxRow = rowNum;
    const rowCells = cellsByRow.get(rowNum) || new Map();
    cellsByRow.set(rowNum, rowCells);
    let colFallback = 0;
    const cRe = /<c\b([^>]*?)\/>|<c\b([^>]*)>([\s\S]*?)<\/c\s*>/g;
    let cm;
    while ((cm = cRe.exec(body))) {
      const cAttrs = cm[1] !== undefined ? cm[1] : cm[2];
      const cBody = cm[1] !== undefined ? "" : cm[3];
      const refM = /\br="([A-Z]+)(\d+)"/.exec(cAttrs);
      const col = refM ? colToIdx(refM[1]) : colFallback + 1;
      colFallback = col;
      if (col > maxCol) maxCol = col;
      rowCells.set(col, xlsxCellText(cBody, cAttrs, sst));
    }
  }
  const grid = [];
  for (let r = 1; r <= maxRow; r++) {
    const rc = cellsByRow.get(r);
    const row = new Array(maxCol).fill("");
    if (rc) for (const [c, v] of rc) row[c - 1] = v;
    grid.push(row);
  }
  while (grid.length && grid[grid.length - 1].every((c) => !String(c || "").trim())) grid.pop();
  return grid;
}

// ============================== 网格 → 课程（v1 timetable_file.py 原样移植） ==============================

// 表头行：前 5 行里找含 星期一~周日 的那行，记下列号 → 星期；之后每行首格须是「第N节」
function gridToCourses(rows) {
  let headerIdx = -1;
  const dayOfCol = new Map();
  for (let ri = 0; ri < Math.min(5, rows.length); ri++) {
    const dmap = new Map();
    rows[ri].forEach((cell, idx) => {
      for (const [title, day] of WEEK_TITLE) {
        if (String(cell || "").includes(title)) dmap.set(idx, day);
      }
    });
    if (dmap.size) {
      headerIdx = ri;
      for (const [k, v] of dmap) dayOfCol.set(k, v);
      break;
    }
  }
  if (headerIdx < 0) return { raw: [], rows: 0, skipped: 0 };
  const raw = [];
  let rowCount = 0;
  let skipped = 0;
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const cells = rows[r] || [];
    const first = String(cells[0] || "").trim();
    if (!/^第\s*\d+\s*节/.test(first)) {
      skipped++; // 跳过"合并展示课程 / 未排具体节次课程"等杂项区
      continue;
    }
    rowCount++;
    for (const [idx, day] of dayOfCol) {
      if (idx >= cells.length) continue;
      const text = String(cells[idx] || "").trim();
      if (text) raw.push(...parseCell(text, day));
    }
  }
  return { raw, rows: rowCount, skipped };
}

// 一格可能有几门课：课程名行 + 详情行（周次 教师 第X节-第Y节 地点）成对出现
function parseCell(text, day) {
  const out = [];
  let pendingName = null;
  for (const line0 of text.split(/\r\n|\r|\n/)) {
    const line = line0.trim();
    if (!line) continue;
    if (line.includes("周") && /第\s*\d+\s*节/.test(line)) {
      out.push(parseDetail(pendingName != null ? pendingName : "未命名课程", line, day));
      pendingName = null;
    } else {
      pendingName = line;
    }
  }
  return out.filter(Boolean);
}

// 详情行：先吃掉开头的 数字/逗号/连字符/周 组成的周次片段（如 "3周,6周,9-10周"），
// 再从剩余部分抽 教师 / 节次 / 地点。注意周次区间只认半角 -~ 和"至"（全角连字符
// 会截断成单周）——py 正则原样如此，保持一致。
function parseDetail(nameLine, detail, day) {
  const stripped = nameLine.replace(/\[[^\]]*\]/g, "").trim(); // 去掉[课程代码]
  const name = stripped || nameLine;
  let i = 0;
  while (i < detail.length && WEEK_CHARS.includes(detail[i])) i++;
  const weeks = [];
  for (const part of detail.slice(0, i).split(/[,，]/)) {
    const m = /^(\d+)\s*(?:[-~至]\s*(\d+))?/.exec(part.trim());
    if (m) {
      const lo = parseInt(m[1], 10);
      const hi = parseInt(m[2] != null ? m[2] : m[1], 10);
      for (let w = lo; w <= hi; w++) weeks.push(w);
    }
  }
  const rest = detail.slice(i).trim();
  const sm = /第\s*(\d+)\s*节\s*(?:[-—~至]\s*第\s*(\d+)\s*节)?/.exec(rest);
  let s;
  let e;
  let teacher;
  let location;
  if (sm) {
    s = parseInt(sm[1], 10);
    e = parseInt(sm[2] != null ? sm[2] : sm[1], 10);
    teacher = rest.slice(0, sm.index).replace(/^[ /]+|[ /]+$/g, "");
    location = rest.slice(sm.index + sm[0].length).trim();
  } else {
    s = 1; e = 1; teacher = ""; location = ""; // 详情行没写节次（少见），兜底第1节
  }
  return { name, teacher, location, day_of_week: day, start_slot: s, end_slot: e, weeks };
}

// ============================== 清洗（v1 ai.py _clean_course 原样移植） ==============================

// day 裁到 1-7、节次裁到 1-14（e<s 交换）、周次裁到 1-total 去重排序（空则补满 1..total）
function cleanCourse(c, total) {
  if (!c) return null;
  const name = String(c.name || c.course || "").trim();
  if (!name) return null;
  const day = parseInt(c.day_of_week, 10) || 0;
  if (!(day >= 1 && day <= 7)) return null;
  let s = Math.max(1, Math.min(parseInt(c.start_slot, 10) || 0, SLOT_COUNT));
  let e = Math.max(1, Math.min(parseInt(c.end_slot, 10) || 0, SLOT_COUNT));
  if (e < s) {
    const t = s;
    s = e;
    e = t;
  }
  let weeks = c.weeks || [];
  if (typeof weeks === "string") weeks = (weeks.match(/\d+/g) || []).map(Number);
  weeks = [...new Set(weeks.filter((w) => w >= 1 && w <= total))].sort((a, b) => a - b);
  if (!weeks.length) weeks = Array.from({ length: total }, (_, i) => i + 1);
  return {
    name: name.slice(0, 60),
    teacher: String(c.teacher || "").slice(0, 30),
    location: String(c.location || "").slice(0, 60),
    day_of_week: day,
    start_slot: s,
    end_slot: e,
    weeks,
  };
}

// ============================== 对外入口 ==============================

// word/document.xml 全文。教务 docx 里第一张含「星期一」表头的表格即课表
// （首行含"星期一"，或前 3 行的第 2 列含"星期一"），取第一张命中的，其余表忽略。
export function parseDocxXml(xmlText, total = 20) {
  const xml = String(xmlText || "");
  for (const tbl of collectTables(xml)) {
    const rows = docxTableRows(xml, tbl);
    const hit =
      (rows.length > 0 && rows[0].some((c) => c.includes("星期一"))) ||
      rows.slice(0, 3).some((r) => r.length > 1 && String(r[1] || "").includes("星期一"));
    if (hit) {
      const g = gridToCourses(rows);
      return {
        courses: g.raw.map((c) => cleanCourse(c, total)).filter(Boolean),
        rows: g.rows,
        skipped: g.skipped,
      };
    }
  }
  return { courses: [], rows: 0, skipped: 0 };
}

// xl/worksheets/sheetN.xml（课表那张表）+ xl/sharedStrings.xml（没有传 "" 即可）
export function parseXlsxParts(sheetXml, sharedStringsXml, total = 20) {
  const sst = parseSharedStrings(String(sharedStringsXml || ""));
  const g = gridToCourses(sheetToGrid(String(sheetXml || ""), sst));
  return {
    courses: g.raw.map((c) => cleanCourse(c, total)).filter(Boolean),
    rows: g.rows,
    skipped: g.skipped,
  };
}
