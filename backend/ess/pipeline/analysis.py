"""Scope analysis of a project: AI extraction + drawing study when an eligible engine exists,
deterministic BOQ/keyword analysis otherwise. Always ends with an engineer review checklist."""
from __future__ import annotations

from typing import Any

from sqlmodel import Session, col, select

from ..db import session_scope
from ..models import Email, KnowledgeItem, Project, ProjectFile, Review, Workspace, utcnow
from ..workspace import log_activity
from .connect import engine_for
from .files import extract_project_files, file_page_png, file_text
from .state import refresh_project_state

MAX_DRAWING_PAGES = 6


def knowledge_context(session: Session, ws: Workspace) -> dict[str, Any]:
    items = session.exec(select(KnowledgeItem).where(KnowledgeItem.workspace_id == ws.id,
                                                     KnowledgeItem.status != "rejected")).all()
    by_kind: dict[str, list] = {}
    for k in items:
        by_kind.setdefault(k.kind, []).append({"key": k.key, "label": k.label, "synonyms": k.synonyms,
                                                "region": k.region, "status": k.status})
    return {"company": ws.company_name or ws.name, "region": ws.region, "languages": ws.languages,
            "currency": ws.currency, **by_kind}


def thread_text(session: Session, project: Project) -> tuple[str, dict[str, str]]:
    emails = session.exec(select(Email).where(Email.project_id == project.id).order_by(col(Email.date))).all()
    parts, sources = [], {}
    for e in emails:
        head = f"From: {e.from_name} <{e.from_email}>\nDate: {e.date}\nSubject: {e.subject}\n"
        body = e.body_text or e.snippet
        parts.append(f"[email {e.id}]\n{head}\n{body}")
        sources[e.id] = f"{e.subject}\n{body}"
        sources[e.thread_id] = sources.get(e.thread_id, "") + "\n" + body
    return "\n\n---\n\n".join(parts), sources


def build_checklist(ws: Workspace, project: Project) -> list[dict]:
    template = (ws.settings or {}).get("review_checklist") or []
    unverified = [r for r in (project.requirements or []) + (project.scope_items or [])
                  if isinstance(r.get("evidence"), dict) and r["evidence"].get("verified") is False]
    checklist = []
    for item in template:
        status = "pending"
        note = ""
        if item["key"] == "scope" and (project.unresolved_questions or unverified):
            status, note = "needs_review", f"{len(project.unresolved_questions or [])} open question(s), {len(unverified)} unverified fact(s)"
        if item["key"] == "drawings" and any(b.get("kind") == "missing_drawing" for b in project.blockers or []):
            status, note = "needs_review", "No drawing received"
        if item["key"] == "loads" and project.service_family in ("bmu", "wce", "cradle"):
            status, note = "needs_review", "Confirm roof/parapet loads with the structural engineer"
        checklist.append({**item, "status": status, "note": note})
    return checklist


def _boq_scope(files: list[ProjectFile]) -> list[dict]:
    items = []
    for f in files:
        for row in (f.extraction or {}).get("boq_relevant") or []:
            desc = row.get("description") or ""
            items.append({"description": desc[:400], "qty": row.get("qty"), "unit": row.get("unit"),
                          "evidence": {"quote": desc[:200], "source_type": "file", "source_id": f.id,
                                       "source_label": f.name, "page": row.get("page"),  # PDF page
                                       "sheet": row.get("sheet"), "row": row.get("row")}})  # spreadsheet
    return items


def analyze_project(project_id: str, *, actor: str = "system") -> dict:
    with session_scope() as s:
        project = s.get(Project, project_id)
        project.analysis = {**(project.analysis or {}), "status": "running", "started_at": utcnow().isoformat()}
        s.add(project)
        refresh_project_state(s, project)
    try:
        return _analyze(project_id, actor)
    except Exception as exc:
        with session_scope() as s:
            project = s.get(Project, project_id)
            project.analysis = {**(project.analysis or {}), "status": "failed", "error": str(exc)[:1000]}
            s.add(project)
            log_activity(s, project.workspace_id, "analysis_failed", f"Analysis failed: {project.name}",
                         detail=str(exc)[:500], project_id=project.id, severity="error")
            refresh_project_state(s, project)
        raise


def _analyze(project_id: str, actor: str) -> dict:
    extract_project_files(project_id)
    with session_scope() as s:
        project = s.get(Project, project_id)
        ws = s.get(Workspace, project.workspace_id)
        files = list(s.exec(select(ProjectFile).where(ProjectFile.project_id == project_id,
                                                      ProjectFile.status == "ready")).all())
        text, sources = thread_text(s, project)
        file_docs = [{"name": f.name, "text": file_text(f)[:60000]} for f in files]
        for f, d in zip(files, file_docs):
            sources[f.id] = d["text"]
            sources[f.name] = d["text"]
        knowledge = knowledge_context(s, ws)
        choice = engine_for(s, ws, "extract_request")
        notes: list[str] = []
        stats: dict[str, Any] = {"files": len(files), "emails_chars": len(text)}

        if choice is not None:
            from ..ai import tasks

            from ..learning import memory_context

            knowledge = {**knowledge, "lessons": memory_context(s, ws, task="extract_request",
                                                                 service_family=project.service_family,
                                                                 customer_id=project.customer_id)}
            facts = tasks.extract_request(choice.engine, text, file_docs, knowledge)
            _merge_facts(project, facts)
            stats["engine"] = f"{choice.connection.provider}/{choice.model}"
            drawing_choice = engine_for(s, ws, "analyze_drawing")
            if drawing_choice is not None:
                done = 0
                for f in files:
                    for page in (f.extraction or {}).get("drawing_pages") or []:
                        if done >= MAX_DRAWING_PAGES or page is None:
                            break
                        try:
                            png = file_page_png(f, int(page), dpi=130)
                            result = tasks.analyze_drawing(drawing_choice.engine, png,
                                                           {"project": project.name, "file": f.name, "page": page})
                            f.analysis = {**(f.analysis or {}), str(page): result}
                            s.add(f)
                            done += 1
                        except Exception as exc:
                            notes.append(f"Drawing {f.name} p{page}: {exc}")
                stats["drawing_pages"] = done
            else:
                notes.append("Drawings were not studied: no eligible vision model for 'analyze_drawing'.")
        else:
            boq = _boq_scope(files)
            if boq and not project.scope_items:
                project.scope_items = boq
            notes.append("No eligible AI engine: scope comes from BOQ rows and the scanned facts only.")
            stats["engine"] = "rules"

        project.analysis = {"status": "done", "ran_at": utcnow().isoformat(), "notes": notes, "stats": stats,
                            "by": actor}
        review = s.exec(select(Review).where(Review.project_id == project.id, Review.decision == None)  # noqa: E711
                        ).first()
        if review is None:
            review = Review(workspace_id=ws.id, project_id=project.id)
        review.checklist = build_checklist(ws, project)
        review.updated_at = utcnow()
        s.add(review)
        s.add(project)
        log_activity(s, ws.id, "analysis", f"Scope analysis ready: {project.name}",
                     detail="; ".join(notes)[:500], project_id=project.id, actor=actor, severity="success")
        s.flush()
        refresh_project_state(s, project)
        return {"status": "done", "notes": notes, "stats": stats}


def _merge_facts(project: Project, facts: dict[str, Any]) -> None:
    for key in ("service_family", "work_type", "request_kind", "tender_no", "location", "owner_client",
                "consultant", "main_contractor"):
        if facts.get(key) and not getattr(project, key, None):
            setattr(project, key, facts[key])
    if facts.get("summary"):
        project.summary = facts["summary"]
    for key in ("scope_items", "requirements"):
        if facts.get(key):
            setattr(project, key, facts[key])
    if facts.get("unresolved_questions"):
        project.unresolved_questions = list(dict.fromkeys((project.unresolved_questions or []) + facts["unresolved_questions"]))
    if facts.get("changes"):
        known = {(c.get("kind"), c.get("new_value")) for c in project.changes or []}
        project.changes = (project.changes or []) + [c for c in facts["changes"] if (c.get("kind"), c.get("new_value")) not in known]
    if facts.get("blockers"):
        project.blockers = (project.blockers or []) + [dict(b, source="ai") for b in facts["blockers"]]
