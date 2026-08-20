"""Long-lived JSONL bridge around Hyperliquid's official Python SDK.

Secrets are read only from the runner process environment. Stdout is reserved for
one JSON reply per request; diagnostics go to stderr.
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
import sys
from decimal import Decimal, ROUND_DOWN
from typing import Any

from eth_account import Account
from hyperliquid.exchange import Exchange
from hyperliquid.utils.constants import MAINNET_API_URL, TESTNET_API_URL
from hyperliquid.utils.types import Cloid


def _address(value: str) -> str:
    return value.strip().lower()


PRIVATE_KEY = os.environ["HL_AGENT_PRIVATE_KEY"]
MASTER_ACCOUNT = _address(os.environ["HL_MASTER_ACCOUNT_ADDRESS"])
TARGETS: dict[str, dict[str, str]] = {
    _address(source): {
        "accountAddress": _address(target["accountAddress"]),
        **({"vaultAddress": _address(target["vaultAddress"])} if target.get("vaultAddress") else {}),
    }
    for source, target in json.loads(os.environ["HL_TARGETS_JSON"]).items()
}
TESTNET = os.environ.get("HL_TESTNET", "true").lower() == "true"
BASE_URL = TESTNET_API_URL if TESTNET else MAINNET_API_URL
CATCHUP_SLIPPAGE = float(os.environ.get("HL_CATCHUP_SLIPPAGE", "0.05"))
WALLET = Account.from_key(PRIVATE_KEY)
EXCHANGES: dict[str, Exchange] = {}
LAST_LEVERAGE: dict[tuple[str, str], tuple[str, int]] = {}
ORDER_OIDS: dict[str, set[str]] = {}


def _exchange(source: str) -> tuple[Exchange, dict[str, str]]:
    source = _address(source)
    target = TARGETS.get(source)
    if target is None:
        raise ValueError(f"No target account mapping for {source}")
    account = _address(target.get("accountAddress", ""))
    vault = _address(target.get("vaultAddress", "")) if target.get("vaultAddress") else ""
    if vault and account != vault:
        raise ValueError(f"Target account and vault/subaccount differ for {source}")
    if not vault and account != MASTER_ACCOUNT:
        raise ValueError(f"Direct target is not the configured master account for {source}")
    exchange = EXCHANGES.get(source)
    if exchange is None:
        exchange = Exchange(
            WALLET,
            base_url=BASE_URL,
            vault_address=target.get("vaultAddress"),
            account_address=MASTER_ACCOUNT,
        )
        EXCHANGES[source] = exchange
    return exchange, target


def _round_size(exchange: Exchange, coin: str, quantity: float) -> float:
    asset = exchange.info.name_to_asset(coin)
    decimals = exchange.info.asset_to_sz_decimals[asset]
    quantum = Decimal(1).scaleb(-decimals)
    rounded = Decimal(str(quantity)).quantize(quantum, rounding=ROUND_DOWN)
    if rounded <= 0:
        raise ValueError(f"Scaled {coin} quantity rounds to zero at {decimals} size decimals")
    return float(rounded)


def _order_type(request: dict[str, Any]) -> dict[str, Any]:
    label = str(request.get("orderType") or "").lower()
    if request.get("isTrigger"):
        trigger_price = float(request.get("triggerPrice") or 0)
        if trigger_price <= 0:
            raise ValueError("Trigger clone is missing a valid trigger price")
        if "take" in label or "tp" in label:
            tpsl = "tp"
        elif "stop" in label or "sl" in label:
            tpsl = "sl"
        else:
            raise ValueError(f"Unable to classify Hyperliquid trigger order type: {label}")
        return {"trigger": {"triggerPx": trigger_price, "isMarket": "market" in label, "tpsl": tpsl}}
    tif_raw = str(request.get("tif") or "").lower()
    tif = "Alo" if tif_raw == "alo" else "Ioc" if tif_raw == "ioc" or "market" in label else "Gtc"
    return {"limit": {"tif": tif}}


def _sync_leverage(exchange: Exchange, source: str, request: dict[str, Any]) -> None:
    if request.get("reduceOnly"):
        return
    leverage = request.get("leverage")
    if not isinstance(leverage, dict):
        raise ValueError("Exact source leverage is unavailable")
    leverage_type = leverage.get("type")
    value = int(leverage.get("value") or 0)
    if leverage_type not in ("cross", "isolated") or value < 1:
        raise ValueError("Exact source leverage is invalid")
    key = (_address(source), str(request["coin"]))
    setting = (str(leverage_type), value)
    if LAST_LEVERAGE.get(key) == setting:
        return
    response = exchange.update_leverage(value, str(request["coin"]), is_cross=leverage_type == "cross")
    if response.get("status") != "ok":
        raise RuntimeError(f"Hyperliquid rejected leverage sync: {response}")
    LAST_LEVERAGE[key] = setting


def _position_signed(exchange: Exchange, account: str, coin: str) -> float:
    state = exchange.info.user_state(account, coin.split(":", 1)[0] if ":" in coin else "")
    for item in state.get("assetPositions", []):
        position = item.get("position", {})
        reported_coin = str(position.get("coin", ""))
        if reported_coin == coin or reported_coin == coin.split(":", 1)[-1]:
            return float(position.get("szi") or 0)
    return 0.0


def _position_size(exchange: Exchange, account: str, coin: str) -> float:
    return abs(_position_signed(exchange, account, coin))


def _status_by_cloid(exchange: Exchange, account: str, cloid: str) -> dict[str, Any] | None:
    payload = exchange.info.post("/info", {"type": "orderStatus", "user": account, "oid": cloid})
    wrapper = payload.get("order") if isinstance(payload, dict) else None
    return wrapper if isinstance(wrapper, dict) and isinstance(wrapper.get("order"), dict) else None


def _open_status(wrapper: dict[str, Any] | None) -> bool:
    return str((wrapper or {}).get("status", "")).lower() == "open"


def _response_status(response: dict[str, Any]) -> tuple[str, str | None]:
    if response.get("status") != "ok":
        return "rejected", None
    statuses = (((response.get("response") or {}).get("data") or {}).get("statuses") or [])
    if not statuses:
        return "accepted", None
    status = statuses[0]
    if "resting" in status:
        return "resting", str(status["resting"].get("oid"))
    if "filled" in status:
        return "filled", str(status["filled"].get("oid"))
    if "error" in status:
        return f"error:{status['error']}", None
    return "accepted", None


def _place_or_modify(request: dict[str, Any]) -> dict[str, Any]:
    source = _address(request["sourceWhale"])
    exchange, target = _exchange(source)
    account = target["accountAddress"]
    cloid_raw = str(request["clientOrderId"])
    cloid = Cloid.from_str(cloid_raw)
    existing = _status_by_cloid(exchange, account, cloid_raw)
    if existing is not None and existing.get("order", {}).get("oid") is not None:
        ORDER_OIDS.setdefault(cloid_raw, set()).add(str(existing["order"]["oid"]))
    if request["action"] == "CANCEL":
        if _open_status(existing):
            response = exchange.cancel_by_cloid(str(request["coin"]), cloid)
            status = "canceled" if response.get("status") == "ok" else "rejected"
            return {"accepted": response.get("status") == "ok", "status": status}
        return {"accepted": True, "status": "already-terminal"}
    if existing is not None and not _open_status(existing):
        return {"accepted": True, "status": str(existing.get("status") or "already-terminal")}

    _sync_leverage(exchange, source, request)
    quantity = float(request["quantity"])
    if request.get("closeAll"):
        quantity = _position_size(exchange, account, str(request["coin"]))
    quantity = _round_size(exchange, str(request["coin"]), quantity)
    kwargs = {
        "name": str(request["coin"]),
        "is_buy": request["side"] == "BUY",
        "sz": quantity,
        "limit_px": float(request["price"]),
        "order_type": _order_type(request),
        "reduce_only": bool(request.get("reduceOnly")),
    }
    if _open_status(existing):
        response = exchange.modify_order(cloid, cloid=cloid, **kwargs)
    else:
        response = exchange.order(cloid=cloid, **kwargs)
    status, oid = _response_status(response)
    if oid is not None:
        ORDER_OIDS.setdefault(cloid_raw, set()).add(str(oid))
    accepted = response.get("status") == "ok" and not status.startswith("error:")
    return {"accepted": accepted, "status": status, "targetOrderId": oid, "quantity": quantity, **({"error": status} if not accepted else {})}


def _target_fills(exchange: Exchange, account: str, oids: set[str], start_time: int) -> list[dict[str, Any]]:
    if not oids:
        return []
    return [fill for fill in exchange.info.user_fills_by_time(account, max(0, start_time - 10_000)) if str(fill.get("oid")) in oids]


def _settle_filled_order(request: dict[str, Any]) -> dict[str, Any]:
    source = _address(request["sourceWhale"])
    exchange, target = _exchange(source)
    account = target["accountAddress"]
    coin = str(request["coin"])
    cloid_raw = str(request["clientOrderId"])
    cloid = Cloid.from_str(cloid_raw)
    wrapper = _status_by_cloid(exchange, account, cloid_raw)
    order = (wrapper or {}).get("order", {})
    oid = order.get("oid")
    if oid is not None:
        ORDER_OIDS.setdefault(cloid_raw, set()).add(str(oid))
    started_at = int(order.get("timestamp") or 0)
    fills = _target_fills(exchange, account, ORDER_OIDS.get(cloid_raw, set()), started_at)
    filled_quantity = sum(float(fill.get("sz") or 0) for fill in fills)

    if _open_status(wrapper):
        cancel = exchange.cancel_by_cloid(coin, cloid)
        if cancel.get("status") != "ok":
            raise RuntimeError(f"Unable to cancel target remainder before market catch-up: {cancel}")
        wrapper = _status_by_cloid(exchange, account, cloid_raw)
        order = (wrapper or {}).get("order", order)
        oid = order.get("oid", oid)
        if oid is not None:
            ORDER_OIDS.setdefault(cloid_raw, set()).add(str(oid))
        fills = _target_fills(exchange, account, ORDER_OIDS.get(cloid_raw, set()), started_at)
        filled_quantity = sum(float(fill.get("sz") or 0) for fill in fills)

    expected = _round_size(exchange, coin, float(request["quantity"]))
    desired_position_raw = request.get("targetPositionAfter")
    desired_position = float(desired_position_raw) if desired_position_raw is not None else None
    current_position = _position_signed(exchange, account, coin)
    if desired_position is not None:
        position_delta = desired_position - current_position
        deficit = abs(position_delta)
        catchup_is_buy = position_delta > 0
        catchup_reduce_only = current_position != 0 and current_position * position_delta < 0 and abs(position_delta) <= abs(current_position)
    else:
        deficit = _position_size(exchange, account, coin) if request.get("closeAll") else max(0.0, expected - filled_quantity)
        catchup_is_buy = request["side"] == "BUY"
        catchup_reduce_only = bool(request.get("reduceOnly"))
    minimum_unit = 10 ** -(exchange.info.asset_to_sz_decimals[exchange.info.name_to_asset(coin)])
    if deficit < minimum_unit / 2:
        return {"accepted": True, "status": "fully-filled-before-catch-up", "marketCatchUpQuantity": 0, "remainingQuantity": 0}

    deficit = _round_size(exchange, coin, deficit)
    catchup_cloid = Cloid.from_str("0x" + hashlib.sha256((cloid_raw + "|catchup").encode()).hexdigest()[:32])
    response = exchange.market_close(coin, sz=deficit, slippage=CATCHUP_SLIPPAGE, cloid=catchup_cloid) if catchup_reduce_only else exchange.market_open(
        coin, catchup_is_buy, deficit, slippage=CATCHUP_SLIPPAGE, cloid=catchup_cloid
    )
    if response is None:
        return {"accepted": True, "status": "position-already-closed", "marketCatchUpQuantity": 0, "remainingQuantity": 0}
    status, target_oid = _response_status(response)
    statuses = (((response.get("response") or {}).get("data") or {}).get("statuses") or [])
    filled = statuses[0].get("filled", {}) if statuses and isinstance(statuses[0], dict) else {}
    caught = float(filled.get("totalSz") or 0)
    average_price = float(filled.get("avgPx") or 0) if filled else 0.0
    if desired_position is not None:
        remaining = abs(desired_position - _position_signed(exchange, account, coin))
        caught = max(0.0, deficit - remaining)
    else:
        remaining = max(0.0, deficit - caught)
    reference = float(request["price"])
    slippage_bps = abs(average_price - reference) / reference * 10_000 if average_price > 0 and reference > 0 else None
    accepted = response.get("status") == "ok" and remaining < minimum_unit / 2
    return {
        "accepted": accepted,
        "status": status,
        "targetOrderId": target_oid,
        "marketCatchUpQuantity": caught,
        "marketCatchUpAveragePrice": average_price or None,
        "marketCatchUpSlippageBps": slippage_bps,
        "remainingQuantity": remaining,
        **({"error": f"Market catch-up left {remaining} {coin} unfilled"} if not accepted else {}),
    }


def _preflight(sources: list[str]) -> dict[str, Any]:
    results: dict[str, Any] = {}
    for source in sources:
        exchange, target = _exchange(source)
        state = exchange.info.user_state(target["accountAddress"])
        account_value = float((state.get("marginSummary") or {}).get("accountValue") or 0)
        open_orders = exchange.info.frontend_open_orders(target["accountAddress"])
        results[_address(source)] = {"accountValueUsd": account_value, "openOrderCount": len(open_orders)}
    return {"sdkVersion": importlib.metadata.version("hyperliquid-python-sdk"), "testnet": TESTNET, "targets": results}


def _handle(message: dict[str, Any]) -> Any:
    operation = message.get("op")
    if operation == "preflight":
        return _preflight(message.get("sourceWhales") or [])
    if operation == "cloneOrder":
        return _place_or_modify(message["request"])
    if operation == "settleFilledOrder":
        return _settle_filled_order(message["request"])
    raise ValueError(f"Unsupported bridge operation: {operation}")


for line in sys.stdin:
    try:
        message = json.loads(line)
        result = _handle(message)
        reply = {"id": message.get("id"), "ok": True, "result": result}
    except Exception as error:  # Deliberately isolate one command without killing the bridge.
        reply = {"id": locals().get("message", {}).get("id"), "ok": False, "error": f"{type(error).__name__}: {error}"}
    sys.stdout.write(json.dumps(reply, separators=(",", ":")) + "\n")
    sys.stdout.flush()
