"""Projects: lists per service family, detail, inputs (links/files), changes, analysis, engineer review."""
from __future__ import annotations

import mimetypes
from typing import Optional
from urllib.parse import urlparse

from fastapi import APIRouter, Body, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from sqlmodel import Session, col, or_, select

from .. import jobs
from ..db import get_session
from ..models import (
    Activity,
    Approval,
    Customer,
    Email,
    Enquiry,
    Project,
    ProjectFile,
    ProjectLink,
    Quotation,
    Review,
    TeamMember,
    Workspace,
    utcnow,
)
from ..pipeline.analysis import analyze_project
from ..pipeline.files import abs_path, download_link_job, extract_project_files, fetch_attachments, file_page_png, store_bytes
from ..pipeline.state import STAGE_LABELS, attention_bucket, refresh_project_state
from ..workspace import log_activity
from .deps import apply_patch, get_or_404, require_role, user_dep, ws_dep

router = APIRouter(prefix="/api", tags=["projects"])


def _summary(p: Project, customers: dict[str, Customer], owners: dict[str, TeamMember], counts: dict) -> dict:
    c = customers.get(p.customer_id or "")
    owner = owners.get(p.assigned_to or "")
    return {
        "id": p.id, "code": p.code, "ref": p.ref, "name": p.name, "service_family": p.service_family,
        "work_type": p.work_type, "request_kind": p.request_kind, "stage": p.stage,
        "stage_label": STAGE_LABELS.get(p.stage, p.stage), "review_status": p.review_status,
        "customer": {"id": c.id, "name": c.name} if c else None, "due_date": p.due_date, "priority": p.priority,
        "tender_no": p.tender_no, "location": p.location, "next_action": p.next_action, "blockers": p.blockers,
        "open_changes": [x for x in (p.changes or []) if not x.get("acknowledged")],
        "owner": {"id": owner.id, "name": owner.name, "initials": owner.initials} if owner else None,
        "enquiries": counts.get(p.id, 0), "bucket": attention_bucket(p, p.stage, p.blockers or []),
        "updated_at": p.updated_at, "archived_at": p.archived_at,
    }


@router.get("/projects")
def list_projects(service_family: Optional[str] = None, stage: Optional[str] = None, bucket: Optional[str] = None,
                  q: Optional[str] = None, customer_id: Optional[str] = None, include_archived: bool = False,
                  session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> dict:
    query = select(Project).where(Project.workspace_id == ws.id)
    if service_family:
        query = query.where(col(Project.service_family).in_(service_family.split(",")))
    if stage:
        query = query.where(col(Project.stage).in_(stage.split(",")))
    if customer_id:
        ids = [e.project_id for e in session.exec(select(Enquiry).where(Enquiry.customer_id == customer_id)).all()]
        query = query.where(or_(Project.customer_id == customer_id, col(Project.id).in_(ids)))
    if not include_archived:
        query = query.where(Project.archived_at == None)  # noqa: E711
    if q:
        like = f"%{q}%"
        query = query.where(or_(col(Project.name).ilike(like), col(Project.tender_no).ilike(like),
                                col(Project.location).ilike(like), col(Project.code).ilike(like)))
    projects = session.exec(query).all()
    customers = {c.id: c for c in session.exec(select(Customer).where(Customer.workspace_id == ws.id)).all()}
    owners = {m.id: m for m in session.exec(select(TeamMember).where(TeamMember.workspace_id == ws.id)).all()}
    counts: dict[str, int] = {}
    for e in session.exec(select(Enquiry).where(Enquiry.workspace_id == ws.id)).all():
        counts[e.project_id] = counts.get(e.project_id, 0) + 1
    rows = [_summary(p, customers, owners, counts) for p in projects]
    if bucket:
        rows = [r for r in rows if r["bucket"] == bucket]
    rows.sort(key=lambda r: (r["due_date"] is None, str(r["due_date"] or ""), r["name"]))
    by_family: dict[str, int] = {}
    for r in rows:
        by_family[r["service_family"]] = by_family.get(r["service_family"], 0) + 1
    return {"items": rows, "total": len(rows), "by_service_family": by_family}


@router.post("/projects")
def create_project(data: dict = Body(...), session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep),
                   user: TeamMember = Depends(user_dep)) -> Project:
    name = (data.get("name") or "").strip()
    if not name:
        raise HTTPException(400, {"code": "name_required", "message": "Project name is required"})
    count = len(session.exec(select(Project.id).where(Project.workspace_id == ws.id)).all())
    p = Project(workspace_id=ws.id, ref=f"P-MANUAL-{count + 1}", code=f"P-{count + 1:04d}", name=name,
                service_family=data.get("service_family") or "other_work",
                work_type=data.get("work_type") or "supply_installation",
                request_kind=data.get("request_kind") or "direct_rfq", customer_id=data.get("customer_id"),
                location=data.get("location"), tender_no=data.get("tender_no"), summary=data.get("summary") or "",
                assigned_to=data.get("assigned_to"), source="manual")
    if data.get("due_date"):
        from datetime import date

        p.due_date = date.fromisoformat(data["due_date"][:10])
    session.add(p)
    session.flush()
    if p.customer_id:
        session.add(Enquiry(workspace_id=ws.id, project_id=p.id, customer_id=p.customer_id, ref=f"E-{p.code}",
                            received_at=utcnow(), due_date=p.due_date))
    log_activity(session, ws.id, "project_created", f"Project created: {p.name}", actor=user.name, project_id=p.id)
    refresh_project_state(session, p)
    session.commit()
    return p


@router.get("/projects/{project_id}")
def project_detail(project_id: str, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> dict:
    p = get_or_404(session, Project, project_id, ws)
    customers = {c.id: c for c in session.exec(select(Customer).where(Customer.workspace_id == ws.id)).all()}
    enquiries = session.exec(select(Enquiry).where(Enquiry.project_id == p.id).order_by(col(Enquiry.received_at))).all()
    emails = session.exec(select(Email).where(Email.project_id == p.id).order_by(col(Email.date))).all()
    files = session.exec(select(ProjectFile).where(ProjectFile.project_id == p.id).order_by(col(ProjectFile.created_at))).all()
    links = session.exec(select(ProjectLink).where(ProjectLink.project_id == p.id)).all()
    quotes = session.exec(select(Quotation).where(Quotation.project_id == p.id).order_by(col(Quotation.created_at).desc())).all()
    # every review round, newest first: a round a newer one supersedes stays in the history
    reviews = session.exec(select(Review).where(Review.project_id == p.id).order_by(col(Review.created_at).desc())).all()
    activity = session.exec(select(Activity).where(Activity.project_id == p.id)
                            .order_by(col(Activity.created_at).desc()).limit(40)).all()
    related = session.exec(select(Project).where(col(Project.id).in_(p.related_project_ids or []))).all()
    owner = session.get(TeamMember, p.assigned_to) if p.assigned_to else None
    return {
        "project": p,
        "stage_label": STAGE_LABELS.get(p.stage, p.stage),
        "bucket": attention_bucket(p, p.stage, p.blockers or []),
        "customer": customers.get(p.customer_id or ""),
        "owner": owner,
        "enquiries": [{**e.model_dump(), "customer": customers[e.customer_id].model_dump() if e.customer_id in customers else None}
                      for e in enquiries],
        "emails": [{k: v for k, v in e.model_dump().items() if k != "body_text"} for e in emails],
        "files": files,
        "links": links,
        "quotations": quotes,
        "review": reviews[0] if reviews else None,
        "reviews": reviews,
        "activity": activity,
        "related": [{"id": r.id, "name": r.name, "service_family": r.service_family, "stage": r.stage} for r in related],
    }


@router.get("/projects/{project_id}/work")
def project_work(project_id: str, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> dict:
    """What is still running for this project, so screens keep waiting as long as the work lasts."""
    p = get_or_404(session, Project, project_id, ws)
    link_ids = {l.id for l in session.exec(select(ProjectLink).where(ProjectLink.project_id == p.id)).all()}
    downloads = [k.split(":", 1)[1] for k in jobs.running_keys("link:") if k.split(":", 1)[1] in link_ids]
    work = {
        "attachments": bool(jobs.running_keys(f"attachments:{p.id}")),
        "downloads": downloads,
        "extracting": jobs.is_running(f"extract:{p.id}"),
        "analyzing": jobs.is_running(f"analyze:{p.id}") or (p.analysis or {}).get("status") == "running",
    }
    work["busy"] = bool(work["attachments"] or work["downloads"] or work["extracting"] or work["analyzing"])
    return work


@router.get("/projects/{project_id}/evidence")
def project_evidence(project_id: str, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> dict:
    """Every fact the system holds about the project, each with the sentence or drawing spot it came from."""
    p = get_or_404(session, Project, project_id, ws)
    files = {f.id: f for f in session.exec(select(ProjectFile).where(ProjectFile.project_id == p.id)).all()}
    emails = {e.id: e for e in session.exec(select(Email).where(Email.project_id == p.id)).all()}

    def source(ev: dict) -> dict:
        sid = str(ev.get("source_id") or "")
        if sid in emails:
            e = emails[sid]
            return {"type": "email", "id": sid, "label": f"{e.from_name or e.from_email} · {e.subject}", "date": e.date}
        f = files.get(sid) or next((x for x in files.values() if x.name == sid or x.name == ev.get("source_label")), None)
        if f:
            return {"type": "file", "id": f.id, "label": f.name, "page": ev.get("page"), "doc_kind": f.doc_kind}
        return {"type": ev.get("source_type") or "unknown", "id": sid, "label": ev.get("source_label")}

    facts = []
    for group, rows in (("requirement", p.requirements), ("scope", p.scope_items), ("change", p.changes),
                        ("blocker", p.blockers)):
        for i, row in enumerate(rows or []):
            ev = row.get("evidence") if isinstance(row.get("evidence"), dict) else None
            facts.append({"group": group, "index": i, "label": row.get("label") or row.get("title") or row.get("description")
                          or row.get("text"), "value": row.get("value") or row.get("new_value") or row.get("qty"),
                          "quote": ev.get("quote") if ev else None, "verified": ev.get("verified") if ev else None,
                          "source": source(ev) if ev else None})
    for f in files.values():
        for page, finding in (f.analysis or {}).items():
            if isinstance(finding, dict):
                facts.append({"group": "drawing", "index": page, "label": f"{f.name} · page {page}",
                              "value": finding.get("summary") or finding.get("title"), "findings": finding,
                              "source": {"type": "file", "id": f.id, "label": f.name, "page": page}})
    stats = {"total": sum(1 for x in facts if x.get("quote")), "verified": sum(1 for x in facts if x.get("verified"))}
    return {"project_id": p.id, "facts": facts, "stats": stats, "questions": p.unresolved_questions}


@router.patch("/projects/{project_id}")
def update_project(project_id: str, data: dict = Body(...), session: Session = Depends(get_session),
                   ws: Workspace = Depends(ws_dep), user: TeamMember = Depends(user_dep)) -> Project:
    p = get_or_404(session, Project, project_id, ws)
    if isinstance(data.get("next_action"), dict):
        data["next_action"] = {"kind": data["next_action"].get("kind") or "custom",
                               "label": str(data["next_action"].get("label") or "")[:300],
                               "source": "user", "by": user.name, "set_at": utcnow().isoformat()}
    if "due_date" in data and isinstance(data["due_date"], str):
        from datetime import date

        data["due_date"] = date.fromisoformat(data["due_date"][:10]) if data["due_date"] else None
    from ..learning import on_fact_corrected

    for fact in ("service_family", "work_type", "request_kind", "requirements", "scope_items", "tender_no", "location"):
        if fact in data and data[fact] != getattr(p, fact):
            on_fact_corrected(session, ws, p, fact, getattr(p, fact), data[fact], user.name)
    changed = apply_patch(p, data, {"name", "service_family", "work_type", "request_kind", "customer_id", "priority",
                                    "due_date", "tender_no", "location", "owner_client", "consultant",
                                    "main_contractor", "summary", "scope_items", "requirements",
                                    "unresolved_questions", "assigned_to", "status_note", "recommended_template",
                                    "next_action"})
    if changed:
        log_activity(session, ws.id, "project_updated", f"{p.name}: {', '.join(changed)} updated", actor=user.name,
                     project_id=p.id)
    refresh_project_state(session, p)
    session.commit()
    return p


@router.post("/projects/{project_id}/archive")
def archive(project_id: str, data: dict = Body(default={}), session: Session = Depends(get_session),
            ws: Workspace = Depends(ws_dep), user: TeamMember = Depends(user_dep)) -> Project:
    p = get_or_404(session, Project, project_id, ws)
    p.archived_at = utcnow()
    p.status_note = data.get("reason") or p.status_note
    log_activity(session, ws.id, "project_archived", f"Archived {p.name}", detail=data.get("reason", ""),
                 actor=user.name, project_id=p.id)
    refresh_project_state(session, p)
    session.commit()
    return p


@router.post("/projects/{project_id}/restore")
def restore(project_id: str, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> Project:
    p = get_or_404(session, Project, project_id, ws)
    p.archived_at = None
    refresh_project_state(session, p)
    session.commit()
    return p


@router.post("/projects/{project_id}/changes/{index}/acknowledge")
def acknowledge_change(project_id: str, index: int, data: dict = Body(default={}), session: Session = Depends(get_session),
                       ws: Workspace = Depends(ws_dep), user: TeamMember = Depends(user_dep)) -> Project:
    p = get_or_404(session, Project, project_id, ws)
    changes = list(p.changes or [])
    if not 0 <= index < len(changes):
        raise HTTPException(404, {"code": "no_change", "message": "Change not found"})
    change = changes[index]
    applied = None
    if change.get("kind") == "deadline_changed" and change.get("pending_confirmation") and data.get("apply", True):
        from datetime import date as _date

        enq = session.get(Enquiry, change.get("enquiry_id")) if change.get("enquiry_id") else None
        targets = [enq] if enq else session.exec(select(Enquiry).where(Enquiry.project_id == p.id,
                                                                       Enquiry.status == "open")).all()
        for e in targets:
            e.due_date_history = [*(e.due_date_history or []), {"value": e.due_date.isoformat() if e.due_date else None,
                                                                "changed_at": change.get("date"),
                                                                "confirmed_by": user.name,
                                                                "evidence": change.get("evidence")}]
            e.due_date = _date.fromisoformat(change["new_value"])
            session.add(e)
        applied = change["new_value"]
    changes[index] = {**change, "acknowledged": True, "acknowledged_by": user.name, "pending_confirmation": False,
                      "applied": applied, "acknowledged_at": utcnow().isoformat(), "note": data.get("note", "")}
    p.changes = changes
    log_activity(session, ws.id, "change_reviewed", f"{p.name}: {changes[index].get('title')}", actor=user.name,
                 project_id=p.id, detail=data.get("note", ""))
    refresh_project_state(session, p)
    session.commit()
    return p


@router.post("/projects/{project_id}/blockers")
def add_blocker(project_id: str, data: dict = Body(...), session: Session = Depends(get_session),
                ws: Workspace = Depends(ws_dep), user: TeamMember = Depends(user_dep)) -> Project:
    p = get_or_404(session, Project, project_id, ws)
    p.blockers = [*(p.blockers or []), {"kind": data.get("kind") or "question", "text": data.get("text") or "",
                                        "source": "user", "by": user.name}]
    refresh_project_state(session, p)
    session.commit()
    return p


@router.post("/projects/{project_id}/blockers/{index}/resolve")
def resolve_blocker(project_id: str, index: int, session: Session = Depends(get_session),
                    ws: Workspace = Depends(ws_dep), user: TeamMember = Depends(user_dep)) -> Project:
    p = get_or_404(session, Project, project_id, ws)
    blockers = list(p.blockers or [])
    if not 0 <= index < len(blockers):
        raise HTTPException(404, {"code": "no_blocker", "message": "Blocker not found"})
    if blockers[index].get("source") == "derived":
        raise HTTPException(409, {"code": "derived", "message": "This blocker clears itself when its cause is fixed."})
    blockers[index] = {**blockers[index], "resolved": True, "resolved_by": user.name}
    p.blockers = blockers
    refresh_project_state(session, p)
    session.commit()
    return p


# --------------------------------------------------------------------------- links & files


@router.post("/projects/{project_id}/links")
def add_link(project_id: str, data: dict = Body(...), session: Session = Depends(get_session),
             ws: Workspace = Depends(ws_dep), user: TeamMember = Depends(user_dep)) -> ProjectLink:
    p = get_or_404(session, Project, project_id, ws)
    url = (data.get("url") or "").strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, {"code": "bad_url", "message": "Enter a full http(s) link"})
    try:
        from ..sources.links import extract_links

        kind = (extract_links(url) or [{"kind": "other"}])[0]["kind"]
    except Exception:
        kind = "other"
    link = ProjectLink(workspace_id=ws.id, project_id=p.id, url=url, kind=kind, host=urlparse(url).hostname or "",
                       status="pending_approval", note=data.get("note") or f"Added by {user.name}")
    session.add(link)
    refresh_project_state(session, p)
    session.commit()
    return link


@router.post("/links/{link_id}/approve")
def approve_link(link_id: str, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep),
                 user: TeamMember = Depends(user_dep)) -> dict:
    link = get_or_404(session, ProjectLink, link_id, ws)
    link.status, link.approved_by, link.approved_at = "approved", user.name, utcnow()
    session.add(link)
    session.add(Approval(workspace_id=ws.id, action="download_link", target_type="link", target_id=link.id,
                         decided_by=user.name, decision="approved", revision=link.url, note=link.url))
    session.commit()
    started = jobs.submit(f"link:{link.id}", download_link_job, link.id, user.name)
    return {"started": started, "link": link}


@router.post("/links/{link_id}/reject")
def reject_link(link_id: str, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep),
                user: TeamMember = Depends(user_dep)) -> ProjectLink:
    link = get_or_404(session, ProjectLink, link_id, ws)
    link.status = "rejected"
    session.add(Approval(workspace_id=ws.id, action="download_link", target_type="link", target_id=link.id,
                         decided_by=user.name, decision="rejected", note=link.url))
    refresh_project_state(session, session.get(Project, link.project_id))
    session.commit()
    return link


@router.post("/links/{link_id}/retry")
def retry_link(link_id: str, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep),
               user: TeamMember = Depends(user_dep)) -> dict:
    link = get_or_404(session, ProjectLink, link_id, ws)
    if link.status == "rejected":
        raise HTTPException(409, {"code": "rejected", "message": "Approve the link first"})
    started = jobs.submit(f"link:{link.id}", download_link_job, link.id, user.name)
    return {"started": started}


@router.post("/projects/{project_id}/fetch-attachments")
def fetch_project_attachments(project_id: str, data: dict = Body(default={}), session: Session = Depends(get_session),
                              ws: Workspace = Depends(ws_dep)) -> dict:
    get_or_404(session, Project, project_id, ws)
    return {"started": jobs.submit(f"attachments:{project_id}", fetch_attachments, project_id,
                                   retry_failed=bool(data.get("retry_failed")))}


@router.post("/files/{file_id}/retry")
def retry_file(file_id: str, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep),
               user: TeamMember = Depends(user_dep)) -> dict:
    """Try a failed download again: an e-mail attachment is fetched from the mailbox again, a file from a
    shared link re-runs that link's download."""
    f = get_or_404(session, ProjectFile, file_id, ws)
    if f.source == "email_attachment":
        f.status, f.error = "not_downloaded", None
        session.add(f)
        session.commit()
        started = jobs.submit(f"attachments:{f.project_id}:{f.id}", fetch_attachments, f.project_id,
                              retry_failed=True, file_ids=[f.id])
        return {"started": started, "kind": "attachment"}
    if f.link_id:
        link = get_or_404(session, ProjectLink, f.link_id, ws)
        if link.status == "rejected":
            raise HTTPException(409, {"code": "rejected", "message": "This link was rejected. Approve it first."})
        return {"started": jobs.submit(f"link:{link.id}", download_link_job, link.id, user.name), "kind": "link"}
    raise HTTPException(409, {"code": "not_retryable", "message": "This file was uploaded by hand. Upload it again."})


@router.post("/links/{link_id}/resolve")
def resolve_link(link_id: str, data: dict = Body(default={}), session: Session = Depends(get_session),
                 ws: Workspace = Depends(ws_dep), user: TeamMember = Depends(user_dep)) -> ProjectLink:
    """The files of this link were obtained another way (uploaded, re-sent): not a rejection."""
    link = get_or_404(session, ProjectLink, link_id, ws)
    link.status = "resolved"
    link.note = (data.get("note") or "Files obtained another way").strip()[:500]
    link.updated_at = utcnow()
    session.add(link)
    session.add(Approval(workspace_id=ws.id, action="resolve_link", target_type="link", target_id=link.id,
                         decided_by=user.name, decision="approved", note=link.note))
    refresh_project_state(session, session.get(Project, link.project_id))
    session.commit()
    return link


@router.post("/projects/{project_id}/files")
async def upload_file(project_id: str, file: UploadFile = File(...), doc_kind: str = "other",
                      session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep),
                      user: TeamMember = Depends(user_dep)) -> ProjectFile:
    p = get_or_404(session, Project, project_id, ws)
    data = await file.read()
    rel, sha = store_bytes(p.id, file.filename or "upload", data)
    row = ProjectFile(workspace_id=ws.id, project_id=p.id, name=file.filename or "upload", doc_kind=doc_kind,
                      source="upload", path=rel, size=len(data), sha256=sha,
                      mime=file.content_type or mimetypes.guess_type(file.filename or "")[0] or "", status="ready")
    session.add(row)
    log_activity(session, ws.id, "file_uploaded", f"{row.name} added to {p.name}", actor=user.name, project_id=p.id)
    refresh_project_state(session, p)
    session.commit()
    jobs.submit(f"extract:{p.id}", extract_project_files, p.id)
    return row


@router.get("/files/{file_id}")
def file_meta(file_id: str, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> ProjectFile:
    return get_or_404(session, ProjectFile, file_id, ws)


@router.get("/files/{file_id}/content")
def file_content(file_id: str, inline: bool = False, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)):
    f = get_or_404(session, ProjectFile, file_id, ws)
    path = abs_path(f.path)
    if path is None or not path.exists():
        raise HTTPException(404, {"code": "missing", "message": "File not downloaded yet"})
    return FileResponse(path, media_type=f.mime or "application/octet-stream", filename=f.name,
                        content_disposition_type="inline" if inline else "attachment")


@router.get("/files/{file_id}/text")
def file_text_route(file_id: str, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> dict:
    from ..pipeline.files import file_text

    f = get_or_404(session, ProjectFile, file_id, ws)
    return {"text": file_text(f)}


@router.get("/files/{file_id}/pages/{page}.png")
def file_page(file_id: str, page: int, dpi: int = 110, session: Session = Depends(get_session),
              ws: Workspace = Depends(ws_dep)):
    f = get_or_404(session, ProjectFile, file_id, ws)
    try:
        return Response(content=file_page_png(f, page, dpi=min(max(dpi, 50), 300)), media_type="image/png")
    except FileNotFoundError:
        raise HTTPException(404, {"code": "missing", "message": "File not downloaded yet"})
    except Exception as exc:
        raise HTTPException(422, {"code": "render_failed", "message": str(exc)})


@router.post("/files/{file_id}/review")
def review_file(file_id: str, data: dict = Body(default={}), session: Session = Depends(get_session),
                ws: Workspace = Depends(ws_dep), user: TeamMember = Depends(user_dep)) -> ProjectFile:
    """A person confirms they read this document. Separate from 'downloaded' and 'extracted'."""
    f = get_or_404(session, ProjectFile, file_id, ws)
    if f.status != "ready":
        raise HTTPException(409, {"code": "not_ready", "message": "The file is not downloaded yet"})
    f.reviewed_by, f.reviewed_at = user.name, utcnow()
    session.add(f)
    session.add(Approval(workspace_id=ws.id, action="review_file", target_type="file", target_id=f.id,
                         decided_by=user.name, decision="approved", revision=f.sha256, note=data.get("note", "")))
    session.commit()
    return f


@router.post("/projects/{project_id}/extract")
def extract_files(project_id: str, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> dict:
    get_or_404(session, Project, project_id, ws)
    return {"started": jobs.submit(f"extract:{project_id}", extract_project_files, project_id)}


# --------------------------------------------------------------------------- analysis & review


@router.post("/projects/{project_id}/analyze")
def run_analysis(project_id: str, wait: bool = False, session: Session = Depends(get_session),
                 ws: Workspace = Depends(ws_dep), user: TeamMember = Depends(user_dep)) -> dict:
    get_or_404(session, Project, project_id, ws)
    if wait:
        return analyze_project(project_id, actor=user.name)
    return {"started": jobs.submit(f"analyze:{project_id}", analyze_project, project_id, actor=user.name),
            "running": jobs.is_running(f"analyze:{project_id}")}


def _review(session: Session, ws: Workspace, project: Project) -> Review:
    review = session.exec(select(Review).where(Review.project_id == project.id).order_by(col(Review.created_at).desc())).first()
    if review is None or review.decision == "changes_requested":
        from ..pipeline.analysis import build_checklist

        review = Review(workspace_id=ws.id, project_id=project.id, checklist=build_checklist(ws, project))
        session.add(review)
        session.flush()
    return review


@router.get("/projects/{project_id}/review")
def get_review(project_id: str, session: Session = Depends(get_session), ws: Workspace = Depends(ws_dep)) -> Review:
    p = get_or_404(session, Project, project_id, ws)
    review = _review(session, ws, p)
    session.commit()
    return review


@router.put("/projects/{project_id}/review")
def update_review(project_id: str, data: dict = Body(...), session: Session = Depends(get_session),
                  ws: Workspace = Depends(ws_dep), user: TeamMember = Depends(user_dep)) -> Review:
    p = get_or_404(session, Project, project_id, ws)
    review = _review(session, ws, p)
    if review.decision == "approved":
        raise HTTPException(409, {"code": "decided", "message": "This review is already approved"})
    if isinstance(data.get("checklist"), list):
        allowed = {"pending", "checked", "needs_review", "failed", "na"}
        if any(not isinstance(i, dict) or not isinstance(i.get("key"), str) or not i["key"].strip()
               for i in data["checklist"]):
            raise HTTPException(422, {"code": "invalid_checklist", "message": "Each check needs a valid key"})
        keys = [i["key"] for i in data["checklist"]]
        if len(keys) != len(set(keys)):
            raise HTTPException(422, {"code": "invalid_checklist", "message": "A check cannot appear more than once"})
        review.checklist = [{**i, "status": i.get("status") if i.get("status") in allowed else "pending"}
                            for i in data["checklist"]]
    if "note" in data:
        review.note = str(data["note"])[:2000]
    review.reviewer_id, review.reviewer_name, review.updated_at = user.id, user.name, utcnow()
    session.add(review)
    p.review_status = "in_review"
    refresh_project_state(session, p)
    session.commit()
    return review


@router.post("/projects/{project_id}/review/approve")
def approve_review(project_id: str, data: dict = Body(default={}), session: Session = Depends(get_session),
                   ws: Workspace = Depends(ws_dep), user: TeamMember = Depends(user_dep)) -> Review:
    require_role(user, "engineer", "Approving the technical scope")
    p = get_or_404(session, Project, project_id, ws)
    review = _review(session, ws, p)
    from ..workspace import DEFAULT_SETTINGS

    required = (ws.settings or {}).get("review_checklist") or DEFAULT_SETTINGS["review_checklist"]
    present = {i.get("key") for i in review.checklist if isinstance(i, dict)}
    missing = [i.get("label") or i["key"] for i in required if i["key"] not in present]
    if not review.checklist or missing:
        raise HTTPException(409, {"code": "checklist_open", "message": "Restore all required checks before approval: " + ", ".join(missing)})
    files = session.exec(select(ProjectFile).where(ProjectFile.project_id == p.id,
                                                   ProjectFile.workspace_id == ws.id)).all()

    def complete(item: dict) -> bool:
        note = str(item.get("note") or "").strip()
        if item.get("status") == "na":
            return bool(note)
        if item.get("status") != "checked":
            return False
        key = str(item.get("key") or "")
        if key != "drawings" and "revision" not in key.lower():
            return True
        if note or any(isinstance(ev, dict) and str(ev.get("quote") or "").strip()
                       for ev in item.get("evidence") or []):
            return True
        for file in files:
            for finding in (file.analysis or {}).values():
                if not isinstance(finding, dict):
                    continue
                revision = (finding.get("sheet") or {}).get("revision")
                if isinstance(revision, dict) and revision.get("readable") is not False and str(revision.get("value") or "").strip():
                    return True
        return False

    open_items = [i.get("label") or i.get("key") or "Unnamed check" for i in review.checklist if not complete(i)]
    if open_items:
        raise HTTPException(409, {"code": "checklist_open", "message": "Complete each check and record a reason when not applicable or the drawing revision is missing: " + ", ".join(open_items)})
    review.decision, review.decided_at = "approved", utcnow()
    review.reviewer_id, review.reviewer_name = user.id, user.name
    review.note = data.get("note", review.note)
    session.add(review)
    session.add(Approval(workspace_id=ws.id, action="approve_scope", target_type="project", target_id=p.id,
                         decided_by=user.name, decision="approved", revision=review.revision or review.id,
                         note=review.note or ""))
    for q in session.exec(select(Quotation).where(Quotation.project_id == p.id)).all():
        if (q.impact_review or {}).get("required"):
            q.impact_review = {**q.impact_review, "required": False, "cleared_by": user.name,
                               "cleared_at": utcnow().isoformat(), "review_id": review.id}
            session.add(q)
    log_activity(session, ws.id, "scope_approved", f"Technical scope approved: {p.name}", actor=user.name,
                 project_id=p.id, severity="success")
    refresh_project_state(session, p)
    session.commit()
    return review


@router.post("/projects/{project_id}/review/request-changes")
def request_changes(project_id: str, data: dict = Body(...), session: Session = Depends(get_session),
                    ws: Workspace = Depends(ws_dep), user: TeamMember = Depends(user_dep)) -> Review:
    p = get_or_404(session, Project, project_id, ws)
    review = _review(session, ws, p)
    note = (data.get("note") or "").strip()
    if not note:
        raise HTTPException(400, {"code": "note_required", "message": "Say what must change"})
    review.decision, review.decided_at, review.note = "changes_requested", utcnow(), note
    review.reviewer_id, review.reviewer_name = user.id, user.name
    session.add(review)
    session.add(Approval(workspace_id=ws.id, action="request_changes", target_type="project", target_id=p.id,
                         decided_by=user.name, decision="rejected", revision=review.revision or review.id, note=note))
    from ..learning import on_review_note

    on_review_note(session, ws, p, note, user.name)
    log_activity(session, ws.id, "changes_requested", f"Changes requested: {p.name}", detail=note, actor=user.name,
                 project_id=p.id, severity="warning")
    refresh_project_state(session, p)
    session.commit()
    return review
