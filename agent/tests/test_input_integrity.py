"""回归案例均为合成数据，验证输入保存和身份约束，不作为真人能力金标。"""

from jobmatch.corpus import _dedupe
from jobmatch.evaluation.pool import build_pool, same_company
from jobmatch.jd import clean_jd


def test_recruitment_context_and_link_requirement_survive():
    text = (
        "招聘项目：2027届校园招聘\n招聘性质：正式全职\n工作地点：上海\n"
        "请提供个人代码作品链接，例如 https://example.invalid/portfolio ，用于技术评审。\n"
        "来源URL：https://example.invalid/jobs/role-1\n抓取时间：2026-09-29\n"
        "学历要求：硕士及以上"
    )
    clean = clean_jd(text)
    for expected in ("2027届校园招聘", "正式全职", "工作地点：上海", "个人代码作品链接", "用于技术评审", "硕士及以上"):
        assert expected in clean
    assert "来源URL" not in clean and "抓取时间" not in clean


def test_near_duplicate_responsibility_and_numbers_are_not_merged():
    texts = [
        "参与开发数据处理服务，负责接口维护、异常处理及跨模块联调。",
        "独立开发数据处理服务，负责接口维护、异常处理及跨模块联调。",
        "数据接入七路相机，完成前视相机最小配置训练。",
        "数据接入七路相机，完成七路相机联合训练。",
    ]
    assert _dedupe(texts + [texts[0]]) == texts


def test_company_subject_cannot_be_guessed_from_prefix_or_brackets():
    assert not same_company("中国电科第三十六研究所", "中国电科第五十五研究所")
    assert not same_company("测试集团（甲公司）", "测试集团（乙公司）")
    assert not same_company("上海测试技术有限公司", "浙江测试技术有限公司")
    assert same_company("测试集团（甲公司）", " 测试集团(甲公司) ")


def item(company, identifier, title="软件开发", text=None):
    return {
        "company": company, "title": title, "position_id": identifier, "city": "测试市",
        "jd_text": text or ("需要 Python 和接口开发经验，负责模块开发与测试。" * 10),
        "state": "consider", "excluded": False, "exclusion_reason": "",
        "file": "/fixture/matching.json", "mtime": 1,
        "url": f"https://example.invalid/jobs/{identifier}",
    }


def test_same_jd_does_not_collapse_distinct_companies_or_positions():
    entries = build_pool([], [
        item("测试集团（甲公司）", "role-a"),
        item("测试集团（乙公司）", "role-b"),
        item("测试集团（甲公司）", "role-c"),
    ])
    assert len(entries) == 3
    assert len({e.eval_id for e in entries}) == 3


def test_title_similarity_is_not_enough_to_backfill_missing_jd():
    row = {"job_id": "job-local", "company": "测试公司", "job_title": "软件开发", "status": "Pending",
           "job_url": "", "job_description": ""}
    assert build_pool([row], [item("测试公司", "role-a")])[0].tracker is None


def test_explicit_official_identity_can_link_and_backfill():
    source = item("测试公司", "role-a")
    row = {"job_id": "job-local", "company": "测试公司", "job_title": "软件开发", "status": "Pending",
           "job_url": source["url"], "job_description": "", "matching_file": source["file"]}
    entries = build_pool([row], [source])
    assert len(entries) == 1 and entries[0].tracker["job_id"] == "job-local"
    assert entries[0].baseline["position_id"] == "role-a"


def test_same_official_url_without_bound_snapshot_does_not_backfill():
    source = item("测试公司", "role-a")
    row = {"job_id": "job-local", "company": "测试公司", "job_title": "软件开发", "status": "Pending",
           "job_url": source["url"], "job_description": ""}
    entries = build_pool([row], [source])
    assert len(entries) == 1 and entries[0].tracker is None


def test_conflicting_bound_records_are_not_resolved_by_mtime():
    a = item("测试公司", "role-a")
    b = {**a, "jd_text": a["jd_text"] + "必须博士毕业。", "mtime": 9}
    row = {"job_id": "job-local", "company": "测试公司", "status": "Pending",
           "job_url": a["url"], "job_description": "", "matching_file": a["file"]}
    audit = []
    entries = build_pool([row], [a, b], audit=audit)
    assert len(entries) == 2 and all(e.tracker is None for e in entries)
    assert audit[0]["identity_matches"] == 2


def test_provenance_retains_source_lines_and_original_hash():
    import hashlib
    from jobmatch.jd import prepare_jd

    raw = "# 招聘项目：2027届校园招聘\n来源：https://example.invalid\n熟悉 API\n能。\n学历要求：硕士及以上\n学历要求：硕士及以上\n"
    prepared = prepare_jd(raw, redact_text=True)
    assert prepared.audit()["provided_sha256"] == hashlib.sha256(raw.encode()).hexdigest()
    assert prepared.clauses == ["招聘项目：2027届校园招聘", "熟悉 API能。", "学历要求：硕士及以上"]
    assert [entry["source_lines"] for entry in prepared.line_map] == [[1], [3, 4], [5, 6]]


def test_corpus_preserves_english_word_boundaries():
    from jobmatch.corpus import Chunk, Corpus
    corpus = Corpus([Chunk("a", "项目", "now here", "fixture"), Chunk("b", "项目", "nowhere", "fixture")])
    assert len(corpus.chunks) == 2


def test_link_requirements_keep_semantics_without_credentials():
    from jobmatch.jd import prepare_jd
    raw = "请提供作品：https://user:fixture-password@example.invalid/demo?token=fixture-token&jobId=1234 ，用于评审。"
    text = prepare_jd(raw, redact_text=True).clean_text
    assert "请提供作品" in text and "用于评审" in text and "jobId=1234" in text
    assert "fixture-password" not in text and "fixture-token" not in text


def test_existing_pool_cannot_be_overwritten(tmp_path):
    import pytest
    from jobmatch.evaluation.pool import write_pool
    target = tmp_path / "pool.jsonl"
    target.write_bytes(b"old frozen dataset")
    with pytest.raises(FileExistsError):
        write_pool([], target)
    assert target.read_bytes() == b"old frozen dataset"
