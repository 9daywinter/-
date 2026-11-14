"""四天版不做登录：前端首次打开生成 user_code 存 localStorage，之后每个请求带 X-User 头。"""
from fastapi import Header, HTTPException


def get_user(x_user: str = Header(default="")) -> str:
    if not x_user:
        raise HTTPException(status_code=401, detail="缺少 X-User 请求头")
    return x_user
