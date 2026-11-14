# -*- coding: utf-8 -*-
"""群通知长文本 → 结构化日程（无 LLM，纯规则）。

微信复制出的班级/课程群通知：多行、带序号、时间地点散落、夹大量与
日程无关的注意事项。和一句话速记（times.py）是两个问题域：
  - times.py：短句，时间即主体，全句扫描
  - notice.py：长文，先找「时间句 / 地点句 / 主题句」再重组

提取目标：{title, note, location, start_at, end_at}
置信度策略：带「开始/结束」标记词的时段 > 连接符时段（8:00-16:00）>
单个时刻；拿到高置信时段后，其余裸时间 token 一律视为干扰丢弃
（"班长8点前领票""8点进场"这类指引不再污染主时间）。
"""
import re
from datetime import datetime, timedelta

# ---------- 预处理 ----------

_AT = re.compile(r"@[^\s，,。:：\n]+")                     # @所有人 @张三
_BRACKET = re.compile(r"（[^）]{2,}）|\([^)]{2,}\)")        # 括号补充说明整体摘除
_ORD = re.compile(r"^\s*(?:[0-9]{1,2}|[①-⑳]{1}|[一二三四五六七八九十])[.、,，)）]\s*")
_CLAUSE_SPLIT = re.compile(r"[。；;\n]+")
_SUB_SPLIT = re.compile(r"[，,:：]")

# ---------- 日期（按优先级，同级取最先出现） ----------

_WEEKDAY_IDX = {"一": 0, "二": 1, "三": 2, "四": 3, "五": 4, "六": 5, "日": 6, "天": 6}


def _d_offset(days):
    return lambda m, now: now.date() + timedelta(days=days)


def _d_next_weekday(m, now):
    """下周X = 下周一 + 偏移。下周一本体 = now + (7 - weekday)。"""
    idx = _WEEKDAY_IDX[m.group(1)]
    next_monday = now.date() + timedelta(days=7 - now.weekday())
    return next_monday + timedelta(days=idx)


def _d_this_weekday(m, now):
    """周X = 从今天起最近的未来周X（含今天）。"""
    idx = _WEEKDAY_IDX[m.group(1)]
    return now.date() + timedelta(days=(idx - now.weekday()) % 7)


def _d_month_day(m, now):
    try:
        return datetime(now.year, int(m.group(1)), int(m.group(2))).date()
    except ValueError:
        return now.date()


_DATE_RES = [
    # 大后天 > 后天 > 明天 > 今天（长词在前防部分匹配）
    (re.compile(r"(大后天|后天|明天|今天|今日)"), _d_offset(None)),  # 占位，下一行真正赋值
    (re.compile(r"下(?:周|星期|礼拜)([一二三四五六日天])"), _d_next_weekday),
    # 裸"下周"不认（"下周会返回"是干扰）；"本/这周X"视同"周X"
    (re.compile(r"(?:本|这)?(?:周|星期|礼拜)([一二三四五六日天])"), _d_this_weekday),
    (re.compile(r"(\d{1,2})月(\d{1,2})[日号]?"), _d_month_day),
]


def _d_relword(m, now):
    return now.date() + timedelta(
        days={"大后天": 3, "后天": 2, "明天": 1, "今天": 0, "今日": 0}[m.group(1)])


def _d_evening(m, now):
    """今晚/明晚/后晚/大后晚 = 当天/明天/后天/大后天的晚上，日期按天偏移。"""
    return now.date() + timedelta(
        days={"今晚": 0, "明晚": 1, "后晚": 2, "大后晚": 3}[m.group(1)])


_DATE_RES[0] = (re.compile(r"(大后晚|后晚|明晚|今晚)"), _d_evening)
_DATE_RES.insert(1, (re.compile(r"(大后天|后天|明天|今天|今日)"), _d_relword))


def _find_date(s, now):
    """返回 (date, matched_text) 或 (None, '')。取优先级最高且最先出现的日期词。"""
    best = None  # (pattern_idx, pos, date, text)
    for idx, (pat, fn) in enumerate(_DATE_RES):
        m = pat.search(s)
        if not m:
            continue
        cand = (idx, m.start())
        if best is None or cand < (best[0], best[1]):
            best = (idx, m.start(), fn(m, now), m.group(0))
    return (best[2], best[3]) if best else (None, "")


# ---------- 时刻与时段 ----------

_CN_NUM = {"一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6,
           "七": 7, "八": 8, "九": 9, "十": 10, "十一": 11, "十二": 12}
# 时刻的小时：阿拉伯或中文数字（"上午九点开始"），"两节课"不中招（要求后面跟 点/时/: ）
_H = r"(?:[0-2]?\d|[一二两三四五六七八九十]{1,2})"


def _to_hour(tok):
    if tok is None:
        return None
    if tok.isdigit():
        return int(tok)
    return _CN_NUM.get(tok)


def _t(name):
    return (rf"(?P<{name}_h>{_H})\s*[:：点时]\s*(?P<{name}_m>[0-5]?\d|半)?")


# 8:00开始 / 8点集合 / 14:00开门 —— 高置信开始
_T_START_M = re.compile(_t("s") + r"\s*(?:开始|起|开门|开放|集合|签到)")
# 16:00结束 / 17:00截止 / 21:00散场 —— 高置信结束
_T_END_M = re.compile(_t("e") + r"\s*(?:结束|截止|关门|散场|离场)")
# 8:00-16:00 / 8点到16点 / 14：30—17：00 —— 连接符时段
_T_RANGE = re.compile(
    _t("a") + r"\s*(?:开始|起|开门)?\s*[—–~～至到\-]\s*[—–~～至到\-]?\s*" + _t("b") + r"\s*(?:结束|截止|关门)?")
# 跨天时段："18:00-周日23:59" / "周五8点至周日22点" —— 连接符中间夹日期词
_CROSS_D = r"(?:大后天|后天|明天|今天|今日|(?:本|这|下)?(?:周|星期|礼拜)[一二三四五六日天])"
_T_RANGE_DAYS = re.compile(
    _t("a") + r"\s*(?:开始|起|开门)?\s*[—–~～至到\-]\s*[—–~～至到\-]?\s*"
    + f"(?P<mid_d>{_CROSS_D})" + r"\s*" + _t("b") + r"\s*(?:结束|截止|关门)?")
# 单个时刻（低置信兜底）：8:00 / 8点 / 上午九点 / 下午两点半
_T_ONE = re.compile(rf"(?P<o_h>{_H})\s*[:：点时]\s*(?P<o_m>[0-5]?\d|半)?")

_PM_WORDS = "凌晨|清晨|早上|早晨|上午|中午|下午|午后|傍晚|晚上|夜里"
# 只说时段没说几点 → 该时段的默认区间（分钟），time_status 标 fuzzy
PERIOD_RANGE = {
    "凌晨": (0, 0, 6, 0), "清晨": (6, 0, 8, 0), "早上": (6, 0, 9, 0), "早晨": (6, 0, 9, 0),
    "上午": (8, 0, 12, 0), "中午": (11, 0, 14, 0), "午后": (13, 0, 17, 0),
    "下午": (13, 0, 18, 0), "傍晚": (17, 0, 19, 0), "晚上": (18, 0, 23, 0), "夜里": (20, 0, 23, 0),
}
# 时长短语 → note（"考试时间60分钟" / "预计两节课结束"）
_DURATION = re.compile(r"(?:时长|时间|用时|大约|约)\D{0,2}(\d{1,3})\s*分钟|(\d{1,3})\s*分钟")
_DUR_SLOTS = re.compile(r"([一二两三四五六七八九\d])\s*节课")
# 字母数字教室：wla406 / WLA-406 / N406 / j3-301
_LOC_ALNUM = re.compile(r"(?<![A-Za-z0-9])[A-Za-z]{1,4}-?\d{1,4}(?:-\d{1,4})?(?![A-Za-z0-9])")
_CN_NUM = {"一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10, "十一": 11, "十二": 12}
_PM_SET = {"中午", "下午", "午后", "傍晚", "晚上", "夜里"}
# "早一点/晚一点/再有点"里的"X点"不是钟点：前一字命中即弃
_VAGUE_PRE = "多少早晚再稍略挺太更挺"


def _hm(m, hname, mname, s):
    """命名组 → (hour, minute)，带时段词修正（下午8点 → 20）。"""
    h = _to_hour(m.group(hname))
    if h is None:
        h = 9
    mm = m.group(mname)
    minute = 30 if mm == "半" else (int(mm) if mm and mm.isdigit() else 0)
    pre = s[max(0, m.start() - 3):m.start()]
    pm = re.search(rf"({_PM_WORDS})\s*$", pre)
    if pm and pm.group(1) in _PM_SET and h < 12:
        h += 12
    return h, minute


def _skip_vague(s, m):
    pre = s[max(0, m.start() - 1):m.start()]
    return bool(pre) and pre in _VAGUE_PRE


def _fix_end_pm(start_hm, end_hm):
    """「下午2点开始到4点结束」：4点前面没时段词，借用开始的时段 → 16 点。"""
    if end_hm and end_hm[0] < start_hm[0] and end_hm[0] < 12:
        return (end_hm[0] + 12, end_hm[1])
    return end_hm


def _find_timespan(s):
    """返回 (start_hm, end_hm, confidence, cross_day_word)。
    confidence: 2=标记式 1=连接式/跨天 0=单时刻；-1=无时刻线索。
    cross_day_word：跨天时段里夹的日期词（"18:00-周日23:59"的"周日"）。"""
    # 1) 标记式：第一个 X开始 + 第一个 Y结束（拿到高置信后裸时间全当干扰）
    ms, me = _T_START_M.search(s), _T_END_M.search(s)
    if ms:
        sh, sm = _hm(ms, "s_h", "s_m", s)
        endhm = None
        if me:
            eh, em = _hm(me, "e_h", "e_m", s)
            endhm = _fix_end_pm((sh, sm), (eh, em))
        return (sh, sm), endhm, 2, None
    if me:  # 只有"16:00结束"没写开始 → 开始默认 8 点（活动通知惯例）
        eh, em = _hm(me, "e_h", "e_m", s)
        return (8, 0), (eh, em), 1, None
    # 2) 跨天时段："18:00-周日23:59"
    md = _T_RANGE_DAYS.search(s)
    if md:
        a = _hm(md, "a_h", "a_m", s)
        b = _hm(md, "b_h", "b_m", s)
        return a, b, 1, md.group("mid_d")
    # 3) 连接式：8:00-16:00 / 8点到16点 / 14：30—17：00
    mr = _T_RANGE.search(s)
    if mr:
        a = _hm(mr, "a_h", "a_m", s)
        b = _hm(mr, "b_h", "b_m", s)
        b = _fix_end_pm(a, b)
        return a, b, 1, None  # b<=a 的跨午夜写法由上层 +1h 兜底
    # 4) 单时刻兜底
    for mo in _T_ONE.finditer(s):
        if _skip_vague(s, mo):
            continue
        hh = _to_hour(mo.group("o_h"))
        if hh is None:
            continue
        m = mo.group("o_m")
        minute = 30 if m == "半" else (int(m) if m and m.isdigit() else 0)
        return (hh, minute), None, 0, None
    return None, None, -1, None


# ---------- 标题 ----------

_TITLE_SUFFIX = ("投票|选举|考试|章测|测验|测试|考察|月考|模拟考|统考|补考|缓考|体检|体测|班会|开会|"
                 "会议|讲座|报告|答辩|培训|比赛|竞赛|大赛|讲堂|运动会|招聘会|宣讲会|晚会|演出|展览|"
                 "报名|打卡|实验|实习|采集|普查|测评|四六级|期末|选课|评教|缴费|注册|报到|返校|放假|集合")
# "进行人大代表的投票"→人大代表+投票；"开班会"→(空)+班会；"是咱们的创客大赛"→创客+大赛
_TITLE_VP = re.compile(rf"(?:进行|开展|举行|举办|组织|召开|参加|是|开)([^，。,;；:：\n]{{0,14}}?)的?\s*({_TITLE_SUFFIX})")
_TITLE_MOD_NOISE = re.compile(r"咱们|我们|咱|你|我|各位|全体|同学|大家的?|一个|这个|那个")
_SALUT = re.compile(r"^(各位同学|同学们|全体同学|同学们|各位|大家|所有人|亲们)")


def _find_title(s):
    m = _TITLE_VP.search(s)
    if m:
        mod = _TITLE_MOD_NOISE.sub("", m.group(1))
        mod = re.sub(r"[的即将了将有要把]", "", mod).strip()
        core = m.group(2)
        return (mod + core)[:16] if mod else core
    # 兜底1：全文第一个中心词
    m = re.search(_TITLE_SUFFIX, s)
    if m:
        return m.group(0)
    # 兜底2：第一子句去称呼/口水词后取前 12 字（纯时间/数字串跳过，宁缺毋滥）
    first = s.strip().split("\n")[0]
    for seg in _SUB_SPLIT.split(first):
        seg = _SALUT.sub("", seg).strip()
        seg = re.sub(r"通知|注意|重要|@|[:：].*$", "", seg).strip()
        seg = re.sub(r"^(请|麻烦|大家|记得|明天|后天|今天|本周|下周)[\s的]*", "", seg)
        if len(seg) >= 2 and not re.search(r"\d", seg):
            return seg[:12]
    return "群通知事项"


# ---------- 地点 ----------

_LOC_STRONG = re.compile(r"校区|体育馆|体育场|运动场|图书馆|教学楼|实验楼|实训楼|食堂|礼堂|会堂|"
                         r"报告厅|会议室|教室|广场|操场|活动中心|游泳馆|机房|大厅|门厅|剧场|剧院|音乐厅")
_LOC_MID = re.compile(r"[馆楼厅室]|中心|基地")
_LOC_PATH = re.compile(r"门|通道|入口|窗口|站台|号口|[东西南北]门")

# 主地点窗口展开的左右边界：从关键词向两侧扩，直到撞上标点/介词/动词
_LOC_STOP_R = re.compile(r"[\s，,。、;；:：（）()\-—【】]|举行|举办|开展|进行|召开|参加|"
                         r"记得|开始|结束|开门|关门|进入|找|开|请")
_LOC_STOP_L = re.compile(r"[\s，,。、;；:：（）()\-—【】]|就在|在|于|从|去|到|和|与|及|的|找|至")

# 路径细节 token：不能混进叙述性句子
_PATH_TOKEN_OK = re.compile(r"^(?:北|南|东|西|左|右|前|后|中间?|\d+|[一二三四五六七八九十]+|左侧|右侧)?"
                            r"[\w一-鿿]{0,6}?(?:[东西南北]门|通道|入口|窗口|站台|号口)$")
_PATH_TOKEN_BAD = re.compile(r"肯定|情况|存在|大家|同学|投票|时间|地点|通知")


def _loc_window(s, pat):
    """找 pat 的第一个匹配，向两侧展开到边界字符 → 地点短语。"""
    m = pat.search(s)
    if not m:
        return ""
    lo = max((lm.end() for lm in _LOC_STOP_L.finditer(s, 0, m.start() + 1)
              if lm.end() <= m.start()), default=0)
    rm = _LOC_STOP_R.search(s, m.end())
    hi = rm.start() if rm else len(s)
    out = s[lo:hi].strip(" 的在于从去到至和与及")
    return out[:30]


def _find_location(s):
    """返回 (主地点, 路径细节)。
    主地点：强关键词（校区/体育馆/教学楼…）优先，弱关键词兜底，
    都没有时认字母数字教室（wla406 / WLA-406）；窗口展开避免整句粘连。"""
    main = _loc_window(s, _LOC_STRONG)
    if not main:
        main = _loc_window(s, _LOC_MID)
    if not main:
        m = _LOC_ALNUM.search(s)
        if m:
            main = m.group(0)
    path = []
    for t in re.split(r"[\s，,。、;；:：（）()\-—]+", s):
        t = re.sub(r"^(?:找到|沿着?|经过|进入|从|由)", "", t).strip()
        if 2 <= len(t) <= 14 and _PATH_TOKEN_OK.match(t) and not _PATH_TOKEN_BAD.search(t) and t != main:
            path.append(t)
    return main[:30], " ".join(path[:4])[:60]


# ---------- 主流程 ----------

_CROSS_WEEKDAY = re.compile(r"^(?:本|这)?(?:周|星期|礼拜)([一二三四五六日天])$")
_CROSS_NEXT_WEEK = re.compile(r"^下(?:周|星期|礼拜)([一二三四五六日天])$")


def _cross_date(word: str, start_date, now) -> "date":
    """跨天时段里第二个日期词："周五18:00-周日23:59" 的周日是开始日那一周的周日，
    必须相对 start_date 推算——今天若是周日，独立的"最近周日"会算成今天（倒挂）。"""
    m = _CROSS_WEEKDAY.match(word)
    if m:
        idx = _WEEKDAY_IDX[m.group(1)]
        return start_date + timedelta(days=(idx - start_date.weekday()) % 7)
    m = _CROSS_NEXT_WEEK.match(word)
    if m:
        idx = _WEEKDAY_IDX[m.group(1)]
        next_monday = now.date() + timedelta(days=7 - now.weekday())
        return next_monday + timedelta(days=idx)
    d, _ = _find_date(word, now)
    return d or start_date


def parse_notice(text: str, now: datetime | None = None) -> dict | None:
    """群通知 → {title, note, location, start_at, end_at, time_status}。

    time_status 四档（前端据此显式提示，避免"假准点"）：
      exact       起止都明确
      start_only  只有开始时间，结束是默认 +1h 估的
      fuzzy       只有日期+时段（"11月21日下午"），时刻用时段默认区间
      todo        完全没时间线索，占位当天 9-10 点
    文本太短（不像通知）返回 None，调用方降级到速记解析。"""
    now = now or datetime.now()
    raw = (text or "").strip()  # 时长等提取用原始文本（括号里的"考试时间60分钟"别丢）
    s = _AT.sub(" ", raw)
    s = _BRACKET.sub(" ", s)
    # 序号行首变分隔，避免"1.投票"的"1."被当数字
    s = "\n".join(_ORD.sub(" ", ln) for ln in s.splitlines())
    if len(s.strip()) < 8:
        return None

    date_, _dtext = _find_date(s, now)
    start_hm, end_hm, conf, cross_day = _find_timespan(s)

    if start_hm is not None:
        sh, sm = start_hm
        if end_hm:
            eh, em = end_hm
            status = "exact"
        else:
            eh, em = sh + 1, sm  # 仅开始时间 → 结束默认 +1h，标记 start_only
            status = "start_only"
    else:
        # 没有任何时刻 → 时段词（"下午"）给默认区间；只日期给全天默认；都没有占位
        pm = re.search(_PM_WORDS, s)
        if pm:
            sh, sm, eh, em = PERIOD_RANGE[pm.group(0)]
            status = "fuzzy"
        elif date_:
            sh, sm, eh, em = 9, 0, 18, 0
            status = "fuzzy"
        else:
            sh, sm, eh, em = 9, 0, 10, 0
            date_ = now.date()
            status = "todo"

    start = now.replace(year=date_.year, month=date_.month, day=date_.day,
                        hour=min(sh, 23), minute=sm, second=0, microsecond=0)
    if cross_day:
        # 跨天时段："周五18:00-周日23:59" → 结束日 = 中间日期词（相对开始日推算）
        end_date = _cross_date(cross_day, start.date(), now)
        end = now.replace(year=end_date.year, month=end_date.month, day=end_date.day,
                          hour=min(eh, 23), minute=em, second=0, microsecond=0)
    else:
        end = start.replace(hour=min(eh, 23), minute=em)
    if end <= start:
        end = start + timedelta(hours=1)

    title = _find_title(s)
    location, path = _find_location(s)
    note = path
    dm = _DURATION.search(raw)
    if dm:
        mins = int(dm.group(1) or dm.group(2))
        if 10 <= mins <= 600:
            note = f"时长约{mins}分钟 {note}".strip()
    dm2 = _DUR_SLOTS.search(raw)
    if dm2 and "节课" not in (note or ""):
        n = _to_hour(dm2.group(1)) or 2
        note = f"约{n}节课 {note}".strip()
    return {"title": title, "note": note, "location": location,
            "start_at": start, "end_at": end, "time_status": status}


def looks_like_notice(text: str) -> bool:
    """判定走群通知解析还是一句话速记解析。
    通知特征：长文 / 多行 / 序号 / 多句 / 公文用语——速记短句全都不具备。
    宁多勿少：notice 解析不了会自动降级速记，反之不会。"""
    t = (text or "").strip()
    if len(t) > 30 or "\n" in t:
        return True
    if re.search(r"^\s*[0-9]{1,2}[.、,，)）]", t, re.M):
        return True
    if len(re.split(r"[。；;]", t)) > 2:
        return True
    if re.search(r"通知|定于|将于|拟于|举办|开展|组织|安排|请(?:大家|同学|各位)|各位同学|全体同学|要求", t):
        return True
    return False
