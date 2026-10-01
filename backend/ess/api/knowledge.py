"""Business knowledge: identity, service families, work types, terms (regional), standards, learning job."""
from __future__ import annotations

from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlmodel import Session, col, select

from .. import jobs
from ..db import get_session, session_scope
from ..models import AppState, Category, Email, KnowledgeItem, TeamMember, Workspace, utcnow
from ..workspace import log_activity
from .deps import get_or_404, require_role, user_dep, ws_dep

router = APIRouter(prefix="/api", tags=["knowledge"])

KINDS = ("service_family", "work_type", "term", "standard", "convention", "identity")


@router.get("/knowledge")
def list_knowledge(kind: Optional[str] = None, status: Optional[str] = None, q: Optional[str] = None,
                   session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> dict:
    query = select(KnowledgeItem).where(KnowledgeItem.workspace_id == ws.id)
    if kind:
        query = query.where(col(KnowledgeItem.kind).in_(kind.split(",")))
    if status:
        query = query.where(col(KnowledgeItem.status).in_(status.split(",")))
    rows = session.exec(query.order_by(col(KnowledgeItem.confidence).desc())).all()
    if q:
        ql = q.lower()
        rows = [r for r in rows if ql in r.label.lower() or ql in (r.key or "").lower()
                or any(ql in str(s).lower() for s in r.synonyms or [])]
    counts = {k: sum(1 for r in rows if r.kind == k) for k in KINDS}
    return {"items": rows, "counts": counts}


@router.post("/knowledge")
def add_item(data: dict = Body(...), session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep),
             user: TeamMember = Depends(user_dep)) -> KnowledgeItem:
    if data.get("kind") not in KINDS or not data.get("label"):
        raise HTTPException(400, {"code": "bad_item", "message": "kind and label are required"})
    key = data.get("key") or data["label"].lower().replace(" ", "_")
    item = KnowledgeItem(workspace_id=ws.id, kind=data["kind"], key=key, label=data["label"],
                         label_ar=data.get("label_ar") or "", description=data.get("description") or "",
                         synonyms=data.get("synonyms") or [], region=data.get("region"), language=data.get("language"),
                         claim_basis="owner", status="owner_confirmed", source="user", confidence=1.0,
                         evidence=[{"quote": f"Added by {user.name}", "source_type": "owner", "weight": 1.0}])
    session.add(item)
    session.commit()
    return item


@router.patch("/knowledge/{item_id}")
def edit_item(item_id: str, data: dict = Body(...), session: Session = Depends(get_session),
              ws: Workspace = Depends(ws_dep), user: TeamMember = Depends(user_dep)) -> KnowledgeItem:
    item = get_or_404(session, KnowledgeItem, item_id, ws)
    wording = ("label", "label_ar", "description", "synonyms")
    if any(k in data and data[k] != getattr(item, k) for k in wording) and not item.original:
        # keep what was found and where, before the owner's correction
        item.original = {**{k: getattr(item, k) for k in wording}, "evidence": item.evidence,
                         "source": item.source, "edited_by": user.name, "edited_at": utcnow().isoformat()}
    for k in ("label", "label_ar", "description", "synonyms", "region", "language", "value"):
        if k in data:
            setattr(item, k, data[k])
    if data.get("status") in ("suggested", "owner_confirmed", "rejected"):
        if data["status"] != item.status:
            from ..learning import on_knowledge_feedback

            on_knowledge_feedback(session, ws, item.kind, item.label, data["status"], user.name)
        item.status = data["status"]
        if item.status == "owner_confirmed":
            item.confidence = max(item.confidence, 0.95)
            item.evidence = [*(item.evidence or []), {"quote": f"Confirmed by {user.name}", "source_type": "owner",
                                                      "weight": 1.0, "at": utcnow().isoformat()}]
    if "apply_to_classification" in data:
        if data["apply_to_classification"] and item.status != "owner_confirmed":
            raise HTTPException(409, {"code": "confirm_first", "message": "Confirm the finding before using it for sorting"})
        item.apply_to_classification = bool(data["apply_to_classification"])
    item.updated_at = utcnow()
    session.add(item)
    session.commit()
    # confirming a finding and using it to sort mail are two separate choices
    if item.kind in ("service_family", "term") and item.apply_to_classification:
        _sync_category(session, ws, item)
    return item


@router.delete("/knowledge/{item_id}")
def delete_item(item_id: str, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> dict:
    item = get_or_404(session, KnowledgeItem, item_id, ws)
    session.delete(item)
    session.commit()
    return {"deleted": item_id}


def _sync_category(session: Session, ws: Workspace, item: KnowledgeItem) -> None:
    """A confirmed service family feeds its words into its mail category (creating one if it is new)."""
    target = (item.value or {}).get("category") if isinstance(item.value, dict) else None
    cid = f"{ws.id}:{target or item.key}"
    cat = session.get(Category, cid)
    if cat is None:
        cat = Category(id=cid, workspace_id=ws.id, key=item.key, label=item.label, label_ar=item.label_ar,
                       group="work", is_work_type=True, icon="briefcase", source="learned", order=50)
    keywords = dict(cat.keywords or {})
    keywords["en"] = sorted(set((keywords.get("en") or []) + [s for s in item.synonyms or [] if isinstance(s, str)] + [item.label]))
    cat.keywords = keywords
    cat.evidence = item.evidence
    session.add(cat)
    session.commit()


@router.get("/knowledge/identity")
def identity(session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> dict:
    items = session.exec(select(KnowledgeItem).where(KnowledgeItem.workspace_id == ws.id,
                                                     KnowledgeItem.status != "rejected")).all()
    def pack(kind: str) -> list[dict]:
        return [{"id": i.id, "key": i.key, "label": i.label, "label_ar": i.label_ar, "status": i.status,
                 "confidence": i.confidence, "claim_basis": i.claim_basis, "description": i.description,
                 "evidence_count": len(i.evidence or []), "synonyms": i.synonyms, "region": i.region}
                for i in sorted(items, key=lambda x: -x.confidence) if i.kind == kind]
    ident = next((i for i in items if i.kind == "identity"), None)
    learning = session.get(AppState, f"learning:{ws.id}")
    return {
        "company": {"name": ws.company_name or ws.name, "email": ws.primary_email, "region": ws.region,
                    "languages": ws.languages, "currency": ws.currency, "details": ident.value if ident else None},
        "service_families": pack("service_family"), "work_types": pack("work_type"),
        "terms": pack("term"), "standards": pack("standard"), "conventions": pack("convention"),
        "confirmed": sum(1 for i in items if i.status == "owner_confirmed"), "total": len(items),
        "learning": learning.value if learning else None,
    }


@router.get("/knowledge/regions")
def regions() -> dict:
    try:
        from ..knowledge.base import load_region_terms

        return load_region_terms()
    except Exception as exc:
        raise HTTPException(503, {"code": "unavailable", "message": str(exc)})


@router.get("/knowledge/standards-library")
def standards_library() -> dict:
    try:
        from ..knowledge.base import load_standards

        return load_standards()
    except Exception as exc:
        raise HTTPException(503, {"code": "unavailable", "message": str(exc)})


def _progress(ws_id: str, step: str, status: str, detail: str = "", **extra) -> None:
    with session_scope() as s:
        state = s.get(AppState, f"learning:{ws_id}") or AppState(key=f"learning:{ws_id}", value={})
        value = dict(state.value or {})
        steps = dict(value.get("steps") or {})
        steps[step] = {"status": status, "detail": detail, "at": utcnow().isoformat()}
        value.update({"steps": steps, "status": extra.pop("overall", value.get("status", "running")), **extra})
        state.value = value
        s.add(state)


def run_discovery(ws_id: str, options: dict) -> dict:
    from ..knowledge.corpus import CorpusDoc, build_corpus_from_folder
    from ..knowledge.miner import build_identity, mine_corpus
    from ..pipeline.connect import engine_for

    from ..knowledge.corpus import from_mail_messages

    _progress(ws_id, "mail", "running", overall="running", started_at=utcnow().isoformat())
    docs: list = []
    with session_scope() as s:
        ws = s.get(Workspace, ws_id)
        emails = s.exec(select(Email).where(Email.workspace_id == ws_id, Email.body_text != "")).all()
        mail = [{"id": e.id, "direction": e.direction, "from_email": e.from_email, "subject": e.subject,
                 "body_text": e.body_text, "labels": e.labels, "date": e.date.isoformat() if e.date else None}
                for e in emails]
        docs.extend(from_mail_messages(mail, ws.own_domains or [], account=ws.primary_email))
        engine = engine_for(s, ws, "discover_business")
        company, domain = ws.company_name or ws.name, (ws.own_domains or [""])[0]
        search = None
        if options.get("web"):
            from .customers import _search_provider

            search = _search_provider(s, ws)
    _progress(ws_id, "mail", "done", f"{len(docs)} messages")
    if search is not None:
        # web pages are context only: low weight, never the sole basis of a finding
        from ..customers.search import fetch_page_text

        _progress(ws_id, "web", "running")
        n0 = len(docs)
        seen = set()
        for query in (company, f"{company} {domain}".strip(), domain):
            try:
                hits = search.search(query, max_results=5)
            except Exception:
                continue
            for hit in hits:
                if hit.url in seen:
                    continue
                seen.add(hit.url)
                page = fetch_page_text(hit.url)
                text = getattr(page, "text", "") or hit.snippet
                if text:
                    docs.append(CorpusDoc(source_type="web", source_id=hit.url, label=hit.title[:120], text=text[:20000]))
        _progress(ws_id, "web", "done", f"{len(docs) - n0} pages")
    folders = [f for f in (options.get("folders") or []) if f]
    if folders:
        _progress(ws_id, "documents", "running")
        n0 = len(docs)
        for folder in folders:
            path = Path(folder).expanduser()
            if path.exists():
                docs.extend(build_corpus_from_folder(path, source_type=options.get("folder_type", "auto"),
                                                     limit=int(options.get("limit", 3000))))
        _progress(ws_id, "documents", "done", f"{len(docs) - n0} documents")
    _progress(ws_id, "mining", "running")
    items = mine_corpus(docs, engine=engine.engine if engine else None)
    _progress(ws_id, "mining", "done", f"{len(items)} findings")
    saved = 0
    with session_scope() as s:
        for it in items:
            d = it if isinstance(it, dict) else (it.model_dump() if hasattr(it, "model_dump") else dict(it.__dict__))
            row = s.exec(select(KnowledgeItem).where(KnowledgeItem.workspace_id == ws_id,
                                                     KnowledgeItem.kind == d["kind"], KnowledgeItem.key == d["key"])).first()
            if row is not None and row.status in ("owner_confirmed", "rejected"):
                continue
            row = row or KnowledgeItem(workspace_id=ws_id, kind=d["kind"], key=d["key"], label=d.get("label") or d["key"])
            for k in ("label", "label_ar", "description", "synonyms", "region", "language", "claim_basis", "evidence",
                      "value", "score", "confidence"):
                if d.get(k) is not None:
                    setattr(row, k, d[k])
            row.source, row.updated_at = "mined", utcnow()
            s.add(row)
            saved += 1
    identity_summary = build_identity(items)
    # progress is written after the findings are committed (one writer at a time in SQLite)
    _progress(ws_id, "identity", "done", overall="done", finished_at=utcnow().isoformat(),
              identity_confidence=(identity_summary or {}).get("confidence"))
    with session_scope() as s:
        log_activity(s, ws_id, "learning", "Business learning finished", detail=f"{saved} findings saved", severity="success")
    return {"saved": saved}


DOC_EXT = {".pdf", ".doc", ".docx", ".xls", ".xlsx", ".xlsm", ".csv", ".txt", ".md", ".msg", ".eml", ".pptx", ".odt"}


@router.get("/local-folders")
def local_folders(path: Optional[str] = None, user: TeamMember = Depends(user_dep)) -> dict:
    """Folder picker for company documents on this computer (names and counts only, never contents)."""
    require_role(user, "admin", "Browsing local folders")
    base = Path(path).expanduser() if path else Path.home()
    if not base.exists() or not base.is_dir():
        raise HTTPException(404, {"code": "no_folder", "message": str(base)})
    folders, docs = [], 0
    try:
        for child in sorted(base.iterdir(), key=lambda p: p.name.lower()):
            if child.name.startswith("."):
                continue
            if child.is_dir():
                folders.append({"name": child.name, "path": str(child)})
            elif child.suffix.lower() in DOC_EXT:
                docs += 1
    except PermissionError:
        raise HTTPException(403, {"code": "permission", "message": f"No permission to read {base}"})
    return {"path": str(base), "parent": str(base.parent) if base.parent != base else None,
            "folders": folders[:500], "documents_here": docs}


@router.post("/knowledge/discover")
def discover(data: dict = Body(default={}), session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep),
             user: TeamMember = Depends(user_dep)) -> dict:
    require_role(user, "admin", "Running business learning")
    started = jobs.submit(f"discover:{ws.id}", run_discovery, ws.id, data)
    return {"started": started}
