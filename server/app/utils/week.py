"""教学周工具：全 App 时间计算的基石"""
from datetime import date, timedelta


def current_week(start_monday: date, today: date | None = None, total_weeks: int = 20) -> int:
    """今天处于第几教学周。开学前返回 0，超过总周数封顶返回 total_weeks。"""
    today = today or date.today()
    days = (today - start_monday).days
    if days < 0:
        return 0
    return min(days // 7 + 1, total_weeks)


def week_monday(start_monday: date, week: int) -> date:
    """第 week 教学周的周一日期"""
    return start_monday + timedelta(weeks=week - 1)


def course_on_week(weeks: list[int] | None, week: int) -> bool:
    """该课程在指定周次是否上课（含单双周判断）"""
    return week in (weeks or [])
