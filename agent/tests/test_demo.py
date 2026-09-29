import json
import socket
from pathlib import Path

from jobmatch.demo import run_demo, demo_scripts, VENDOR
from jobmatch.verifier import load_verifier


def test_demo_is_self_contained_offline_and_resumable(tmp_path, monkeypatch):
    monkeypatch.setenv("JOBHUNT_WORKSPACE", str(tmp_path / "no-personal-workspace"))
    monkeypatch.setenv("JOBHUNT_SKILLS_DIR", str(tmp_path / "no-installed-skills"))
    monkeypatch.setenv("JOBMATCH_PRIVATE_DIR", str(tmp_path / "no-private-config"))
    attempts = []
    def blocked(*args, **kwargs):
        attempts.append(True)
        raise AssertionError("offline demo attempted networking")
    monkeypatch.setattr(socket.socket, "connect", blocked)
    monkeypatch.setattr(socket, "create_connection", blocked)
    load_verifier.cache_clear()
    out = tmp_path / "demo"
    first = run_demo(out, stop_after=1)
    assert first["simulation"] and first["execution_status"] == "interrupted"
    assert first["jobs"][0]["searches"] == 1 and first["jobs"][0]["repairs"] == 1
    resumed = run_demo(out, resume=True)
    assert resumed["mechanical_passed"] and resumed["calls_this_invocation"] == 2
    assert run_demo(out, resume=True)["calls_this_invocation"] == 0
    assert not attempts
    summary = json.loads((out / "demo-summary.json").read_text(encoding="utf-8"))
    assert summary["api_calls"] == 0 and summary["private_candidate_data_used"] is False
    assert resumed["selected_position_id"] is None and not resumed["readiness"]["can_register_selected_position"]
    assert "模拟模型" in (out / "demo-report.md").read_text(encoding="utf-8")
    load_verifier.cache_clear()


def test_demo_validator_has_pinned_source_and_license():
    assert demo_scripts() == VENDOR
    data = json.loads((VENDOR / "SOURCE.json").read_text(encoding="utf-8"))
    assert len(data["revision"]) == 40 and len(data["files"]) == 4
    assert "MIT License" in (VENDOR / "LICENSE").read_text(encoding="utf-8")


def test_demo_snapshot_matches_canonical_skill_when_available():
    import pytest
    from jobmatch.config import default_paths
    source = default_paths().matching_scripts
    if not (source / "verify-matching.py").is_file():
        pytest.skip("独立演示无需Skill；CI有规范来源时核对发布副本")
    data = json.loads((VENDOR / "SOURCE.json").read_text(encoding="utf-8"))
    for name in data["files"]:
        assert (source / name).read_bytes().replace(b"\r\n", b"\n") == (VENDOR / name).read_bytes().replace(b"\r\n", b"\n")
