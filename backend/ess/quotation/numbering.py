"""Quotation references: ``<representative initials>/<two-digit year>/<four-digit serial>``.

Historical Medmack references look like ``AA/26/0117`` (docs/corpus-analysis.md in the builder).
The next reference continues the highest serial already issued for the same initials and year.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable

_REFERENCE = re.compile(
    r"""^\s*
    (?P<initials>[A-Za-z]{1,5})\s*[/\\-]\s*
    (?P<year>\d{4}|\d{2})\s*[/\\-]\s*
    (?P<serial>\d{1,6})
    (?:\s*[-/ ]?\s*(?:R|REV)\.?\s*(?P<revision>\d{1,3}))?   # optional revision suffix: -R1, Rev.2
    \s*$""",
    re.IGNORECASE | re.VERBOSE,
)


@dataclass(frozen=True)
class Reference:
    initials: str
    year: int  # two-digit year, 0-99
    serial: int
    revision: int | None = None

    def __str__(self) -> str:
        return format_reference(self.initials, self.year, self.serial)


def normalize_initials(initials: str | None) -> str:
    """Upper-case letters only, at most three (the builder's rule); ``Q`` when nothing is left."""
    letters = re.sub(r"[^A-Z]", "", str(initials or "").upper())
    return letters[:3] or "Q"


def _two_digit_year(year: int | str) -> int:
    value = int(str(year).strip())
    if value < 0:
        raise ValueError(f"Invalid year: {year!r}")
    return value % 100


def format_reference(initials: str, year: int | str, serial: int) -> str:
    return f"{normalize_initials(initials)}/{_two_digit_year(year):02d}/{int(serial):04d}"


def parse_reference(reference: str | None) -> Reference | None:
    """Parse ``AA/26/0117`` (also ``aa-2026-117``, ``AA/26/0117-R1``). ``None`` when not a reference."""
    match = _REFERENCE.match(str(reference or ""))
    if not match:
        return None
    revision = match.group("revision")
    return Reference(
        initials=match.group("initials").upper(),
        year=_two_digit_year(match.group("year")),
        serial=int(match.group("serial")),
        revision=int(revision) if revision else None,
    )


def next_reference(initials: str, year: int | str, existing_refs: Iterable[str | None]) -> str:
    """Next free reference for these initials and year: highest existing serial + 1.

    >>> next_reference("AA", 2026, ["AA/26/0117", "AA/25/0400", "AB/26/0900"])
    'AA/26/0118'
    """
    wanted_initials = normalize_initials(initials)
    wanted_year = _two_digit_year(year)
    highest = 0
    for ref in existing_refs or ():
        parsed = parse_reference(ref)
        if parsed and normalize_initials(parsed.initials) == wanted_initials and parsed.year == wanted_year:
            highest = max(highest, parsed.serial)
    return format_reference(wanted_initials, wanted_year, highest + 1)
