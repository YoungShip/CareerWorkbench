import json

from jobmatch.config import default_paths
from jobmatch.graph import Matcher
from jobmatch.llm import Reply
from jobmatch.record import Job
from jobmatch.retrieval import Retriever

from conftest import FakeLLM


def extraction(lines=None):
    return json.dumps({"requirements": [{"text": "Python 开发", "category": "core_capability",
        "jd_lines": lines or [1], "category_basis_lines": [1]}]})


def judgment(evidence="python", support="direct_support", conclusion="satisfied"):
    return json.dumps({"judgments": [{"requirement_id": "R1", "support": support,
        "conclusion": conclusion, "evidence_ids": [evidence], "judgment": "依据提供的项目证据判定。"}]})


def tool(query="Python"):
    return Reply(tool_calls=[{"id": "call_1", "type": "function",
        "function": {"name": "search_evidence", "arguments": json.dumps({"query": query})}}])


def matcher(corpus, replies, **kwargs):
    client = FakeLLM(replies)
    return Matcher(client, Retriever(corpus, "bm25"), corpus, default_paths().matching_scripts, **kwargs), client


def test_tool_call_unknown_evidence_repair_and_official_pipeline(corpus, tmp_path):
    match, client = matcher(corpus, [extraction(), tool(), judgment("invented"), judgment()])
    out = tmp_path / "run"
    result = match.run(Job("role", "Fixture", "Developer", "需要 Python 开发能力。"), out)
    assert result["verification_passed"], (result, (out / "trace.jsonl").read_text(encoding="utf-8"))
    assert result["first_passed"] is False
    assert result["repairs"] == 1 and result["searches"] == 1
    assert result["decision"] == "recommended"
    assert "CANDIDATE_EVIDENCE_REFERENCE_UNKNOWN" in result["attempts"][0]["codes"]
    record = json.loads((out / "pipeline/assembled-matching.json").read_text(encoding="utf-8"))
    assert record["coverage"]["capture_status"] == "partial"
    assert record["positions"][0]["jd_source"]["quotes"][0]["text"] == "需要 Python 开发能力。"
    assert (out / "pipeline/human-summary.json").is_file()
    audit = json.loads((out / "pipeline/jd-preprocessing.json").read_text(encoding="utf-8"))
    from jobmatch.record import sha
    assert audit["provided_sha256"] == sha((out / "pipeline/jd-original.txt").read_text(encoding="utf-8"))
    assert audit["model_sha256"] == sha((out / "pipeline/jd.txt").read_text(encoding="utf-8"))
    assert len(client.requests) == 4


def test_repair_limit_never_publishes_invalid_decision(corpus, tmp_path):
    match, _ = matcher(corpus, [extraction()] + [judgment("invented")] * 3)
    result = match.run(Job("role", "Fixture", "Developer", "需要 Python。"), tmp_path / "run")
    assert result["execution_status"] == "completed"
    assert not result["verification_passed"] and result["decision"] is None
    assert result["repairs"] == 2 and len(result["attempts"]) == 3


def test_out_of_range_lines_get_format_retry(corpus, tmp_path):
    match, client = matcher(corpus, [extraction([99]), extraction(), judgment()])
    result = match.run(Job("role", "Fixture", "Developer", "需要 Python。"), tmp_path / "run")
    assert result["verification_passed"]
    assert len(client.requests) == 3


def test_forbidden_tool_after_limit_fails_closed(corpus, tmp_path):
    match, client = matcher(corpus, [extraction(), tool(), tool(), tool()])
    result = match.run(Job("role", "Fixture", "Developer", "需要 Python。"), tmp_path / "run")
    assert result["execution_status"] == "failed"
    assert client.requests[-1][1]["tool_choice"] == "none"
    assert result["decision"] is None


def test_error_log_does_not_expose_provider_error(corpus, tmp_path):
    secret = "fake-secret-that-must-not-be-logged"
    match, _ = matcher(corpus, [RuntimeError(secret)])
    out = tmp_path / "run"
    result = match.run(Job("role", "Fixture", "Developer", "需要 Python。"), out)
    assert result["execution_status"] == "failed"
    assert secret not in (out / "trace.jsonl").read_text(encoding="utf-8")
    assert secret not in (out / "result.json").read_text(encoding="utf-8")


def test_full_mode_never_requests_more_evidence(corpus, tmp_path):
    client = FakeLLM([extraction(), judgment()])
    match = Matcher(client, Retriever(corpus, "full"), corpus, default_paths().matching_scripts)
    result = match.run(Job("role", "Fixture", "Developer", "需要 Python。"), tmp_path / "run")
    assert result["verification_passed"]
    assert client.requests[1][1]["tool_choice"] == "none"


def test_existing_run_is_preserved(corpus, tmp_path):
    import pytest

    match, _ = matcher(corpus, [])
    out = tmp_path / "run"
    out.mkdir()
    (out / "keep.txt").write_text("original")
    with pytest.raises(FileExistsError):
        match.run(Job("role", "Fixture", "Developer", "需要 Python。"), out)
    assert (out / "keep.txt").read_text() == "original"


def test_full_context_sends_each_evidence_only_once(corpus, tmp_path):
    client = FakeLLM([])
    match = Matcher(client, Retriever(corpus, "full"), corpus, default_paths().matching_scripts)
    match.directory = tmp_path
    match.job = Job("fixture", "Fixture", "2027届校招工程师", "需要 Python。", "Fixture City")
    req = json.loads(extraction())["requirements"][0]
    state = match.retrieve({"requirements": [req, req], "clauses": ["需要 Python。"]})
    payload = json.loads(state["messages"][1]["content"])
    assert len(payload["evidence"]) == len(corpus.chunks)
    assert payload["evidence_ids_by_requirement"] == {}
    assert payload["always_include_boundary_ids"] == ["limit"]
    assert payload["job_context"]["title"] == "2027届校招工程师"
    assert payload["job_context"]["city"] == "Fixture City"
