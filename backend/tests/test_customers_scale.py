"""The customer directory pages, filters and sorts in SQL (built for ~10,000 companies)."""
import importlib
import tempfile

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("ESS_DATA_DIR", tempfile.mkdtemp(prefix="ess-cust-"))
    monkeypatch.setenv("ESS_SCHEDULER", "0")
    from ess import config, db

    config.get_settings.cache_clear()
    db.reset_engine()
    import ess.main as main

    importlib.reload(main)
    with TestClient(main.app) as c:
        c.post("/api/workspaces", json={"name": "Acme", "primary_email": "sales@acme.example", "owner_name": "Tester"})
        from ess.db import session_scope
        from ess.models import Customer
        from ess.workspace import get_active_workspace

        with session_scope() as s:
            ws = get_active_workspace(s)
            for i in range(250):
                s.add(Customer(workspace_id=ws.id, ref=f"c{i}.example", name=f"Company {i:03d}", domain=f"c{i}.example",
                               kind="main_contractor" if i % 2 else "consultant", enquiry_count=i % 7,
                               tags=[{"tag": "bmu" if i % 3 == 0 else "wce"}]))
            s.add(Customer(workspace_id=ws.id, ref="shop.example", name="Shop", kind="supplier"))
        yield c
    db.reset_engine()
    config.get_settings.cache_clear()


def test_pages_filters_and_facets(client):
    first = client.get("/api/customers", params={"page_size": 100, "sort": "name"}).json()
    assert first["total"] == 250 and len(first["items"]) == 100  # the supplier is not a work customer
    assert first["items"][0]["name"] == "Company 000"
    last = client.get("/api/customers", params={"page": 3, "page_size": 100, "sort": "name"}).json()
    assert len(last["items"]) == 50 and last["items"][-1]["name"] == "Company 249"
    bmu = client.get("/api/customers", params={"tag": "bmu", "kind": "consultant"}).json()
    assert bmu["total"] == sum(1 for i in range(250) if i % 3 == 0 and i % 2 == 0)
    assert dict(map(tuple, client.get("/api/customers").json()["tags"]))["bmu"] == 84
    busiest = client.get("/api/customers", params={"sort": "enquiries", "page_size": 1}).json()["items"][0]
    assert busiest["enquiry_count"] == 6
