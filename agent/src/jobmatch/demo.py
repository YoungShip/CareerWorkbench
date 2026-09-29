"""离线可复现演示：虚构资料、预制模型响应，同一真实执行/校验/恢复路径。"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

from .checkpoint import atomic_json, digest
from .corpus import Chunk, Corpus
from .graph import Matcher
from .llm import Reply
from .retrieval import Retriever
from .workflow import run_research

ASSETS = Path(__file__).with_name("resources") / "demo"
VENDOR = Path(__file__).with_name("_vendor") / "matching"


def demo_scripts() -> Path:
    lock = json.loads((VENDOR / "SOURCE.json").read_text(encoding="utf-8"))
    for name, expected in lock["files"].items():
        data = (VENDOR / name).read_bytes().replace(b"\r\n", b"\n")
        if hashlib.sha256(data).hexdigest() != expected:
            raise ValueError("演示校验器与固定来源不一致；拒绝运行")
    return VENDOR


class ScriptedLLM:
    """显式模拟；既不调用LLM API，也不读取任何模型凭据。"""
    config = SimpleNamespace(provider="scripted", model="scripted-demo-v1", base_url="offline",
                             max_output_tokens=8192, input_price=None, output_price=None)

    def __init__(self, scenarios: dict):
        self.config = SimpleNamespace(**vars(type(self).config), fixture_sha256=digest(scenarios))
        self.scenarios = scenarios
        self.counts = {}
        self.usage = []

    def chat(self, messages, **kwargs):
        title = None
        for message in messages:
            if message.get("role") != "user":
                continue
            try:
                value = json.loads(message.get("content", ""))
            except (ValueError, TypeError):
                continue
            if isinstance(value, dict):
                title = value.get("title") or value.get("job_context", {}).get("title") or title
        if title not in self.scenarios:
            raise ValueError("该模拟模型仅支持随包演示场景")
        index = self.counts.get(title, 0)
        self.counts[title] = index + 1
        response = self.scenarios[title][index]
        if "tool_query" in response:
            return Reply(tool_calls=[{"id": f"demo-call-{index}", "type": "function",
                "function": {"name": "search_evidence", "arguments": json.dumps({"query": response["tool_query"]}, ensure_ascii=False)}}])
        return Reply(json.dumps(response, ensure_ascii=False))


def run_demo(directory: Path, *, resume=False, retry_failed=False, stop_after=None) -> dict:
    fixture = json.loads((ASSETS / "fixture.json").read_text(encoding="utf-8"))
    corpus = Corpus([Chunk(**c) for c in fixture["chunks"]])
    llm = ScriptedLLM(fixture["responses"])
    matcher = Matcher(llm, Retriever(corpus, "bm25"), corpus, demo_scripts())
    # 即使外层终端开启了远端追踪，离线演示也只在本地运行。
    from langsmith import tracing_context
    with tracing_context(enabled=False):
        result = run_research(ASSETS / "request.json", directory, matcher,
            {"read_only": True, "selection_rules": "合成演示规则：只读核对，绝不选岗、登记或提交。", "synthetic": True},
            resume=resume, retry_failed=retry_failed, stop_after=stop_after)
    summary = {"simulation": True, "model_responses": "scripted_not_real_model",
               "api_calls": 0, "private_candidate_data_used": False, "execution_status": result["execution_status"],
               "calls_this_invocation": sum(llm.counts.values()), "tracker_written": False,
               "jobs": [{k: j.get(k) for k in ("job_id", "decision", "verification_passed", "searches", "repairs", "attempt_count")}
                        for j in result["jobs"]],
               "scope": "验证真实程序的编排、工具补查、故障纠错、来源记录和恢复；不能当模型准确率。",
               "next_step": "完整结果见research-report.md；中断演示可用resume继续。"}
    atomic_json(directory / "demo-summary.json", summary)
    if result["execution_status"] == "completed":
        content = (directory / "research-report.md").read_text(encoding="utf-8")
        banner = "# 离线演示：合成资料 + 模拟模型\n\n本报告由预制响应驱动真实程序生成，没有调用真实模型、没有读取个人档案，不是质量评测成绩。\n\n"
        (directory / "demo-report.md").write_text(banner + content, encoding="utf-8", newline="\n")
    return {**result, "simulation": True, "calls_this_invocation": summary["calls_this_invocation"]}
