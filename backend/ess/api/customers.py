"""Customers: directory, profile, tags, service opportunities, deep research, updates/monitoring."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import exists, func, true
from sqlmodel import Session, col, or_, select

from .. import jobs
from ..db import get_session, session_scope
from ..models import (
    Contact,
    Customer,
    CustomerUpdate,
    Email,
    Enquiry,
    KnowledgeItem,
    Opportunity,
    Project,
    Quotation,
    ResearchReport,
    TeamMember,
    Workspace,
    utcnow,
)
from ..workspace import log_activity
from .deps import apply_patch, get_or_404, user_dep, ws_dep

router = APIRouter(prefix="/api", tags=["customers"])


@router.get("/customers")
def list_customers(q: Optional[str] = None, tag: Optional[str] = None, kind: Optional[str] = None,
                   status: Optional[str] = None, profile_status: Optional[str] = None,
                   monitoring: Optional[bool] = None, sort: str = "last_seen", work_only: bool = True,
                   page: int = 1, page_size: int = 100, session: Session = Depends(get_session),
                   ws: Workspace = Depends(ws_dep)) -> dict:
    """Paged customer directory, built for ~10,000 companies: filters, sort and paging run in SQL;
    the tag facets cover the whole filtered set."""
    conds = [Customer.workspace_id == ws.id]
    if q:
        like = f"%{q}%"
        conds.append(or_(col(Customer.name).ilike(like), col(Customer.domain).ilike(like)))
    if kind:
        conds.append(col(Customer.kind).in_(kind.split(",")))
    if status:
        conds.append(col(Customer.status).in_(status.split(",")))
    if profile_status:
        conds.append(col(Customer.profile_status).in_(profile_status.split(",")))
    if monitoring is not None:
        conds.append(Customer.monitoring == monitoring)
    if work_only:
        conds.append(or_(Customer.enquiry_count > 0, Customer.project_count > 0,
                         col(Customer.kind).not_in(["other", "supplier"])))
    if tag:  # tags is a JSON list of {"tag": ...}
        tags_each = func.json_each(Customer.tags).table_valued("value").alias("t")
        conds.append(exists(select(1).select_from(tags_each)
                            .where(func.json_extract(tags_each.c.value, "$.tag") == tag)))
    name_key = func.lower(Customer.name)
    order = {"name": [name_key],
             "enquiries": [col(Customer.enquiry_count).desc(), name_key],
             "projects": [col(Customer.project_count).desc(), name_key]}.get(
        sort, [col(Customer.last_seen).is_(None), col(Customer.last_seen).desc(), name_key])
    page_size = max(1, min(page_size, 500))
    page = max(1, page)
    total = session.exec(select(func.count()).select_from(Customer).where(*conds)).one()
    window = session.exec(select(Customer).where(*conds).order_by(*order)
                          .offset((page - 1) * page_size).limit(page_size)).all()
    ids = [c.id for c in window]
    opp_count = dict(session.exec(
        select(Opportunity.customer_id, func.count()).where(Opportunity.workspace_id == ws.id,
                                                            Opportunity.status == "suggested",
                                                            col(Opportunity.customer_id).in_(ids))
        .group_by(Opportunity.customer_id)).all()) if ids else {}
    facet_each = func.json_each(Customer.tags).table_valued("value").alias("f")
    tag_key = func.json_extract(facet_each.c.value, "$.tag")
    facets = session.exec(select(tag_key, func.count()).select_from(Customer).join(facet_each, true())
                          .where(*conds, tag_key.is_not(None)).group_by(tag_key)
                          .order_by(func.count().desc()).limit(100)).all()
    return {"items": [{**c.model_dump(exclude={"notes"}), "opportunities": opp_count.get(c.id, 0)} for c in window],
            "total": total, "page": page, "page_size": page_size,
            "tags": [[t, n] for t, n in facets]}


@router.post("/customers")
def add_customer(data: dict = Body(...), session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep),
                 user: TeamMember = Depends(user_dep)) -> Customer:
    name = (data.get("name") or "").strip()
    if not name:
        raise HTTPException(400, {"code": "name_required", "message": "Company name is required"})
    domain = (data.get("domain") or "").lower().strip()
    ref = domain or name.lower().replace(" ", "-")
    if session.exec(select(Customer).where(Customer.workspace_id == ws.id, Customer.ref == ref)).first():
        raise HTTPException(409, {"code": "exists", "message": "This customer already exists"})
    c = Customer(workspace_id=ws.id, ref=ref, name=name, domain=domain, kind=data.get("kind") or "other",
                 country=data.get("country") or "", city=data.get("city") or "", website=data.get("website") or "",
                 status="prospect", notes=data.get("notes") or "")
    session.add(c)
    log_activity(session, ws.id, "customer_added", f"Customer added: {name}", actor=user.name, customer_id=c.id)
    session.commit()
    return c


@router.get("/customers/{customer_id}")
def customer_detail(customer_id: str, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> dict:
    c = get_or_404(session, Customer, customer_id, ws)
    contacts = session.exec(select(Contact).where(Contact.customer_id == c.id)).all()
    enquiries = session.exec(select(Enquiry).where(Enquiry.customer_id == c.id)).all()
    project_ids = list({e.project_id for e in enquiries})
    projects = session.exec(select(Project).where(or_(col(Project.id).in_(project_ids), Project.customer_id == c.id))).all()
    quotes = session.exec(select(Quotation).where(Quotation.customer_id == c.id)).all()
    emails = session.exec(select(Email).where(Email.customer_id == c.id).order_by(col(Email.date).desc()).limit(30)).all()
    opps = session.exec(select(Opportunity).where(Opportunity.customer_id == c.id).order_by(col(Opportunity.score).desc())).all()
    report = session.exec(select(ResearchReport).where(ResearchReport.customer_id == c.id)
                          .order_by(col(ResearchReport.created_at).desc())).first()
    updates = session.exec(select(CustomerUpdate).where(CustomerUpdate.customer_id == c.id)
                           .order_by(col(CustomerUpdate.found_at).desc()).limit(30)).all()
    return {
        "customer": c, "contacts": contacts,
        "enquiries": enquiries,
        "projects": [{"id": p.id, "name": p.name, "service_family": p.service_family, "stage": p.stage,
                      "due_date": p.due_date} for p in projects],
        "quotations": [{"id": q.id, "reference": q.reference, "status": q.status, "project_id": q.project_id} for q in quotes],
        "emails": [{"id": e.id, "subject": e.subject, "date": e.date, "category": e.category, "from_email": e.from_email}
                   for e in emails],
        "opportunities": opps, "research": report, "updates": updates,
    }


@router.patch("/customers/{customer_id}")
def edit_customer(customer_id: str, data: dict = Body(...), session: Session = Depends(get_session),
                  ws: Workspace = Depends(ws_dep)) -> Customer:
    c = get_or_404(session, Customer, customer_id, ws)
    apply_patch(c, data, {"name", "domain", "kind", "country", "city", "website", "notes", "status", "tags", "monitoring"})
    c.updated_at = utcnow()
    session.add(c)
    session.commit()
    return c


def _our_services(session: Session, ws: Workspace) -> list[dict]:
    """What we sell, as short mail-category keys/labels. Rejected service families are left out."""
    from ..models import Category

    rejected = set()
    for k in session.exec(select(KnowledgeItem).where(KnowledgeItem.workspace_id == ws.id,
                                                      KnowledgeItem.kind == "service_family",
                                                      KnowledgeItem.status == "rejected")).all():
        key = (k.value or {}).get("category") if isinstance(k.value, dict) else None
        rejected.add(key or k.key)
    cats = session.exec(select(Category).where(Category.workspace_id == ws.id, Category.group == "work")
                        .order_by(Category.order)).all()
    return [{"key": c.key, "label": c.label} for c in cats if c.key != "other_work" and c.key not in rejected]


def _signature_block(body: str) -> str:
    """The sender's own sign-off, not the RFQ text above it (which names consultants and owners)."""
    import re

    first = re.split(r"\n\s*(?:-{3,}\s*Forwarded message|From:\s|On .+ wrote:)", body, maxsplit=1)[0]
    m = None
    for m in re.finditer(r"(?im)^\s*(?:best\s+regards|kind\s+regards|regards|thanks(?: and regards)?|sincerely|yours (?:faithfully|truly))\b.*$", first):
        pass
    return first[m.start():][:600] if m else first[-400:]


def retag_customer(session: Session, ws: Workspace, c: Customer) -> dict:
    from ..customers.opportunities import match_services
    from ..customers.tagging import infer_customer_kind, tag_customer

    emails = session.exec(select(Email).where(Email.customer_id == c.id)).all()
    enquiries = session.exec(select(Enquiry).where(Enquiry.customer_id == c.id)).all()
    projects = session.exec(select(Project).where(col(Project.id).in_([e.project_id for e in enquiries]))).all()
    email_dicts = [{"subject": e.subject, "body_text": (e.body_text or "")[:4000], "from_email": e.from_email,
                    "date": e.date.isoformat() if e.date else None, "category": e.category} for e in emails]
    project_dicts = [{"name": p.name, "service_family": p.service_family, "summary": p.summary, "location": p.location,
                      "owner_client": p.owner_client, "request_kind": p.request_kind} for p in projects]
    services = _our_services(session, ws)
    signatures = [_signature_block(e.body_text or "") for e in emails[:10]]
    if c.kind in ("other", "") or c.kind_confidence < 0.5:
        kind, conf, _reason = infer_customer_kind(c.domain, c.name, signatures)
        c.kind, c.kind_confidence = kind, conf
    customer = {"name": c.name, "domain": c.domain, "kind": c.kind, "country": c.country}
    tags = tag_customer(customer, email_dicts, project_dicts, services)
    keep = [t for t in c.tags or [] if t.get("source") == "user"]
    c.tags = keep + [t if isinstance(t, dict) else t.__dict__ for t in tags]
    opps = match_services(customer, c.tags, services)
    existing = {o.service_key: o for o in session.exec(select(Opportunity).where(Opportunity.customer_id == c.id)).all()}
    for o in opps:
        od = o if isinstance(o, dict) else o.__dict__
        row = existing.get(od["service_key"]) or Opportunity(workspace_id=ws.id, customer_id=c.id, service_key=od["service_key"])
        if row.status == "dismissed":
            continue
        row.score, row.reason, row.evidence, row.updated_at = od.get("score", 0), od.get("reason", ""), od.get("evidence") or [], utcnow()
        session.add(row)
    c.updated_at = utcnow()
    session.add(c)
    return {"tags": c.tags, "opportunities": len(opps)}


@router.post("/customers/{customer_id}/retag")
def retag(customer_id: str, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> dict:
    c = get_or_404(session, Customer, customer_id, ws)
    result = retag_customer(session, ws, c)
    session.commit()
    return result


@router.post("/customers/retag-all")
def retag_all(session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> dict:
    rows = session.exec(select(Customer).where(Customer.workspace_id == ws.id)).all()
    n = 0
    for c in rows:
        if c.enquiry_count or c.email_count:
            retag_customer(session, ws, c)
            n += 1
    session.commit()
    return {"retagged": n}


@router.get("/opportunities")
def opportunities(status: str = "suggested", customer_id: Optional[str] = None, service_key: Optional[str] = None,
                  limit: int = 500, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> list[dict]:
    query = select(Opportunity).where(Opportunity.workspace_id == ws.id, Opportunity.status == status)
    if customer_id:
        query = query.where(Opportunity.customer_id == customer_id)
    if service_key:
        query = query.where(Opportunity.service_key == service_key)
    rows = session.exec(query.order_by(col(Opportunity.score).desc()).limit(max(1, min(limit, 2000)))).all()
    ids = {o.customer_id for o in rows}
    customers = {c.id: c for c in session.exec(select(Customer).where(Customer.workspace_id == ws.id,
                                                                      col(Customer.id).in_(ids))).all()} if ids else {}
    return [{**o.model_dump(), "customer": {"id": o.customer_id, "name": customers[o.customer_id].name}
             if o.customer_id in customers else None} for o in rows]


@router.patch("/opportunities/{opp_id}")
def update_opportunity(opp_id: str, data: dict = Body(...), session: Session = Depends(get_session),
                       ws: Workspace = Depends(ws_dep)) -> Opportunity:
    o = get_or_404(session, Opportunity, opp_id, ws)
    if data.get("status") in ("suggested", "accepted", "dismissed"):
        o.status = data["status"]
    o.updated_at = utcnow()
    session.add(o)
    session.commit()
    return o


# --------------------------------------------------------------------------- research & monitoring


def _search_provider(session: Session, ws: Workspace):
    from ..customers.search import get_search_provider
    from ..pipeline.connect import active_connection
    from ..secrets import get_secret

    conn = active_connection(session, ws, "search")
    if conn is None:
        return get_search_provider({"provider": "duckduckgo"})
    return get_search_provider({"provider": conn.provider, "api_key": get_secret(f"{conn.id}:api_key"),
                                **(conn.config or {})})


def run_research(report_id: str) -> None:
    from ..customers.research import research_customer
    from ..pipeline.connect import engine_for

    with session_scope() as s:
        report = s.get(ResearchReport, report_id)
        ws = s.get(Workspace, report.workspace_id)
        c = s.get(Customer, report.customer_id)
        provider = _search_provider(s, ws)
        choice = engine_for(s, ws, "research_customer")
        emails = s.exec(select(Email).where(Email.customer_id == c.id).order_by(col(Email.date).desc()).limit(20)).all()
        own = [{"text": (e.body_text or e.snippet)[:3000], "source": f"email {e.id}", "date": e.date.isoformat() if e.date else None}
               for e in emails]
        customer = {"name": c.name, "domain": c.domain, "country": c.country, "city": c.city, "kind": c.kind}
        standard = report.standard
    try:
        result = research_customer(customer, provider, engine=choice.engine if choice else None, standard=standard,
                                   own_evidence=own)
        with session_scope() as s:
            report = s.get(ResearchReport, report_id)
            report.status = "done"
            report.sections = result.get("sections") or {}
            report.gaps = result.get("gaps") or []
            report.met_standard = bool(result.get("met_standard"))
            report.evidence_count = int(result.get("evidence_count") or 0)
            report.summary = result.get("summary") or ""
            report.provider = getattr(provider, "name", type(provider).__name__)
            report.finished_at = utcnow()
            s.add(report)
            c = s.get(Customer, report.customer_id)
            c.profile_status = "ready" if report.met_standard else "partial"
            s.add(c)
            log_activity(s, report.workspace_id, "research", f"Research ready: {c.name}",
                         detail=f"{report.evidence_count} sources; standard {'met' if report.met_standard else 'partly met'}",
                         customer_id=c.id, severity="success")
    except Exception as exc:
        with session_scope() as s:
            report = s.get(ResearchReport, report_id)
            report.status, report.error, report.finished_at = "failed", str(exc)[:1000], utcnow()
            s.add(report)
            c = s.get(Customer, report.customer_id)
            c.profile_status = "none"
            s.add(c)


@router.post("/customers/{customer_id}/research")
def start_research(customer_id: str, data: dict = Body(default={}), session: Session = Depends(get_session),
                   ws: Workspace = Depends(ws_dep), user: TeamMember = Depends(user_dep)) -> ResearchReport:
    c = get_or_404(session, Customer, customer_id, ws)
    standard = data.get("standard") or "standard"
    if standard not in ("basic", "standard", "deep"):
        raise HTTPException(400, {"code": "bad_standard", "message": standard})
    report = ResearchReport(workspace_id=ws.id, customer_id=c.id, standard=standard, status="running")
    c.profile_status = "researching"
    if data.get("monitor") is not None:
        c.monitoring = bool(data["monitor"])
    session.add(report)
    session.add(c)
    session.commit()
    jobs.submit(f"research:{c.id}", run_research, report.id)
    return report


@router.get("/customers/{customer_id}/research")
def research_history(customer_id: str, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> list[ResearchReport]:
    get_or_404(session, Customer, customer_id, ws)
    return list(session.exec(select(ResearchReport).where(ResearchReport.customer_id == customer_id)
                             .order_by(col(ResearchReport.created_at).desc())).all())


def check_customer_updates(customer_id: str) -> int:
    import hashlib
    from datetime import timedelta

    from ..customers.monitor import check_updates

    with session_scope() as s:
        c = s.get(Customer, customer_id)
        ws = s.get(Workspace, c.workspace_id)
        provider = _search_provider(s, ws)
        seen = {u.url for u in s.exec(select(CustomerUpdate).where(CustomerUpdate.customer_id == c.id)).all()}
        since = c.last_checked_at or (utcnow() - timedelta(days=365))
        customer = {"name": c.name, "domain": c.domain, "country": c.country}
    found = check_updates(customer, provider, since, seen)
    with session_scope() as s:
        c = s.get(Customer, customer_id)
        for u in found:
            ud = u if isinstance(u, dict) else u.__dict__
            if ud.get("url") in seen:
                continue
            s.add(CustomerUpdate(workspace_id=c.workspace_id, customer_id=c.id, kind=ud.get("kind") or "news",
                                 title=ud.get("title") or "", summary=ud.get("summary") or "", url=ud.get("url") or "",
                                 url_hash=hashlib.sha1((ud.get("url") or "").encode()).hexdigest(),
                                 source=ud.get("source") or "", relevance=float(ud.get("relevance") or 0)))
        c.last_checked_at = utcnow()
        s.add(c)
    return len(found)


@router.post("/customers/{customer_id}/updates/check")
def check_updates_now(customer_id: str, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> dict:
    get_or_404(session, Customer, customer_id, ws)
    return {"started": jobs.submit(f"updates:{customer_id}", check_customer_updates, customer_id)}


@router.post("/customers/{customer_id}/monitor")
def set_monitoring(customer_id: str, data: dict = Body(...), session: Session = Depends(get_session),
                   ws: Workspace = Depends(ws_dep)) -> Customer:
    c = get_or_404(session, Customer, customer_id, ws)
    c.monitoring = bool(data.get("enabled"))
    session.add(c)
    session.commit()
    return c
