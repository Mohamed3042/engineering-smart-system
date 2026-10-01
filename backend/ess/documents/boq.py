"""Bill-of-quantities parsing for spreadsheets, Word tables, CSV and PDF text.

``parse_boq_rows(rows)`` finds the header row (Item/Ref/No, Description, Qty, Unit, Rate,
Amount and their Arabic equivalents), carries section headings ("DIVISION 11 – EQUIPMENT",
"11 24 23 Façade Access Equipment") into every item, joins wrapped description lines and
flags rows about building maintenance units / window cleaning / façade access.

``parse_boq_text(text)`` does the same for column-aligned text (PDF "layout" extraction).
Items are plain dicts: ``{ref, description, qty, unit, rate, amount, section, row, relevant,
match}`` plus ``sheet``/``page`` when known. Numbers are floats (``None`` when blank/text);
the original cell text is kept in ``qty_text``/``rate_text``/``amount_text`` when not numeric.
"""
from __future__ import annotations

import re
import unicodedata
from datetime import date, datetime
from typing import Any, Sequence

__all__ = [
    "RELEVANT_PATTERNS",
    "find_header",
    "header_role",
    "is_relevant",
    "parse_boq_rows",
    "parse_boq_text",
    "parse_number",
]

ROLES = ("ref", "description", "qty", "unit", "rate", "amount")

# Phrases that make a BOQ line relevant to a façade-access / BMU contractor.
RELEVANT_PATTERNS: tuple[str, ...] = (
    r"\bbmus?\b",
    r"building\s+maintenance\s+units?",
    r"gondolas?",
    r"\bcradles?\b",
    r"window[\s-]*clean",
    r"glass[\s-]*clean",
    r"glazing[\s-]*clean",
    r"facade[\s-]*(access|cleaning|maintenance|maint\b|equipment)",
    r"\bmonorails?\b",
    r"\bdavits?\b",
    r"suspended\s+(working\s+)?(platforms?|access|cradles?|stages?)",
    r"roof[\s-]*(car|trolley|track)s?\b",
    r"rope[\s-]*access",
    r"fall[\s-]*arrest",
    r"man[\s-]*riding",
    r"travel+ing\s+(ladders?|gantr(y|ies)|cradles?)",
    r"access\s+equipment",
    r"maintenance\s+equipment",
    r"\banchor(age)?\s+points?\b",
    r"roof\s+anchors?",
    r"\b11\s?24\s?(23|00)\b",
    r"وحدة\s*صيانة\s*المبان",
    r"صيانة\s*الواجه",
    r"تنظيف\s*الواجه",
    r"تنظيف\s*النواف",
    r"تنظيف\s*الزجاج",
    r"جندول",
    r"سل[ةه]\s*معلق",
    r"منص[ةه]\s*معلق",
    r"مونوريل",
)
_RELEVANT_RE = re.compile("|".join(f"(?:{p})" for p in RELEVANT_PATTERNS), re.I)

_TOTAL_RE = re.compile(
    r"^\s*(sub[\s-]*total|total|grand\s+total|page\s+total|total\s+carried|carried\s+(forward|to)|brought\s+forward"
    r"|collection|summary|المجموع|الإجمالي|الاجمالي|مجموع|إجمالي|المرحل|ما\s*قبله)\b",
    re.I,
)
_DIVISION_RE = re.compile(
    r"^\s*(division|div\.?|bill(\s+no\.?|\s+of)?|part|section|schedule|volume|chapter|trade|package"
    r"|القسم|الباب|الجزء|جدول|الفصل)\b",
    re.I,
)
_MASTERFORMAT_RE = re.compile(r"^\s*\d{2}\s?\d{2}\s?\d{2}(\.\d+)?\b")
_UNIT_TOKENS = {
    "no", "nos", "no.", "nos.", "nr", "number", "item", "items", "ls", "l.s", "l.s.", "lump sum", "lumpsum", "lot",
    "lots", "set", "sets", "m", "m2", "m²", "sqm", "sq.m", "m3", "m³", "cum", "lm", "rm", "r.m", "kg", "ton",
    "tons", "t", "sum", "pc", "pcs", "each", "ea", "unit", "units", "job", "month", "months", "day", "days",
    "visit", "visits", "year", "yr", "ps", "p.s", "p.s.", "prov sum", "عدد", "مقطوعية", "م2", "م3", "م.ط", "طقم",
}
_ARABIC_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹٫٬", "01234567890123456789.,")


_ALEF = str.maketrans({"أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا"})


def _fold(text: str) -> str:
    """Lower-case, Latin accents removed (façade -> facade), Arabic alef forms unified,
    whitespace collapsed."""
    decomposed = unicodedata.normalize("NFKD", str(text))
    kept = "".join(ch for ch in decomposed if not unicodedata.combining(ch) or "؀" <= ch <= "ۿ")
    text = unicodedata.normalize("NFC", kept).translate(_ALEF)
    return re.sub(r"\s+", " ", text).strip().lower()


def is_relevant(*texts: str | None) -> str | None:
    """The matched phrase when any text is about BMU / window cleaning / façade access."""
    for text in texts:
        if not text:
            continue
        match = _RELEVANT_RE.search(_fold(text))
        if match:
            return match.group(0)
    return None


def _cell_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return re.sub(r"\s+", " ", str(value)).strip()


def parse_number(value: Any) -> float | None:
    """``1,250.500`` / ``1.250,5`` / ``١٢٥٠`` / ``KD 1,200`` -> float; blanks and text -> None."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().translate(_ARABIC_DIGITS)
    if not text or text.lower() in ("-", "--", "—", "n/a", "na", "nil", "incl", "incl.", "included", "excluded"):
        return None
    negative = text.startswith("(") and text.endswith(")")
    cleaned = re.sub(r"[^\d.,\-]", "", text)
    if not re.search(r"\d", cleaned):
        return None
    if re.search(r"[a-z؀-ۿ]{3,}", text.lower()) and not re.match(r"^\s*(kd|kwd|qar|qr|aed|sar|usd|\$|bd|omr|ro)\b", text.lower()):
        # words around the digits ("2 sets", "Rate only") -> not a clean number
        if not re.fullmatch(r"[\d.,\s]+[a-z]{0,3}\.?", text.lower()):
            return None
    if cleaned.count(",") and cleaned.count("."):
        if cleaned.rfind(",") > cleaned.rfind("."):
            cleaned = cleaned.replace(".", "").replace(",", ".")
        else:
            cleaned = cleaned.replace(",", "")
    elif cleaned.count(","):
        cleaned = cleaned.replace(",", "") if re.fullmatch(r"-?\d{1,3}(,\d{3})+", cleaned) else cleaned.replace(",", ".")
    if cleaned.count(".") > 1:
        cleaned = cleaned.replace(".", "", cleaned.count(".") - 1)
    try:
        number = float(cleaned)
    except ValueError:
        return None
    return -number if negative else number


def header_role(cell: Any) -> str | None:
    """Which BOQ column a header cell names (``None`` for anything else)."""
    text = _fold(_cell_text(cell))
    if not text or len(text) > 60:
        return None
    text = re.sub(r"\((kd|kwd|k\.d\.?|qar|aed|sar|usd|omr|bhd|fils|dinars?|currency|.{0,6})\)", " ", text)
    text = re.sub(r"\b(kd|kwd|qar|aed|sar|usd|omr|bhd)\b", " ", text)
    text = re.sub(r"[^\w\s/#؀-ۿ]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return None
    if re.search(r"الإجمالي|الاجمالي|اجمالي|إجمالي|المجموع|المبلغ", text):
        return "amount"  # before "سعر": "السعر الإجمالي" is the total price
    if re.search(r"\b(unit\s*(rate|price|cost)|rates?|u\s*/?\s*rate|price\s*per\s*unit|unit\s*value)\b", text) or re.fullmatch(
        r"(unit\s*)?price", text
    ) or re.search(r"سعر\s*الوحد|الفئ|^فئ|^السعر|سعر", text):
        return "rate"
    if re.search(r"\b(qty|qtys|quantity|quantities|qnty|qnt|no\s*of\s*units|number\s*of\s*units)\b", text) or re.search(
        r"الكمي|كمي|^العدد", text
    ):
        return "qty"
    if re.search(r"\b(amount|total|totals|total\s*(amount|price|cost|value)|value|extension|sum)\b", text) or re.search(
        r"المبلغ|الإجمالي|الاجمالي|القيم|المجموع|اجمالي|إجمالي", text
    ):
        return "amount"
    if re.search(r"^(units?|uom|u\s*o\s*m|unit\s*of\s*measure(ment)?|measure|unit\s*type)$", text) or re.search(
        r"^(ال)?وحد", text
    ):
        return "unit"
    if re.search(
        r"\b(description|descriptions|item\s*description|particulars|details|specifications?|scope|works?|"
        r"description\s*of\s*(the\s*)?works?|item\s*details|activity|trade\s*description)\b",
        text,
    ) or re.search(r"الوصف|البيان|وصف|بيان", text):
        return "description"
    if re.fullmatch(
        r"(item|items|item\s*no|item\s*ref|ref|ref\s*no|reference|no|s\s*no|sl\s*no|sr\s*no|serial|serial\s*no|code|pos|"
        r"position|#|bill\s*ref|item\s*code|clause|s/n|sn)",
        text,
    ) or re.fullmatch(r"(البند|رقم البند|بند|م|مسلسل|الرقم|رقم|ت)", text):
        return "ref"
    return None


def find_header(rows: Sequence[Sequence[Any]], *, scan: int = 60) -> tuple[int, dict[str, int]] | None:
    """(row index, {role: column}) of the most convincing header row, if any."""
    best: tuple[int, dict[str, int]] | None = None
    for idx, row in enumerate(rows[:scan]):
        roles: dict[str, int] = {}
        for col, cell in enumerate(row):
            role = header_role(cell)
            if role and role not in roles:
                roles[role] = col
        if "description" not in roles:
            continue
        others = len(roles) - 1
        if others < 2:
            continue
        if best is None or len(roles) > len(best[1]):
            best = (idx, roles)
            if len(roles) == len(ROLES):
                break
    return best


def _heading_level(text: str, ref: str) -> int:
    """1 = division/bill/part, 2 = sub-section, 0 = not a heading."""
    full = f"{ref} {text}".strip()
    if _DIVISION_RE.match(full) or _DIVISION_RE.match(text):
        return 1
    if _MASTERFORMAT_RE.match(full) or _MASTERFORMAT_RE.match(text):
        return 2
    letters = [ch for ch in text if ch.isalpha()]
    latin = [ch for ch in letters if ch.isascii()]
    if latin and len(text) <= 150 and sum(ch.isupper() for ch in latin) / len(latin) >= 0.7 and len(latin) >= 3:
        return 2
    if text.endswith(":") and len(text) <= 150:
        return 2
    if ref and len(ref) <= 6 and re.fullmatch(r"[A-Z]{1,2}|[IVX]{1,5}|\d{1,2}", ref.strip(".")) and len(text) <= 120:
        return 2
    return 0


def _norm_ref(ref: str) -> str:
    return ref.strip().rstrip(".").strip()


def parse_boq_rows(
    rows: Sequence[Sequence[Any]],
    *,
    row_numbers: Sequence[int] | None = None,
    sheet: str | None = None,
    page: int | None = None,
) -> list[dict]:
    """BOQ items from a table (list of rows of cell values)."""
    found = find_header(rows)
    if found is None:
        return []
    header_idx, roles = found
    numbers = list(row_numbers) if row_numbers is not None else list(range(1, len(rows) + 1))
    items: list[dict] = []
    division = ""
    subsection = ""
    last_item_pos = -10
    for pos in range(header_idx + 1, len(rows)):
        row = list(rows[pos])
        get = lambda role: row[roles[role]] if role in roles and roles[role] < len(row) else None  # noqa: E731
        ref = _norm_ref(_cell_text(get("ref")))
        desc = _cell_text(get("description"))
        qty_raw, unit_raw, rate_raw, amount_raw = get("qty"), get("unit"), get("rate"), get("amount")
        qty, rate, amount = parse_number(qty_raw), parse_number(rate_raw), parse_number(amount_raw)
        unit = _cell_text(unit_raw)
        mapped = set(roles.values())
        stray = [(_cell_text(v)) for c, v in enumerate(row) if c not in mapped and _cell_text(v)]
        nonempty = [v for v in row if _cell_text(v)]
        if not nonempty:
            continue
        if len(nonempty) >= 2 and all(header_role(v) for v in nonempty):
            continue  # header repeated at the top of a new page
        label = desc or " ".join(stray) or ref
        if _TOTAL_RE.match(label or "") or (not desc and _TOTAL_RE.match(" ".join(stray) or "")):
            continue
        qty_text = _cell_text(qty_raw)
        if qty is None and qty_text and not unit and qty_text.lower().strip(".") in {u.strip(".") for u in _UNIT_TOKENS}:
            unit, qty_text = qty_text, ""
        has_values = any(v is not None for v in (qty, rate, amount)) or bool(unit) or bool(qty_text)
        if not has_values:
            text = desc or " ".join(stray)
            if not text and ref:
                text, ref_for_heading = ref, ""
            else:
                ref_for_heading = ref
            if not text:
                continue
            level = _heading_level(text, ref_for_heading)
            heading = f"{ref_for_heading} {text}".strip() if ref_for_heading and not text.startswith(ref_for_heading) else text
            if level == 1:
                division, subsection = heading, ""
                continue
            if level == 0 and items and pos - last_item_pos <= 3 and (items[-1].get("section") or "") == _section(division, subsection):
                items[-1]["description"] = f"{items[-1]['description']} {text}".strip()
                last_item_pos = pos
                hit = is_relevant(text)
                if hit and not items[-1]["relevant"]:
                    items[-1]["relevant"], items[-1]["match"] = True, hit
                continue
            subsection = heading
            continue
        if not desc and stray:
            desc = " ".join(stray)
        section = _section(division, subsection)
        hit = is_relevant(desc, ref) or is_relevant(section)
        item = {
            "ref": ref or None,
            "description": desc,
            "qty": qty,
            "unit": unit or None,
            "rate": rate,
            "amount": amount,
            "section": section or None,
            "row": numbers[pos] if pos < len(numbers) else pos + 1,
            "relevant": bool(hit),
            "match": hit,
        }
        if qty is None and qty_text:
            item["qty_text"] = qty_text
        if rate is None and _cell_text(rate_raw):
            item["rate_text"] = _cell_text(rate_raw)
        if amount is None and _cell_text(amount_raw):
            item["amount_text"] = _cell_text(amount_raw)
        if sheet is not None:
            item["sheet"] = sheet
        if page is not None:
            item["page"] = page
        items.append(item)
        last_item_pos = pos
    return items


def _section(division: str, subsection: str) -> str:
    if division and subsection:
        return f"{division} › {subsection}"
    return division or subsection


# --------------------------------------------------------------------------- text (PDF) BOQs
_CHUNK_RE = re.compile(r"\S+(?: \S+)*")


def _chunks(line: str) -> list[tuple[int, int, str]]:
    return [(m.start(), m.end(), m.group(0)) for m in _CHUNK_RE.finditer(line)]


def _looks_numeric(text: str) -> bool:
    return parse_number(text) is not None and bool(re.fullmatch(r"[\d.,()\-\s٠-٩]+", text.translate(_ARABIC_DIGITS)))


def parse_boq_text(text: str, *, page: int | None = None) -> tuple[list[dict], list[list[str]]]:
    """BOQ items from column-aligned text. Returns (items, rows-as-cells)."""
    lines = [ln.rstrip() for ln in (text or "").splitlines()]
    header_line = None
    columns: list[tuple[str, int, int]] = []  # (role, start, end)
    for idx, line in enumerate(lines[:120]):
        chunks = _chunks(line)
        roles: list[tuple[str, int, int]] = []
        for start, end, chunk in chunks:
            role = header_role(chunk)
            if role is None and " " in chunk:  # "Item  Description" glued by a single space
                for sub in re.finditer(r"\S+", chunk):
                    sub_role = header_role(sub.group(0))
                    if sub_role:
                        roles.append((sub_role, start + sub.start(), start + sub.end()))
                continue
            if role:
                roles.append((role, start, end))
        names = {r for r, _s, _e in roles}
        if "description" in names and len(names) >= 3:
            header_line, columns = idx, roles
            break
    if header_line is None:
        return [], []
    order = [r for r, _s, _e in columns]
    desc_col = next(c for c in columns if c[0] == "description")
    next_starts = sorted(s for _r, s, _e in columns if s > desc_col[1])
    desc_end = next_starts[0] if next_starts else 10_000

    rows: list[list[str]] = [[r for r in order]]
    for line in lines[header_line + 1 :]:
        if not line.strip():
            continue
        cells = {r: "" for r in order}
        for start, end, chunk in _chunks(line):
            center = (start + end) / 2
            if _looks_numeric(chunk) or chunk.lower().strip(".") in {u.strip(".") for u in _UNIT_TOKENS}:
                numeric_cols = [c for c in columns if c[0] in ("qty", "rate", "amount", "unit")]
                if chunk.lower().strip(".") in {u.strip(".") for u in _UNIT_TOKENS} and any(c[0] == "unit" for c in columns):
                    role = "unit"
                elif numeric_cols:
                    role = min(numeric_cols, key=lambda c: abs((c[1] + c[2]) / 2 - center))[0]
                    if role == "unit":
                        role = min([c for c in numeric_cols if c[0] != "unit"] or numeric_cols,
                                   key=lambda c: abs((c[1] + c[2]) / 2 - center))[0]
                else:
                    role = "description"
                if role != "unit" and start < desc_col[1] - 1 and "ref" in cells and not cells["ref"]:
                    role = "ref"  # item numbers left of the description
            elif start < desc_col[1] - 1 and "ref" in cells:
                role = "ref"
            elif start < desc_end - 1 or "description" not in cells:
                role = "description"
            else:
                role = min(columns, key=lambda c: abs((c[1] + c[2]) / 2 - center))[0]
            cells[role] = f"{cells[role]} {chunk}".strip() if cells.get(role) else chunk
        rows.append([cells[r] for r in order])
    items = parse_boq_rows(rows, row_numbers=list(range(header_line + 1, header_line + 1 + len(rows))), page=page)
    for item in items:
        item["row"] = None if page is not None else item["row"]
    return items, rows
