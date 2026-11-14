# -*- coding: utf-8 -*-
"""组队空闲 e2e：建组/进组 → 共同空闲 Top3 → 查忙闲三档 → 定档确认状态机 → 隐私开关。
用法: .venv/Scripts/python.exe -X utf8 scripts/test_groups.py"""
import json
import urllib.request
import uuid

BASE = "http://localhost:8000"
U1 = "testg_a_" + uuid.uuid4().hex[:6]
U2 = "testg_b_" + uuid.uuid4().hex[:6]


def call(method, path, user, body=None):
    req = urllib.request.Request(BASE + path, method=method)
    req.add_header("X-User", user)
    req.add_header("Content-Type", "application/json; charset=utf-8")
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    try:
        with urllib.request.urlopen(req, data) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return {"__err": e.code, "detail": e.read().decode("utf-8")}


# --- FR-41 建组/进组 ---
g = call("POST", "/api/groups", U1, {"name": "测试项目组", "nickname": "组长甲"})
assert "code" in g, g
code = g["code"]
assert g["is_creator"] is True and len(g["members"]) == 1, g
print("✓ 建组 code =", code)

g2 = call("POST", "/api/groups/join", U2, {"code": code, "nickname": "组员乙"})
assert len(g2["members"]) == 2, g2
print("✓ 口令进组，成员 2 人")

bad = call("POST", "/api/groups/join", U2, {"code": "XXXX9999", "nickname": "x"})
assert bad.get("__err") == 404, bad
print("✓ 错口令 404")

# --- FR-42 共同空闲 Top3 ---
fr = call("GET", f"/api/groups/{code}/free", U1)
assert "slots" in fr, fr
print(f"✓ 共同空闲 Top3：{len(fr['slots'])} 个候选")
for s in fr["slots"]:
    assert all(m["status"] == "free" for m in s["members"]), s
    print(f"  {s['date']} {s['start_min']//60:02d}:{s['start_min']%60:02d}-"
          f"{s['end_min']//60:02d}:{s['end_min']%60:02d} 全员空闲")

# --- FR-43 指定时间查忙闲（饭点 → 可能有事） ---
chk = call("POST", f"/api/groups/{code}/check", U1,
           {"day": "2026-11-10", "start_min": 720, "end_min": 780})
assert len(chk["members"]) == 2, chk
statuses = {m["nickname"]: m["status"] for m in chk["members"]}
assert all(v == "maybe" for v in statuses.values()), statuses
assert all(m["details"] == [] for m in chk["members"]), chk  # 隐私默认关
print("✓ 饭点查忙闲 = 可能有事（全员），且细节为空（隐私默认）")

# --- FR-45 隐私开关 ---
p = call("POST", f"/api/groups/{code}/privacy", U2, {"share_detail": True})
assert p.get("share_detail") is True, p
p2 = call("POST", f"/api/groups/{code}/privacy", U2, {"share_detail": False})
assert p2.get("share_detail") is False, p2
print("✓ 隐私开关往返")

# --- FR-44 定档与确认 ---
day = fr["slots"][0]["date"] if fr["slots"] else "2026-11-10"
lo = fr["slots"][0]["start_min"] if fr["slots"] else 840
hi = lo + 60
st = call("POST", f"/api/groups/{code}/settle", U1,
          {"title": "组会", "day": day, "start_min": lo, "end_min": hi})
assert st.get("ok") and st.get("count") == 2, st
batch = st["batch"]
print(f"✓ 组长定档 {day} {lo//60:02d}:{lo%60:02d}，batch={batch}")

deny = call("POST", f"/api/groups/{code}/settle", U2,
            {"title": "抢权", "day": day, "start_min": lo, "end_min": hi})
assert deny.get("__err") == 403, deny
print("✓ 非组长定档被拒 403")

pend = call("GET", f"/api/groups/{code}/pending", U2)
assert len(pend["pending"]) == 1 and pend["pending"][0]["batch"] == batch, pend
print("✓ 组员看到 1 条待确认")

r1 = call("POST", f"/api/groups/{code}/respond", U1, {"batch": batch, "ok": True})
assert r1.get("ok") and not r1.get("settled"), r1
r2 = call("POST", f"/api/groups/{code}/respond", U2, {"batch": batch, "ok": True})
assert r2.get("settled") is True, r2
print("✓ 全员确认 → settled")

# 日程已落到各自 events（status=ok）
evs = call("GET", "/api/events?start=2026-01-01&end=2027-01-01", U2)
mine = [e for e in evs if e.get("type") == "group" and e.get("title") == "组会"]
assert mine and mine[0]["status"] == "ok", mine
print("✓ 定档已写入组员日程 (status=ok)")

# 冲突响应流：再来一批，组员标冲突 → 批次作废
st2 = call("POST", f"/api/groups/{code}/settle", U1,
           {"title": "组会2", "day": day, "start_min": lo, "end_min": hi})
b2 = st2["batch"]
call("POST", f"/api/groups/{code}/respond", U1, {"batch": b2, "ok": True})
rc = call("POST", f"/api/groups/{code}/respond", U2, {"batch": b2, "ok": False})
assert rc.get("conflict") is True, rc
evs2 = call("GET", "/api/events?start=2026-01-01&end=2027-01-01", U2)
g2ev = [e for e in evs2 if e.get("title") == "组会2"]
assert g2ev and g2ev[0]["status"] == "conflict", g2ev
print("✓ 有人标冲突 → 该人 conflict，批次不 settle")

# --- 退组 ---
lv = call("POST", f"/api/groups/{code}/leave", U2)
assert lv.get("ok"), lv
lst = call("GET", "/api/groups", U2)
assert all(g["code"] != code for g in lst["groups"]), lst
print("✓ 退组成功")

print("\nALL GROUP E2E PASS")
