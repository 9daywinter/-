"""中文模糊时间解析：语音速记的兜底与规整（没有 LLM Key 也能跑）。

支持：
- 日期：今天/明天/后天/大后天、(下/本)周X/星期X/礼拜X、X月X日
- 时刻：上午/下午/晚上/凌晨… + 3点 / 三点半 / 15:30 / 8:05，也认裸数字（"明天11"）
- 结束：「到5点」「开到明天1点」「到24点/到0点」，「两个小时」「一个半小时」90分钟」，默认 +1 小时

识别策略（v2，2026-11-08）：全句扫描所有时间 token → 自动分主/次。
带「到/至」的直接改名是结束；第一个裸时间戳是开始。
这样「明天11，叫我，有会到24点」一次对上：开始 11:00、结束 23:59。
"""
import re
from datetime import date, datetime, timedelta

CN_NUM = {"零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5,
          "六": 6, "七": 7, "八": 8, "九": 9, "十": 10, "十一": 11, "十二": 12}
WEEKDAY = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "日": 7, "天": 7}
PERIOD_DEFAULT = {  # 只说了时段没说几点 → 默认时刻
    "凌晨": (1, 0), "清晨": (6, 0), "早上": (8, 0), "早晨": (8, 0),
    "上午": (9, 0), "中午": (12, 0), "午后": (14, 0), "下午": (14, 0),
    "傍晚": (18, 0), "晚上": (19, 0), "夜里": (21, 0),
}
PM_WORDS = "凌晨|清晨|早上|早晨|上午|中午|下午|午后|傍晚|晚上|夜里"
NUM = r"([0-9]{1,2}|[一二两三四五六七八九十]{1,2})"

# 时间 token：数字 + （":分钟" 或 "点/时 可选分钟"）；前半不带捕获组，防"早8"吞进组1
# 时段词不进正则（让它把匹配起点前移），靠前置字符窗口检测（"下午两点" 的"两点"）
CAND_RE = re.compile(
    rf"{NUM}"
    rf"(?:\s*:\s*([0-9]{{1,2}})|\s*[点时]\s*([0-9]{{1,2}}|半|一刻|三刻)?)?"
)
# 裸数字不能跟这些单位，否则是月份/数量而不是钟点
BARE_BAN_NEXT = "月日号个分节天周年"

FILLER = "^(请帮我|帮我|麻烦|记得|提醒我|叫我|给我|我要|我|要去|记一下|记一笔|安排一下|安排|订|预约|设置)"
DURATIONS = (  # (pattern, 分钟数 or 函数)
    (re.compile(r"([0-9]{1,2}|[一二两三四五])\s*个\s*半\s*小时"), lambda g: _to_int(g) * 60 + 30),
    (re.compile(r"半\s*个?\s*小时"), lambda g: 30),
    (re.compile(r"([0-9]{1,2}|[一二两三四五])\s*个?\s*小时"), lambda g: _to_int(g) * 60),
    (re.compile(r"(\d{1,3})\s*分钟"), lambda g: int(g)),
)


def _to_int(tok):
    if tok is None:
        return None
    if tok.isdigit():
        return int(tok)
    return CN_NUM.get(tok)


def _minute(tok):
    if not tok:
        return 0
    if tok == "半":
        return 30
    if tok == "一刻":
        return 15
    if tok == "三刻":
        return 45
    return int(tok) if tok.isdigit() and int(tok) < 60 else 0


def _apply_period(hour, period):
    if period in ("中午", "下午", "午后", "傍晚", "晚上", "夜里") and hour < 12:
        return hour + 12
    return hour


def _anchor_date(s, now):
    """返回 (date, has_explicit_date, spans)"""
    spans = []
    m = re.search(r"大后天|后天|明天|今天|今日", s)
    if m:
        off = {"大后天": 3, "后天": 2, "明天": 1, "今天": 0, "今日": 0}[m.group(0)]
        spans.append(m.span())
        return now.date() + timedelta(days=off), True, spans
    # (?<!一)：歇后"一下周三"的"一下"是副词，别拆成"一 + 下周三"
    m = re.search(r"(?<!一)下(?:周|星期|礼拜)([一二三四五六日天])", s)
    if m:
        # 下周三 = 下周一 + 偏移，不从"本周X"顺延
        t = WEEKDAY[m.group(1)]
        next_monday = now.date() + timedelta(days=7 - now.weekday())
        spans.append(m.span())
        return next_monday + timedelta(days=t - 1), True, spans
    m = re.search(r"(?<!一)下(?:周|星期|礼拜)(?![一二三四五六日天])", s)
    if m:
        # 裸"下周"没指明哪天 → 下周一
        spans.append(m.span())
        return now.date() + timedelta(days=7 - now.weekday()), True, spans
    m = re.search(r"(?:周|星期|礼拜)[一二三四五六日天]", s)
    if m:
        # 匹配到的必须是 周X/星期X/礼拜X（"周会/周边/粥"这类词里的"周"不算）
        t = WEEKDAY[m.group(0)[-1]]
        spans.append(m.span())
        return now.date() + timedelta(days=(t - now.isoweekday()) % 7), True, spans
    m = re.search(r"(\d{1,2})月(\d{1,2})[日号]", s)
    if m:
        try:
            d = date(now.year, int(m.group(1)), int(m.group(2)))
            spans.append(m.span())
            return d, True, spans
        except ValueError:
            pass
    return now.date(), False, spans


def _scan_tokens(s):
    """全句扫时间 token。返回 [{end, cut, period, hour, minute}]。

    规则：
    - 带"点/时/: "必认；裸数字只认阿拉伯数字（绝不做"一下"），且冒月/日/个/分/节/天等单位
    - 数字前 8 字内出现"到/至" → 结束时间；「到明天1点」的日期词单独记
    - "第11/几11"不是钟点
    """
    out = []
    for m in CAND_RE.finditer(s):
        tok = m.group(1)
        full = m.group(0)
        nxt = s[m.end():m.end() + 1]
        prv = s[m.start() - 1:m.start()]
        has_clock = bool(re.search(r"[点时:：]", full))  # 带"点/时/:"必是钟点
        if not has_clock and (nxt in BARE_BAN_NEXT or not tok.isdigit()):
            # 裸数且后跟单位/是中文数字 → 不是钟点（"周四"的"四"）
            continue
        if prv and prv in "第几":
            continue  # 第11/几11
        hour = _to_int(tok)
        if hour is None:
            continue
        if hour == 0 and not has_clock:
            continue  # 裸"0"不是时刻（带"点"的"0点"认）
        # 时段词：取 token 前面 3 字内的时段词（"晚上11" → 晚上，容忍空格"下午 2点"）
        pre = s[max(0, m.start() - 3):m.start()]
        p2 = re.search(rf"({PM_WORDS})\s*$", pre)
        period = p2.group(1) if p2 else None
        minute = _minute(m.group(2) or m.group(3))
        # 结束标记：数字前 8 字内以"到/至"收尾（可有日期词，"开到明天1点"）
        pre8 = s[max(0, m.start() - 8):m.start()]
        em = re.search(r"[到至]\s*(?:大后天|后天|明天|今天|今日)?\s*$", pre8)
        base8 = m.start() - len(pre8)
        if em:
            region = pre8[em.start():em.end()]
            dwm = re.search(r"(大后天|后天|明天|今天|今日)", region)
            dw = dwm.group(1) if dwm else None
            cut_lo = base8 + em.start()  # 从"到"开始切
            # "开到/完/做…到明天一点"的前置动词也一起切掉，标题只留事件
            vb = re.search(r"(?:开|完|做|写|赶|上|聊|开完)\s*$", pre8[:em.start()])
            if vb:
                cut_lo = min(cut_lo, base8 + vb.start())
        else:
            dw = None
            cut_lo = m.start()
        # 时段词（上午/下午/晚上…）随 token 一起从标题里切掉，只留时间值
        if period and p2:
            cut_lo = min(cut_lo, max(0, m.start() - 3) + p2.start(1))
        out.append({"end": em is not None, "dw": dw, "cut": (cut_lo, m.end()),
                    "period": period, "hour": hour, "minute": minute})
    return out


def resolve_event_time(text, now=None):
    """一句话 → {title, start_at, end_at}；解析不出的部分用合理默认值。"""
    now = now or datetime.now()
    s = (text or "").strip()
    # 口语缩略先展开成完整日期词，_anchor_date 才认得（否则"今早"会被当成没说日期）
    s = (s.replace("今晚", "今天晚上").replace("明晚", "明天晚上")
          .replace("今早", "今天早上").replace("明早", "明天早上"))

    date_, has_date, spans = _anchor_date(s, now)
    toks = _scan_tokens(s)
    starts = [t for t in toks if not t["end"]]
    ends = [t for t in toks if t["end"]]
    sc = starts[0] if starts else None
    # 结束：第一个"到X点"；"到0点/到24点"是午夜标记，若另有真正的"到X点"优先用后者
    ec = next((t for t in ends if t["hour"] not in (0, 24)), None)
    if ec is None:
        ec = next((t for t in ends), None)
    if sc and sc["hour"] in (0, 24):  # 起始"0点"按 24:00 算，落到当天深夜
        sc["hour"] = 23
        sc["minute"] = 59

    # ---- 开始时间 ----
    if sc:
        period, hour, minute = sc["period"], sc["hour"], sc["minute"]
    else:
        period = None
        pm = re.search(PM_WORDS, s)
        if pm:
            period = pm.group(0)
            spans.append(pm.span())
        hour, minute = PERIOD_DEFAULT.get(period, (9, 0))
    hour = _apply_period(hour, period) if hour is not None else hour
    if hour is not None and hour > 23:
        hour, minute = 23, 59
    start = now.replace(year=date_.year, month=date_.month, day=date_.day,
                        hour=hour if hour is not None else 9,
                        minute=minute or 0, second=0, microsecond=0)
    # 没提日期就一律今天（哪怕时刻已过也不再顺延到明天）
    # 裸钟点（不带时段词、不带日期）在 11-21 点之间有歧义：
    # "晚上21:30说十一点半睡觉" 应是 23:30 而不是中午 11:30 → 取"离现在最近的未来"
    if not has_date and period is None and hour not in (None, 0, 12, 23, 24):
        alt = start + timedelta(hours=12 if hour < 12 else -12)
        if alt > now and (start <= now or alt - now < max(start - now, timedelta(0))):
            start = alt

    # ---- 结束时间 ----
    end = None
    for t in toks:  # 所有时间 token 都要从标题里抠掉
        spans.append(t["cut"])
    if ec:
        e_h, e_m = ec["hour"], ec["minute"]
        if ec["dw"]:
            # “开到明天1点”：结束带日期词，只按自带时段换算，再平移天数
            e_h = _apply_period(e_h, ec["period"])
            if e_h in (0, 24):
                end = start.replace(hour=23, minute=59)
                end += timedelta(days={"大后天": 3, "后天": 2, "明天": 1, "今天": 0, "今日": 0}[ec["dw"]])
            else:
                end = start.replace(hour=min(e_h, 23), minute=e_m)
                end += timedelta(days={"大后天": 3, "后天": 2, "明天": 1, "今天": 0, "今日": 0}[ec["dw"]])
            if end <= start:
                end += timedelta(days=1)
        else:
            if e_h in (0, 24):
                # “有会到24点 / 到0点” → 当天深夜 23:59
                d_h, e_m = 23, 59
                end = start.replace(hour=d_h, minute=e_m)
            else:
                # “到5点”：没带日期，借用开始时间的时段（晚上3点到5点 → 17点）
                e_h = _apply_period(_apply_period(e_h, ec["period"]), sc["period"] if sc else None)
                end = start.replace(hour=min(e_h, 23), minute=e_m)
                if end <= start:
                    end += timedelta(hours=12)  # “11点到1点”跨午夜 / “3点到5点”晚上场景的兜底
            if end == start.replace(hour=23, minute=59) and start.hour != 23:
                pass  # 起始就在 23:59 的极端场景不特殊处理
    if end is None:
        # 时长短语："一个半小时" 要排在 "半小时" 前，否则"一个半小时"被 30 分钟分支抢先
        for pat, mins in DURATIONS:
            dm = pat.search(s)
            if dm:
                g = dm.group(1) if dm.lastindex else "1"
                spans.append(dm.span())
                end = start + timedelta(minutes=mins(g))
                break
        else:
            dm_all = re.search(r"全天|一整天", s)
            if dm_all:  # “周六全天志愿者” → 8:00~22:00
                spans.append(dm_all.span())
                start = start.replace(hour=8, minute=0)
                end = start.replace(hour=22)
    if end is None or end <= start:
        end = start + timedelta(hours=1)

    # ---- 标题：去掉时间片段和口水词 ----
    title = s
    for a, b in sorted(spans, reverse=True):
        title = title[:a] + " " + title[b:]
    title = re.sub(FILLER, "", title.strip())
    # 语气/揣测词、提醒类动词短语不该留在标题里
    title = re.sub(r"(?:可能|大概|也许|应该|估计|好像|貌似)(?:要|得)?", "", title)
    title = re.sub(r"记一下|记一笔|记一个|记个|打个|发个", "", title)
    title = re.sub(r"叫我|我叫|咱俩|我们", "", title)
    title = re.sub(r"\s*[，,。.·!！~～到至-]\s*", " ", title)
    title = re.sub(r"\s+", " ", title).strip()
    title = re.sub(r"^(?:要|去|跟|和)\s+", "", title)          # 删时间词后残留的句首动词
    title = re.sub(r"(?:吧|呗|呢|啊|呀|哈|嘛|哦|噢|啦|喽|了|的|要|去)+$", "", title)
    title = re.sub(r"\s+", " ", title).strip()
    title = re.sub(r"(我的|我)$", "", title)
    return {"title": title[:30] or "临时安排", "start_at": start, "end_at": end}
