"""Product catalog prefill (the builder's v1.4.0 catalog shape, e.g. scaffolding-catalog.json).

The catalog is private company data: ``<private>/catalog/*.json`` (never in the repository)::

    {"schema": 1, "units": {"each": {"en": "Each", "ar": "للوحدة"}, ...},
     "transactions": [{"id": "sale", "label": {"en": ..., "ar": ...}}, ...],
     "products": [{"id", "family", "name": {"en", "ar"}, "aliases": [...],
                   "specification": {"en", "ar"}, "default_units": {"sale": "each"},
                   "transactions": ["sale", "rental"],
                   "prices": [{"year", "transaction", "amount", "currency", "unit", "context"}]}]}

Choosing a product fills description, specification and units only. ``unit_price`` / ``total``
always stay empty: a dated historical price is returned separately as ``price_hint`` guidance
for the engineer and is never copied into a quotation (rule 3: no invented prices).
"""
from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

try:  # optional fuzzy ranking (a project dependency, but keep the module importable without it)
    from rapidfuzz import fuzz
except Exception:  # pragma: no cover
    fuzz = None

# A catalog unit is the *price* unit (per month, per day, per lot ...); the quantity is counted in
# these units. Time and lot units count pieces: two scaffolds rented per month are "2 No.".
QTY_UNITS = {
    "set": {"en": "Set", "ar": "طقم"},
    "metre": {"en": "m", "ar": "متر"},
    "square_metre": {"en": "m²", "ar": "م²"},
    "coil": {"en": "Coil", "ar": "لفة"},
    "visit": {"en": "Visit", "ar": "زيارة"},
    "project": {"en": "Lot", "ar": "مقطوعية"},
}
_PIECES = {"en": "No.", "ar": "عدد"}


@dataclass(frozen=True)
class CatalogProduct:
    id: str
    name: Mapping[str, str]
    specification: Mapping[str, str] = field(default_factory=dict)
    family: str = ""
    aliases: tuple[str, ...] = ()
    default_units: Mapping[str, str] = field(default_factory=dict)
    transactions: tuple[str, ...] = ()
    prices: tuple[Mapping[str, Any], ...] = ()  # historical guidance only
    source: str = ""

    def text(self, language: str = "en") -> tuple[str, str]:
        lang = "ar" if language == "ar" else "en"
        name = self.name.get(lang) or self.name.get("en") or self.name.get("ar") or self.id
        spec = self.specification.get(lang) or self.specification.get("en") or ""
        return name, spec

    def unit_key(self, transaction: str | None = None) -> str | None:
        if transaction and transaction in self.default_units:
            return self.default_units[transaction]
        return next(iter(self.default_units.values()), None)


@dataclass
class Catalog:
    products: list[CatalogProduct] = field(default_factory=list)
    units: dict[str, dict[str, str]] = field(default_factory=dict)
    transactions: list[dict[str, Any]] = field(default_factory=list)
    sources: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def get(self, product_id: str) -> CatalogProduct | None:
        return next((p for p in self.products if p.id == product_id), None)

    def unit_label(self, unit_key: str | None, language: str = "en") -> str:
        if not unit_key:
            return ""
        labels = self.units.get(unit_key) or {}
        return labels.get("ar" if language == "ar" else "en") or labels.get("en") or unit_key

    def search(self, query: str = "", *, language: str = "en", transaction: str | None = None,
               limit: int = 20) -> list[dict[str, Any]]:
        return search_catalog(query, self, language=language, transaction=transaction, limit=limit)

    def to_dict(self) -> dict[str, Any]:
        return {"sources": list(self.sources), "units": self.units, "transactions": self.transactions,
                "products": len(self.products), "warnings": list(self.warnings)}


# --------------------------------------------------------------------------------------------
def _normalize(text: str) -> str:
    """Case-, diacritic- and Arabic-letter-variant-insensitive form for matching."""
    text = unicodedata.normalize("NFKC", str(text or "")).casefold()
    text = re.sub(r"[\u064b-\u065f\u0670\u0640]", "", text)  # harakat, dagger alef, tatweel
    text = text.translate(str.maketrans({"أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ى": "ي", "ة": "ه", "ؤ": "و", "ئ": "ي"}))
    text = "".join(ch for ch in unicodedata.normalize("NFKD", text) if not unicodedata.combining(ch))
    return re.sub(r"[^\w]+", " ", text).strip()


def _strings(value: Any) -> dict[str, str]:
    if isinstance(value, Mapping):
        return {str(k): str(v) for k, v in value.items() if isinstance(v, str) and v.strip()}
    if isinstance(value, str) and value.strip():
        return {"en": value}
    return {}


def _product(raw: Any, source: str) -> CatalogProduct | None:
    if not isinstance(raw, Mapping) or not raw.get("id"):
        return None
    name = _strings(raw.get("name"))
    if not name:
        return None
    prices = tuple(p for p in (raw.get("prices") or []) if isinstance(p, Mapping))
    return CatalogProduct(
        id=str(raw["id"]),
        name=name,
        specification=_strings(raw.get("specification")),
        family=str(raw.get("family") or ""),
        aliases=tuple(str(a) for a in raw.get("aliases") or [] if isinstance(a, str)),
        default_units={str(k): str(v) for k, v in (raw.get("default_units") or {}).items()}
        if isinstance(raw.get("default_units"), Mapping) else {},
        transactions=tuple(str(t) for t in raw.get("transactions") or [] if isinstance(t, str)),
        prices=prices,
        source=source,
    )


def load_catalog(private_dir: Path | str | None) -> Catalog:
    """Merge every ``<private>/catalog/*.json``. Missing folder -> empty catalog."""
    catalog = Catalog()
    if not private_dir:
        return catalog
    folder = Path(private_dir) / "catalog"
    if not folder.is_dir():
        return catalog
    seen: set[str] = set()
    for path in sorted(folder.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(data, Mapping) or not isinstance(data.get("products"), list):
                raise ValueError("no products list")
        except Exception as exc:
            catalog.warnings.append(f"{path.name}: not a catalog ({exc.__class__.__name__}).")
            continue
        catalog.sources.append(path.name)
        for key, labels in (data.get("units") or {}).items():
            if isinstance(labels, Mapping):
                catalog.units.setdefault(str(key), _strings(labels))
        known = {t.get("id") for t in catalog.transactions}
        for transaction in data.get("transactions") or []:
            if isinstance(transaction, Mapping) and transaction.get("id") not in known:
                catalog.transactions.append({"id": str(transaction.get("id")), "label": _strings(transaction.get("label"))})
        for raw in data["products"]:
            product = _product(raw, path.name)
            if product is None:
                catalog.warnings.append(f"{path.name}: a product without id or name was skipped.")
            elif product.id in seen:
                catalog.warnings.append(f"{path.name}: duplicate product id {product.id!r} ignored.")
            else:
                seen.add(product.id)
                catalog.products.append(product)
    return catalog


def price_hint(product: CatalogProduct, catalog: Catalog | None = None, *, transaction: str | None = None,
               unit: str | None = None, language: str = "en") -> dict[str, Any] | None:
    """Latest dated historical price for this transaction (and unit): guidance, never a price."""
    prices = [p for p in product.prices
              if (not transaction or p.get("transaction") == transaction) and (not unit or p.get("unit") == unit)
              and isinstance(p.get("amount"), (int, float))]
    if not prices:
        return None
    latest = max(prices, key=lambda p: int(p.get("year") or 0))
    unit_label = catalog.unit_label(latest.get("unit"), language) if catalog else str(latest.get("unit") or "")
    amount = f"{latest['amount']:,.3f}".rstrip("0").rstrip(".")
    currency = str(latest.get("currency") or "KWD")
    context = str(latest.get("context") or "")
    if language == "ar":
        text = f"استرشاد تاريخي فقط ({latest.get('year')}): {amount} {'د.ك' if currency == 'KWD' else currency} / {unit_label}"
    else:
        text = f"Historical guidance only ({latest.get('year')}): {amount} {currency} / {unit_label}"
    return {
        "year": latest.get("year"), "amount": latest["amount"], "currency": currency,
        "unit": latest.get("unit"), "unit_label": unit_label, "transaction": latest.get("transaction"),
        "context": context, "text": text + (f" — {context}" if context else ""),
    }


def catalog_item(product: CatalogProduct, catalog: Catalog | None = None, *, language: str = "en",
                 transaction: str | None = None, qty: Any = None, no: Any = None) -> dict[str, Any]:
    """A quotation item prefilled from the catalog. Prices stay ``None`` for the engineer."""
    name, spec = product.text(language)
    unit_key = product.unit_key(transaction)
    lang = "ar" if language == "ar" else "en"
    price_unit = catalog.unit_label(unit_key, lang) if catalog else (unit_key or "")
    qty_unit = QTY_UNITS.get(unit_key or "", _PIECES)[lang]
    return {
        "no": no, "description": name, "spec": spec or None, "qty": qty, "unit": qty_unit,
        "price_unit": price_unit or None, "unit_price": None, "total": None, "catalog_id": product.id,
    }


def search_catalog(query: str = "", catalog: Catalog | Path | str | None = None, *, language: str = "en",
                   transaction: str | None = None, limit: int = 20) -> list[dict[str, Any]]:
    """Products matching ``query`` (English or Arabic, aliases included), best first.

    ``catalog`` is a loaded :class:`Catalog` or a private directory (default: the app's).
    Each result carries the prefill (``description``, ``spec``, ``unit``) and a separate
    ``price_hint`` (dated guidance or ``None``).
    """
    if not isinstance(catalog, Catalog):
        if catalog is None:
            from ..config import get_settings

            catalog = get_settings().private_dir
        catalog = load_catalog(catalog)
    wanted = _normalize(query)
    tokens = wanted.split()
    results = []
    for product in catalog.products:
        if transaction and transaction not in product.transactions:
            continue
        names = [_normalize(n) for n in product.name.values()] + [_normalize(a) for a in product.aliases]
        specs = [_normalize(s) for s in product.specification.values()]
        score = 0.0
        if tokens:
            name_hits = sum(1 for token in tokens if any(token in n for n in names))
            other_hits = sum(1 for token in tokens if not any(token in n for n in names)
                             and (any(token in s for s in specs) or token in _normalize(product.id + " " + product.family)))
            phrase = any(wanted in n for n in names) or any(wanted in s for s in specs)
            # Relevant only when the name / an alias matches, or the whole phrase is in the spec.
            if not phrase and (name_hits == 0 or name_hits + other_hits < (len(tokens) + 1) // 2):
                continue
            score = 10 * name_hits + 4 * other_hits + (50 if any(wanted in n for n in names) else 0)
            if fuzz is not None:
                score += max(fuzz.partial_ratio(wanted, n) for n in names) / 10
        item = catalog_item(product, catalog, language=language, transaction=transaction)
        results.append({
            "product_id": product.id,
            "family": product.family,
            "description": item["description"],
            "spec": item["spec"],
            "unit": item["unit"],
            "price_unit": item["price_unit"],
            "transactions": list(product.transactions),
            "score": round(score, 1),
            "price_hint": price_hint(product, catalog, transaction=transaction,
                                     unit=product.unit_key(transaction) if transaction else None, language=language),
        })
    results.sort(key=lambda r: (-r["score"], r["description"]))
    return results[: max(1, int(limit))]
