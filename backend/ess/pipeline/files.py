"""Project inputs: save attachments, download shared links (with the approval policy), read documents."""
from __future__ import annotations

import hashlib
import json
import mimetypes
import re
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse

from sqlmodel import Session, col, select

from ..config import get_settings
from ..db import session_scope
from ..models import Email, Project, ProjectFile, ProjectLink, Workspace, utcnow
from ..workspace import log_activity
from .state import refresh_project_state

SAFE_NAME = re.compile(r"[^A-Za-z0-9._\-() ؀-ۿ]+")


def safe_filename(name: str) -> str:
    name = SAFE_NAME.sub("_", Path(name or "file").name).strip(" .") or "file"
    return name[:180]


def project_dir(project_id: str) -> Path:
    d = get_settings().files_dir / project_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def store_bytes(project_id: str, name: str, data: bytes) -> tuple[str, str]:
    """Write bytes into the project folder; returns (relative path, sha256)."""
    dest = project_dir(project_id) / safe_filename(name)
    if dest.exists() and dest.read_bytes() != data:
        stem, suffix = dest.stem, dest.suffix
        n = 2
        while dest.exists():
            dest = dest.with_name(f"{stem} ({n}){suffix}")
            n += 1
    dest.write_bytes(data)
    return str(dest.relative_to(get_settings().data_dir)), hashlib.sha256(data).hexdigest()


def abs_path(rel: Optional[str]) -> Optional[Path]:
    if not rel:
        return None
    p = (get_settings().data_dir / rel).resolve()
    if get_settings().data_dir.resolve() not in p.parents:
        return None  # never serve outside the data dir
    return p


# --------------------------------------------------------------------------- links


def link_policy(ws: Workspace, url: str) -> str:
    """'auto' when the host is a trusted file host, else 'approval'."""
    host = (urlparse(url).hostname or "").lower()
    hosts = [h.lower() for h in (ws.settings or {}).get("downloads", {}).get("auto_approve_hosts", [])]
    return "auto" if any(host == h or host.endswith("." + h) for h in hosts) else "approval"


def register_links(session: Session, ws: Workspace, project: Project, email: Email) -> list[ProjectLink]:
    created = []
    links = list(email.links or [])
    if not links:
        try:
            from ..sources.links import extract_links

            links = extract_links(email.body_text or "")
        except Exception:
            links = []
    for l in links:
        url = l.get("url")
        if not url or l.get("kind") == "other":
            continue
        exists = session.exec(select(ProjectLink).where(ProjectLink.project_id == project.id, ProjectLink.url == url)).first()
        if exists:
            continue
        link = ProjectLink(workspace_id=ws.id, project_id=project.id, email_id=email.id, url=url,
                           kind=l.get("kind") or "other", host=urlparse(url).hostname or "",
                           status="approved" if link_policy(ws, url) == "auto" else "pending_approval")
        session.add(link)
        created.append(link)
    return created


async def download_link_job(link_id: str, approved_by: str = "policy") -> dict:
    from ..browser.downloader import download_link

    with session_scope() as s:
        link = s.get(ProjectLink, link_id)
        if link is None:
            return {"status": "missing"}
        ws = s.get(Workspace, link.workspace_id)
        link.status = "downloading"
        link.approved_by = link.approved_by or approved_by
        link.approved_at = link.approved_at or utcnow()
        s.add(link)
        url, kind, project_id = link.url, link.kind, link.project_id
        max_mb = (ws.settings or {}).get("downloads", {}).get("max_file_mb", 2000)

    dest = project_dir(project_id) / "downloads"
    dest.mkdir(parents=True, exist_ok=True)
    try:
        result = await download_link(url, kind, dest, max_bytes=int(max_mb) * 1024 * 1024)
        status = getattr(result, "status", "failed")
        files = list(getattr(result, "files", []) or [])
        error = getattr(result, "error", None)
        log = list(getattr(result, "log", []) or [])
    except Exception as exc:  # network errors, browser missing
        status, files, error, log = "failed", [], str(exc), []

    with session_scope() as s:
        link = s.get(ProjectLink, link_id)
        project = s.get(Project, link.project_id)
        for f in files:
            fd = f if isinstance(f, dict) else f.__dict__
            path = Path(fd["path"])
            rel = str(path.resolve().relative_to(get_settings().data_dir.resolve()))
            existing = s.exec(select(ProjectFile).where(ProjectFile.project_id == project.id,
                                                        ProjectFile.sha256 == fd.get("sha256"))).first()
            if existing:
                continue
            s.add(ProjectFile(workspace_id=project.workspace_id, project_id=project.id, name=fd.get("name") or path.name,
                              source=_source_for_kind(link.kind), source_url=link.url, link_id=link.id, path=rel,
                              size=fd.get("size") or path.stat().st_size, sha256=fd.get("sha256"),
                              mime=fd.get("mime") or (mimetypes.guess_type(path.name)[0] or ""), status="ready"))
        link.status = {"ok": "downloaded"}.get(status, status)
        link.error = error
        link.files_count = len(files)
        link.result = {"log": log[-50:], "status": status}
        link.updated_at = utcnow()
        s.add(link)
        log_activity(s, project.workspace_id, "download", f"{len(files)} file(s) from {link.host}",
                     detail=error or status, project_id=project.id,
                     severity="success" if status == "ok" else "warning")
        s.flush()
        refresh_project_state(s, project)
    if status == "ok":
        extract_project_files(project_id)
    return {"status": status, "files": len(files), "error": error}


def _source_for_kind(kind: str) -> str:
    if kind.startswith("google"):
        return "google_drive"
    return kind if kind in ("wetransfer", "dropbox", "onedrive") else "link"


# --------------------------------------------------------------------------- attachments


def fetch_attachments(project_id: str, *, retry_failed: bool = False, file_ids: Optional[list[str]] = None) -> dict:
    """Download e-mail attachments not saved yet; with ``retry_failed`` also the ones that failed."""
    from .connect import mail_source_for

    saved, failed = 0, []
    statuses = ["not_downloaded", "failed"] if retry_failed else ["not_downloaded"]
    with session_scope() as s:
        project = s.get(Project, project_id)
        ws = s.get(Workspace, project.workspace_id)
        query = select(ProjectFile).where(ProjectFile.project_id == project_id,
                                          ProjectFile.source == "email_attachment",
                                          col(ProjectFile.status).in_(statuses))
        if file_ids:
            query = query.where(col(ProjectFile.id).in_(file_ids))
        pending = s.exec(query).all()
        if not pending:
            return {"saved": 0, "failed": []}
        try:
            source = mail_source_for(s, ws)
        except Exception as exc:  # no mailbox or a broken connection: say so on every file instead of failing silently
            for f in pending:
                f.status, f.error = "failed", f"Mailbox not available: {exc}"[:500]
                s.add(f)
            refresh_project_state(s, project)
            return {"saved": 0, "failed": [f.name for f in pending], "error": str(exc)[:300]}
        for f in pending:
            if not f.email_id:
                continue
            try:
                attachment_id = f.attachment_id or _find_attachment_id(s, f)
                data = source.download_attachment(f.email_id, attachment_id)
                rel, sha = store_bytes(project_id, f.name, data)
                f.path, f.sha256, f.size, f.status, f.error = rel, sha, len(data), "ready", None
                saved += 1
            except Exception as exc:
                f.status, f.error = "failed", str(exc)[:500]
                failed.append(f.name)
            s.add(f)
        refresh_project_state(s, project)
    if saved:
        extract_project_files(project_id)
    return {"saved": saved, "failed": failed}


def _find_attachment_id(session: Session, f: ProjectFile) -> Optional[str]:
    email = session.get(Email, f.email_id) if f.email_id else None
    for a in (email.attachments if email else []) or []:
        if a.get("filename") == f.name:
            return a.get("attachment_id")
    return None


# --------------------------------------------------------------------------- extraction


def extract_file(session: Session, f: ProjectFile) -> ProjectFile:
    from ..documents.extract import classify_document, extract_document

    path = abs_path(f.path)
    if path is None or not path.exists():
        f.status, f.error = "failed", "File missing on disk"
        return f
    doc = extract_document(path)
    text = doc.text or ""
    text_path = path.with_suffix(path.suffix + ".txt")
    text_path.write_text(text, encoding="utf-8")
    pages = list(doc.pages or [])
    boq = list(doc.boq_items or [])
    f.pages = len(pages) or int((doc.meta or {}).get("pages") or 0)
    if f.doc_kind in ("other", "", None):
        f.doc_kind = classify_document(f.name, text)
    f.extraction = {
        "kind": doc.kind,
        "chars": len(text),
        "drawing_pages": [p.get("n") if isinstance(p, dict) else getattr(p, "n", None)
                          for p in pages if (p.get("is_drawing_like") if isinstance(p, dict) else getattr(p, "is_drawing_like", False))],
        "boq_items": len(boq),
        "boq_relevant": [b if isinstance(b, dict) else b.__dict__ for b in boq
                         if (b.get("relevant") if isinstance(b, dict) else getattr(b, "relevant", False))][:200],
        "warnings": list(doc.warnings or []),
        "text_path": str(text_path.relative_to(get_settings().data_dir)),
        "meta": doc.meta if isinstance(doc.meta, dict) else {},
    }
    if doc.kind in ("cad", "image") and len(text.strip()) < 20:
        f.extraction_status = "not_supported"
    elif doc.warnings and len(text.strip()) < 200:
        f.extraction_status = "partial"
    else:
        f.extraction_status = "extracted"
    f.updated_at = utcnow()
    _register_children(session, f, list(getattr(doc, "children", None) or []))
    return f


def _register_children(session: Session, parent: ProjectFile, children: list) -> None:
    """Files found inside a ZIP or an e-mail become project files too (then get read like any other)."""
    data_dir = get_settings().data_dir.resolve()
    for child in children:
        cpath = Path(child.path if hasattr(child, "path") else child["path"]).resolve()
        if data_dir not in cpath.parents or not cpath.is_file():
            continue
        rel = str(cpath.relative_to(data_dir))
        if session.exec(select(ProjectFile).where(ProjectFile.project_id == parent.project_id,
                                                  ProjectFile.path == rel)).first():
            continue
        data = cpath.read_bytes()
        session.add(ProjectFile(workspace_id=parent.workspace_id, project_id=parent.project_id,
                                enquiry_id=parent.enquiry_id, name=cpath.name,
                                doc_kind=getattr(child, "doc_kind", None) or "other",
                                source=parent.source, source_url=parent.source_url, email_id=parent.email_id,
                                link_id=parent.link_id, path=rel, size=len(data),
                                sha256=hashlib.sha256(data).hexdigest(),
                                mime=mimetypes.guess_type(cpath.name)[0] or "", status="ready",
                                summary=f"Inside {parent.name}"))


def file_text(f: ProjectFile) -> str:
    rel = (f.extraction or {}).get("text_path")
    p = abs_path(rel) if rel else None
    return p.read_text(encoding="utf-8", errors="ignore") if p and p.exists() else ""


def extract_project_files(project_id: str) -> dict:
    done, errors = 0, []
    with session_scope() as s:
        for _round in range(4):  # archives can contain archives
            files = s.exec(select(ProjectFile).where(ProjectFile.project_id == project_id,
                                                     ProjectFile.status == "ready")).all()
            todo = [f for f in files if not (f.extraction or {}).get("text_path") and f.name not in errors]
            if not todo:
                break
            for f in todo:
                try:
                    extract_file(s, f)
                    done += 1
                except Exception as exc:
                    f.error = f"extract: {exc}"[:500]
                    f.extraction_status = "failed"
                    errors.append(f.name)
                s.add(f)
            s.flush()
        project = s.get(Project, project_id)
        if project:
            refresh_project_state(s, project)
    return {"extracted": done, "errors": errors}


def file_page_png(f: ProjectFile, page: int, dpi: int = 110) -> bytes:
    from ..documents.extract import render_pdf_page

    path = abs_path(f.path)
    if path is None or not path.exists():
        raise FileNotFoundError(f.name)
    cache = path.parent / ".pages" / f"{path.name}.p{page}.{dpi}.png"
    if cache.exists():
        return cache.read_bytes()
    png = render_pdf_page(path, page, dpi=dpi)
    cache.parent.mkdir(exist_ok=True)
    cache.write_bytes(png)
    return png


def dump_json(obj: Any) -> str:
    return json.dumps(obj, default=str, ensure_ascii=False)
