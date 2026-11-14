from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Course, Term
from ..schemas import CourseBatchIn, CourseIn, CourseOut
from .deps import get_user
from .terms import get_or_none as get_term

router = APIRouter(prefix="/api/courses", tags=["courses"])


def _owned(db: Session, user: str, course_id: int) -> Course:
    course = db.get(Course, course_id)
    if not course or course.user_code != user:
        raise HTTPException(status_code=404, detail="课程不存在")
    return course


@router.get("", response_model=list[CourseOut])
def list_courses(user: str = Depends(get_user), db: Session = Depends(get_db)):
    return db.scalars(
        select(Course).where(Course.user_code == user).order_by(Course.day_of_week, Course.start_slot)
    ).all()


@router.post("", response_model=CourseOut)
def create_course(body: CourseIn, user: str = Depends(get_user), db: Session = Depends(get_db)):
    term = get_term(db, user)
    if not term:
        raise HTTPException(status_code=400, detail="请先设置学期")
    course = Course(user_code=user, term_id=term.id, **body.model_dump())
    db.add(course)
    db.commit()
    db.refresh(course)
    return course


@router.post("/batch", response_model=list[CourseOut])
def batch_create(body: CourseBatchIn, user: str = Depends(get_user), db: Session = Depends(get_db)):
    """D2 课表截图解析后批量入库"""
    term = get_term(db, user)
    if not term:
        raise HTTPException(status_code=400, detail="请先设置学期")
    courses = [Course(user_code=user, term_id=term.id, **c.model_dump()) for c in body.courses]
    db.add_all(courses)
    db.commit()
    return courses


@router.put("/{course_id}", response_model=CourseOut)
def update_course(course_id: int, body: CourseIn, user: str = Depends(get_user), db: Session = Depends(get_db)):
    course = _owned(db, user, course_id)
    for k, v in body.model_dump().items():
        setattr(course, k, v)
    db.commit()
    db.refresh(course)
    return course


@router.delete("/{course_id}")
def delete_course(course_id: int, user: str = Depends(get_user), db: Session = Depends(get_db)):
    course = _owned(db, user, course_id)
    db.delete(course)
    db.commit()
    return {"ok": True}


@router.delete("")
def clear_courses(user: str = Depends(get_user), db: Session = Depends(get_db)):
    """重新导入课表前清空旧数据"""
    db.query(Course).filter(Course.user_code == user).delete()
    db.commit()
    return {"ok": True}
