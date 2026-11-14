# -*- coding: utf-8 -*-
"""D3 DDL 中枢 + 推荐引擎 v1（规则版）。

- 倒计时墙：剩余时间 × 权重 → 红黄绿三档，逾期自动置灰（FR-32）
- 采集：手动添加 / 粘贴群通知抽取（规则优先，有 Key 走 LLM 增强）（FR-31）
- 推荐：空闲池（活动窗 − 课程 − 日程 − 饭点）× 紧迫度 × 时段匹配 × 偏好修正，
  每张卡片三键——接受/换时间/忽略。产品铁律：绝不自动写入日程（FR-33）。

打分公式（概要设计 M3）：
  score = 紧迫度(weight × 48h / 剩余小时) × 时段匹配度(空闲段长 vs 预估时长)
          × 偏好修正(0.6^该时段被忽略次数) × 越早越好(1/(1+0.2×天数))
"""
import re
from datetime import date, datetime, time, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Course, DdlFeedback, DDL, Event, Term
from ..schemas import (DdlBatchIn, DdlIn, DdlOut, DdlParseIn, DdlParseOut,
                       DdlGuess, EventOut, SuggestAcceptIn,
                       SuggestCardOut, SuggestFeedbackIn, SuggestOut,
                       SuggestPlanIn, SuggestSlotOut)
from ..utils.llm import LLMError, ask_llm, llm_enabled, text_model
from ..utils.notice import _find_date, _PM_SET, _PM_WORDS
from ..utils.slots import SLOT_TIMES
from ..utils.week import current_week
from .ai import _extract_json
from .deps import get_user
from .terms import get_or_none as get_term

router = APIRouter(prefix="/api/ddls", tags=["ddls"])
sug_router = APIRouter(prefix="/api/suggestions", tags=["suggestions"])


# ---------- 倒计时墙分档（FR-32：剩余时间 × 权重） ----------

TIER_ORDER = {"red": 0, "yellow": 1, "green": 2, "overdue": 3, "done": 4}


def _remain_text(due: datetime, now: datetime) -> str:
    sec = (due - now).total_seconds()
    past = sec < 0
    hours = abs(sec) / 3600
    if hours < 1:
        txt = f"{int(abs(sec) // 60)}分钟"
    elif hours < 24:
        txt = f"{int(hours)}小时"
    else:
        days, rh = divmod(int(hours), 24)
        txt = f"{days}天" + (f"{rh}小时" if rh else "")
    return ("逾期" if past else "剩") + txt


def _tier(due: datetime, weight: int, status: str, now: datetime) -> str:
    if status == "done":
        return "done"
    hours = (due - now).total_seconds() / 3600
    if hours <= 0:
        return "overdue"
    eff = hours / weight  # 权重高 → 同样剩余时间更紧迫
    if eff <= 12:
        return "red"
    if eff <= 72:
        return "yellow"
    return "green"


def _to_out(d: DDL, now: datetime) -> DdlOut:
    return DdlOut(
        id=d.id, title=d.title, course_name=d.course_name or "",
        due_at=d.due_at, weight=d.weight, status=d.status,
        kind=d.kind or "task", location=d.location or "", note=d.note or "",
        exam_end=d.exam_end, muted=d.muted,
        remind=(d.kind != "exam" and d.status != "done"
                and timedelta(0) < (d.due_at - now) <= timedelta(hours=24)),
        tier=_tier(d.due_at, d.weight, d.status, now),
        remain_text=_remain_text(d.due_at, now))


def _exam_title(d: DDL) -> str:
    if not d.course_name or d.title.startswith(d.course_name):
        return d.title
    return f"{d.course_name}·{d.title}"


def _sync_exam_event(db: Session, user: str, d: DDL) -> None:
    """考试 DDL ↔ 日程表事件同步：考试本体（type=exam）按醒目样式上表；
    改时间/地点/备注随 DDL 编辑更新，删 DDL 连带删。"""
    ev = db.scalars(select(Event).where(
        Event.user_code == user, Event.ddl_id == d.id, Event.type == "exam")).first()
    if d.kind != "exam":
        if ev:
            db.delete(ev)
        return
    start = d.due_at
    end = d.exam_end if (d.exam_end and d.exam_end > start) else start + timedelta(hours=2)
    if ev:
        ev.title = _exam_title(d)[:60]
        ev.location = d.location or ""
        ev.note = d.note or ""
        ev.start_at = start
        ev.end_at = end
    else:
        db.add(Event(user_code=user, title=_exam_title(d)[:60], icon="📝",
                     location=d.location or "", note=d.note or "",
                     start_at=start, end_at=end, time_status="exact",
                     type="exam", source="ddl", ddl_id=d.id))


@router.get("", response_model=list[DdlOut])
def list_ddls(user: str = Depends(get_user), db: Session = Depends(get_db)):
    """倒计时墙：逾期顺手落库（置灰档），考试结束自动算完成（FR-32 懒更新）"""
    now = datetime.now()
    rows = db.scalars(select(DDL).where(DDL.user_code == user)).all()
    dirty = False
    for d in rows:
        if d.status == "open" and d.due_at <= now:
            d.status = "overdue"  # 真过了时间没完成 → 未完成（灰档）
            dirty = True
        if d.kind == "exam" and d.status != "done":
            end = d.exam_end if (d.exam_end and d.exam_end > d.due_at) \
                else d.due_at + timedelta(hours=2)
            if end <= now:
                d.status = "done"  # 考试结束自动算完成，事件保留归属
                dirty = True
    if dirty:
        db.commit()
    out = [_to_out(d, now) for d in rows]
    out.sort(key=lambda x: (TIER_ORDER[x.tier], x.due_at))
    return out


@router.post("", response_model=DdlOut)
def create_ddl(body: DdlIn, user: str = Depends(get_user), db: Session = Depends(get_db)):
    d = DDL(user_code=user, **body.model_dump())
    db.add(d)
    db.commit()
    _sync_exam_event(db, user, d)  # 考试 → 醒目事件上日程表
    db.commit()
    db.refresh(d)
    return _to_out(d, datetime.now())


@router.post("/batch", response_model=list[DdlOut])
def create_ddls(body: DdlBatchIn, user: str = Depends(get_user), db: Session = Depends(get_db)):
    """粘贴通知解析校对后批量入库。跳过与已有 DDL（或本批内）同标题同截止时间的重复项，
    防止同一条通知反复解析保存出现双胞胎。"""
    now = datetime.now()
    existing = db.scalars(select(DDL).where(DDL.user_code == user)).all()
    seen = {(d.title, d.due_at) for d in existing}
    rows = []
    skipped = 0
    for x in body.ddls:
        key = (x.title, x.due_at)
        if key in seen:
            skipped += 1
            continue
        seen.add(key)
        rows.append(DDL(user_code=user, **x.model_dump()))
    db.add_all(rows)
    db.commit()
    return [_to_out(d, now) for d in rows]


@router.put("/{ddl_id}", response_model=DdlOut)
def update_ddl(ddl_id: int, body: DdlIn, user: str = Depends(get_user),
               db: Session = Depends(get_db)):
    d = db.get(DDL, ddl_id)
    if not d or d.user_code != user:
        raise HTTPException(404, detail="DDL 不存在")
    for k, v in body.model_dump().items():
        setattr(d, k, v)
    if d.status == "overdue":  # 改了截止时间，逾期状态重算
        d.status = "open"
    db.commit()
    _sync_exam_event(db, user, d)  # 考试改时间/地点 → 日程表事件跟着改
    db.commit()
    db.refresh(d)
    return _to_out(d, datetime.now())


@router.delete("/{ddl_id}")
def delete_ddl(ddl_id: int, user: str = Depends(get_user), db: Session = Depends(get_db)):
    d = db.get(DDL, ddl_id)
    if not d or d.user_code != user:
        raise HTTPException(404, detail="DDL 不存在")
    # 事件不悬空：考试事件随 DDL 删；已排的建议/复习安排解除归属，变普通日程保留
    for e in db.scalars(select(Event).where(
            Event.user_code == user, Event.ddl_id == d.id)).all():
        if e.type == "exam":
            db.delete(e)
        else:
            e.ddl_id = None
    db.delete(d)
    db.commit()
    return {"ok": True}


@router.post("/{ddl_id}/done", response_model=DdlOut)
def done_ddl(ddl_id: int, user: str = Depends(get_user), db: Session = Depends(get_db)):
    """完成打卡：置 done（灰绿档）；未到截止也算完成"""
    d = db.get(DDL, ddl_id)
    if not d or d.user_code != user:
        raise HTTPException(404, detail="DDL 不存在")
    d.status = "done"
    db.commit()
    db.refresh(d)
    return _to_out(d, datetime.now())


@router.post("/{ddl_id}/reopen", response_model=DdlOut)
def reopen_ddl(ddl_id: int, user: str = Depends(get_user), db: Session = Depends(get_db)):
    d = db.get(DDL, ddl_id)
    if not d or d.user_code != user:
        raise HTTPException(404, detail="DDL 不存在")
    d.status = "overdue" if d.due_at <= datetime.now() else "open"
    db.commit()
    db.refresh(d)
    return _to_out(d, datetime.now())


@router.post("/{ddl_id}/unmute", response_model=DdlOut)
def unmute_ddl(ddl_id: int, user: str = Depends(get_user), db: Session = Depends(get_db)):
    """撤销"忽略"：恢复该 DDL 的推荐。"""
    d = db.get(DDL, ddl_id)
    if not d or d.user_code != user:
        raise HTTPException(404, detail="DDL 不存在")
    d.muted = False
    db.commit()
    db.refresh(d)
    return _to_out(d, datetime.now())


# ---------- 粘贴群通知 → DDL 抽取（FR-31；规则优先，LLM 增强） ----------

_WEEKDAY_CN = "一二三四五六日"
_DDL_TASK = ("实验报告|课程论文|毕业论文|开题报告|中期报告|论文|实验|作业|习题|练习|报告|"
             "笔记|读后感|观后感|综述|总结|翻译|作文|简历|申报书|大纲|预习|复习|打卡|签到|"
             "汇报|答辩|演讲|项目|代码|试卷|卷子|PPT|ppt|Lab|lab")
_DDL_TITLE_RE = re.compile(rf"([^，。,;；:：\s、！!？?（）()]{{0,12}}?)({_DDL_TASK})")
# 修饰语清洗：日期碎片（12月30日前）和交/写/提交这类动作词都不属于任务名
_DDL_MOD_NOISE = re.compile(r"\d|[月日号周]|点|半|分|之前|前|以内|以内的|的|把|将|请|记得|要|需|需要|完成|提交|上交|交|写|做|赶|弄")

# 截止时刻：数字/中文钟点 + 前/之前/截止；"24:00前"是学生通知的黑话 → 23:59
_DUE_T = re.compile(
    r"(?P<h>[0-2]?\d|十一|十二|十|[一两二三四五六七八九])\s*[:：点时]\s*(?P<m>[0-5]\d|半)?\s*分?\s*(?:之前|前|截止)")
# 兜底：行里任意独立钟点（"截止到11月15日 18:00"/"今晚六点半"——截止词太远或中文钟点）
_ANY_T = re.compile(r"(?<![0-9])(?P<h>[0-2]?\d|十一|十二|十|[一两二三四五六七八九])\s*[:：点]\s*(?P<m>[0-5]\d|半)?(?![0-9])")
_CN_HOUR = {"一": 1, "两": 2, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6,
            "七": 7, "八": 8, "九": 9, "十": 10, "十一": 11, "十二": 12}
# 只说时段没说几点 → 该时段的默认截止
_DUE_PERIOD = {"上午": (12, 0), "中午": (14, 0), "下午": (18, 0), "傍晚": (22, 0),
               "晚上": (23, 59), "夜里": (23, 59), "凌晨": (6, 0)}


def _due_clock(line: str) -> tuple[int, int] | None:
    """行内找截止钟点。带 前/之前/截止 标记的优先，其次行内任意独立钟点。"""
    m = _DUE_T.search(line) or _ANY_T.search(line)
    if not m:
        return None
    h = m.group("h")
    h = int(h) if h.isdigit() else _CN_HOUR.get(h, 10)
    mm = m.group("m")
    minute = 30 if mm == "半" else (int(mm) if mm and mm.isdigit() else 0)
    if h >= 24:  # "24:00前" = 当天最后一秒
        return 23, 59
    # 时段词修正：晚上8点前 → 20 点；今晚六点半 → 18 点半（借 notice.py 的词表 + 晚词）
    pre = line[max(0, m.start() - 3):m.start()]
    pm = re.search(rf"(今晚|明晚|后晚|{_PM_WORDS})\s*$", pre)
    if pm and h < 12 and (pm.group(1) in _PM_SET or pm.group(1) in {"今晚", "明晚", "后晚"}):
        h += 12
    return h, minute


def _guess_weight(title: str) -> int:
    if re.search(r"考试|答辩|论文|期末|大作业|申报", title):
        return 3
    if re.search(r"打卡|签到|预习|投票", title):
        return 1
    return 2


# 考试单独分区：命中这些词 → kind=exam，且强制最高重要度
_EXAM_WORDS = re.compile(r"考试|期中|期末|测验|小测|月考|统考|补考|缓考|四六级|"
                         r"期中考|期末考|结课考|开卷考|闭卷考|quiz|exam", re.I)


def _find_ddl_title(line: str, eaten_spans: list[tuple[int, int]]) -> str:
    """任务名：『X前交+任务词』的修饰语+中心词；兜底取最长中文字段"""
    m = _DDL_TITLE_RE.search(line)
    if m:
        mod = _DDL_MOD_NOISE.sub("", m.group(1))
        return (mod + m.group(2))[:24] if mod else m.group(2)
    # 兜底：抠掉日期/钟点已匹配片段后取最长 CJK 字段
    parts, last = [], 0
    for a, b in sorted(eaten_spans):
        parts.append(line[last:a])
        last = b
    parts.append(line[last:])
    tokens = [t for t in re.split(r"[\s，,。;；:：、！!？?（）()【】\[\]]+", " ".join(parts))
              if t and re.search(r"[一-鿿A-Za-z]", t)]
    if not tokens:
        return "DDL事项"
    best = max(tokens, key=len)
    best = re.sub(r"^(请大家?|务必|记得|提前|尽快|及时|辛苦|麻烦)+", "", best) or best
    return best[:24]


def _rule_parse_ddls(text: str, now: datetime, course_names: list[str]) -> list[DdlGuess]:
    """逐行找『日期 + 截止钟点 + 任务词』。复用 notice._find_date 的全套日期词。"""
    out: list[DdlGuess] = []
    seen: set[tuple[str, date]] = set()
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        d, dtext = _find_date(line, now)
        if not d:
            continue
        clock = _due_clock(line)
        if clock:
            h, mi = clock
        else:
            pm = re.search(rf"({_PM_WORDS})", line)
            h, mi = _DUE_PERIOD.get(pm.group(1), (23, 59)) if pm else (23, 59)
        due = datetime(d.year, d.month, d.day, h, mi)
        if due <= now:  # 已过去的不抽取（历史通知复制进来很常见）
            continue
        title = _find_ddl_title(line, [])
        course = max((c for c in course_names if c and c in line), key=len, default="")
        kind = "exam" if _EXAM_WORDS.search(line) else "task"
        weight = 3 if kind == "exam" else _guess_weight(title)
        key = (title, d)
        if key in seen:
            continue
        seen.add(key)
        out.append(DdlGuess(title=title, course_name=course, due_at=due,
                            weight=weight, kind=kind))
    return out


@router.post("/parse", response_model=DdlParseOut)
def parse_ddls(body: DdlParseIn, user: str = Depends(get_user), db: Session = Depends(get_db)):
    """粘贴群通知 → DDL 候选列表（先校对再入库）。有 Key 走 LLM，失败/没 Key 走规则。"""
    text = (body.text or "").strip()[:2000]
    if not text:
        raise HTTPException(400, detail="先粘贴点文字")
    now = datetime.now()
    courses = db.scalars(select(Course).where(Course.user_code == user)).all()
    names = sorted({c.name for c in courses}, key=len, reverse=True)

    if llm_enabled():
        try:
            raw = ask_llm(
                "你是 DDL 解析助手，只输出 JSON，不输出任何解释文字。",
                f"""现在是 {now.strftime('%Y-%m-%d %H:%M')}（周{_WEEKDAY_CN[now.weekday()]}）。
从下面这段群通知/课程要求里抽取所有 DDL（截止任务），输出 JSON 数组，每个元素：
{{"title":"任务名(不超过24字)","course_name":"关联课程名，没有就空字符串","due_at":"YYYY-MM-DD HH:MM","weight":1到3整数(考试论文=3 作业报告=2 打卡=1),"kind":"task或exam(考试/测验/期中期末=exam，其余=task)"}}
规则：没写几点就 23:59；"24:00前"解析为 23:59；已经过去的截止不要输出。只输出 JSON 数组。

文本：
{text}""",
                model=text_model(), max_tokens=2000)
            data = _extract_json(raw)
            if isinstance(data, dict):
                data = data.get("ddls") or []
            guesses = []
            for x in data if isinstance(data, list) else []:
                if not isinstance(x, dict):
                    continue
                try:
                    g = DdlGuess(
                        title=str(x.get("title") or "").strip()[:24],
                        course_name=str(x.get("course_name") or "")[:60],
                        due_at=datetime.strptime(str(x.get("due_at"))[:16], "%Y-%m-%d %H:%M"),
                        weight=max(1, min(3, int(x.get("weight") or 2))),
                        kind="exam" if str(x.get("kind") or "") == "exam" else "task")
                    if g.title and g.due_at > now:
                        guesses.append(g)
                except (ValueError, TypeError):
                    continue
            if guesses:
                return DdlParseOut(by="llm", ddls=guesses[:20])
        except LLMError:
            pass  # 降级到规则
    return DdlParseOut(by="rule", ddls=_rule_parse_ddls(text, now, names)[:20])


# ---------- 推荐引擎 v1（FR-33：空闲池 + 紧迫度 + 偏好修正） ----------

ACTIVE = (8 * 60, 22 * 60 + 30)          # 日活动窗（睡眠不推）
MEALS = [(12 * 60, 13 * 60 + 40), (17 * 60 + 30, 18 * 60 + 50)]  # 饭点：可能有事，不推
HORIZON_DAYS = 7                          # 只看未来 7 天
GRID = 30                                 # 30 分钟粒度起排
MIN_SEG = 40                              # 碎片小于 40 分钟不推
EST_BY_WEIGHT = {1: 60, 2: 90, 3: 120}    # 预估时长（分钟）：紧迫度里的"子任务时长"


def _hms(t: str) -> int:
    h, m = t.split(":")
    return int(h) * 60 + int(m)


def _merge(ivs: list[tuple[int, int]]) -> list[tuple[int, int]]:
    out: list[list[int]] = []
    for lo, hi in sorted(ivs):
        if out and lo <= out[-1][1]:
            out[-1][1] = max(out[-1][1], hi)
        else:
            out.append([lo, hi])
    return [(a, b) for a, b in out]


def _day_busy(db: Session, user: str, term: Term | None, day: date) -> list[tuple[int, int]]:
    """某天的忙碌区间（分钟）：课表节次 + 精确/仅开始日程 + 饭点。忙闲位图实时算不落库。
    仅开始(start_only)有确定的开始和 +1h 预估结束，占时间，必须算忙——否则建议会排到它头上。"""
    ivs: list[tuple[int, int]] = list(MEALS)
    if term:
        week = current_week(term.start_monday, day, term.total_weeks)
        if week >= 1:
            for c in db.scalars(select(Course).where(Course.user_code == user)).all():
                if c.day_of_week != day.isoweekday() or week not in (c.weeks or []):
                    continue
                lo = _hms(SLOT_TIMES[c.start_slot - 1][0])
                hi = _hms(SLOT_TIMES[min(c.end_slot, len(SLOT_TIMES)) - 1][1])
                ivs.append((lo, hi))
    day_lo = datetime.combine(day, time.min)
    day_hi = datetime.combine(day, time.max)
    for e in db.scalars(select(Event).where(
            Event.user_code == user, Event.status == "ok",
            Event.time_status.in_(("exact", "start_only")),
            Event.start_at <= day_hi, Event.end_at >= day_lo)).all():
        lo = 0 if e.start_at < day_lo else e.start_at.hour * 60 + e.start_at.minute
        hi = 24 * 60 if e.end_at > day_hi else e.end_at.hour * 60 + e.end_at.minute
        ivs.append((lo, hi))
    return _merge(ivs)


def _free_segments(busy: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """活动窗 − 忙碌 → 空闲段"""
    lo0, hi0 = ACTIVE
    segs, cur = [], lo0
    for lo, hi in busy:
        if hi <= cur or lo >= hi0:
            continue
        if lo > cur:
            segs.append((cur, min(lo, hi0)))
        cur = max(cur, hi)
    if cur < hi0:
        segs.append((cur, hi0))
    return [(a, b) for a, b in segs if b - a >= MIN_SEG]


def _bucket(start_at: datetime) -> str:
    h = start_at.hour
    return "morning" if h < 12 else ("afternoon" if h < 18 else "evening")


def _pref_factor(db: Session, user: str) -> dict[str, float]:
    """偏好修正：该时段被忽略/换时间过的次数 → 0.6^次 降权（换时间算半次）"""
    counts = {"morning": 0.0, "afternoon": 0.0, "evening": 0.0}
    since = datetime.now() - timedelta(days=14)  # 只看近两周的反馈
    for f in db.scalars(select(DdlFeedback).where(
            DdlFeedback.user_code == user, DdlFeedback.created_at >= since)).all():
        if f.bucket in counts and f.action in ("ignore", "change"):
            counts[f.bucket] += 1.0 if f.action == "ignore" else 0.5
    return {k: 0.6 ** v for k, v in counts.items()}


@sug_router.get("", response_model=SuggestOut)
def get_suggestions(user: str = Depends(get_user), db: Session = Depends(get_db)):
    """生成建议卡片：每个未完成且未排期的 DDL 最多 3 个候选时段。绝不写日程。"""
    now = datetime.now()
    term = get_term(db, user)
    ddls = db.scalars(select(DDL).where(DDL.user_code == user,
                                        DDL.status != "done",
                                        DDL.muted.is_(False))).all()
    if not ddls:
        return SuggestOut(cards=[])
    # 已接受过推荐且时段还没过去的 → 不再重复推
    scheduled = {e.ddl_id for e in db.scalars(select(Event).where(
        Event.user_code == user, Event.status == "ok", Event.ddl_id.isnot(None),
        Event.end_at > now)).all()}
    prefs = _pref_factor(db, user)
    horizon_end = now + timedelta(days=HORIZON_DAYS)
    cards: list[SuggestCardOut] = []

    for d in ddls:
        if d.id in scheduled or d.due_at <= now - timedelta(days=3):
            continue  # 已排期 / 逾期超过 3 天的陈年旧账不推
        is_exam = d.kind == "exam"
        est = 240 if is_exam else EST_BY_WEIGHT.get(d.weight, 90)
        hours_left = max((d.due_at - now).total_seconds() / 3600, 0.5)
        urgency = min((4 if is_exam else d.weight) * 48 / hours_left, 12)
        end_day = min(d.due_at.date(), (now + timedelta(days=HORIZON_DAYS)).date())
        cands: list[SuggestSlotOut] = []
        day = now.date()
        while day <= end_day and len(cands) < 48:
            segs = _free_segments(_day_busy(db, user, term, day))
            for lo, hi in segs:
                start_min = ((max(lo, _now_min(day, now)) + GRID - 1) // GRID) * GRID
                if day == now.date() and start_min < _now_min(day, now) + 15:
                    start_min = ((_now_min(day, now) + 15 + GRID - 1) // GRID) * GRID
                if start_min >= hi:
                    continue
                # 同一空档产出两种时长：短（约 1 小时）/ 长（约 2.5-3 小时），保证建议差异度
                for dur in (min(60, est), min(max(est, 180), 240)):
                    if dur < 45 or start_min + dur > hi:
                        continue
                    slot_end = start_min + dur
                    if day == d.due_at.date():  # 截止当天的时段必须赶在截止前
                        due_min = d.due_at.hour * 60 + d.due_at.minute
                        if slot_end > due_min:
                            dur = due_min - start_min
                            if dur < 45:
                                continue
                            slot_end = start_min + dur
                    s = datetime.combine(day, time(start_min // 60, start_min % 60))
                    e = datetime.combine(day, time(slot_end // 60, slot_end % 60))
                    b = _bucket(s)
                    fit = 1.0 if (hi - lo) >= est else (hi - lo) / est
                    days_ahead = (day - now.date()).days
                    score = urgency * fit * prefs[b] / (1 + 0.2 * days_ahead)
                    weekend = s.weekday() >= 5
                    long_ = (slot_end - start_min) >= 120
                    # 差异度分桶：工作日短时 / 周末长时 / 工作日长时
                    cat = ("ws" if not weekend else "fs") if not long_ else (
                        "wl" if weekend else "dl")
                    wd = "周" + _WEEKDAY_CN[s.weekday()]
                    dur_txt = f"{(slot_end - start_min) // 60}小时" if slot_end - start_min >= 60 else f"{slot_end - start_min}分钟"
                    if cat == "ws":
                        style = f"工作日抽 {dur_txt} 小块"
                    elif cat == "wl":
                        style = f"周末整块 {dur_txt}，适合{'考前集中' if is_exam else '赶工'}"
                    elif cat == "fs":
                        style = f"周末 {dur_txt} 轻量推进"
                    else:
                        style = f"工作日大块 {dur_txt} 沉浸做"
                    if d.due_at <= now:
                        reason = f"已逾期，越早补越好；{style}，{wd}{s:%H:%M}-{e:%H:%M} 没课也没安排"
                    else:
                        reason = (f"距截止{_remain_text(d.due_at, now)}；{style}，"
                                  f"{wd}{s:%H:%M}-{e:%H:%M} 没课也没安排")
                    cands.append(SuggestSlotOut(start_at=s, end_at=e, bucket=b,
                                                score=round(score, 3), reason=reason,
                                                cat=cat))
            day += timedelta(days=1)
        # 差异化选 slot：三个桶各取一个最高分，不足 3 个再用剩余高分补齐
        cands.sort(key=lambda x: -x.score)
        picked: list[SuggestSlotOut] = []
        for cat in ("ws", "wl", "dl"):
            if len(picked) >= 3:
                break
            for c in cands:
                if c.cat == cat and all(_far_enough(c, p) for p in picked):
                    picked.append(c)
                    break
        for c in cands:
            if len(picked) >= 3:
                break
            if all(_far_enough(c, p) for p in picked):
                picked.append(c)
        if picked:
            cards.append(SuggestCardOut(
                ddl_id=d.id, title=d.title, course_name=d.course_name or "",
                weight=d.weight, kind=d.kind, due_at=d.due_at,
                remain_text=_remain_text(d.due_at, now),
                tier=_tier(d.due_at, d.weight, d.status, now), slots=picked))
    cards.sort(key=lambda c: -(c.slots[0].score if c.slots else 0))
    return SuggestOut(cards=cards[:5])


def _now_min(day: date, now: datetime) -> int:
    return now.hour * 60 + now.minute if day == now.date() else 0


def _far_enough(a: SuggestSlotOut, b: SuggestSlotOut) -> bool:
    if a.start_at.date() != b.start_at.date():
        return True
    return abs((a.start_at - b.start_at).total_seconds()) >= 3 * 3600


@sug_router.post("/accept", response_model=EventOut)
def accept_suggestion(body: SuggestAcceptIn, user: str = Depends(get_user),
                      db: Session = Depends(get_db)):
    """接受建议 → 写入日程（type=suggestion / source=ddl，课表上立即可见）。"""
    if body.end_at <= body.start_at:
        raise HTTPException(400, detail="结束时间要晚于开始时间")
    d = db.get(DDL, body.ddl_id)
    if not d or d.user_code != user:
        raise HTTPException(404, detail="DDL 不存在")
    if not d.course_name or d.title.startswith(d.course_name):
        title = d.title  # 标题本身已带课名，不重复拼
    else:
        title = f"{d.course_name}·{d.title}"
    ev = Event(user_code=user, title=title[:60], icon="📌",
               note=d.note or "来自 DDL 建议", location=d.location or "",
               start_at=body.start_at, end_at=body.end_at, time_status="exact",
               type="suggestion", source="ddl", ddl_id=d.id)
    db.add(ev)
    db.add(DdlFeedback(user_code=user, ddl_id=d.id, action="accept",
                       bucket=_bucket(body.start_at)))
    db.commit()
    db.refresh(ev)
    return ev


@sug_router.post("/feedback")
def feedback_suggestion(body: SuggestFeedbackIn, user: str = Depends(get_user),
                        db: Session = Depends(get_db)):
    """忽略/换时间：只记反馈降权，绝不写日程（FR-33 铁律）。
    忽略 = 用户说"别管这个了" → 该 DDL 永久静音，推荐引擎永不再推（换时间不静音）。"""
    if body.action not in ("ignore", "change"):
        raise HTTPException(400, detail="action 只能是 ignore 或 change")
    db.add(DdlFeedback(user_code=user, ddl_id=body.ddl_id, action=body.action,
                       bucket=body.bucket, reason=(body.reason or "")[:64]))
    if body.action == "ignore":
        d = db.get(DDL, body.ddl_id)
        if d and d.user_code == user:
            d.muted = True
    db.commit()
    return {"ok": True}


PLAN_CAP = 8  # 考前复习最多排 4 个周末（8 个半天）


@sug_router.get("/free")
def free_slots(start: date | None = None, days: int = 7,
               user: str = Depends(get_user), db: Session = Depends(get_db)):
    """空闲格查询：批奏折自定义时间的点选网格用。返回每天的空闲段（分钟），
    已扣掉课程/精确日程/饭点；今天额外扣掉已过去的时刻。"""
    now = datetime.now()
    start = start or now.date()
    days = max(1, min(days, 21))
    term = get_term(db, user)
    out = []
    for i in range(days):
        day = start + timedelta(days=i)
        segs = _free_segments(_day_busy(db, user, term, day))
        if day == now.date():
            now_min = now.hour * 60 + now.minute + 15  # 留 15 分钟缓冲
            segs = [(max(lo, ((now_min + 29) // 30) * 30), hi) for lo, hi in segs]
            segs = [(lo, hi) for lo, hi in segs if hi - lo >= 30]
        out.append({"date": day.isoformat(), "weekday": day.isoweekday(), "segs": segs})
    return {"days": out}


@sug_router.post("/review-plan", response_model=list[EventOut])
def review_plan(body: SuggestPlanIn, user: str = Depends(get_user),
                db: Session = Depends(get_db)):
    """批奏折·考前复习计划：从最近的周末起，每个周末排一段整块复习
    （避开课程/日程/饭点，能排 3 小时就 3 小时），一直到考试前。
    复习事件挂 ddl_id → 考试被视为已安排，推荐卡自动消停。"""
    d = db.get(DDL, body.ddl_id)
    if not d or d.user_code != user:
        raise HTTPException(404, detail="DDL 不存在")
    now = datetime.now()
    term = get_term(db, user)
    created: list[Event] = []
    day = now.date()
    while day < d.due_at.date() and len(created) < PLAN_CAP:
        if day.weekday() >= 5:  # 周六/日才排
            segs = [(lo, hi) for lo, hi in
                    _free_segments(_day_busy(db, user, term, day)) if hi - lo >= 120]
            if segs:
                lo, hi = max(segs, key=lambda s: s[1] - s[0])  # 取最长的空档
                dur = min(180, hi - lo)
                s = datetime.combine(day, time(lo // 60, lo % 60))
                created.append(Event(
                    user_code=user, title=f"{_exam_title(d)}·复习"[:60], icon="📚",
                    note=f"考前复习 · {d.title}"[:120], time_status="exact",
                    type="review", source="ddl", ddl_id=d.id,
                    start_at=s, end_at=s + timedelta(minutes=dur)))
        day += timedelta(days=1)
    if not created:
        raise HTTPException(400, detail="考试前的周末没有 ≥2 小时的空闲整块（可能被课占满了）")
    db.add_all(created)
    db.add(DdlFeedback(user_code=user, ddl_id=d.id, action="plan", bucket=""))
    db.commit()
    for e in created:
        db.refresh(e)
    return created
