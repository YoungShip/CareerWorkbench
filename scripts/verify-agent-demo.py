"""Verify the built wheel's offline demo in an isolated directory, with networking blocked."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import zipfile


def main():
    parser = argparse.ArgumentParser()
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--wheel", type=Path)
    source.add_argument("--wheel-dir", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    wheels = [args.wheel] if args.wheel else list(args.wheel_dir.glob("jobmatch-*.whl"))
    if len(wheels) != 1 or not wheels[0].is_file():
        raise ValueError("Provide exactly one built jobmatch wheel")
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=False)
    package = out / "package"
    package.mkdir()
    with zipfile.ZipFile(wheels[0]) as archive:
        for member in archive.infolist():
            target = (package / member.filename).resolve()
            if not target.is_relative_to(package):
                raise ValueError("Wheel contains an unsafe path")
            if member.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.read(member))
    (package / "sitecustomize.py").write_text(
        "import os,socket\n"
        "def blocked(*a,**k):\n"
        " with open(os.environ['DEMO_NETWORK_LOG'],'a',encoding='utf-8') as f:f.write('attempt\\n')\n"
        " raise RuntimeError('network blocked during offline demo verification')\n"
        "socket.socket.connect=blocked\nsocket.create_connection=blocked\n", encoding="utf-8")
    network_log = out / "network-attempts.txt"
    env = dict(os.environ)
    for key in ("OPENAI_API_KEY", "CPA_API_KEY", "DEEPSEEK_API_KEY", "DASHSCOPE_API_KEY", "LANGCHAIN_API_KEY"):
        env.pop(key, None)
    env.update(PYTHONPATH=str(package), JOBHUNT_WORKSPACE=str(out / "no-candidate"),
               JOBHUNT_SKILLS_DIR=str(out / "no-skills"), JOBMATCH_PRIVATE_DIR=str(out / "no-private-config"),
               LANGSMITH_TRACING="true", LANGCHAIN_TRACING_V2="true", LANGSMITH_API_KEY="synthetic-not-a-key",
               DEMO_NETWORK_LOG=str(network_log))
    def execute(label, command):
        result = subprocess.run([sys.executable, "-X", "utf8", *command], cwd=out, env=env,
                                capture_output=True, encoding="utf-8", timeout=60)
        (out / f"{label}.log").write_text(result.stdout + result.stderr, encoding="utf-8")
        if result.returncode:
            raise RuntimeError(f"{label} failed; inspect the isolated log")
        return result.stdout
    origin = execute("origin", ["-c", "import jobmatch;print(jobmatch.__file__)"]).strip()
    if not Path(origin).resolve().is_relative_to(package):
        raise ValueError("Demo imported checkout source instead of the built wheel")
    execute("benchmarks", ["-c", "from pathlib import Path;import jobmatch;from jobmatch.evaluation.semantic import load_cases;"
        "p=Path(jobmatch.__file__).parent/'resources'/'benchmarks';"
        "assert len(load_cases(p/'quality-pairs-v1.json')['cases'])==10;"
        "assert len(load_cases(p/'semantic-cases.json')['cases'])==10;print('packaged benchmarks verified')"])
    run = out / "run"
    execute("first", ["-m", "jobmatch.cli", "demo", "--out", str(run), "--stop-after", "1"])
    first = json.loads((run / "demo-summary.json").read_text(encoding="utf-8"))
    execute("resume", ["-m", "jobmatch.cli", "resume", "--run-dir", str(run)])
    resumed = json.loads((run / "demo-summary.json").read_text(encoding="utf-8"))
    execute("completed-resume", ["-m", "jobmatch.cli", "demo", "--out", str(run), "--resume"])
    finished = json.loads((run / "demo-summary.json").read_text(encoding="utf-8"))
    if (first["execution_status"] != "interrupted" or first["calls_this_invocation"] != 4 or
            resumed["execution_status"] != "completed" or resumed["calls_this_invocation"] != 2 or
            finished["calls_this_invocation"] != 0 or network_log.exists()):
        raise AssertionError("Offline recovery invariant failed")
    report = {"wheel": wheels[0].name, "imported_wheel": True, "private_inputs_absent": True,
              "network_attempts": 0, "scripted_calls_by_invocation": [4, 2, 0],
              "tool_searches": first["jobs"][0]["searches"], "repairs": first["jobs"][0]["repairs"],
              "status": "passed"}
    (out / "verification.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
