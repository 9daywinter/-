"""个人主页：档案 + 聚合概览 + 重置。一次请求拿全页面数据，前端不用拼。"""
from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Course, Event, Group, GroupMember, Profile
from ..schemas import (
    ProfileChangeItem,
    ProfileEventItem,
    ProfileGroupItem,
    ProfileIn,
    ProfileOut,
    ProfileSummaryOut,
    ResetIn,
)
from .deps import get_user
from .terms import _to_out, get_or_none as get_term

router = APIRouter(prefix="/api/profile", tags=["profile"])


def _get_profile(db: Session, user: str) -> Profile:
    """没有档案就当场建（created_at 即"首次使用时间"）"""
    p = db.get(Profile, user)
    if not p:
        p = Profile(user_code=user)
        db.add(p)
        db.commit()
        db.refresh(p)
    return p


@router.get("", response_model=ProfileOut)
def read_profile(user: str = Depends(get_user), db: Session = Depends(get_db)):
    return _get_profile(db, user)


@router.put("", response_model=ProfileOut)
def save_profile(body: ProfileIn, user: str = Depends(get_user), db: Session = Depends(get_db)):
    p = _get_profile(db, user)
    p.nickname = body.nickname.strip()
    db.commit()
    db.refresh(p)
    return p


@router.get("/summary", response_model=ProfileSummaryOut)
def summary(user: str = Depends(get_user), db: Session = Depends(get_db)):
    profile = _get_profile(db, user)

    term = get_term(db, user)
    courses = db.scalars(
        select(Course).where(Course.user_code == user).order_by(Course.day_of_week, Course.start_slot)
    ).all()
    events = db.scalars(
        select(Event)
        .where(Event.user_code == user, Event.status == "ok")
        .order_by(Event.start_at.desc())
        .limit(200)  # 多取一些，重复组折叠后凑满 50 条展示位
    ).all()
    # 长时间重复日程归为一项：同 series 只留最近一条代表，带上总条数
    series_count: dict[int, int] = {}
    for e in events:
        if e.series_id:
            series_count[e.series_id] = series_count.get(e.series_id, 0) + 1
    seen_series: set[int] = set()
    grouped: list[tuple[Event, int]] = []
    for e in events:
        if e.series_id:
            if e.series_id in seen_series:
                continue
            seen_series.add(e.series_id)
        grouped.append((e, series_count.get(e.series_id, 1) if e.series_id else 1))
        if len(grouped) >= 50:
            break
    changes = [c for c in courses if (c.remark or "").strip()]

    # 已加入的群组（D4 开放创建，这里现在就能正确返回空/已有数据）
    rows = db.execute(
        select(Group, GroupMember)
        .join(GroupMember, GroupMember.group_id == Group.id)
        .where(GroupMember.user_code == user)
    ).all()
    groups = [ProfileGroupItem(code=g.code, name=g.name, nickname=m.nickname) for g, m in rows]

    return ProfileSummaryOut(
        profile=ProfileOut(
            user_code=profile.user_code,
            nickname=profile.nickname,
            created_at=profile.created_at,
        ),
        term=_to_out(term) if term else None,
        stats={
            "courses": len(courses),
            "events": len(events),
            "changes": len(changes),
            "groups": len(groups),
        },
        events=[
            ProfileEventItem(
                id=e.id, title=e.title, icon=e.icon or "", location=e.location or "",
                time_status=e.time_status, type=e.type, start_at=e.start_at, end_at=e.end_at,
                series_id=e.series_id, series_count=n,
            )
            for e, n in grouped
        ],
        changes=[
            ProfileChangeItem(
                id=c.id, name=c.name, remark=c.remark, day_of_week=c.day_of_week,
                start_slot=c.start_slot, end_slot=c.end_slot, weeks=c.weeks or [],
            )
            for c in changes
        ],
        groups=groups,
    )


@router.post("/reset")
def reset(body: ResetIn, user: str = Depends(get_user), db: Session = Depends(get_db)):
    """重置数据：courses=清空课程（新学期换课表） events=清空日程 all=两者都清。
    学期设置不动——重置课程后跳学期页改成新学期日期即可。"""
    scope = body.scope
    if scope not in ("courses", "events", "all"):
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="scope 只能是 courses/events/all")
    deleted = {"courses": 0, "events": 0}
    if scope in ("courses", "all"):
        deleted["courses"] = db.query(Course).filter(Course.user_code == user).delete()
    if scope in ("events", "all"):
        deleted["events"] = db.query(Event).filter(Event.user_code == user).delete()
    db.commit()
    return {"ok": True, "deleted": deleted}
