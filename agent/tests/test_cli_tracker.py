import json
from types import SimpleNamespace

import pytest
from jobmatch.cli import query_tracker_job


def test_job_lookup_uses_locked_tracker_query_not_raw_csv(tmp_path, monkeypatch):
    calls = []
    def run(command, **kwargs):
        calls.append(command)
        return SimpleNamespace(returncode=0, stdout=json.dumps({
            "revision": "current-revision", "jobs": [{"job_id": "stable-id", "job_description": "完整JD"}]}))
    monkeypatch.setattr("jobmatch.cli.subprocess.run", run)
    result = query_tracker_job(SimpleNamespace(project=tmp_path), "stable-id")
    assert result["revision"] == "current-revision"
    assert calls[0][2] == "query" and "--job_id=stable-id" in calls[0]
    assert "--no_events" in calls[0]


def test_failed_tracker_read_does_not_fall_back_to_stale_csv(tmp_path, monkeypatch):
    monkeypatch.setattr("jobmatch.cli.subprocess.run", lambda *a, **k: SimpleNamespace(returncode=1))
    with pytest.raises(ValueError, match="只读查询失败"):
        query_tracker_job(SimpleNamespace(project=tmp_path), "missing")
