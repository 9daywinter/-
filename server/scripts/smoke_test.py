"""冒烟测试：D1 后端接口全链路验证（可反复运行）"""
import httpx

BASE = "http://localhost:8000"
H = {"X-User": "test001"}

r = httpx.get(f"{BASE}/api/health", headers=H)
print("health:", r.json())

r = httpx.put(f"{BASE}/api/terms", headers=H,
              json={"name": "2026秋", "start_monday": "2026-09-07", "total_weeks": 20})
print("term:", r.status_code, r.json())  # 应返回 current_week（今天是第几教学周）

r = httpx.post(f"{BASE}/api/courses", headers=H,
               json={"name": "高等数学", "location": "教三-301",
                     "day_of_week": 1, "start_slot": 1, "end_slot": 2,
                     "weeks": [1, 3, 5, 7, 9, 11, 13, 15, 17]})
print("create:", r.status_code, r.json())
cid = r.json()["id"]

r = httpx.get(f"{BASE}/api/courses", headers=H)
print("list:", r.status_code, f"{len(r.json())} 门课")

r = httpx.delete(f"{BASE}/api/courses/{cid}", headers=H)
print("delete:", r.status_code, r.json())

r = httpx.get(f"{BASE}/api/courses", headers=H)
print("after delete:", f"{len(r.json())} 门课")
