"""OpenAI 兼容模型调用、有限重试、结构化输出和用量记录。"""

from __future__ import annotations

import json
import os
import random
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from pydantic import BaseModel, ValidationError

from .privacy import redact
from .runtime import RunInterrupted


class ModelError(RuntimeError):
    pass


class OutputTruncated(ModelError):
    def __init__(self, content=""):
        super().__init__("模型输出达到长度上限，未作为完整答案使用")
        self.partial_response = redact(content)[:30000]


def parse_json(text: str) -> Any:
    text = text.strip()
    fence = chr(96) * 3
    if text.startswith(fence):
        text = re.sub("^" + fence + r"(?:json)?\s*|\s*" + fence + "$", "", text, flags=re.I)
    return json.loads(text)


@dataclass
class ModelConfig:
    provider: str
    base_url: str
    model: str
    api_key: str = field(repr=False)
    input_price: float | None = None
    output_price: float | None = None
    max_output_tokens: int = 8192


def load_config(path: Path, provider: str | None = None) -> ModelConfig:
    data = json.loads(path.read_text(encoding="utf-8-sig")) if path.is_file() else {}
    provider = provider or data.get("active", "deepseek")
    if provider not in {"deepseek", "qwen", "cpa"}:
        raise ModelError("provider 必须为 deepseek、qwen 或 cpa")
    item = data.get("providers", {}).get(provider, {})
    env = {"deepseek": "DEEPSEEK_API_KEY", "qwen": "DASHSCOPE_API_KEY", "cpa": "CPA_API_KEY"}[provider]
    key = os.environ.get(env) or item.get("api_key")
    if not isinstance(key, str) or not key.strip():
        raise ModelError("未配置模型 Key；请在本地 llm.json 或对应环境变量中填写")
    defaults = {
        "deepseek": ("https://api.deepseek.com", "deepseek-chat"),
        "qwen": ("https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus"),
        "cpa": ("http://127.0.0.1:8317/v1", ""),
    }
    url, model = defaults[provider]
    if not (item.get("model") or model):
        raise ModelError("请配置 CPA 的实际模型 ID；不能由别名猜测后端模型")
    price = item.get("price_per_million_tokens_cny") or {}
    prices = [price.get("input"), price.get("output")]
    if any(v is not None and (isinstance(v, bool) or not isinstance(v, (float, int)) or v < 0) for v in prices):
        raise ModelError("模型单价必须为非负数或 null")
    maximum = item.get("max_output_tokens", 8192)
    if type(maximum) is not int or not 1024 <= maximum <= 32768:
        raise ModelError("max_output_tokens 必须为 1024–32768 的整数")
    return ModelConfig(provider, item.get("base_url") or url, item.get("model") or model, key.strip(), *prices, max_output_tokens=maximum)


@dataclass
class Reply:
    content: str = ""
    tool_calls: list[dict] = field(default_factory=list)

    def message(self) -> dict:
        result = {"role": "assistant", "content": self.content or None}
        if self.tool_calls:
            result["tool_calls"] = self.tool_calls
        return result


class LLM:
    def __init__(self, config: ModelConfig, *, transport=None, sleep=time.sleep):
        from openai import OpenAI

        self.config = config
        self.client = transport or OpenAI(api_key=config.api_key, base_url=config.base_url, timeout=90, max_retries=0)
        self.sleep = sleep
        self.usage: list[dict] = []
        self.cancel_event = None

    def chat(self, messages: list[dict], *, tools=None, tool_choice=None, json_mode=False) -> Reply:
        from openai import APIConnectionError, APITimeoutError, InternalServerError, RateLimitError

        kwargs = dict(model=self.config.model, messages=messages, temperature=0, max_tokens=self.config.max_output_tokens)
        if tools:
            kwargs.update(tools=tools, tool_choice=tool_choice or "auto")
        if json_mode:
            kwargs["response_format"] = {"type": "json_object"}
        started = time.perf_counter()
        for attempt in range(4):
            if self.cancel_event is not None and self.cancel_event.is_set():
                raise RunInterrupted()
            try:
                response = self.client.chat.completions.create(**kwargs)
                break
            except (APIConnectionError, APITimeoutError, InternalServerError, RateLimitError) as exc:
                if attempt == 3:
                    raise ModelError(f"模型调用失败：{type(exc).__name__}，已达重试上限") from None
                delay = min(2 ** attempt, 8) + random.random()
                if self.cancel_event is None:
                    self.sleep(delay)
                elif self.cancel_event.wait(delay):
                    raise RunInterrupted()
            except Exception as exc:
                raise ModelError(f"模型调用失败：{type(exc).__name__}") from None
        if not response.choices:
            raise ModelError("模型返回空 choices")
        msg = response.choices[0].message
        usage = response.usage
        incoming = getattr(usage, "prompt_tokens", None)
        outgoing = getattr(usage, "completion_tokens", None)
        cost = None
        if all(v is not None for v in (incoming, outgoing, self.config.input_price, self.config.output_price)):
            cost = (incoming * self.config.input_price + outgoing * self.config.output_price) / 1_000_000
        self.usage.append({
            "model": self.config.model, "input_tokens": incoming, "output_tokens": outgoing,
            "cost_cny": cost, "elapsed_ms": round((time.perf_counter() - started) * 1000, 2),
            "attempts": attempt + 1,
            "max_output_tokens": self.config.max_output_tokens,
            "finish_reason": response.choices[0].finish_reason,
        })
        if response.choices[0].finish_reason == "length":
            raise OutputTruncated(msg.content or "")
        calls = [{"id": c.id, "type": "function", "function": {"name": c.function.name, "arguments": c.function.arguments}}
                 for c in (msg.tool_calls or [])]
        return Reply(redact(msg.content or ""), calls)


def structured(call: Callable, messages: list[dict], schema: type[BaseModel], check=None, *, attempts=2):
    """格式错误带回模型；支持关系等业务错误交给正式校验器。"""
    request = list(messages)
    request.append({"role": "user", "content": output_instruction(schema)})
    for attempt in range(attempts):
        try:
            reply = call(request, json_mode=True)
        except OutputTruncated:
            if attempt + 1 == attempts:
                raise
            request.append({"role": "user", "content": "上轮回答超长被截断，没有采用。请用简短字段返回完整 JSON；要求文字和背景理由各用一句话，不省略要求、不漏行、不输出思考过程。"})
            continue
        try:
            value = schema.model_validate(parse_json(reply.content))
            return check(value) if check else value
        except (ValueError, ValidationError) as exc:
            if attempt + 1 == attempts:
                raise ModelError("模型结构化输出不合规，已达格式重试上限") from None
            error = exc.errors(include_input=False, include_url=False) if isinstance(exc, ValidationError) else str(exc)
            request += [reply.message(), {"role": "user", "content":
                "上次输出不是合规的数据实例。重新分析前述输入，返回实际结果，禁止复述 Schema 元数据。错误：" + str(error)[:2000]}]


def output_instruction(schema: type[BaseModel]) -> str:
    examples = {
        "Extraction": {"requirements": [{"text": "从实际 JD 提取的要求", "category": "core_capability",
            "jd_lines": [1], "category_basis_lines": [1]}],
            "ignored_lines": [{"line": 2, "kind": "context", "reason": "此行仅为章节标题，无候选人要求。"}]},
        "Judgments": {"judgments": [{"requirement_id": "R1", "support": "no_evidence",
            "conclusion": "pending", "evidence_ids": [], "unverified_aspects": ["该要求中尚无证据的必要能力"],
            "judgment": "根据实际证据给出简短理由。"}]},
    }
    return (
        "请完成前述输入的实际分析任务，只输出一个 JSON 数据实例。"
        "下面 Schema 仅供理解字段约束，禁止复述它，也不要输出 $defs、properties、type、required 等元数据。"
        "\nSchema:\n" + json.dumps(schema.model_json_schema(), ensure_ascii=False) +
        "\n最终答案结构示例（值必须替换为当前 JD 和证据的真实分析，数组包含所有要求）：\n" +
        json.dumps(examples.get(schema.__name__, {}), ensure_ascii=False)
    )
