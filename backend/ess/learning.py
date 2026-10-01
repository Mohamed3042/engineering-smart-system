"""Learning from corrections (the app's long-term memory of right and wrong).

Every time a person corrects the system — a mail category, a template choice, an edited draft, a
review note, a rejected finding — a Lesson is stored. Lessons are used three ways, silently:

1. Deterministic overrides: a sender/domain that a person re-categorised is categorised the same
   way next time, before any AI runs.
2. Preferences: a template chosen repeatedly for one kind of project becomes the default for it
   (template rules written by a person always win).
3. Prompt memory: the most relevant lessons (this customer, this service family, this task) are
   added to the AI's context so it does not repeat a corrected mistake.

No model is retrained: the memory is local, inspectable and can be switched off per lesson.
"""
from __future__ import annotations

from typing import Any, Optional

from sqlmodel import Session, col, select

from .models import Email, Lesson, Project, Quotation, TemplateRule, Workspace, utcnow

PREFERENCE_THRESHOLD = 2  # template choices before a learned preference applies


def record_lesson(session: Session, ws: Workspace, kind: str, *, scope: str = "workspace", scope_key: str = "",
                  subject: str = "", before: Any = None, after: Any = None, note: str = "", by: str = "") -> Lesson:
    """Store a correction; an identical correction (same kind, scope and outcome) is counted, not duplicated."""
    existing = session.exec(select(Lesson).where(Lesson.workspace_id == ws.id, Lesson.kind == kind,
                                                 Lesson.scope == scope, Lesson.scope_key == scope_key)).all()
    for lesson in existing:
        if lesson.after == after and (lesson.before == before or kind in ("category_correction", "template_choice")):
            lesson.count += 1
            lesson.last_seen_at = utcnow()
            if note:
                lesson.note = note
            session.add(lesson)
            return lesson
    lesson = Lesson(workspace_id=ws.id, kind=kind, scope=scope, scope_key=scope_key, subject=subject[:300],
                    before=before, after=after, note=note[:2000], created_by=by)
    session.add(lesson)
    return lesson


# --------------------------------------------------------------------------- 1. category overrides


def learned_category(session: Session, ws: Workspace, email: Email) -> Optional[dict]:
    """A person's earlier correction for this sender (or its domain) decides the category."""
    sender = (email.from_email or "").lower()
    domain = sender.split("@")[-1] if "@" in sender else ""
    for scope, key in (("sender", sender), ("domain", domain)):
        if not key or (scope == "domain" and domain in (ws.own_domains or [])):
            continue
        lessons = session.exec(select(Lesson).where(Lesson.workspace_id == ws.id, Lesson.active == True,  # noqa: E712
                                                    Lesson.kind == "category_correction", Lesson.scope == scope,
                                                    Lesson.scope_key == key)
                               .order_by(col(Lesson.last_seen_at).desc())).all()
        if lessons:
            best = max(lessons, key=lambda l: (l.count, l.last_seen_at))
            return {"category": best.after, "confidence": 0.97, "priority": None,
                    "reason": f"Learned: {best.created_by or 'a person'} filed mail from this {scope} as "
                              f"'{best.after}' ({best.count}×)",
                    "evidence": [{"quote": email.subject, "source": "subject"}]}
    return None


def on_category_corrected(session: Session, ws: Workspace, email: Email, old: str, new: str, by: str) -> None:
    sender = (email.from_email or "").lower()
    record_lesson(session, ws, "category_correction", scope="sender", scope_key=sender, subject=email.subject,
                  before=old, after=new, by=by)
    domain = sender.split("@")[-1] if "@" in sender else ""
    if domain and domain not in (ws.own_domains or []) and new in ("promotions", "notifications", "bills", "vendor_offer"):
        # noise usually comes from a whole domain; work categories stay per sender
        record_lesson(session, ws, "category_correction", scope="domain", scope_key=domain, subject=email.subject,
                      before=old, after=new, by=by)


# --------------------------------------------------------------------------- 2. template rules & preferences


def _matches(rule: TemplateRule, project: Project, customer_id: Optional[str]) -> bool:
    m = rule.match or {}
    checks = {"service_family": project.service_family, "work_type": project.work_type,
              "request_kind": project.request_kind, "customer_id": customer_id}
    return all(not m.get(k) or m.get(k) == v or (isinstance(m.get(k), list) and v in m[k]) for k, v in checks.items())


def resolve_template(session: Session, ws: Workspace, project: Project, customer_id: Optional[str]) -> Optional[dict]:
    """Template rule written by a person first, then a learned preference. None → template defaults."""
    rules = session.exec(select(TemplateRule).where(TemplateRule.workspace_id == ws.id, TemplateRule.enabled == True)  # noqa: E712
                         .order_by(TemplateRule.priority, col(TemplateRule.updated_at).desc())).all()
    specificity = lambda r: -sum(1 for v in (r.match or {}).values() if v)  # noqa: E731
    for rule in sorted(rules, key=lambda r: (r.priority, specificity(r))):
        if _matches(rule, project, customer_id):
            rule.hits += 1
            session.add(rule)
            return {"template_key": rule.template_key, "language": rule.language, "paper_id": rule.paper_id,
                    "signatory_id": rule.signatory_id, "reason": f"Rule '{rule.name or rule.template_key}'"}
    key = f"{project.service_family}|{project.work_type}"
    prefs = session.exec(select(Lesson).where(Lesson.workspace_id == ws.id, Lesson.active == True,  # noqa: E712
                                              Lesson.kind == "template_choice", Lesson.scope == "service_family",
                                              Lesson.scope_key == key)).all()
    best = max(prefs, key=lambda l: l.count, default=None)
    if best is not None and best.count >= PREFERENCE_THRESHOLD and isinstance(best.after, dict):
        return {**best.after, "reason": f"Learned: chosen {best.count}× for {project.service_family} / {project.work_type}"}
    return None


def on_template_changed(session: Session, ws: Workspace, q: Quotation, project: Project, choice: dict, by: str) -> None:
    record_lesson(session, ws, "template_choice", scope="service_family",
                  scope_key=f"{project.service_family}|{project.work_type}", subject=project.name,
                  before={"template_key": q.template_key, "language": q.language},
                  after={k: v for k, v in choice.items() if v is not None}, by=by)


# --------------------------------------------------------------------------- 3. edits, reviews, facts


def _item_texts(data: dict) -> list[str]:
    return [str(i.get("description") or "").strip() for i in data.get("items") or [] if i.get("description")]


def on_quotation_edited(session: Session, ws: Workspace, q: Quotation, project: Project, before: dict, after: dict,
                        by: str) -> None:
    """Remember what people change in AI drafts (removed/added lines, exclusions, subject wording)."""
    if q.created_by not in ("ai", "mcp", "rules"):
        return
    old_items, new_items = set(_item_texts(before)), set(_item_texts(after))
    diff = {
        "removed_items": sorted(old_items - new_items)[:10],
        "added_items": sorted(new_items - old_items)[:10],
        "subject": [before.get("subject"), after.get("subject")] if before.get("subject") != after.get("subject") else None,
        "added_exclusions": sorted(set(after.get("exclusions") or []) - set(before.get("exclusions") or []))[:10],
        "removed_exclusions": sorted(set(before.get("exclusions") or []) - set(after.get("exclusions") or []))[:10],
    }
    diff = {k: v for k, v in diff.items() if v}
    if not diff:
        return
    record_lesson(session, ws, "quotation_edit", scope="service_family", scope_key=project.service_family,
                  subject=f"{q.reference} · {project.name}", before=None, after=diff, by=by)


def on_review_note(session: Session, ws: Workspace, project: Project, note: str, by: str, kind: str = "review_note") -> None:
    record_lesson(session, ws, kind, scope="service_family", scope_key=project.service_family,
                  subject=project.name, after=None, note=note, by=by)
    if project.customer_id:
        record_lesson(session, ws, kind, scope="customer", scope_key=project.customer_id, subject=project.name,
                      after=None, note=note, by=by)


def on_fact_corrected(session: Session, ws: Workspace, project: Project, field: str, before: Any, after: Any, by: str) -> None:
    record_lesson(session, ws, "fact_correction", scope="service_family", scope_key=project.service_family,
                  subject=f"{project.name}: {field}", before=before, after=after, by=by)


def on_knowledge_feedback(session: Session, ws: Workspace, kind: str, label: str, status: str, by: str) -> None:
    record_lesson(session, ws, "knowledge_feedback", scope="workspace", scope_key=kind, subject=label,
                  after=status, by=by)


# --------------------------------------------------------------------------- prompt memory


def memory_context(session: Session, ws: Workspace, *, task: str, customer_id: Optional[str] = None,
                   service_family: Optional[str] = None, limit: int = 15) -> list[str]:
    """Short lessons for an AI prompt, most specific and most repeated first."""
    kinds = {
        "classify_email": ("category_correction",),
        "extract_request": ("fact_correction", "review_note", "change_request"),
        "draft_quotation": ("quotation_edit", "change_request", "review_note", "template_choice"),
        "discover_business": ("knowledge_feedback",),
        "research_customer": ("review_note",),
    }.get(task, ())
    if not kinds:
        return []
    rows = session.exec(select(Lesson).where(Lesson.workspace_id == ws.id, Lesson.active == True,  # noqa: E712
                                             col(Lesson.kind).in_(kinds))).all()

    def rank(l: Lesson) -> tuple:
        specific = (l.scope == "customer" and l.scope_key == customer_id) or (
            l.scope == "service_family" and l.scope_key.split("|")[0] == service_family)
        return (not specific, -l.count, -(l.last_seen_at.timestamp() if l.last_seen_at else 0))

    out = []
    for l in sorted(rows, key=rank)[:limit]:
        if l.kind == "category_correction":
            out.append(f"Mail from {l.scope_key} is '{l.after}', not '{l.before}' (corrected {l.count}×).")
        elif l.kind == "quotation_edit":
            out.append(f"In {l.scope_key} drafts people changed: {l.after} ({l.count}×).")
        elif l.kind == "template_choice":
            out.append(f"For {l.scope_key.replace('|', ' / ')} people use template {l.after} ({l.count}×).")
        elif l.kind == "fact_correction":
            out.append(f"Correction on {l.subject}: '{l.before}' → '{l.after}'.")
        elif l.kind == "knowledge_feedback":
            out.append(f"Business finding '{l.subject}' was {l.after} by the owner.")
        elif l.note:
            out.append(f"Engineer note ({l.subject}): {l.note[:300]}")
    return out


def summary(session: Session, ws: Workspace) -> dict:
    rows = session.exec(select(Lesson).where(Lesson.workspace_id == ws.id)).all()
    by_kind: dict[str, int] = {}
    for l in rows:
        by_kind[l.kind] = by_kind.get(l.kind, 0) + 1
    return {"total": len(rows), "active": sum(1 for l in rows if l.active), "by_kind": by_kind,
            "rules": len(session.exec(select(TemplateRule).where(TemplateRule.workspace_id == ws.id)).all())}
