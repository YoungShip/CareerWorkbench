"""校验器桥接：加载原工作流的 verify-matching.py（schema v2），不另写匹配规则。

生产使用工作区Skill；独立演示使用带来源和哈希的固定发布副本。

Agent 的「通过」与人工流程同一口径：机械校验通过（mechanical_passed）且该岗位 status=verified。
coverage 检查只针对全量目录抓取，单岗匹配固定声明 partial，它的 warning 不算失败。
"""

from __future__ import annotations

import importlib.util
import re
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from types import ModuleType
from typing import Any

from .config import default_paths

_REQUIREMENT_INDEX = re.compile(r"requirements\[(\d+)\]")


@lru_cache(maxsize=4)
def load_verifier(scripts_dir: Path | None = None) -> ModuleType:
    path = (scripts_dir or default_paths().matching_scripts) / "verify-matching.py"
    if not path.is_file():
        raise FileNotFoundError(f"找不到校验器 {path}；用 JOBHUNT_SKILLS_DIR 指向技能目录")
    spec = importlib.util.spec_from_file_location("jobmatch_verify_matching", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"无法加载 {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def summary(requirements: list[dict[str, Any]], scripts_dir: Path | None = None) -> dict[str, int]:
    """requirement_summary 由校验器同一函数计算，避免两处口径漂移。"""
    return load_verifier(scripts_dir).summary(requirements)


@dataclass
class Verification:
    report: dict[str, Any]
    position_id: str
    issues: list[dict[str, Any]] = field(default_factory=list)

    @property
    def position(self) -> dict[str, Any] | None:
        return next((p for p in self.report.get("positions", []) if p.get("id") == self.position_id), None)

    @property
    def passed(self) -> bool:
        position = self.position
        return bool(self.report.get("mechanical_passed")) and position is not None and position["status"] == "verified"

    @property
    def codes(self) -> list[str]:
        return [item["code"] for item in self.issues]

    def by_requirement(self) -> dict[int, list[dict[str, Any]]]:
        """按 requirements 下标归组，给纠错节点定位到具体条目；定位不到的归到 -1。"""
        grouped: dict[int, list[dict[str, Any]]] = {}
        for item in self.issues:
            match = _REQUIREMENT_INDEX.search(item.get("path", ""))
            grouped.setdefault(int(match.group(1)) if match else -1, []).append(item)
        return grouped


def blocking_issues(report: dict[str, Any]) -> list[dict[str, Any]]:
    """会让本岗位不通过的问题：去掉 coverage 类（单岗匹配固定是 partial）。"""
    return [
        item
        for item in report.get("issues", [])
        if item.get("check") != "coverage" and item.get("outcome") in {"failed", "unverified"}
    ]


def verify(record: dict[str, Any], matching_path: Path, position_id: str, scripts_dir: Path | None = None) -> Verification:
    report, _ = load_verifier(scripts_dir).validate_v2(record, matching_path)
    return Verification(report=report, position_id=position_id, issues=blocking_issues(report))
