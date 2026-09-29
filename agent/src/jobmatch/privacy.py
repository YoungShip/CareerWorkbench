"""发给模型前的脱敏：手机号、邮箱、证件号一律替换。

证据库本身按白名单取字段、不读联系方式；这里是第二道保险，JD 正文也过一遍（JD 里常有 HR 邮箱电话）。
"""

from __future__ import annotations

import re

_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_ID_CARD = re.compile(r"(?<!\d)\d{17}[\dXx](?![\dA-Za-z])")
_MOBILE = re.compile(r"(?<!\d)(?:\+?86[- ]?)?1[3-9]\d(?:[- ]?\d{4}){2}(?!\d)")
_URL_USERINFO = re.compile(r"(https?://)[^/\s@]+@", re.I)
_URL_SECRET = re.compile(r"([?&#](?:access_token|refresh_token|token|api[_-]?key|key|secret|password|pwd|signature|sig|auth|authorization|code)=)[^&#\s\"<>，。；）]*", re.I)


def redact(text: str) -> str:
    text = _URL_USERINFO.sub(r"\1[redacted]@", text)
    text = _URL_SECRET.sub(r"\1[redacted]", text)
    text = _EMAIL.sub("[邮箱已隐去]", text)
    text = _ID_CARD.sub("[证件号已隐去]", text)
    return _MOBILE.sub("[手机号已隐去]", text)
