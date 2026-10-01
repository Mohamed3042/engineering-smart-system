"""ess.customers.opportunities: service-gap suggestions that never leave our own services."""
from __future__ import annotations

import itertools
import random
from datetime import datetime, timezone
from pathlib import Path

import pytest

from ess.customers.opportunities import learn_cross_sell, match_services, merge_cross_sell
from ess.customers.tagging import tag_customer
from ess.knowledge import base

FIXTURES = Path(__file__).parent / "fixtures" / "knowledge"
CROSS_SELL = FIXTURES / "data" / "cross_sell.json"
OURS = [{"key": "bmu", "label": "Building Maintenance Units"}, {"key": "wce", "label": "Window Cleaning Equipment"},
        {"key": "cradle", "label": "Suspended platforms"}, {"key": "access_rental", "label": "Access rental"},
        {"key": "annual_maintenance", "label": "Maintenance contracts"}]


@pytest.fixture(autouse=True)
def fixture_data(monkeypatch):
    monkeypatch.setattr(base, "DATA_DIR", FIXTURES / "data")
    base.clear_caches()
    yield
    base.clear_caches()


TAGS = [
    {"tag": "Building Maintenance Units", "kind": "need", "key": "bmu", "service_key": "bmu", "confidence": 0.8,
     "evidence": [{"quote": "RFQ - BMU for Al Noor Tower", "source": "email"}]},
    {"tag": "Main contractor", "kind": "role", "key": "main_contractor", "confidence": 0.7},
    {"tag": "High-rise towers", "kind": "sector", "key": "tower", "confidence": 0.65},
]


def test_match_services_suggests_adjacent_offered_services():
    out = match_services({"name": "Gulf Horizon"}, TAGS, OURS, CROSS_SELL)
    keys = [o["service_key"] for o in out]
    assert keys and "bmu" not in keys  # already asked for
    assert {"wce", "annual_maintenance", "cradle"} <= set(keys)
    assert not {"hoist", "scaffolding", "crane"} & set(keys)  # we do not offer them
    assert [o["score"] for o in out] == sorted((o["score"] for o in out), reverse=True)
    wce = next(o for o in out if o["service_key"] == "wce")
    assert wce["status"] == "suggested" and 0 < wce["score"] <= 0.95
    kinds = {e["kind"] for e in wce["evidence"]}
    assert {"adjacency", "project_type"} <= kinds  # two independent reasons reinforce
    assert wce["score"] > next(o for o in out if o["service_key"] == "access_rental")["score"]
    assert "davits or monorails" in wce["reason"]


def test_never_suggests_unoffered_services_property():
    rng = random.Random(7)
    all_keys = ["bmu", "wce", "cradle", "hoist", "crane", "scaffolding", "access_rental", "annual_maintenance",
                "inspection_certification", "supply_installation", "other_work"]
    kinds = ["main_contractor", "consultant", "facility_management", "government", "developer", "subcontractor"]
    sectors = ["tower", "hospital", "mall", "oil_gas", "school"]
    for _ in range(200):
        offered = rng.sample(all_keys, rng.randint(1, 6))
        ours = [{"key": k, "label": k} for k in offered]
        tags = [{"kind": "need", "key": k, "confidence": 0.8} for k in rng.sample(all_keys, rng.randint(0, 3))]
        tags += [{"kind": "role", "key": rng.choice(kinds), "confidence": 0.7},
                 {"kind": "sector", "key": rng.choice(sectors), "confidence": 0.6}]
        asked = {t["key"] for t in tags if t["kind"] == "need"}
        for o in match_services({}, tags, ours, CROSS_SELL, limit=0):
            assert o["service_key"] in offered and o["service_key"] not in asked
            assert o["service_key"] != "other_work"


def test_inactive_services_and_empty_inputs():
    ours = [{"key": "wce", "label": "WCE", "offered": False}, {"key": "cradle", "label": "Cradles"}]
    keys = [o["service_key"] for o in match_services({}, TAGS, ours, CROSS_SELL)]
    assert "wce" not in keys
    assert match_services({}, TAGS, [], CROSS_SELL) == []
    assert match_services({}, [], OURS, CROSS_SELL) == []


def test_customer_kind_and_plain_user_tags():
    out = match_services({"kind": "government", "kind_confidence": 0.9},
                         [{"tag": "Building Maintenance Units", "source": "user"}], OURS, CROSS_SELL)
    keys = [o["service_key"] for o in out]
    assert "bmu" not in keys  # the user's tag counts as already asked
    assert "annual_maintenance" in keys and "wce" in keys


def test_end_to_end_with_tagging():
    emails = [{"from_email": "a@client.example", "subject": "RFQ BMU for Marina Tower", "date": "2026-09-01",
               "body_text": "Kindly quote one BMU for Marina Tower."}]
    tags = tag_customer({"name": "Marina Contracting Co.", "domain": "client.example"}, emails,
                        [{"name": "Marina Tower", "service_family": "bmu"}], OURS,
                        now=datetime(2026, 9, 15, tzinfo=timezone.utc))
    out = match_services({"name": "Marina Contracting Co."}, tags, OURS, CROSS_SELL)
    assert out and {o["service_key"] for o in out} <= {o["key"] for o in OURS} - {"bmu"}


def test_learn_cross_sell_from_customer_needs():
    needs = {f"c{i}": {"chiller", "fan_coil_unit"} for i in range(5)}
    needs.update({f"d{i}": {"chiller"} for i in range(5)})
    needs.update({f"e{i}": {"pump"} for i in range(10)})
    learned = learn_cross_sell(needs)
    rules = {(r["from"], r["to"]) for r in learned["service_adjacency"]}
    assert ("fan_coil_unit", "chiller") in rules and ("chiller", "fan_coil_unit") in rules
    assert not any("pump" in pair for pair in rules)
    merged = merge_cross_sell(CROSS_SELL, learned)
    assert len(merged["service_adjacency"]) == 6 + len(learned["service_adjacency"])
    ours = [{"key": "chiller", "label": "Chillers"}, {"key": "fan_coil_unit", "label": "Fan coil units"}]
    out = match_services({}, [{"kind": "need", "key": "fan_coil_unit", "confidence": 0.9}], ours, learned)
    assert [o["service_key"] for o in out] == ["chiller"]
