import json
from types import SimpleNamespace

from jobmatch.evaluation.pool import PoolEntry
from jobmatch.evaluation.run import run_batch


class FakeMatcher:
    retriever = SimpleNamespace(mode="hybrid")
    corpus = SimpleNamespace(version="fixture")
    llm = SimpleNamespace()

    def __init__(self):
        self.calls = 0

    def run(self, job, directory):
        self.calls += 1
        assert self.calls == 1
        result = {"job_id": job.id, "execution_status": "completed", "verification_passed": True, "decision": "pending"}
        directory.mkdir(parents=True)
        (directory / "result.json").write_text(json.dumps(result), encoding="utf-8")
        return result


def test_parallel_batch_keeps_sessions_separate_and_labels_out(tmp_path):
    entries = [PoolEntry(f"role-{i}", "Fixture", "Developer", "City", "Python", baseline={"state": "excluded"}) for i in range(8)]
    results = run_batch(FakeMatcher(), entries, tmp_path / "batch", model_name="fixture", workers=4, matcher_factory=FakeMatcher)
    assert len(results) == 8 and len({r["eval_id"] for r in results}) == 8
    manifest = json.loads((tmp_path / "batch/manifest.json").read_text())
    assert manifest["workers"] == 4 and manifest["labels_sent_to_model"] is False
