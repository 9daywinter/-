"""解析教务系统导出的课表文件（.docx / .xlsx）→ 课程列表。

纯结构化解析：不联网、不花钱、不会识别错。docx 取 word/document.xml 的表格，
xlsx 取第一个工作表的网格，两者统一成「行=第N节，列=星期几」的网格再抽取。
"""
import io
import re
import zipfile
from xml.etree import ElementTree

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
WEEK_TITLE = {"星期一": 1, "星期二": 2, "星期三": 3, "星期四": 4,
              "星期五": 5, "星期六": 6, "星期日": 7, "周日": 7}
WEEK_CHARS = "0123456789,，-－~～至周 \t"


def parse_timetable_file(data: bytes) -> list[dict]:
    """docx / xlsx 自动识别；返回课程 dict 列表（未做周次越界清洗）"""
    if not data.startswith(b"PK"):
        raise ValueError("不是合法的 docx/xlsx 文件")
    names = zipfile.ZipFile(io.BytesIO(data)).namelist()
    if "word/document.xml" in names:
        return _parse_docx(data)
    if any(n.startswith("xl/") for n in names):
        return _parse_xlsx(data)
    raise ValueError("只支持 .docx / .xlsx 格式")


# ---------- docx ----------

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


# ---------- xlsx ----------

def _parse_xlsx(data: bytes) -> list[dict]:
    import openpyxl  # 仅 xlsx 分支需要
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        wb = openpyxl.load_workbook(io.BytesIO(data), data_only=True)
    ws = wb.active
    grid = [[ws.cell(r, c).value for c in range(1, ws.max_column + 1)]
            for r in range(1, ws.max_row + 1)]
    return _grid_to_courses(grid)


# ---------- 共用：网格 → 课程 ----------

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
            continue  # 跳过“合并展示课程 / 未排具体节次课程”等杂项区
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
