"""命令行入口：jobmatch <子命令>。"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from collections import Counter
from pathlib import Path
from datetime import datetime
from uuid import uuid4

from .config import default_paths


def cmd_eval_pool(args: argparse.Namespace) -> int:
    from .evaluation.pool import build_pool, read_tracker, sample_blind, scan_v2, write_pool

    paths = default_paths()
    rows = read_tracker(paths.tracker_csv)
    items = scan_v2(paths.research_tmp)
    audit = []
    entries = build_pool(rows, items, base_dir=paths.workspace, audit=audit)
    out = Path(args.data_dir) if args.data_dir else paths.eval_dir / "datasets" / run_name("identity-v2")
    out.mkdir(parents=True, exist_ok=False)
    from .record import write_json
    write_json(out / "identity-audit.json", audit)
    write_json(out / "dataset.json", {"identity_version": "pool-v2-explicit-identity",
        "old_labels_migrated": False, "baseline_is_gold": False,
        "tracker_sha256": hashlib.sha256(paths.tracker_csv.read_bytes()).hexdigest()})
    write_pool(entries, out / "pool.jsonl")
    blind = sample_blind(entries, seed=args.seed)
    (out / "blind-sample.json").write_text(json.dumps(blind, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    applied = sum(1 for e in entries if e.applied)
    print(f"tracker rows={len(rows)} v2 positions={len(items)} pool={len(entries)} applied={applied}")
    print("blind strata:", dict(Counter(b["stratum"] for b in blind)))
    print(f"新数据集：{out}；现有池、样本和标注未改动。")
    return 0


def eval_directory(args, paths) -> Path:
    return Path(args.data_dir) if args.data_dir else paths.eval_dir


def cmd_eval_sheet(args: argparse.Namespace) -> int:
    from .evaluation.pool import read_pool
    from .evaluation.sheet import write_sheet

    paths = default_paths()
    data = eval_directory(args, paths)
    entries = {e.eval_id: e for e in read_pool(data / "pool.jsonl")}
    blind = json.loads((data / "blind-sample.json").read_text(encoding="utf-8"))
    target = Path(args.out) if args.out else data / "标注表-50岗.xlsx"
    if target.exists() and not args.force:
        print(f"refuse to overwrite {target} (use --force)", file=sys.stderr)
        return 2
    write_sheet([entries[b["eval_id"]] for b in blind], target)
    print(target)
    return 0


def cmd_eval_labels(args: argparse.Namespace) -> int:
    from .evaluation.sheet import read_labels, write_labels

    paths = default_paths()
    data = eval_directory(args, paths)
    source = Path(args.xlsx) if args.xlsx else data / "标注表-50岗.xlsx"
    labels = read_labels(source)
    write_labels(labels, data / "labels.json")
    print(f"labels={len(labels)}", dict(Counter(v["judgment"] for v in labels.values())))
    return 0


def run_name(prefix: str) -> str:
    return f"{prefix}-{datetime.now():%Y%m%d-%H%M%S}-{uuid4().hex[:6]}"


def current_corpus(paths):
    from .corpus import build_corpus
    from .materials import require_consistent_materials
    require_consistent_materials(paths.profile_json, paths.project)
    return build_corpus(paths.profile_json, paths.profile_md, paths.extra_evidence)


def cmd_doctor(args):
    from .llm import ModelError, load_config
    from .evaluation.sheet import read_labels
    paths = default_paths()
    try:
        config = load_config(paths.llm_config, args.provider)
        model = {"configured": True, "provider": config.provider, "model": config.model}
    except ModelError:
        model = {"configured": False}
    sheet = paths.eval_dir / "标注表-50岗.xlsx"
    labels = read_labels(sheet) if sheet.is_file() else {}
    from .materials import inspect_materials
    materials = inspect_materials(paths.profile_json, paths.project)
    ready = model["configured"] and paths.profile_json.is_file() and (paths.matching_scripts / "verify-matching.py").is_file() and materials["status"] == "passed"
    print(json.dumps({"model": model, "manual_labels": len(labels), "annotation_sheet": str(sheet),
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


def cmd_eval_run(args):
    from .evaluation.run import run_batch, select_entries
    paths = default_paths()
    data = eval_directory(args, paths)
    entries = select_entries(data / "pool.jsonl", data / "blind-sample.json", args.dataset, args.limit)
    matcher, config = make_matcher(args, paths)
    from .graph import Matcher
    from .llm import LLM
    def factory():
        return Matcher(LLM(config), matcher.retriever, matcher.corpus, paths.matching_scripts)
    directory = data / "runs" / run_name(args.variant)
    print(f"运行目录：{directory}", flush=True)
    results = run_batch(matcher, entries, directory, model_name=config.model, workers=args.workers,
                        matcher_factory=factory if args.workers > 1 else None)
    print(f"结果目录：{directory}")
    return 0 if len(results) == len(entries) and all(r["verification_passed"] for r in results) else 1


def cmd_run_status(args):
    from .checkpoint import run_status
    print(json.dumps(run_status(Path(args.run_dir)), ensure_ascii=False, indent=2))
    return 0


def cmd_demo(args):
    from .demo import run_demo
    directory = Path(args.out).resolve()
    result = run_demo(directory, resume=args.resume, stop_after=args.stop_after)
    print(json.dumps({"directory": str(directory), "simulation": True, "api_calls": 0,
                      "execution_status": result["execution_status"],
                      "calls_this_invocation": result["calls_this_invocation"]}, ensure_ascii=False, indent=2))
    return 0 if result["execution_status"] in {"completed", "interrupted"} else 1


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
    if state["contract"]["engine"].get("provider") == "scripted":
        from .demo import run_demo
        result = run_demo(directory, resume=True, retry_failed=args.retry_failed)
        print(json.dumps({"directory": str(directory), "simulation": True, "status": result["execution_status"]}, ensure_ascii=False))
        return 0 if result["execution_status"] == "completed" else 1
    config = load_config(paths.llm_config, args.provider or state["contract"]["engine"].get("provider"))
    if status["kind"] == "semantic":
        from .evaluation.semantic import run_semantic, semantic_success
        result = run_semantic(directory / "cases.json", directory, lambda: LLM(config), paths.matching_scripts,
                              model_name=config.model, resume=True, retry_failed=args.retry_failed)
        print(json.dumps({"directory": str(directory), "passed": result["passed"], "total": result["total"],
                          "execution_status": result["execution_status"]}, ensure_ascii=False, indent=2))
        return 0 if semantic_success(result) else 1
    corpus = Corpus.load(directory / "corpus.json")  # 恢复冻结资料，不重新读取个人母表。
    mode = state["contract"]["engine"]["variant"]
    embedder = LocalEmbedder(paths.models_dir) if mode in {"dense", "hybrid"} else None
    retriever = Retriever(corpus, mode, embedder=embedder, cache_dir=paths.corpus_dir)
    def factory():
        return Matcher(LLM(config), retriever, corpus, paths.matching_scripts)
    matcher = factory()
    try:
        if status["kind"] == "evaluation":
            from .evaluation.pool import PoolEntry
            from .evaluation.run import run_batch
            manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
            entries = [PoolEntry(**e) for e in json.loads((directory / "samples.json").read_text(encoding="utf-8"))]
            run_batch(matcher, entries, directory, model_name=config.model, workers=manifest["workers"],
                matcher_factory=factory if manifest["workers"] > 1 else None, resume=True, retry_failed=args.retry_failed)
        elif status["kind"] == "research":
            from .workflow import run_research
            run_research(directory / "research-request.json", directory, matcher, {}, resume=True, retry_failed=args.retry_failed)
        else:
            raise ValueError("不支持该检查点类型")
    finally:
        matcher.llm.client.close()
    print(json.dumps({"directory": str(directory), **run_status(directory)}, ensure_ascii=False, indent=2))
    return 0 if run_status(directory)["recorded_status"] == "completed" else 1


def cmd_eval_report(args):
    from .evaluation.report import make_report
    from .evaluation.sheet import read_labels
    from .evaluation.run import ensure_batch_complete
    from .checkpoint import run_lock
    from .record import write_json
    paths = default_paths()
    source = Path(args.run_dir)
    with run_lock(source):
        results = [json.loads(line) for line in (source / "results.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
        ensure_batch_complete(source, results)
        data = eval_directory(args, paths)
        sheet = Path(args.xlsx) if args.xlsx else data / "标注表-50岗.xlsx"
        labels = read_labels(sheet) if sheet.is_file() else {}
        metadata_file = data / "labels-metadata.json"
        metadata = json.loads(metadata_file.read_text(encoding="utf-8")) if metadata_file.is_file() else None
        report = make_report(results, labels, metadata)
        write_json(source / "report.json", report)
    # badcase 内容留在私有报告，终端只给概要。
    print(json.dumps({k: v for k, v in report.items() if k != "badcases"}, ensure_ascii=False, indent=2))
    return 0


def cmd_semantic_check(args):
    from .evaluation.semantic import run_semantic, semantic_success
    from .llm import LLM, load_config
    paths = default_paths()
    config = load_config(paths.llm_config, args.provider)
    filename = "quality-pairs-v1.json" if args.suite == "quality" else "semantic-cases.json"
    cases = Path(args.cases) if args.cases else Path(__file__).with_name("resources") / "benchmarks" / filename
    out = paths.eval_dir / "semantic" / run_name("semantic")
    print(f"运行目录：{out}", flush=True)
    report = run_semantic(cases, out, lambda: LLM(config), paths.matching_scripts, model_name=config.model)
    print(json.dumps({"directory": str(out), "total": report["total"], "passed": report["passed"],
                      "provenance": report["provenance"]}, ensure_ascii=False, indent=2))
    return 0 if semantic_success(report) else 1


def cmd_semantic_compare(args):
    from .evaluation.semantic import compare_semantic
    from .record import write_json
    result = compare_semantic(Path(args.before), Path(args.after))
    directory = default_paths().eval_dir / "semantic" / run_name("comparison")
    directory.mkdir(parents=True)
    write_json(directory / "comparison.json", result)
    print(json.dumps({"directory": str(directory), **result}, ensure_ascii=False, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="jobmatch", description="岗位匹配 Agent")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("check-materials", help="只读核对母表项目、简历、生成资料及当前证据版本，不调用模型")
    p.add_argument("--matching-file", help="可选 matching JSON 或含 corpus.json 的运行目录，检查旧事实是否仍适用")
    p.set_defaults(func=cmd_check_materials)

    p = sub.add_parser("demo", help="合成资料+模拟模型的完整离线演示；不读个人档案、Key或网络")
    p.add_argument("--out", default="demo-output")
    p.add_argument("--stop-after", type=int, help="完成N岗后受控停止，用于展示恢复")
    p.add_argument("--resume", action="store_true")
    p.set_defaults(func=cmd_demo)

    p = sub.add_parser("run-status", help="只读查看新版批次检查点，不调用模型")
    p.add_argument("--run-dir", required=True)
    p.set_defaults(func=cmd_run_status)

    p = sub.add_parser("resume", help="恢复同版本冻结批次；默认复用已完成结果，保留所有历史尝试")
    p.add_argument("--run-dir", required=True)
    p.add_argument("--retry-failed", action="store_true", help="显式重试已完成但失败的岗位；旧失败仍保留")
    p.add_argument("--provider", choices=["deepseek", "qwen", "cpa"])
    p.set_defaults(func=cmd_resume)

    p = sub.add_parser("semantic-check", help="真实调用模型验证 1–10 个有明确预期的边界案例")
    p.add_argument("--cases", help="带来源说明的案例 JSON；默认使用公开合成案例")
    p.add_argument("--suite", choices=["boundary", "quality"], default="boundary")
    p.add_argument("--provider", choices=["deepseek", "qwen", "cpa"])
    p.set_defaults(func=cmd_semantic_check)

    p = sub.add_parser("semantic-compare", help="比较同一冻结语义基准的两次结果，不调用模型")
    p.add_argument("--before", required=True)
    p.add_argument("--after", required=True)
    p.set_defaults(func=cmd_semantic_compare)

    p = sub.add_parser("compare", help="同一公司多个匹配结果的只读证据对照，不调用模型或写主表")
    p.add_argument("--run-dir", dest="run_dirs", nargs="+", required=True)
    p.set_defaults(func=cmd_compare)

    p = sub.add_parser("research", help="研究 Skill 入口：官方快照与目录 → 多岗匹配 → 公司 matching v2 与报告")
    p.add_argument("--request", required=True)
    p.add_argument("--provider", choices=["deepseek", "qwen", "cpa"])
    p.add_argument("--variant", choices=["full", "bm25", "dense", "hybrid"], default="full")
    p.set_defaults(func=cmd_research)

    p = sub.add_parser("eval-pool", help="从主表和 v2 记录构建评测池并分层抽盲标样本")
    p.add_argument("--data-dir", help="新数据集目录，必须尚不存在；默认创建带日期的私有目录")
    p.add_argument("--seed", type=int, default=20260928)
    p.set_defaults(func=cmd_eval_pool)

    p = sub.add_parser("eval-sheet", help="生成盲标 xlsx")
    p.add_argument("--data-dir")
    p.add_argument("--out")
    p.add_argument("--force", action="store_true")
    p.set_defaults(func=cmd_eval_sheet)

    p = sub.add_parser("eval-labels", help="读回填好的盲标 xlsx")
    p.add_argument("--data-dir")
    p.add_argument("--xlsx")
    p.set_defaults(func=cmd_eval_labels)

    p = sub.add_parser("doctor", help="只检查配置是否齐全与标注数量，不显示密钥")
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

    p = sub.add_parser("eval-run", help="冻结样本顺序运行，默认仅 3 岗冒烟测试")
    p.add_argument("--data-dir")
    p.add_argument("--set", dest="dataset", choices=["blind", "applied"], default="blind")
    p.add_argument("--limit", type=int, default=3)
    p.add_argument("--workers", type=int, default=1, choices=range(1, 5))
    p.add_argument("--provider", choices=["deepseek", "qwen", "cpa"])
    p.add_argument("--variant", choices=["full", "bm25", "dense", "hybrid"], default="full")
    p.set_defaults(func=cmd_eval_run)

    p = sub.add_parser("eval-report", help="读真实标注并计算结果，不调用模型")
    p.add_argument("--data-dir")
    p.add_argument("--run-dir", required=True)
    p.add_argument("--xlsx")
    p.set_defaults(func=cmd_eval_report)
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
