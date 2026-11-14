"""D2 导入与 AI 能力：教务课表文件解析（docx/xlsx，无需 LLM）、截图识别（LLM）、
课表文本导入、语音/文字速记解析。

设计原则：LLM 只是增强——文件导入和语音速记走内置解析器，没配 Key 也全部能用。
"""
import base64
import json
import re
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Term
from ..schemas import (CourseGuess, FileParseIn, ImageParseIn, TextParseIn,
                       TimetableParseOut, VoiceParseIn, VoiceParseOut,
                       VoiceUploadIn)
from ..utils import timetable_file
from ..utils.asr import AsrError, asr_enabled, transcribe
from ..utils.llm import LLMError, ask_llm, llm_enabled, text_model, vision_model
from ..utils.notice import looks_like_notice, parse_notice
from ..utils.slots import SLOT_COUNT, SLOT_TABLE
from ..utils.times import resolve_event_time
from .deps import get_user
from .terms import get_or_none as get_term

router = APIRouter(prefix="/api/ai", tags=["ai"])

WEEKDAY_CN = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "日": 7, "天": 7}


# ---------- JSON 容错提取 ----------

def _extract_json(raw: str):
    raw = re.sub(r"```(?:json)?", "", raw).strip().strip("`")
    for opener, closer in (("[", "]"), ("{", "}")):
        i, j = raw.find(opener), raw.rfind(closer)
        if i != -1 and j > i:
            try:
                return json.loads(raw[i:j + 1])
            except json.JSONDecodeError:
                continue
    raise LLMError("模型没输出合法 JSON：" + raw[:200])


# ---------- 课程字段清洗（LLM 和规则解析共用） ----------

def _clean_course(c: dict, total: int) -> dict | None:
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


def _total_weeks(db: Session, user: str) -> int:
    term = get_term(db, user)
    return term.total_weeks if term else 20


# ---------- 0) 教务课表文件导入（docx/xlsx，确定性解析，无需 Key） ----------

@router.post("/parse-timetable-file", response_model=TimetableParseOut)
def parse_timetable_file_ep(body: FileParseIn, user: str = Depends(get_user),
                            db: Session = Depends(get_db)):
    total = _total_weeks(db, user)
    b64 = body.file_base64.split(",", 1)[-1]  # 容忍 dataURL 前缀
    try:
        data = base64.b64decode(b64)
    except Exception:
        raise HTTPException(400, detail="文件编码不对，重新选一次试试")
    try:
        raw = timetable_file.parse_timetable_file(data)
    except ValueError as e:
        raise HTTPException(400, detail=str(e))
    courses = [c for c in (_clean_course(x, total) for x in raw) if c]
    return {"by": "file", "courses": courses}


# ---------- 1) 课表截图识别（必须有 Key） ----------

@router.post("/parse-timetable", response_model=TimetableParseOut)
def parse_timetable_image(body: ImageParseIn, user: str = Depends(get_user),
                          db: Session = Depends(get_db)):
    if not llm_enabled():
        raise HTTPException(400, detail="还没配置 LLM_API_KEY：在 server/.env 填好后重启。可先用「粘贴文本」导入")
    total = _total_weeks(db, user)
    system = "你是课表解析助手，只输出 JSON，不输出任何解释文字。"
    prompt = f"""这是教务系统的课表截图。提取出全部课程，输出 JSON 数组，每个元素：
{{"name":"课程名","teacher":"教师名，没有就空字符串","location":"上课地点，没有就空字符串","day_of_week":1到7的整数（1=周一，7=周日）,"start_slot":开始节次整数,"end_slot":结束节次整数,"weeks":[上课周次数组]}}

节次对照表：
{SLOT_TABLE}

规则：
- 周次按截图文字展开成数组，如“1-16周”→[1,2,...,16]；“单周”→[1,3,5,...]；没写周次就用 1-{total}
- 同一门课出现在多个格子（不同周次）就合并成一条，weeks 取并集
- 只输出 JSON 数组本身。"""
    try:
        raw = ask_llm(system, prompt, image_base64=body.image_base64,
                      model=vision_model(), max_tokens=4000)
        data = _extract_json(raw)
    except LLMError as e:
        raise HTTPException(502, detail=str(e))
    if isinstance(data, dict):  # 有的模型会包一层
        data = data.get("courses") or data.get("data") or []
    courses = [c for c in (_clean_course(x, total) for x in data if isinstance(x, dict)) if c]
    return {"by": "llm", "courses": courses}


# ---------- 2) 课表文本导入（有 Key 走 LLM，没 Key 走规则） ----------

@router.post("/parse-timetable-text", response_model=TimetableParseOut)
def parse_timetable_text(body: TextParseIn, user: str = Depends(get_user),
                         db: Session = Depends(get_db)):
    total = _total_weeks(db, user)
    if llm_enabled():
        try:
            raw = ask_llm(
                "你是课表解析助手，只输出 JSON，不输出任何解释文字。",
                f"""把下面这段课表文本解析成 JSON 数组，字段：
{{"name":"","teacher":"","location":"","day_of_week":1到7,"start_slot":1到12,"end_slot":1到12,"weeks":[周次数组]}}
没写周次就 1-{total} 全周。只输出 JSON 数组。

课表文本：
{body.text}""",
                model=text_model(),
            )
            data = _extract_json(raw)
            if isinstance(data, dict):
                data = data.get("courses") or []
            courses = [c for c in (_clean_course(x, total) for x in data if isinstance(x, dict)) if c]
            if courses:
                return {"by": "llm", "courses": courses}
        except LLMError:
            pass  # 降级到规则解析
    courses = _rule_parse_timetable(body.text, total)
    return {"by": "rule", "courses": courses}


def _rule_parse_timetable(text: str, total: int) -> list[dict]:
    """每行一门课：周X + 节次 + 周次 + 地点启发式。覆盖教务系统常见文本格式。"""
    out = []
    for line in (text or "").splitlines():
        line = line.strip()
        if not line:
            continue
        m = re.search(r"(?:周|星期|礼拜)([一二三四五六日天])", line)
        if not m:
            continue
        day = WEEKDAY_CN[m.group(1)]

        sm = re.search(r"第?\s*(\d+)\s*[-~—至]\s*(\d+)\s*节", line) or \
             re.search(r"第?\s*(\d+)\s*[,，]\s*(\d+)\s*节", line)
        if sm:
            s, e = int(sm.group(1)), int(sm.group(2))
        else:
            sm = re.search(r"第?\s*(\d+)\s*节", line)
            if not sm:
                continue
            s = e = int(sm.group(1))

        weeks = []
        wm = None
        single = None
        if re.search(r"单周", line):
            weeks = [w for w in range(1, total + 1) if w % 2 == 1]
        elif re.search(r"双周", line):
            weeks = [w for w in range(1, total + 1) if w % 2 == 0]
        else:
            # 周次必须以“周”字收尾，避免误抓“1-2节”里的节次区间
            wm = re.search(r"[{【\[]?\s*(\d+)\s*[-~—]\s*(\d+)\s*周", line)
            if not wm:
                wm = re.search(r"[{【\[]?\s*(\d+)\s*[,，]\s*(\d+)(?:\s*[,，]\s*\d+)*\s*周", line)
            if wm and not (sm and sm.start() <= wm.start() < sm.end()):
                lo, hi = int(wm.group(1)), int(wm.group(2))
                if lo <= hi <= total:
                    weeks = list(range(lo, hi + 1))
        if not weeks:
            single = re.search(r"(\d{1,2})\s*周", line)
            if single and not (sm and sm.start() <= single.start() < sm.end()):
                weeks = [int(single.group(1))]
        weeks = [w for w in weeks if 1 <= w <= total] or list(range(1, total + 1))

        # 课程名 / 地点：按“原字符串绝对位置”一次性抠掉已匹配片段（逐段删会让索引错位）
        cuts = sorted(p.span() for p in (m, sm, wm, single) if p)
        parts, last = [], 0
        for a, b in cuts:
            parts.append(line[last:a])
            last = b
        parts.append(line[last:])
        eaten = " ".join(x for x in parts if x.strip())
        tokens = [t for t in re.split(r"[\s\t{｛}｝【】\[\]()（）,，、;；|]+", eaten) if t]
        cjk = [t for t in tokens if re.search(r"[一-鿿A-Za-z]", t)]
        if not cjk:
            continue
        loc_cand = [t for t in cjk if (
            re.search(r"[教楼馆区栋层]", t) or re.match(r"^[A-Za-z]+\d", t) or t.startswith("@")
        )]
        if loc_cand and len(cjk) >= 2:
            location = loc_cand[0].lstrip("@")
            name = max((t for t in cjk if t not in loc_cand), key=len, default="")
        else:
            location = ""
            name = max(cjk, key=len)
        if not name:
            continue
        out.append(_clean_course(
            {"name": name, "location": location, "day_of_week": day,
             "start_slot": s, "end_slot": e, "weeks": weeks}, total))
    return [c for c in out if c]


# ---------- 3) 语音/文字速记解析（有 Key 走 LLM，没 Key 走规则） ----------

@router.post("/parse-voice", response_model=VoiceParseOut)
def parse_voice(body: VoiceParseIn, user: str = Depends(get_user)):
    text = (body.text or "").strip()[:200]
    if not text:
        raise HTTPException(400, detail="说点什么吧")
    now = datetime.now()

    if llm_enabled():
        try:
            raw = ask_llm(
                "你从大学生的一句话里提取日程信息，只输出 JSON。",
                f"""现在是 {now.strftime('%Y-%m-%d %H:%M')}（周{'一二三四五六日'[now.weekday()]}）。
从这句话里提取日程：“{text}”
输出 {{"title":"事件关键词(不超过12字，只留事件本身，去掉所有时间/日期/语气词)","note":"补充说明，没有就空字符串","start":"YYYY-MM-DD HH:MM","end":"YYYY-MM-DD HH:MM"}}
没说日期就用今天；end 没说就比 start 晚 1 小时。只输出 JSON。""",
                model=text_model(), max_tokens=300,
            )
            data = _extract_json(raw)
            title = str(data.get("title") or "").strip() or text[:12]
            note = str(data.get("note") or "").strip()
            start = datetime.strptime(str(data["start"])[:16], "%Y-%m-%d %H:%M")
            end = datetime.strptime(str(data["end"])[:16], "%Y-%m-%d %H:%M")
            if end <= start:
                end = start + timedelta(hours=1)
            return VoiceParseOut(title=title[:30], note=note[:100],
                                 start_at=start, end_at=end, by="llm")
        except (LLMError, KeyError, ValueError):
            pass  # 降级到规则

    # 长文本（微信复制的群通知）走专用解析器：时间标记词配对 + 地点 + 主题提取
    if looks_like_notice(text):
        r = parse_notice(text, now)
        if r:
            return VoiceParseOut(**r, by="notice")

    r = resolve_event_time(text, now)
    return VoiceParseOut(**r, by="rule")


# ---------- 4) 录音上传识别（H5 / APK 通用，绕开浏览器 SpeechRecognition） ----------

@router.post("/voice-upload")
def voice_upload(body: VoiceUploadIn, user: str = Depends(get_user)):
    """录音音频(base64) → ASR 文字 → 复用 parse-voice 的解析。
    没配 ASR_API_KEY 返回 400 友好提示，前端降级到手填/打字。"""
    if not asr_enabled():
        raise HTTPException(400, detail="还没配置 ASR_API_KEY：填好后重启。可先打字或手填")
    b64 = body.audio_base64.split(",", 1)[-1]  # 容忍 dataURL 前缀
    try:
        audio = base64.b64decode(b64)
    except Exception:
        raise HTTPException(400, detail="音频编码不对，重新录一次试试")
    if len(audio) < 200:
        raise HTTPException(400, detail="录音太短，没录到声音")
    try:
        text = transcribe(audio, ext=(body.ext or "mp3").lstrip("."))
    except AsrError as e:
        raise HTTPException(502, detail=str(e))
    if not text:
        raise HTTPException(422, detail="没听清，请靠近麦克风再说一次")
    # 复用 parse-voice：返回 {title, note, start_at, end_at, by}，前端据此预填表单
    out = parse_voice(VoiceParseIn(text=text), user=user)
    return out.model_dump() | {"text_used": text}  # 附带 ASR 听成的原文，便于前端校对
