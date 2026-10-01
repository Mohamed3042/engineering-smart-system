"""Engine via MCP: an external AI client (Claude, ChatGPT, …) does the reading and drafting through
these tools instead of an API key stored in the app.

The same quality rules apply as for API engines: the client declares its model, ineligible models
are refused, every submission is schema-checked, evidence quotes must exist in the source text,
prices are stripped, and nothing here can send mail or approve anything.

Run over HTTP (mounted by the app at /mcp/) or stdio: `python -m ess.mcp_server`.
"""
from __future__ import annotations

from typing import Optional

from mcp.server.mcpserver import Image, MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from sqlmodel import col, select

from .db import init_db, session_scope
from .models import (
    AppState,
    Category,
    Customer,
    Email,
    Enquiry,
    KnowledgeItem,
    Project,
    ProjectFile,
    Quotation,
    ResearchReport,
    utcnow,
)
from .pipeline.importer import _verify_tree, quote_found, strip_prices
from .pipeline.state import refresh_project_state
from .workspace import get_active_workspace, log_activity

INSTRUCTIONS = """You are the analysis engine of an engineering company's email-to-quotation system.
Rules you must follow (submissions that break them are rejected):
1. Call declare_engine first with your real provider and model id.
2. Every fact needs evidence: a verbatim quote copied from the email or file text you read, plus its source id.
3. Never invent values. Unknown → null and add a question to unresolved_questions.
4. Never write prices, rates or totals. The engineer prices the quotation.
5. You cannot send mail, approve, or contact anyone. A person reviews everything you submit."""

CRITICAL = {"submit_project_facts": "extract_request", "submit_drawing_findings": "analyze_drawing",
            "propose_quotation": "draft_quotation", "add_knowledge": "discover_business",
            "submit_customer_research": "research_customer", "submit_classification": "classify_email"}


def _server():
    server = MCPServer(name="Engineering Smart System", instructions=INSTRUCTIONS, version="0.1.0")

    def check_engine(s, ws, tool: str) -> dict:
        state = s.get(AppState, f"mcp:engine:{ws.id}")
        decl = state.value if state and state.value else None
        if not decl:
            raise ToolError("Call declare_engine(provider, model_id) before submitting work.")
        task = CRITICAL.get(tool)
        status = (decl.get("tasks") or {}).get(task, {}).get("status")
        if status != "eligible":
            raise ToolError(f"Model {decl.get('model_id')} is not eligible for {task}: "
                             + "; ".join((decl.get("tasks") or {}).get(task, {}).get("reasons", [])))
        return decl

    @server.tool()
    def workspace_overview() -> dict:
        """Company identity, mail categories, service families, and the rules for this workspace."""
        with session_scope() as s:
            ws = get_active_workspace(s)
            cats = s.exec(select(Category).where(Category.workspace_id == ws.id).order_by(Category.order)).all()
            know = s.exec(select(KnowledgeItem).where(KnowledgeItem.workspace_id == ws.id,
                                                      KnowledgeItem.status != "rejected")).all()
            return {
                "company": ws.company_name or ws.name, "mailbox": ws.primary_email, "region": ws.region,
                "languages": ws.languages, "currency": ws.currency,
                "categories": [{"key": c.key, "label": c.label, "group": c.group} for c in cats],
                "service_families": [{"key": k.key, "label": k.label, "status": k.status} for k in know if k.kind == "service_family"],
                "terms": [{"term": k.label, "synonyms": k.synonyms, "region": k.region} for k in know if k.kind == "term"][:200],
                "rules": INSTRUCTIONS,
            }

    @server.tool()
    def declare_engine(provider: str, model_id: str, client_name: str = "") -> dict:
        """Declare which model is doing the work. Refused or unexamined models cannot submit critical work."""
        from .pipeline.connect import model_eligibility

        with session_scope() as s:
            ws = get_active_workspace(s)
            tasks = {}
            for task in sorted(set(CRITICAL.values())):
                try:
                    status, reasons = model_eligibility(s, ws, provider, model_id, task)
                except Exception as exc:
                    status, reasons = "refused", [f"policy check failed: {exc}"]
                tasks[task] = {"status": status, "reasons": reasons}
            decl = {"provider": provider, "model_id": model_id, "client": client_name, "tasks": tasks,
                    "declared_at": utcnow().isoformat()}
            for key, value in ((f"mcp:engine:{ws.id}", decl), (f"mcp:last_client:{ws.id}", {"client": client_name, "model": model_id, "at": decl["declared_at"]})):
                row = s.get(AppState, key) or AppState(key=key)
                row.value = value
                s.add(row)
            log_activity(s, ws.id, "mcp_engine", f"MCP engine declared: {model_id}", detail=client_name)
            return decl

    @server.tool()
    def list_work(kind: str = "needs_analysis", limit: int = 20) -> list[dict]:
        """Work queue. kind: unclassified | needs_analysis | needs_draft | open_changes | needs_research."""
        with session_scope() as s:
            ws = get_active_workspace(s)
            if kind == "unclassified":
                rows = s.exec(select(Email).where(Email.workspace_id == ws.id, Email.category_source == "rules",
                                                  Email.direction == "inbound").order_by(col(Email.date).desc()).limit(limit)).all()
                return [{"email_id": e.id, "subject": e.subject, "from": e.from_email, "rule_category": e.category,
                         "confidence": e.category_confidence} for e in rows]
            if kind == "needs_research":
                rows = s.exec(select(Customer).where(Customer.workspace_id == ws.id, Customer.profile_status == "none",
                                                     Customer.enquiry_count > 0).limit(limit)).all()
                return [{"customer_id": c.id, "name": c.name, "domain": c.domain} for c in rows]
            projects = s.exec(select(Project).where(Project.workspace_id == ws.id, Project.archived_at == None)).all()  # noqa: E711
            out = []
            for p in projects:
                if kind == "needs_analysis" and (p.analysis or {}).get("status") != "done":
                    out.append(p)
                elif kind == "needs_draft" and (p.analysis or {}).get("status") == "done" and not s.exec(
                        select(Quotation).where(Quotation.project_id == p.id)).first():
                    out.append(p)
                elif kind == "open_changes" and any(not c.get("acknowledged") for c in p.changes or []):
                    out.append(p)
            return [{"project_id": p.id, "name": p.name, "service_family": p.service_family, "stage": p.stage,
                     "due_date": p.due_date.isoformat() if p.due_date else None} for p in out[:limit]]

    @server.tool()
    def get_email(email_id: str) -> dict:
        """Full email text (the evidence source for quotes)."""
        with session_scope() as s:
            e = s.get(Email, email_id)
            if e is None:
                raise ToolError("email not found")
            return {"id": e.id, "thread_id": e.thread_id, "from": f"{e.from_name} <{e.from_email}>", "to": e.to,
                    "cc": e.cc, "date": e.date.isoformat() if e.date else None, "subject": e.subject,
                    "body_text": e.body_text, "attachments": e.attachments, "links": e.links,
                    "category": e.category, "project_id": e.project_id}

    @server.tool()
    def get_project(project_id: str) -> dict:
        """Project facts, enquiries, emails and files (ids for read_file / get_file_page)."""
        with session_scope() as s:
            p = s.get(Project, project_id)
            if p is None:
                raise ToolError("project not found")
            emails = s.exec(select(Email).where(Email.project_id == p.id).order_by(col(Email.date))).all()
            files = s.exec(select(ProjectFile).where(ProjectFile.project_id == p.id)).all()
            enqs = s.exec(select(Enquiry).where(Enquiry.project_id == p.id)).all()
            return {
                "project": {k: v for k, v in p.model_dump().items() if k not in ("analysis",)},
                "enquiries": [{"id": e.id, "customer_id": e.customer_id, "due_date": e.due_date.isoformat() if e.due_date else None,
                               "status": e.status, "contact": e.contact} for e in enqs],
                "emails": [{"id": e.id, "subject": e.subject, "date": e.date.isoformat() if e.date else None,
                            "from": e.from_email} for e in emails],
                "files": [{"id": f.id, "name": f.name, "doc_kind": f.doc_kind, "status": f.status, "pages": f.pages,
                           "drawing_pages": (f.extraction or {}).get("drawing_pages")} for f in files],
            }

    @server.tool()
    def read_file(file_id: str, max_chars: int = 60000) -> dict:
        """Extracted text of a project file (PDF/DOCX/XLSX…), with BOQ rows flagged as relevant."""
        from .pipeline.files import file_text

        with session_scope() as s:
            f = s.get(ProjectFile, file_id)
            if f is None:
                raise ToolError("file not found")
            return {"name": f.name, "doc_kind": f.doc_kind, "text": file_text(f)[:max_chars],
                    "boq_relevant": (f.extraction or {}).get("boq_relevant", [])[:100]}

    @server.tool()
    def get_file_page(file_id: str, page: int, dpi: int = 130) -> Image:
        """Render one PDF page (e.g. a drawing) as a PNG image to study it visually."""
        from .pipeline.files import file_page_png

        with session_scope() as s:
            f = s.get(ProjectFile, file_id)
            if f is None:
                raise ToolError("file not found")
            png = file_page_png(f, page, dpi=dpi)
        return Image(data=png, format="png")

    @server.tool()
    def submit_classification(email_id: str, category: str, confidence: float, reason: str,
                              evidence: list[dict], priority: str = "normal") -> dict:
        """Set an email's category. Evidence quotes must appear verbatim in the email."""
        with session_scope() as s:
            ws = get_active_workspace(s)
            decl = check_engine(s, ws, "submit_classification")
            e = s.get(Email, email_id)
            if e is None or not s.get(Category, f"{ws.id}:{category}"):
                raise ToolError("unknown email or category")
            bad = [ev.get("quote") for ev in evidence if not quote_found(ev.get("quote", ""), f"{e.subject}\n{e.body_text}")]
            if bad or not evidence:
                raise ToolError(f"Evidence not found verbatim in the email: {bad or 'none given'}")
            if e.category_source == "user":
                return {"skipped": "a person already set this category"}
            e.category, e.category_confidence, e.category_reason = category, float(confidence), reason[:500]
            e.category_evidence, e.priority, e.category_source = evidence, priority, "mcp"
            s.add(e)
            return {"ok": True, "by": decl["model_id"]}

    @server.tool()
    def submit_project_facts(project_id: str, facts: dict) -> dict:
        """Submit extracted project facts (see docs/snapshot-format.md project fields). Unverified evidence is flagged."""
        from .pipeline.analysis import _merge_facts, build_checklist, thread_text
        from .pipeline.files import file_text
        from .models import Review

        with session_scope() as s:
            ws = get_active_workspace(s)
            decl = check_engine(s, ws, "submit_project_facts")
            p = s.get(Project, project_id)
            if p is None:
                raise ToolError("project not found")
            _, sources = thread_text(s, p)
            for f in s.exec(select(ProjectFile).where(ProjectFile.project_id == p.id)).all():
                sources[f.id] = file_text(f)
                sources[f.name] = sources[f.id]
            sources["__all__"] = "\n".join(sources.values())
            stats = {"checked": 0, "verified": 0}
            clean = _verify_tree(strip_prices(facts), sources, stats)
            _merge_facts(p, clean)
            p.analysis = {"status": "done", "ran_at": utcnow().isoformat(), "by": f"mcp:{decl['model_id']}",
                          "notes": [f"Evidence verified {stats['verified']}/{stats['checked']}"], "stats": stats}
            review = s.exec(select(Review).where(Review.project_id == p.id, Review.decision == None)).first()  # noqa: E711
            review = review or Review(workspace_id=ws.id, project_id=p.id)
            review.checklist = build_checklist(ws, p)
            s.add(review)
            s.add(p)
            log_activity(s, ws.id, "analysis", f"Scope analysis submitted over MCP: {p.name}", project_id=p.id,
                         actor=decl["model_id"], detail=p.analysis["notes"][0])
            s.flush()
            refresh_project_state(s, p)
            return {"ok": True, "evidence": stats}

    @server.tool()
    def submit_drawing_findings(file_id: str, page: int, findings: dict) -> dict:
        """Store what you saw on a drawing page (title block, levels, BMU/monorail marks…) with where-on-sheet evidence."""
        with session_scope() as s:
            ws = get_active_workspace(s)
            decl = check_engine(s, ws, "submit_drawing_findings")
            f = s.get(ProjectFile, file_id)
            if f is None:
                raise ToolError("file not found")
            f.analysis = {**(f.analysis or {}), str(page): {**strip_prices(findings), "by": decl["model_id"]}}
            s.add(f)
            return {"ok": True}

    @server.tool()
    def propose_quotation(project_id: str, draft: dict, enquiry_id: Optional[str] = None,
                          template_key: Optional[str] = None, language: str = "en") -> dict:
        """Create a draft quotation (subject, intro, items with qty/unit, exclusions, clarifications). No prices."""
        from .pipeline.drafting import create_quotation

        with session_scope() as s:
            ws = get_active_workspace(s)
            decl = check_engine(s, ws, "propose_quotation")
            p = s.get(Project, project_id)
            if p is None:
                raise ToolError("project not found")
            enquiry = s.get(Enquiry, enquiry_id) if enquiry_id else None
            q = create_quotation(s, ws, p, enquiry=enquiry, template_key=template_key, language=language,
                                 actor=f"mcp:{decl['model_id']}")
            clean = strip_prices(draft)
            data = dict(q.data)
            for key in ("subject", "intro", "exclusions", "clarifications", "notes"):
                if clean.get(key):
                    data[key] = clean[key]
            if clean.get("items"):
                data["items"] = [{"no": i + 1, "description": it.get("description", ""), "spec": it.get("spec", ""),
                                  "qty": it.get("qty"), "unit": it.get("unit") or "", "unit_price": None, "total": None}
                                 for i, it in enumerate(clean["items"])]
            q.data = data
            q.created_by = "mcp"
            s.add(q)
            return {"ok": True, "quotation_id": q.id, "reference": q.reference, "status": q.status}

    @server.tool()
    def add_knowledge(items: list[dict]) -> dict:
        """Suggest business knowledge (service_family | work_type | term | standard | convention) with evidence."""
        with session_scope() as s:
            ws = get_active_workspace(s)
            decl = check_engine(s, ws, "add_knowledge")
            added = 0
            for it in items:
                if it.get("kind") not in ("service_family", "work_type", "term", "standard", "convention") or not it.get("label"):
                    continue
                if not it.get("evidence"):
                    continue
                key = it.get("key") or it["label"].lower().replace(" ", "_")
                row = s.exec(select(KnowledgeItem).where(KnowledgeItem.workspace_id == ws.id, KnowledgeItem.kind == it["kind"],
                                                         KnowledgeItem.key == key)).first()
                if row is not None and row.status in ("owner_confirmed", "rejected"):
                    continue
                row = row or KnowledgeItem(workspace_id=ws.id, kind=it["kind"], key=key, label=it["label"])
                for k in ("label", "label_ar", "description", "synonyms", "region", "language", "claim_basis", "evidence"):
                    if it.get(k) is not None:
                        setattr(row, k, it[k])
                row.confidence = min(float(it.get("confidence") or 0.5), 0.9)
                row.source, row.status = f"mcp:{decl['model_id']}", "suggested"
                s.add(row)
                added += 1
            return {"added": added}

    @server.tool()
    def submit_customer_research(customer_id: str, report: dict, standard: str = "standard") -> dict:
        """Store a customer research report: sections → claims, each claim citing url + verbatim quote."""
        with session_scope() as s:
            ws = get_active_workspace(s)
            check_engine(s, ws, "submit_customer_research")
            c = s.get(Customer, customer_id)
            if c is None:
                raise ToolError("customer not found")
            sections = report.get("sections") or {}
            cited = sum(1 for sec in sections.values() for cl in (sec or {}).get("claims", []) if cl.get("sources"))
            r = ResearchReport(workspace_id=ws.id, customer_id=c.id, standard=standard, status="done", provider="mcp",
                               sections=sections, gaps=report.get("gaps") or [], summary=report.get("summary") or "",
                               evidence_count=cited, met_standard=cited > 0, finished_at=utcnow())
            c.profile_status = "ready" if cited else "partial"
            s.add(r)
            s.add(c)
            return {"ok": True, "report_id": r.id, "cited_claims": cited}

    return server


_instance = None


def get_server():
    global _instance
    if _instance is None:
        _instance = _server()
    return _instance


def http_app():
    """Starlette app for mounting at /mcp (stateless streamable HTTP, JSON responses).

    DNS-rebinding protection stays on; extra host names (e.g. a LAN name) go in ESS_MCP_ALLOWED_HOSTS.
    """
    import os

    from mcp.server.transport_security import TransportSecuritySettings

    hosts = ["127.0.0.1", "127.0.0.1:*", "localhost", "localhost:*", "testserver"]
    hosts += [h.strip() for h in os.environ.get("ESS_MCP_ALLOWED_HOSTS", "").split(",") if h.strip()]
    origins = ["http://127.0.0.1:*", "http://localhost:*"]
    security = TransportSecuritySettings(enable_dns_rebinding_protection=True, allowed_hosts=hosts,
                                         allowed_origins=origins)
    return get_server().streamable_http_app(streamable_http_path="/", stateless_http=True, json_response=True,
                                            transport_security=security)


if __name__ == "__main__":
    init_db()
    get_server().run("stdio")
