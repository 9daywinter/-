from datetime import datetime, time, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Event
from ..schemas import EventIn, EventOut, EventRecurIn
from .deps import get_user

router = APIRouter(prefix="/api/events", tags=["events"])

RECUR_CAP = 120  # 单次重复日程的实例上限（一学期每天 1 条约 140，留余量）


@router.get("", response_model=list[EventOut])
def list_events(user: str = Depends(get_user), db: Session = Depends(get_db)):
    return db.scalars(
        select(Event).where(Event.user_code == user).order_by(Event.start_at.desc())
    ).all()


@router.post("", response_model=EventOut)
def create_event(body: EventIn, user: str = Depends(get_user), db: Session = Depends(get_db)):
    if body.end_at <= body.start_at:
        raise HTTPException(400, detail="结束时间要晚于开始时间")
    ev = Event(user_code=user, **body.model_dump())
    db.add(ev)
    db.commit()
    db.refresh(ev)
    return ev


@router.put("/{event_id}", response_model=EventOut)
def update_event(event_id: int, body: EventIn, user: str = Depends(get_user),
                 db: Session = Depends(get_db)):
    """改标题/备注/颜色/起止时间"""
    if body.end_at <= body.start_at:
        raise HTTPException(400, detail="结束时间要晚于开始时间")
    ev = db.get(Event, event_id)
    if not ev or ev.user_code != user:
        raise HTTPException(404, detail="日程不存在")
    for k, v in body.model_dump().items():
        setattr(ev, k, v)
    db.commit()
    db.refresh(ev)
    return ev


@router.delete("/{event_id}")
def delete_event(event_id: int, user: str = Depends(get_user), db: Session = Depends(get_db)):
    ev = db.get(Event, event_id)
    if not ev or ev.user_code != user:
        raise HTTPException(404, detail="日程不存在")
    db.delete(ev)
    db.commit()
    return {"ok": True}


# ---------- 批量重复日程（每天练琴 / 每周一三有事） ----------

@router.post("/recurring", response_model=list[EventOut])
def create_recurring(body: EventRecurIn, user: str = Depends(get_user),
                     db: Session = Depends(get_db)):
    """按规则展开成多条日程，共享 series_id（课表上单条可删，也可整组删）。
    结束时刻早于开始 = 跨天（23:00-02:00 → 每条实例跨午夜到次日），时长须 15min~24h。"""
    if body.repeat not in ("daily", "weekly"):
        raise HTTPException(400, detail="repeat 只能是 daily（每天）或 weekly（每周）")
    if body.repeat == "weekly" and not body.days:
        raise HTTPException(400, detail="每周重复至少选一天")
    if body.end_date < body.start_date:
        raise HTTPException(400, detail="结束日期不能早于开始日期")
    try:
        sh, sm = map(int, body.start_time.split(":"))
        eh, em = map(int, body.end_time.split(":"))
    except ValueError:
        raise HTTPException(400, detail="时间格式不对")
    dur = (eh * 60 + em) - (sh * 60 + sm)
    if dur <= 0:
        dur += 1440  # 跨天：23:00 → 次日 02:00
    if dur < 15 or dur >= 1440:
        raise HTTPException(400, detail="单次时长要在 15 分钟 ~ 24 小时之间（结束早于开始=跨到次日）")
    days_set = set(body.days) if body.repeat == "weekly" else set(range(1, 8))
    max_series = db.scalar(select(Event.series_id).where(
        Event.user_code == user, Event.series_id.isnot(None)).order_by(
        Event.series_id.desc()).limit(1)) or 0
    series_id = max_series + 1
    rows: list[Event] = []
    d = body.start_date
    while d <= body.end_date and len(rows) < RECUR_CAP:
        if d.isoweekday() in days_set:
            start_at = datetime.combine(d, time(sh, sm))
            end_at = datetime.combine(d, time(eh, em))
            if end_at <= start_at:
                end_at += timedelta(days=1)  # 跨天时长：23:00-02:00
            rows.append(Event(
                user_code=user, title=body.title, note=body.note,
                location=body.location, icon=body.icon, color_idx=body.color_idx,
                time_status=body.time_status, type="temp", source="text",
                start_at=start_at, end_at=end_at, series_id=series_id))
        d += timedelta(days=1)
    if not rows:
        raise HTTPException(400, detail="这个时间段内没有匹配的日期")
    db.add_all(rows)
    db.commit()
    for e in rows:
        db.refresh(e)
    return rows


@router.delete("/series/{series_id}")
def delete_series(series_id: int, user: str = Depends(get_user), db: Session = Depends(get_db)):
    """整组删除重复日程"""
    rows = db.scalars(select(Event).where(
        Event.user_code == user, Event.series_id == series_id)).all()
    if not rows:
        raise HTTPException(404, detail="日程组不存在")
    for e in rows:
        db.delete(e)
    db.commit()
    return {"ok": True, "deleted": len(rows)}
