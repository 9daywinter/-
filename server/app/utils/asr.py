"""语音转文字（ASR）客户端：OpenAI 兼容 /audio/transcriptions 协议。

只依赖已装的 httpx，不引任何新 SDK（本环境装不了新包）。
任意兼容端点都能接：OpenAI / 阿里云(兼容模式) / 智谱 / 本地 faster-whisper server。

配置放 server/.env（参考 .env.example）：
  ASR_API_KEY    必填，填了才启用"录音上传识别"
  ASR_BASE_URL   默认 OpenAI；换服务商就改这一个
  ASR_MODEL      默认 whisper-1；其它端点按它要的填
"""
import os

import httpx

from .llm import _load_env

_load_env()  # 复用同一份 .env 读取（幂等）


class AsrError(Exception):
    """ASR 调用失败，调用方返回友好错误即可，不影响手填主路"""


def asr_enabled() -> bool:
    return bool(os.environ.get("ASR_API_KEY"))


def _base() -> str:
    return os.environ.get("ASR_BASE_URL", "https://api.openai.com/v1").rstrip("/")


def _model() -> str:
    return os.environ.get("ASR_MODEL", "whisper-1")


def transcribe(audio: bytes, ext: str = "mp3", language: str = "zh") -> str:
    """音频字节 → 文字。ext 是文件后缀（mp3/m4a/wav/amr…），用于 multipart 文件名。"""
    key = os.environ.get("ASR_API_KEY", "")
    if not key:
        raise AsrError("未配置 ASR_API_KEY")
    # 清掉 OpenAI 不认识的字段（whisper-1 不要 response_format 之类）
    data = {"model": _model()}
    if language and _model() != "whisper-1":
        data["language"] = language  # 部分兼容端点支持；whisper-1 会自动检测
    try:
        r = httpx.post(
            f"{_base()}/audio/transcriptions",
            files={"file": (f"audio.{ext}", audio, "application/octet-stream")},
            data=data,
            headers={"Authorization": f"Bearer {key}"},
            timeout=60,
        )
    except httpx.HTTPError as e:
        raise AsrError(f"ASR 网络错误：{e}") from e
    if r.status_code != 200:
        raise AsrError(f"ASR 返回 {r.status_code}：{r.text[:200]}")
    try:
        return r.json().get("text", "").strip()
    except (ValueError, AttributeError) as e:
        raise AsrError("ASR 返回格式异常：" + r.text[:200]) from e
