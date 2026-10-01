"""Database tables.

JSON columns hold structured, evidence-bearing data (scope items, requirements, changes,
checklists). Always assign a new value to a JSON attribute instead of mutating it in place,
otherwise SQLAlchemy will not notice the change.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from typing import Any, Optional

from sqlalchemy import Text
from sqlmodel import JSON, Column, Field, SQLModel


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def _json(default: Any = None) -> Any:
    factory = (lambda: list(default)) if isinstance(default, list) else (lambda: dict(default or {}))
    return Field(default_factory=factory, sa_column=Column(JSON))


def _text() -> Any:
    return Field(default="", sa_column=Column(Text))


class AppState(SQLModel, table=True):
    """Key/value store: active workspace, current user, schema version."""

    key: str = Field(primary_key=True)
    value: Any = Field(default=None, sa_column=Column(JSON))


# --------------------------------------------------------------------------- workspace


class Workspace(SQLModel, table=True):
    id: str = Field(default_factory=lambda: new_id("ws"), primary_key=True)
    name: str
    company_name: str = ""
    primary_email: str = ""
    region: str = ""
    country: str = ""
    languages: list = _json([])
    currency: str = "USD"
    timezone: str = "UTC"
    own_domains: list = _json([])
    # Onboarding progress: workspace → engine → model → mail → documents → scope → learning → identity → done
    setup_step: str = "workspace"
    settings: dict = _json({})
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class TeamMember(SQLModel, table=True):
    id: str = Field(default_factory=lambda: new_id("usr"), primary_key=True)
    workspace_id: str = Field(index=True)
    name: str
    email: str = ""
    role: str = "engineer"  # owner | admin | engineer | sales | viewer
    initials: str = ""
    active: bool = True
    created_at: datetime = Field(default_factory=utcnow)


class Connection(SQLModel, table=True):
    """A configured external connection. Secrets live in the encrypted secret store."""

    id: str = Field(default_factory=lambda: new_id("con"), primary_key=True)
    workspace_id: str = Field(index=True)
    kind: str  # ai | mail | drive | search
    method: str  # api | mcp | oauth | imap
    provider: str  # openai | anthropic | google | azure_openai | openai_compatible | gmail | imap | mcp | brave | tavily | serpapi | duckduckgo
    name: str = ""
    config: dict = _json({})
    secret_names: list = _json([])
    status: str = "not_connected"  # connected | error | not_connected | needs_auth
    account: Optional[str] = None
    is_active: bool = True
    last_checked_at: Optional[datetime] = None
    last_error: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class AIModelState(SQLModel, table=True):
    """Eligibility of one model for one workspace (registry entry + exam result)."""

    id: str = Field(primary_key=True)  # f"{workspace_id}:{provider}:{model_id}"
    workspace_id: str = Field(index=True)
    provider: str
    model_id: str
    display_name: str = ""
    tier: str = "standard"
    capabilities: dict = _json({})
    status: str = "needs_evaluation"  # eligible | refused | needs_evaluation | failed_evaluation
    reasons: list = _json([])
    exam: dict = _json({})
    evaluated_at: Optional[datetime] = None
    source: str = "registry"  # registry | remote
    is_selected: bool = False
    updated_at: datetime = Field(default_factory=utcnow)


class Approval(SQLModel, table=True):
    """Audit trail of every human-gate decision."""

    id: str = Field(default_factory=lambda: new_id("apr"), primary_key=True)
    workspace_id: str = Field(index=True)
    action: str  # send_quotation | download_link | unsubscribe | approve_scope | approve_quotation | request_changes
    target_type: str
    target_id: str = Field(index=True)
    decided_by: str
    decision: str  # approved | rejected
    revision: Optional[str] = None  # exact version the decision covers (quotation v / review id / file sha)
    note: str = ""
    created_at: datetime = Field(default_factory=utcnow)


class Activity(SQLModel, table=True):
    id: str = Field(default_factory=lambda: new_id("act"), primary_key=True)
    workspace_id: str = Field(index=True)
    kind: str
    title: str
    detail: str = ""
    severity: str = "info"  # info | success | warning | error
    actor: str = "system"
    project_id: Optional[str] = Field(default=None, index=True)
    customer_id: Optional[str] = None
    email_id: Optional[str] = None
    quotation_id: Optional[str] = None
    is_read: bool = False
    created_at: datetime = Field(default_factory=utcnow, index=True)


# --------------------------------------------------------------------------- mail


class Category(SQLModel, table=True):
    id: str = Field(primary_key=True)  # f"{workspace_id}:{key}"
    workspace_id: str = Field(index=True)
    key: str
    label: str
    label_ar: str = ""
    group: str = "work"  # work | bills | promotions | other
    icon: str = "mail"
    visible: bool = True
    is_work_type: bool = False
    description: str = ""
    keywords: dict = _json({})
    negative_keywords: dict = _json({})
    order: int = 100
    source: str = "default"  # default | learned | user
    evidence: list = _json([])


class Email(SQLModel, table=True):
    id: str = Field(primary_key=True)  # provider message id
    workspace_id: str = Field(index=True)
    thread_id: str = Field(index=True)
    account: str = ""
    direction: str = "inbound"
    from_name: str = ""
    from_email: str = Field(default="", index=True)
    to: list = _json([])
    cc: list = _json([])
    subject: str = ""
    date: Optional[datetime] = Field(default=None, index=True)
    snippet: str = ""
    body_text: str = _text()
    labels: list = _json([])
    attachments: list = _json([])
    links: list = _json([])
    list_unsubscribe: Optional[str] = None
    list_unsubscribe_post: Optional[str] = None
    view_url: Optional[str] = None
    message_count: int = 1
    answered_by_us: bool = False
    category: str = Field(default="other", index=True)
    category_confidence: float = 0.0
    category_reason: str = ""
    category_evidence: list = _json([])
    category_source: str = "rules"  # rules | ai | mcp | user | import | learned
    # What the message is for, independent of the service family:
    # rfq | addendum | deadline_change | reminder | revision | clarification | award | purchase_order
    # | invoice | offer | newsletter | notification | internal | other
    intent: str = "other"
    priority: str = "normal"  # high | normal | low
    state: str = "new"  # new | needs_review | linked | update | archived | ignored
    project_id: Optional[str] = Field(default=None, index=True)
    enquiry_id: Optional[str] = None
    customer_id: Optional[str] = Field(default=None, index=True)
    unsubscribed_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class ScanJob(SQLModel, table=True):
    id: str = Field(default_factory=lambda: new_id("scan"), primary_key=True)
    workspace_id: str = Field(index=True)
    scope: dict = _json({})
    status: str = "queued"  # queued | running | done | failed | cancelled
    progress: float = 0.0
    counts: dict = _json({})
    log: list = _json([])
    error: Optional[str] = None
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=utcnow)


# --------------------------------------------------------------------------- customers


class Customer(SQLModel, table=True):
    id: str = Field(default_factory=lambda: new_id("cus"), primary_key=True)
    workspace_id: str = Field(index=True)
    ref: str = Field(index=True)  # usually the e-mail domain
    name: str
    domain: str = ""
    kind: str = "other"
    kind_confidence: float = 0.0
    country: str = ""
    city: str = ""
    website: str = ""
    tags: list = _json([])  # [{tag, kind, confidence, evidence}]
    notes: str = _text()
    first_seen: Optional[datetime] = None
    last_seen: Optional[datetime] = None
    email_count: int = 0
    enquiry_count: int = 0
    project_count: int = 0
    status: str = "active"  # active | prospect | dormant
    profile_status: str = "none"  # none | researching | ready | partial
    monitoring: bool = False
    last_checked_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class Contact(SQLModel, table=True):
    id: str = Field(default_factory=lambda: new_id("ctc"), primary_key=True)
    workspace_id: str = Field(index=True)
    customer_id: str = Field(index=True)
    name: str = ""
    email: str = Field(default="", index=True)
    phone: Optional[str] = None
    title: Optional[str] = None
    last_seen: Optional[datetime] = None


class ResearchReport(SQLModel, table=True):
    id: str = Field(default_factory=lambda: new_id("rsr"), primary_key=True)
    workspace_id: str = Field(index=True)
    customer_id: str = Field(index=True)
    standard: str = "standard"  # basic | standard | deep
    status: str = "running"  # running | done | failed
    provider: str = ""
    sections: dict = _json({})
    gaps: list = _json([])
    met_standard: bool = False
    evidence_count: int = 0
    summary: str = _text()
    error: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)
    finished_at: Optional[datetime] = None


class CustomerUpdate(SQLModel, table=True):
    id: str = Field(default_factory=lambda: new_id("upd"), primary_key=True)
    workspace_id: str = Field(index=True)
    customer_id: str = Field(index=True)
    kind: str = "news"  # news | project | tender | contract_award | people | enquiry
    title: str
    summary: str = ""
    url: str = ""
    url_hash: str = Field(default="", index=True)
    source: str = ""
    published_at: Optional[datetime] = None
    found_at: datetime = Field(default_factory=utcnow)
    relevance: float = 0.0
    is_read: bool = False


class Opportunity(SQLModel, table=True):
    id: str = Field(default_factory=lambda: new_id("opp"), primary_key=True)
    workspace_id: str = Field(index=True)
    customer_id: str = Field(index=True)
    service_key: str
    score: float = 0.0
    reason: str = ""
    evidence: list = _json([])
    status: str = "suggested"  # suggested | accepted | dismissed
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


# --------------------------------------------------------------------------- projects


class Project(SQLModel, table=True):
    id: str = Field(default_factory=lambda: new_id("prj"), primary_key=True)
    workspace_id: str = Field(index=True)
    ref: str = Field(index=True)
    code: str = ""
    name: str
    service_family: str = Field(default="other_work", index=True)
    work_type: str = "supply_installation"
    request_kind: str = "tender_rfq"
    customer_id: Optional[str] = Field(default=None, index=True)
    stage: str = Field(default="received", index=True)
    status_note: str = ""
    priority: str = "normal"
    due_date: Optional[date] = None
    tender_no: Optional[str] = None
    location: Optional[str] = None
    owner_client: Optional[str] = None
    consultant: Optional[str] = None
    main_contractor: Optional[str] = None
    summary: str = _text()
    scope_items: list = _json([])
    requirements: list = _json([])
    unresolved_questions: list = _json([])
    changes: list = _json([])
    blockers: list = _json([])
    next_action: dict = _json({})
    timeline: list = _json([])
    analysis: dict = _json({})
    recommended_template: Optional[str] = None
    related_project_ids: list = _json([])
    assigned_to: Optional[str] = None
    review_status: str = "not_started"  # not_started | in_review | approved | changes_requested
    source: str = "pipeline"  # pipeline | scan | manual | mcp
    archived_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class Enquiry(SQLModel, table=True):
    """One contractor's request for one project (tenders bring several per project)."""

    id: str = Field(default_factory=lambda: new_id("enq"), primary_key=True)
    workspace_id: str = Field(index=True)
    project_id: str = Field(index=True)
    customer_id: Optional[str] = Field(default=None, index=True)
    ref: str = ""
    contact: dict = _json({})
    email_ids: list = _json([])
    thread_ids: list = _json([])
    received_at: Optional[datetime] = None
    due_date: Optional[date] = None
    due_date_history: list = _json([])
    status: str = "open"  # open | quoted | declined | lost | won | closed
    our_response: dict = _json({})
    # The customer's answer after we sent our offer: none | awaiting | clarification | accepted | rejected
    customer_response: str = "none"
    customer_response_at: Optional[datetime] = None
    quotation_id: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class ProjectLink(SQLModel, table=True):
    id: str = Field(default_factory=lambda: new_id("lnk"), primary_key=True)
    workspace_id: str = Field(index=True)
    project_id: str = Field(index=True)
    email_id: Optional[str] = None
    url: str
    kind: str = "other"
    host: str = ""
    # found | pending_approval | approved | downloading | downloaded | failed | expired | needs_login | blocked | rejected
    # | resolved (files obtained another way — not a rejection)
    status: str = "found"
    note: str = ""
    error: Optional[str] = None
    files_count: int = 0
    approved_by: Optional[str] = None
    approved_at: Optional[datetime] = None
    result: dict = _json({})
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class ProjectFile(SQLModel, table=True):
    id: str = Field(default_factory=lambda: new_id("fil"), primary_key=True)
    workspace_id: str = Field(index=True)
    project_id: str = Field(index=True)
    enquiry_id: Optional[str] = None
    name: str
    doc_kind: str = "other"  # drawing | boq | specification | tender_doc | addendum | photo | cad | correspondence | other
    source: str = "email_attachment"  # email_attachment | google_drive | wetransfer | dropbox | onedrive | link | upload | scan
    source_url: Optional[str] = None
    email_id: Optional[str] = None
    attachment_id: Optional[str] = None
    link_id: Optional[str] = None
    path: Optional[str] = None  # relative to data dir
    size: int = 0
    sha256: Optional[str] = None
    mime: str = ""
    # not_downloaded | downloading | ready | failed | expired | needs_login
    status: str = "not_downloaded"
    error: Optional[str] = None
    pages: int = 0
    summary: str = _text()
    # three separate facts: transferred (status) · extracted (extraction_status) · reviewed by a person
    extraction_status: str = "pending"  # pending | extracted | partial | failed | not_supported
    reviewed_by: Optional[str] = None
    reviewed_at: Optional[datetime] = None
    extraction: dict = _json({})
    analysis: dict = _json({})
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class Review(SQLModel, table=True):
    id: str = Field(default_factory=lambda: new_id("rev"), primary_key=True)
    workspace_id: str = Field(index=True)
    project_id: str = Field(index=True)
    quotation_id: Optional[str] = None
    checklist: list = _json([])  # [{key, label, status, note, evidence}]
    reviewer_id: Optional[str] = None
    reviewer_name: Optional[str] = None
    note: str = _text()
    decision: Optional[str] = None  # approved | changes_requested | superseded
    decided_at: Optional[datetime] = None
    revision: str = ""  # what was reviewed, e.g. "R03" or the change that reopened it
    supersedes_id: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


# --------------------------------------------------------------------------- quotations


class Signatory(SQLModel, table=True):
    id: str = Field(default_factory=lambda: new_id("sig"), primary_key=True)
    workspace_id: str = Field(index=True)
    initials: str
    full_name: str
    title: str = ""
    company: str = ""
    city: str = ""
    email: str = ""
    phone: Optional[str] = None
    is_default: bool = False
    created_at: datetime = Field(default_factory=utcnow)


class TemplateSetting(SQLModel, table=True):
    id: str = Field(primary_key=True)  # f"{workspace_id}:{key}:{language}"
    workspace_id: str = Field(index=True)
    key: str
    language: str = "en"
    enabled: bool = True
    overrides: dict = _json({})  # intro, terms, exclusions, price_unit
    applies_to: dict = _json({})
    updated_at: datetime = Field(default_factory=utcnow)


class Quotation(SQLModel, table=True):
    id: str = Field(default_factory=lambda: new_id("quo"), primary_key=True)
    workspace_id: str = Field(index=True)
    project_id: str = Field(index=True)
    enquiry_id: Optional[str] = None
    customer_id: Optional[str] = None
    reference: str = Field(default="", index=True)
    template_key: str = "supply_installation"
    template_reason: str = ""
    language: str = "en"
    signatory_id: Optional[str] = None
    # draft | needs_review | changes_requested | approved | sent | superseded
    status: str = Field(default="draft", index=True)
    version: int = 1
    data: dict = _json({})
    pdf_path: Optional[str] = None
    pdf_rendered_at: Optional[datetime] = None
    assets_status: dict = _json({})
    created_by: str = "ai"
    approved_by: Optional[str] = None
    approved_at: Optional[datetime] = None
    sent_at: Optional[datetime] = None
    sent_via: Optional[str] = None
    mail_draft_id: Optional[str] = None
    impact_review: dict = _json({})  # {"required": bool, "reason", "change", "since"} after a new revision
    change_requests: list = _json([])
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


# --------------------------------------------------------------------------- knowledge


class KnowledgeItem(SQLModel, table=True):
    id: str = Field(default_factory=lambda: new_id("kn"), primary_key=True)
    workspace_id: str = Field(index=True)
    kind: str = Field(index=True)  # service_family | work_type | term | standard | convention | identity
    key: str = Field(index=True)
    label: str
    label_ar: str = ""
    description: str = _text()
    synonyms: list = _json([])
    region: Optional[str] = None
    language: Optional[str] = None
    claim_basis: Optional[str] = None  # delivered_work | catalogue_claim | market_vocabulary | owner
    evidence: list = _json([])
    value: Any = Field(default=None, sa_column=Column(JSON))
    score: float = 0.0
    confidence: float = 0.0
    status: str = "suggested"  # suggested | owner_confirmed | rejected
    apply_to_classification: bool = False  # separate choice from confirming the finding
    original: dict = _json({})  # wording and source before an owner edited it
    source: str = "mined"  # mined | import | user
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class TemplateRule(SQLModel, table=True):
    """'For this kind of project use this template / paper / language / signatory'."""

    id: str = Field(default_factory=lambda: new_id("trl"), primary_key=True)
    workspace_id: str = Field(index=True)
    name: str = ""
    # any of: service_family, work_type, request_kind, customer_id (missing key = any)
    match: dict = _json({})
    template_key: str
    language: Optional[str] = None
    paper_id: Optional[str] = None
    signatory_id: Optional[str] = None
    priority: int = 100  # lower runs first
    enabled: bool = True
    source: str = "user"  # user | learned
    hits: int = 0
    created_by: str = ""
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class Lesson(SQLModel, table=True):
    """A correction a person made to the system's work. Lessons feed later decisions and AI prompts."""

    id: str = Field(default_factory=lambda: new_id("lsn"), primary_key=True)
    workspace_id: str = Field(index=True)
    # category_correction | template_choice | quotation_edit | review_note | change_request
    # | fact_correction | knowledge_feedback
    kind: str = Field(index=True)
    scope: str = "workspace"  # workspace | customer | sender | domain | service_family
    scope_key: str = Field(default="", index=True)
    subject: str = ""  # short human label of what was corrected
    before: Any = Field(default=None, sa_column=Column(JSON))
    after: Any = Field(default=None, sa_column=Column(JSON))
    note: str = _text()
    count: int = 1
    weight: float = 1.0
    active: bool = True
    created_by: str = ""
    created_at: datetime = Field(default_factory=utcnow)
    last_seen_at: datetime = Field(default_factory=utcnow)


# --------------------------------------------------------------------------- automations


class Automation(SQLModel, table=True):
    id: str = Field(default_factory=lambda: new_id("aut"), primary_key=True)
    workspace_id: str = Field(index=True)
    key: str
    name: str
    description: str = ""
    trigger: str = "manual"  # new_email | schedule | manual
    interval_minutes: Optional[int] = None
    steps: list = _json([])  # [{key, label, type, enabled, requires_approval, config}]
    enabled: bool = True
    last_run_at: Optional[datetime] = None
    runs_count: int = 0
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class AutomationRun(SQLModel, table=True):
    id: str = Field(default_factory=lambda: new_id("run"), primary_key=True)
    workspace_id: str = Field(index=True)
    automation_id: str = Field(index=True)
    status: str = "running"  # running | succeeded | failed | waiting_approval | cancelled
    trigger: str = "manual"
    target_type: Optional[str] = None
    target_id: Optional[str] = None
    steps: list = _json([])  # [{key, label, status, started_at, finished_at, message, details}]
    summary: str = ""
    error: Optional[str] = None
    started_at: datetime = Field(default_factory=utcnow)
    finished_at: Optional[datetime] = None
