"""冲突检测：一段空闲与否的判定是全 App 复用能力（保存日程警告 / D4 组队忙闲）。"""
from datetime import date, datetime, time, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Course, Event, Term
from ..schemas import ConflictCheckIn, CourseConflictOut, EventConflictOut
from ..utils.slots import SLOT_TIMES
from ..utils.week import current_week
from .deps import get_user
from .terms import get_or_none as get_term

router = APIRouter(prefix="/api/events", tags=["conflict"])


def _hms(t: str) -> int:
    h, m = t.split(":")
    return int(h) * 60 + int(m)


def find_course_conflicts(db: Session, user: str, start_at: datetime, end_at: datetime,
                          term: Term | None = None) -> list[CourseConflictOut]:
    """时段与课表的冲突：逐天把时段截断到当天分钟区间，与该天命中教学周的课程节次比对。"""
    term = term or get_term(db, user)
    if not term:
        return []
    courses = db.scalars(select(Course).where(Course.user_code == user)).all()
    if not courses:
        return []
    out: list[CourseConflictOut] = []
    day = start_at.date()
    while day <= end_at.date() and len(out) < 20:  # 封顶防超长区间拖垮
        week = current_week(term.start_monday, day, term.total_weeks)
        if week >= 1:
            day_lo = max(start_at, datetime.combine(day, time.min))
            day_hi = min(end_at, datetime.combine(day, time.max))
            s_min = day_lo.hour * 60 + day_lo.minute
            e_min = day_hi.hour * 60 + day_hi.minute
            for c in courses:
                if c.day_of_week != day.isoweekday() or week not in (c.weeks or []):
                    continue
                for slot in range(c.start_slot, min(c.end_slot, len(SLOT_TIMES)) + 1):
                    t0, t1 = SLOT_TIMES[slot - 1]
                    a, b = _hms(t0), _hms(t1)
                    if a < e_min and s_min < b:  # 区间相交
                        first, last = SLOT_TIMES[c.start_slot - 1][0], SLOT_TIMES[min(c.end_slot, len(SLOT_TIMES)) - 1][1]
                        out.append(CourseConflictOut(
                            name=c.name, location=c.location or "", date=day,
                            slots_text=f"第{c.start_slot}-{c.end_slot}节",
                            time_text=f"{first}-{last}", course_id=c.id))
                        break
        day += timedelta(days=1)
    return out


def find_event_conflicts(db: Session, user: str, start_at: datetime, end_at: datetime,
                         exclude_event_id: int | None = None) -> list[EventConflictOut]:
    """时段与已有日程的重叠（排除自身/已取消）。精确与仅开始都算占位——
    仅开始有确定开始和预估结束，会真实占住那段时间；大概/待定不查。"""
    evs = db.scalars(
        select(Event).where(Event.user_code == user, Event.status == "ok",
                            Event.time_status.in_(("exact", "start_only")))).all()
    return [EventConflictOut(id=e.id, title=e.title, start_at=e.start_at, end_at=e.end_at)
            for e in evs
            if e.id != exclude_event_id and e.start_at < end_at and start_at < e.end_at]


@router.post("/conflict")
def check_conflict(body: ConflictCheckIn, user: str = Depends(get_user),
                   db: Session = Depends(get_db)):
    """只报告不阻断——是否仍要保存由用户决定（产品原则：只建议，不强迫）。
    大概/待定不做检测；仅开始按预估结束时刻检测。"""
    if body.time_status not in ("exact", "start_only"):
        return {"courses": [], "events": []}  # 大概/待定时间不做检测
    return {
        "courses": find_course_conflicts(db, user, body.start_at, body.end_at),
        "events": find_event_conflicts(db, user, body.start_at, body.end_at,
                                       body.exclude_event_id),
    }


def _iso(dt: datetime) -> str:
    return dt.isoformat(timespec="minutes")


def _ev_item(e: Event) -> dict:
    return {"type": "event", "id": e.id, "title": e.title[:24],
            "start_at": _iso(e.start_at), "end_at": _iso(e.end_at),
            "series_id": e.series_id, "multi_day": e.start_at.date() != e.end_at.date()}


def _course_item(c: Course, day: date) -> dict:
    """课程 → 可视化块：具体某一天的节次起止（用冲突发生日或下一次上课日）。"""
    t0 = SLOT_TIMES[c.start_slot - 1][0]
    t1 = SLOT_TIMES[min(c.end_slot, len(SLOT_TIMES)) - 1][1]
    sh, sm = map(int, t0.split(":"))
    eh, em = map(int, t1.split(":"))
    return {"type": "course", "id": c.id, "title": c.name[:24],
            "start_at": _iso(datetime.combine(day, time(sh, sm))),
            "end_at": _iso(datetime.combine(day, time(eh, em))),
            "series_id": None, "multi_day": False}


def _next_day(day_of_week: int, now: datetime) -> date:
    return now.date() + timedelta(days=(day_of_week - now.isoweekday()) % 7)


@router.get("/conflicts")
def list_conflicts(user: str = Depends(get_user), db: Session = Depends(get_db)):
    """全量扫描未来 30 天的时间冲突：日程×课程 / 日程×日程 / 课程×课程。
    每条带 items（冲突双方的标题+起止），前端画迷你时间表，用户点哪块删/改哪边。
    同 DDL 的多段安排、同重复组不算冲突。"""
    now = datetime.now()
    horizon = now + timedelta(days=30)
    term = get_term(db, user)
    courses = db.scalars(select(Course).where(Course.user_code == user)).all()
    events = db.scalars(select(Event).where(
        Event.user_code == user, Event.status == "ok",
        Event.time_status.in_(("exact", "start_only")),
        Event.end_at > now, Event.start_at < horizon)).all()

    items: list[dict] = []
    for e in events:  # 日程 × 课程
        for cc in find_course_conflicts(db, user, e.start_at, e.end_at, term):
            co = next((c for c in courses if c.id == cc.course_id), None)
            day = cc.date or e.start_at.date()
            items.append({
                "kind": "event_course",
                "text": f"《{e.title}》撞上课 {cc.name}（{cc.slots_text} {cc.time_text}）",
                "event_id": e.id, "course_id": cc.course_id or None,
                "items": [_ev_item(e), _course_item(co, day)] if co else [_ev_item(e)],
            })
    for i in range(len(events)):  # 日程 × 日程
        for j in range(i + 1, len(events)):
            a, b = events[i], events[j]
            if a.start_at >= b.end_at or b.start_at >= a.end_at:
                continue
            if a.ddl_id and a.ddl_id == b.ddl_id:
                continue  # 同一 DDL 的多段安排
            if a.series_id and a.series_id == b.series_id:
                continue  # 同一重复组
            items.append({
                "kind": "event_event",
                "text": f"《{a.title}》与《{b.title}》时间重叠",
                "event_id": a.id, "other_event_id": b.id,
                "items": [_ev_item(a), _ev_item(b)],
            })
    for i in range(len(courses)):  # 课程 × 课程（导入错位常见）
        for j in range(i + 1, len(courses)):
            a, b = courses[i], courses[j]
            if a.day_of_week != b.day_of_week or not set(a.weeks or []) & set(b.weeks or []):
                continue
            la = _hms(SLOT_TIMES[a.start_slot - 1][0])
            ha = _hms(SLOT_TIMES[min(a.end_slot, len(SLOT_TIMES)) - 1][1])
            lb = _hms(SLOT_TIMES[b.start_slot - 1][0])
            hb = _hms(SLOT_TIMES[min(b.end_slot, len(SLOT_TIMES)) - 1][1])
            if la < hb and lb < ha:
                day = _next_day(a.day_of_week, now)
                items.append({
                    "kind": "course_course",
                    "text": f"《{a.name}》与《{b.name}》节次重叠（周{a.day_of_week}）",
                    "course_id": a.id, "other_course_id": b.id,
                    "items": [_course_item(a, day), _course_item(b, day)],
                })

    seen: set[str] = set()
    uniq = []
    for it in items:
        if it["text"] in seen:
            continue
        seen.add(it["text"])
        uniq.append(it)
    return {"conflicts": uniq[:20]}
