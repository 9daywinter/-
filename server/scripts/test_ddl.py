# -*- coding: utf-8 -*-
"""D3 DDL 测试：规则抽取 / 红黄绿分档 / 空闲池推荐 / 接受落日程。
纯函数直测 + 内存 SQLite 走一遍引擎（不起服务）。"""
import sys
from datetime import date, datetime, time, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402

from app.database import Base  # noqa: E402
from app.models import Course, DdlFeedback, DDL, Event, Term  # noqa: E402
from app.routers.ddls import (_free_segments, _pref_factor, _remain_text,  # noqa: E402
                              _rule_parse_ddls, _tier, get_suggestions,
                              accept_suggestion)
from app.schemas import SuggestAcceptIn  # noqa: E402

NOW = datetime(2026, 11, 8, 10, 0)  # 周日
RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, ok, detail))
    print(f"{'✅' if ok else '❌'} {name}" + (f"  [{detail}]" if detail and not ok else ""))


# ---------- 1) 规则抽取 ----------

r = _rule_parse_ddls("同学们，本周五24:00前交实验报告，电子版发学习通", NOW, [])
check("抽取·周五24:00前交实验报告",
      len(r) == 1 and r[0].due_at == datetime(2026, 11, 13, 23, 59)
      and r[0].title == "实验报告" and r[0].weight == 2,
      f"got {r[0].due_at if r else '-'} {r[0].title if r else '-'}")

r = _rule_parse_ddls("12月30日前提交课程论文，查重率15%以下", NOW, [])
check("抽取·12月30日前课程论文（论文→权重3）",
      len(r) == 1 and r[0].due_at == datetime(2026, 12, 30, 23, 59)
      and r[0].title == "课程论文" and r[0].weight == 3,
      f"got {r[0].due_at if r else '-'} {r[0].title if r else '-'} w{r[0].weight if r else '-'}")

r = _rule_parse_ddls("截止到11月15日 18:00，提交读书笔记", NOW, [])
check("抽取·截止到X日 18:00",
      len(r) == 1 and r[0].due_at == datetime(2026, 11, 15, 18, 0)
      and r[0].title == "读书笔记",
      f"got {r[0].due_at if r else '-'} {r[0].title if r else '-'}")

notice = ("@所有人 通知两件事：\n"
          "1. 本周五24:00前交实验报告，发学习通\n"
          "2. 数据结构作业 ddl 11月20日晚上10点\n"
          "3. 教材费还没交的同学尽快找班长")
r = _rule_parse_ddls(notice, NOW, [])
check("抽取·群通知多行两 DDL",
      len(r) == 2 and {x.title for x in r} == {"实验报告", "数据结构作业"}
      and any(x.due_at == datetime(2026, 11, 20, 22, 0) for x in r),
      f"got {[(x.title, x.due_at) for x in r]}")

r = _rule_parse_ddls("11月1日前交上次作业（过期通知）", NOW, [])
check("抽取·已过期不抽", len(r) == 0, f"got {len(r)}")

r = _rule_parse_ddls("@所有人 请大家提前完成CAD安装，今晚六点半学习CAD内容", NOW, [])
check("抽取·今晚六点半=今天18:30",
      len(r) == 1 and r[0].due_at == datetime(2026, 11, 8, 18, 30),
      f"got {[(x.title, x.due_at) for x in r]}")

r = _rule_parse_ddls("明晚8点前交实验报告", NOW, [])
check("抽取·明晚8点前=明天20:00",
      len(r) == 1 and r[0].due_at == datetime(2026, 11, 9, 20, 0),
      f"got {[(x.title, x.due_at) for x in r]}")

r = _rule_parse_ddls("高数作业 ddl 11月20日", NOW, ["高等数学", "数据结构"])
check("抽取·课程名弱关联匹配", len(r) == 1 and r[0].title == "高数作业",
      f"got {[(x.title, x.course_name) for x in r]}")

# ---------- 2) 红黄绿分档（剩余时间 × 权重） ----------

check("分档·高权重半天内=红", _tier(NOW + timedelta(hours=20), 3, "open", NOW) == "red")
check("分档·中权重5天=黄", _tier(NOW + timedelta(hours=100), 2, "open", NOW) == "yellow")
check("分档·低权重3天内=黄", _tier(NOW + timedelta(hours=70), 1, "open", NOW) == "yellow")
check("分档·一周外=绿", _tier(NOW + timedelta(days=7), 1, "open", NOW) == "green")
check("分档·过线=逾期置灰", _tier(NOW - timedelta(hours=2), 3, "open", NOW) == "overdue")
check("分档·完成=done", _tier(NOW - timedelta(hours=2), 3, "done", NOW) == "done")
check("倒计时·剩3天5小时", _remain_text(NOW + timedelta(days=3, hours=5), NOW) == "剩3天5小时")
check("倒计时·逾期2小时", _remain_text(NOW - timedelta(hours=2), NOW) == "逾期2小时")

# ---------- 3) 空闲段切分 ----------

segs = _free_segments([(8 * 60, 9 * 60 + 40), (12 * 60, 13 * 60 + 40),
                       (17 * 60 + 30, 18 * 60 + 50), (19 * 60, 21 * 60)])
# 注意：18:50-19:00 只有 10 分钟碎片，低于 MIN_SEG=40 被丢弃
check("空闲·活动窗内抠掉忙碌与饭点",
      segs == [(9 * 60 + 40, 12 * 60), (13 * 60 + 40, 17 * 60 + 30), (21 * 60, 22 * 60 + 30)],
      f"got {segs}")

# ---------- 4) 推荐引擎全链路（内存库） ----------

eng = create_engine("sqlite://")
Base.metadata.create_all(eng)
db = sessionmaker(bind=eng)()
real_now = datetime.now()
monday = real_now.date() - timedelta(days=real_now.weekday())
db.add(Term(user_code="u1", name="测试学期", start_monday=monday, total_weeks=20))
tomorrow = real_now.date() + timedelta(days=1)
db.add(Course(user_code="u1", term_id=1, name="高等数学", day_of_week=tomorrow.isoweekday(),
              start_slot=1, end_slot=2, weeks=list(range(1, 21))))
db.add(Event(user_code="u1", title="社团例会", start_at=datetime.combine(tomorrow, time(19, 0)),
             end_at=datetime.combine(tomorrow, time(21, 0)), time_status="exact"))
d_urgent = DDL(user_code="u1", title="实验报告", due_at=real_now + timedelta(hours=20), weight=3)
d_later = DDL(user_code="u1", title="读书笔记", due_at=real_now + timedelta(days=6), weight=1)
db.add_all([d_urgent, d_later])
db.commit()

out = get_suggestions(user="u1", db=db)
ok_cnt = len(out.cards)
first = out.cards[0] if out.cards else None
check("推荐·两个 DDL 都出卡片", ok_cnt == 2, f"got {ok_cnt}")
check("推荐·紧迫的排前面", first and first.title == "实验报告", f"first={first.title if first else '-'}")

bad = []
for c in out.cards:
    for s in c.slots:
        if not (time(8, 0) <= s.start_at.time() and s.end_at.time() <= time(22, 30)):
            bad.append(f"{s.start_at} 超出活动窗")
        if s.start_at.date() == tomorrow:
            lo = s.start_at.hour * 60 + s.start_at.minute
            hi = s.end_at.hour * 60 + s.end_at.minute
            if lo < 9 * 60 + 40 and hi > 8 * 60:
                bad.append(f"{s.start_at} 撞课")          # 8:00-9:40 高数
            if lo < 21 * 60 and hi > 19 * 60:
                bad.append(f"{s.start_at} 撞例会")        # 19:00-21:00
            if lo < 13 * 60 + 40 and hi > 12 * 60:
                bad.append(f"{s.start_at} 撞午饭")        # 12:00-13:40
check("推荐·避开课程/例会/饭点且在活动窗内", not bad, "; ".join(bad[:3]))
check("推荐·每卡最多3个备选", all(len(c.slots) <= 3 for c in out.cards))

# 接受 → 写入日程（type=suggestion / source=ddl / ddl_id 关联）
slot0 = first.slots[0]
ev = accept_suggestion(SuggestAcceptIn(ddl_id=first.ddl_id,
                                       start_at=slot0.start_at, end_at=slot0.end_at),
                       user="u1", db=db)
check("接受·落日程并关联 DDL",
      ev.type == "suggestion" and ev.source == "ddl" and ev.ddl_id == first.ddl_id
      and ev.start_at == slot0.start_at)

out2 = get_suggestions(user="u1", db=db)
check("接受·不再重复推同一 DDL",
      all(c.ddl_id != first.ddl_id for c in out2.cards), f"got {len(out2.cards)} cards")

# 忽略两晚 → 晚上降权
db.add_all([DdlFeedback(user_code="u1", ddl_id=d_later.id, action="ignore", bucket="evening"),
            DdlFeedback(user_code="u1", ddl_id=d_later.id, action="ignore", bucket="evening")])
db.commit()
prefs = _pref_factor(db, "u1")
check("反馈·晚间被忽略两次→降权", prefs["evening"] < 0.4 and prefs["morning"] == 1.0,
      f"got {prefs}")

print(f"\n{sum(1 for _, ok, _ in RESULTS if ok)}/{len(RESULTS)}")
sys.exit(0 if all(ok for _, ok, _ in RESULTS) else 1)
