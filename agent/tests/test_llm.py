from types import SimpleNamespace

import httpx
import pytest
from openai import AuthenticationError, RateLimitError

from jobmatch.llm import LLM, ModelConfig, ModelError


class Transport:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = 0
        self.chat = SimpleNamespace(completions=self)

    def create(self, **kwargs):
        self.calls += 1
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


def response():
    return SimpleNamespace(usage=SimpleNamespace(prompt_tokens=100, completion_tokens=20),
        choices=[SimpleNamespace(finish_reason="stop", message=SimpleNamespace(content='{"ok":true}', tool_calls=[]))])


def http_error(kind, status):
    return kind("synthetic credential echo must not appear", response=httpx.Response(status,
        request=httpx.Request("POST", "https://example.invalid")), body={})


def test_transient_errors_retry_and_usage_is_recorded():
    transport = Transport([http_error(RateLimitError, 429), response()])
    sleeps = []
    llm = LLM(ModelConfig("deepseek", "https://example.invalid", "fixture", "unused", 1, 2),
        transport=transport, sleep=sleeps.append)
    assert llm.chat([{"role": "user", "content": "JSON"}]).content == '{"ok":true}'
    assert transport.calls == 2 and len(sleeps) == 1
    assert llm.usage[0]["cost_cny"] == .00014


def test_auth_failure_never_retries_or_exposes_raw_error():
    transport = Transport([http_error(AuthenticationError, 401)])
    llm = LLM(ModelConfig("deepseek", "https://example.invalid", "fixture", "unused"), transport=transport)
    with pytest.raises(ModelError) as caught:
        llm.chat([])
    assert "synthetic" not in str(caught.value)
    assert transport.calls == 1


def test_truncation_records_the_actual_output_budget_without_accepting_partial_json():
    from jobmatch.llm import OutputTruncated
    reply = response()
    reply.choices[0].finish_reason = "length"
    reply.choices[0].message.content = '{"unfinished":'
    transport = Transport([reply])
    llm = LLM(ModelConfig("cpa", "https://example.invalid", "fixture", "unused", max_output_tokens=16384), transport=transport)
    with pytest.raises(OutputTruncated):
        llm.chat([])
    assert llm.usage[0]["max_output_tokens"] == 16384
    assert llm.usage[0]["finish_reason"] == "length"
