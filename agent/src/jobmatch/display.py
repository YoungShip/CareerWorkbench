"""工作台展示等级；保留上游证据分数，资格待核不等于技术弱相关。"""
from __future__ import annotations

import copy

POLICY_VERSION = "professional-fit-v2"


def apply_display_policy(summary: dict, record: dict) -> dict:
    result = copy.deepcopy(summary)
    positions = {p['id']: p for p in record['positions']}
    for item in result.get('positions', []):
        position = positions[item['id']]
        core = [r for r in position['requirements'] if r['category'] in {'hard_qualification', 'core_capability'}]
        score = item['evidence_match_percent']
        decision = item['decision']
        if position.get('excluded') or any(r['conclusion'] == 'not_satisfied' for r in core):
            grade = 'C'
        elif decision == 'recommended' and all(r['conclusion'] == 'satisfied' for r in core) and score >= 85:
            grade = 'S'
        elif score >= 75:
            grade = 'A'
        elif score >= 60 or decision == 'consider':
            grade = 'B'
        else:
            grade = 'C'
        item['upstream_grade'] = item.get('upstream_grade', item['grade'])
        item['grade'] = grade
        item['grade_policy'] = POLICY_VERSION
    result['grade_policy'] = POLICY_VERSION
    result['grade_scope'] = '专业证据适配；分数/决策/登记许可未改变，待核资格与本地申请条件仍须分别核查'
    return result
