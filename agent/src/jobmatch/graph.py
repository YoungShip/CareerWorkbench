"""受限 LangGraph：模型拆解/判定、只读检索、确定性决策和正式校验纠错。"""

from __future__ import annotations

import json
import time
from dataclasses import asdict
from pathlib import Path
from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph

from . import prompts
from .corpus import Corpus
from .jd import InvalidJDSource, numbered, prepare_jd
from .llm import ModelError, OutputTruncated, output_instruction, parse_json, structured
from .privacy import redact
from .record import Job, assembled, build_record, prepare_snapshots, publish, sha, write_json, source_context
from .schemas import Extraction, Judgments, extraction_check, judgments_check
from .runtime import source_fingerprint, RunInterrupted
from .verifier import verify
from .rubric import rubric_issues


class State(TypedDict, total=False):
    clauses: list[str]
    requirements: list[dict]
    local_gates: list[dict]
    judgments: list[dict]
    messages: list[dict]
    pending_tools: list[dict]
    visible_evidence_ids: list[str]
    searches: int
    repairs: int
    passed: bool
    first_passed: bool
    issues: list[dict]
    record: dict
    verified_attempts: list[dict]


class Matcher:
    def __init__(self, llm, retriever, corpus: Corpus, scripts_dir: Path, *, max_searches=2, max_repairs=2, max_calls=16):
        if not 0 <= max_searches <= 2 or not 0 <= max_repairs <= 2 or not 1 <= max_calls <= 30:
            raise ValueError("检索/纠错上限必须在 0–2，调用上限必须在 1–30")
        self.llm, self.retriever, self.corpus, self.scripts = llm, retriever, corpus, scripts_dir
        self.max_searches, self.max_repairs, self.max_calls = max_searches, max_repairs, max_calls
        self.calls = 0
        self.graph = self._graph()

    def trace(self, kind, **data):
        item = {"event": kind, **data}
        with (self.directory / "trace.jsonl").open("a", encoding="utf-8") as fh:
            fh.write(redact(json.dumps(item, ensure_ascii=False)) + "\n")

    def chat(self, messages, **kwargs):
        cancel = getattr(self, "cancel_event", None)
        if cancel is not None and cancel.is_set():
            raise RunInterrupted()
        if self.calls >= self.max_calls:
            raise ModelError("本岗位模型调用已达上限")
        self.calls += 1
        try:
            reply = self.llm.chat(messages, **kwargs)
        except OutputTruncated as exc:
            self.trace("truncated_output", call=self.calls, partial_response=exc.partial_response)
            raise
        self.trace("model", call=self.calls, response=reply.content, tools=reply.tool_calls)
        return reply

    def prepare(self, state):
        clauses = prepare_jd(self.job.jd_text, redact_text=True).clauses
        if not clauses:
            raise ValueError("JD 清洗后没有可分析正文")
        prepare_snapshots(self.directory, self.job, clauses, self.corpus)
        self.trace("prepare", jd_sha256=sha("\n".join(clauses) + "\n"), corpus_version=self.corpus.version, clauses=len(clauses))
        return {"clauses": clauses, "searches": 0, "repairs": 0, "verified_attempts": []}

    def extract(self, state):
        messages = [
            {"role": "system", "content": prompts.EXTRACT},
            {"role": "user", "content": json.dumps({"company": redact(self.job.company), "title": redact(self.job.title),
              "city": redact(self.job.city), "jd": numbered(state["clauses"]),
              "source_context": source_context(self.job)}, ensure_ascii=False)},
        ]
        output = structured(self.chat, messages, Extraction, lambda v: extraction_check(v, len(state["clauses"]), state["clauses"]))
        requirements = [r.model_dump() for r in output.requirements]
        gates = [r.model_dump() | {"checked": False} for r in output.ignored_lines if r.kind in {"application_gate", "preference_gate"}]
        audit = {"requirements": requirements, "ignored_lines": [r.model_dump() for r in output.ignored_lines],
                 "all_lines_accounted": True, "semantic_correctness_verified": False}
        write_json(self.directory / "extraction-audit.json", audit)
        write_json(self.directory / "application-gates.json", {"gates": gates, "all_checked": not gates,
            "scope": "本地投前核查；未向匹配模型发送私密个人事实，专业匹配通过不代表这些条件已通过"})
        self.trace("extract", **audit)
        return {"requirements": requirements, "local_gates": gates}

    def retrieve(self, state):
        results, evidence = {}, {}
        if self.retriever.mode == "full":
            evidence = {c.id: asdict(c) for c in self.corpus.chunks}
        else:
            for n, req in enumerate(state["requirements"], 1):
                hits = self.retriever.search(req["text"])
                results[f"R{n}"] = [c.id for c in hits]
                evidence.update({c.id: asdict(c) for c in hits})
        boundaries = self.retriever.boundaries()
        evidence.update({c.id: asdict(c) for c in boundaries})
        payload = {
            "job_context": {"company": redact(self.job.company), "title": redact(self.job.title),
                            "city": redact(self.job.city), "source_context": source_context(self.job)},
            "requirements": [{"requirement_id": f"R{i}", **r} for i, r in enumerate(state["requirements"], 1)],
            "jd": numbered(state["clauses"]), "evidence_ids_by_requirement": results,
            "local_application_gates": state.get("local_gates", []),
            "evidence": list(evidence.values()), "always_include_boundary_ids": [c.id for c in boundaries],
        }
        messages = [
            {"role": "system", "content": prompts.JUDGE},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
            {"role": "user", "content": output_instruction(Judgments)},
        ]
        visible_ids = sorted(evidence)
        self.trace("retrieve", evidence_ids=results, unique_evidence_count=len(evidence), variant=self.retriever.mode,
                   visible_evidence_ids=visible_ids)
        return {"messages": messages, "visible_evidence_ids": visible_ids}

    def judge(self, state):
        choice = "auto" if state["searches"] < self.max_searches and self.retriever.mode != "full" else "none"
        try:
            reply = self.chat(state["messages"], tools=prompts.SEARCH_TOOL, tool_choice=choice)
        except OutputTruncated:
            output = structured(self.chat, state["messages"] + [{"role": "user", "content":
                "上轮输出超长已丢弃。每条判定用一句简短理由，只返回完整 JSON，不输出推理过程。"}],
                Judgments, lambda v: judgments_check(v, len(state["requirements"])), attempts=1)
            return {"judgments": [j.model_dump() | {"category": None} for j in output.judgments], "pending_tools": []}
        if reply.tool_calls:
            if choice == "none":
                raise ModelError("模型违反工具调用上限")
            return {"messages": state["messages"] + [reply.message()], "pending_tools": reply.tool_calls}
        try:
            output = judgments_check(Judgments.model_validate(parse_json(reply.content)), len(state["requirements"]))
        except ValueError:
            output = structured(self.chat, state["messages"] + [reply.message(),
                {"role": "user", "content": "上次 JSON 结构或 R 编号不合规，请按既定结构返回全部判定。"}],
                Judgments, lambda v: judgments_check(v, len(state["requirements"])))
        rows = [j.model_dump() for j in output.judgments]
        # 初判类别沿用 extract；纠错节点才允许显式调整类别。
        for row in rows:
            row["category"] = None
        return {"judgments": rows, "pending_tools": []}

    def search_tools(self, state):
        used, messages = state["searches"], list(state["messages"])
        visible_ids = set(state["visible_evidence_ids"])
        for call in state["pending_tools"]:
            try:
                fn = call.get("function", {})
                args = parse_json(fn.get("arguments", ""))
                if fn.get("name") != "search_evidence" or not isinstance(args, dict) or set(args) != {"query"}:
                    raise ValueError("仅支持 search_evidence(query)")
                query = args["query"]
                if not isinstance(query, str) or not 1 <= len(query.strip()) <= 400:
                    raise ValueError("query 长度必须为 1–400")
                if used >= self.max_searches:
                    raise ValueError("追加检索达到上限")
                used += 1
                hits = self.retriever.search(redact(query))
                result = {"evidence": [asdict(c) for c in hits]}
                visible_ids.update(c.id for c in hits)
            except (ValueError, TypeError):
                result = {"error": "工具名、参数无效或已达上限；请以现有证据返回最终 JSON"}
                # 错误调用也消耗额度，避免不断调用不存在的工具。
                used = min(used + 1, self.max_searches)
            messages.append({"role": "tool", "tool_call_id": call["id"], "content": json.dumps(result, ensure_ascii=False)})
            self.trace("search", result=result, searches=used)
        return {"messages": messages, "searches": used, "pending_tools": [],
                "visible_evidence_ids": sorted(visible_ids)}

    def decide(self, state):
        raw = build_record(self.job, state["clauses"], state["requirements"], state["judgments"], self.corpus, self.scripts,
                           visible_evidence_ids=state["visible_evidence_ids"])
        write_json(self.directory / f"attempt-{state['repairs']}-raw.json", raw)
        return {"record": assembled(raw, self.scripts)}

    def verify_node(self, state):
        path = self.directory / f"attempt-{state['repairs']}.json"
        write_json(path, state["record"])
        result = verify(state["record"], path, self.job.id, self.scripts)
        guard_issues = rubric_issues(state["requirements"], state["judgments"], state["clauses"])
        report = result.report | {"rubric_guard": {"passed": not guard_issues, "issues": guard_issues,
            "semantic_accuracy_verified": False}}
        write_json(path.with_name(path.stem + "-verification.json"), report)
        passed = result.passed and not guard_issues
        codes = list(dict.fromkeys(result.codes + [issue["code"] for issue in guard_issues]))
        attempts = state["verified_attempts"] + [{"repair": state["repairs"], "passed": passed, "codes": codes}]
        self.trace("verify", **attempts[-1])
        return {"passed": passed, "first_passed": attempts[0]["passed"], "issues": result.issues + guard_issues, "verified_attempts": attempts}

    def repair(self, state):
        # 保留所有已提供的检索证据，纠错不允许访问额外资源或重写 JD。
        payload = {
            "previous_judgments": state["judgments"], "issues": state["issues"],
            "requirements": state["requirements"],
        }
        messages = [{"role": "system", "content": prompts.REPAIR}] + state["messages"][1:]
        messages += [{"role": "user", "content": json.dumps(payload, ensure_ascii=False)}]
        output = structured(self.chat, messages, Judgments, lambda v: judgments_check(v, len(state["requirements"])))
        self.trace("repair", round=state["repairs"] + 1)
        return {"judgments": [j.model_dump() for j in output.judgments], "repairs": state["repairs"] + 1}

    def _graph(self):
        graph = StateGraph(State)
        for name in ("prepare", "extract", "retrieve", "judge", "search_tools", "decide", "repair"):
            graph.add_node(name, getattr(self, name))
        graph.add_node("verify", self.verify_node)
        for a, b in ((START, "prepare"), ("prepare", "extract"), ("extract", "retrieve"), ("retrieve", "judge"),
                     ("search_tools", "judge"), ("decide", "verify"), ("repair", "decide")):
            graph.add_edge(a, b)
        graph.add_conditional_edges("judge", lambda s: "search_tools" if s.get("pending_tools") else "decide")
        graph.add_conditional_edges("verify", lambda s: END if s["passed"] or s["repairs"] >= self.max_repairs else "repair")
        return graph.compile()

    def run(self, job: Job, directory: Path, *, official_pipeline=True) -> dict[str, Any]:
        self.job, self.directory, self.calls = job, directory, 0
        directory.mkdir(parents=True, exist_ok=False)
        started = time.perf_counter()
        usage_start = len(getattr(self.llm, "usage", []))
        result = {"job_id": job.id, "variant": self.retriever.mode, "corpus_version": self.corpus.version, "verification_passed": False}
        result["semantic_accuracy_verified"] = False
        result["source_sha256"] = source_fingerprint()
        result["model"] = getattr(getattr(self.llm, "config", None), "model", None)
        try:
            state = self.graph.invoke({}, {"recursion_limit": 40})
            final = self.directory / "matching-raw.json"
            write_json(final, build_record(job, state["clauses"], state["requirements"], state["judgments"], self.corpus,
                                          self.scripts, visible_evidence_ids=state["visible_evidence_ids"]))
            passed = state["passed"]
            if official_pipeline:
                pipeline = publish(final, self.scripts, directory / "pipeline")
                report = pipeline.get("assembled_verification") or {}
                passed = passed and bool(pipeline.get("mechanical_passed")) and any(p.get("id") == job.id and p.get("status") == "verified" for p in report.get("positions", []))
            result.update(
                execution_status="completed", verification_passed=passed,
                first_passed=state["first_passed"], repairs=state["repairs"], searches=state["searches"],
                decision=state["record"]["positions"][0]["decision"]["state"] if passed else None,
                attempts=state["verified_attempts"],
                local_application_gates=state.get("local_gates", []),
                local_application_gates_checked=not state.get("local_gates"),
            )
        except Exception as exc:
            # 错误只存类型，避免第三方异常回显密钥或完整输入。
            self.trace("failure", error_type=type(exc).__name__)
            result.update(execution_status="failed", error_type=type(exc).__name__, decision=None)
            if isinstance(exc, (ModelError, InvalidJDSource)):
                result["error_message"] = str(exc)
        usage = getattr(self.llm, "usage", [])[usage_start:]
        result.update(calls=self.calls, usage=usage, elapsed_ms=round((time.perf_counter() - started) * 1000, 2))
        write_json(directory / "result.json", result)
        return result
