"""路径配置。

默认按仓库布局推导：agent/ 在 CareerWorkbench/ 下，CareerWorkbench/ 在求职工作区下，
技能在工作区的 .agents/skills/。私有输入输出都放在 CareerWorkbench/data/private/，不入库。
CI 或其他机器用环境变量覆盖。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

AGENT_DIR = Path(__file__).resolve().parents[2]
PROJECT_DIR = AGENT_DIR.parent


def resolve_artifact_path(value: str | Path, project: Path | None = None) -> Path:
    """Resolve the former sibling directory for read-only historical artifacts."""
    value = Path(value)
    project = project or PROJECT_DIR
    if value.exists() or not value.is_absolute() or project.name != "CareerWorkbench":
        return value
    legacy = project.parent / "JobHuntBot"
    try:
        relative = value.relative_to(legacy)
    except ValueError:
        return value
    if ".." in relative.parts:
        return value
    candidate = project / relative
    return candidate if candidate.exists() else value


@dataclass(frozen=True)
class Paths:
    project: Path
    workspace: Path
    skills: Path
    private: Path

    @property
    def secrets(self) -> Path:
        return self.private / "secrets"

    @property
    def eval_dir(self) -> Path:
        return self.private / "eval"

    @property
    def runs_dir(self) -> Path:
        return self.private / "agent-runs"

    @property
    def corpus_dir(self) -> Path:
        return self.private / "agent-corpus"

    @property
    def tracker_csv(self) -> Path:
        """与 lib/tracker-git.js 的 locate 同序：JOBHUNT_DATA_DIR > 私有仓库 tracker/ 的专用 worktree > dashboard/。
        这里只读；需要最新数据时先跑一次 tracker-cli（会拉取）。"""
        if os.environ.get("JOBHUNT_DATA_DIR"):
            return Path(os.environ["JOBHUNT_DATA_DIR"]) / "job_pool.csv"
        if os.environ.get("JOBHUNT_TRACKER_GIT") != "0" and (self.workspace / "lapis-cv" / ".git").exists():
            worktree = os.environ.get("JOBHUNT_TRACKER_WORKTREE") or self.private / "tracker-worktree"
            return Path(worktree) / "tracker" / "job_pool.csv"
        return self.project / "dashboard" / "job_pool.csv"

    @property
    def research_tmp(self) -> Path:
        return self.workspace / "lapis-cv" / "tmp"

    @property
    def profile_json(self) -> Path:
        """网申母表：教育、工作、项目、技能等可引用事实。"""
        return self.workspace / "lapis-cv" / "秋招" / "网申档案.json"

    @property
    def profile_md(self) -> Path:
        """求职档案：取「经历与表述边界」一节。"""
        return self.workspace / "lapis-cv" / "秋招" / "求职档案.md"

    @property
    def extra_evidence(self) -> Path:
        """可选的补充证据（每行一条「- 」开头），用于母表尚未收录、本人确认过的经历。"""
        return self.corpus_dir / "extra-evidence.md"

    @property
    def models_dir(self) -> Path:
        return self.private / "models"

    @property
    def llm_config(self) -> Path:
        return self.secrets / "llm.json"

    @property
    def matching_scripts(self) -> Path:
        return self.skills / "campus-recruitment" / "scripts"


def default_paths() -> Paths:
    project = Path(os.environ.get("JOBHUNT_PROJECT_DIR", PROJECT_DIR))
    workspace = Path(os.environ.get("JOBHUNT_WORKSPACE", project.parent))
    skills = Path(os.environ.get("JOBHUNT_SKILLS_DIR", workspace / ".agents" / "skills"))
    private = Path(os.environ.get("JOBMATCH_PRIVATE_DIR", project / "data" / "private"))
    return Paths(project=project, workspace=workspace, skills=skills, private=private)
