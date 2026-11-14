from datetime import timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Term
from ..schemas import TermIn, TermOut
from ..utils.week import current_week
from .deps import get_user

router = APIRouter(prefix="/api/terms", tags=["terms"])


def _to_out(term: Term) -> TermOut:
    return TermOut(
        id=term.id,
        name=term.name,
        start_monday=term.start_monday,
        total_weeks=term.total_weeks,
        current_week=current_week(term.start_monday, total_weeks=term.total_weeks),
    )


def get_or_none(db: Session, user: str) -> Term | None:
    return db.scalar(select(Term).where(Term.user_code == user).order_by(Term.id.desc()))


@router.get("", response_model=TermOut)
def read_term(user: str = Depends(get_user), db: Session = Depends(get_db)):
    term = get_or_none(db, user)
    if not term:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="未设置学期，请先填写开学日期")
    return _to_out(term)


@router.put("", response_model=TermOut)
def save_term(body: TermIn, user: str = Depends(get_user), db: Session = Depends(get_db)):
    # 开学日期必须是周一：填了周中任意一天，自动对齐到那一周的周一，
    # 否则整个课表的星期列全部错位（周六开学的"第1周周一"其实是周六）
    body.start_monday -= timedelta(days=body.start_monday.weekday())
    term = get_or_none(db, user)
    if term:
        term.name = body.name
        term.start_monday = body.start_monday
        term.total_weeks = body.total_weeks
    else:
        term = Term(user_code=user, **body.model_dump())
        db.add(term)
    db.commit()
    db.refresh(term)
    return _to_out(term)
