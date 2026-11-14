# -*- coding: utf-8 -*-
"""D2+ 冒烟：图标/地点字段、冲突检测、临时调课（停课/换时段）。"""
import sys

import httpx

BASE = "http://localhost:8000"
U = "smoke_conflict_user"

c = httpx.Client(base_url=BASE, headers={"X-User": U}, timeout=30)


def check(name, cond, detail=""):
    print(("PASS" if cond else "FAIL"), name, detail if not cond else "")
    if not cond:
        sys.exit(1)


# 0) 干净环境：学期（11-02 周一开学）+ 一门周一 1-2 节的课
c.put("/api/terms", json={"start_monday": "2026-11-02", "total_weeks": 20})
c.delete("/api/courses")
r = c.post("/api/courses", json={"name": "高等数学", "day_of_week": 1,
                                 "start_slot": 1, "end_slot": 2, "weeks": [1]})
check("setup course", r.status_code == 200, r.text)

# 1) 冲突检测：与课程撞（周一 11-09 是第 2 周——课 weeks=[1] 只有第 1 周有课，先测第 1 周）
r = c.post("/api/events/conflict", json={
    "start_at": "2026-11-02 08:30:00", "end_at": "2026-11-02 10:00:00"})
d = r.json()
check("course conflict hit", r.status_code == 200 and len(d["courses"]) == 1, d)
check("course conflict fields",
      d["courses"][0]["name"] == "高等数学" and d["courses"][0]["slots_text"] == "第1-2节", d)

# 2) 不撞的时段（同一天下午）
r = c.post("/api/events/conflict", json={
    "start_at": "2026-11-02 14:00:00", "end_at": "2026-11-02 16:00:00"})
d = r.json()
check("no conflict", r.status_code == 200 and not d["courses"] and not d["events"], d)

# 3) 教学周过滤：第 2 周同一时段（该课只上第 1 周）→ 不冲突
r = c.post("/api/events/conflict", json={
    "start_at": "2026-11-09 08:30:00", "end_at": "2026-11-09 10:00:00"})
d = r.json()
check("week filter works", not d["courses"], d)

# 4) 日程冲突 + exclude 自身
r = c.post("/api/events", json={"title": "已有安排", "icon": "📚",
                                "start_at": "2026-11-03 09:00:00",
                                "end_at": "2026-11-03 11:00:00"})
check("event with icon created", r.status_code == 200 and r.json()["icon"] == "📚", r.text)
eid = r.json()["id"]
r = c.post("/api/events/conflict", json={
    "start_at": "2026-11-03 10:00:00", "end_at": "2026-11-03 12:00:00"})
d = r.json()
check("event conflict hit", len(d["events"]) == 1 and d["events"][0]["title"] == "已有安排", d)
r = c.post("/api/events/conflict", json={
    "start_at": "2026-11-03 10:00:00", "end_at": "2026-11-03 12:00:00",
    "exclude_event_id": eid})
check("exclude self", not r.json()["events"], r.text)

# 5) 调课：原课去掉第 1 周 → 新建第 1 周周一下午的调课记录
courses = c.get("/api/courses").json()
src = next(x for x in courses if x["name"] == "高等数学")
r = c.put(f"/api/courses/{src['id']}", json={**src, "weeks": []})
check("skip week put", r.status_code == 200, r.text)
r = c.post("/api/courses", json={"name": "高等数学", "day_of_week": 1,
                                 "start_slot": 6, "end_slot": 7, "weeks": [1]})
check("moved course created", r.status_code == 200, r.text)
# 原时段不再冲突，新时段（周一 14:00-15:40）冲突
r = c.post("/api/events/conflict", json={
    "start_at": "2026-11-02 08:30:00", "end_at": "2026-11-02 10:00:00"})
check("old slot free after move", not r.json()["courses"], r.text)
r = c.post("/api/events/conflict", json={
    "start_at": "2026-11-02 14:30:00", "end_at": "2026-11-02 16:00:00"})
check("new slot conflicts after move", len(r.json()["courses"]) == 1, r.text)

# 6) 清理
c.delete("/api/courses")
for ev in c.get("/api/events").json():
    c.delete(f"/api/events/{ev['id']}")
print("\nALL CONFLICT/RESCHEDULE SMOKE TESTS PASSED")
