"""组队空闲查询（FR-41~45）：建组/口令进组 → 共同空闲 Top3 → 指定时间查忙闲
→ 定档与全员确认 → 写入各自日程。隐私默认：只暴露忙闲与状态类型，细节可自愿开放。"""
import secrets
from datetime import date, datetime, time, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Course, Event, Group, GroupMember, Profile
from ..utils.slots import SLOT_TIMES
from ..utils.week import current_week
from .deps import get_user
from .ddls import MEALS, _day_busy, _free_segments
from .terms import get_or_none as get_term

router = APIRouter(prefix="/api/groups", tags=["groups"])

BUSY_WINDOW = (8 * 60, 23 * 60)   # 共同空闲只在 8:00-23:00 里找
GRID = 30                          # 30 分钟粒度（FR-42）
TOP_N = 3


# ---------- 出入组 ----------

class GroupIn(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    nickname: str = Field(min_length=1, max_length=32)


class JoinIn(BaseModel):
    code: str = Field(min_length=4, max_length=12)
    nickname: str = Field(min_length=1, max_length=32)


def _ensure_profile(db: Session, user: str, nickname: str) -> None:
    if not db.get(Profile, user):
        db.add(Profile(user_code=user, nickname=nickname))
        db.commit()


def _member_out(m: GroupMember) -> dict:
    return {"user_code": m.user_code, "nickname": m.nickname or "同学",
            "share_detail": bool(m.share_detail), "is_me": False}


@router.post("")
def create_group(body: GroupIn, user: str = Depends(get_user), db: Session = Depends(get_db)):
    """建组：生成 8 位进组口令，创建者自动成为第一名成员（组长）。"""
    _ensure_profile(db, user, body.nickname)
    code = secrets.token_urlsafe(6)[:8].upper()  # 8 位口令，去掉易混字符靠 urlsafe
    g = Group(code=code, name=body.name.strip(), creator_code=user)
    db.add(g)
    db.commit()
    db.refresh(g)
    db.add(GroupMember(group_id=g.id, user_code=user, nickname=body.nickname.strip()))
    db.commit()
    return _group_out(db, g, user)


@router.post("/join")
def join_group(body: JoinIn, user: str = Depends(get_user), db: Session = Depends(get_db)):
    """口令进组（远程发群/面对面扫码都落到这个口）。零填表：只要昵称。"""
    _ensure_profile(db, user, body.nickname)
    g = db.scalars(select(Group).where(Group.code == body.code.strip().upper())).first()
    if not g:
        raise HTTPException(404, detail="口令不对，找组长核对一下")
    m = db.scalars(select(GroupMember).where(
        GroupMember.group_id == g.id, GroupMember.user_code == user)).first()
    if m:
        m.nickname = body.nickname.strip()  # 重复进组就当改昵称
    else:
        db.add(GroupMember(group_id=g.id, user_code=user, nickname=body.nickname.strip()))
    db.commit()
    return _group_out(db, g, user)


@router.get("")
def my_groups(user: str = Depends(get_user), db: Session = Depends(get_db)):
    rows = db.execute(
        select(Group, GroupMember)
        .join(GroupMember, GroupMember.group_id == Group.id)
        .where(GroupMember.user_code == user)).all()
    return {"groups": [_group_out(db, g, user, member=m) for g, m in rows]}


def _group_out(db: Session, g: Group, user: str, member: GroupMember | None = None) -> dict:
    members = db.scalars(select(GroupMember).where(
        GroupMember.group_id == g.id)).all()
    return {
        "code": g.code, "name": g.name, "creator_code": g.creator_code,
        "is_creator": g.creator_code == user,
        "members": [{**_member_out(m), "is_me": m.user_code == user} for m in members],
        "my_share_detail": bool(member.share_detail) if member else False,
    }


@router.post("/{code}/leave")
def leave_group(code: str, user: str = Depends(get_user), db: Session = Depends(get_db)):
    g = _get(db, code)
    m = db.scalars(select(GroupMember).where(
        GroupMember.group_id == g.id, GroupMember.user_code == user)).first()
    if not m:
        raise HTTPException(404, detail="你不在这个组")
    db.delete(m)
    db.commit()
    # 组空了就没意义了，顺手清掉
    if not db.scalars(select(GroupMember).where(GroupMember.group_id == g.id)).first():
        db.delete(g)
        db.commit()
    return {"ok": True}


class PrivacyIn(BaseModel):
    share_detail: bool = False


@router.post("/{code}/privacy")
def set_privacy(code: str, body: PrivacyIn, user: str = Depends(get_user),
                db: Session = Depends(get_db)):
    """FR-45：开放/关闭细节。默认关——组内只能看到你的忙闲，看不到课程名/事件标题。"""
    g = _get(db, code)
    m = _member(db, g, user)
    m.share_detail = body.share_detail
    db.commit()
    return {"ok": True, "share_detail": m.share_detail}


def _get(db: Session, code: str) -> Group:
    g = db.scalars(select(Group).where(Group.code == code.strip().upper())).first()
    if not g:
        raise HTTPException(404, detail="组不存在")
    return g


def _member(db: Session, g: Group, user: str) -> GroupMember:
    m = db.scalars(select(GroupMember).where(
        GroupMember.group_id == g.id, GroupMember.user_code == user)).first()
    if not m:
        raise HTTPException(403, detail="先加入这个组")
    return m


# ---------- 忙闲位图（FR-45：默认只暴露类型，不暴露标题） ----------

def _member_status(db: Session, m: GroupMember, day: date,
                   lo_min: int, hi_min: int) -> tuple[str, list[str]]:
    """返回 (状态, 细节列表)。状态：busy 确定忙 / maybe 可能有事 / free 应该空闲。
    细节仅在本人开放 share_detail 时返回。"""
    user = m.user_code
    term = get_term(db, user)
    now = datetime.now()
    details: list[str] = []
    # 课程
    if term:
        week = current_week(term.start_monday, day, term.total_weeks)
        if week >= 1:
            for c in db.scalars(select(Course).where(Course.user_code == user)).all():
                if c.day_of_week != day.isoweekday() or week not in (c.weeks or []):
                    continue
                a = _hms(SLOT_TIMES[c.start_slot - 1][0])
                b = _hms(SLOT_TIMES[min(c.end_slot, len(SLOT_TIMES)) - 1][1])
                if a < hi_min and lo_min < b:
                    details.append(f"上课 {c.name}")
    # 日程（含仅开始、挡时间）
    day_lo = datetime.combine(day, time.min)
    day_hi = datetime.combine(day, time.max)
    evs = db.scalars(select(Event).where(
        Event.user_code == user, Event.status.in_(("ok", "pending")),
        Event.start_at <= day_hi, Event.end_at >= day_lo)).all()
    fuzzy_hit = False
    for e in evs:
        e_lo = 0 if e.start_at < day_lo else e.start_at.hour * 60 + e.start_at.minute
        e_hi = 24 * 60 - 1 if e.end_at > day_hi else e.end_at.hour * 60 + e.end_at.minute
        if e.time_status in ("exact", "start_only"):
            if e_lo < hi_min and lo_min < e_hi:
                tag = "安排" if e.type != "block" else "挡时间"
                details.append(f"{tag} {e.title}")
        else:  # fuzzy / todo：只有整天覆盖才算"可能有事"
            if e_lo <= lo_min and e_hi >= hi_min:
                fuzzy_hit = True
    # 饭点深夜 → 可能有事
    meal_hit = any(a < hi_min and lo_min < b for a, b in
                   ((720, 820), (1050, 1130)))  # 12:00-13:40 / 17:30-18:50
    if any("上课" in d or "安排" in d or "挡时间" in d for d in details):
        return "busy", (details if m.share_detail else [])
    if fuzzy_hit or meal_hit:
        return "maybe", []
    return "free", []


def _hms(t: str) -> int:
    h, m = t.split(":")
    return int(h) * 60 + int(m)


def _members(db: Session, g: Group) -> list[GroupMember]:
    return db.scalars(select(GroupMember).where(GroupMember.group_id == g.id)).all()


# ---------- FR-42 共同空闲 Top3 ----------

@router.get("/{code}/free")
def common_free(code: str, days: int = 7, user: str = Depends(get_user),
                db: Session = Depends(get_db)):
    """未来 N 天全组成员都空闲的时段，按偏好打分取 Top3。返回各时段全员状态一览。"""
    g = _get(db, code)
    _member(db, g, user)
    days = max(1, min(days, 14))
    members = _members(db, g)
    if not members:
        return {"slots": []}
    now = datetime.now()
    out: list[dict] = []
    day = now.date()
    # 收集所有共同空闲段
    cands: list[dict] = []
    for _ in range(days):
        segs_per_m = []
        for m in members:
            segs_per_m.append(_free_segments(_day_busy(db, m.user_code, get_term(db, m.user_code), day)))
        # 逐 30 分钟格求交集
        lo0, hi0 = BUSY_WINDOW
        grid_lo = ((max(lo0, _now_min(day, now)) + GRID - 1) // GRID) * GRID
        day_cands: list[tuple[int, int]] = []
        t = grid_lo
        while t + GRID <= min(hi0, 23 * 60):
            if all(any(a <= t and t + GRID <= b for a, b in segs) for segs in segs_per_m):
                day_cands.append((t, t + GRID))
            t += GRID
        # 连续格合并成段
        for a, b in _merge(day_cands):
            cands.append({"day": day, "lo": a, "hi": b})
        day += timedelta(days=1)
    # 打分：越早越大段越靠前；输出每个候选全员状态
    def score(c: dict) -> float:
        span = c["hi"] - c["lo"]
        ahead = (c["day"] - now.date()).days
        return span / (1 + 0.5 * ahead)
    for c in sorted(cands, key=score, reverse=True)[:TOP_N]:
        states = []
        for m in members:
            st, det = _member_status(db, m, c["day"], c["lo"], c["hi"])
            states.append({"nickname": m.nickname or "同学", "status": st, "details": det})
        out.append({
            "date": c["day"].isoformat(),
            "start_min": c["lo"], "end_min": c["hi"],
            "members": states,
        })
    return {"slots": out}


def _merge(cells: list[tuple[int, int]]) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    for a, b in cells:
        if out and a == out[-1][1]:
            out[-1] = (out[-1][0], b)
        else:
            out.append((a, b))
    return out


def _now_min(day: date, now: datetime) -> int:
    return now.hour * 60 + now.minute if day == now.date() else 0


# ---------- FR-43 指定时间查忙闲 ----------

class CheckIn(BaseModel):
    day: date
    start_min: int = Field(ge=0, le=1439)
    end_min: int = Field(ge=1, le=1440)


@router.post("/{code}/check")
def check_time(code: str, body: CheckIn, user: str = Depends(get_user),
               db: Session = Depends(get_db)):
    """指定任意时间 → 每个成员三档状态：确定忙 / 可能有事 / 应该空闲。"""
    g = _get(db, code)
    _member(db, g, user)
    if body.end_min <= body.start_min:
        raise HTTPException(400, detail="结束要晚于开始")
    members = _members(db, g)
    out = []
    for m in members:
        st, det = _member_status(db, m, body.day, body.start_min, body.end_min)
        out.append({"nickname": m.nickname or "同学", "is_me": m.user_code == user,
                    "status": st, "details": det})
    return {"members": out}


def _member_day_intervals(db: Session, m: GroupMember, day: date
                          ) -> tuple[list[tuple[int, int]], list[tuple[int, int]]]:
    """成员某天的 (确定忙区间, 可能有事区间)。每天只扫一次库，供整周矩阵复用。"""
    user = m.user_code
    term = get_term(db, user)
    busy: list[tuple[int, int]] = []
    if term:
        week = current_week(term.start_monday, day, term.total_weeks)
        if week >= 1:
            for c in db.scalars(select(Course).where(Course.user_code == user)).all():
                if c.day_of_week != day.isoweekday() or week not in (c.weeks or []):
                    continue
                busy.append((_hms(SLOT_TIMES[c.start_slot - 1][0]),
                             _hms(SLOT_TIMES[min(c.end_slot, len(SLOT_TIMES)) - 1][1])))
    day_lo = datetime.combine(day, time.min)
    day_hi = datetime.combine(day, time.max)
    fuzzy: list[tuple[int, int]] = []
    for e in db.scalars(select(Event).where(
            Event.user_code == user, Event.status == "ok",
            Event.start_at <= day_hi, Event.end_at >= day_lo)).all():
        lo = 0 if e.start_at < day_lo else e.start_at.hour * 60 + e.start_at.minute
        hi = 24 * 60 if e.end_at > day_hi else e.end_at.hour * 60 + e.end_at.minute
        if e.time_status in ("exact", "start_only"):
            busy.append((lo, hi))
        else:  # fuzzy / todo 整天覆盖才算"可能有事"
            fuzzy.append((lo, hi))
    maybe = list(MEALS) + fuzzy
    return busy, maybe


# ---------- 整周忙闲矩阵（本周/下周一览表） ----------

@router.get("/{code}/matrix")
def busy_matrix(code: str, week: int = 0, user: str = Depends(get_user),
                db: Session = Depends(get_db)):
    """周一至周日 × 30 分钟格 × 全员：0 空闲 / 1 可能有事 / 2 确定忙。
    week=0 本周，1 下周。隐私同 FR-45：只给状态，细节走 /check。"""
    g = _get(db, code)
    _member(db, g, user)
    week = 1 if week else 0
    today = datetime.now().date()
    monday = today - timedelta(days=today.isoweekday() - 1) + timedelta(weeks=week)
    days = [monday + timedelta(days=i) for i in range(7)]
    slots = list(range(BUSY_WINDOW[0], BUSY_WINDOW[1], GRID))
    members = _members(db, g)
    # grid[第几天][第几个成员][第几格]
    grid: list[list[list[int]]] = []
    for day in days:
        per_member: list[list[int]] = []
        for m in members:
            busy, maybe = _member_day_intervals(db, m, day)
            col = []
            for lo in slots:
                hi = lo + GRID
                if any(a < hi and lo < b for a, b in busy):
                    col.append(2)
                elif any(a < hi and lo < b for a, b in maybe):
                    col.append(1)
                else:
                    col.append(0)
            per_member.append(col)
        grid.append(per_member)
    return {
        "days": [d.isoformat() for d in days],
        "slots": slots,
        "members": [{"nickname": m.nickname or "同学", "is_me": m.user_code == user}
                    for m in members],
        "grid": grid,
    }


# ---------- FR-44 定档与确认 ----------

class SettleIn(BaseModel):
    title: str = Field(min_length=1, max_length=64)
    day: date
    start_min: int = Field(ge=0, le=1439)
    end_min: int = Field(ge=1, le=1440)


@router.post("/{code}/settle")
def settle(code: str, body: SettleIn, user: str = Depends(get_user),
           db: Session = Depends(get_db)):
    """组长定档：给每个成员各写一条 pending 群组日程，等全员确认。"""
    g = _get(db, code)
    if g.creator_code != user:
        raise HTTPException(403, detail="只有组长能定档")
    if body.end_min <= body.start_min:
        raise HTTPException(400, detail="结束要晚于开始")
    members = _members(db, g)
    if not members:
        raise HTTPException(400, detail="组里没人")
    start = datetime.combine(body.day, time(body.start_min // 60, body.start_min % 60))
    end = datetime.combine(body.day, time(body.end_min // 60, body.end_min % 60))
    batch = f"group:{g.code}:{int(datetime.now().timestamp() * 1000)}"
    for m in members:
        db.add(Event(user_code=m.user_code, title=body.title.strip(),
                     start_at=start, end_at=end, type="group", source="group",
                     status="pending", note=batch[:120]))
    db.commit()
    return {"ok": True, "batch": batch, "count": len(members)}


class RespondIn(BaseModel):
    batch: str
    ok: bool = True


@router.post("/{code}/respond")
def respond(code: str, body: RespondIn, user: str = Depends(get_user),
            db: Session = Depends(get_db)):
    """成员确认 ✓ / 有冲突 ✗。全员确认 → 整批转 ok 正式进各自日程；
    有人标冲突 → 该人转 conflict，批次作废（组长需另选时间）。"""
    g = _get(db, code)
    _member(db, g, user)
    ev = db.scalars(select(Event).where(
        Event.user_code == user, Event.type == "group",
        Event.note == body.batch[:120])).first()
    if not ev:
        raise HTTPException(404, detail="这档不存在或已处理")
    ev.status = "ok" if body.ok else "conflict"
    db.commit()
    batch_evs = db.scalars(select(Event).where(
        Event.type == "group", Event.note == body.batch[:120])).all()
    if all(e.status == "ok" for e in batch_evs):
        for e in batch_evs:  # 全员确认 → 正式落各自日程
            e.status = "ok"
        db.commit()
        return {"ok": True, "settled": True}
    if any(e.status == "conflict" for e in batch_evs):
        return {"ok": True, "settled": False, "conflict": True}
    return {"ok": True, "settled": False, "confirmed": sum(1 for e in batch_evs if e.status == "ok"),
            "total": len(batch_evs)}


@router.get("/{code}/pending")
def pending_settles(code: str, user: str = Depends(get_user), db: Session = Depends(get_db)):
    """我的待确认群组定档列表。"""
    g = _get(db, code)
    _member(db, g, user)
    evs = db.scalars(select(Event).where(
        Event.user_code == user, Event.type == "group", Event.status == "pending")).all()
    seen: dict[str, dict] = {}
    for e in evs:
        batch = e.note or ""
        if batch not in seen:
            seen[batch] = {"batch": batch, "title": e.title,
                           "start_at": e.start_at.isoformat(timespec="minutes"),
                           "end_at": e.end_at.isoformat(timespec="minutes")}
    return {"pending": list(seen.values())}
