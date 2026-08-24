#!/usr/bin/env python3
"""Private-key sidecar for Faithful Mirror V2.

The process speaks newline-delimited JSON on stdin/stdout.  It never submits an
action itself: it returns a signed Hyperliquid action for Node's target socket
to post.  stdout is intentionally reserved for JSON replies only.
"""

from __future__ import annotations

import importlib.metadata
import json
import os
import re
import sys
from typing import Any, Callable


CONFIRMATION = "I_UNDERSTAND_LIVE_HYPERLIQUID_ORDERS"
ADDRESS_RE = re.compile(r"^0x[a-fA-F0-9]{40}$")
PRIVATE_KEY_RE = re.compile(r"^0x[a-fA-F0-9]{64}$")
CLOID_RE = re.compile(r"^0x[a-fA-F0-9]{32}$")
SECRET_HEX_RE = re.compile(r"0x[a-fA-F0-9]{64}")


class BridgeError(Exception):
    """Safe, request-level bridge error."""


def as_address(value: Any, name: str) -> str:
    candidate = str(value or "").strip()
    if not ADDRESS_RE.fullmatch(candidate):
        raise BridgeError(f"{name} must be a 20-byte address")
    return candidate.lower()


def as_positive(value: Any, name: str) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError) as error:
        raise BridgeError(f"{name} must be numeric") from error
    if not parsed > 0:
        raise BridgeError(f"{name} must be positive")
    return parsed


def as_bool(value: Any, name: str) -> bool:
    if not isinstance(value, bool):
        raise BridgeError(f"{name} must be boolean")
    return value


def normalize_coin(value: Any) -> str:
    coin = str(value or "").strip()
    if not coin:
        raise BridgeError("coin is required")
    return coin


def normalize_dex_coin(dex: str, value: Any) -> str:
    """Make a non-default DEX coin unambiguous before it reaches signing."""
    coin = normalize_coin(value)
    if not dex:
        return coin
    if ":" not in coin:
        return f"{dex}:{coin}"
    prefix, _ = coin.split(":", 1)
    if prefix != dex:
        raise BridgeError("coin DEX prefix does not match the queried DEX")
    return coin


def safe_error(error: BaseException, secrets: list[str]) -> str:
    text = str(error) or "bridge request rejected"
    for secret in secrets:
        if secret:
            text = text.replace(secret, "[REDACTED]")
    return SECRET_HEX_RE.sub("[REDACTED]", text)[:500]


def _perp_dex_names(info: Any) -> list[str]:
    """Return the canonical default DEX plus every SDK-reported HIP-3 DEX.

    ``Info.perp_dexs`` is the official public SDK route.  It reports builder
    DEX metadata, while the original perpetual DEX is always represented by
    the empty string in the remaining Info calls.  A malformed response is a
    preflight failure rather than a reason to omit an account partition.
    """
    try:
        payload = info.perp_dexs()
    except Exception as error:  # pragma: no cover - public-network behavior
        raise BridgeError("perpDexs preflight query failed") from error
    if not isinstance(payload, list):
        raise BridgeError("perpDexs preflight response is invalid")

    dexes = [""]
    seen = {""}
    for index, entry in enumerate(payload):
        if isinstance(entry, str):
            name = entry.strip()
        elif isinstance(entry, dict) and isinstance(entry.get("name"), str):
            name = entry["name"].strip()
        else:
            raise BridgeError(f"perpDexs preflight entry {index} is invalid")
        # Some SDK responses label the original DEX as an empty name; accept
        # the documented aliases defensively but always issue it as ``dex=""``.
        if name.lower() in {"", "main", "default", "perp"}:
            continue
        if name in seen:
            continue
        seen.add(name)
        dexes.append(name)
    return dexes


def _dedupe_preflight_record(
    seen: dict[tuple[str, str], dict[str, Any]],
    *,
    key: tuple[str, str],
    record: dict[str, Any],
    kind: str,
) -> bool:
    """Accept an exact duplicate but fail closed for contradictory records."""
    prior = seen.get(key)
    if prior is None:
        seen[key] = record
        return True
    if prior != record:
        raise BridgeError(f"conflicting duplicate {kind} in all-DEX preflight")
    return False


def collect_all_dex_target_state(info: Any, target_address: str) -> dict[str, Any]:
    """Read and normalize every target-account perpetual partition.

    The return shape deliberately keeps the exchange order fields intact for
    the Node cleanup path, adding ``dex`` so an order identity is never only
    an OID.  Positions and orders are deduplicated on (dex, coin) and
    (dex, oid) respectively.  Query and shape failures are fatal: a LIVE
    bridge must not sign after an incomplete target-account inventory.
    """
    dexes = _perp_dex_names(info)
    states: dict[str, dict[str, Any]] = {}
    positions: list[dict[str, Any]] = []
    orders: list[dict[str, Any]] = []
    seen_positions: dict[tuple[str, str], dict[str, Any]] = {}
    seen_orders: dict[tuple[str, str], dict[str, Any]] = {}

    for dex in dexes:
        label = dex or "main"
        try:
            # SDK 0.24.0 sends the required ``dex`` field for the default DEX
            # as well; never rely on an omitted field selecting main.
            state = info.user_state(target_address, dex=dex)
        except Exception as error:  # pragma: no cover - public-network behavior
            raise BridgeError(f"clearinghouseState preflight query failed for {label}") from error
        if not isinstance(state, dict):
            raise BridgeError(f"clearinghouseState preflight response is invalid for {label}")
        raw_positions = state.get("assetPositions")
        if not isinstance(raw_positions, list):
            raise BridgeError(f"clearinghouseState assetPositions is invalid for {label}")
        if not isinstance(state.get("marginSummary"), dict):
            raise BridgeError(f"clearinghouseState marginSummary is invalid for {label}")
        states[dex] = state

        for item in raw_positions:
            position = item.get("position") if isinstance(item, dict) else None
            if not isinstance(position, dict):
                raise BridgeError(f"clearinghouseState position is invalid for {label}")
            coin = normalize_dex_coin(dex, position.get("coin"))
            normalized = {"dex": dex, "coin": coin, "position": position}
            if _dedupe_preflight_record(
                seen_positions,
                key=(dex, coin),
                record=normalized,
                kind="position",
            ):
                positions.append(normalized)

        try:
            raw_orders = info.frontend_open_orders(target_address, dex=dex)
        except Exception as error:  # pragma: no cover - public-network behavior
            raise BridgeError(f"frontendOpenOrders preflight query failed for {label}") from error
        if not isinstance(raw_orders, list):
            raise BridgeError(f"frontendOpenOrders preflight response is invalid for {label}")
        for item in raw_orders:
            if not isinstance(item, dict):
                raise BridgeError(f"frontendOpenOrders order is invalid for {label}")
            coin = normalize_dex_coin(dex, item.get("coin"))
            oid = item.get("oid")
            if isinstance(oid, bool) or not (isinstance(oid, int) or (isinstance(oid, str) and oid.isdigit())):
                raise BridgeError(f"frontendOpenOrders oid is invalid for {label}")
            # Preserve all original fields for cancellation and attach the
            # queried DEX even when the exchange response omitted it.
            normalized = {**item, "coin": coin, "oid": oid, "dex": dex}
            if _dedupe_preflight_record(
                seen_orders,
                key=(dex, str(oid)),
                record=normalized,
                kind="order",
            ):
                orders.append(normalized)

    return {
        "dexes": dexes,
        "states": states,
        "positions": positions,
        "openOrders": orders,
    }


class HyperliquidPairSigner:
    def __init__(self) -> None:
        self.private_key = str(os.environ.get("FMV2_AGENT_PRIVATE_KEY", "")).strip()
        if not PRIVATE_KEY_RE.fullmatch(self.private_key):
            raise BridgeError("FMV2_AGENT_PRIVATE_KEY is missing or invalid")
        self.master_address = as_address(os.environ.get("FMV2_MASTER_ACCOUNT_ADDRESS"), "FMV2_MASTER_ACCOUNT_ADDRESS")
        self.target_address = as_address(os.environ.get("FMV2_TARGET_ACCOUNT_ADDRESS"), "FMV2_TARGET_ACCOUNT_ADDRESS")
        testnet_text = str(os.environ.get("FMV2_TESTNET", "")).strip().lower()
        if testnet_text not in {"true", "false"}:
            raise BridgeError("FMV2_TESTNET must be true or false")
        self.testnet = testnet_text == "true"
        self.expires_after_ms = int(os.environ.get("FMV2_ACTION_EXPIRES_AFTER_MS", "5000"))
        if self.expires_after_ms < 100 or self.expires_after_ms > 60_000:
            raise BridgeError("FMV2_ACTION_EXPIRES_AFTER_MS is outside the safe range")
        self.exclusive_target = str(os.environ.get("FMV2_EXCLUSIVE_TARGET_ACCOUNT", "true")).lower() == "true"
        self.adopt_existing = str(os.environ.get("FMV2_ADOPT_EXISTING_TARGET_STATE", "false")).lower() == "true"
        if self.exclusive_target and self.adopt_existing:
            raise BridgeError("exclusive and adopt-existing target policies conflict")
        self.sdk: dict[str, Any] | None = None
        self.info: Any | None = None
        self.wallet: Any | None = None
        self.preflight_complete = False

    @property
    def secret_values(self) -> list[str]:
        return [self.private_key]

    def _load_sdk(self) -> dict[str, Any]:
        if self.sdk is not None:
            return self.sdk
        # Kept lazy: a rejected mainnet signing request must not import the SDK
        # or make an HTTP request.
        try:
            from eth_account import Account
            from hyperliquid.info import Info
            from hyperliquid.utils import constants
            from hyperliquid.utils.signing import (
                float_to_usd_int,
                get_timestamp_ms,
                order_request_to_order_wire,
                order_wires_to_order_action,
                sign_l1_action,
            )
            from hyperliquid.utils.types import Cloid
        except Exception as error:  # pragma: no cover - dependent on local venv
            raise BridgeError("hyperliquid-python-sdk==0.24.0 is required") from error
        self.wallet = Account.from_key(self.private_key)
        base_url = constants.TESTNET_API_URL if self.testnet else constants.MAINNET_API_URL
        self.info = Info(base_url, skip_ws=True)
        self.sdk = {
            "Cloid": Cloid,
            "float_to_usd_int": float_to_usd_int,
            "get_timestamp_ms": get_timestamp_ms,
            "order_request_to_order_wire": order_request_to_order_wire,
            "order_wires_to_order_action": order_wires_to_order_action,
            "sign_l1_action": sign_l1_action,
        }
        return self.sdk

    def _require_signing(self) -> dict[str, Any]:
        if not self.testnet and os.environ.get("FMV2_PRODUCTION_CONFIRMED") != CONFIRMATION:
            raise BridgeError("mainnet signing requires FMV2_PRODUCTION_CONFIRMED")
        if not self.preflight_complete:
            raise BridgeError("preflight must succeed before any signing operation")
        return self._load_sdk()

    def _asset(self, coin: Any) -> int:
        if self.info is None:
            raise BridgeError("preflight must succeed before resolving assets")
        try:
            return int(self.info.name_to_asset(normalize_coin(coin)))
        except Exception as error:
            raise BridgeError("coin is not available in the preflight metadata") from error

    def _signed(self, action: dict[str, Any]) -> dict[str, Any]:
        sdk = self._require_signing()
        nonce = int(sdk["get_timestamp_ms"]())
        expires_after = nonce + self.expires_after_ms
        signature = sdk["sign_l1_action"](
            self.wallet,
            action,
            self.target_address,
            nonce,
            expires_after,
            not self.testnet,
        )
        return {
            "signedPayload": {
                "action": action,
                "nonce": nonce,
                "signature": signature,
                "vaultAddress": self.target_address,
                "expiresAfter": expires_after,
            }
        }

    def _order_request(self, order: dict[str, Any], *, require_cloid: bool) -> dict[str, Any]:
        sdk = self._require_signing()
        side = str(order.get("side", "")).upper()
        if side not in {"BUY", "SELL", "B", "A"}:
            raise BridgeError("order.side must be BUY or SELL")
        order_type = str(order.get("orderType", "LIMIT")).upper()
        trigger_price = order.get("triggerPrice")
        if trigger_price is not None or order_type.startswith("TRIGGER"):
            trigger_kind = str(order.get("tpsl") or order.get("triggerType") or "").lower()
            if trigger_kind not in {"tp", "sl"}:
                raise BridgeError("trigger order requires explicit tpsl=tp or sl")
            wire_type: dict[str, Any] = {
                "trigger": {
                    "triggerPx": as_positive(trigger_price, "order.triggerPrice"),
                    "isMarket": as_bool(order.get("triggerIsMarket"), "order.triggerIsMarket"),
                    "tpsl": trigger_kind,
                }
            }
        else:
            tif_by_name = {"GTC": "Gtc", "IOC": "Ioc", "ALO": "Alo"}
            tif = tif_by_name.get(str(order.get("tif", "GTC")).upper())
            if tif is None:
                raise BridgeError("order.tif must be GTC, IOC, or ALO")
            wire_type = {"limit": {"tif": tif}}
        request: dict[str, Any] = {
            "coin": normalize_coin(order.get("coin")),
            "is_buy": side in {"BUY", "B"},
            "sz": as_positive(order.get("quantity", order.get("targetRemainingSize")), "order.quantity"),
            "limit_px": as_positive(order.get("price"), "order.price"),
            "order_type": wire_type,
            "reduce_only": as_bool(order.get("reduceOnly", False), "order.reduceOnly"),
        }
        cloid = order.get("targetOrderId") or order.get("cloid")
        if require_cloid and not CLOID_RE.fullmatch(str(cloid or "")):
            raise BridgeError("order requires a canonical 16-byte targetOrderId cloid")
        if cloid is not None:
            if not CLOID_RE.fullmatch(str(cloid)):
                raise BridgeError("order cloid must be a canonical 16-byte hex value")
            request["cloid"] = sdk["Cloid"].from_str(str(cloid).lower())
        return request

    def preflight(self, _payload: dict[str, Any]) -> dict[str, Any]:
        # Reset an earlier successful result before every new inventory.  This
        # prevents a later partial all-DEX refresh from authorizing signing.
        self.preflight_complete = False
        self._load_sdk()
        assert self.info is not None
        try:
            target_inventory = collect_all_dex_target_state(self.info, self.target_address)
        except Exception as error:  # pragma: no cover - network behavior belongs to testnet validation
            raise BridgeError("target all-DEX preflight query failed") from error
        positions = target_inventory["positions"]
        open_orders = target_inventory["openOrders"]
        if positions and not self.adopt_existing:
            raise BridgeError("target has existing positions; adoptExistingTargetState is required")
        if open_orders and not self.exclusive_target:
            raise BridgeError("target has existing open orders but is not an exclusive target")
        self.preflight_complete = True
        try:
            version = importlib.metadata.version("hyperliquid-python-sdk")
        except importlib.metadata.PackageNotFoundError:  # pragma: no cover - dependency installation issue
            version = "unknown"
        return {
            "ok": True,
            "sdkVersion": version,
            "masterAccountAddress": self.master_address,
            "targetAddress": self.target_address,
            "targetRelationship": "CONFIGURED_TARGET_REQUIRES_TESTNET_OWNERSHIP_VALIDATION" if self.target_address != self.master_address else "MASTER_ACCOUNT",
            "accountEquityUsd": target_inventory["states"][""].get("marginSummary", {}).get("accountValue"),
            "openOrders": open_orders if self.exclusive_target else [],
            "existingPositionCount": len(positions),
            "queriedDexes": target_inventory["dexes"],
        }

    def sign_set_leverage(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._require_signing()
        leverage = payload.get("leverage")
        if not isinstance(leverage, dict):
            raise BridgeError("leverage object is required")
        kind = str(leverage.get("type", "")).lower()
        if kind not in {"cross", "isolated"}:
            raise BridgeError("leverage.type must be cross or isolated")
        value = int(as_positive(leverage.get("value"), "leverage.value"))
        return self._signed({"type": "updateLeverage", "asset": self._asset(payload.get("coin")), "isCross": kind == "cross", "leverage": value})

    def sign_adjust_isolated_margin(self, payload: dict[str, Any]) -> dict[str, Any]:
        sdk = self._require_signing()
        # The official 0.24.0 action has an isBuy field.  It is unsafe to infer
        # that side from a margin delta, so the caller must supply it explicitly.
        delta = float(payload.get("marginDeltaUsd"))
        if delta == 0:
            raise BridgeError("marginDeltaUsd must not be zero")
        action = {
            "type": "updateIsolatedMargin",
            "asset": self._asset(payload.get("coin")),
            "isBuy": as_bool(payload.get("isBuy"), "isBuy"),
            "ntli": sdk["float_to_usd_int"](delta),
        }
        return self._signed(action)

    def sign_upsert_order(self, payload: dict[str, Any]) -> dict[str, Any]:
        sdk = self._require_signing()
        order = payload.get("order")
        if not isinstance(order, dict):
            raise BridgeError("order object is required")
        request = self._order_request(order, require_cloid=True)
        wire = sdk["order_request_to_order_wire"](request, self._asset(request["coin"]))
        existing_oid = payload.get("existingOid")
        if existing_oid not in {None, ""}:
            oid: Any
            if isinstance(existing_oid, int) or str(existing_oid).isdigit():
                oid = int(existing_oid)
            elif CLOID_RE.fullmatch(str(existing_oid)):
                oid = sdk["Cloid"].from_str(str(existing_oid).lower())
                oid = oid.to_raw()
            else:
                raise BridgeError("existingOid must be an exchange OID or canonical cloid")
            return self._signed({"type": "batchModify", "modifies": [{"oid": oid, "order": wire}]})
        return self._signed(sdk["order_wires_to_order_action"]([wire]))

    def sign_cancel_order(self, payload: dict[str, Any]) -> dict[str, Any]:
        sdk = self._require_signing()
        asset = self._asset(payload.get("coin"))
        oid = payload.get("oid")
        if oid not in {None, ""}:
            if not (isinstance(oid, int) or str(oid).isdigit()):
                raise BridgeError("oid must be an exchange order ID")
            return self._signed({"type": "cancel", "cancels": [{"a": asset, "o": int(oid)}]})
        cloid = str(payload.get("cloid", ""))
        if not CLOID_RE.fullmatch(cloid):
            raise BridgeError("cancel requires oid or canonical cloid")
        return self._signed({"type": "cancelByCloid", "cancels": [{"asset": asset, "cloid": sdk["Cloid"].from_str(cloid.lower()).to_raw()}]})

    def sign_protected_ioc(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._require_signing()
        delta = float(payload.get("deltaSize"))
        if delta == 0:
            raise BridgeError("deltaSize must not be zero")
        mark = as_positive(payload.get("markPriceUsd"), "markPriceUsd")
        slippage_bps = float(payload.get("maxSlippageBps"))
        if slippage_bps < 0 or slippage_bps > 10_000:
            raise BridgeError("maxSlippageBps is outside the safe range")
        is_buy = delta > 0
        limit_price = mark * (1 + slippage_bps / 10_000) if is_buy else mark * (1 - slippage_bps / 10_000)
        request = self._order_request({
            "coin": payload.get("coin"),
            "side": "BUY" if is_buy else "SELL",
            "quantity": abs(delta),
            "price": limit_price,
            "tif": "IOC",
            "reduceOnly": as_bool(payload.get("reduceOnly", False), "reduceOnly"),
        }, require_cloid=False)
        sdk = self._require_signing()
        wire = sdk["order_request_to_order_wire"](request, self._asset(request["coin"]))
        return self._signed(sdk["order_wires_to_order_action"]([wire]))

    def dispatch(self, operation: str, payload: Any) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise BridgeError("payload must be an object")
        handlers: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
            "preflight": self.preflight,
            "signSetLeverage": self.sign_set_leverage,
            "signAdjustIsolatedMargin": self.sign_adjust_isolated_margin,
            "signUpsertOrder": self.sign_upsert_order,
            "signCancelOrder": self.sign_cancel_order,
            "signProtectedIoc": self.sign_protected_ioc,
        }
        handler = handlers.get(operation)
        if handler is None:
            raise BridgeError("unsupported operation")
        return handler(payload)


def run() -> int:
    try:
        bridge = HyperliquidPairSigner()
    except Exception as error:
        # Keep the process alive to return a JSON error per request, without
        # exposing an environment dump or a private key.
        bridge = None
        startup_error = safe_error(error, [os.environ.get("FMV2_AGENT_PRIVATE_KEY", "")])
    else:
        startup_error = None
    for raw_line in sys.stdin:
        request_id: Any = None
        try:
            request = json.loads(raw_line)
            if not isinstance(request, dict):
                raise BridgeError("request must be an object")
            request_id = request.get("id")
            if bridge is None:
                raise BridgeError(startup_error or "bridge initialization failed")
            result = bridge.dispatch(str(request.get("operation", "")), request.get("payload", {}))
            reply = {"id": request_id, "ok": True, "result": result}
        except Exception as error:
            secrets = bridge.secret_values if bridge is not None else [os.environ.get("FMV2_AGENT_PRIVATE_KEY", "")]
            reply = {"id": request_id, "ok": False, "error": safe_error(error, secrets)}
        sys.stdout.write(json.dumps(reply, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
