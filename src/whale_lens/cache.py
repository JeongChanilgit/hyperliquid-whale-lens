"""Atomic raw-response cache and checkpoint helpers for resumable screen runs."""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import time
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any


METRIC_VERSION = "1"
RAW_PAYLOAD_SCHEMA_VERSION = "1"


class ResumeValidationError(ValueError):
    """Raised when a checkpoint belongs to a materially different run."""


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def atomic_replace_with_retry(source: str | Path, destination: str | Path) -> None:
    """Replace a file atomically, tolerating brief Windows reader locks.

    Antivirus/indexers and status readers can transiently hold a destination
    without making the run invalid.  Retry only access/sharing violations for
    a bounded period; every other filesystem error remains immediately fatal.
    """

    for attempt in range(8):
        try:
            os.replace(source, destination)
            return
        except PermissionError:
            if attempt == 7:
                raise
            time.sleep(min(0.025 * (2**attempt), 0.2))


def atomic_write_json(path: Path, payload: Any) -> None:
    """Atomically replace ``path`` with UTF-8 JSON, leaving no partial target."""

    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = (_canonical_json(payload) + "\n").encode("utf-8")
    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        atomic_replace_with_retry(temporary_name, path)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def read_json(path: Path) -> Any | None:
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        return None


@dataclass(frozen=True)
class RawCacheKey:
    """Identity for data that may influence a fixed-window score.

    Including every field below prevents a prior day's raw response or a
    different metric/schema/mode from silently becoming a current-run score.
    """

    wallet: str | None
    endpoint: str
    window_start_ms: int
    window_end_ms: int
    as_of_ms: int
    metric_version: str = METRIC_VERSION
    raw_payload_schema_version: str = RAW_PAYLOAD_SCHEMA_VERSION
    coverage_mode: str = "FAST_INCREMENTAL"

    def __post_init__(self) -> None:
        if not self.endpoint:
            raise ValueError("cache endpoint must be non-empty")
        if self.window_end_ms < self.window_start_ms:
            raise ValueError("window_end_ms must not be before window_start_ms")
        if self.as_of_ms < self.window_end_ms:
            # A fixed as_of must be at least the endpoint's declared window end.
            raise ValueError("as_of_ms must not be before window_end_ms")

    def to_dict(self) -> dict[str, Any]:
        return {
            "wallet": self.wallet.lower() if self.wallet else None,
            "endpoint": self.endpoint,
            "window_start_ms": self.window_start_ms,
            "window_end_ms": self.window_end_ms,
            "as_of_ms": self.as_of_ms,
            "metric_version": self.metric_version,
            "raw_payload_schema_version": self.raw_payload_schema_version,
            "coverage_mode": self.coverage_mode,
        }

    @property
    def digest(self) -> str:
        return hashlib.sha256(_canonical_json(self.to_dict()).encode("utf-8")).hexdigest()


def make_raw_cache_key(
    *,
    wallet: str | None,
    endpoint: str,
    window_start_ms: int,
    window_end_ms: int,
    as_of_ms: int,
    metric_version: str = METRIC_VERSION,
    raw_payload_schema_version: str = RAW_PAYLOAD_SCHEMA_VERSION,
    coverage_mode: str = "FAST_INCREMENTAL",
) -> RawCacheKey:
    """Small named-argument constructor used by CLI stages and tests."""

    return RawCacheKey(
        wallet=wallet,
        endpoint=endpoint,
        window_start_ms=window_start_ms,
        window_end_ms=window_end_ms,
        as_of_ms=as_of_ms,
        metric_version=metric_version,
        raw_payload_schema_version=raw_payload_schema_version,
        coverage_mode=coverage_mode,
    )


class RawResponseCache:
    """Disk cache that stores raw/normalized data with its complete identity."""

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)

    @staticmethod
    def _endpoint_dir(endpoint: str) -> str:
        return re.sub(r"[^A-Za-z0-9_.-]+", "_", endpoint).strip("._") or "endpoint"

    def path_for(self, key: RawCacheKey) -> Path:
        return self.root / self._endpoint_dir(key.endpoint) / f"{key.digest}.json"

    def put(self, key: RawCacheKey, payload: Any, *, stored_at_ms: int | None = None, metadata: Mapping[str, Any] | None = None) -> Path:
        stored_at_ms = int(time.time() * 1000) if stored_at_ms is None else int(stored_at_ms)
        path = self.path_for(key)
        atomic_write_json(
            path,
            {
                "key": key.to_dict(),
                "stored_at_ms": stored_at_ms,
                "payload": payload,
                "metadata": dict(metadata or {}),
            },
        )
        return path

    def get_record(
        self,
        key: RawCacheKey,
        *,
        max_age_ms: int | None = None,
        now_ms: int | None = None,
    ) -> dict[str, Any] | None:
        record = read_json(self.path_for(key))
        if not isinstance(record, dict) or record.get("key") != key.to_dict():
            return None
        if max_age_ms is not None:
            stored_at = record.get("stored_at_ms")
            now_ms = int(time.time() * 1000) if now_ms is None else int(now_ms)
            if not isinstance(stored_at, int) or now_ms - stored_at > max_age_ms:
                return None
        return record

    def get(self, key: RawCacheKey, *, max_age_ms: int | None = None, now_ms: int | None = None) -> Any | None:
        record = self.get_record(key, max_age_ms=max_age_ms, now_ms=now_ms)
        return None if record is None else record.get("payload")


@dataclass(frozen=True)
class ResumeIdentity:
    run_id: str
    as_of_ms: int
    metric_version: str
    discovery_pool_hash: str
    coverage_mode: str

    @classmethod
    def from_checkpoint(cls, checkpoint: Mapping[str, Any]) -> "ResumeIdentity":
        try:
            return cls(
                run_id=str(checkpoint["run_id"]),
                as_of_ms=int(checkpoint["as_of_ms"]),
                metric_version=str(checkpoint["metric_version"]),
                discovery_pool_hash=str(checkpoint["discovery_pool_hash"]),
                coverage_mode=str(checkpoint["coverage_mode"]),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise ResumeValidationError(f"checkpoint lacks required resume identity: {exc}") from exc

    def to_dict(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "as_of_ms": self.as_of_ms,
            "metric_version": self.metric_version,
            "discovery_pool_hash": self.discovery_pool_hash,
            "coverage_mode": self.coverage_mode,
        }


def validate_resume(checkpoint: Mapping[str, Any], expected: ResumeIdentity) -> None:
    """Fail closed unless every fixed-run identity field exactly matches."""

    actual = ResumeIdentity.from_checkpoint(checkpoint)
    mismatches = [
        name
        for name in ("run_id", "as_of_ms", "metric_version", "discovery_pool_hash", "coverage_mode")
        if getattr(actual, name) != getattr(expected, name)
    ]
    if mismatches:
        raise ResumeValidationError("resume identity mismatch: " + ", ".join(mismatches))


class CheckpointStore:
    """Run checkpoint persistence.  Saving is atomic; loading validates identity."""

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)

    def path_for(self, run_id: str) -> Path:
        if not run_id or "/" in run_id or "\\" in run_id:
            raise ValueError("run_id must be a non-empty filename component")
        return self.root / f"{run_id}.checkpoint.json"

    def save(self, checkpoint: Mapping[str, Any]) -> Path:
        # Validate all required fields before replacing an existing checkpoint.
        identity = ResumeIdentity.from_checkpoint(checkpoint)
        if not identity.discovery_pool_hash:
            raise ResumeValidationError("checkpoint discovery_pool_hash must be non-empty")
        payload = dict(checkpoint)
        payload.setdefault("checkpoint_schema_version", 1)
        payload["updated_at_ms"] = int(time.time() * 1000)
        path = self.path_for(identity.run_id)
        atomic_write_json(path, payload)
        return path

    def load(self, run_id: str, *, expected: ResumeIdentity | None = None) -> dict[str, Any] | None:
        checkpoint = read_json(self.path_for(run_id))
        if checkpoint is None:
            return None
        if not isinstance(checkpoint, dict):
            raise ResumeValidationError("checkpoint must contain a JSON object")
        if expected is not None:
            validate_resume(checkpoint, expected)
        return checkpoint


# Short aliases keep CLI code readable while retaining explicit class names.
RawCache = RawResponseCache
RunCheckpointStore = CheckpointStore
