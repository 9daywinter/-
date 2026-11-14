# -*- coding: utf-8 -*-
"""v2 换学期工具：教务系统导出的课表文件（.docx / .xlsx）→ 手机可粘贴的课表 JSON。

纯离线结构化解析（解析逻辑与 v1 后端 timetable_file.py 完全一致，已验证过真实教务格式），
不联网、不需要 LLM。用法：

    python scripts/import_timetable.py 学生课表.xlsx [总周数，默认20]

输出 timetable.json：手机打开 App → 主页 → 课表管理 → 从文件导入课表 → 粘贴全文。
（xlsx 分支需要 openpyxl：pip install openpyxl；docx 无任何依赖）
"""
import io
import json
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
WEEK_TITLE = {"星期一": 1, "星期二": 2, "星期三": 3, "星期四": 4,
              "星期五": 5, "星期六": 6, "星期日": 7, "周日": 7}
WEEK_CHARS = "0123456789,，-－~～至周 \t"
SLOT_COUNT = 14  # 与 app/src/utils/slots.js 保持一致


# ---------- 文件 → 网格 → 课程（v1 timetable_file.py 原样移植） ----------

def parse_timetable_file(data: bytes) -> list[dict]:
    if not data.startswith(b"PK"):
        raise ValueError("不是合法的 docx/xlsx 文件")
    names = zipfile.ZipFile(io.BytesIO(data)).namelist()
    if "word/document.xml" in names:
        return _parse_docx(data)
    if any(n.startswith("xl/") for n in names):
        return _parse_xlsx(data)
    raise ValueError("只支持 .docx / .xlsx 格式")


def _parse_docx(data: bytes) -> list[dict]:
    z = zipfile.ZipFile(io.BytesIO(data))
    root = ElementTree.fromstring(z.read("word/document.xml"))
    for tbl in root.iter(W + "tbl"):
        rows = []
        for tr in tbl.findall(W + "tr"):
            cells = []
            for tc in tr.findall(W + "tc"):
                lines = []
                for p in tc.findall(W + "p"):
                    buf = []
                    for node in p.iter():  # 软换行 <w:br/> 也要断行，否则课名和详情粘在一起
                        if node.tag == W + "t":
                            buf.append(node.text or "")
                        elif node.tag in (W + "br", W + "cr"):
                            buf.append("\n")
                    text = "".join(buf)
                    for seg in text.split("\n"):
                        if seg.strip():
                            lines.append(seg.strip())
                cells.append("\n".join(lines))
            rows.append(cells)
        if any("星期一" in str(c or "") for c in (rows[0] if rows else [])) or \
           any("星期一" in str((r[1] if len(r) > 1 else "") or "") for r in rows[:3]):
            return _grid_to_courses(rows)
    return []


def _parse_xlsx(data: bytes) -> list[dict]:
    try:
        import openpyxl
    except ImportError:
        raise ValueError("xlsx 需要 openpyxl：pip install openpyxl（或改用教务导出的 .docx）")
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        wb = openpyxl.load_workbook(io.BytesIO(data), data_only=True)
    ws = wb.active
    grid = [[ws.cell(r, c).value for c in range(1, ws.max_column + 1)]
            for r in range(1, ws.max_row + 1)]
    return _grid_to_courses(grid)


def _grid_to_courses(rows: list[list]) -> list[dict]:
    """表头行（前几行里找含 星期一~星期日 的那行）；之后每行首格是「第N节」"""
    header_idx, day_of_col = None, {}
    for ri, cells in enumerate(rows[:5]):
        dmap = {}
        for idx, cell in enumerate(cells):
            for title, day in WEEK_TITLE.items():
                if title in str(cell or ""):
                    dmap[idx] = day
        if dmap:
            header_idx, day_of_col = ri, dmap
            break
    if header_idx is None:
        return []
    out = []
    for cells in rows[header_idx + 1:]:
        first = str(cells[0]).strip() if cells else ""
        if not re.match(r"^第\s*\d+\s*节", first):
            continue  # 跳过"合并展示课程 / 未排具体节次课程"等杂项区
        for idx, day in day_of_col.items():
            if idx >= len(cells):
                continue
            text = str(cells[idx] or "").strip()
            if text:
                out.extend(_parse_cell(text, day))
    return out


def _parse_cell(text: str, day: int) -> list[dict]:
    """一格可能有几门课：课程名行 + 详情行（周次 教师 第X节-第Y节 地点）成对出现"""
    out, pending_name = [], None
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        if "周" in line and re.search(r"第\s*\d+\s*节", line):
            out.append(_parse_detail(pending_name or "未命名课程", line, day))
            pending_name = None
        else:
            pending_name = line
    return [c for c in out if c]


def _parse_detail(name_line: str, detail: str, day: int) -> dict:
    name = re.sub(r"\[[^\]]*\]", "", name_line).strip() or name_line  # 去掉[课程代码]

    # 周次前缀：吃掉开头的 数字,逗号,连字符,周 组成的片段，如 "3周,6周,9-10周 "
    i = 0
    while i < len(detail) and detail[i] in WEEK_CHARS:
        i += 1
    weeks = []
    for part in re.split(r"[,，]", detail[:i]):
        m = re.match(r"(\d+)\s*(?:[-~至]\s*(\d+))?", part.strip())
        if m:
            lo = int(m.group(1))
            hi = int(m.group(2) or m.group(1))
            weeks.extend(range(lo, hi + 1))
    rest = detail[i:].strip()

    sm = re.search(r"第\s*(\d+)\s*节\s*(?:[-—~至]\s*第\s*(\d+)\s*节)?", rest)
    if sm:
        s, e = int(sm.group(1)), int(sm.group(2) or sm.group(1))
        teacher = rest[:sm.start()].strip(" /")
        location = rest[sm.end():].strip()
    else:  # 详情行没写节次（少见），兜底第1节
        s, e, teacher, location = 1, 1, "", ""
    return {"name": name, "teacher": teacher, "location": location,
            "day_of_week": day, "start_slot": s, "end_slot": e, "weeks": weeks}


# ---------- 清洗（v1 ai.py _clean_course 原样移植） ----------

def clean_course(c: dict, total: int) -> dict | None:
    try:
        name = str(c.get("name") or c.get("course") or "").strip()
        if not name:
            return None
        day = int(c.get("day_of_week") or 0)
        if not 1 <= day <= 7:
            return None
        s, e = int(c.get("start_slot") or 0), int(c.get("end_slot") or 0)
        s, e = max(1, min(s, SLOT_COUNT)), max(1, min(e, SLOT_COUNT))
        if e < s:
            s, e = e, s
        weeks = c.get("weeks") or []
        if isinstance(weeks, str):  # "1-16" 之类
            weeks = [int(x) for x in re.findall(r"\d+", weeks)]
        weeks = sorted({w for w in weeks if 1 <= w <= total}) or list(range(1, total + 1))
        return {
            "name": name[:60],
            "teacher": str(c.get("teacher") or "")[:30],
            "location": str(c.get("location") or "")[:60],
            "day_of_week": day,
            "start_slot": s,
            "end_slot": e,
            "weeks": weeks,
        }
    except (TypeError, ValueError):
        return None


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    src = Path(sys.argv[1])
    total = int(sys.argv[2]) if len(sys.argv) > 2 else 20
    if not src.exists():
        sys.exit(f"找不到文件：{src}")

    raw = parse_timetable_file(src.read_bytes())
    courses = [c for c in (clean_course(x, total) for x in raw) if c]
    if not courses:
        sys.exit("没解析出课程——文件里找不到「星期一…星期日 + 第N节」的课表网格，确认是教务系统导出的原文件")

    out = src.parent / "timetable.json"
    out.write_text(json.dumps(
        {"app": "pintime", "kind": "timetable", "total_weeks": total, "courses": courses},
        ensure_ascii=False), encoding="utf-8")

    print(f"解析出 {len(courses)} 门课：")
    by_day = {}
    for c in courses:
        by_day.setdefault(c["day_of_week"], []).append(c)
    for d in sorted(by_day):
        parts = []
        for c in by_day[d]:
            week_note = "" if len(c["weeks"]) >= total else f"·{len(c['weeks'])}周"
            parts.append(f"{c['name']}({c['start_slot']}-{c['end_slot']}节{week_note})")
        print(f"  周{'一二三四五六日'[d - 1]}：{'、'.join(parts)}")
    print(f"\n已生成 → {out}")
    print("下一步：把 timetable.json 的内容发到手机（微信文件传输助手即可），"
          "在 App「主页 → 课表管理 → 从文件导入课表」里粘贴。")


if __name__ == "__main__":
    main()
