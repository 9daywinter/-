# -*- coding: utf-8 -*-
"""教务课表文件导入端到端测试：真实 docx/xlsx → /api/ai/parse-timetable-file"""
import base64
import sys

import httpx

BASE = "http://localhost:8000"
FILES = [
    r"D:\xwechat_files\wxid_kxa20f7im3j722_5764\msg\file\2026-11\学生课表20261107125107242.docx",
    r"D:\xwechat_files\wxid_kxa20f7im3j722_5764\msg\file\2026-11\学生课表20261107125434061.xlsx",
]

c = httpx.Client(base_url=BASE, headers={"X-User": "smoke_file_user"}, timeout=30)

# 先建学期（第 1 周周一设为 2026-09-07，共 19 周）
c.put("/api/terms", json={"name": "本学期", "start_monday": "2026-09-07", "total_weeks": 19})

results = {}
for p in FILES:
    b64 = base64.b64encode(open(p, "rb").read()).decode()
    r = c.post("/api/ai/parse-timetable-file", json={"file_base64": b64})
    assert r.status_code == 200, r.text
    d = r.json()
    tag = p.rsplit(".", 1)[-1]
    results[tag] = d["courses"]
    print(f"{tag}: {len(d['courses'])} 门, by={d['by']}")
    for x in d["courses"][:3]:
        print("   e.g.", x["name"], f"周{x['day_of_week']} 第{x['start_slot']}-{x['end_slot']}节",
              f"{len(x['weeks'])}周", x["location"])

# 两种格式应解析出同样的课程集合
key = lambda cs: sorted((x["name"], x["day_of_week"], x["start_slot"], x["end_slot"],
                         tuple(x["weeks"]), x["location"]) for x in cs)
same = key(results["docx"]) == key(results["xlsx"])
print("docx/xlsx 结果一致:", same)

# 再验证批量入库
r = c.post("/api/courses/batch", json={"courses": results["xlsx"]})
assert r.status_code == 200, r.text
n = len(c.get("/api/courses").json())
print("入库后课程总数:", n)
print("PASS" if same and n == len(results["xlsx"]) else "FAIL")
sys.exit(0 if same and n == len(results["xlsx"]) else 1)
