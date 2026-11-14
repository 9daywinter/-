# -*- coding: utf-8 -*-
"""ASR 端点自测：读 server/.env，发一段静音，确认 端点/key/model 是否对得上。

用法（填完 .env 的 ASR_API_KEY/BASE_URL/MODEL 后）：
  .venv/Scripts/python -X utf8 scripts/test_asr.py

判读：
  - "端点通了"（能收到 200，哪怕没识别出字）→ key/model/URL 都对，录音可用
  - 报 401/403 → key 不对；404 → 这条 /audio/transcriptions 路径 provider 没开
    （那就是百炼不兼容，换 ① OpenAI 或 ③ 本地 faster-whisper，见 .env 注释）
  - 报 400 → model 名字不对或音频格式不被收
"""
import io
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.utils.asr import AsrError, asr_enabled, transcribe  # noqa: E402


def silent_wav(seconds: float = 1.0, rate: int = 16000) -> bytes:
    """标准库生成一段静音 WAV（免任何音频素材）。"""
    n = int(seconds * rate)
    frames = b"\x00\x00" * n  # 16-bit mono
    buf = io.BytesIO()
    buf.write(b"RIFF" + struct.pack("<I", 36 + len(frames)) + b"WAVE")
    buf.write(b"fmt " + struct.pack("<I2H2I4x", 16, 1, 1, rate, rate * 2, 2))
    buf.write(b"data" + struct.pack("<I", len(frames)) + frames)
    return buf.getvalue()


def main():
    if not asr_enabled():
        print("✗ 还没填 ASR_API_KEY。把 server/.env 里 ASR_API_KEY 填好再跑这条。")
        return 1
    from app.utils.asr import _base, _model
    print(f"→ 端点: {_base()}/audio/transcriptions  模型: {_model()}")
    audio = silent_wav()
    try:
        text = transcribe(audio, ext="wav")
        print(f"✓ 端点通了（auth + 路径 + 模型名 都正确）。识别结果：{text!r}（静音→空属正常）")
        print("  现在打开 App 点红色录音按钮说一句，走的就是这条路。")
        return 0
    except AsrError as e:
        code = ""
        for tok in str(e).split():
            if tok.isdigit() and 100 <= int(tok) < 600:
                code = tok
                break
        print(f"✗ 不通：{e}")
        tips = {
            "401": "  → key 写错了",
            "403": "  → key 没权限 / 欠费",
            "404": "  → 这个 provider 的 /audio/transcriptions 没开。百炼常见就是这种，换 ① OpenAI 或 ③ 本地 faster-whisper（.env 注释里有现成填法）",
            "400": "  → 多半 model 名字不被收，按 provider 文档改 ASR_MODEL",
        }
        print(tips.get(code, "  → 换 .env 里 ① OpenAI 或 ③ 本地那条试试"))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
