# -*- coding: utf-8 -*-
"""群通知解析器测试：真实微信通知 → 结构化日程（无 LLM）。
直接测 utils.notice（不起服务）；现在 = 2026-11-08（周日）。"""
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.utils.notice import looks_like_notice, parse_notice  # noqa: E402

NOW = datetime(2026, 11, 8, 10, 0)  # 周日

CASES = [
    # (名字, 文本, 期望断言函数)
    ("微信·人大投票通知（真实样例）",
     "@所有人 各位同学，明天即将进行人大代表的投票，以下是一些注意事项，请大家务必认真阅读:\n"
     "1.投票地点时间:8:00开始——16:00结束 沙河校区体育馆 北门进入 找到左侧2号通道 信通学院投票站"
     "（Ps：尽量早点投完，实在一天都有课的就午休过来投）\n"
     "2.班长会在8点前找我领取本班选票，其他同学找班长领取选票后8点就可以进场投票，代投的同学需要带好委托书，每人只有一张，丢了无法补\n"
     "3.按照选票要求进行投票，尽量不要投出废票和无效票。\n"
     "排队情况肯定是存在的，辛苦大家耐心一些，希望大家投出自己神圣的一票，选民证下周会返回给大家作为纪念",
     lambda r: r["start_at"] == datetime(2026, 11, 9, 8, 0)
     and r["end_at"] == datetime(2026, 11, 9, 16, 0)
     and "投票" in r["title"]
     and "体育馆" in r["location"]),

    ("讲座通知",
     "讲座通知：明天14:00-16:30 在图书馆报告厅举行人工智能前沿讲座，请同学们准时参加",
     lambda r: r["start_at"] == datetime(2026, 11, 9, 14, 0)
     and r["end_at"] == datetime(2026, 11, 9, 16, 30)
     and "讲座" in r["title"]),

    ("体测安排（带日期）",
     "体测安排\n12月20日 8:00开始，17:00结束，地点：东校区体育场，记得带学生证",
     lambda r: r["start_at"] == datetime(2026, 12, 20, 8, 0)
     and r["end_at"] == datetime(2026, 12, 20, 17, 0)
     and "体测" in r["title"]
     and "体育场" in r["location"]),

    ("班会通知（下午场）",
     "各位同学，下周三下午2点开始到4点结束在教学楼A305开班会，讨论选课事宜",
     lambda r: r["start_at"] == datetime(2026, 11, 11, 14, 0)
     and r["end_at"] == datetime(2026, 11, 11, 16, 0)),

    ("只有截止时间",
     "四六级报名提醒：本周五17:00截止，错过不能再报",
     lambda r: r["end_at"] == datetime(2026, 11, 13, 17, 0)),

    ("微信·高数章测（跨天时间窗，真实样例）",
     "@所有人 各位同学，本周五18:00-周日23:59进行第二章的章测，25个题（总100分，考试时间60分钟，"
     "题库刷题路径：学习通-我的课程-2026级高等数学（1）过程考核），如果考得不满意，可以重考，"
     "考试最多可以进行三次，取最高分计入平时成绩。考试设置了切屏记录，请大家考试过程中不要离开考试界面。"
     "请大家合理安排时间，预留出考试时间，最好设置闹钟提醒，以免错过考试！",
     lambda r: r["time_status"] == "exact"
     and r["start_at"] == datetime(2026, 11, 13, 18, 0)
     and r["end_at"] == datetime(2026, 11, 15, 23, 59)
     and "章测" in r["title"]
     and "60分钟" in r["note"]),

    ("创客大赛（只有日期+时段，无时刻）",
     "定于11月21日下午，是咱们的创客大赛，要求大一全体同学到星光剧场参加，"
     "无故不可请假，大家认真看看大二同学们的作品，方便明年参赛",
     lambda r: r["time_status"] == "fuzzy"
     and r["start_at"] == datetime(2026, 11, 21, 13, 0)
     and r["end_at"] == datetime(2026, 11, 21, 18, 0)
     and r["title"] == "创客大赛"
     and "星光剧场" in r["location"]),

    ("高数小讲堂（只有开始时间，地点待定）",
     "【高数小讲堂】\n梳理知识脉络，破解学习难点\n为帮助同学们掌握高数知识、解决学习疑难，"
     "学院特举办高数小讲堂，围绕重点知识点进行讲解与答疑。\n"
     "• 时间：11月11日 18:30\n• 地点：待定（具体地点后续将在高数小讲堂报名群内通知）\n"
     "• 参与方式：扫描下方二维码加入报名群，参加本次活动可获得1分二课积分。",
     lambda r: r["time_status"] == "start_only"
     and r["start_at"] == datetime(2026, 11, 11, 18, 30)
     and "小讲堂" in r["title"]
     and not r["location"]),

    ("学长讲课（中文数字时刻+字母教室，真实样例）",
     "11月14日wla406上午九点开始 预计两节课结束 来不了的同学让其他同学帮忙听听吧 "
     "讲课的也是学长 人家周中也有课 大家的课表也比较分散 不太能周中讲 都互相理解吧",
     lambda r: r["time_status"] == "start_only"
     and r["start_at"] == datetime(2026, 11, 14, 9, 0)
     and r["location"].lower() == "wla406"
     and "节课" in r["note"]),

    ("完全没时间的通知（待定）",
     "各位同学，学校下周将组织一次企业参观活动，具体时间地点另行通知，有意向的同学先在群里接龙",
     lambda r: r["time_status"] == "todo" and r["title"]),

    ("路由回归：短句不是通知",
     "明天下午三点半开班会，两个小时",
     None),  # 只测 looks_like_notice == False
]


def main():
    ok = 0
    for name, text, check in CASES:
        if check is None:
            is_notice = looks_like_notice(text)
            good = not is_notice
            print(("PASS" if good else "FAIL"), name, "(短句→走速记解析)")
        else:
            r = parse_notice(text, NOW)
            good = bool(r) and bool(check(r))
            print(("PASS" if good else "FAIL"), name)
            if r:
                print(f"   -> {r['title']} | {r['start_at']:%m-%d %H:%M} ~ {r['end_at']:%m-%d %H:%M}"
                      f" | {r['time_status']} | 地点:{r['location'] or '-'} | 备注:{r['note'] or '-'}")
            else:
                print("   -> 解析返回 None")
        ok += good
    print(f"\n{ok}/{len(CASES)} 通过")
    sys.exit(0 if ok == len(CASES) else 1)


if __name__ == "__main__":
    main()
