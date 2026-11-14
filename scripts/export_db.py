# -*- coding: utf-8 -*-
"""v2 数据迁移：把 v1 的 schedule.db（FastAPI + SQLAlchemy 时代的 SQLite）导出为
「拼时间」v2 备份 JSON，供 App 内 个人主页 → 备份与恢复 → 导入备份 使用。

仅用 Python 标准库（不需要 server/ 的虚拟环境和依赖），用法：

    python scripts/export_db.py [schedule.db 路径] [输出 json 路径]

不带参数时默认读仓库根目录的 schedule.db，输出 pintime_backup_<日期>.json。
"""
import json
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def fmt(v):
    """sqlite datetime 字段 → 'YYYY-MM-DD HH:mm:ss'（v2 本地库的时间格式）。"""
    if not v:
        return None
    s = str(v)
    for pat in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, pat).strftime("%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue
    return s


def main() -> None:
    try:  # Windows 控制台默认 GBK，中文提示强制 UTF-8
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    db_path = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "schedule.db"
    out_path = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / f"pintime_backup_{datetime.now():%Y%m%d}.json"
    if not db_path.exists():
        sys.exit(f"找不到数据库：{db_path}")

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    def rows(table):
        try:
            return cur.execute(f"SELECT * FROM {table}").fetchall()
        except sqlite3.OperationalError:
            return []

    terms = [dict(r) for r in rows("terms")]
    profiles = [dict(r) for r in rows("profiles")]
    courses = [dict(r) for r in rows("courses")]
    events = [dict(r) for r in rows("events")]
    ddls = [dict(r) for r in rows("ddls")]

    # v1 是多设备/测试共库：按数据量挑出真实账号（要导别的账号：python export_db.py 后加账号名参数）
    by_user: dict[str, dict] = {}
    for table, rs in (("term", terms), ("course", courses), ("event", events), ("ddl", ddls)):
        for r in rs:
            u = r.get("user_code")
            by_user.setdefault(u, {"term": 0, "course": 0, "event": 0, "ddl": 0})[table] += 1
    if not by_user:
        sys.exit("库里没有任何数据")
    explicit = sys.argv[3] if len(sys.argv) > 3 else None
    if explicit:
        user = explicit
    else:
        user = max(by_user, key=lambda u: (by_user[u]["course"] + by_user[u]["event"] + by_user[u]["ddl"],
                                           by_user[u]["term"]))
    print("库内各账号（课程/日程/DDL）：")
    for u, c in sorted(by_user.items(), key=lambda kv: -(kv[1]["course"] + kv[1]["event"] + kv[1]["ddl"])):
        mark = "  ← 本次导出" if u == user else ""
        print(f"  {u}: {c['course']}/{c['event']}/{c['ddl']}{mark}")

    def keep(rows_, key="user_code"):
        return [r for r in rows_ if r.get(key) == user]

    terms, courses, events, ddls = keep(terms), keep(courses), keep(events), keep(ddls)
    prof = next((p for p in keep(profiles) if p["user_code"] == user), {})

    def clean_course(c):
        return {
            "id": c["id"], "name": c["name"], "teacher": c.get("teacher") or "",
            "location": c.get("location") or "", "day_of_week": c["day_of_week"],
            "start_slot": c["start_slot"], "end_slot": c["end_slot"],
            "weeks": json.loads(c["weeks"]) if isinstance(c.get("weeks"), str) else (c.get("weeks") or []),
            "remark": c.get("remark") or "",
        }

    def clean_event(e):
        return {
            "id": e["id"], "title": e["title"], "note": e.get("note") or "",
            "location": e.get("location") or "", "icon": e.get("icon") or "",
            "color_idx": e.get("color_idx") or 0, "time_status": e.get("time_status") or "exact",
            "type": e.get("type") or "temp", "source": e.get("source") or "text",
            "status": e.get("status") or "ok", "ddl_id": e.get("ddl_id"), "series_id": e.get("series_id"),
            "start_at": fmt(e["start_at"]), "end_at": fmt(e["end_at"]),
        }

    def clean_ddl(d):
        return {
            "id": d["id"], "title": d["title"], "course_name": d.get("course_name") or "",
            "due_at": fmt(d["due_at"]), "weight": d.get("weight") or 2,
            "kind": d.get("kind") or "task", "location": d.get("location") or "",
            "note": d.get("note") or "", "exam_end": fmt(d.get("exam_end")),
            "muted": bool(d.get("muted")), "status": d.get("status") or "open",
        }

    term = terms[-1] if terms else None  # 取最新一条学期（同 v1 get_or_none 的语义）
    backup = {
        "app": "pintime", "version": 2, "exported_at": fmt(datetime.now().isoformat()),
        "term": None if not term else {
            "id": term["id"], "name": term.get("name") or "本学期",
            "start_monday": fmt(term["start_monday"])[:10],
            "total_weeks": term.get("total_weeks") or 20,
        },
        "courses": [clean_course(c) for c in courses],
        "events": [clean_event(e) for e in events],
        "ddls": [clean_ddl(d) for d in ddls],
        "profile": {
            "user_code": user, "nickname": prof.get("nickname") or "",
            "created_at": fmt(prof.get("created_at")),
        },
    }
    out_path.write_text(json.dumps(backup, ensure_ascii=False), encoding="utf-8")
    print(f"账号 {user}：课程 {len(courses)} 门 / 日程 {len(events)} 条 / DDL {len(ddls)} 个 / 学期 {'有' if term else '无'}")
    print(f"已导出 → {out_path}")
    print("下一步：手机打开 App → 主页 → 备份与恢复 → 导入备份，粘贴该文件全部内容。")
    conn.close()


if __name__ == "__main__":
    main()
