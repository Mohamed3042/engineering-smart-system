"""BOQ parser: header detection, numbers, sections, continuation lines and BMU relevance."""
from __future__ import annotations

import pytest

from ess.documents.boq import find_header, header_role, is_relevant, parse_boq_rows, parse_boq_text, parse_number


@pytest.mark.parametrize("cell,role", [
    ("Item", "ref"), ("Item No.", "ref"), ("S/N", "ref"), ("البند", "ref"),
    ("Description", "description"), ("Description of Works", "description"), ("البيان", "description"),
    ("Qty", "qty"), ("Quantity", "qty"), ("Total Qty", "qty"), ("الكمية", "qty"),
    ("Unit", "unit"), ("UOM", "unit"), ("الوحدة", "unit"),
    ("Rate (KD)", "rate"), ("Unit Price", "rate"), ("Price", "rate"), ("سعر الوحدة", "rate"),
    ("Amount (KWD)", "amount"), ("Total Price", "amount"), ("المبلغ", "amount"), ("السعر الإجمالي", "amount"),
    ("Remarks", None), ("", None), (None, None),
])
def test_header_roles(cell, role):
    assert header_role(cell) == role


@pytest.mark.parametrize("value,number", [
    ("1,250.500", 1250.5), ("1.250,5", 1250.5), ("١٢٥٠", 1250.0), ("KD 1,200", 1200.0), ("(500)", -500.0),
    (3, 3.0), (2.5, 2.5), ("1 No", 1.0), ("2 sets", None), ("Rate only", None), ("-", None), ("Incl.", None),
    (None, None), (True, None),
])
def test_parse_number(value, number):
    assert parse_number(value) == number


@pytest.mark.parametrize("text,hit", [
    ("Roof-mounted BMU with telescopic jib", True),
    ("Building Maintenance Units (2 nos)", True),
    ("Window-cleaning cradle, motorised", True),
    ("Façade access equipment as per 11 24 23", True),
    ("Monorail track and trolley", True),
    ("Davit arms and sockets", True),
    ("Suspended working platform (gondola)", True),
    ("Fall arrest anchor points on roof", True),
    ("تنظيف الواجهات الزجاجية", True),
    ("Aluminium entrance doors", False),
    ("Painting of plant room", False),
    ("Submit O&M manuals", False),
])
def test_relevance_keywords(text, hit):
    assert bool(is_relevant(text)) is hit


def test_rows_with_repeated_headers_headings_and_notes():
    rows = [
        ["PROJECT: TOWER", None, None],
        ["Ref", "Description", "Qty", "Unit", "Rate", "Amount"],
        ["A", "PRELIMINARIES"],
        ["A.1", "Site establishment", "1", "LS", "", ""],
        ["", "including temporary offices", "", "", "", ""],
        ["Ref", "Description", "Qty", "Unit", "Rate", "Amount"],  # header repeated on the next printed page
        ["BILL NO. 5 - SPECIALIST WORKS"],
        ["", "Supply the following:"],
        ["5.1", "Gondola system complete", "2", "Sets", "", ""],
        ["5.2", "Temporary works", "Item", "", "", ""],
        ["", "Page total", "", "", "", "12,000"],
    ]
    assert find_header(rows) == (1, {"ref": 0, "description": 1, "qty": 2, "unit": 3, "rate": 4, "amount": 5})
    items = parse_boq_rows(rows, sheet="Bill 5")
    assert [i["ref"] for i in items] == ["A.1", "5.1", "5.2"]
    assert items[0]["description"] == "Site establishment including temporary offices"
    assert items[0]["section"] == "A PRELIMINARIES" and items[0]["unit"] == "LS" and items[0]["qty"] == 1
    assert items[1]["section"] == "BILL NO. 5 - SPECIALIST WORKS › Supply the following:"
    assert items[1]["relevant"] and items[1]["match"] == "gondola" and items[1]["row"] == 9
    assert items[2]["unit"] == "Item" and items[2]["qty"] is None and items[2]["sheet"] == "Bill 5"
    assert parse_boq_rows([["no header here"], ["1", "2"]]) == []


def test_section_makes_items_relevant():
    rows = [
        ["Item", "Description", "Unit", "Qty"],
        ["11 24 23", "FACADE ACCESS EQUIPMENT"],
        ["1", "Electrical power supply to roof", "LS", "1"],
    ]
    [item] = parse_boq_rows(rows)
    assert item["relevant"] and item["section"] == "11 24 23 FACADE ACCESS EQUIPMENT"


def test_layout_text_boq():
    text = (
        "BILL OF QUANTITIES\n"
        "Item    Description                                      Qty      Unit     Rate       Amount\n"
        "        DIVISION 11 - EQUIPMENT\n"
        "11.1    Building maintenance unit, roof mounted            1      No\n"
        "        complete with cradle and controls\n"
        "11.2    Aluminium louvres                                 25      m2     12.500     312.500\n"
    )
    items, rows = parse_boq_text(text, page=4)
    assert rows[0] == ["ref", "description", "qty", "unit", "rate", "amount"]
    assert [(i["ref"], i["qty"], i["unit"], i["relevant"]) for i in items] == [
        ("11.1", 1.0, "No", True), ("11.2", 25.0, "m2", False)]
    assert items[0]["description"] == "Building maintenance unit, roof mounted complete with cradle and controls"
    assert items[1]["rate"] == 12.5 and items[1]["amount"] == 312.5 and items[1]["page"] == 4
    assert items[0]["section"] == "DIVISION 11 - EQUIPMENT"
    assert parse_boq_text("no table here") == ([], [])
