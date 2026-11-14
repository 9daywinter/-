"""极简 LLM 客户端：OpenAI 兼容协议，智谱 GLM / 阿里 Qwen 通吃。

配置放 server/.env（参考 .env.example）：
  LLM_API_KEY   必填，填了才启用 AI 功能
  LLM_BASE_URL  默认智谱；阿里改成 https://dashscope.aliyuncs.com/compatible-mode/v1
  LLM_MODEL     视觉模型，默认 glm-4v-flash（免费额度够四天开发用）
  LLM_TEXT_MODEL 文本模型，默认 glm-4-flash
"""
import os
from pathlib import Path

import httpx


class LLMError(Exception):
    """LLM 调用失败，调用方应降级或返回友好错误"""


def _load_env():
    """四天版不引 python-dotenv，手动读 server/.env（已设置的环境变量优先）"""
    env = Path(__file__).resolve().parent.parent.parent / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip())


_load_env()


def llm_enabled() -> bool:
    return bool(os.environ.get("LLM_API_KEY"))


def _base() -> str:
    return os.environ.get("LLM_BASE_URL", "https://open.bigmodel.cn/api/paas/v4")


def text_model() -> str:
    base = _base()
    if os.environ.get("LLM_TEXT_MODEL"):
        return os.environ["LLM_TEXT_MODEL"]
    if "bigmodel" in base:
        return "glm-4-flash"
    return os.environ.get("LLM_MODEL", "qwen-turbo")


def vision_model() -> str:
    return os.environ.get("LLM_MODEL", "glm-4v-flash")


def ask_llm(system: str, user: str, *, image_base64: str = None,
            model: str = None, max_tokens: int = 3000, timeout: float = 90) -> str:
    """返回模型文本。image_base64 支持裸 base64 或 dataURL。"""
    key = os.environ.get("LLM_API_KEY", "")
    if not key:
        raise LLMError("未配置 LLM_API_KEY")

    if image_base64:
        url = image_base64 if image_base64.startswith("data:") \
            else "data:image/jpeg;base64," + image_base64
        content = [
            {"type": "image_url", "image_url": {"url": url}},
            {"type": "text", "text": user},
        ]
    else:
        content = user

    payload = {
        "model": model or vision_model(),
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": content},
        ],
        "temperature": 0.1,
        "max_tokens": max_tokens,
    }
    try:
        r = httpx.post(
            f"{_base()}/chat/completions",
            json=payload,
            headers={"Authorization": f"Bearer {key}"},
            timeout=timeout,
        )
    except httpx.HTTPError as e:
        raise LLMError(f"LLM 网络错误：{e}") from e
    if r.status_code != 200:
        raise LLMError(f"LLM 返回 {r.status_code}：{r.text[:200]}")
    try:
        return r.json()["choices"][0]["message"]["content"]
    except (KeyError, IndexError, ValueError) as e:
        raise LLMError("LLM 返回格式异常：" + r.text[:200]) from e
