from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .database import Base, engine
from .routers import ai, conflict, courses, ddls, events, groups, profile, terms

# 启动即建表（SQLite 骨架版够用）
Base.metadata.create_all(bind=engine)


def _ensure_columns():
    """SQLite 轻量迁移：create_all 只建新表不加列，老库手动补列（幂等）"""
    from sqlalchemy import inspect, text

    ins = inspect(engine)
    cols = {c["name"] for c in ins.get_columns("events")}
    with engine.begin() as conn:
        if "note" not in cols:
            conn.execute(text("ALTER TABLE events ADD COLUMN note VARCHAR(256) DEFAULT ''"))
        if "color_idx" not in cols:
            conn.execute(text("ALTER TABLE events ADD COLUMN color_idx INTEGER DEFAULT 0"))
        if "location" not in cols:
            conn.execute(text("ALTER TABLE events ADD COLUMN location VARCHAR(128) DEFAULT ''"))
        if "icon" not in cols:
            conn.execute(text("ALTER TABLE events ADD COLUMN icon VARCHAR(8) DEFAULT ''"))
        if "time_status" not in cols:
            conn.execute(text("ALTER TABLE events ADD COLUMN time_status VARCHAR(12) DEFAULT 'exact'"))
        if "ddl_id" not in cols:
            conn.execute(text("ALTER TABLE events ADD COLUMN ddl_id INTEGER"))
        course_cols = {c["name"] for c in ins.get_columns("courses")}
        if "remark" not in course_cols:
            conn.execute(text("ALTER TABLE courses ADD COLUMN remark VARCHAR(128) DEFAULT ''"))
        ddl_cols = {c["name"] for c in ins.get_columns("ddls")}
        if "kind" not in ddl_cols:
            conn.execute(text("ALTER TABLE ddls ADD COLUMN kind VARCHAR(8) DEFAULT 'task'"))
        if "location" not in ddl_cols:
            conn.execute(text("ALTER TABLE ddls ADD COLUMN location VARCHAR(128) DEFAULT ''"))
        if "note" not in ddl_cols:
            conn.execute(text("ALTER TABLE ddls ADD COLUMN note VARCHAR(256) DEFAULT ''"))
        if "exam_end" not in ddl_cols:
            conn.execute(text("ALTER TABLE ddls ADD COLUMN exam_end DATETIME"))
        if "muted" not in ddl_cols:
            conn.execute(text("ALTER TABLE ddls ADD COLUMN muted BOOLEAN DEFAULT 0"))
        if "series_id" not in cols:
            conn.execute(text("ALTER TABLE events ADD COLUMN series_id INTEGER"))
        gm_cols = {c["name"] for c in ins.get_columns("group_members")}
        if "share_detail" not in gm_cols:
            conn.execute(text("ALTER TABLE group_members ADD COLUMN share_detail BOOLEAN DEFAULT 0"))


_ensure_columns()

app = FastAPI(title="大学生日程工具 API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 骨架版放开；上线前收紧
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(terms.router)
app.include_router(courses.router)
app.include_router(events.router)
app.include_router(conflict.router)
app.include_router(ai.router)
app.include_router(profile.router)
app.include_router(ddls.router)
app.include_router(ddls.sug_router)
app.include_router(groups.router)


@app.get("/api/health")
def health():
    return {"ok": True, "app": "schedule-api"}
