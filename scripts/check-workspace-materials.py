"""Read-only material gate for client preflight; uses the installed Agent runtime."""
from pathlib import Path
import sys
import json

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'agent/src'))
from jobmatch.config import default_paths
from jobmatch.materials import inspect_materials

paths = default_paths()
result = inspect_materials(paths.profile_json, paths.project)
print(json.dumps(result, ensure_ascii=False))
sys.exit(0 if result['status'] == 'passed' else 1)
