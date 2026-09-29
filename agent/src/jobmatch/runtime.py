"""运行实现的内容指纹；包含未提交源码，避免仅记录旧 Git HEAD。"""

import hashlib
from pathlib import Path


class RunInterrupted(BaseException):
    """协作式中断，不被匹配器当作已完成的模型失败封存。"""


def source_fingerprint() -> str:
    root = Path(__file__).resolve().parent
    digest = hashlib.sha256()
    for source in sorted(root.rglob("*.py")):
        digest.update(str(source.relative_to(root)).replace("\\", "/").encode())
        digest.update(source.read_bytes())
    return digest.hexdigest()
