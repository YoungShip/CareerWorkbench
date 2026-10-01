"""Generate private workflow reference views from the canonical profile and rules."""
from pathlib import Path
import argparse
import hashlib
import json
import os
from uuid import uuid4


def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()


def atomic(path, value):
    text = json.dumps(value, ensure_ascii=False, indent=2) + "\n" if not isinstance(value, str) else value
    temp = path.with_name(path.name + ".workflow-view.tmp-" + uuid4().hex)
    try:
        temp.write_text(text, encoding="utf-8")
        os.replace(temp, path)
    finally:
        if temp.exists(): temp.unlink()


def generate(workspace):
    project = workspace / "CareerWorkbench"
    master_path = workspace / "lapis-cv/秋招/网申档案.json"
    rules_path = workspace / "lapis-cv/秋招/求职档案.md"
    master_bytes = master_path.read_bytes()
    data = json.loads(master_bytes.decode("utf-8-sig"))
    master_hash, rules_hash = hashlib.sha256(master_bytes).hexdigest(), digest(rules_path)
    header = (f"> 自动生成的只读参考；事实唯一来源：[网申母表]({master_path.as_posix()})。\n"
              f"> 当前选岗与经历边界：[求职档案]({rules_path.as_posix()})。\n"
              f"> 来源版本：{data.get('_版本')}；母表 SHA256：{master_hash}。\n\n")
    outputs = {}
    pointer = {"_schema": "career-workbench-profile-reference-v1", "_derived_only": True,
        "source_of_truth": master_path.as_posix(), "source_sha256": master_hash,
        "selection_rules_source": rules_path.as_posix(), "selection_rules_sha256": rules_hash,
        "read_fields_from_master": {"education": "教育经历", "work": "工作经历", "projects": "项目经历",
            "skills": "专业技能", "intent": "求职意向", "answers": "可复制文本", "patents": "学术成果",
            "basic_fields": "基本信息", "standard_answers": "_网申标准答案",
            "company_specific_answers": "_公司专项网申口径"},
        "resume_files": [{"version": key.removeprefix('简历_'), "file_path": (workspace/'lapis-cv'/name).as_posix()}
            for key, name in data["附件"].items() if key.startswith("简历_")],
        "project_index": [{"id": p['id'], "name": p['名称'], "source_field": f"项目经历[{i}]"}
            for i, p in enumerate(data['项目经历'])],
        "default_resume_selection": data['附件']['默认投递版本']}
    outputs['candidate_profile.json'] = pointer
    lines = ['# 经历选材入口\n\n', header,
        '本文件只索引当前经历，不独立维护事实、匹配分数或项目数量。按完整 JD 从母表选择相关经历，记录职责和证据边界。\n\n',
        '## 实习\n\n']
    for i, work in enumerate(data['工作经历']):
        if work.get('是否默认填写', True):
            lines.append(f"- {work.get('公司')}｜{work.get('职位')}：读取母表 `工作经历[{i}]` 的版本描述和正式日期。\n")
    lines += ['\n## 当前结构化项目\n\n', '| 项目 | 角色 | 方向提示 | 事实位置 |\n|---|---|---|---|\n']
    for i, p in enumerate(data['项目经历']):
        directions = '、'.join(p.get('匹配方向', [])) or '按 JD 与实际职责核对'
        lines.append(f"| {p['名称']} | {p.get('角色', '按母表核对')} | {directions} | `项目经历[{i}]` / `{p['id']}` |\n")
    lines += ['\n## 科研与专利\n\n',
        '- 硕士课题的已完成阶段、进行中事项和未验收结果分别读取母表 `硕士课题`。研究尚未结题不意味着所有阶段都不能引用；只陈述有来源的阶段成果。B 版启用与公司延后规则继续遵循求职档案。\n',
        '- 专利实际分工读取 `学术成果[].实际分工说明`，正式名单与排序读取对应结构化字段。排序不替代实际分工，也不据成果存在推断所有面试能力。\n',
        '\n投递时选择少量最相关经历；需要完整履历的表单按母表填写。提交内容与材料快照留在私有申请目录，再按主表协议登记。\n']
    outputs['experience_bank.md'] = ''.join(lines)
    lines = ['# 网申回答入口\n\n', header,
        '当前正文与字数版本由母表生成，不在本文件另存可能过期的回答。\n\n',
        f"- [A 版网申文本]({(workspace/'lapis-cv/秋招/网申文本-A-智驾仿真评测.txt').as_posix()})\n",
        f"- [C 版网申文本]({(workspace/'lapis-cv/秋招/网申文本-C-AI工程.txt').as_posix()})\n",
        f"- [资料总览]({(workspace/'lapis-cv/秋招/网申资料总览.md').as_posix()})\n\n",
        '## 按字段读取\n\n', '| 表单问题 | 母表位置 |\n|---|---|\n',
        '| 基本信息、成绩、综合排名、学习形式与家庭资料 | 对应结构化字段；同义口径补查 `_网申标准答案` 与 `_自动化规则`，证件及联系人按需读私密信息 |\n',
        '| 自我介绍、专业技能、自我评价、应聘动机 | `可复制文本` 中对应 A/C 和字数版本 |\n',
        '| 项目名称、角色、日期、简介、职责与成果 | `项目经历`，按适用版本和 JD 选择 |\n',
        '| 面试、调剂、出差、驻场、轮班和入职 | `求职意向` 的对应字段；选岗硬规则同时读求职档案 |\n',
        '| 薪资与工作资格等高影响字段 | 母表已确认值，按具体问题解释，不由旧回答推断 |\n',
        '| 公司已确认的月薪档、声明及专项表达 | `_公司专项网申口径`，先核公司、站点、批次与用途，不推广到其他公司 |\n',
        '| 专利自由描述 | `可复制文本.专利成果` |\n',
        '| 专利正式名单、排序及实际分工 | `学术成果` 对应结构化字段 |\n\n',
        '补问前查当前母表的结构化记录、标准答案、自动化规则、补充确认与按需私密来源；单个字段为空不代表事实缺失。已有同义且适用范围一致的本人确认直接复用；范围或含义不同不扩展。排名类型、学位与在读状态按原语义区分。公司专属问题结合官方 JD 和已确认经历表达。真正缺失的事实、高影响含义不明或未授权承诺交本人处理。最终提交遵循当前 AGENTS.md 的授权模式。\n']
    outputs['answer_bank.md'] = ''.join(lines)
    outputs['application_rules.md'] = ('# 申请规则入口\n\n' + header +
        '筛选条件、地域、薪资口径、面试方式、投递额度和机器人延后规则只读取求职档案的当前「选岗规则」；本文件不维护第二套阈值。\n\n' +
        data['附件']['默认投递版本'] + '\n\n' +
        f"授权与材料留存遵循 [AGENTS.md]({(workspace/'AGENTS.md').as_posix()}) 和安装的三个 Skill。新岗位须本人选定；真实提交凭据才登记 Submitted。\n\n" +
        '资料检查：运行 `jobmatch check-materials`。旧匹配记录用于新选岗前，可附 `--matching-file=<matching.json>` 检查冻结事实是否仍与母表一致。\n')
    for name, value in outputs.items(): atomic(project/name, value)
    if digest(master_path) != master_hash or digest(rules_path) != rules_hash:
        raise ValueError("资料生成期间母表或规则发生变化，请重新生成；未发布核验清单。")
    manifest = {'master_sha256': master_hash, 'rules_sha256': rules_hash,
        'outputs': {name: digest(project/name) for name in outputs}}
    target = project/'data/private/workflow-views-manifest.json'
    target.parent.mkdir(parents=True, exist_ok=True)
    atomic(target, manifest)
    return {'generated': list(outputs), 'source_sha256': master_hash}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--workspace', type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    print(json.dumps(generate(args.workspace.resolve()), ensure_ascii=False))
