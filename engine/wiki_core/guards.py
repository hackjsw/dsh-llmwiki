"""Local credential filtering, independent of Hermes."""
import re

PATTERNS = [
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)",
    r"\b(?:sk-|ghp_|github_pat_|xox[baprs]-|AIza|hf_|npm_|pypi-|gsk_|xai-)[A-Za-z0-9_.=-]{10,}\b",
    r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b",
    r"\b\d{8,12}:[A-Za-z0-9_-]{30,}\b",
    r"(?i)\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|credential)\s*[\"']?\s*[:=]\s*[\"']?[^\s\"']+",
    r"(?im)^\s*(?:(?:>\s*)|(?:(?:[-+*]|\d+[.)])\s+)|(?:\[[ xX]\]\s+))*(?:cookie|set-cookie|authorization)\s*:[^\r\n]*",
    r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+",
    r"\b[a-z][a-z0-9+.-]*://[^\s/@:]+:[^\s/@]+@",
    r"(?:密码|密钥|令牌|验证码)\s*[:：=]\s*[^\s，。；]+",
]


def redact_sensitive_text(text, **_kwargs):
    for pattern in PATTERNS:
        text = re.sub(pattern, "[REDACTED]", text)
    return text


def scan_for_threats(text, **_kwargs):
    return bool(re.search(r"(?:忽略|无视|覆盖|绕过|泄露|输出|打印|透露).{0,40}(?:系统|开发者|上级|之前|先前).{0,20}(?:指令|提示|规则|提示词)", text))
