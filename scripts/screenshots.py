"""Rendered screens for the visual review: every page on desktop and phone, and a separate image for
every dialog, on an invented sample workspace. No real data is read or shown.

    backend/.venv/Scripts/python scripts/screenshots.py        # Windows
    backend/.venv/bin/python scripts/screenshots.py            # macOS / Linux
    ... --no-build (reuse frontend/dist)   --only 26,27 (some states)   --keep (leave the app running)

Builds the interface, starts the app on a throwaway data folder (data/screenshots, git-ignored), fills
it with sample content through the same API the interface uses, then writes
docs/rendered/{desktop,phone}/*.png and docs/rendered/INDEX.md (route and viewport of every image).
"""
from __future__ import annotations

import argparse
import copy
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
DATA = ROOT / "data" / "screenshots"
OUT = ROOT / "docs" / "rendered"


def _free_port() -> int:
    import socket

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


PORT = _free_port()
BASE = f"http://127.0.0.1:{PORT}"
DEVICES = {
    "desktop": {"label": "1440 × 900", "ctx": {"viewport": {"width": 1440, "height": 900}, "device_scale_factor": 1}},
    "phone": {"label": "390 × 844 @2x", "ctx": {"viewport": {"width": 390, "height": 844}, "device_scale_factor": 2,
                                                  "is_mobile": True, "has_touch": True}},
}

# ----------------------------------------------------------------------------------- sample content
# Invented companies, people and tenders only (".example" domains). Extends backend/ess/demo.py.

WESTGATE_RFQ = (
    "Dear Sales Team,\n\nWe are bidding for the Marina Tower A tender as main contractor and invite your offer for "
    "the Building Maintenance Unit package.\nTender closing date: 12/11/2026.\n"
    "Validity of the offer: 90 days from the closing date.\n\nRegards,\nPriya Nair\nEstimation Engineer, Westgate Builders"
)
HARBOR_TERMS = (
    "Hello,\n\nFurther to our request for the BMU maintenance at Harbor Offices, please note:\n"
    "- the validity of your offer to be 120 days from the closing date\n"
    "- Contract period: 24 months from handover\n"
    "- comprehensive maintenance with spares for the full period.\n\nThanks,\nLiam O'Connor, Harbor Facilities"
)
ARABIC_REQUEST = (
    "السادة المحترمون،\n\nنرجو التكرم بفحص وحدة صيانة المبنى في برج العينة (ب) وتقديم عرض سعر لأعمال الإصلاح "
    "بعد الفحص. الوحدة متوقفة منذ أسبوعين.\n\nمع التحية،\nإدارة المرافق"
)


def _mail(id_, thread, sender, name, subject, date, body, category, project_ref=None, customer_ref=None):
    return {"id": id_, "thread_id": thread, "direction": "inbound", "from_name": name, "from_email": sender,
            "to": ["sales@sample-access.example"], "cc": [], "subject": subject, "date": date, "snippet": body[:180],
            "body_text": body, "labels": ["INBOX"], "attachments": [], "links": [], "category": category,
            "category_confidence": 0.86, "category_reason": "sample", "priority": "high", "state": "new",
            "project_ref": project_ref, "customer_ref": customer_ref}


def _ev(quote, source="demo-m1"):
    return [{"quote": quote, "source_type": "email", "source_id": source, "verified": True}]


KNOWLEDGE = [
    {"kind": "service_family", "key": "bmu", "label": "Building Maintenance Units", "label_ar": "وحدات صيانة المباني",
     "claim_basis": "delivered_work", "confidence": 0.92, "status": "owner_confirmed",
     "evidence": _ev("Building Maintenance Unit (BMU) for Marina Tower A")},
    {"kind": "service_family", "key": "wce", "label": "Window Cleaning Equipment", "label_ar": "معدات تنظيف الواجهات",
     "claim_basis": "delivered_work", "confidence": 0.88, "status": "suggested",
     "evidence": _ev("monorail with cradle and davit arms", "demo-c1")},
    {"kind": "service_family", "key": "hoist", "label": "Construction hoists", "label_ar": "رافعات إنشائية",
     "claim_basis": "catalogue_claim", "confidence": 0.61, "status": "suggested",
     "evidence": _ev("two (2) construction hoists", "demo-e1")},
    {"kind": "work_type", "key": "annual_maintenance", "label": "Annual maintenance", "label_ar": "صيانة سنوية",
     "claim_basis": "delivered_work", "confidence": 0.8, "status": "suggested",
     "evidence": _ev("24 months plus an optional 12 months", "demo-h1")},
    {"kind": "term", "key": "bmu_gondola", "label": "BMU", "label_ar": "وحدة صيانة المبنى", "region": "gulf",
     "synonyms": ["gondola (UK / EU)", "window-washing rig (US)", "фасадная люлька (Russia)", "façade access machine"],
     "claim_basis": "market_vocabulary", "confidence": 0.74, "status": "suggested",
     "evidence": _ev("Building Maintenance Unit (BMU)")},
    {"kind": "standard", "key": "en_1808", "label": "EN 1808 — suspended access equipment", "region": "uk_eu",
     "claim_basis": "catalogue_claim", "confidence": 0.7, "status": "suggested", "evidence": []},
    {"kind": "convention", "key": "quotation_reference", "label": "Quotation reference AA/26/0118",
     "description": "Signatory initials / year / running number.", "claim_basis": "delivered_work",
     "confidence": 0.9, "status": "owner_confirmed", "evidence": []},
]


def sample_snapshot() -> dict:
    sys.path.insert(0, str(BACKEND))
    from ess.demo import DEMO_SNAPSHOT

    snap = copy.deepcopy(DEMO_SNAPSHOT)
    snap["emails"] += [
        _mail("demo-w1", "demo-t8", "priya.nair@westgate.example", "Priya Nair", "Marina Tower A — BMU package enquiry",
              "2026-09-30T08:20:00Z", WESTGATE_RFQ, "bmu", "P-DEMO-MARINA", "westgate.example"),
        _mail("demo-h2", "demo-t4", "liam.oconnor@harborfacilities.example", "Liam O'Connor",
              "RE: BMU maintenance quote — Harbor Offices", "2026-09-30T10:05:00Z", HARBOR_TERMS, "bmu",
              "P-DEMO-HARBOR", "harborfacilities.example"),
        _mail("demo-a1", "demo-t9", "facilities@sample-tower.example", "إدارة المرافق",
              "طلب فحص وإصلاح وحدة صيانة المبنى", "2026-09-30T12:40:00Z", ARABIC_REQUEST, "bmu"),
    ]
    snap["customers"].append({"ref": "westgate.example", "name": "Westgate Builders", "domain": "westgate.example",
                              "kind": "main_contractor", "tags": ["Main contractor", "High-rise towers"],
                              "contacts": [{"name": "Priya Nair", "email": "priya.nair@westgate.example",
                                            "title": "Estimation Engineer"}]})
    marina = next(p for p in snap["projects"] if p["ref"] == "P-DEMO-MARINA")
    marina["changes"][0]["pending_confirmation"] = True  # the new closing date waits for a person
    marina["enquiries"].append({"ref": "E-DEMO-MARINA-WG", "customer_ref": "westgate.example",
                                "contact": {"name": "Priya Nair", "email": "priya.nair@westgate.example"},
                                "email_ids": ["demo-w1"], "thread_ids": ["demo-t8"],
                                "received_at": "2026-09-30T08:20:00Z", "due_date": "2026-11-12"})
    harbor = next(p for p in snap["projects"] if p["ref"] == "P-DEMO-HARBOR")
    harbor["enquiries"][0]["email_ids"].append("demo-h2")
    snap["knowledge"] = KNOWLEDGE
    return snap


def sample_assets(private: Path) -> None:
    """An invented signature (a scribble) and a round stamp marked SAMPLE: approved PDFs show them, drafts never do."""
    from PIL import Image, ImageDraw

    (private / "signatures").mkdir(parents=True, exist_ok=True)
    (private / "letterhead").mkdir(parents=True, exist_ok=True)
    sig = Image.new("RGBA", (600, 200), (0, 0, 0, 0))
    pts = [(30 + i * 9, 120 - 55 * ((i * 7919) % 13) / 13 + (25 if i % 4 == 0 else 0)) for i in range(60)]
    ImageDraw.Draw(sig).line(pts, fill=(24, 48, 140, 255), width=6, joint="curve")
    sig.save(private / "signatures" / "JE.png")
    stamp = Image.new("RGBA", (420, 420), (0, 0, 0, 0))
    d = ImageDraw.Draw(stamp)
    d.ellipse((10, 10, 410, 410), outline=(30, 60, 160, 200), width=12)
    d.ellipse((60, 60, 360, 360), outline=(30, 60, 160, 200), width=5)
    d.text((210, 210), "SAMPLE", fill=(30, 60, 160, 220), anchor="mm", font_size=72)
    stamp.save(private / "letterhead" / "stamp.png")


def seed() -> None:
    """A fresh sample workspace in DATA (the app is not running yet)."""
    sys.path.insert(0, str(BACKEND))
    from ess import config, db
    from ess.demo import DEMO_WORKSPACE
    from ess.models import Signatory
    from ess.pipeline.importer import import_snapshot
    from ess.workspace import create_workspace

    config.get_settings.cache_clear()
    sample_assets(config.get_settings().private_dir)
    db.init_db()
    with db.session_scope() as s:
        ws = create_workspace(s, dict(DEMO_WORKSPACE), owner_name="Jordan Ellis")
        import_snapshot(s, ws, sample_snapshot())
        ws.setup_step = "done"
        s.add(ws)
        s.add(Signatory(workspace_id=ws.id, initials="JE", full_name="Jordan Ellis", title="Sales Manager",
                        company=ws.company_name, city="Sample City", email=ws.primary_email, is_default=True))
    db.reset_engine()


# ----------------------------------------------------------------------------------- app + workflow


def start_app():
    home = DATA / "home"  # the folder picker starts in the home folder: show invented folders, never this computer's
    for folder in ("Company documents/Old quotations", "Company documents/Catalogues", "Company documents/Certificates",
                   "Desktop", "Downloads"):
        (home / folder).mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "ESS_DATA_DIR": str(DATA), "ESS_PORT": str(PORT), "ESS_SCHEDULER": "0", "PYTHONUTF8": "1",
           "HOME": str(home), "USERPROFILE": str(home)}
    log = open(DATA / "server.log", "w", encoding="utf-8")
    proc = subprocess.Popen([sys.executable, "-m", "ess.main"], cwd=BACKEND, env=env, stdout=log, stderr=subprocess.STDOUT)
    import httpx

    for _ in range(120):
        try:
            if httpx.get(f"{BASE}/api/health", timeout=1).status_code == 200:
                return proc
        except httpx.HTTPError:
            pass
        time.sleep(0.5)
    proc.kill()
    raise SystemExit(f"The app did not start; see {DATA / 'server.log'}")


def _until(check, what: str, timeout: float = 90):
    end = time.time() + timeout
    while time.time() < end:
        value = check()
        if value:
            return value
        time.sleep(0.5)
    raise SystemExit(f"Timed out waiting for {what}")


def prepare(c) -> dict:
    """Bring the sample workspace into the states the screens show. Returns ids for the routes."""
    ok = lambda r: (r.raise_for_status(), r.json())[1]  # noqa: E731
    projects = {p["name"]: p["id"] for p in ok(c.get("/api/projects"))["items"]}
    ctx = {"marina": projects["Marina Tower A"], "crescent": projects["Crescent School"],
           "eastquay": projects["East Quay Plant"], "harbor": projects["Harbor Offices"]}

    # Tender files for Crescent School: a specification/drawing PDF and a BOQ workbook in one ZIP (test fixtures).
    sys.path.insert(0, str(BACKEND / "tests" / "fixtures"))
    from ess_input_fixtures import make_boq_xlsx, make_tender_pdf, zip_bytes

    tmp = DATA / "fixtures"
    tmp.mkdir(exist_ok=True)
    bundle = zip_bytes({"Tender/Drawings-and-specs.pdf": make_tender_pdf(tmp / "t.pdf").read_bytes(),
                        "Tender/BOQ-Div11.xlsx": make_boq_xlsx(tmp / "b.xlsx").read_bytes()})
    ok(c.post(f"/api/projects/{ctx['crescent']}/files", files={"file": ("tender-set.zip", bundle, "application/zip")}))

    def extracted():
        files = ok(c.get(f"/api/projects/{ctx['crescent']}"))["files"]
        named = {f["name"]: f for f in files}
        done = all(f["extraction_status"] != "pending" for f in files if f["status"] == "ready")
        return named if done and "BOQ-Div11.xlsx" in named else None

    files = _until(extracted, "the tender files to be read")
    ctx["file_pdf"], ctx["file_boq"] = files["Drawings-and-specs.pdf"]["id"], files["BOQ-Div11.xlsx"]["id"]
    ok(c.post(f"/api/projects/{ctx['crescent']}/analyze", params={"wait": True}))

    def approve_review(pid):
        review = ok(c.get(f"/api/projects/{pid}/review"))
        ok(c.put(f"/api/projects/{pid}/review", json={"checklist": [{**i, "status": "checked", "note": "Sample engineer confirmed this fictional review basis."} for i in review["checklist"]],
                                                       "note": "Scope, loads and standards checked against the sample files."}))
        ok(c.post(f"/api/projects/{pid}/review/approve", json={}))

    approve_review(ctx["harbor"])
    approve_review(ctx["crescent"])
    review = ok(c.get(f"/api/projects/{ctx['marina']}/review"))  # every item checked, approval still open
    ok(c.put(f"/api/projects/{ctx['marina']}/review",
             json={"checklist": [{**i, "status": "checked", "note": "Sample engineer confirmed this fictional review basis."} for i in review["checklist"]], "note": ""}))
    review = ok(c.get(f"/api/projects/{ctx['eastquay']}/review"))  # half-way: some items checked, one flagged
    items = review["checklist"]
    for i, item in enumerate(items):
        item["status"] = "checked" if i < 2 else ("flagged" if i == 2 else item["status"])
        if i == 2:
            item["note"] = "Free-standing mast at 24 m: base and anchorage design not received."
    ok(c.put(f"/api/projects/{ctx['eastquay']}/review", json={"checklist": items, "note": ""}))

    # Quotations: Harbor (customer asked for other terms), Crescent (priced and approved), Marina (first contractor).
    qh = ok(c.post("/api/quotations", json={"project_id": ctx["harbor"]}))
    ctx["q_harbor"] = qh["id"]
    if any(t["key"] == "validity" for t in qh["data"].get("term_changes") or []):
        ok(c.post(f"/api/quotations/{qh['id']}/term-changes/validity/decide", json={"decision": "accept"}))
    def priced(project_id: str) -> dict:  # a person entered quantities and (invented) prices, terms decided
        q = ok(c.post("/api/quotations", json={"project_id": project_id}))
        for change in q["data"].get("term_changes") or []:
            ok(c.post(f"/api/quotations/{q['id']}/term-changes/{change['key']}/decide",
                      json={"decision": "retain", "reason": "Company policy for tenders."}))
        items = [{**i, "qty": i.get("qty") or 1, "unit_price": 1850.0 + 250 * n} for n, i in enumerate(q["data"]["items"])]
        ok(c.put(f"/api/quotations/{q['id']}", json={"data": {"items": items}}))
        return q

    ctx["q_crescent"] = priced(ctx["crescent"])["id"]  # approved
    ok(c.post(f"/api/quotations/{ctx['q_crescent']}/approve", json={"note": "Sample approval for the visual review."}))
    ctx["q_ready"] = priced(ctx["crescent"])["id"]  # waits for approval with nothing missing
    ok(c.post(f"/api/quotations/{ctx['q_ready']}/submit"))
    enquiries = [e for e in ok(c.get("/api/enquiries")) if e["project_id"] == ctx["marina"]]
    first = min(enquiries, key=lambda e: e.get("received_at") or "")
    qm = ok(c.post("/api/quotations", json={"project_id": ctx["marina"], "enquiry_id": first["id"]}))
    ctx["q_marina"] = qm["id"]
    ok(c.post(f"/api/quotations/{qm['id']}/submit"))

    # Learning from a correction, customer services, an automation run.
    ok(c.patch("/api/emails/demo-v1", json={"category": "hoist"}))
    c.post("/api/customers/retag-all")
    customers = ok(c.get("/api/customers"))
    rows = customers["items"] if isinstance(customers, dict) else customers
    ctx["customer"] = next(x["id"] for x in rows if x["name"] == "Harbor Facilities")
    autos = {a["key"]: a for a in ok(c.get("/api/automations"))}
    ctx["automation"] = autos["enquiry_intake"]["id"]
    hygiene = autos["inbox_hygiene"]["id"]  # stops at its approval gate (unsubscribing needs a person)
    ctx["run"] = ok(c.post(f"/api/automations/{hygiene}/run", json={}))["run_id"]
    _until(lambda: ok(c.get(f"/api/runs/{ctx['run']}"))["run"]["status"] != "running", "the inbox hygiene run to pause", 60)
    return ctx


# ----------------------------------------------------------------------------------- states
# no, title, route (formatted with ctx), optional steps that open a dialog: ("click", "<button name regex>")

STATES: list[dict] = [
    {"no": "11", "title": "Control center", "path": "/"},
    {"no": "12", "title": "Classified inbox", "path": "/inbox"},
    {"no": "13", "title": "Email detail", "path": "/inbox/demo-m2"},
    {"no": "13b", "title": "Arabic request (RTL)", "path": "/inbox/demo-a1"},
    {"no": "14", "title": "Show and hide categories", "path": "/inbox", "open": [("click", "^Show and hide")]},
    {"no": "52", "title": "Promotions inbox", "path": "/inbox", "steps": [("click", "^Promotions")]},
    {"no": "53", "title": "Unsubscribe confirmation", "path": "/inbox",
     "open": [("click", "^Promotions"), ("click", "^Unsubscribe")]},
    {"no": "54", "title": "Change category dialog", "path": "/inbox/demo-v1", "open": [("click", "^Change category")]},
    {"no": "15", "title": "Projects", "path": "/projects"},
    {"no": "17", "title": "Project overview", "path": "/projects/{marina}"},
    {"no": "17b", "title": "Contractor enquiries", "path": "/projects/{marina}/enquiries"},
    {"no": "18", "title": "Project inputs", "path": "/projects/{crescent}/inputs"},
    {"no": "18b", "title": "Missing inputs", "path": "/projects/{marina}/inputs"},
    {"no": "20", "title": "File and evidence viewer", "path": "/files/{file_pdf}"},
    {"no": "78", "title": "BOQ evidence", "path": "/files/{file_boq}"},
    {"no": "21", "title": "Scope analysis", "path": "/projects/{crescent}/analysis"},
    {"no": "22", "title": "Engineering review", "path": "/projects/{eastquay}/review"},
    {"no": "74", "title": "Deadline amendment", "path": "/projects/{marina}/changes/0"},
    {"no": "73", "title": "Technical revision", "path": "/projects/{eastquay}/changes/0"},
    {"no": "17c", "title": "Project documents", "path": "/projects/{harbor}/documents"},
    {"no": "68", "title": "Project archive", "path": "/projects/archive"},
    {"no": "19", "title": "Download approval dialog", "path": "/projects/{marina}/inputs",
     "open": [("click", "^Approve download")]},
    {"no": "64", "title": "Add project link dialog", "path": "/projects/{crescent}/inputs", "open": [("click", "^Add link")]},
    {"no": "20b", "title": "Mark file reviewed dialog", "path": "/files/{file_pdf}", "open": [("click", "^Mark reviewed")]},
    {"no": "22b", "title": "Approve technical scope dialog", "path": "/projects/{marina}/review",
     "open": [("click", "^Approve (technical )?scope|^Approve review")]},
    {"no": "63", "title": "Request changes dialog", "path": "/projects/{marina}/review", "open": [("click", "^Request changes")]},
    {"no": "74b", "title": "Confirm new closing date dialog", "path": "/projects/{marina}/changes/0",
     "open": [("click", "^Confirm new closing date")]},
    {"no": "60", "title": "Create quotation: choose the contractor", "path": "/projects/{marina}/documents",
     "open": [("click", "^Create quotation")]},
    {"no": "17d", "title": "Use this template for projects like this", "path": "/projects/{harbor}/documents",
     "open": [("click", "^Use this template")]},
    {"no": "23", "title": "Quotations", "path": "/quotations"},
    {"no": "26", "title": "Quotation editor with requested terms", "path": "/quotations/{q_harbor}"},
    {"no": "27", "title": "Draft preview", "path": "/quotations/{q_harbor}/preview"},
    {"no": "27b", "title": "Approved preview", "path": "/quotations/{q_crescent}/preview"},
    {"no": "26b", "title": "Decide a requested term", "path": "/quotations/{q_harbor}", "open": [("click", "^Decide")]},
    {"no": "26c", "title": "Stamp placement", "path": "/quotations/{q_harbor}", "open": [("click", "^Edit stamp placement")]},
    {"no": "26d", "title": "Save as template rule", "path": "/quotations/{q_harbor}", "open": [("click", "^Save as template rule")]},
    {"no": "26e", "title": "Lines from the catalogue", "path": "/quotations/{q_harbor}", "open": [("click", "^From catalogue")]},
    {"no": "26f", "title": "Add a reference photo", "path": "/quotations/{q_harbor}", "open": [("click", "^Add photo")]},
    {"no": "79", "title": "Maintenance quotation waiting for approval", "path": "/quotations/{q_ready}"},
    {"no": "28b", "title": "Approve quotation dialog", "path": "/quotations/{q_ready}", "open": [("click", "^Approve ")]},
    {"no": "63b", "title": "Request changes on a quotation", "path": "/quotations/{q_ready}", "open": [("click", "^Request changes")]},
    {"no": "29", "title": "Send quotation dialog", "path": "/quotations/{q_crescent}", "open": [("click", "^Send quotation")]},
    {"no": "23b", "title": "New quotation dialog", "path": "/quotations", "open": [("click", "^New quotation")]},
    {"no": "28", "title": "Approvals", "path": "/quotations/approvals"},
    {"no": "25", "title": "Quotation setup: templates", "path": "/quotations/setup/templates"},
    {"no": "25b", "title": "Template wording editor", "path": "/quotations/setup/templates/annual_maintenance"},
    {"no": "24", "title": "Template rules", "path": "/quotations/setup/rules"},
    {"no": "24b", "title": "Add template rule", "path": "/quotations/setup/rules", "open": [("click", "^Add rule")]},
    {"no": "82", "title": "Company papers", "path": "/quotations/setup/papers"},
    {"no": "83", "title": "Signatories", "path": "/quotations/setup/signatories"},
    {"no": "83b", "title": "Add signatory", "path": "/quotations/setup/signatories", "open": [("click", "^Add signatory")]},
    {"no": "84", "title": "Stamp and letterhead", "path": "/quotations/setup/letterhead"},
    {"no": "85", "title": "Catalogue", "path": "/quotations/setup/catalog"},
    {"no": "30", "title": "Customers", "path": "/customers"},
    {"no": "61", "title": "Add company dialog", "path": "/customers", "open": [("click", "^Add company")]},
    {"no": "31", "title": "Customer profile", "path": "/customers/{customer}"},
    {"no": "59", "title": "Customer projects", "path": "/customers/{customer}/projects"},
    {"no": "33", "title": "Customer research", "path": "/customers/{customer}/research"},
    {"no": "32", "title": "Research setup dialog", "path": "/customers/{customer}/research", "open": [("click", "^Run research")]},
    {"no": "34", "title": "Customer updates", "path": "/customers/{customer}/updates"},
    {"no": "35", "title": "Suggested services", "path": "/customers/{customer}/opportunities"},
    {"no": "81", "title": "Lessons for this customer", "path": "/customers/{customer}/lessons"},
    {"no": "36", "title": "Automations", "path": "/automations"},
    {"no": "37", "title": "Automation", "path": "/automations/{automation}"},
    {"no": "38", "title": "Automation run waiting at a gate", "path": "/automations/runs/{run}"},
    {"no": "38b", "title": "Continue a paused run", "path": "/automations/runs/{run}", "open": [("click", "^Continue")]},
    {"no": "39", "title": "Mailbox and services", "path": "/settings/connections"},
    {"no": "06b", "title": "Add mailbox dialog", "path": "/settings/connections", "open": [("click", "^Add mailbox|^Connect mailbox")]},
    {"no": "39b", "title": "Add search service", "path": "/settings/connections", "open": [("click", "^Add search service")]},
    {"no": "04", "title": "AI engine and MCP", "path": "/settings/ai"},
    {"no": "04b", "title": "Use MCP as the AI engine", "path": "/settings/ai", "steps": [("click", "^Connect using MCP")],
     "open": [("click", "^Use MCP as the AI engine")]},
    {"no": "42", "title": "AI quality rules", "path": "/settings/ai-rules"},
    {"no": "40", "title": "Business knowledge: services", "path": "/settings/knowledge/service-families"},
    {"no": "57", "title": "Business knowledge: work types", "path": "/settings/knowledge/work-types"},
    {"no": "71", "title": "Business knowledge: terms", "path": "/settings/knowledge/terms"},
    {"no": "58", "title": "Business knowledge: standards", "path": "/settings/knowledge/standards"},
    {"no": "86", "title": "Business knowledge: conventions", "path": "/settings/knowledge/conventions"},
    {"no": "40b", "title": "Add a finding", "path": "/settings/knowledge/service-families", "open": [("click", "^Add ")]},
    {"no": "40c", "title": "Learn from files and mail", "path": "/settings/knowledge/service-families",
     "open": [("click", "^Learn from")]},
    {"no": "71b", "title": "Regional vocabulary", "path": "/settings/knowledge/terms", "open": [("click", "^Regional vocabulary")]},
    {"no": "58b", "title": "Standards library", "path": "/settings/knowledge/standards", "open": [("click", "^Standards library")]},
    {"no": "80", "title": "Learned corrections", "path": "/settings/learning"},
    {"no": "80b", "title": "Delete a lesson", "path": "/settings/learning", "open": [("click", "^Delete")]},
    {"no": "43", "title": "Workspace settings", "path": "/settings/workspace"},
    {"no": "41", "title": "Team", "path": "/settings/team"},
    {"no": "62", "title": "Add team member", "path": "/settings/team", "open": [("click", "^Add member")]},
    {"no": "70", "title": "Your account", "path": "/settings/account"},
    {"no": "01", "title": "Setup: workspace", "path": "/setup/workspace"},
    {"no": "02", "title": "Setup: AI engine", "path": "/setup/engine"},
    {"no": "05", "title": "Setup: model", "path": "/setup/model"},
    {"no": "06", "title": "Setup: mailbox", "path": "/setup/mail"},
    {"no": "07", "title": "Setup: company documents", "path": "/setup/documents"},
    {"no": "65", "title": "Company folder picker", "path": "/setup/documents", "open": [("click", "^Choose folder")]},
    {"no": "08", "title": "Setup: scan scope", "path": "/setup/scope"},
    {"no": "09", "title": "Setup: learning", "path": "/setup/learning"},
    {"no": "10", "title": "Setup: business discovery", "path": "/setup/identity"},
]


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def settle(page) -> None:
    page.wait_for_load_state("networkidle")
    try:  # skeletons gone
        page.wait_for_function("!document.querySelector('[aria-label=\"Loading\"], .skeleton')", timeout=10_000)
    except Exception:
        pass
    page.wait_for_timeout(300)


def run_steps(page, steps, dialog: bool = True) -> None:
    """Click controls by their accessible name (buttons, links, tabs, segmented options, menu items)."""
    for kind, arg in steps:
        if kind == "click":
            name = re.compile(arg, re.I)
            for role in ("button", "link", "tab", "radio", "menuitem"):
                target = page.get_by_role(role, name=name)
                if target.count():
                    break
            target.first.click()
        elif kind == "fill":
            label, value = arg
            page.get_by_label(re.compile(label, re.I)).first.fill(value)
        settle(page)
    if steps and dialog:
        page.get_by_role("dialog").first.wait_for(state="visible", timeout=5_000)
        page.wait_for_timeout(350)


def shoot(ctx: dict, only: set[str]) -> list[dict]:
    from playwright.sync_api import sync_playwright

    done = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        for device, spec in DEVICES.items():
            (OUT / device).mkdir(parents=True, exist_ok=True)
            context = browser.new_context(**spec["ctx"], reduced_motion="reduce", locale="en-GB",
                                          timezone_id="Asia/Kuwait")
            page = context.new_page()
            for st in STATES:
                if only and st["no"] not in only:
                    continue
                path = st["path"].format(**ctx)
                name = f"{st['no']}-{slug(st['title'])}-{device}.png"
                try:
                    page.goto(BASE + path)
                    settle(page)
                    run_steps(page, st.get("steps") or [], dialog=False)
                    run_steps(page, st.get("open") or [])
                    target = str(OUT / device / name)
                    if st.get("open"):  # a dialog: the visible screen
                        page.screenshot(path=target)
                    else:  # a page: grow the window to the page, so fixed bars and the sidebar sit where they belong
                        size = spec["ctx"]["viewport"]
                        height = page.evaluate("Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)")
                        page.set_viewport_size({"width": size["width"], "height": max(size["height"], min(height, 12_000))})
                        page.wait_for_timeout(300)
                        page.screenshot(path=target)
                        page.set_viewport_size(size)
                    if device == "desktop":
                        done.append({**st, "route": path, "file": name})
                except Exception as exc:  # keep going: one broken state must not hide the others
                    print(f"! {st['no']} {st['title']} ({device}): {exc}".splitlines()[0])
            context.close()
        browser.close()
    return done


PDFS = [("27c", "Draft PDF", "q_harbor"), ("27d", "Approved PDF", "q_crescent")]


def render_pdfs(c, ctx: dict) -> list[dict]:
    """First and last page of a draft and of an approved quotation PDF, as the app renders them."""
    import pypdfium2 as pdfium

    shutil.rmtree(OUT / "pdf", ignore_errors=True)
    (OUT / "pdf").mkdir(parents=True)
    out = []
    for no, title, key in PDFS:
        r = c.get(f"/api/quotations/{ctx[key]}/pdf")
        r.raise_for_status()
        doc = pdfium.PdfDocument(r.content)
        for index in sorted({0, len(doc) - 1}):
            name = f"{no}-{slug(title)}-page-{index + 1}.png"
            doc[index].render(scale=1.6).to_pil().save(OUT / "pdf" / name)
            out.append({"no": no, "title": f"{title}, page {index + 1} of {len(doc)}", "file": name,
                        "route": f"/api/quotations/:{key}/pdf"})
    return out


def write_index(done: list[dict], pdfs: list[dict]) -> None:
    lines = [
        "# Rendered screens",
        "",
        "Screenshots of the working application, for the visual review. Generated by `scripts/screenshots.py` on an",
        "invented sample workspace (no real companies, people, prices or mail). One desktop and one phone image per",
        "page, and a separate image for every dialog or sheet. Desktop: 1440 × 900 (full page). Phone: 390 × 844 at",
        "2× pixel density (full page; dialogs show the visible screen). Numbers follow the concept index where a",
        "concept exists (`docs/ui-mockups/SCREEN-INDEX.md`); 80+ are new.",
        "",
        "| No. | Screen or dialog | Route | Desktop | Phone |",
        "|---|---|---|---|---|",
    ]
    for st in sorted(done, key=lambda s: (s["no"].rstrip("abcdefgh").zfill(3), s["no"])):
        phone = st["file"].replace("-desktop.png", "-phone.png")
        how = f" — {st['how']}" if st.get("how") else ""
        lines.append(f"| {st['no']} | {st['title']}{how} | `{st['route_display']}` | [desktop](desktop/{st['file']}) | "
                     f"[phone](phone/{phone}) |")
    lines += [
        "",
        "## PDF output",
        "",
        "The preview page embeds the PDF; the screenshot browser (headless Chromium) cannot display a PDF inside a",
        "page, so the pages below are rendered from the same PDF files. The sample signatory has an invented",
        "signature and a stamp marked SAMPLE: the approved PDF carries them, the draft never does.",
        "",
        "| No. | PDF | Source | Image |",
        "|---|---|---|---|",
    ]
    lines += [f"| {p['no']} | {p['title']} | `{p['route']}` | [page](pdf/{p['file']}) |" for p in pdfs]
    (OUT / "INDEX.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--no-build", action="store_true", help="reuse frontend/dist")
    ap.add_argument("--only", default="", help="comma-separated state numbers")
    ap.add_argument("--keep", action="store_true", help="leave the app running")
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if not a.no_build:
        subprocess.run("npm run build", cwd=ROOT / "frontend", shell=True, check=True)
    shutil.rmtree(DATA, ignore_errors=True)
    DATA.mkdir(parents=True)
    os.environ["ESS_DATA_DIR"] = str(DATA)
    seed()
    proc = start_app()
    try:
        import httpx

        with httpx.Client(base_url=BASE, timeout=120) as c:
            ctx = prepare(c)
        only = {x.strip() for x in a.only.split(",") if x.strip()}
        if not only:
            shutil.rmtree(OUT / "desktop", ignore_errors=True)
            shutil.rmtree(OUT / "phone", ignore_errors=True)
        done = shoot(ctx, only)
        for st in done:  # routes in the index use placeholders, not the sample ids
            st["route_display"] = re.sub(r"\{(\w+)\}", lambda m: ":" + m.group(1), st["path"])
        with httpx.Client(base_url=BASE, timeout=120) as c:
            pdfs = render_pdfs(c, ctx)
        if not only:
            write_index(done, pdfs)
        print(f"{len(done)} states → {OUT}")
        if a.keep:
            print(f"App still running on {BASE} (pid {proc.pid}); stop it when done.")
            return
    finally:
        if not a.keep:
            proc.terminate()


if __name__ == "__main__":
    main()
