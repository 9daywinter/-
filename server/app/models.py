"""数据模型——四天版全部实体一次建好，后续天只加路由不动表"""
from datetime import date, datetime

from sqlalchemy import JSON, Boolean, Date, DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


class Profile(Base):
    """用户档案：昵称等展示信息（D4 群组里给别人看；无密码，口令即身份）"""
    __tablename__ = "profiles"

    user_code: Mapped[str] = mapped_column(String(64), primary_key=True)
    nickname: Mapped[str] = mapped_column(String(32), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)


class Term(Base):
    """学期：教学周推算的基准"""
    __tablename__ = "terms"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_code: Mapped[str] = mapped_column(String(64), index=True)
    name: Mapped[str] = mapped_column(String(64), default="本学期")
    start_monday: Mapped[date] = mapped_column(Date)  # 第 1 教学周的周一
    total_weeks: Mapped[int] = mapped_column(Integer, default=20)


class Course(Base):
    """课程；weeks 是周次数组，如 [1,3,5..17] 即单双周"""
    __tablename__ = "courses"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_code: Mapped[str] = mapped_column(String(64), index=True)
    term_id: Mapped[int] = mapped_column(ForeignKey("terms.id"))
    name: Mapped[str] = mapped_column(String(128))
    teacher: Mapped[str] = mapped_column(String(64), default="")
    location: Mapped[str] = mapped_column(String(128), default="")
    day_of_week: Mapped[int] = mapped_column(Integer)  # 1=周一 ... 7=周日
    start_slot: Mapped[int] = mapped_column(Integer)   # 第几节开始
    end_slot: Mapped[int] = mapped_column(Integer)     # 第几节结束
    weeks: Mapped[list] = mapped_column(JSON, default=list)
    remark: Mapped[str] = mapped_column(String(128), default="")  # 调课/停课标记，个人主页展示


class Event(Base):
    """日程：语音/文字速记、接受的推荐、群组定档"""
    __tablename__ = "events"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_code: Mapped[str] = mapped_column(String(64), index=True)
    title: Mapped[str] = mapped_column(String(128))
    note: Mapped[str] = mapped_column(String(256), default="")    # 备注，显示在日程块上
    location: Mapped[str] = mapped_column(String(128), default="")  # 地点（群通知/速记提取）
    icon: Mapped[str] = mapped_column(String(8), default="")      # 标题前小图标（emoji）
    time_status: Mapped[str] = mapped_column(String(12), default="exact")  # exact|start_only|fuzzy|todo
    color_idx: Mapped[int] = mapped_column(Integer, default=0)   # 日程块配色下标
    start_at: Mapped[datetime] = mapped_column(DateTime)
    end_at: Mapped[datetime] = mapped_column(DateTime)
    type: Mapped[str] = mapped_column(String(16), default="temp")    # temp | suggestion | group
    source: Mapped[str] = mapped_column(String(16), default="text")  # voice | text | ddl | group
    status: Mapped[str] = mapped_column(String(16), default="ok")    # ok | canceled
    ddl_id: Mapped[int | None] = mapped_column(Integer, nullable=True, default=None)  # 接受的推荐 ↔ 来源 DDL
    series_id: Mapped[int | None] = mapped_column(Integer, nullable=True, default=None)  # 重复日程组（整组删改）


class DDL(Base):
    __tablename__ = "ddls"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_code: Mapped[str] = mapped_column(String(64), index=True)
    title: Mapped[str] = mapped_column(String(128))
    course_name: Mapped[str] = mapped_column(String(128), default="")
    due_at: Mapped[datetime] = mapped_column(DateTime)
    weight: Mapped[int] = mapped_column(Integer, default=2)  # 1 低 2 中 3 高
    kind: Mapped[str] = mapped_column(String(8), default="task")  # task | exam 考试单独分区
    location: Mapped[str] = mapped_column(String(128), default="")  # 考试地点（醒目展示）
    note: Mapped[str] = mapped_column(String(256), default="")      # 备注（考试范围/开闭卷等）
    exam_end: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)  # 考试结束时刻（开始= due_at）
    muted: Mapped[bool] = mapped_column(Boolean, default=False)  # 用户忽略过 → 永久不再给该 DDL 提建议
    status: Mapped[str] = mapped_column(String(16), default="open")  # open | done | overdue


class DdlFeedback(Base):
    """建议卡片三键反馈（FR-33）：忽略/换时间记录在案，推荐打分按「时段」降权——
    老在晚上点忽略的人，之后少推晚上（偏好修正，规则版不猜原因）"""
    __tablename__ = "ddl_feedback"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_code: Mapped[str] = mapped_column(String(64), index=True)
    ddl_id: Mapped[int] = mapped_column(Integer, index=True)
    action: Mapped[str] = mapped_column(String(8))   # ignore | change | accept
    bucket: Mapped[str] = mapped_column(String(8), default="")  # morning|afternoon|evening
    reason: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)


class Group(Base):
    """空闲碰撞组；code 是进组口令"""
    __tablename__ = "groups"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(8), index=True, unique=True)
    name: Mapped[str] = mapped_column(String(64))
    creator_code: Mapped[str] = mapped_column(String(64))


class GroupMember(Base):
    __tablename__ = "group_members"

    id: Mapped[int] = mapped_column(primary_key=True)
    group_id: Mapped[int] = mapped_column(ForeignKey("groups.id"), index=True)
    user_code: Mapped[str] = mapped_column(String(64), index=True)
    nickname: Mapped[str] = mapped_column(String(32), default="")
    share_detail: Mapped[bool] = mapped_column(Boolean, default=False)  # FR-45 自愿开放细节
