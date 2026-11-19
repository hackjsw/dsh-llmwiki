"""Completion types only. The DSH host provides every model call."""
from typing import Any, Callable, Dict

CompleteJson = Callable[[str, str, str, int], Dict[str, Any]]
