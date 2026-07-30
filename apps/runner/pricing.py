from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional


@dataclass(frozen=True)
class ModelPrice:
    provider: str
    model: str
    input_usd_per_million: float
    cached_input_usd_per_million: Optional[float]
    output_usd_per_million: float
    registry_version: str

    def cost(self, input_tokens: int, output_tokens: int, cached_input_tokens: int = 0) -> float:
        cached_tokens = min(max(0, cached_input_tokens), max(0, input_tokens))
        uncached_tokens = max(0, input_tokens) - cached_tokens
        cached_rate = self.cached_input_usd_per_million if self.cached_input_usd_per_million is not None else self.input_usd_per_million
        return (
            uncached_tokens * self.input_usd_per_million
            + cached_tokens * cached_rate
            + max(0, output_tokens) * self.output_usd_per_million
        ) / 1_000_000


@dataclass(frozen=True)
class CostReservation:
    amount_usd: float
    input_token_limit: int
    output_token_limit: int


class CostBudgetGuard:
    def __init__(self, max_cost_usd: float):
        self.max_cost_usd = float(max_cost_usd)
        self.spent_usd = 0.0
        self.reserved_usd = 0.0
        self._lock = threading.Lock()

    def reserve(self, price: ModelPrice, input_token_limit: int, output_token_limit: int) -> CostReservation:
        amount = price.cost(input_token_limit, output_token_limit)
        with self._lock:
            remaining = self.max_cost_usd - self.spent_usd - self.reserved_usd
            if amount > remaining + 1e-12:
                raise RuntimeError("evaluation cost budget cannot cover the next provider call")
            self.reserved_usd += amount
        return CostReservation(amount, input_token_limit, output_token_limit)

    def settle(self, reservation: CostReservation, actual_cost_usd: Optional[float]) -> float:
        charged = reservation.amount_usd if actual_cost_usd is None else float(actual_cost_usd)
        with self._lock:
            self.reserved_usd = max(0.0, self.reserved_usd - reservation.amount_usd)
            self.spent_usd += charged
        if charged > reservation.amount_usd + 1e-12:
            raise RuntimeError("provider usage exceeded the reserved evaluation cost")
        return charged


def conservative_input_token_limit(text: str) -> int:
    # Provider tokenizers are byte-based; UTF-8 bytes bound content tokens.
    # The fixed allowance covers chat-message framing and provider-side metadata.
    return len(text.encode("utf-8")) + 1024


def _load_registry() -> tuple[Dict[str, Any], Dict[tuple[str, str], ModelPrice]]:
    payload = json.loads(Path(__file__).with_name("pricing.json").read_text(encoding="utf-8"))
    version = str(payload["version"])
    if payload.get("currency") != "USD" or payload.get("unit") != "per_million_tokens":
        raise RuntimeError("invalid pricing registry units")
    prices: Dict[tuple[str, str], ModelPrice] = {}
    for entry in payload.get("models", []):
        price = ModelPrice(
            provider=str(entry["provider"]),
            model=str(entry["model"]),
            input_usd_per_million=float(entry["input_usd"]),
            cached_input_usd_per_million=float(entry["cached_input_usd"]) if entry.get("cached_input_usd") is not None else None,
            output_usd_per_million=float(entry["output_usd"]),
            registry_version=version,
        )
        key = (price.provider, price.model)
        if key in prices or price.input_usd_per_million < 0 or price.output_usd_per_million < 0 or (price.cached_input_usd_per_million is not None and price.cached_input_usd_per_million < 0):
            raise RuntimeError("invalid or duplicate model price")
        prices[key] = price
    return payload, prices


PRICING_REGISTRY, MODEL_PRICES = _load_registry()


def get_model_price(provider: str, model: str) -> Optional[ModelPrice]:
    return MODEL_PRICES.get((provider, model))


def pricing_metadata() -> Dict[str, Any]:
    return {
        "version": PRICING_REGISTRY["version"],
        "currency": PRICING_REGISTRY["currency"],
        "unit": PRICING_REGISTRY["unit"],
        "sources": list(PRICING_REGISTRY.get("sources", [])),
        "models": [
            {
                "provider": price.provider,
                "model": price.model,
                "input_usd": price.input_usd_per_million,
                "cached_input_usd": price.cached_input_usd_per_million,
                "output_usd": price.output_usd_per_million,
            }
            for price in MODEL_PRICES.values()
        ],
    }
