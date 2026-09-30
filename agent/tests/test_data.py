import json

import pytest

from jobmatch.corpus import build_corpus
from jobmatch.jd import clean_jd, split_clauses
from jobmatch.llm import ModelError, load_config, parse_json, structured
from jobmatch.schemas import Extraction

from conftest import FakeLLM


def test_profile_whitelist_and_negative_evidence(tmp_path):
    # 合成测试值；证件的地区/日期无效，邮箱使用保留域名。
    mobile = "139" + "0" * 8
    identity = "99" + "0" * 15 + "X"
    profile = {
        "基本信息": {"移动电话": mobile, "电子邮箱": "private@example.invalid", "证件号码": identity},
        "家庭成员": [{"姓名": "不能流出"}],
        "教育经历": [{"id": "edu", "学历": "硕士研究生", "学校": "测试大学", "专业": "计算机", "开始": "2024", "结束": "2027",
                    "学位名称": "硕士", "学位说明": "在读，尚未毕业", "日期状态": "常规暂用值", "研究方向": "合成机器人学习课题"}],
        "工作经历": [{"id": "hidden", "公司": "不默认公司", "是否默认填写": False, "描述": "不该出现"}],
        "项目经历": [{"id": "project", "名称": "开发工具", "描述": "完成接口开发。联系 abc@example.invalid",
            "边界": "AI 辅助实现，不称独立手写。"}],
    }
    p, m = tmp_path / "profile.json", tmp_path / "rules.md"
    p.write_text(json.dumps(profile), encoding="utf-8")
    m.write_text("## 经历与表述边界\n- 数据库仅课程接触。\n- 专利未授权，按公开填写，不改变署名顺序。\n## 其他\n- 不得进入语料。\n", encoding="utf-8")
    corpus = build_corpus(p, m)
    assert "课程接触" in corpus.snapshot and "AI 辅助" in corpus.snapshot
    assert "在读，尚未毕业" in corpus.snapshot and "常规暂用值" in corpus.snapshot and "专利未授权" in corpus.snapshot
    assert "研究方向：合成机器人学习课题" in corpus.snapshot
    for forbidden in (mobile, identity, "private@example.invalid", "abc@example.invalid", "不该出现", "不能流出", "不得进入语料"):
        assert forbidden not in corpus.snapshot


def test_jd_cleaning_keeps_requirements_and_nested_numbers():
    text = "工作地点：无锡；学历：本科及以上；招聘项目：校招\n职位描述\n1、学历要求：统招本科学历\n熟悉接口（API网关）。\n5-1. 熟悉 Python。\n来源：https://example.invalid"
    cleaned = clean_jd(text)
    assert "学历：本科及以上" in cleaned and "统招本科学历" in cleaned and "API网关" in cleaned
    assert "招聘项目：校招" in cleaned and "https://" not in cleaned
    assert "5-1. 熟悉 Python。" in split_clauses(text)


def test_patent_order_does_not_hide_candidate_reported_work(tmp_path):
    profile = {"学术成果": [{"名称": "合成专利", "类型": "发明专利", "状态": "已公开、尚未授权",
        "发明人排序": 2, "发明人总人数": 5,
        "实际分工说明": "本人说明：实际工作由本人完成，导师按署名安排列第一。"}]}
    source, rules = tmp_path / "profile.json", tmp_path / "rules.md"
    source.write_text(json.dumps(profile, ensure_ascii=False), encoding="utf-8")
    rules.write_text("## 经历与表述边界\n- 正式署名按公开顺序填写。\n", encoding="utf-8")
    corpus = build_corpus(source, rules)
    patent = corpus.get("ip_1")
    assert "第 2 发明人（共 5 人）" in patent.text
    assert "本人说明：实际工作由本人完成" in patent.text
    assert "已公开、尚未授权" in patent.text


def test_missing_key_is_explicit_and_config_repr_hides_key(tmp_path, monkeypatch):
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    with pytest.raises(ModelError, match="未配置模型 Key"):
        load_config(tmp_path / "missing.json")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "not-a-real-key")
    assert "not-a-real-key" not in repr(load_config(tmp_path / "missing.json"))


def test_json_does_not_accept_prose_or_trailing_payload():
    assert parse_json(chr(96) * 3 + 'json\n{"a":1}\n' + chr(96) * 3) == {"a": 1}
    with pytest.raises(ValueError):
        parse_json('ignore this {"a":1}')
    with pytest.raises(ValueError):
        parse_json('{"a":1} {"b":2}')


def test_schema_retry_is_bounded():
    client = FakeLLM(['{"requirements":[]}', '{"requirements":[]}'])
    with pytest.raises(ModelError):
        structured(client.chat, [{"role": "user", "content": "JSON"}], Extraction)
    assert len(client.requests) == 2


def test_truncation_retries_once_without_accepting_partial_json():
    from jobmatch.llm import OutputTruncated
    valid = json.dumps({"requirements": [{"text": "Python", "category": "core_capability", "jd_lines": [1], "category_basis_lines": [1]}]})
    client = FakeLLM([OutputTruncated("partial"), valid])
    assert structured(client.chat, [], Extraction).requirements[0].text == "Python"
    assert len(client.requests) == 2
    client = FakeLLM([OutputTruncated("partial")] * 2)
    with pytest.raises(OutputTruncated):
        structured(client.chat, [], Extraction)
    assert len(client.requests) == 2


def test_cpa_model_must_be_explicit(tmp_path, monkeypatch):
    monkeypatch.delenv("CPA_API_KEY", raising=False)
    path = tmp_path / "models.json"
    data = {"active": "cpa", "providers": {"cpa": {"api_key": "fixture", "base_url": "http://127.0.0.1:8317/v1"}}}
    path.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(ModelError, match="实际模型 ID"):
        load_config(path)
    data["providers"]["cpa"]["model"] = "fixture-model"
    path.write_text(json.dumps(data), encoding="utf-8")
    assert load_config(path).model == "fixture-model"
