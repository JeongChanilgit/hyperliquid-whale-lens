"""Append-only account evidence registry and immutable raw artifact store."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Iterable, Mapping

from .cache import atomic_write_json, read_json


REGISTRY_SCHEMA_VERSION = "1"
RESCUE_ENGINE_VERSION = "1"


class DataQualityStatus(str, Enum):
    VERIFIED_EXACT = "VERIFIED_EXACT"
    VERIFIED_INTERVAL = "VERIFIED_INTERVAL"
    VERIFIED_INTERVAL_WITH_GUARD = "VERIFIED_INTERVAL_WITH_GUARD"
    VERIFIED_BLOCK_RECONCILED = "VERIFIED_BLOCK_RECONCILED"
    VERIFIED_DERIVED_VALUE = "VERIFIED_DERIVED_VALUE"
    ESTIMATED_MODIFIED_DIETZ = "ESTIMATED_MODIFIED_DIETZ"
    BOUNDED = "BOUNDED"
    PROVISIONAL = "PROVISIONAL"
    RESCUE_PENDING = "RESCUE_PENDING"
    UNRESOLVED = "UNRESOLVED"


class ActivityStatus(str, Enum):
    QUALIFIED = "QUALIFIED"
    NO_OBSERVED_RAW_FILLS = "NO_OBSERVED_RAW_FILLS"
    INSUFFICIENT_COMPLETED_EPISODES = "INSUFFICIENT_COMPLETED_EPISODES"
    ACTIVITY_UNVERIFIABLE = "ACTIVITY_UNVERIFIABLE"
    NOT_YET_SCANNED = "NOT_YET_SCANNED"


class SelectionStatus(str, Enum):
    ACTIVE = "ACTIVE"
    STANDBY = "STANDBY"
    HIGH_POTENTIAL_WATCHLIST = "HIGH_POTENTIAL_WATCHLIST"
    WATCHLIST = "WATCHLIST"
    NOT_SELECTED = "NOT_SELECTED"


EXACT_RANKING_QUALITIES = frozenset(
    {
        DataQualityStatus.VERIFIED_EXACT,
        DataQualityStatus.VERIFIED_INTERVAL,
        DataQualityStatus.VERIFIED_INTERVAL_WITH_GUARD,
        DataQualityStatus.VERIFIED_BLOCK_RECONCILED,
        DataQualityStatus.VERIFIED_DERIVED_VALUE,
    }
)


def _canonical_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str) + "\n").encode("utf-8")


def _event_id(value: Mapping[str, Any]) -> str:
    return hashlib.sha256(_canonical_bytes(value)).hexdigest()


def _wallet(value: str) -> str:
    normalized = str(value).strip().lower()
    if len(normalized) != 42 or not normalized.startswith("0x"):
        raise ValueError("wallet must be a 20-byte 0x address")
    int(normalized[2:], 16)
    return normalized


def _append_unique(history: list[Any], entry: Mapping[str, Any]) -> None:
    candidate = dict(entry)
    candidate.setdefault("event_id", _event_id(candidate))
    if not any(isinstance(item, Mapping) and item.get("event_id") == candidate["event_id"] for item in history):
        history.append(candidate)


@dataclass(frozen=True)
class RawArtifactRef:
    sha256: str
    relative_path: str
    endpoint: str
    run_id: str
    captured_at_ms: int
    wallet: str | None = None
    coverage: Mapping[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "sha256": self.sha256,
            "relative_path": self.relative_path,
            "endpoint": self.endpoint,
            "run_id": self.run_id,
            "captured_at_ms": self.captured_at_ms,
            "wallet": self.wallet,
            "coverage": dict(self.coverage or {}),
        }


class EvidenceRegistry:
    """Content-addressed raw storage plus one append-only record per account."""

    def __init__(self, root: str | Path = "state/account-evidence-registry") -> None:
        self.root = Path(root)
        self.accounts = self.root / "accounts"
        self.runs = self.root / "runs"
        self.raw = self.root / "raw"
        self.root.mkdir(parents=True, exist_ok=True)
        schema_path = self.root / "schema-version.json"
        existing = read_json(schema_path)
        expected = {"schema_version": REGISTRY_SCHEMA_VERSION, "rescue_engine_version": RESCUE_ENGINE_VERSION}
        if existing is None:
            atomic_write_json(schema_path, expected)
        elif existing != expected:
            raise ValueError("evidence registry schema/engine version mismatch")

    def preserve_raw_artifact(
        self,
        *,
        endpoint: str,
        run_id: str,
        captured_at_ms: int,
        payload: Any,
        wallet: str | None = None,
        request_identity: Mapping[str, Any] | None = None,
        coverage: Mapping[str, Any] | None = None,
    ) -> RawArtifactRef:
        normalized_wallet = _wallet(wallet) if wallet else None
        envelope = {
            "schema_version": REGISTRY_SCHEMA_VERSION,
            "endpoint": str(endpoint),
            "run_id": str(run_id),
            "captured_at_ms": int(captured_at_ms),
            "wallet": normalized_wallet,
            "request_identity": dict(request_identity or {}),
            "coverage": dict(coverage or {}),
            "payload": payload,
        }
        digest = hashlib.sha256(_canonical_bytes(envelope)).hexdigest()
        relative = Path("raw") / digest[:2] / f"{digest}.json"
        target = self.root / relative
        if target.exists():
            current = target.read_bytes()
            if hashlib.sha256(current).hexdigest() == hashlib.sha256(_canonical_bytes(envelope)).hexdigest():
                pass
            elif json.loads(current.decode("utf-8")) != envelope:
                raise ValueError(f"immutable raw artifact collision: {digest}")
        else:
            atomic_write_json(target, envelope)
        return RawArtifactRef(
            sha256=digest,
            relative_path=relative.as_posix(),
            endpoint=str(endpoint),
            run_id=str(run_id),
            captured_at_ms=int(captured_at_ms),
            wallet=normalized_wallet,
            coverage=coverage,
        )

    def account_path(self, wallet: str) -> Path:
        return self.accounts / f"{_wallet(wallet)}.json"

    def load_account(self, wallet: str) -> dict[str, Any] | None:
        value = read_json(self.account_path(wallet))
        return dict(value) if isinstance(value, Mapping) else None

    def record_account(
        self,
        *,
        wallet: str,
        seen_at_ms: int,
        run_id: str,
        discovery: Mapping[str, Any] | None = None,
        evaluation: Mapping[str, Any] | None = None,
        raw_artifact_refs: Iterable[RawArtifactRef | Mapping[str, Any]] = (),
        latest_scores: Mapping[str, Any] | None = None,
        data_quality_status: DataQualityStatus | str = DataQualityStatus.PROVISIONAL,
        activity_status: ActivityStatus | str = ActivityStatus.NOT_YET_SCANNED,
        selection_status: SelectionStatus | str = SelectionStatus.NOT_SELECTED,
        reason_codes: Iterable[str] = (),
        unknown_delta_types: Iterable[str] = (),
        last_known_account_value_usd: Any = None,
        last_known_completed_episodes: int | None = None,
        rescue_attempt: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        address = _wallet(wallet)
        quality = DataQualityStatus(data_quality_status)
        activity = ActivityStatus(activity_status)
        selection = SelectionStatus(selection_status)
        existing = self.load_account(address) or {
            "schema_version": REGISTRY_SCHEMA_VERSION,
            "wallet": address,
            "first_seen_at_ms": int(seen_at_ms),
            "last_seen_at_ms": int(seen_at_ms),
            "last_evaluated_run_id": None,
            "discovery_history": [],
            "evaluation_history": [],
            "raw_artifact_refs": [],
            "latest_scores": {
                "provisional_twr": None,
                "exact_twr": None,
                "estimated_twr": None,
                "twr_lower_bound": None,
                "twr_upper_bound": None,
            },
            "data_quality_status": DataQualityStatus.PROVISIONAL.value,
            "activity_status": ActivityStatus.NOT_YET_SCANNED.value,
            "selection_status": SelectionStatus.NOT_SELECTED.value,
            "reason_codes": [],
            "rescue_attempts": [],
            "unknown_delta_types": [],
            "last_known_account_value_usd": None,
            "last_known_completed_episodes": None,
        }
        record = dict(existing)
        record["last_seen_at_ms"] = max(int(record.get("last_seen_at_ms", 0)), int(seen_at_ms))
        record["first_seen_at_ms"] = min(int(record.get("first_seen_at_ms", seen_at_ms)), int(seen_at_ms))
        record["last_evaluated_run_id"] = str(run_id)
        for field in ("discovery_history", "evaluation_history", "raw_artifact_refs", "rescue_attempts"):
            record[field] = list(record.get(field) or [])
        if discovery:
            _append_unique(record["discovery_history"], {"run_id": str(run_id), "seen_at_ms": int(seen_at_ms), **dict(discovery)})
        if evaluation:
            _append_unique(record["evaluation_history"], {"run_id": str(run_id), "evaluated_at_ms": int(seen_at_ms), **dict(evaluation)})
        for ref in raw_artifact_refs:
            value = ref.to_dict() if isinstance(ref, RawArtifactRef) else dict(ref)
            _append_unique(record["raw_artifact_refs"], value)
        if rescue_attempt:
            _append_unique(record["rescue_attempts"], {"run_id": str(run_id), **dict(rescue_attempt)})
        scores = dict(record.get("latest_scores") or {})
        scores.update({key: value for key, value in dict(latest_scores or {}).items() if key in scores})
        record["latest_scores"] = scores
        record["data_quality_status"] = quality.value
        record["activity_status"] = activity.value
        record["selection_status"] = selection.value
        record["reason_codes"] = sorted(set(map(str, record.get("reason_codes") or ())) | set(map(str, reason_codes)))
        record["unknown_delta_types"] = sorted(
            set(map(str, record.get("unknown_delta_types") or ())) | set(map(str, unknown_delta_types))
        )
        if last_known_account_value_usd is not None:
            record["last_known_account_value_usd"] = str(last_known_account_value_usd)
        if last_known_completed_episodes is not None:
            record["last_known_completed_episodes"] = int(last_known_completed_episodes)
        atomic_write_json(self.account_path(address), record)
        return record

    def write_run_manifest(self, run_id: str, manifest: Mapping[str, Any]) -> Path:
        payload = {"schema_version": REGISTRY_SCHEMA_VERSION, "run_id": str(run_id), **dict(manifest)}
        path = self.runs / f"{run_id}.json"
        existing = read_json(path)
        if existing is not None and existing != payload:
            raise ValueError("run evidence manifest is immutable")
        if existing is None:
            atomic_write_json(path, payload)
        return path

    def write_rescue_queue(self, entries: Iterable[Mapping[str, Any]]) -> Path:
        ordered = sorted(
            (dict(item) for item in entries),
            key=lambda item: (-float(item.get("priority", 0)), str(item.get("wallet", ""))),
        )
        path = self.root / "rescue-queue.json"
        atomic_write_json(
            path,
            {
                "schema_version": REGISTRY_SCHEMA_VERSION,
                "rescue_engine_version": RESCUE_ENGINE_VERSION,
                "entries": ordered,
            },
        )
        return path


__all__ = [
    "ActivityStatus",
    "DataQualityStatus",
    "EvidenceRegistry",
    "EXACT_RANKING_QUALITIES",
    "RawArtifactRef",
    "REGISTRY_SCHEMA_VERSION",
    "RESCUE_ENGINE_VERSION",
    "SelectionStatus",
]
