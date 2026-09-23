# -*- coding: utf-8 -*-
"""被攻击目标模型的选择层。用户可在右上角切换，选择存入会话。
小模型优先排序；DeepSeek 直连，其余国产/国外小模型走 OpenRouter。
每项: id(内部键) / label / note(产地·体量) / provider / model(真实 API id)。"""
from flask import session

MODELS = [
    {
        "id": "custom-deepseek-flash",
        "label": "DeepSeek V4 Flash",
        "note": "MoreCode 中转",
        "provider": "custom",
        "model": "deepseek-v4-flash"
    },
    {
        "id": "custom-deepseek-pro",
        "label": "DeepSeek V4 Pro",
        "note": "MoreCode 中转",
        "provider": "custom",
        "model": "deepseek-v4-pro"
    },
    {
        "id": "custom-glm-5.2",
        "label": "GLM-5.2",
        "note": "MoreCode 中转",
        "provider": "custom",
        "model": "glm-5.2"
    },
    {
        "id": "custom-kimi-k2.6",
        "label": "Kimi K2.6",
        "note": "MoreCode 中转",
        "provider": "custom",
        "model": "kimi-k2.6"
    },
    {
        "id": "custom-qwen3.7-max",
        "label": "Qwen3.7 Max",
        "note": "MoreCode 中转",
        "provider": "custom",
        "model": "qwen3.7-max"
    },
    {
        "id": "custom-claude-sonnet-5",
        "label": "Claude Sonnet 5",
        "note": "MoreCode 中转",
        "provider": "custom",
        "model": "claude-sonnet-5"
    },
    {
        "id": "custom-gpt-5.6-sol",
        "label": "GPT-5.6 Sol",
        "note": "MoreCode 中转",
        "provider": "custom",
        "model": "gpt-5.6-sol"
    },
    {
        "id": "custom-gemini-3.1-pro",
        "label": "Gemini 3.1 Pro",
        "note": "MoreCode 中转",
        "provider": "custom",
        "model": "gemini-3.1-pro"
    }
]
# 默认用稳定的云端 Flash（本地模型可能还在下载/推理慢，不设为默认）
DEFAULT = "deepseek-flash"
_BY_ID = {m["id"]: m for m in MODELS}


def current():
    """返回当前选中模型的内部 id。"""
    m = session.get("target_model")
    return m if m in _BY_ID else DEFAULT


def current_entry():
    """返回当前选中模型的完整配置 dict。"""
    return _BY_ID[current()]


def set_model(m):
    if m in _BY_ID:
        session["target_model"] = m
        return True
    return False
