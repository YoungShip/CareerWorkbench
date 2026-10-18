"""命令行入口：jobmatch <子命令>。"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections import Counter
from pathlib import Path
from datetime import datetime
from uuid import uuid4

from .config import default_paths


def run_name(prefix: str) -> str:
    return f"{prefix}-{datetime.now():%Y%m%d-%H%M%S}-{uuid4().hex[:6]}"


def current_corpus(paths):
    from .corpus import build_corpus
    from .materials import require_consistent_materials
    require_consistent_materials(paths.profile_json, paths.project)
    return build_corpus(paths.profile_json, paths.profile_md, paths.extra_evidence)


def cmd_doctor(args):
    from .llm import ModelError, load_config
    paths = default_paths()
    try:
        config = load_config(paths.llm_config, args.provider)
        model = {"configured": True, "provider": config.provider, "model": config.model,
                 "max_output_tokens": config.max_output_tokens}
    except ModelError:
        model = {"configured": False}
    from .materials import inspect_materials
    materials = inspect_materials(paths.profile_json, paths.project)
    ready = model["configured"] and paths.profile_json.is_file() and (paths.matching_scripts / "verify-matching.py").is_file() and materials["status"] == "passed"
    print(json.dumps({"model": model,
        "profile_exists": paths.profile_json.is_file(), "verifier_exists": (paths.matching_scripts / "verify-matching.py").is_file(),
        "materials": materials, "ready_for_matching": ready}, ensure_ascii=False, indent=2))
    return 0 if ready else 1


def cmd_check_materials(args):
    from .materials import inspect_materials, matching_freshness
    from .corpus import build_corpus
    paths = default_paths()
    result = inspect_materials(paths.profile_json, paths.project)
    if result["status"] == "passed":
        corpus = build_corpus(paths.profile_json, paths.profile_md, paths.extra_evidence)
        result["corpus"] = {"version": corpus.version, "chunks": len(corpus.chunks)}
        if args.matching_file:
            result["matching_freshness"] = matching_freshness(Path(args.matching_file), corpus.version)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["status"] == "passed" and result.get("matching_freshness", {}).get("status", "current") == "current" else 1


def cmd_corpus(args):
    paths = default_paths()
    corpus = current_corpus(paths)
    corpus.write(paths.corpus_dir)
    print(json.dumps({"version": corpus.version, "chunks": len(corpus.chunks),
        "kinds": dict(Counter(c.kind for c in corpus.chunks))}, ensure_ascii=False, indent=2))
    return 0


def make_matcher(args, paths):
    from .graph import Matcher
    from .llm import LLM, load_config
    from .retrieval import LocalEmbedder, Retriever
    config = load_config(paths.llm_config, args.provider)  # 无 Key 时不启动模型下载或创建运行目录。
    corpus = current_corpus(paths)
    embedder = LocalEmbedder(paths.models_dir) if args.variant in {"dense", "hybrid"} else None
    engine = Retriever(corpus, args.variant, embedder=embedder, cache_dir=paths.corpus_dir)
    return Matcher(LLM(config), engine, corpus, paths.matching_scripts), config


def cmd_match(args):
    from .record import Job, write_json
    paths = default_paths()
    source = None
    if args.job_id:
        if args.position_id:
            raise ValueError("--position-id 仅用于 --jd-file；主表岗位使用原 job_id")
        source = query_tracker_job(paths, args.job_id)
        r = source["jobs"][0]
        job = Job(r["job_id"], r["company"], r["job_title"], r.get("job_description") or "", r.get("location") or "", r.get("job_url") or "")
    else:
        if not args.company or not args.title:
            raise ValueError("--jd-file 必须同时提供 --company 和 --title")
        job = Job(args.position_id or "local-" + uuid4().hex[:12], args.company, args.title, Path(args.jd_file).read_text(encoding="utf-8-sig"), args.city or "", args.url or "")
    if not job.jd_text.strip():
        raise ValueError("该岗位没有完整 JD，不能进行匹配")
    matcher, _ = make_matcher(args, paths)
    directory = paths.runs_dir / run_name(args.variant)
    result = matcher.run(job, directory)
    if source is not None:
        write_json(directory / "tracker-source.json", source)
    print(json.dumps({"directory": str(directory), **result}, ensure_ascii=False, indent=2))
    return 0 if result["verification_passed"] else 1


def query_tracker_job(paths, identifier: str) -> dict:
    fields = "job_id,company,job_title,job_description,location,job_url"
    response = subprocess.run(["node", str(paths.project / "dashboard/tracker-cli.js"), "query",
        "--job_id=" + identifier, "--fields=" + fields, "--no_events"],
        cwd=paths.project, stdin=subprocess.DEVNULL, capture_output=True, encoding="utf-8", timeout=30)
    if response.returncode:
        raise ValueError("主表只读查询失败，请先检查 tracker；本次不会调用模型")
    payload = json.loads(response.stdout)
    rows = payload.get("jobs", [])
    if len(rows) != 1 or rows[0].get("job_id") != identifier or not payload.get("revision"):
        raise ValueError("job_id 不存在、不唯一或缺少主表 revision")
    return payload


def cmd_compare(args):
    from .compare import compare_runs, save_comparison
    report = compare_runs([Path(p) for p in args.run_dirs])
    out = default_paths().runs_dir / run_name("company-comparison")
    save_comparison(report, out)
    print(json.dumps({"directory": str(out), "company": report["company"],
        "jobs": [{k: j[k] for k in ("position_id", "title", "decision_label")} for j in report["jobs"]],
        "constraints": report["constraints"], "selected_position_id": None}, ensure_ascii=False, indent=2))
    return 0


def cmd_research(args):
    from .workflow import inspect_request, run_research
    paths = default_paths()
    request = Path(args.request).resolve()
    inspect_request(request)  # 输入错误先报出，不启动模型或向量模型下载。
    response = subprocess.run(["node", str(paths.project / "dashboard/tracker-cli.js"), "rules"],
        cwd=paths.project, stdin=subprocess.DEVNULL, capture_output=True, encoding="utf-8", timeout=30)
    if response.returncode:
        raise ValueError("无法读取现行选岗规则；本次不调用模型")
    rules = json.loads(response.stdout)
    matcher, _ = make_matcher(args, paths)
    directory = paths.runs_dir / run_name("research")
    print(f"运行目录：{directory}", flush=True)
    try:
        result = run_research(request, directory, matcher, rules)
    finally:
        matcher.llm.client.close()
    print(json.dumps({"directory": str(directory), "execution_status": result["execution_status"],
        "mechanical_passed": result["mechanical_passed"], "readiness": result["readiness"],
        "gate_checks": result["gate_checks"], "tracker_written": False}, ensure_ascii=False, indent=2))
    return 0 if result["execution_status"] == "completed" and result["mechanical_passed"] else 1


def cmd_run_status(args):
    from .checkpoint import run_status
    print(json.dumps(run_status(Path(args.run_dir)), ensure_ascii=False, indent=2))
    return 0


def cmd_resume(args):
    from .checkpoint import run_status
    from .corpus import Corpus
    from .graph import Matcher
    from .llm import LLM, load_config
    from .retrieval import LocalEmbedder, Retriever
    paths, directory = default_paths(), Path(args.run_dir).resolve()
    status = run_status(directory)
    if not status["code_matches"]:
        raise ValueError("实现版本与检查点不同；请新建运行，保留旧结果")
    state = json.loads((directory / "checkpoint.json").read_text(encoding="utf-8"))
    config = load_config(paths.llm_config, args.provider or state["contract"]["engine"].get("provider"))
    corpus = Corpus.load(directory / "corpus.json")  # 恢复冻结资料，不重新读取个人母表。
    mode = state["contract"]["engine"]["variant"]
    embedder = LocalEmbedder(paths.models_dir) if mode in {"dense", "hybrid"} else None
    retriever = Retriever(corpus, mode, embedder=embedder, cache_dir=paths.corpus_dir)
    def factory():
        return Matcher(LLM(config), retriever, corpus, paths.matching_scripts)
    matcher = factory()
    try:
        if status["kind"] == "research":
            from .workflow import run_research
            run_research(directory / "research-request.json", directory, matcher, {}, resume=True, retry_failed=args.retry_failed)
        else:
            raise ValueError("不支持该检查点类型")
    finally:
        matcher.llm.client.close()
    print(json.dumps({"directory": str(directory), **run_status(directory)}, ensure_ascii=False, indent=2))
    return 0 if run_status(directory)["recorded_status"] == "completed" else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="jobmatch", description="岗位匹配 Agent")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("check-materials", help="只读核对母表项目、简历、生成资料及当前证据版本，不调用模型")
    p.add_argument("--matching-file", help="可选 matching JSON 或含 corpus.json 的运行目录，检查旧事实是否仍适用")
    p.set_defaults(func=cmd_check_materials)

    p = sub.add_parser("run-status", help="只读查看新版批次检查点，不调用模型")
    p.add_argument("--run-dir", required=True)
    p.set_defaults(func=cmd_run_status)

    p = sub.add_parser("resume", help="恢复同版本冻结批次；默认复用已完成结果，保留所有历史尝试")
    p.add_argument("--run-dir", required=True)
    p.add_argument("--retry-failed", action="store_true", help="显式重试已完成但失败的岗位；旧失败仍保留")
    p.add_argument("--provider", choices=["deepseek", "qwen", "cpa"])
    p.set_defaults(func=cmd_resume)

    p = sub.add_parser("compare", help="同一公司多个匹配结果的只读证据对照，不调用模型或写主表")
    p.add_argument("--run-dir", dest="run_dirs", nargs="+", required=True)
    p.set_defaults(func=cmd_compare)

    p = sub.add_parser("research", help="研究 Skill 入口：官方快照与目录 → 多岗匹配 → 公司 matching v2 与报告")
    p.add_argument("--request", required=True)
    p.add_argument("--provider", choices=["deepseek", "qwen", "cpa"])
    p.add_argument("--variant", choices=["full", "bm25", "dense", "hybrid"], default="full")
    p.set_defaults(func=cmd_research)

    p = sub.add_parser("doctor", help="只检查模型配置和资料是否齐全，不显示密钥")
    p.add_argument("--provider", choices=["deepseek", "qwen", "cpa"])
    p.set_defaults(func=cmd_doctor)

    p = sub.add_parser("corpus", help="从最新母表生成私有证据库")
    p.set_defaults(func=cmd_corpus)

    p = sub.add_parser("match", help="只读匹配单岗，结果写私有运行目录")
    source = p.add_mutually_exclusive_group(required=True)
    source.add_argument("--job-id")
    source.add_argument("--jd-file")
    p.add_argument("--position-id", help="与 JD 文件对应的明确岗位 ID；省略时使用本地临时 ID")
    for name in ("company", "title", "city", "url"):
        p.add_argument("--" + name)
    p.add_argument("--provider", choices=["deepseek", "qwen", "cpa"])
    p.add_argument("--variant", choices=["full", "bm25", "dense", "hybrid"], default="full")
    p.set_defaults(func=cmd_match)

    return parser


def main(argv: list[str] | None = None) -> int:
    from .runtime import RunInterrupted
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except (KeyboardInterrupt, RunInterrupted):
        print("批次已中断；可用 jobmatch resume --run-dir <上方运行目录> 继续。尚在途的请求无法保证未计费。", file=sys.stderr)
        return 130
    except (ValueError, FileNotFoundError, FileExistsError) as exc:
        print(str(exc), file=sys.stderr)
        return 2
    except Exception as exc:
        from .llm import ModelError
        print(str(exc) if isinstance(exc, ModelError) else f"执行失败：{type(exc).__name__}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
