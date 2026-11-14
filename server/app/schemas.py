from datetime import date, datetime

from pydantic import BaseModel, Field


# ---------- 学期 ----------

class TermIn(BaseModel):
    name: str = "本学期"
    start_monday: date
    total_weeks: int = Field(default=20, ge=1, le=30)


class TermOut(TermIn):
    id: int
    current_week: int

    class Config:
        from_attributes = True


# ---------- 课程 ----------

class CourseIn(BaseModel):
    name: str
    teacher: str = ""
    location: str = ""
    day_of_week: int = Field(ge=1, le=7)
    start_slot: int = Field(ge=1, le=14)
    end_slot: int = Field(ge=1, le=14)
    weeks: list[int] = []
    remark: str = Field(default="", max_length=128)  # 调课/停课标记


class CourseOut(CourseIn):
    id: int

    class Config:
        from_attributes = True


class CourseBatchIn(BaseModel):
    """D2 课表截图解析结果批量入库"""
    courses: list[CourseIn]


# ---------- 日程（D2 语音速记用） ----------

class EventIn(BaseModel):
    title: str
    start_at: datetime
    end_at: datetime
    note: str = ""
    location: str = ""
    icon: str = Field(default="", max_length=8)   # 标题前小图标（emoji）
    color_idx: int = Field(default=0, ge=0, le=10)
    time_status: str = "exact"  # exact | start_only | fuzzy | todo
    type: str = "temp"
    source: str = "text"


class EventOut(EventIn):
    id: int
    status: str
    ddl_id: int | None = None
    series_id: int | None = None  # 重复日程组（整组删）

    class Config:
        from_attributes = True


class ConflictCheckIn(BaseModel):
    """保存日程前的冲突检测：与课程/已有日程的时间重叠"""
    start_at: datetime
    end_at: datetime
    exclude_event_id: int | None = None  # 编辑日程时排除自身
    time_status: str = "exact"  # 非 exact（大概/待定）不做冲突检测——占位时间不算数


class CourseConflictOut(BaseModel):
    name: str
    location: str = ""
    date: date            # 冲突发生在哪一天
    slots_text: str       # "第6-7节"
    time_text: str        # "14:00-15:40"
    course_id: int = 0    # 供冲突处理界面跳转编辑


class EventConflictOut(BaseModel):
    id: int
    title: str
    start_at: datetime
    end_at: datetime


# ---------- AI（D2） ----------

class ImageParseIn(BaseModel):
    image_base64: str


class VoiceUploadIn(BaseModel):
    """录音转文字：前端 uni.getRecorderManager 录的音频（base64）+ 文件后缀"""
    audio_base64: str
    ext: str = "mp3"


class FileParseIn(BaseModel):
    """教务系统导出的 .docx / .xlsx 课表文件（base64 或 dataURL）"""
    file_base64: str


class TextParseIn(BaseModel):
    text: str


class CourseGuess(BaseModel):
    """解析出的课程（入库前用户可校对修改）"""
    name: str
    teacher: str = ""
    location: str = ""
    day_of_week: int
    start_slot: int
    end_slot: int
    weeks: list[int] = []


class TimetableParseOut(BaseModel):
    by: str = "rule"  # llm | rule
    courses: list[CourseGuess]


class VoiceParseIn(BaseModel):
    text: str


class VoiceParseOut(BaseModel):
    title: str
    note: str = ""
    location: str = ""
    start_at: datetime
    end_at: datetime
    time_status: str = "exact"  # exact | start_only | fuzzy | todo
    by: str = "rule"  # llm | rule | notice


# ---------- 个人主页（D2） ----------

class ProfileIn(BaseModel):
    nickname: str = Field(default="", max_length=32)


class ProfileOut(BaseModel):
    user_code: str
    nickname: str
    created_at: datetime | None = None


class ProfileEventItem(BaseModel):
    """主页日程列表的精简条目（重复组折叠成一项）"""
    id: int
    title: str
    icon: str = ""
    location: str = ""
    time_status: str = "exact"
    type: str = "temp"
    start_at: datetime
    end_at: datetime
    series_id: int | None = None
    series_count: int = 1  # 同组共多少条（>1 显示 🔁×N）


class ProfileChangeItem(BaseModel):
    """课表改动：带 remark 的课程（调课/停课标记）"""
    id: int
    name: str
    remark: str
    day_of_week: int
    start_slot: int
    end_slot: int
    weeks: list[int] = []


class ProfileGroupItem(BaseModel):
    """加入的群组（D4 填充内容，现在就能查）"""
    code: str
    name: str
    nickname: str = ""


class ProfileSummaryOut(BaseModel):
    profile: ProfileOut
    term: TermOut | None = None
    stats: dict  # courses/events/changes/groups 计数
    events: list[ProfileEventItem]      # 最近的，按开始时间倒序
    changes: list[ProfileChangeItem]    # remark 非空的课程
    groups: list[ProfileGroupItem]      # 已加入的群组


class ResetIn(BaseModel):
    """重置：courses=清空课程（新学期换课表） events=清空日程 all=全部"""
    scope: str = "courses"  # courses | events | all


# ---------- DDL 中枢与推荐（D3） ----------

class DdlIn(BaseModel):
    title: str = Field(max_length=128)
    course_name: str = Field(default="", max_length=128)
    due_at: datetime
    weight: int = Field(default=2, ge=1, le=3)  # 1低 2中 3高
    kind: str = "task"  # task | exam（考试单独分区，强制高重要度）
    location: str = Field(default="", max_length=128)  # 考试地点
    note: str = Field(default="", max_length=256)      # 备注
    exam_end: datetime | None = None  # 考试结束时刻（开始= due_at）；考试会同步上日程表


class DdlOut(DdlIn):
    id: int
    status: str            # open | done | overdue
    tier: str = "green"    # red | yellow | green | overdue | done（倒计时墙分档）
    remain_text: str = ""  # "剩2天3小时" / "逾期4小时"
    remind: bool = False   # 截止前 24h 内还没完成 → 前一天提醒
    muted: bool = False    # 被忽略过 → 推荐引擎永久跳过


class DdlBatchIn(BaseModel):
    """粘贴群通知解析校对后批量入库"""
    ddls: list[DdlIn]


class DdlParseIn(BaseModel):
    text: str


class DdlGuess(BaseModel):
    """抽取出的 DDL（入库前用户可校对）"""
    title: str
    course_name: str = ""
    due_at: datetime
    weight: int = 2
    kind: str = "task"  # task | exam
    location: str = ""
    note: str = ""


class DdlParseOut(BaseModel):
    by: str = "rule"  # llm | rule
    ddls: list[DdlGuess]


class SuggestSlotOut(BaseModel):
    """一个候选时段（每张卡片最多 3 个，换时间=循环切换）"""
    start_at: datetime
    end_at: datetime
    bucket: str = ""   # morning | afternoon | evening
    score: float = 0.0
    reason: str = ""
    cat: str = ""      # ws 工作日短时 | wl 周末长时 | dl 工作日长时 | fs 周末短时（差异化分桶）


class SuggestCardOut(BaseModel):
    ddl_id: int
    title: str
    course_name: str = ""
    weight: int = 2
    kind: str = "task"  # task | exam
    due_at: datetime
    remain_text: str = ""
    tier: str = "green"
    slots: list[SuggestSlotOut]


class SuggestOut(BaseModel):
    cards: list[SuggestCardOut]


class SuggestAcceptIn(BaseModel):
    """接受建议 → 写入日程（唯一会落库的三键之一）"""
    ddl_id: int
    start_at: datetime
    end_at: datetime


class SuggestFeedbackIn(BaseModel):
    """忽略/换时间：只记录，绝不写日程"""
    ddl_id: int
    action: str = "ignore"  # ignore | change
    bucket: str = ""
    reason: str = Field(default="", max_length=64)


class SuggestPlanIn(BaseModel):
    """批奏折·考前复习计划：每个周末排一段长时间复习，一直到考试前"""
    ddl_id: int


class EventRecurIn(BaseModel):
    """批量重复日程：每天 9 点练琴 1 小时 / 每周一三 9:00-10:00 有事"""
    title: str = Field(max_length=128)
    note: str = ""
    location: str = ""
    icon: str = Field(default="", max_length=8)
    color_idx: int = Field(default=0, ge=0, le=10)
    start_time: str = "09:00"   # HH:MM
    end_time: str = "10:00"
    repeat: str = "daily"       # daily | weekly
    days: list[int] = []        # weekly 时有效：1=周一 … 7=周日
    start_date: date
    end_date: date
    time_status: str = "exact"
