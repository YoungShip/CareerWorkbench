from jobmatch.config import resolve_artifact_path


def test_only_missing_old_workspace_artifacts_are_resolved(tmp_path):
    project = tmp_path / "CareerWorkbench"
    current = project / "data" / "jd.txt"
    current.parent.mkdir(parents=True)
    current.write_text("original evidence", encoding="utf-8")
    legacy = tmp_path / "JobHuntBot" / "data" / "jd.txt"
    assert resolve_artifact_path(legacy, project) == current
    assert resolve_artifact_path("relative.txt", project).as_posix() == "relative.txt"
    unrelated = tmp_path / "other" / "JobHuntBot" / "data" / "jd.txt"
    assert resolve_artifact_path(unrelated, project) == unrelated
    legacy.parent.mkdir(parents=True)
    legacy.write_text("independent old file", encoding="utf-8")
    assert resolve_artifact_path(legacy, project) == legacy
