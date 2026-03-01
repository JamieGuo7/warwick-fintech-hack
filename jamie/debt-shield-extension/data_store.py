"""
Persistent data store — survives uvicorn --reload.
Users are written to debt_shield_users.json next to this file so the
in-memory dict is always warm after any hot-reload.
"""
import json
from pathlib import Path

_STORE_PATH = Path(__file__).parent / "debt_shield_users.json"

_cache: dict = {}


def _load() -> None:
    global _cache
    if _STORE_PATH.exists():
        try:
            _cache = json.loads(_STORE_PATH.read_text(encoding="utf-8"))
        except Exception:
            _cache = {}
    else:
        _cache = {}


def _flush() -> None:
    tmp = _STORE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(_cache, indent=2), encoding="utf-8")
    tmp.replace(_STORE_PATH)


# Warm the cache immediately on import
_load()


def save_user(user) -> None:
    """Persist a UserOnboarding (Pydantic model) by name."""
    _cache[user.name] = user.model_dump()
    _flush()


def get_user(name: str):
    """Return a UserOnboarding instance, or None if not found."""
    _load()  # re-read so hot-reloads never see stale data
    raw = _cache.get(name)
    if raw is None:
        return None
    from models import UserOnboarding
    return UserOnboarding(**raw)
