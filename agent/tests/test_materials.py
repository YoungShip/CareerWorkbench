import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from jobmatch.config import Paths
from jobmatch.materials import inspect_materials, matching_freshness, normalized_text, project_titles


@pytest.fixture
def material_workspace(tmp_path):
    project = tmp_path / "CareerWorkbench"
    materials = tmp_path / "lapis-cv"
    (materials / "秋招").mkdir(parents=True)
    project.mkdir()
    profile = materials / "秋招/网申档案.json"
    (materials / "resume.md").write_text("# Candidate\n\n## 项目经历\n<h3>AlphaProject</h3>\n- Implementation\n", encoding="utf-8")
    (materials / "resume.pdf").write_bytes(b"fixture-placeholder")
    (materials / "秋招/求职档案.md").write_text("## 选岗规则\n- 当前测试规则。\n", encoding="utf-8")
    data = {"_版本": "fixture", "工作经历": [], "项目经历": [{"id": "project_alpha", "名称": "AlphaProject",
        "网申文本组": "Alpha", "描述": ["Implementation"], "适用版本": ["C"]}],
        "可复制文本": {"Alpha": {"300": {"文本": "Implementation", "字符数": 14, "上限": 300}}},
        "附件": {"简历_C": "resume.pdf", "默认投递版本": "C"}, "_文本来源": {"原简历C": "resume.md"}}
    def save(value=data):
        profile.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    save()
    return SimpleNamespace(project=project, root=materials, profile=profile, data=data, save=save,
        paths=Paths(project, tmp_path, tmp_path / ".agents/skills", project / "data/private"))


def codes(report): return {x["code"] for x in report["errors"]}


def test_resume_project_missing_from_master_is_reported(material_workspace):
    w = material_workspace
    w.data["项目经历"] = []
    w.save()
    assert "RESUME_PROJECT_NOT_IN_MASTER" in codes(inspect_materials(w.profile, w.project, check_pdf=False))


def test_declared_alias_resolves_without_fuzzy_guessing(material_workspace):
    w = material_workspace
    w.data["项目经历"][0].update(名称="AlphaProject Full Name", 简历标题别名=["AlphaProject"])
    w.save()
    report = inspect_materials(w.profile, w.project, check_pdf=False)
    assert report["status"] == "passed"
    assert report["resumes"][0]["project_ids"] == ["project_alpha"]


def test_duplicate_project_identity_fails(material_workspace):
    w = material_workspace
    w.data["项目经历"].append(dict(w.data["项目经历"][0]))
    w.save()
    assert "PROJECT_ID_MISSING_OR_DUPLICATE" in codes(inspect_materials(w.profile, w.project, check_pdf=False))


def test_outdated_compatibility_description_fails(material_workspace):
    w = material_workspace
    w.data["项目经历"][0]["描述"] = ["Old description"]
    w.save()
    assert "PROJECT_DESCRIPTION_OUTDATED" in codes(inspect_materials(w.profile, w.project, check_pdf=False))


def test_wrong_text_count_or_declared_limit_fails(material_workspace):
    w = material_workspace
    w.data["可复制文本"]["Alpha"]["300"]["上限"] = 500
    w.save()
    assert "COPYTEXT_COUNT_OR_LIMIT" in codes(inspect_materials(w.profile, w.project, check_pdf=False))


def test_missing_attachment_fails(material_workspace):
    w = material_workspace
    (w.root / "resume.pdf").unlink()
    assert "ATTACHMENT_MISSING_OR_OUTSIDE_ROOT" in codes(inspect_materials(w.profile, w.project, check_pdf=False))


def test_pdf_old_text_fails_even_when_filename_and_size_match(material_workspace, monkeypatch):
    w = material_workspace
    monkeypatch.setattr("pypdf.PdfReader", lambda _: SimpleNamespace(pages=[SimpleNamespace(extract_text=lambda: "Old content")]))
    assert "RESUME_PDF_TEXT_OUTDATED" in codes(inspect_materials(w.profile, w.project))


def test_unicode_radicals_are_not_hidden_by_normalization(material_workspace, monkeypatch):
    w = material_workspace
    monkeypatch.setattr("pypdf.PdfReader", lambda _: SimpleNamespace(pages=[SimpleNamespace(extract_text=lambda: "⼈⼯")]))
    assert "RESUME_PDF_RADICAL_CHARACTERS" in codes(inspect_materials(w.profile, w.project))
    assert normalized_text("人工") != normalized_text("⼈⼯")


def test_stale_generated_output_is_reported(material_workspace):
    from jobmatch.materials import file_sha
    w = material_workspace
    w.data["_生成管理"] = {"输出": ["秋招/output.txt"]}
    w.save()
    target = w.root / "秋招/output.txt"
    target.write_text("old", encoding="utf-8")
    manifest = {"master_sha256": file_sha(w.profile), "outputs": {"秋招/output.txt": file_sha(target)}}
    (w.profile.parent / "资料生成核验.json").write_text(json.dumps(manifest), encoding="utf-8")
    target.write_text("edited", encoding="utf-8")
    assert "GENERATED_MATERIALS_OUTPUT_OUTDATED" in codes(inspect_materials(w.profile, w.project, check_pdf=False))


def test_derived_workflow_view_and_source_drift_is_reported(material_workspace):
    w = material_workspace
    file = Path(__file__).resolve().parents[2] / "scripts/generate-workflow-views.py"
    spec = importlib.util.spec_from_file_location("workflow_views_fixture", file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.generate(w.project.parent)
    assert inspect_materials(w.profile, w.project, check_pdf=False)["status"] == "passed"
    (w.project / "answer_bank.md").write_text("old policy", encoding="utf-8")
    report = inspect_materials(w.profile, w.project, check_pdf=False)
    assert "WORKFLOW_VIEW_OUTDATED" in codes(report)
    w.data["_版本"] = "new"
    w.save()
    assert "WORKFLOW_VIEWS_SOURCE_OUTDATED" in codes(inspect_materials(w.profile, w.project, check_pdf=False))


def test_matching_versions_are_current_stale_or_unknown(tmp_path):
    file = tmp_path / "matching.json"
    file.write_text(json.dumps({"positions": [{"candidate_source": {"profile_version": "corpus@old"}}]}))
    assert matching_freshness(file, "corpus@new")["status"] == "stale"
    assert matching_freshness(file, "corpus@old")["status"] == "current"
    file.write_text(json.dumps({"positions": [{"candidate_source": {"profile_version": "manual-v1"}}]}))
    assert matching_freshness(file, "corpus@new")["status"] == "unknown"


def test_inconsistent_materials_stop_before_model_construction(material_workspace, monkeypatch):
    from jobmatch.cli import make_matcher
    from jobmatch.llm import ModelConfig
    w = material_workspace
    w.data["项目经历"] = []
    w.save()
    monkeypatch.setattr("jobmatch.llm.load_config", lambda *a: ModelConfig("cpa", "https://example.invalid", "fixture", "fixture"))
    monkeypatch.setattr("jobmatch.materials.inspect_materials", lambda *a: {"status": "failed", "errors": [{"code": "RESUME_PROJECT_NOT_IN_MASTER"}]})
    def forbidden(*a, **k): raise AssertionError("model must not start")
    monkeypatch.setattr("jobmatch.llm.LLM", forbidden)
    with pytest.raises(ValueError, match="RESUME_PROJECT_NOT_IN_MASTER"):
        make_matcher(SimpleNamespace(provider="cpa", variant="full"), w.paths)


def test_project_link_label_is_not_part_of_identity():
    source = '## 项目经历\n<h3>AlphaProject <a href="https://example.invalid">GitHub</a></h3>\n## 专业技能\n'
    assert project_titles(source) == ["AlphaProject"]


def test_declared_resume_cannot_bypass_checks_by_deleting_source_pointer(material_workspace):
    w = material_workspace
    w.data["_文本来源"] = {}
    w.save()
    assert "RESUME_SOURCE_NOT_DECLARED" in codes(inspect_materials(w.profile, w.project, check_pdf=False))


def test_markdown_project_heading_cannot_bypass_master_check(material_workspace):
    w = material_workspace
    (w.root / "resume.md").write_text('## 项目经历\n### MissingProject [GitHub](https://example.invalid)\n- Work\n', encoding="utf-8")
    report = inspect_materials(w.profile, w.project, check_pdf=False)
    assert "RESUME_PROJECT_NOT_IN_MASTER" in codes(report)
    assert report["resumes"][0]["project_titles"] == ["MissingProject"]


def test_project_without_declared_copytext_group_is_incomplete(material_workspace):
    w = material_workspace
    del w.data["项目经历"][0]["网申文本组"]
    w.save()
    assert "PROJECT_COPYTEXT_GROUP_MISSING" in codes(inspect_materials(w.profile, w.project, check_pdf=False))


def test_partially_missing_matching_version_is_unknown(tmp_path):
    file = tmp_path / "matching.json"
    file.write_text(json.dumps({"positions": [{"candidate_source": {"profile_version": "corpus@current"}}, {}]}))
    assert matching_freshness(file, "corpus@current")["status"] == "unknown"


def test_view_generation_does_not_publish_manifest_for_changed_source(material_workspace, monkeypatch):
    w = material_workspace
    file = Path(__file__).resolve().parents[2] / "scripts/generate-workflow-views.py"
    spec = importlib.util.spec_from_file_location("workflow_views_changed_fixture", file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.generate(w.project.parent)
    manifest = w.project / "data/private/workflow-views-manifest.json"
    prior = manifest.read_bytes()
    original = module.atomic
    def change_after_view(path, value):
        original(path, value)
        if path.name == "candidate_profile.json":
            w.data["_版本"] = "changed-during-generation"
            w.save()
    monkeypatch.setattr(module, "atomic", change_after_view)
    with pytest.raises(ValueError, match="资料生成期间"):
        module.generate(w.project.parent)
    assert manifest.read_bytes() == prior
    assert "WORKFLOW_VIEWS_SOURCE_OUTDATED" in codes(inspect_materials(w.profile, w.project, check_pdf=False))
