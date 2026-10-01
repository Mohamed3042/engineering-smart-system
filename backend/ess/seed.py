"""Command line helpers.

  python -m ess.seed init --name Medmack --company "…" --email sales@… [--country KW]
  python -m ess.seed import snapshot.json [--files-root DIR]
  python -m ess.seed knowledge medmack-knowledge.json
  python -m ess.seed signatory --initials AA --name "…" [--title …] [--default]
  python -m ess.seed demo            # neutral sample workspace (no real data)
  python -m ess.seed export out.json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from sqlmodel import select

from .db import init_db, session_scope
from .models import KnowledgeItem, Signatory, Workspace
from .pipeline.importer import export_snapshot, import_snapshot
from .workspace import create_workspace, get_active_workspace


def _ws(session) -> Workspace:
    ws = get_active_workspace(session, required=False)
    if ws is None:
        sys.exit("No workspace yet. Run: python -m ess.seed init --name … --email …")
    return ws


def cmd_init(a) -> None:
    with session_scope() as s:
        ws = create_workspace(s, {"name": a.name, "company_name": a.company or a.name, "primary_email": a.email,
                                  "country": a.country, "region": a.region, "languages": a.languages.split(","),
                                  "currency": a.currency, "timezone": a.timezone}, owner_name=a.owner)
        print(f"workspace {ws.id} ({ws.name}) created and active")


def cmd_import(a) -> None:
    snap = json.loads(Path(a.path).read_text(encoding="utf-8"))
    with session_scope() as s:
        result = import_snapshot(s, _ws(s), snap, files_root=Path(a.files_root) if a.files_root else Path(a.path).parent)
    print(json.dumps(result, indent=2))


def cmd_knowledge(a) -> None:
    """Load an `ess-knowledge/1` file (business identity mined from mail and documents)."""
    data = json.loads(Path(a.path).read_text(encoding="utf-8"))
    items = []
    for fam in data.get("service_families", []):
        items.append({"kind": "service_family", **fam,
                      "value": {"category": fam.get("category"), "related_categories": fam.get("related_categories") or [],
                                "typical_items": fam.get("typical_items") or []}})
    for wt in data.get("work_types", []):
        items.append({"kind": "work_type", **wt})
    for t in data.get("terms", []):
        items.append({"kind": "term", "key": t.get("term"), "label": t.get("term"), "description": t.get("meaning", ""),
                      "synonyms": t.get("synonyms", []), "region": t.get("region"), "language": t.get("language"),
                      "claim_basis": "market_vocabulary" if t.get("used_by") == "customers" else "delivered_work",
                      "evidence": t.get("evidence", []), "confidence": t.get("confidence", 0.7),
                      "value": {"concept_key": t.get("concept_key"), "used_by": t.get("used_by")}})
    for st in data.get("standards", []):
        items.append({"kind": "standard", "key": st.get("code"), "label": st.get("code"), "description": st.get("title", ""),
                      "evidence": st.get("evidence", []), "confidence": st.get("confidence", 0.7),
                      "value": {"applies_to": st.get("applies_to", [])}})
    for cv in data.get("conventions", []):
        items.append({"kind": "convention", "key": cv.get("key"), "label": cv.get("key", "").replace("_", " ").title(),
                      "value": cv.get("value"), "evidence": cv.get("evidence", []), "confidence": cv.get("confidence", 0.8)})
    if data.get("identity"):
        items.append({"kind": "identity", "key": "company", "label": data["identity"].get("legal_name") or "Company",
                      "value": data["identity"], "confidence": 0.9,
                      "evidence": data["identity"].get("evidence", [])})
    with session_scope() as s:
        ws = _ws(s)
        n = 0
        for it in items:
            key = str(it.get("key") or it.get("label"))
            row = s.exec(select(KnowledgeItem).where(KnowledgeItem.workspace_id == ws.id, KnowledgeItem.kind == it["kind"],
                                                     KnowledgeItem.key == key)).first()
            if row is not None and row.status in ("owner_confirmed", "rejected"):
                continue
            row = row or KnowledgeItem(workspace_id=ws.id, kind=it["kind"], key=key, label=str(it.get("label") or key))
            for f in ("label", "label_ar", "description", "synonyms", "region", "language", "claim_basis", "evidence",
                      "value", "confidence"):
                if it.get(f) is not None:
                    setattr(row, f, it[f])
            if it.get("our_terms"):
                row.synonyms = sorted(set((row.synonyms or []) + list(it["our_terms"])))
            row.source, row.status = "import", "suggested"
            s.add(row)
            n += 1
    print(f"{n} knowledge items loaded")


def cmd_signatory(a) -> None:
    with session_scope() as s:
        ws = _ws(s)
        existing = s.exec(select(Signatory).where(Signatory.workspace_id == ws.id, Signatory.initials == a.initials.upper())).first()
        sig = existing or Signatory(workspace_id=ws.id, initials=a.initials.upper(), full_name=a.name)
        sig.full_name, sig.title, sig.company = a.name, a.title or sig.title, a.company or ws.company_name
        sig.city, sig.email = a.city or sig.city, a.email or sig.email or ws.primary_email
        if a.default:
            for other in s.exec(select(Signatory).where(Signatory.workspace_id == ws.id)).all():
                other.is_default = False
                s.add(other)
            sig.is_default = True
        s.add(sig)
        print(f"signatory {sig.initials} saved")


def cmd_demo(_a) -> None:
    from .demo import DEMO_SNAPSHOT, DEMO_WORKSPACE

    with session_scope() as s:
        ws = get_active_workspace(s, required=False) or create_workspace(s, dict(DEMO_WORKSPACE), owner_name="Jordan Ellis")
        result = import_snapshot(s, ws, DEMO_SNAPSHOT)
        if not s.exec(select(Signatory).where(Signatory.workspace_id == ws.id)).first():
            s.add(Signatory(workspace_id=ws.id, initials="JE", full_name="Jordan Ellis", title="Sales Manager",
                            company=ws.company_name, city="Sample City", email=ws.primary_email, is_default=True))
    print(json.dumps(result, indent=2))


def cmd_export(a) -> None:
    with session_scope() as s:
        Path(a.path).write_text(json.dumps(export_snapshot(s, _ws(s)), indent=2, ensure_ascii=False, default=str), encoding="utf-8")
    print(f"written {a.path}")


def main(argv=None) -> None:
    p = argparse.ArgumentParser(prog="python -m ess.seed")
    sub = p.add_subparsers(dest="cmd", required=True)
    i = sub.add_parser("init")
    i.add_argument("--name", required=True)
    i.add_argument("--company")
    i.add_argument("--email", required=True)
    i.add_argument("--country", default="")
    i.add_argument("--region", default="")
    i.add_argument("--languages", default="en")
    i.add_argument("--currency", default="USD")
    i.add_argument("--timezone", default="UTC")
    i.add_argument("--owner", default="Owner")
    im = sub.add_parser("import")
    im.add_argument("path")
    im.add_argument("--files-root")
    k = sub.add_parser("knowledge")
    k.add_argument("path")
    sg = sub.add_parser("signatory")
    sg.add_argument("--initials", required=True)
    sg.add_argument("--name", required=True)
    sg.add_argument("--title", default="")
    sg.add_argument("--company", default="")
    sg.add_argument("--city", default="")
    sg.add_argument("--email", default="")
    sg.add_argument("--default", action="store_true")
    sub.add_parser("demo")
    ex = sub.add_parser("export")
    ex.add_argument("path")
    a = p.parse_args(argv)
    init_db()
    {"init": cmd_init, "import": cmd_import, "knowledge": cmd_knowledge, "signatory": cmd_signatory,
     "demo": cmd_demo, "export": cmd_export}[a.cmd](a)


if __name__ == "__main__":
    main()
