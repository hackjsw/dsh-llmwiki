from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import secrets
import sqlite3
import stat
import time
import unicodedata
from contextlib import closing
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Dict, Iterable, List, Optional

import yaml

if os.name == "nt":
    from . import winfs as os


logger = logging.getLogger(__name__)

_AUTO_RECALL_DIRS = {"entities", "concepts", "comparisons", "queries"}
_HISTORICAL_DIRS = {"raw", "archive", "_archive"}
_NAVIGATION_FILES = {"SCHEMA.md", "index.md", "log.md"}
_CURRENT_STATE = "CURRENT_STATE.md"
_DEFAULT_MAX_RESULTS = 3
_DEFAULT_MAX_CHARS = 5000
_DEFAULT_MAX_TOKENS = 5000
_DEFAULT_MAX_FILE_BYTES = 262_144
_REVIEW_ACTIONS = {"approve": "approved", "reject": "rejected"}
_CANDIDATE_COUNT_THRESHOLD = 20
_CANDIDATE_AGE_THRESHOLD_DAYS = 14
_DERIVED_INDEX_FILENAME = "llm-wiki.sqlite"
_DERIVED_INDEX_SCHEMA_VERSION = 3
_EVIDENCE_WARNING = "Historical or unhealthy content is evidence only, not current truth."
_SENSITIVE_PATTERNS = (
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"\b\d{8,12}:[A-Za-z0-9_-]{30,}\b"),
    re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"),
    re.compile(
        r"\b(?:sk-|ghp_|github_pat_|xox[baprs]-|AIza|hf_|npm_|pypi-|gsk_|xai-)"
        r"[A-Za-z0-9_.=-]{10,}\b"
    ),
    re.compile(
        r"(?i)\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)"
        r"\s*[:=]\s*[^\s]{8,}"
    ),
    re.compile(
        r"(?im)^[ \t]*(?:(?:>[ \t]*)|(?:(?:[-+*]|[0-9]+[.)])[ \t]+)|"
        r"(?:\[[ xX]\][ \t]+))*"
        r"(?:cookie|set-cookie)[ \t]*:"
    ),
)
_INJECTION_PATTERNS = (
    re.compile(r"(?i)\b(?:ignore|disregard|override)\b.{0,40}\b(?:instructions?|rules?|prompt)\b"),
    re.compile(
        r"(?i)\b(?:reveal|show|print|exfiltrate|leak)\b.{0,40}"
        r"\b(?:system|developer|hidden|internal)\s+(?:prompt|instructions?|rules?)\b"
    ),
)
# ponytail: conservative regex privacy scan, not a general PII framework.
# Explicit private-network IPs, connection strings, and labelled ports in
# canonical content; values are not emitted, only stable issue codes.
_PRIVATE_IP_RE = re.compile(
    r"(?<!\d)(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}"
    r"|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}"
    r"|192\.168\.\d{1,3}\.\d{1,3}"
    r"|127\.\d{1,3}\.\d{1,3}\.\d{1,3})(?!\d)"
)
_CONNECTION_STRING_RE = re.compile(
    r'''(?i)\b[a-z][a-z0-9+.-]{1,20}://[^\s"'<>]*[:@][^\s"'<>]{3,}'''
)
_PORT_LABEL_RE = re.compile(
    r"(?i)(?:\b(?:port|listen|bind)\b|端口|监听)[^\n]{0,20}?(?<!\d)\d{1,5}(?!\d)"
)


def canonical_privacy_issues(text: str) -> List[str]:
    """Detect private-network details in canonical content; emit issue codes only.

    Conservative: explicit private IPs, scheme://connection-strings, and ports
    labelled by port/端口/listen/bind. Years, dates, public URLs, and version
    numbers are deliberately not flagged.
    """
    issues = []
    if _PRIVATE_IP_RE.search(text):
        issues.append("canonical.privacy.private_ip")
    if _CONNECTION_STRING_RE.search(text):
        issues.append("canonical.privacy.connection_string")
    if _PORT_LABEL_RE.search(text):
        issues.append("canonical.privacy.private_port")
    return issues


_CURRENT_QUERY_RE = re.compile(
    r"(?:\u73b0\u5728|\u5f53\u524d|\u76ee\u524d|\u6700\u65b0|\u73b0\u72b6|\u662f\u5426\u5df2\u7ecf|\u662f\u5426\u8fd8|\u8fd8\u5728|\u5df2\u542f\u7528|\u6b63\u5728|"
    r"\bcurrent\b|\blatest\b|\bstatus\b|\bright now\b)",
    re.IGNORECASE,
)
# "what's the current status?" carries no topic, so CURRENT_STATE answers it directly; any other
# words left after removing these make it a topic question that must pass the relevance gate.
_BARE_STATUS_RE = re.compile(
    r"(?:\bwhat(?:'s| is)?\b|\bthe\b|\bis\b|\bcurrent(?:ly)?\b|\blatest\b|\bstatus\b|\bstate\b|\bnow\b|"
    r"\bright\b|\bhow\b|\bare\b|\bthings\b|\u73b0\u5728|\u5f53\u524d|\u76ee\u524d|\u6700\u65b0|\u73b0\u72b6|\u72b6\u6001|\u60c5\u51b5|\u600e\u4e48\u6837|\u600e\u6837|\u5982\u4f55|\u662f\u4ec0\u4e48|\u662f|\u4ec0\u4e48|\u7684|\u4e86|\u5417|\u5462|\u554a)",
    re.IGNORECASE,
)


def _is_bare_status_query(query: str) -> bool:
    remainder = _BARE_STATUS_RE.sub(" ", _normalized(query))
    return not re.search(r"[0-9a-z\u3400-\u9fff]", remainder)


# Automatic recall must not fire on incidental overlap: these function-word bigrams and
# English stopwords never count toward relevance on their own.
_DEFAULT_MIN_RECALL_SCORE = 6
_CONSOLIDATE_MODES = ("off", "shadow", "on")
# Automation never writes these; humans own them.
_PROTECTED_PATHS = frozenset({_CURRENT_STATE, "SCHEMA.md", "index.md", "log.md"})
_SCOPE_RE = re.compile(r"profile:[a-z0-9_-]{1,64}")
_INDEX_BLOCK_START = "<!-- llm-wiki:auto-index:start -->"
_INDEX_BLOCK_END = "<!-- llm-wiki:auto-index:end -->"
_RECALL_STOPWORDS = frozenset(
    {
        "今天", "明天", "昨天", "现在", "什么", "怎么", "么样", "怎样", "为什", "为何",
        "一下", "一个", "这个", "那个", "这样", "那样", "可以", "我们", "你们", "他们",
        "帮我", "给我", "是不", "不是", "有没", "没有", "如何", "哪里", "哪个", "一些",
        "还是", "或者", "然后", "因为", "所以", "如果", "的话", "就是", "已经", "进行",
        "需要", "应该", "能不", "不能", "请问", "问题", "情况", "东西", "一点", "看看",
        "是否", "知道", "觉得", "时候", "我的", "你的", "他的", "的是", "了吗",
        "the", "and", "for", "with", "what", "how", "this", "that", "you", "are",
        "can", "please", "help", "is", "it", "to", "of", "in", "on", "me", "my",
    }
)


class WikiError(RuntimeError):
    pass


class WikiAccessError(WikiError):
    pass


class WikiConflictError(WikiError):
    """A page changed between read and write; the caller should re-plan, not overwrite."""


def _render_markdown(metadata: Dict[str, Any], body: str) -> str:
    """Same layout propose()/review_candidate() use, so candidate byte checks stay stable."""
    return (
        "---\n"
        + yaml.safe_dump(metadata, allow_unicode=True, sort_keys=False).strip()
        + "\n---\n\n"
        + body.strip()
        + "\n"
    )


def _set_frontmatter_fields(text: str, fields: Dict[str, Any]) -> str:
    """Replace or append single-line top-level keys, leaving hand-written YAML untouched."""
    if not text.startswith("---\n"):
        raise WikiAccessError("page frontmatter is not editable in place")
    end = text.find("\n---\n", 4)
    if end < 0:
        raise WikiAccessError("page frontmatter is not editable in place")
    head = text[4:end].split("\n")
    for key, value in fields.items():
        line = f"{key}: {json.dumps(value, ensure_ascii=False)}"
        for index, existing in enumerate(head):
            if existing.startswith(f"{key}:"):
                if index + 1 < len(head) and head[index + 1].startswith((" ", "-")):
                    raise WikiAccessError(f"frontmatter key {key} is not a single line")
                head[index] = line
                break
        else:
            head.append(line)
    return "---\n" + "\n".join(head) + text[end:]


def _append_record(text: str, record_line: str) -> str:
    """Append one dated line under the trailing `## 记录` section, creating it if absent."""
    body = text.rstrip("\n")
    if "\n## 记录\n" not in body:
        body += "\n\n## 记录\n"
    return body + "\n" + record_line.strip() + "\n"


@dataclass(frozen=True)
class WikiSettings:
    profile_root: Path
    wiki_path: Path
    max_results: int = _DEFAULT_MAX_RESULTS
    max_chars: int = _DEFAULT_MAX_CHARS
    max_file_bytes: int = _DEFAULT_MAX_FILE_BYTES
    propose_enabled: bool = False
    shared_wiki_path: Path | None = None
    min_recall_score: int = _DEFAULT_MIN_RECALL_SCORE
    profile_name: str = "default"
    auto_capture: bool = False
    extract_every_turns: int = 10
    consolidate: str = "off"
    add_min_confidence: float = 0.8
    update_min_confidence: float = 0.7


@dataclass(frozen=True)
class MarkdownDocument:
    path: Path
    relative_path: str
    metadata: Dict[str, Any]
    body: str
    title: str
    aliases: List[str]
    tags: List[str]
    authority: str


@dataclass(frozen=True)
class _IndexedCandidates:
    documents: List[tuple[str, str]]


def _coerce_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
    if isinstance(value, (int, float)):
        return bool(value)
    return default


def _bounded_int(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(maximum, parsed))


def _bounded_float(value: Any, default: float, minimum: float, maximum: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        parsed = default
    if parsed != parsed:  # NaN
        parsed = default
    return max(minimum, min(maximum, parsed))


def profile_name_for(home: Path) -> str:
    """`profiles/<name>` homes are that profile; the root Hermes home is `default`."""
    home = Path(home)
    if home.parent.name == "profiles":
        return home.name.casefold()
    return "default"


def scope_of(metadata: Dict[str, Any]) -> str:
    """`shared` (also when absent), `profile:<name>`, or `invalid` (never visible)."""
    raw = str(metadata.get("scope") or "shared").strip().casefold()
    if raw == "shared" or _SCOPE_RE.fullmatch(raw):
        return raw
    return "invalid"


def scope_visible(metadata: Dict[str, Any], profile: str) -> bool:
    scope = scope_of(metadata)
    return scope == "shared" or scope == f"profile:{profile}"


def _confined_profile_path(home: Path, value: Any) -> Path:
    """Resolve a profile-owned path without allowing symlink/profile escape."""
    home = home.expanduser().resolve()
    raw = Path(str(value)).expanduser()
    candidate = raw if raw.is_absolute() else home / raw
    candidate = Path(os.path.abspath(candidate))
    try:
        relative = candidate.relative_to(home)
    except ValueError as exc:
        raise WikiAccessError("wiki_path must stay within the active Hermes profile") from exc
    if any(part in {"", ".", ".."} for part in relative.parts):
        raise WikiAccessError("wiki_path must stay within the active Hermes profile")
    current = home
    for part in relative.parts:
        current = current / part
        if current.is_symlink() or (hasattr(current, "is_junction") and current.is_junction()):
            raise WikiAccessError("symbolic links are not allowed in profile-owned wiki paths")
        if not current.exists():
            break
    resolved = candidate.resolve(strict=False)
    try:
        resolved.relative_to(home)
    except ValueError as exc:
        raise WikiAccessError("wiki_path resolves outside the active Hermes profile") from exc
    return candidate


def _estimate_tokens(text: str) -> int:
    """Estimate token count using a language-aware upper bound.

    ASCII text is estimated at 1 byte per token.  Non-ASCII text (primarily
    CJK) is estimated at 1.5 bytes per token, which approximates modern
    BPE tokenizers where one Chinese character typically costs 1–1.5 tokens
    (3–4.5 UTF-8 bytes).  The result is a conservative upper bound that
    avoids underestimating token usage while not penalising CJK content as
    severely as a raw byte count.
    """
    encoded = text.encode("utf-8")
    ascii_bytes = 0
    non_ascii_bytes = 0
    for byte in encoded:
        if byte < 0x80:
            ascii_bytes += 1
        else:
            non_ascii_bytes += 1
    return ascii_bytes + (non_ascii_bytes * 2 + 2) // 3


def _truncate_recall(text: str, *, max_chars: int, max_tokens: int) -> str:
    if len(text) <= max_chars and _estimate_tokens(text) <= max_tokens:
        return text
    marker = "\n[... truncated]"
    low, high = 0, min(len(text), max_chars)
    while low < high:
        middle = (low + high + 1) // 2
        candidate = text[:middle].rstrip() + marker
        if len(candidate) <= max_chars and _estimate_tokens(candidate) <= max_tokens:
            low = middle
        else:
            high = middle - 1
    return text[:low].rstrip() + marker


def _guard_text(*values: str, subject: str) -> None:
    combined = "\n".join(values)
    normalized = unicodedata.normalize("NFKC", combined)
    scan_text = " ".join(normalized.split())
    metadata_scan = re.sub(r'"([^"\\]+)"\s*:', r"\n\1:", normalized)
    if any(
        pattern.search(scan_target)
        for pattern in _SENSITIVE_PATTERNS
        for scan_target in (normalized, metadata_scan)
    ):
        raise WikiAccessError(f"{subject} appears to contain a credential or secret")
    try:
        from .guards import redact_sensitive_text

        redacted = redact_sensitive_text(
            combined,
            force=True,
            file_read=True,
            redact_url_credentials=True,
        )
    except Exception as exc:
        raise WikiAccessError(f"{subject} credential scanner is unavailable") from exc
    if redacted != combined:
        raise WikiAccessError(f"{subject} appears to contain a credential or secret")
    if any(pattern.search(scan_text) for pattern in _INJECTION_PATTERNS):
        raise WikiAccessError(
            f"{subject} contains instruction-injection or exfiltration text"
        )
    try:
        from .guards import scan_for_threats

        findings = scan_for_threats(scan_text, scope="strict")
    except Exception as exc:
        raise WikiAccessError(f"{subject} threat scanner is unavailable") from exc
    if findings:
        raise WikiAccessError(
            f"{subject} contains instruction-injection or exfiltration text"
        )


def _candidate_normal_form(text: str) -> str:
    """Return deterministic Unicode/case/whitespace normalization, not semantics."""
    return " ".join(unicodedata.normalize("NFKC", str(text)).casefold().split())


def _content_fingerprint(title: str, content: str, page_type: str) -> str:
    """Identity of a claim: who proposed it, when, and why never make it a new claim."""
    return hashlib.sha256(
        json.dumps(
            {
                "title": _candidate_normal_form(title),
                "content": _candidate_normal_form(content),
                "page_type": str(page_type),
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()


def _candidate_content(document: "MarkdownDocument") -> str:
    """Body as written by propose(), without its generated title heading."""
    return document.body.removeprefix(f"# {document.title}\n\n").strip()


_FACT_KINDS = ("preference", "project", "procedure", "entity", "decision", "fact")
_SLUG_RE = re.compile(r"[a-z0-9][a-z0-9-]{1,62}[a-z0-9]")


def _validated_facets(facets: Dict[str, Any], profile: str) -> Dict[str, Any]:
    """Structured extraction fields; unknown keys are dropped, bad values raise."""
    out: Dict[str, Any] = {}
    if "kind" in facets:
        if facets["kind"] not in _FACT_KINDS:
            raise WikiAccessError("unsupported fact kind")
        out["kind"] = facets["kind"]
    if "confidence" in facets:
        out["confidence"] = round(_bounded_float(facets["confidence"], 0.0, 0.0, 1.0), 2)
    if "volatility" in facets:
        if facets["volatility"] not in ("operational", "stable"):
            raise WikiAccessError("volatility must be operational or stable")
        out["volatility"] = facets["volatility"]
    if "scope" in facets:
        scope = str(facets["scope"]).strip().casefold()
        if scope not in ("shared", f"profile:{profile}"):
            raise WikiAccessError("a candidate may only be shared or scoped to its own profile")
        out["scope"] = scope
    if facets.get("slug"):
        slug = str(facets["slug"]).strip().casefold()
        if not _SLUG_RE.fullmatch(slug):
            raise WikiAccessError("slug must be lowercase ASCII words joined by hyphens")
        out["slug"] = slug
    if facets.get("evidence_quote"):
        out["evidence_quote"] = " ".join(str(facets["evidence_quote"]).split())[:200]
    return out


def _utc_now(value: Optional[datetime] = None) -> datetime:
    current = value or datetime.now(timezone.utc)
    if current.tzinfo is None:
        raise ValueError("now must include a timezone")
    return current.astimezone(timezone.utc)


def _parse_utc_timestamp(value: Any, *, allow_date: bool = False) -> datetime:
    text = str(value).strip()
    if allow_date and re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", text):
        # Date-only verification metadata is the start of that UTC day, not a renewal.
        return datetime.combine(date.fromisoformat(text), datetime.min.time(), timezone.utc)
    if not re.fullmatch(
        r"[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt ][0-9]{2}:[0-9]{2}:[0-9]{2}"
        r"(?:\.[0-9]{1,6})?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])", text
    ):
        raise ValueError("expected an ISO timestamp with timezone")
    return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(timezone.utc)


def _current_state_freshness(
    document: "MarkdownDocument", *, now: Optional[datetime] = None
) -> Dict[str, Any]:
    """Check canonical expiry; only CURRENT_STATE requires a revalidation command."""
    expiry_text = str(document.metadata.get("expires_at") or "").strip()
    command = str(document.metadata.get("revalidation_command") or "").strip()
    reason = ""
    expiry: Optional[datetime] = None
    if not expiry_text:
        reason = "missing_expires_at"
    else:
        try:
            expiry = _parse_utc_timestamp(expiry_text)
        except (TypeError, ValueError, OverflowError):
            reason = "invalid_expires_at"
    if document.relative_path == _CURRENT_STATE and (
        not command or len(command) > 2048 or "\n" in command or "\r" in command
    ):
        if not reason:
            reason = "invalid_revalidation_command"
        command = ""
    current = _utc_now(now)
    review_class = document.metadata.get("review_class")
    if not reason:
        if "review_class" not in document.metadata:
            reason = "missing_review_class"
        elif review_class not in ("operational", "stable"):
            reason = "invalid_review_class"
    if not reason:
        if "last_verified_at" not in document.metadata:
            reason = "missing_last_verified_at"
        else:
            try:
                verified = _parse_utc_timestamp(document.metadata["last_verified_at"], allow_date=True)
                if verified > current:
                    reason = "future_last_verified_at"
                elif review_class and expiry is not None:
                    days = 30 if review_class == "operational" else 365
                    expiry = min(expiry, verified + timedelta(days=days))
            except (TypeError, ValueError, OverflowError):
                reason = "invalid_last_verified_at"
    if not reason and expiry is not None and current >= expiry:
        reason = "expired"
    return {
        "authority": document.authority,
        "expires_at": expiry_text,
        "stale": bool(reason),
        "staleness_reason": reason,
        "revalidation_command": command,
    }


def _canonical_issues(
    document: MarkdownDocument, *, now: Optional[datetime] = None
) -> List[str]:
    if document.authority != "canonical":
        return []
    freshness = _current_state_freshness(document, now=now)
    prefix = "current_state" if document.relative_path == _CURRENT_STATE else "canonical"
    issues = (
        [f"{prefix}.{freshness['staleness_reason']}"] if freshness['stale'] else []
    )
    if scope_of(document.metadata) == "invalid":
        issues.append("canonical.invalid_scope")
    # Decision 3: private-network ops facts may live in profile-scoped pages; shared pages stay clean.
    if scope_of(document.metadata) == "shared":
        privacy_text = " ".join(
            [
                document.title,
                " ".join(document.aliases),
                document.body,
            ]
        )
        issues.extend(canonical_privacy_issues(privacy_text))
    return issues


def _guard_candidate_text(*values: str) -> None:
    _guard_text(*values, subject="candidate")


def _guard_document_text(*values: str) -> None:
    _guard_text(*values, subject="wiki source")


def _ensure_named_directory_current(path: Path, directory_fd: int, label: str) -> None:
    try:
        opened = os.fstat(directory_fd)
        named = path.lstat()
    except OSError as exc:
        raise WikiAccessError(f"{label} changed during access") from exc
    if (
        stat.S_ISLNK(named.st_mode)
        or not stat.S_ISDIR(opened.st_mode)
        or (opened.st_dev, opened.st_ino) != (named.st_dev, named.st_ino)
    ):
        raise WikiAccessError(f"{label} changed during access")


def _ensure_named_file_current(
    directory_fd: int, filename: str, expected: os.stat_result, label: str
) -> None:
    file_fd: Optional[int] = None
    try:
        file_fd = os.open(
            filename,
            os.O_RDONLY
            | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_CLOEXEC", 0),
            dir_fd=directory_fd,
        )
        named = os.fstat(file_fd)
        if (
            not stat.S_ISREG(named.st_mode)
            or (named.st_dev, named.st_ino) != (expected.st_dev, expected.st_ino)
        ):
            raise WikiAccessError(f"{label} changed during access")
    except WikiAccessError:
        raise
    except OSError as exc:
        raise WikiAccessError(f"{label} changed during access") from exc
    finally:
        if file_fd is not None:
            os.close(file_fd)


def load_settings(hermes_home: str | Path) -> WikiSettings:
    home = Path(hermes_home).expanduser().resolve()
    config: Dict[str, Any] = {}
    try:
        home_fd = os.open(
            home,
            os.O_RDONLY
            | getattr(os, "O_DIRECTORY", 0)
            | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_CLOEXEC", 0),
        )
        config_fd: Optional[int] = None
        config_info: Optional[os.stat_result] = None
        try:
            config_fd = os.open(
                "llm_wiki.json",
                os.O_RDONLY
                | getattr(os, "O_NOFOLLOW", 0)
                | getattr(os, "O_CLOEXEC", 0),
                dir_fd=home_fd,
            )
            config_info = os.fstat(config_fd)
            if not stat.S_ISREG(config_info.st_mode):
                raise WikiAccessError("llm_wiki.json must be a regular file")
            with os.fdopen(config_fd, "r", encoding="utf-8-sig") as handle:
                config_fd = None
                loaded = json.load(handle)
            if isinstance(loaded, dict):
                config = loaded
            _ensure_named_file_current(
                home_fd, "llm_wiki.json", config_info, "llm_wiki.json"
            )
            _ensure_named_directory_current(home, home_fd, "Hermes profile root")
        except FileNotFoundError:
            pass
        except OSError as exc:
            raise WikiAccessError("llm_wiki.json is not safely readable") from exc
        finally:
            if config_fd is not None:
                os.close(config_fd)
            os.close(home_fd)
    except WikiAccessError:
        raise
    except Exception as exc:
        logger.warning("Ignoring invalid llm_wiki.json: %s", exc)

    wiki_path = os.environ.get("WIKI_PATH") or config.get("wiki_path") or home / "llm-wiki"
    # Sharing is explicit local configuration, never inferred from an environment override.
    shared = config.get("shared_wiki_path")
    shared = Path(os.path.abspath(Path(shared).expanduser())) if shared else None
    if shared is not None:
        if not shared.is_absolute() or len(shared.parts) < 3:
            raise WikiAccessError("shared wiki must be an explicit local directory")
        for part in [*shared.parents, shared]:
            if part.is_symlink() or (hasattr(part, "is_junction") and part.is_junction()):
                raise WikiAccessError("shared wiki must not contain links or junctions")
    if shared is not None and Path(os.path.abspath(wiki_path)) == shared:
        safe_wiki = shared
    else:
        safe_wiki = _confined_profile_path(home, wiki_path)
    max_results = os.environ.get("LLM_WIKI_MAX_RESULTS", config.get("max_results"))
    max_chars = os.environ.get("LLM_WIKI_MAX_CHARS", config.get("max_chars"))
    max_file_bytes = os.environ.get(
        "LLM_WIKI_MAX_FILE_BYTES", config.get("max_file_bytes")
    )
    propose_enabled = os.environ.get(
        "LLM_WIKI_PROPOSE_ENABLED", config.get("propose_enabled")
    )
    min_recall_score = os.environ.get(
        "LLM_WIKI_MIN_RECALL_SCORE", config.get("min_recall_score")
    )
    consolidate = str(
        os.environ.get("LLM_WIKI_CONSOLIDATE", config.get("consolidate")) or "off"
    ).strip().casefold()
    auto_apply = config.get("auto_apply") if isinstance(config.get("auto_apply"), dict) else {}

    return WikiSettings(
        profile_root=home,
        wiki_path=safe_wiki,
        max_results=_bounded_int(max_results, _DEFAULT_MAX_RESULTS, 1, _DEFAULT_MAX_RESULTS),
        max_chars=_bounded_int(max_chars, _DEFAULT_MAX_CHARS, 1000, 12_000),
        max_file_bytes=_bounded_int(
            max_file_bytes, _DEFAULT_MAX_FILE_BYTES, 32_768, 1_048_576
        ),
        propose_enabled=_coerce_bool(propose_enabled, False),
        shared_wiki_path=shared,
        min_recall_score=_bounded_int(
            min_recall_score, _DEFAULT_MIN_RECALL_SCORE, 0, 200
        ),
        profile_name=profile_name_for(home),
        auto_capture=_coerce_bool(
            os.environ.get("LLM_WIKI_AUTO_CAPTURE", config.get("auto_capture")), False
        ),
        extract_every_turns=_bounded_int(config.get("extract_every_turns"), 10, 2, 100),
        consolidate=consolidate if consolidate in _CONSOLIDATE_MODES else "off",
        add_min_confidence=_bounded_float(auto_apply.get("add_min_confidence"), 0.8, 0.0, 1.0),
        update_min_confidence=_bounded_float(
            auto_apply.get("update_min_confidence"), 0.7, 0.0, 1.0
        ),
    )


def save_settings(values: Dict[str, Any], hermes_home: str | Path) -> None:
    home = Path(hermes_home).expanduser().resolve()
    home.mkdir(parents=True, exist_ok=True)
    existing: Dict[str, Any] = {}
    settings = load_settings(home)
    existing = {
        "wiki_path": str(settings.wiki_path) if settings.shared_wiki_path else settings.wiki_path.relative_to(home).as_posix(),
        "max_results": settings.max_results,
        "max_chars": settings.max_chars,
        "max_file_bytes": settings.max_file_bytes,
        "propose_enabled": settings.propose_enabled,
        "min_recall_score": settings.min_recall_score,
        "auto_capture": settings.auto_capture,
        "extract_every_turns": settings.extract_every_turns,
        "consolidate": settings.consolidate,
        "auto_apply": {
            "add_min_confidence": settings.add_min_confidence,
            "update_min_confidence": settings.update_min_confidence,
        },
    }
    if settings.shared_wiki_path:
        existing["shared_wiki_path"] = str(settings.shared_wiki_path)

    if "wiki_path" in values and str(values["wiki_path"]).strip():
        requested = Path(os.path.abspath(values["wiki_path"]))
        safe_path = requested if requested == settings.shared_wiki_path else _confined_profile_path(home, values["wiki_path"])
        existing["wiki_path"] = str(safe_path) if safe_path == settings.shared_wiki_path else safe_path.relative_to(home).as_posix()
    if "max_results" in values:
        existing["max_results"] = _bounded_int(
            values["max_results"], _DEFAULT_MAX_RESULTS, 1, _DEFAULT_MAX_RESULTS
        )
    if "max_chars" in values:
        existing["max_chars"] = _bounded_int(values["max_chars"], 5000, 1000, 12_000)
    if "max_file_bytes" in values:
        existing["max_file_bytes"] = _bounded_int(
            values["max_file_bytes"], _DEFAULT_MAX_FILE_BYTES, 32_768, 1_048_576
        )
    if "propose_enabled" in values:
        existing["propose_enabled"] = _coerce_bool(values["propose_enabled"], False)
    if "min_recall_score" in values:
        existing["min_recall_score"] = _bounded_int(
            values["min_recall_score"], _DEFAULT_MIN_RECALL_SCORE, 0, 200
        )
    if "auto_capture" in values:
        existing["auto_capture"] = _coerce_bool(values["auto_capture"], False)
    if "extract_every_turns" in values:
        existing["extract_every_turns"] = _bounded_int(values["extract_every_turns"], 10, 2, 100)
    if "consolidate" in values:
        mode = str(values["consolidate"]).strip().casefold()
        existing["consolidate"] = mode if mode in _CONSOLIDATE_MODES else "off"

    payload = json.dumps(existing, ensure_ascii=False, indent=2) + "\n"
    home_fd: Optional[int] = None
    temp_fd: Optional[int] = None
    temp_info: Optional[os.stat_result] = None
    temp_name = ""
    try:
        home_fd = os.open(
            home,
            os.O_RDONLY
            | getattr(os, "O_DIRECTORY", 0)
            | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_CLOEXEC", 0),
        )
        for _ in range(16):
            temp_name = f".llm_wiki.json.{secrets.token_hex(16)}.tmp"
            try:
                temp_fd = os.open(
                    temp_name,
                    os.O_WRONLY
                    | os.O_CREAT
                    | os.O_EXCL
                    | getattr(os, "O_NOFOLLOW", 0)
                    | getattr(os, "O_CLOEXEC", 0),
                    0o600,
                    dir_fd=home_fd,
                )
                break
            except FileExistsError:
                continue
        if temp_fd is None:
            raise WikiAccessError("could not allocate a private settings file")
        temp_info = os.fstat(temp_fd)
        with os.fdopen(temp_fd, "w", encoding="utf-8") as handle:
            temp_fd = None
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(
            temp_name,
            "llm_wiki.json",
            src_dir_fd=home_fd,
            dst_dir_fd=home_fd,
        )
        temp_name = ""
        _ensure_named_file_current(
            home_fd, "llm_wiki.json", temp_info, "llm_wiki.json"
        )
        _ensure_named_directory_current(home, home_fd, "Hermes profile root")
        os.fsync(home_fd)
    except WikiAccessError:
        raise
    except OSError as exc:
        raise WikiAccessError("llm_wiki settings could not be saved safely") from exc
    finally:
        if temp_fd is not None:
            os.close(temp_fd)
        if temp_name and home_fd is not None:
            try:
                os.unlink(temp_name, dir_fd=home_fd)
            except OSError:
                pass
        if home_fd is not None:
            os.close(home_fd)


def _string_list(value: Any) -> List[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, str):
        return [part.strip() for part in value.split(",") if part.strip()]
    return [str(value).strip()]


def _parse_frontmatter(text: str) -> tuple[Dict[str, Any], str]:
    if not text.startswith("---\n") and not text.startswith("---\r\n"):
        return {}, text
    lines = text.splitlines(keepends=True)
    closing_index: Optional[int] = None
    consumed = len(lines[0])
    for index, line in enumerate(lines[1:201], start=1):
        consumed += len(line)
        if consumed > 65_536:
            break
        if line.strip() == "---":
            closing_index = index
            break
    if closing_index is None:
        return {"_metadata_error": "unterminated frontmatter"}, text
    raw = "".join(lines[1:closing_index])
    body = "".join(lines[closing_index + 1 :])
    try:
        parsed = yaml.safe_load(raw) or {}
    except Exception as exc:
        return {"_metadata_error": f"invalid frontmatter: {exc}"}, body
    if not isinstance(parsed, dict):
        return {"_metadata_error": "frontmatter must be a mapping"}, body
    return parsed, body


def _metadata_text(metadata: Dict[str, Any], key: str) -> str:
    value = metadata.get(key, "")
    return str(value).strip().lower()


def authority_for(relative_path: str, metadata: Dict[str, Any]) -> str:
    rel = PurePosixPath(relative_path)
    parts = tuple(part.lower() for part in rel.parts)
    first = parts[0] if parts else ""

    if metadata.get("_metadata_error"):
        return "invalid"
    if first in _HISTORICAL_DIRS:
        return "historical"
    if first == "inbox":
        return "candidate"
    if len(parts) == 1 and rel.name in _NAVIGATION_FILES:
        return "navigation"

    status = _metadata_text(metadata, "status")
    tier = _metadata_text(metadata, "tier") or _metadata_text(metadata, "authority")
    if relative_path == _CURRENT_STATE:
        if (
            tier == "canonical"
            and _coerce_bool(metadata.get("source_of_truth"), False)
            and status == "active"
        ):
            return "canonical"
        return "invalid"
    if first in _AUTO_RECALL_DIRS:
        if tier == "canonical" and status in {"active", "canonical"}:
            return "canonical"
        return "draft"
    return "navigation"


def _normalized(text: str) -> str:
    return unicodedata.normalize("NFKC", text).casefold()


def _is_managed_candidate(document: "MarkdownDocument") -> bool:
    """A propose()-shaped candidate: top-level inbox file with a well-formed candidate id.

    Same rule as fnos governance (filename + id, no tier requirement), so both see one backlog.
    """
    parts = PurePosixPath(document.relative_path).parts
    return (
        document.authority == "candidate"
        and len(parts) == 2
        and parts[0] == "inbox"
        and bool(re.fullmatch(r"[0-9a-f]{12}", str(document.metadata.get("candidate_id", ""))))
    )


def _query_terms(query: str) -> List[str]:
    normalized = _normalized(query)
    terms = set(re.findall(r"[a-z0-9_.-]{2,}", normalized))
    for sequence in re.findall(r"[\u3400-\u9fff]{2,}", normalized):
        terms.add(sequence)
        if len(sequence) > 2:
            terms.update(sequence[index : index + 2] for index in range(len(sequence) - 1))
    return sorted(terms, key=lambda item: (-len(item), item))


def _index_grams(value: str) -> List[str]:
    """Encode searchable two-character fragments as FTS-safe derived tokens."""
    grams = set()
    normalized = _normalized(value)
    for sequence in re.findall(r"[a-z0-9_.-]{2,}|[\u3400-\u9fff]{2,}", normalized):
        for index in range(len(sequence) - 1):
            first, second = sequence[index : index + 2]
            grams.add(f"g{ord(first):06x}{ord(second):06x}")
    return sorted(grams)


def _index_terms(*values: str) -> str:
    """Build FTS candidate terms without changing the canonical scoring semantics."""
    return " ".join(sorted({gram for value in values for gram in _index_grams(value)}))


def _fts_candidate_query(terms: List[str]) -> str:
    clauses = []
    for term in terms:
        grams = _index_grams(term)
        if grams:
            quoted = [f'"{gram}"' for gram in grams]
            clauses.append(" AND ".join(quoted))
    return " OR ".join(f"({clause})" for clause in clauses)


def _first_heading(body: str) -> str:
    for line in body.splitlines():
        if line.startswith("# "):
            return line[2:].strip()
    return ""


def _truncate(text: str, limit: int) -> tuple[str, bool]:
    if len(text) <= limit:
        return text, False
    if limit <= 20:
        return text[:limit], True
    return text[: limit - 18].rstrip() + "\n[... truncated]", True


class WikiRepository:
    def __init__(self, settings: WikiSettings):
        self.settings = settings
        self.root = settings.wiki_path

    def _trusted_root(self) -> Path:
        boundary = self.settings.shared_wiki_path or self.settings.profile_root
        root = _confined_profile_path(boundary, self.root)
        if root.is_symlink():
            raise WikiAccessError("wiki root cannot be a symbolic link")
        return root

    @staticmethod
    def _directory_flags() -> int:
        return (
            os.O_RDONLY
            | getattr(os, "O_DIRECTORY", 0)
            | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_CLOEXEC", 0)
        )

    def _open_wiki_root_fd(self) -> int:
        """Open the wiki from the profile fd without re-resolving untrusted paths."""
        profile = self.settings.shared_wiki_path or self.settings.profile_root
        try:
            relative = self.root.relative_to(profile)
        except ValueError as exc:
            raise WikiAccessError("wiki root escapes the active Hermes profile") from exc
        profile_fd: Optional[int] = None
        current_fd: Optional[int] = None
        try:
            profile_fd = os.open(profile, self._directory_flags())
            current_fd = profile_fd
            for part in relative.parts:
                next_fd = os.open(part, self._directory_flags(), dir_fd=current_fd)
                if current_fd != profile_fd:
                    os.close(current_fd)
                current_fd = next_fd
            if current_fd == profile_fd:
                current_fd = os.dup(profile_fd)
            self._ensure_root_fd_current(current_fd)
            return current_fd
        except (OSError, ValueError, WikiAccessError) as exc:
            if current_fd is not None and current_fd != profile_fd:
                os.close(current_fd)
            if isinstance(exc, WikiAccessError):
                raise
            raise WikiAccessError("wiki root changed or is not a trusted directory") from exc
        finally:
            if profile_fd is not None:
                os.close(profile_fd)

    def _ensure_root_fd_current(self, root_fd: int) -> None:
        try:
            opened = os.fstat(root_fd)
            named = self.root.lstat()
        except OSError as exc:
            raise WikiAccessError("wiki root changed during access") from exc
        if stat.S_ISLNK(named.st_mode) or not stat.S_ISDIR(opened.st_mode):
            raise WikiAccessError("wiki root changed during access")
        if (opened.st_dev, opened.st_ino) != (named.st_dev, named.st_ino):
            raise WikiAccessError("wiki root changed during access")

    def _ensure_directory_fd_current(
        self, root_fd: int, relative_parts: tuple[str, ...], directory_fd: int
    ) -> None:
        """Verify an opened descendant directory is still named beneath the wiki root."""
        current_fd: Optional[int] = None
        try:
            current_fd = os.dup(root_fd)
            for part in relative_parts:
                next_fd = os.open(part, self._directory_flags(), dir_fd=current_fd)
                os.close(current_fd)
                current_fd = next_fd
            opened = os.fstat(directory_fd)
            named = os.fstat(current_fd)
            if (opened.st_dev, opened.st_ino) != (named.st_dev, named.st_ino):
                raise WikiAccessError("wiki directory changed during access")
        except WikiAccessError:
            raise
        except OSError as exc:
            raise WikiAccessError("wiki directory changed during access") from exc
        finally:
            if current_fd is not None:
                os.close(current_fd)

    @staticmethod
    def _ensure_file_current(directory_fd: int, filename: str, expected: os.stat_result) -> None:
        file_fd: Optional[int] = None
        try:
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
            file_fd = os.open(filename, flags, dir_fd=directory_fd)
            named = os.fstat(file_fd)
            if (named.st_dev, named.st_ino) != (expected.st_dev, expected.st_ino):
                raise WikiAccessError("wiki file changed during access")
        except WikiAccessError:
            raise
        except OSError as exc:
            raise WikiAccessError("wiki file changed during access") from exc
        finally:
            if file_fd is not None:
                os.close(file_fd)

    @staticmethod
    def _unlink_if_same(directory_fd: int, filename: str, expected: Optional[os.stat_result]) -> None:
        if expected is None:
            return
        quarantine = f".llm-wiki-cleanup-{secrets.token_hex(16)}"
        try:
            os.link(
                filename,
                quarantine,
                src_dir_fd=directory_fd,
                dst_dir_fd=directory_fd,
                follow_symlinks=False,
            )
            copied = os.stat(quarantine, dir_fd=directory_fd, follow_symlinks=False)
            if (copied.st_dev, copied.st_ino) != (expected.st_dev, expected.st_ino):
                return
            current = os.stat(filename, dir_fd=directory_fd, follow_symlinks=False)
            if (current.st_dev, current.st_ino) == (expected.st_dev, expected.st_ino):
                os.unlink(filename, dir_fd=directory_fd)
        except OSError:
            pass
        finally:
            try:
                os.unlink(quarantine, dir_fd=directory_fd)
            except OSError:
                pass

    @staticmethod
    def _validated_relative_markdown(relative_path: str) -> PurePosixPath:
        if not isinstance(relative_path, str) or not relative_path.strip():
            raise WikiAccessError("path is required")
        raw = relative_path.strip().replace("\\", "/")
        if "\x00" in raw or re.match(r"^[A-Za-z]:", raw):
            raise WikiAccessError("path must be relative to the wiki root")
        rel = PurePosixPath(raw)
        if rel.is_absolute() or any(part in {"", ".", ".."} for part in rel.parts):
            raise WikiAccessError("path must stay within the wiki root")
        if any(part.startswith(".") for part in rel.parts):
            raise WikiAccessError("hidden wiki paths are not readable")
        if rel.suffix.lower() != ".md":
            raise WikiAccessError("only Markdown files can be read")
        return rel

    def _read_markdown_fd(self, relative_path: str) -> tuple[PurePosixPath, str]:
        rel = self._validated_relative_markdown(relative_path)
        root_fd: Optional[int] = None
        directory_fd: Optional[int] = None
        file_fd: Optional[int] = None
        try:
            root_fd = self._open_wiki_root_fd()
            directory_fd = root_fd
            for part in rel.parts[:-1]:
                next_fd = os.open(part, self._directory_flags(), dir_fd=directory_fd)
                if directory_fd != root_fd:
                    os.close(directory_fd)
                directory_fd = next_fd
            file_flags = (
                os.O_RDONLY
                | getattr(os, "O_NOFOLLOW", 0)
                | getattr(os, "O_CLOEXEC", 0)
            )
            file_fd = os.open(rel.name, file_flags, dir_fd=directory_fd)
            info = os.fstat(file_fd)
            if not stat.S_ISREG(info.st_mode):
                raise WikiAccessError("wiki source is not a regular file")
            if info.st_size > self.settings.max_file_bytes:
                raise WikiAccessError(
                    f"wiki source exceeds {self.settings.max_file_bytes} bytes"
                )
            with os.fdopen(file_fd, "r", encoding="utf-8-sig") as handle:
                file_fd = None
                text = handle.read(self.settings.max_file_bytes + 1)
            if len(text.encode("utf-8")) > self.settings.max_file_bytes:
                raise WikiAccessError(
                    f"wiki source exceeds {self.settings.max_file_bytes} bytes"
                )
            self._ensure_file_current(directory_fd, rel.name, info)
            self._ensure_directory_fd_current(root_fd, tuple(rel.parts[:-1]), directory_fd)
            self._ensure_root_fd_current(root_fd)
            return rel, text
        except WikiAccessError:
            raise
        except (OSError, UnicodeError) as exc:
            raise WikiAccessError("wiki source changed or is not safely readable") from exc
        finally:
            if file_fd is not None:
                os.close(file_fd)
            if directory_fd is not None and directory_fd != root_fd:
                os.close(directory_fd)
            if root_fd is not None:
                os.close(root_fd)

    def is_ready(self) -> bool:
        try:
            root = self._trusted_root()
            if not (
                root.is_dir()
                and (root / "SCHEMA.md").is_file()
                and (root / "index.md").is_file()
                and (root / _CURRENT_STATE).is_file()
            ):
                return False
            return self.load_document(_CURRENT_STATE).authority == "canonical"
        except (OSError, UnicodeError, WikiError):
            return False

    def _safe_path(self, relative_path: str, *, require_file: bool = True) -> Path:
        rel = self._validated_relative_markdown(relative_path)

        root = self._trusted_root().resolve(strict=True)
        current = root
        for part in rel.parts:
            current = current / part
            try:
                mode = current.lstat().st_mode
            except FileNotFoundError:
                if require_file:
                    raise WikiAccessError("wiki source does not exist")
                break
            if stat.S_ISLNK(mode):
                raise WikiAccessError("symbolic links are not allowed in the wiki")
        resolved = current.resolve(strict=require_file)
        try:
            resolved.relative_to(root)
        except ValueError as exc:
            raise WikiAccessError("path escapes the wiki root") from exc
        if require_file and not resolved.is_file():
            raise WikiAccessError("wiki source is not a file")
        return resolved

    def load_document(self, relative_path: str, *, guard: bool = True) -> MarkdownDocument:
        rel, text = self._read_markdown_fd(relative_path)
        path = self.root.joinpath(*rel.parts)
        metadata, body = _parse_frontmatter(text)
        relative = rel.as_posix()
        title = str(metadata.get("title") or _first_heading(body) or path.stem).strip()
        if guard:
            _guard_document_text(
                title,
                body,
                json.dumps(metadata, ensure_ascii=False, sort_keys=True, default=str),
            )
        return MarkdownDocument(
            path=path,
            relative_path=relative,
            metadata=metadata,
            body=body.strip(),
            title=title,
            aliases=_string_list(metadata.get("aliases")),
            tags=_string_list(metadata.get("tags")),
            authority=authority_for(relative, metadata),
        )

    def _iter_markdown_paths(self) -> Iterable[Path]:
        try:
            root = self._trusted_root().resolve(strict=True)
        except (OSError, WikiError):
            return []
        if not root.is_dir():
            return []
        paths = []
        for path in root.rglob("*.md"):
            try:
                relative = path.relative_to(root)
            except ValueError:
                continue
            if any(part.startswith(".") for part in relative.parts):
                continue
            paths.append(path)
        return sorted(paths, key=lambda item: item.as_posix())

    def iter_documents(self, *, include_historical: bool = False) -> Iterable[MarkdownDocument]:
        root = self._trusted_root().resolve(strict=True)
        for path in self._iter_markdown_paths():
            relative = path.relative_to(root).as_posix()
            try:
                document = self.load_document(relative)
            except (OSError, UnicodeError, WikiError):
                continue
            if document.authority == "canonical":
                yield document
            elif include_historical and document.authority in {
                "historical",
                "candidate",
                "draft",
            }:
                yield document

    def _iter_scoped_documents(
        self, *, candidates: bool = False, canonical: bool = False
    ) -> Iterable[MarkdownDocument]:
        """Load only inbox and/or canonical-eligible files; raw history is never read here."""
        root = self._trusted_root().resolve(strict=True)
        for path in self._iter_markdown_paths():
            relative = path.relative_to(root).as_posix()
            parts = PurePosixPath(relative).parts
            first = parts[0] if parts else ""
            wanted = (candidates and first == "inbox") or (
                canonical and (relative == _CURRENT_STATE or first in _AUTO_RECALL_DIRS)
            )
            if not wanted:
                continue
            try:
                document = self.load_document(relative)
            except (OSError, UnicodeError, WikiError):
                continue
            if (candidates and document.authority == "candidate") or (
                canonical and document.authority == "canonical"
            ):
                yield document

    def _index_path(self) -> Path:
        return self.settings.profile_root / _DERIVED_INDEX_FILENAME

    def _source_fingerprint(self, info: os.stat_result, relative: str = "") -> str:
        fingerprint = ":".join(
            (
                str(info.st_dev),
                str(info.st_ino),
                str(info.st_mode),
                str(info.st_size),
                str(info.st_mtime_ns),
                str(info.st_ctime_ns),
            )
        )
        # NTFS st_ctime is creation time; restored mtimes must not hide changed content.
        if os.name == "nt" and relative:
            _, text = self._read_markdown_fd(relative)
            fingerprint += ":" + hashlib.sha256(text.encode("utf-8")).hexdigest()
        return fingerprint

    def _canonical_index_documents(self) -> List[tuple[MarkdownDocument, str]]:
        documents = []
        root = self._trusted_root().resolve(strict=True)
        for path in self._iter_markdown_paths():
            relative = path.relative_to(root).as_posix()
            parts = PurePosixPath(relative).parts
            if relative != _CURRENT_STATE and (not parts or parts[0] not in _AUTO_RECALL_DIRS):
                continue
            try:
                document = self.load_document(relative)
                info = path.lstat()
            except (OSError, UnicodeError, WikiError):
                continue
            if document.authority != "canonical" or not stat.S_ISREG(info.st_mode):
                continue
            documents.append((document, self._source_fingerprint(info, relative)))
        return documents

    def _index_source_manifest(self) -> List[tuple[str, str]]:
        """Return a cheap, deterministic change detector for default-recall sources."""
        root = self._trusted_root().resolve(strict=True)
        manifest = []
        for path in self._iter_markdown_paths():
            relative = path.relative_to(root).as_posix()
            parts = PurePosixPath(relative).parts
            if relative != _CURRENT_STATE and (not parts or parts[0] not in _AUTO_RECALL_DIRS):
                continue
            try:
                info = path.lstat()
            except OSError:
                continue
            if stat.S_ISREG(info.st_mode):
                try:
                    manifest.append((relative, self._source_fingerprint(info, relative)))
                except WikiError:
                    continue
        return manifest

    @staticmethod
    def _source_snapshot(manifest: List[tuple[str, str]]) -> str:
        serialized = json.dumps(manifest, ensure_ascii=False, separators=(",", ":"))
        return hashlib.sha256(serialized.encode("utf-8")).hexdigest()

    def _current_index_snapshot(self) -> str:
        return self._source_snapshot(self._index_source_manifest())

    def _build_index(self, documents: List[tuple[MarkdownDocument, str]], snapshot: str) -> None:
        home = self.settings.profile_root
        index_path = self._index_path()
        if home.is_symlink() or index_path.is_symlink():
            raise WikiAccessError("derived index path is not trusted")
        home_fd: Optional[int] = None
        temp_fd: Optional[int] = None
        temp_info: Optional[os.stat_result] = None
        temp_name = ""
        connection: Optional[sqlite3.Connection] = None
        try:
            home_fd = os.open(home, self._directory_flags())
            _ensure_named_directory_current(home, home_fd, "Hermes profile root")
            for _ in range(16):
                candidate = f".{_DERIVED_INDEX_FILENAME}.{secrets.token_hex(16)}.tmp"
                try:
                    temp_fd = os.open(
                        candidate,
                        os.O_RDWR
                        | os.O_CREAT
                        | os.O_EXCL
                        | getattr(os, "O_NOFOLLOW", 0)
                        | getattr(os, "O_CLOEXEC", 0),
                        0o600,
                        dir_fd=home_fd,
                    )
                except FileExistsError:
                    continue
                os.fchmod(temp_fd, 0o600)
                temp_info = os.fstat(temp_fd)
                temp_name = candidate
                break
            if temp_fd is None or temp_info is None:
                raise WikiAccessError("could not allocate private derived index")
            index_uri = (home / temp_name).as_uri() if os.name == "nt" else f"file:/proc/self/fd/{temp_fd}"
            connection = sqlite3.connect(index_uri + "?mode=rwc", uri=True)
            connection.execute("PRAGMA journal_mode=DELETE")
            connection.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            connection.execute(
                "CREATE TABLE documents ("
                "doc_id INTEGER PRIMARY KEY, relative_path TEXT NOT NULL UNIQUE, "
                "fingerprint TEXT NOT NULL)"
            )
            connection.execute("CREATE VIRTUAL TABLE documents_fts USING fts5(terms)")
            connection.executemany(
                "INSERT INTO documents(doc_id, relative_path, fingerprint) VALUES (?, ?, ?)",
                [
                    (index + 1, document.relative_path, fingerprint)
                    for index, (document, fingerprint) in enumerate(documents)
                ],
            )
            connection.executemany(
                "INSERT INTO documents_fts(rowid, terms) VALUES (?, ?)",
                [
                    (
                        index + 1,
                        _index_terms(
                            document.title,
                            " ".join(document.aliases),
                            " ".join(document.tags),
                            document.relative_path,
                            document.body,
                        ),
                    )
                    for index, (document, _) in enumerate(documents)
                ],
            )
            connection.executemany(
                "INSERT INTO meta(key, value) VALUES (?, ?)",
                [
                    ("schema_version", str(_DERIVED_INDEX_SCHEMA_VERSION)),
                    ("source_snapshot", snapshot),
                ],
            )
            connection.commit()
            if connection.execute("PRAGMA quick_check").fetchone() != ("ok",):
                raise WikiAccessError("derived index integrity check failed")
            connection.close()
            connection = None
            os.fsync(temp_fd)
            if self._current_index_snapshot() != snapshot:
                raise WikiAccessError("wiki changed while derived index was built")
            try:
                target_info = os.stat(
                    _DERIVED_INDEX_FILENAME, dir_fd=home_fd, follow_symlinks=False
                )
            except FileNotFoundError:
                target_info = None
            if target_info is not None and (
                not stat.S_ISREG(target_info.st_mode)
                or not self._private_index(index_path)
            ):
                raise WikiAccessError("derived index target is not replaceable")
            _ensure_named_directory_current(home, home_fd, "Hermes profile root")
            _ensure_named_file_current(home_fd, temp_name, temp_info, "derived index temporary file")
            if os.name == "nt":
                os.close(temp_fd)
                temp_fd = None
            os.replace(
                temp_name,
                _DERIVED_INDEX_FILENAME,
                src_dir_fd=home_fd,
                dst_dir_fd=home_fd,
            )
            temp_name = ""
            _ensure_named_file_current(
                home_fd, _DERIVED_INDEX_FILENAME, temp_info, "derived index"
            )
            os.fsync(home_fd)
        finally:
            if connection is not None:
                connection.close()
            if temp_fd is not None:
                os.close(temp_fd)
            if temp_name and home_fd is not None:
                self._unlink_if_same(home_fd, temp_name, temp_info)
            if home_fd is not None:
                os.close(home_fd)

    @staticmethod
    def _private_index(path: Path) -> bool:
        return os.is_private(path) if os.name == "nt" else stat.S_IMODE(path.stat().st_mode) == 0o600

    def _indexed_candidates(self, terms: List[str]) -> Optional[_IndexedCandidates]:
        query = _fts_candidate_query(terms)
        if not query:
            return None
        try:
            snapshot = self._current_index_snapshot()
            index_path = self._index_path()
            if index_path.is_symlink():
                return None
            needs_rebuild = not index_path.is_file()
            if not needs_rebuild:
                if not self._private_index(index_path):
                    return None
                with closing(sqlite3.connect(index_path.as_uri() + "?mode=ro", uri=True)) as connection:
                    meta = dict(connection.execute("SELECT key, value FROM meta"))
                    needs_rebuild = (
                        meta.get("schema_version") != str(_DERIVED_INDEX_SCHEMA_VERSION)
                        or meta.get("source_snapshot") != snapshot
                    )
            if needs_rebuild:
                documents = self._canonical_index_documents()
                if self._current_index_snapshot() != snapshot:
                    return None
                self._build_index(documents, snapshot)
            with closing(sqlite3.connect(index_path.as_uri() + "?mode=ro", uri=True)) as connection:
                rows = connection.execute(
                    "SELECT documents.relative_path, documents.fingerprint "
                    "FROM documents_fts JOIN documents ON documents_fts.rowid = documents.doc_id "
                    "WHERE documents_fts MATCH ? ORDER BY documents.relative_path",
                    (query,),
                ).fetchall()
            return _IndexedCandidates(documents=rows)
        except (OSError, sqlite3.Error, UnicodeError, WikiError) as exc:
            logger.warning("Derived wiki index is unavailable; falling back to Markdown: %s", exc)
            return None

    def _scan_documents(self, *, include_historical: bool) -> Iterable[MarkdownDocument]:
        return self.iter_documents(include_historical=include_historical)

    def _search_documents(self, terms: List[str], *, include_historical: bool) -> Iterable[MarkdownDocument]:
        if include_historical:
            return self._scan_documents(include_historical=True)
        candidates = self._indexed_candidates(terms)
        if candidates is None:
            return self._scan_documents(include_historical=False)
        documents = []
        for relative_path, fingerprint in candidates.documents:
            try:
                document = self.load_document(relative_path)
                current = self._safe_path(relative_path).stat()
            except (OSError, UnicodeError, WikiError):
                return self._scan_documents(include_historical=False)
            current_fingerprint = self._source_fingerprint(current, relative_path)
            if document.authority != "canonical" or current_fingerprint != fingerprint:
                return self._scan_documents(include_historical=False)
            documents.append(document)
        return documents

    def _score(self, document: MarkdownDocument, query: str, terms: List[str]) -> int:
        normalized_query = _normalized(query).strip()
        title = _normalized(document.title)
        aliases = _normalized(" ".join(document.aliases))
        tags = _normalized(" ".join(document.tags))
        path = _normalized(document.relative_path)
        body = _normalized(document.body)
        score = 0
        if normalized_query and len(normalized_query) >= 2:
            if normalized_query in title:
                score += 120
            if normalized_query in aliases:
                score += 100
            if normalized_query in body:
                score += 30
        for term in terms:
            if term in title:
                score += 20
            if term in aliases:
                score += 16
            if term in tags:
                score += 12
            if term in path:
                score += 8
            occurrences = body.count(term)
            score += min(occurrences, 4) * 3
        return score

    def _recall_relevant(self, document: MarkdownDocument, terms: List[str], score: int) -> bool:
        """Gate automatic recall: a title/alias/tag hit, or several distinct body terms."""
        gating = [term for term in terms if term not in _RECALL_STOPWORDS]
        if not gating:
            return False
        fields = _normalized(" ".join([document.title, *document.aliases, *document.tags]))
        if any(term in fields for term in gating):
            return True
        body = _normalized(document.body)
        distinct = sum(1 for term in gating if term in body)
        # One meaningful term (e.g. an English keyword) may match once; more terms need breadth.
        required = 1 if len(gating) == 1 else (2 if len(gating) <= 4 else 3)
        return distinct >= required and score >= self.settings.min_recall_score

    def _excerpt(self, document: MarkdownDocument, terms: List[str], limit: int) -> str:
        lines = document.body.splitlines()
        match_index: Optional[int] = None
        for index, line in enumerate(lines):
            normalized = _normalized(line)
            if any(term in normalized for term in terms):
                match_index = index
                break
        if match_index is None:
            excerpt = document.body
        else:
            start = max(0, match_index - 2)
            end = min(len(lines), match_index + 7)
            excerpt = "\n".join(lines[start:end]).strip()
        return _truncate(excerpt, limit)[0]

    def search(
        self,
        query: str,
        *,
        include_historical: bool = False,
        limit: Optional[int] = None,
        char_budget: Optional[int] = None,
        now: Optional[datetime] = None,
        relevance_gate: bool = False,
        visible_profile: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        query = str(query or "").strip()
        terms = _query_terms(query)
        if not query or not terms:
            return []
        profile = visible_profile or self.settings.profile_name
        result_limit = _bounded_int(limit, self.settings.max_results, 1, 10)
        budget = _bounded_int(char_budget, self.settings.max_chars, 500, 20_000)
        now = _utc_now(now)
        scored = []
        for document in self._search_documents(terms, include_historical=include_historical):
            if not scope_visible(document.metadata, profile):
                continue
            # Recheck after both scan and FTS lookup: time can advance without a file change.
            issues = _canonical_issues(document, now=now)
            if issues and not include_historical:
                continue
            score = self._score(document, query, terms)
            if score > 0 and (
                not relevance_gate or self._recall_relevant(document, terms, score)
            ):
                scored.append((score, document.relative_path, document, issues))
        scored.sort(
            key=lambda item: (
                item[2].relative_path != _CURRENT_STATE,
                -item[0],
                item[1],
            )
        )

        results: List[Dict[str, Any]] = []
        remaining = budget
        for score, _, document, issues in scored[:result_limit]:
            if remaining < 100:
                break
            excerpt_limit = min(1600, remaining)
            excerpt = self._excerpt(document, terms, excerpt_limit)
            remaining -= len(excerpt)
            results.append(
                {
                    "path": document.relative_path,
                    "title": document.title,
                    "authority": document.authority,
                    "updated": str(document.metadata.get("updated", "")),
                    "last_verified_at": str(
                        document.metadata.get("last_verified_at", "")
                    ),
                    "score": score,
                    "excerpt": excerpt,
                    "issues": issues,
                    "scope": scope_of(document.metadata),
                    "origin": str(document.metadata.get("origin", "")),
                    "warning": (
                        _EVIDENCE_WARNING
                        + (" Privacy issue." if any("privacy" in i for i in issues) else "")
                    ) if include_historical or issues else "",
                }
            )
        return results

    def _render_results(self, results: List[Dict[str, Any]]) -> str:
        if not results:
            return ""
        canonical_only = all(
            result.get("authority") == "canonical" and not result.get("warning")
            for result in results
        )
        parts = [
            "## Hermes LLM Wiki Recall",
            (
                "Only canonical pages are included (human-reviewed, or applied by the consolidation "
                "policy and marked Origin: auto). Paths are relative to the wiki root."
                if canonical_only
                else _EVIDENCE_WARNING + " Paths are relative to the wiki root."
            ),
        ]
        for result in results[:_DEFAULT_MAX_RESULTS]:
            lines = [
                f"### {result['title']}",
                f"Source: {result['path']}",
                f"Authority: {result.get('authority', 'unknown')}",
            ]
            if result.get("origin") == "auto":
                lines.append("Origin: auto")
            if result.get("updated"):
                lines.append(f"Updated: {result['updated']}")
            if result.get("last_verified_at"):
                lines.append(f"Verified: {result['last_verified_at']}")
            lines.extend(["", result["excerpt"]])
            parts.append("\n".join(lines))
            candidate = "\n\n".join(parts)
            if (
                len(candidate) > self.settings.max_chars
                or _estimate_tokens(candidate) > _DEFAULT_MAX_TOKENS
            ):
                break
        rendered = "\n\n".join(parts)
        return _truncate_recall(
            rendered,
            max_chars=self.settings.max_chars,
            max_tokens=_DEFAULT_MAX_TOKENS,
        )

    def _stale_warning(self, freshness: Dict[str, Any]) -> str:
        lines = [
            "## Hermes LLM Wiki Recall",
            "Current-state memory is stale. Do not use it as current truth.",
            f"Reason: {freshness['staleness_reason']}",
        ]
        if freshness.get("expires_at"):
            lines.append(f"Expires: {freshness['expires_at']}")
        if freshness.get("revalidation_command"):
            lines.append(f"Revalidate: {freshness['revalidation_command']}")
        return _truncate_recall(
            "\n".join(lines),
            max_chars=self.settings.max_chars,
            max_tokens=_DEFAULT_MAX_TOKENS,
        )

    def prefetch(self, query: str, *, now: Optional[datetime] = None) -> str:
        if not self.is_ready():
            return ""
        try:
            current = self.load_document(_CURRENT_STATE)
        except (OSError, UnicodeError, WikiError):
            return (
                "## Hermes LLM Wiki Recall\n"
                "Current-state memory is unavailable. Do not infer current facts from history."
            )
        freshness = _current_state_freshness(current, now=now)
        terms = _query_terms(str(query or ""))
        current_relevant = bool(terms) and self._recall_relevant(
            current, terms, self._score(current, str(query or ""), terms)
        )
        is_current_query = bool(_CURRENT_QUERY_RE.search(str(query or "")))
        if is_current_query and (current_relevant or _is_bare_status_query(str(query or ""))):
            if current.authority != "canonical":
                return (
                    "## Hermes LLM Wiki Recall\n"
                    "CURRENT_STATE.md failed authority validation. Do not use historical pages "
                    "to answer current-state questions."
                )
            issues = _canonical_issues(current, now=now)
            if issues:
                if freshness["stale"]:
                    return self._stale_warning(freshness)
                return (
                    "## Hermes LLM Wiki Recall\n"
                    "CURRENT_STATE.md failed canonical validation. Do not use it as current truth.\n"
                    "Issues: " + ", ".join(issues)
                )
            result = {
                "path": current.relative_path,
                "title": current.title,
                "authority": current.authority,
                "updated": str(current.metadata.get("updated", "")),
                "last_verified_at": str(current.metadata.get("last_verified_at", "")),
                "score": 1000,
                "excerpt": _truncate(current.body, self.settings.max_chars - 300)[0],
            }
            return self._render_results([result])
        results = self.search(
            query,
            limit=min(self.settings.max_results, _DEFAULT_MAX_RESULTS),
            now=now,
            relevance_gate=True,
        )
        if freshness["stale"]:
            results = [result for result in results if result["path"] != _CURRENT_STATE]
            if not results and not current_relevant:
                return ""
            rendered = self._render_results(results)
            combined = self._stale_warning(freshness)
            if rendered:
                combined += "\n\n" + rendered
            return _truncate_recall(
                combined,
                max_chars=self.settings.max_chars,
                max_tokens=_DEFAULT_MAX_TOKENS,
            )
        return self._render_results(results)

    def read_source(
        self, relative_path: str, *, max_chars: int = 8000, now: Optional[datetime] = None
    ) -> Dict[str, Any]:
        document = self.load_document(relative_path)
        if document.metadata.get("_metadata_error"):
            raise WikiAccessError("source frontmatter is invalid")
        if not scope_visible(document.metadata, self.settings.profile_name):
            raise WikiAccessError("source belongs to another profile")
        relative = PurePosixPath(document.relative_path)
        if document.authority == "invalid" or (
            document.authority == "navigation"
            and not (len(relative.parts) == 1 and relative.name in _NAVIGATION_FILES)
        ):
            raise WikiAccessError("source is not a supported recall source")
        _guard_document_text(document.title, document.body)
        limit = _bounded_int(max_chars, 8000, 500, 12_000)
        content, truncated = _truncate(document.body, limit)
        issues = _canonical_issues(document, now=now)
        return {
            "success": True,
            "path": document.relative_path,
            "title": document.title,
            "authority": document.authority,
            "metadata": {
                key: value
                for key, value in document.metadata.items()
                if not str(key).startswith("_")
            },
            "content": content,
            "truncated": truncated,
            "issues": issues,
            "warning": (
                _EVIDENCE_WARNING
                + (" Privacy issue." if any("privacy" in i for i in issues) else "")
                if document.authority != "canonical" or issues
                else ""
            ),
        }

    def status(self, *, now: Optional[datetime] = None) -> Dict[str, Any]:
        counts: Dict[str, int] = {}
        invalid_files = 0
        loaded_documents: List[MarkdownDocument] = []
        try:
            root = self._trusted_root().resolve(strict=True)
        except (OSError, WikiError):
            return {
                "success": True,
                "ready": False,
                "health": "unavailable",
                "issues": [{"code": "wiki.unavailable", "path": str(self.root)}],
                "notices": [],
                "current_state": {
                    "authority": "unavailable",
                    "expires_at": "",
                    "stale": True,
                    "staleness_reason": "unavailable",
                    "revalidation_command": "",
                },
                "integrity": {
                    "source_references_checked": 0,
                    "broken_sources": [],
                    "wikilinks_checked": 0,
                    "broken_wikilinks": [],
                    "ambiguous_wikilinks": [],
                    "active_canonical_conflicts": [],
                },
                "candidate_backlog": {
                    "count": 0,
                    "count_threshold": _CANDIDATE_COUNT_THRESHOLD,
                    "oldest_created_at": None,
                    "oldest_age_days": None,
                    "oldest_age_threshold_days": _CANDIDATE_AGE_THRESHOLD_DAYS,
                    "unknown_age_count": 0,
                    "over_count_threshold": False,
                    "over_age_threshold": False,
                },
                "inbox": {"reviewed_count": 0, "unmanaged_count": 0, "unmanaged_paths": []},
                "wiki_path": str(self.root),
                "propose_enabled": self.settings.propose_enabled,
                "max_results": self.settings.max_results,
                "max_chars": self.settings.max_chars,
                "max_tokens": _DEFAULT_MAX_TOKENS,
                "counts": {},
                "invalid_files": 0,
            }
        for path in self._iter_markdown_paths():
            relative = path.relative_to(root).as_posix()
            # status() never returns historical bodies, so skip their (slow) content scanner.
            first = PurePosixPath(relative).parts[0].lower()
            try:
                document = self.load_document(relative, guard=first not in _HISTORICAL_DIRS)
            except (OSError, UnicodeError, WikiError):
                invalid_files += 1
                continue
            counts[document.authority] = counts.get(document.authority, 0) + 1
            loaded_documents.append(document)
        try:
            current = self.load_document(_CURRENT_STATE)
            current_state = _current_state_freshness(current, now=now)
        except (OSError, UnicodeError, WikiError):
            current_state = {
                "authority": "unavailable",
                "expires_at": "",
                "stale": True,
                "staleness_reason": "unavailable",
                "revalidation_command": "",
            }
        ready = self.is_ready()
        issues = []
        if current_state["stale"] and current_state["authority"] != "canonical":
            issues.append(
                {
                    "code": f"current_state.{current_state['staleness_reason']}",
                    "path": _CURRENT_STATE,
                }
            )
        for document in loaded_documents:
            issues.extend(
                {"code": code, "path": document.relative_path}
                for code in _canonical_issues(document, now=now)
            )
        candidate_dates = []
        candidate_count = 0
        unknown_age_count = 0
        reviewed_count = 0
        unmanaged_paths: List[str] = []
        for candidate in loaded_documents:
            relative = candidate.relative_path
            if not relative.startswith("inbox/") or relative == "inbox/README.md":
                continue
            top_level = len(PurePosixPath(relative).parts) == 2
            marked = "candidate" in {
                _metadata_text(candidate.metadata, "tier"), _metadata_text(candidate.metadata, "status")
            }
            # Backlog = top-level candidates (propose()-written, or hand-made with candidate tier/status).
            # Nested folders and unmarked files are parked material: a notice, not degraded health.
            if not top_level or not (_is_managed_candidate(candidate) or marked):
                unmanaged_paths.append(relative)
                continue
            review_status = _metadata_text(candidate.metadata, "review_status") or "pending"
            if review_status != "pending":
                reviewed_count += 1
                continue
            candidate_count += 1
            try:
                raw_created = candidate.metadata.get("created")
                if isinstance(raw_created, datetime):
                    created_date = raw_created.date()
                elif isinstance(raw_created, date):
                    created_date = raw_created
                else:
                    created_date = date.fromisoformat(str(raw_created))
                candidate_dates.append(created_date)
            except (TypeError, ValueError):
                unknown_age_count += 1
        today = _utc_now(now).date()
        oldest_created = min(candidate_dates) if candidate_dates else None
        oldest_age = max(0, (today - oldest_created).days) if oldest_created else None
        candidate_backlog = {
            "count": candidate_count,
            "count_threshold": _CANDIDATE_COUNT_THRESHOLD,
            "oldest_created_at": oldest_created.isoformat() if oldest_created else None,
            "oldest_age_days": oldest_age,
            "oldest_age_threshold_days": _CANDIDATE_AGE_THRESHOLD_DAYS,
            "unknown_age_count": unknown_age_count,
            "over_count_threshold": candidate_count >= _CANDIDATE_COUNT_THRESHOLD,
            "over_age_threshold": (
                oldest_age is not None and oldest_age >= _CANDIDATE_AGE_THRESHOLD_DAYS
            ),
        }
        inbox_summary = {
            "reviewed_count": reviewed_count,
            "unmanaged_count": len(unmanaged_paths),
            "unmanaged_paths": sorted(unmanaged_paths)[:20],
        }
        notices = []
        if unmanaged_paths:
            notices.append({"code": "inbox.unmanaged_files", "path": "inbox"})
        if candidate_backlog["over_count_threshold"]:
            issues.append({"code": "candidate_backlog.count_threshold", "path": "inbox"})
        if candidate_backlog["over_age_threshold"]:
            issues.append({"code": "candidate_backlog.oldest_age_threshold", "path": "inbox"})
        if unknown_age_count:
            issues.append({"code": "candidate_backlog.unknown_age", "path": "inbox"})

        link_index: Dict[str, set[str]] = {}
        conflict_index: Dict[str, set[str]] = {}
        canonical_topics = [
            document
            for document in loaded_documents
            if document.authority == "canonical" and document.relative_path != _CURRENT_STATE
        ]
        link_documents = [
            document
            for document in loaded_documents
            if document.authority not in {"candidate", "draft", "invalid"}
        ]
        for document in link_documents:
            relative = PurePosixPath(document.relative_path)
            keys = {
                relative.with_suffix("").as_posix(),
                relative.stem,
                document.title,
                *document.aliases,
            }
            for key in keys:
                normalized_key = _candidate_normal_form(key)
                if normalized_key:
                    link_index.setdefault(normalized_key, set()).add(document.relative_path)
        for document in canonical_topics:
            relative = PurePosixPath(document.relative_path)
            for key in {relative.stem, document.title, *document.aliases}:
                normalized_key = _candidate_normal_form(key)
                if normalized_key:
                    conflict_index.setdefault(normalized_key, set()).add(document.relative_path)

        broken_sources = []
        source_references_checked = 0
        broken_wikilinks = []
        ambiguous_wikilinks = []
        wikilinks_checked = 0
        inspect_documents = [
            document
            for document in loaded_documents
            if document.authority in {"canonical", "navigation"}
        ]
        for document in inspect_documents:
            if document.authority == "canonical":
                for target in _string_list(document.metadata.get("sources")):
                    source_references_checked += 1
                    try:
                        source = self.load_document(target)
                        if source.authority in {"candidate", "draft", "invalid"}:
                            raise WikiAccessError("unsupported source authority")
                    except (OSError, UnicodeError, WikiError):
                        broken_sources.append({"path": document.relative_path, "target": target})
            for raw_target in re.findall(r"\[\[([^\]]+)\]\]", document.body):
                target = raw_target.split("|", 1)[0].split("#", 1)[0].strip()
                wikilinks_checked += 1
                paths = sorted(link_index.get(_candidate_normal_form(target), set()))
                if not paths:
                    broken_wikilinks.append({"path": document.relative_path, "target": target})
                elif len(paths) > 1:
                    ambiguous_wikilinks.append(
                        {
                            "path": document.relative_path,
                            "target": target,
                            "resolved_paths": paths,
                        }
                    )
        conflicts = [
            {"key": key, "paths": sorted(paths)}
            for key, paths in conflict_index.items()
            if len(paths) > 1
        ]
        broken_sources.sort(key=lambda item: (item["path"], _candidate_normal_form(item["target"])))
        broken_wikilinks.sort(key=lambda item: (item["path"], _candidate_normal_form(item["target"])))
        ambiguous_wikilinks.sort(
            key=lambda item: (item["path"], _candidate_normal_form(item["target"]), item["resolved_paths"])
        )
        conflicts.sort(key=lambda item: item["key"])
        integrity = {
            "source_references_checked": source_references_checked,
            "broken_sources": broken_sources,
            "wikilinks_checked": wikilinks_checked,
            "broken_wikilinks": broken_wikilinks,
            "ambiguous_wikilinks": ambiguous_wikilinks,
            "active_canonical_conflicts": conflicts,
        }
        for code, findings in (
            ("integrity.broken_source", broken_sources),
            ("integrity.broken_wikilink", broken_wikilinks),
            ("integrity.ambiguous_wikilink", ambiguous_wikilinks),
            ("integrity.active_canonical_conflict", conflicts),
        ):
            if findings:
                issues.append({"code": code, "path": findings[0].get("path", "")})
        issues.sort(key=lambda issue: (issue["code"], issue.get("path", "")))
        return {
            "success": True,
            "ready": ready,
            "health": "unavailable" if not ready else ("degraded" if issues else "healthy"),
            "issues": issues,
            "notices": notices,
            "current_state": current_state,
            "candidate_backlog": candidate_backlog,
            "inbox": inbox_summary,
            "integrity": integrity,
            "wiki_path": str(self.root),
            "propose_enabled": self.settings.propose_enabled,
            "max_results": self.settings.max_results,
            "max_chars": self.settings.max_chars,
            "max_tokens": _DEFAULT_MAX_TOKENS,
            "counts": counts,
            "invalid_files": invalid_files,
        }

    def propose(
        self,
        *,
        title: str,
        content: str,
        page_type: str = "concept",
        reason: str = "",
        provenance: Optional[Dict[str, Any]] = None,
        facets: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        if not self.settings.propose_enabled:
            raise WikiAccessError("wiki_propose is disabled; the wiki is read-only")
        title = str(title or "").strip()
        content = str(content or "").replace("\r\n", "\n").replace("\r", "\n").strip()
        reason = str(reason or "").strip()
        if not title or len(title) > 160 or "\n" in title or "\r" in title:
            raise WikiAccessError("title must be a single line of at most 160 characters")
        if not content or len(content) > 8000:
            raise WikiAccessError("content must contain 1 to 8000 characters")
        if len(reason) > 500:
            raise WikiAccessError("reason must contain at most 500 characters")
        if page_type not in {"entity", "concept", "comparison", "query", "summary"}:
            raise WikiAccessError("unsupported candidate page_type")

        safe_provenance = {}
        for key in ("session_id", "platform", "user_id", "chat_id", "profile", "source"):
            value = (provenance or {}).get(key)
            if value:
                safe_provenance[key] = str(value)[:200]
        if (provenance or {}).get("producer") == "hermes-loop":
            # Verified by the host against its immutable session events, never supplied by the model.
            source_seq, turn = provenance.get("source_seq"), provenance.get("turn")
            source_hash, quote = provenance.get("source_hash"), provenance.get("evidence_quote")
            if (type(source_seq) is not int or source_seq < 0 or type(turn) is not int or turn < 1
                    or not isinstance(source_hash, str) or not re.fullmatch(r"[a-f0-9]{64}", source_hash)
                    or not isinstance(quote, str) or not quote.strip() or len(quote) > 2000):
                raise WikiAccessError("invalid external source evidence")
            safe_provenance.update(producer="hermes-loop", source_seq=source_seq, turn=turn,
                                   source_hash=source_hash, evidence_quote=quote)
        safe_facets = _validated_facets(facets or {}, self.settings.profile_name)
        # Decision 3: internal-network details are only ever stored privately for this profile.
        if canonical_privacy_issues(" ".join([title, content])):
            safe_facets["scope"] = f"profile:{self.settings.profile_name}"
        provenance_values = [str(value) for value in safe_provenance.values()]
        _guard_candidate_text(
            title, content, reason, *provenance_values,
            *(str(value) for value in safe_facets.values()),
        )

        normalized_fingerprint = _content_fingerprint(title, content, page_type)
        normalized_content = _candidate_normal_form(content)
        duplicate: Optional[MarkdownDocument] = None
        duplicate_of = ""
        for existing in self._iter_scoped_documents(candidates=True, canonical=True):
            # Another profile's private candidate or page is neither a duplicate nor disclosed.
            if not scope_visible(existing.metadata, self.settings.profile_name):
                continue
            if existing.authority == "candidate":
                if not _is_managed_candidate(existing):
                    continue
                # Recomputed from the file: stored fingerprints predate the provenance-free form.
                existing_fingerprint = _content_fingerprint(
                    existing.title,
                    _candidate_content(existing),
                    str(existing.metadata.get("type", "concept")),
                )
                if existing_fingerprint == normalized_fingerprint:
                    duplicate, duplicate_of = existing, "candidate"
                    break
            elif len(normalized_content) >= 12 and normalized_content in _candidate_normal_form(
                existing.body
            ):
                duplicate, duplicate_of = existing, "canonical"
                break
        if duplicate is not None:
            root_fd: Optional[int] = None
            directory_fd: Optional[int] = None
            try:
                root_fd = self._open_wiki_root_fd()
                directory_fd = os.open("inbox", self._directory_flags(), dir_fd=root_fd)
                self._ensure_directory_fd_current(root_fd, ("inbox",), directory_fd)
                self._ensure_root_fd_current(root_fd)
            except (OSError, WikiAccessError) as exc:
                raise WikiAccessError("inbox changed during duplicate validation") from exc
            finally:
                if directory_fd is not None:
                    os.close(directory_fd)
                if root_fd is not None:
                    os.close(root_fd)
            result = {
                "success": True,
                "created": False,
                "duplicate": True,
                "path": duplicate.relative_path,
            }
            # Keep the original result shape for a pending candidate; only add what is new information.
            if duplicate_of == "candidate":
                result["candidate_id"] = str(duplicate.metadata.get("candidate_id", ""))
                status = str(duplicate.metadata.get("review_status", "pending"))
                if status != "pending":
                    result["review_status"] = status
            else:
                result["duplicate_of"] = duplicate_of
            return result

        identity = json.dumps(
            {
                "title": title,
                "content": content,
                "page_type": page_type,
                "reason": reason[:500],
                "provenance": safe_provenance,
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:12]
        now = datetime.now(timezone.utc)
        filename = f"{now:%Y-%m-%d}-candidate-{digest}.md"
        relative_target = f"inbox/{filename}"

        metadata = {
            "title": title,
            "created": now.date().isoformat(),
            "updated": now.date().isoformat(),
            "type": page_type,
            "status": "candidate",
            "tier": "candidate",
            "candidate_id": digest,
            "normalized_fingerprint": normalized_fingerprint,
            "review_status": "pending",
            "reason": reason[:500],
            "provenance": safe_provenance,
        }
        metadata.update(safe_facets)
        document = (
            "---\n"
            + yaml.safe_dump(metadata, allow_unicode=True, sort_keys=False).strip()
            + "\n---\n\n# "
            + title
            + "\n\n"
            + content
            + "\n"
        )
        root_fd = None
        directory_fd = None
        descriptor: Optional[int] = None
        created = False
        created_info: Optional[os.stat_result] = None
        try:
            root_fd = self._open_wiki_root_fd()
            try:
                directory_fd = os.open("inbox", self._directory_flags(), dir_fd=root_fd)
            except FileNotFoundError as exc:
                raise WikiAccessError(
                    "inbox changed or is not safely writable"
                ) from exc
            directory_info = os.fstat(directory_fd)
            if not stat.S_ISDIR(directory_info.st_mode):
                raise WikiAccessError("inbox must be a real directory")
            self._ensure_directory_fd_current(root_fd, ("inbox",), directory_fd)
            self._ensure_root_fd_current(root_fd)
            create_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
            create_flags |= getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
            try:
                descriptor = os.open(filename, create_flags, 0o600, dir_fd=directory_fd)
            except FileExistsError:
                self._ensure_directory_fd_current(root_fd, ("inbox",), directory_fd)
                self._ensure_root_fd_current(root_fd)
                existing_fd: Optional[int] = None
                try:
                    existing_flags = (
                        os.O_RDONLY
                        | getattr(os, "O_NOFOLLOW", 0)
                        | getattr(os, "O_CLOEXEC", 0)
                    )
                    existing_fd = os.open(filename, existing_flags, dir_fd=directory_fd)
                    existing_info = os.fstat(existing_fd)
                    if not stat.S_ISREG(existing_info.st_mode):
                        raise WikiAccessError("existing candidate is not a regular file")
                    with os.fdopen(existing_fd, "r", encoding="utf-8") as handle:
                        existing_fd = None
                        existing_document = handle.read(len(document) + 1)
                    if existing_document != document:
                        raise WikiAccessError("existing candidate content does not match its digest")
                    self._ensure_file_current(directory_fd, filename, existing_info)
                    self._ensure_directory_fd_current(root_fd, ("inbox",), directory_fd)
                    self._ensure_root_fd_current(root_fd)
                except WikiAccessError:
                    raise
                except (OSError, UnicodeError) as exc:
                    raise WikiAccessError("existing candidate is not safely readable") from exc
                finally:
                    if existing_fd is not None:
                        os.close(existing_fd)
                raise WikiAccessError("candidate already exists")
            created = True
            try:
                created_info = os.fstat(descriptor)
            except OSError:
                try:
                    created_info = os.stat(descriptor)
                except OSError:
                    pass
                raise
            try:
                os.fchmod(descriptor, 0o600)
                with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                    descriptor = None
                    handle.write(document)
                    handle.flush()
                    os.fsync(handle.fileno())
            except BaseException:
                if descriptor is not None:
                    os.close(descriptor)
                    descriptor = None
                self._unlink_if_same(directory_fd, filename, created_info)
                raise
            self._ensure_file_current(directory_fd, filename, created_info)
            self._ensure_directory_fd_current(root_fd, ("inbox",), directory_fd)
            self._ensure_root_fd_current(root_fd)
        except WikiAccessError:
            if descriptor is not None:
                os.close(descriptor)
                descriptor = None
            if created and directory_fd is not None:
                self._unlink_if_same(directory_fd, filename, created_info)
            raise
        except OSError as exc:
            if descriptor is not None:
                os.close(descriptor)
                descriptor = None
            if created and directory_fd is not None:
                self._unlink_if_same(directory_fd, filename, created_info)
            raise WikiAccessError("inbox changed or is not safely writable") from exc
        finally:
            if descriptor is not None:
                os.close(descriptor)
            if directory_fd is not None:
                os.close(directory_fd)
            if root_fd is not None:
                os.close(root_fd)
        return {
            "success": True,
            "created": True,
            "candidate_id": digest,
            "path": relative_target,
        }

    # -- page write primitives (consolidation only; propose() keeps its inbox-only path) --

    def _open_dir_chain(self, root_fd: int, parts: tuple[str, ...], *, create: bool) -> int:
        """Open (optionally creating) nested directories beneath the pinned wiki root."""
        current = os.dup(root_fd)
        try:
            for part in parts:
                if part.startswith(".") or part in {"", ".", ".."}:
                    raise WikiAccessError("unsafe wiki directory")
                try:
                    next_fd = os.open(part, self._directory_flags(), dir_fd=current)
                except FileNotFoundError:
                    if not create:
                        raise
                    os.mkdir(part, 0o700, dir_fd=current)
                    next_fd = os.open(part, self._directory_flags(), dir_fd=current)
                os.close(current)
                current = next_fd
            return current
        except BaseException:
            os.close(current)
            raise

    def _read_at(self, directory_fd: int, name: str) -> Optional[str]:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
        try:
            fd = os.open(name, flags, dir_fd=directory_fd)
        except FileNotFoundError:
            return None
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_size > self.settings.max_file_bytes:
                raise WikiAccessError("wiki page is not a bounded regular file")
            with os.fdopen(fd, "r", encoding="utf-8-sig", newline="") as handle:
                fd = None
                return handle.read(self.settings.max_file_bytes + 1)
        finally:
            if fd is not None:
                os.close(fd)

    @staticmethod
    def _writable_target(relative_path: str) -> PurePosixPath:
        rel = WikiRepository._validated_relative_markdown(relative_path)
        first = rel.parts[0].lower()
        if rel.as_posix() in {_CURRENT_STATE, "SCHEMA.md", "log.md"} or first == "raw":
            raise WikiAccessError("automation never writes this path")
        return rel

    def write_text(self, relative_path: str, text: str, *, expected: Optional[str]) -> None:
        """Create (expected=None) or replace (expected=current text) one Markdown page.

        Replacement is optimistic: if the page no longer equals ``expected`` it raises
        WikiConflictError instead of overwriting. Content passes the same guard as reads.
        """
        rel = self._writable_target(relative_path)
        if len(text.encode("utf-8")) > self.settings.max_file_bytes:
            raise WikiAccessError("page exceeds the wiki file size limit")
        metadata, body = _parse_frontmatter(text)
        if metadata.get("_metadata_error"):
            raise WikiAccessError("page frontmatter is invalid")
        _guard_document_text(
            str(metadata.get("title", "")), body,
            json.dumps(metadata, ensure_ascii=False, sort_keys=True, default=str),
        )
        root_fd = directory_fd = None
        try:
            root_fd = self._open_wiki_root_fd()
            directory_fd = self._open_dir_chain(root_fd, tuple(rel.parts[:-1]), create=True)
            current = self._read_at(directory_fd, rel.name)
            if current != expected:
                raise WikiConflictError(f"{rel.as_posix()} changed; re-plan before writing")
            self._write_at(directory_fd, rel.name, text, replace=expected is not None)
            self._ensure_root_fd_current(root_fd)
        except (WikiAccessError, WikiConflictError):
            raise
        except OSError as exc:
            raise WikiAccessError("wiki page could not be written safely") from exc
        finally:
            if directory_fd is not None:
                os.close(directory_fd)
            if root_fd is not None:
                os.close(root_fd)

    def _write_at(self, directory_fd: int, name: str, text: str, *, replace: bool) -> None:
        create = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        create |= getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
        target = f".llm-wiki-{secrets.token_hex(12)}.tmp" if replace else name
        fd = os.open(target, create, 0o600, dir_fd=directory_fd)
        info = os.fstat(fd)
        try:
            # newline="": pages keep their exact line endings on every OS (undo compares bytes).
            with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
                fd = None
                handle.write(text)
                handle.flush()
                os.fsync(handle.fileno())
            if replace:
                for attempt in range(5):
                    try:
                        os.replace(target, name, src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
                        break
                    except PermissionError:
                        # Windows: a concurrent reader briefly holds the file open.
                        if attempt == 4:
                            raise
                        time.sleep(0.05 * (attempt + 1))
        except BaseException:
            if fd is not None:
                os.close(fd)
            self._unlink_if_same(directory_fd, target, info)
            raise

    def remove_file(self, relative_path: str, *, expected: str) -> None:
        """Unlink one page only if it still equals ``expected`` (undo of an automatic ADD)."""
        rel = self._writable_target(relative_path)
        root_fd = directory_fd = None
        try:
            root_fd = self._open_wiki_root_fd()
            directory_fd = self._open_dir_chain(root_fd, tuple(rel.parts[:-1]), create=False)
            if self._read_at(directory_fd, rel.name) != expected:
                raise WikiConflictError(f"{rel.as_posix()} changed; refusing to remove")
            os.unlink(rel.name, dir_fd=directory_fd)
        except (WikiAccessError, WikiConflictError):
            raise
        except OSError as exc:
            raise WikiAccessError("wiki page could not be removed safely") from exc
        finally:
            if directory_fd is not None:
                os.close(directory_fd)
            if root_fd is not None:
                os.close(root_fd)

    def read_text(self, relative_path: str) -> Optional[str]:
        """Raw page text for planning a write, or None when the page does not exist."""
        rel = self._validated_relative_markdown(relative_path)
        root_fd = directory_fd = None
        try:
            root_fd = self._open_wiki_root_fd()
            try:
                directory_fd = self._open_dir_chain(root_fd, tuple(rel.parts[:-1]), create=False)
            except FileNotFoundError:
                return None
            return self._read_at(directory_fd, rel.name)
        except OSError as exc:
            raise WikiAccessError("wiki page is not safely readable") from exc
        finally:
            if directory_fd is not None:
                os.close(directory_fd)
            if root_fd is not None:
                os.close(root_fd)

    def append_log(self, line: str) -> None:
        """Append one single-line audit entry to log.md."""
        line = " ".join(str(line).split())[:600]
        _guard_candidate_text(line)
        root_fd = log_fd = None
        try:
            root_fd = self._open_wiki_root_fd()
            log_fd = os.open(
                "log.md",
                os.O_WRONLY | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0),
                dir_fd=root_fd,
            )
            if not stat.S_ISREG(os.fstat(log_fd).st_mode):
                raise WikiAccessError("audit log is not a regular file")
            with os.fdopen(log_fd, "a", encoding="utf-8") as handle:
                log_fd = None
                handle.write(line + "\n")
                handle.flush()
                os.fsync(handle.fileno())
        except WikiAccessError:
            raise
        except OSError as exc:
            raise WikiAccessError("audit log could not be appended") from exc
        finally:
            if log_fd is not None:
                os.close(log_fd)
            if root_fd is not None:
                os.close(root_fd)

    def update_candidate_metadata(self, candidate_id: str, updates: Dict[str, Any]) -> MarkdownDocument:
        """Merge ``updates`` into one managed candidate's frontmatter (optimistic, inbox only)."""
        document = self.find_candidate(candidate_id)
        raw = self.read_text(document.relative_path)
        if raw is None:
            raise WikiConflictError("candidate disappeared")
        metadata, body = _parse_frontmatter(raw)
        metadata.update(updates)
        rendered = _render_markdown(metadata, body)
        rel = PurePosixPath(document.relative_path)
        root_fd = directory_fd = None
        try:
            root_fd = self._open_wiki_root_fd()
            directory_fd = os.open("inbox", self._directory_flags(), dir_fd=root_fd)
            if self._read_at(directory_fd, rel.name) != raw:
                raise WikiConflictError("candidate changed during update")
            self._write_at(directory_fd, rel.name, rendered, replace=True)
        except (WikiAccessError, WikiConflictError):
            raise
        except OSError as exc:
            raise WikiAccessError("candidate could not be updated safely") from exc
        finally:
            if directory_fd is not None:
                os.close(directory_fd)
            if root_fd is not None:
                os.close(root_fd)
        return self.load_document(document.relative_path)

    def find_candidate(self, candidate_id: str, *, any_profile: bool = False) -> MarkdownDocument:
        if not re.fullmatch(r"[0-9a-f]{12}", str(candidate_id or "")):
            raise WikiAccessError("candidate_id must be a 12-character lowercase hex digest")
        matches = [
            document
            for document in self._iter_scoped_documents(candidates=True)
            if _is_managed_candidate(document)
            and str(document.metadata.get("candidate_id", "")) == candidate_id
            and (any_profile or scope_visible(document.metadata, self.settings.profile_name))
        ]
        if len(matches) != 1:
            raise WikiAccessError("candidate does not exist or is ambiguous")
        return matches[0]

    def taken_stems(self) -> set[str]:
        """Every Markdown stem in the wiki: new pages must not create ambiguous wikilinks."""
        return {path.stem.casefold() for path in self._iter_markdown_paths()}

    def update_index_block(self) -> bool:
        """Regenerate the automatic section of index.md from active `origin: auto` pages."""
        entries = []
        for document in self._iter_scoped_documents(canonical=True):
            if document.relative_path == _CURRENT_STATE:
                continue
            if str(document.metadata.get("origin", "")).casefold() != "auto":
                continue
            stem = PurePosixPath(document.relative_path).stem
            scope = scope_of(document.metadata)
            suffix = f"（{scope}）" if scope != "shared" else ""
            summary = " ".join(document.title.split())[:80]
            entries.append(f"- [[{stem}]] — {summary}{suffix}")
        block = "\n".join([_INDEX_BLOCK_START, *sorted(entries), _INDEX_BLOCK_END])
        current = self.read_text("index.md")
        if current is None:
            raise WikiAccessError("index.md is missing")
        newline = "\r\n" if "\r\n" in current else "\n"
        block = block.replace("\n", newline)
        start, end = current.find(_INDEX_BLOCK_START), current.find(_INDEX_BLOCK_END)
        if start >= 0 and end > start:
            updated = current[:start] + block + current[end + len(_INDEX_BLOCK_END):]
        else:
            updated = (current.rstrip("\r\n") + newline * 2 + "## 自动整理" + newline * 2
                       + block + newline)
        if updated == current:
            return False
        self.write_text("index.md", updated, expected=current)
        return True

    def list_candidates(
        self, *, review_status: str = "pending", limit: int = 20, any_profile: bool = False
    ) -> List[Dict[str, Any]]:
        """Bounded summaries of managed inbox candidates, oldest first."""
        wanted = str(review_status or "pending").strip().casefold()
        if wanted not in {"pending", "needs_review", "applied", "approved", "rejected", "all"}:
            raise WikiAccessError(
                "review_status must be pending, needs_review, applied, approved, rejected, or all"
            )
        limit = _bounded_int(limit, 20, 1, 50)
        rows = []
        for document in self._iter_scoped_documents(candidates=True):
            if not _is_managed_candidate(document):
                continue
            if not any_profile and not scope_visible(document.metadata, self.settings.profile_name):
                continue
            status = _metadata_text(document.metadata, "review_status") or "pending"
            state = _metadata_text(document.metadata, "consolidation_state")
            if wanted == "needs_review":
                if status != "pending" or state != "needs_review":
                    continue
            elif wanted != "all" and status != wanted:
                continue
            plan = document.metadata.get("proposed_plan")
            rows.append(
                {
                    "candidate_id": str(document.metadata.get("candidate_id", "")),
                    "path": document.relative_path,
                    "title": document.title,
                    "type": str(document.metadata.get("type", "")),
                    "kind": str(document.metadata.get("kind", "")),
                    "scope": scope_of(document.metadata),
                    "created": str(document.metadata.get("created", "")),
                    "review_status": status,
                    "consolidation_state": state,
                    "proposed_op": str(plan.get("op", "")) if isinstance(plan, dict) else "",
                    "review_reason": str(document.metadata.get("review_reason", ""))[:200],
                    "reason": str(document.metadata.get("reason", ""))[:200],
                    "excerpt": _truncate(_candidate_content(document), 400)[0],
                }
            )
        rows.sort(key=lambda row: (row["created"], row["path"]))
        return rows[:limit]

    def review_candidate(
        self,
        *,
        candidate_id: str,
        action: str,
        reviewer: str,
        note: str = "",
    ) -> Dict[str, Any]:
        """Record an explicit candidate decision without promoting canonical truth."""
        candidate_id = str(candidate_id or "").strip()
        action = str(action or "").strip().casefold()
        reviewer = str(reviewer or "").strip()
        note = str(note or "").strip()
        if not re.fullmatch(r"[0-9a-f]{12}", candidate_id):
            raise WikiAccessError("candidate_id must be a 12-character lowercase hex digest")
        if action not in _REVIEW_ACTIONS:
            raise WikiAccessError("action must be approve or reject")
        if not reviewer or len(reviewer) > 160 or "\n" in reviewer or "\r" in reviewer:
            raise WikiAccessError("reviewer must be a single line of at most 160 characters")
        if len(note) > 500 or "\n" in note or "\r" in note:
            raise WikiAccessError("note must be a single line of at most 500 characters")
        _guard_candidate_text(reviewer, note)

        # Look the candidate up through iter_documents (the original path the race tests hook).
        matches = [
            document
            for document in self.iter_documents(include_historical=True)
            if _is_managed_candidate(document)
            and str(document.metadata.get("candidate_id", "")) == candidate_id
            and scope_visible(document.metadata, self.settings.profile_name)
        ]
        if len(matches) != 1:
            raise WikiAccessError("candidate does not exist or is ambiguous")
        document = matches[0]
        reviewed_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        metadata = dict(document.metadata)
        metadata.update(
            {
                "review_status": _REVIEW_ACTIONS[action],
                "reviewed_at": reviewed_at,
                "reviewed_by": reviewer,
                "review_note": note,
            }
        )
        original_text = (
            "---\n"
            + yaml.safe_dump(document.metadata, allow_unicode=True, sort_keys=False).strip()
            + "\n---\n\n"
            + document.body
            + "\n"
        )
        original_size = len(original_text.encode("utf-8"))
        rendered = (
            "---\n"
            + yaml.safe_dump(metadata, allow_unicode=True, sort_keys=False).strip()
            + "\n---\n\n"
            + document.body
            + "\n"
        )
        rel = self._validated_relative_markdown(document.relative_path)
        if len(rel.parts) != 2 or rel.parts[0] != "inbox":
            raise WikiAccessError("candidate must remain inside inbox")
        root_fd: Optional[int] = None
        inbox_fd: Optional[int] = None
        fd: Optional[int] = None
        try:
            root_fd = self._open_wiki_root_fd()
            inbox_fd = os.open("inbox", self._directory_flags(), dir_fd=root_fd)
            fd = os.open(
                rel.name,
                os.O_RDWR
                | getattr(os, "O_NOFOLLOW", 0)
                | getattr(os, "O_CLOEXEC", 0),
                dir_fd=inbox_fd,
            )
            candidate_info = os.fstat(fd)
            if not stat.S_ISREG(candidate_info.st_mode):
                raise WikiAccessError("candidate changed during review")
            if candidate_info.st_size != original_size:
                raise WikiAccessError("candidate changed during review")
            os.lseek(fd, 0, os.SEEK_SET)
            check_fd = os.dup(fd)
            try:
                with os.fdopen(check_fd, "r", encoding="utf-8") as check:
                    check_fd = -1
                    if check.read(original_size + 1) != original_text:
                        raise WikiAccessError("candidate changed during review")
            finally:
                if check_fd >= 0:
                    os.close(check_fd)
            os.fchmod(fd, 0o600)
            os.lseek(fd, 0, os.SEEK_SET)
            os.ftruncate(fd, 0)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                fd = None
                handle.write(rendered)
                handle.flush()
                os.fsync(handle.fileno())
            self._ensure_file_current(inbox_fd, rel.name, candidate_info)
            self._ensure_directory_fd_current(root_fd, ("inbox",), inbox_fd)
            self._ensure_root_fd_current(root_fd)
        except WikiAccessError:
            raise
        except OSError as exc:
            raise WikiAccessError("candidate changed during review") from exc
        finally:
            if fd is not None:
                os.close(fd)
            if inbox_fd is not None:
                os.close(inbox_fd)
            if root_fd is not None:
                os.close(root_fd)

        audit_line = (
            f"- {reviewed_at} candidate `{candidate_id}` action `{action}` "
            f"by `{reviewer}`"
            + (f": {note}" if note else "")
            + "\n"
        )
        root_fd = None
        log_fd: Optional[int] = None
        try:
            root_fd = self._open_wiki_root_fd()
            log_fd = os.open(
                "log.md",
                os.O_WRONLY
                | os.O_APPEND
                | getattr(os, "O_NOFOLLOW", 0)
                | getattr(os, "O_CLOEXEC", 0),
                dir_fd=root_fd,
            )
            log_info = os.fstat(log_fd)
            if not stat.S_ISREG(log_info.st_mode):
                raise WikiAccessError("audit log is not a regular file")
            with os.fdopen(log_fd, "a", encoding="utf-8") as handle:
                log_fd = None
                handle.write(audit_line)
                handle.flush()
                os.fsync(handle.fileno())
            self._ensure_file_current(root_fd, "log.md", log_info)
            self._ensure_root_fd_current(root_fd)
        except WikiAccessError:
            raise
        except OSError as exc:
            raise WikiAccessError("audit log changed during review") from exc
        finally:
            if log_fd is not None:
                os.close(log_fd)
            if root_fd is not None:
                os.close(root_fd)
        return {
            "success": True,
            "candidate_id": candidate_id,
            "path": document.relative_path,
            "review_status": _REVIEW_ACTIONS[action],
        }
