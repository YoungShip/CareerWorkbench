import pytest

from jobmatch.corpus import Chunk, Corpus
from jobmatch.llm import Reply


@pytest.fixture
def corpus():
    return Corpus([
        Chunk("python", "项目", "开发 Python 数据处理与 FastAPI 接口。", "fixture"),
        Chunk("robot", "项目", "运行开源机器人推理示例。", "fixture"),
        Chunk("limit", "边界", "未独立训练机器人策略，不能把开源示例说成独立训练。", "fixture"),
    ])


class FakeLLM:
    def __init__(self, replies):
        self.replies = list(replies)
        self.requests = []
        self.usage = []

    def chat(self, messages, **kwargs):
        self.requests.append((messages, kwargs))
        value = self.replies.pop(0)
        if isinstance(value, BaseException):
            raise value
        return value if isinstance(value, Reply) else Reply(value)
