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
    marina["enquiries"].append({"ref": "E-DEMO-MARINA-WG", "customer_ref": "westgate.example",
                                "contact": {"name": "Priya Nair", "email": "priya.nair@westgate.example"},
                                "email_ids": ["demo-w1"], "thread_ids": ["demo-t8"],
                                "received_at": "2026-09-30T08:20:00Z", "due_date": "2026-11-12"})
    harbor = next(p for p in snap["projects"] if p["ref"] == "P-DEMO-HARBOR")
    harbor["enquiries"][0]["email_ids"].append("demo-h2")
    snap["knowledge"] = KNOWLEDGE
    return snap


def seed() -> None:
    """A fresh sample workspace in DATA (the app is not running yet)."""
    sys.path.insert(0, str(BACKEND))
    from ess import config, db
    from ess.demo import DEMO_WORKSPACE
    from ess.models import Signatory
    from ess.pipeline.importer import import_snapshot
    from ess.workspace import create_workspace

    config.get_settings.cache_clear()
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
    env = {**os.environ, "ESS_DATA_DIR": str(DATA), "ESS_PORT": str(PORT), "ESS_SCHEDULER": "0", "PYTHONUTF8": "1"}
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
        ok(c.put(f"/api/projects/{pid}/review", json={"checklist": [{**i, "status": "checked"} for i in review["checklist"]],
                                                       "note": "Scope, loads and standards checked against the sample files."}))
        ok(c.post(f"/api/projects/{pid}/review/approve", json={}))

    approve_review(ctx["harbor"])
    approve_review(ctx["crescent"])
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
    qc = ok(c.post("/api/quotations", json={"project_id": ctx["crescent"]}))
    ctx["q_crescent"] = qc["id"]
    for change in qc["data"].get("term_changes") or []:
        ok(c.post(f"/api/quotations/{qc['id']}/term-changes/{change['key']}/decide",
                  json={"decision": "retain", "reason": "Company policy for tenders."}))
    items = [{**i, "qty": i.get("qty") or 1, "unit_price": 1850.0 + 250 * n} for n, i in enumerate(qc["data"]["items"])]
    ok(c.put(f"/api/quotations/{qc['id']}", json={"data": {"items": items}}))
    ok(c.post(f"/api/quotations/{qc['id']}/approve", json={"note": "Sample approval for the visual review."}))
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
    autos = ok(c.get("/api/automations"))
    ctx["automation"] = autos[0]["id"]
    ctx["run"] = ok(c.post(f"/api/automations/{autos[0]['id']}/run", json={}))["run_id"]
    time.sleep(2)  # let the run reach its first gate or finish
    return ctx


# ----------------------------------------------------------------------------------- states
# no, title, route (formatted with ctx), optional steps that open a dialog: ("click", "<button name regex>")

STATES: list[dict] = [
    {"no": "11", "title": "Control center", "path": "/"},
    {"no": "12", "title": "Classified inbox", "path": "/inbox"},
    {"no": "13", "title": "Email detail", "path": "/inbox/demo-m2"},
    {"no": "13b", "title": "Arabic request (RTL)", "path": "/inbox/demo-a1"},
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
    {"no": "23", "title": "Quotations", "path": "/quotations"},
    {"no": "26", "title": "Quotation editor with requested terms", "path": "/quotations/{q_harbor}"},
    {"no": "27", "title": "Draft preview", "path": "/quotations/{q_harbor}/preview"},
    {"no": "27b", "title": "Approved preview", "path": "/quotations/{q_crescent}/preview"},
    {"no": "28", "title": "Approvals", "path": "/quotations/approvals"},
    {"no": "25", "title": "Quotation setup", "path": "/quotations/setup"},
    {"no": "30", "title": "Customers", "path": "/customers"},
    {"no": "31", "title": "Customer profile", "path": "/customers/{customer}"},
    {"no": "36", "title": "Automations", "path": "/automations"},
    {"no": "37", "title": "Automation", "path": "/automations/{automation}"},
    {"no": "38", "title": "Automation run", "path": "/automations/runs/{run}"},
    {"no": "39", "title": "Mailbox and services", "path": "/settings/connections"},
    {"no": "04", "title": "AI engine and MCP", "path": "/settings/ai"},
    {"no": "42", "title": "AI quality rules", "path": "/settings/ai-rules"},
    {"no": "40", "title": "Business knowledge", "path": "/settings/knowledge"},
    {"no": "80", "title": "Learned corrections", "path": "/settings/learning"},
    {"no": "43", "title": "Workspace settings", "path": "/settings/workspace"},
    {"no": "41", "title": "Team", "path": "/settings/team"},
    {"no": "70", "title": "Your account", "path": "/settings/account"},
    {"no": "01", "title": "Setup: workspace", "path": "/setup/workspace"},
    {"no": "02", "title": "Setup: AI engine", "path": "/setup/engine"},
    {"no": "05", "title": "Setup: model", "path": "/setup/model"},
    {"no": "06", "title": "Setup: mailbox", "path": "/setup/mail"},
    {"no": "07", "title": "Setup: company documents", "path": "/setup/documents"},
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


def run_steps(page, steps) -> None:
    for kind, arg in steps:
        if kind == "click":
            target = page.get_by_role("button", name=re.compile(arg, re.I))
            if not target.count():
                target = page.get_by_role("link", name=re.compile(arg, re.I))
            target.first.click()
        elif kind == "fill":
            label, value = arg
            page.get_by_label(re.compile(label, re.I)).first.fill(value)
        settle(page)
    if steps:
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
                    run_steps(page, st.get("open") or [])
                    page.screenshot(path=str(OUT / device / name), full_page=not st.get("open"))
                    if device == "desktop":
                        done.append({**st, "route": path, "file": name})
                except Exception as exc:  # keep going: one broken state must not hide the others
                    print(f"! {st['no']} {st['title']} ({device}): {exc}".splitlines()[0])
            context.close()
        browser.close()
    return done


def write_index(done: list[dict]) -> None:
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
        if not only:
            write_index(done)
        print(f"{len(done)} states → {OUT}")
        if a.keep:
            print(f"App still running on {BASE} (pid {proc.pid}); stop it when done.")
            return
    finally:
        if not a.keep:
            proc.terminate()


if __name__ == "__main__":
    main()
