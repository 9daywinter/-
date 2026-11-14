# -*- coding: utf-8 -*-
"""D2 冒烟测试：语音解析 / 文本导入 / 截图接口降级 / 日程 CRUD"""
import sys

import httpx

BASE = "http://localhost:8000"
U = "smoke_d2_user"

c = httpx.Client(base_url=BASE, headers={"X-User": U}, timeout=30)


def check(name, cond, detail=""):
    print(("PASS" if cond else "FAIL"), name, detail if not cond else "")
    if not cond:
        sys.exit(1)


# 0) 健康检查
r = c.get("/api/health")
check("health", r.status_code == 200)

# 1) 语音解析（规则降级，无 Key 也通）
r = c.post("/api/ai/parse-voice", json={"text": "明天下午三点半开班会，两个小时"})
d = r.json()
check("parse-voice", r.status_code == 200 and d["title"] == "开班会" and d["by"] in ("rule", "llm"), d)
print("   ->", d["start_at"], "~", d["end_at"], "by", d["by"])

# 2) 课表文本导入（规则解析）
r = c.post("/api/ai/parse-timetable-text", json={"text": "高等数学 周一 1-2节 1-16周 教三301\n大学英语 周三 3-4节 教四402\n数据结构 周五 第6节"})
d = r.json()
check("parse-text count", r.status_code == 200 and len(d["courses"]) == 3, d)
c0 = d["courses"][0]
check("parse-text fields",
      c0["name"] == "高等数学" and c0["day_of_week"] == 1 and c0["start_slot"] == 1
      and c0["end_slot"] == 2 and len(c0["weeks"]) == 16 and c0["location"] == "教三301", c0)
c2 = d["courses"][2]
check("parse-text default weeks", c2["weeks"] == list(range(1, 21)), c2)
print("   -> by", d["by"])

# 3) 截图接口在无 Key 时给出友好错误
r = c.post("/api/ai/parse-timetable", json={"image_base64": "xxx"})
check("parse-image no-key", r.status_code == 400 and "LLM_API_KEY" in r.json()["detail"], r.text)

# 4) 日程 CRUD
r = c.post("/api/events", json={
    "title": "开班会", "start_at": "2026-11-08 15:30:00",
    "end_at": "2026-11-08 17:30:00", "type": "temp", "source": "voice"})
check("event create", r.status_code == 200, r.text)
eid = r.json()["id"]

r = c.post("/api/events", json={
    "title": "坏的", "start_at": "2026-11-08 15:30:00", "end_at": "2026-11-08 15:30:00"})
check("event end<=start rejected", r.status_code == 400)

r = c.get("/api/events")
check("event list", r.status_code == 200 and len(r.json()) >= 1)

r = c.delete(f"/api/events/{eid}")
check("event delete", r.status_code == 200)

print("\nALL D2 SMOKE TESTS PASSED")
