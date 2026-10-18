"""回归案例均为合成数据，验证输入保存和身份约束，不作为真人能力金标。"""

from jobmatch.corpus import _dedupe
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

