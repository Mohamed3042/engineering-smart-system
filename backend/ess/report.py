"""Self-contained HTML report of a workspace's projects (for reading or sharing outside the app).

  python -m ess.report out.html [--families bmu,wce] [--title "…"]
"""
from __future__ import annotations

import argparse
import html
from collections import Counter
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Iterable, Optional

from sqlmodel import col, select

from .db import init_db, session_scope
from .models import Category, Customer, Email, Enquiry, Project, ProjectFile, ProjectLink, Quotation
from .pipeline.state import STAGE_LABELS
from .workspace import get_active_workspace

FAMILY_LABELS = {"bmu": "Building Maintenance Units", "wce": "Window Cleaning Equipment", "cradle": "Cradles",
                 "hoist": "Construction hoists", "crane": "Cranes", "access_rental": "Access rental",
                 "scaffolding": "Scaffolding", "space_frame": "Space frames", "other_work": "Other work"}

CSS = """
:root{--bg:#f6f7f7;--card:#fff;--ink:#14201f;--muted:#5b6b69;--line:#e3e8e7;--teal:#0f5f5c;--teal-bg:#e6f2f1;
--amber:#9a5b00;--amber-bg:#fff4e0;--red:#a3261b;--red-bg:#fdeceb;--ok:#1d6b3a;--ok-bg:#e8f5ec}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0f1514;--card:#162020;--ink:#e8efee;--muted:#9fb0ae;
--line:#26302f;--teal:#5cc2bb;--teal-bg:#123130;--amber:#f2b55c;--amber-bg:#3a2a10;--red:#ff8a80;--red-bg:#3a1715;--ok:#7fd49c;--ok-bg:#12301f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif}
main{max-width:1080px;margin:0 auto;padding:28px 16px 64px}h1{font-size:28px;margin:0 0 4px}h2{font-size:20px;margin:36px 0 12px}
h3{font-size:17px;margin:0}.muted{color:var(--muted)}.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:20px 0}
.tile{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}.tile b{display:block;font-size:26px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin:14px 0}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:space-between}
.pill{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12.5px;font-weight:600;background:var(--teal-bg);color:var(--teal)}
.pill.amber{background:var(--amber-bg);color:var(--amber)}.pill.red{background:var(--red-bg);color:var(--red)}.pill.ok{background:var(--ok-bg);color:var(--ok)}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:12px}@media(max-width:760px){.grid{grid-template-columns:1fr}}
.label{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:10px 0 4px}
ul{margin:4px 0;padding-left:18px}li{margin:3px 0}blockquote{margin:4px 0 0;padding:6px 10px;border-left:3px solid var(--line);color:var(--muted);font-size:13.5px}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
.next{margin-top:10px;padding:10px 12px;border-radius:10px;background:var(--teal-bg);color:var(--teal);font-weight:600}
details.card{padding:0}details.card>summary{list-style:none;cursor:pointer;padding:16px 18px;border-radius:14px}
details.card>summary::-webkit-details-marker{display:none}details.card>summary:hover{background:var(--teal-bg)}
details.card[open]>summary{border-bottom:1px solid var(--line);border-radius:14px 14px 0 0}
.body{padding:4px 18px 18px}.who{margin-top:4px;font-size:13.5px;color:var(--muted)}.who b{color:var(--ink);font-weight:600}
.chev{display:inline-block;transition:transform .15s;color:var(--muted);margin-right:6px}details[open] .chev{transform:rotate(90deg)}
.tools{margin:8px 0 0;font-size:13px}.tools button{border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:8px;padding:4px 10px;cursor:pointer}
nav a{color:var(--teal);margin-right:14px;text-decoration:none;font-weight:600}
"""


def e(v) -> str:
    return html.escape("" if v is None else str(v))


def fmt_date(v) -> str:
    if not v:
        return "—"
    if isinstance(v, str):
        try:
            v = date.fromisoformat(v[:10])
        except ValueError:
            return e(v)
    return v.strftime("%d %b %Y")


def quote_html(ev: Optional[dict]) -> str:
    if not isinstance(ev, dict) or not ev.get("quote"):
        return ""
    mark = "✓ verified" if ev.get("verified") else ("✗ not found in source" if ev.get("verified") is False else "")
    return f'<blockquote>“{e(ev["quote"])}” <span class="muted">— {e(ev.get("source_label") or ev.get("source_type"))} {e(mark)}</span></blockquote>'


def project_card(p: Project, customers: dict, enquiries: list[Enquiry], files: list[ProjectFile],
                 links: list[ProjectLink], quotes: list[Quotation]) -> str:
    stage = STAGE_LABELS.get(p.stage, p.stage)
    open_changes = [c for c in p.changes or [] if not c.get("acknowledged")]
    companies = [customers[q.customer_id].name for q in enquiries if q.customer_id in customers]
    due = min((q.due_date for q in enquiries if q.due_date), default=p.due_date)
    parts = [f'<details class="card" id="{e(p.id)}"><summary><div class="row"><div><h3><span class="chev">▸</span>{e(p.name)}</h3>'
             f'<div class="who">{" · ".join("<b>" + e(c) + "</b>" for c in companies) or "—"}'
             f'{" · closes " + fmt_date(due) if due else ""}</div></div>'
             f'<div><span class="pill">{e(stage)}</span> '
             + (f'<span class="pill amber">{len(open_changes)} change(s)</span> ' if open_changes else "")
             + (f'<span class="pill red">{len(p.blockers or [])} blocker(s)</span>' if p.blockers else "")
             + f'</div></div></summary><div class="body"><div class="muted">{e(FAMILY_LABELS.get(p.service_family, p.service_family))}'
             f' · {e(p.work_type.replace("_", " "))}{" · Tender " + e(p.tender_no) if p.tender_no else ""}'
             f'{" · " + e(p.location) if p.location else ""}</div>']
    if p.summary:
        parts.append(f"<p>{e(p.summary)}</p>")
    rows = []
    for enq in enquiries:
        c = customers.get(enq.customer_id or "")
        current = enq.due_date.isoformat() if enq.due_date else None
        hist = " ← ".join(fmt_date(h.get("value")) for h in reversed(enq.due_date_history or [])
                          if h.get("value") and str(h.get("value"))[:10] != current)
        resp = (enq.our_response or {}).get("status") or "none"
        rows.append(f"<tr><td><b>{e(c.name if c else '—')}</b><br><span class='muted'>{e((enq.contact or {}).get('name'))} "
                    f"{e((enq.contact or {}).get('email'))}</span></td><td>{fmt_date(enq.due_date)}"
                    f"{('<br><span class=muted>was ' + hist + '</span>') if hist else ''}</td>"
                    f"<td>{e(enq.status)}</td><td>{e(resp)}</td></tr>")
    if rows:
        parts.append('<div class="label">Enquiries (one quotation each)</div><table><tr><th>Company</th><th>Closing date</th>'
                     '<th>Status</th><th>Our reply</th></tr>' + "".join(rows) + "</table>")
    left, right = [], []
    if open_changes or p.changes:
        items = "".join(f"<li><b>{e(c.get('title'))}</b> {e(c.get('old_value') or '')}{' → ' if c.get('old_value') else ''}"
                        f"{e(c.get('new_value') or '')} <span class='muted'>({fmt_date(c.get('date'))})</span>{quote_html(c.get('evidence'))}</li>"
                        for c in p.changes or [])
        left.append(f'<div class="label">Changes</div><ul>{items}</ul>')
    if p.scope_items:
        items = "".join(f"<li>{e(s.get('description'))}{(' — ' + e(s.get('qty')) + ' ' + e(s.get('unit') or '')) if s.get('qty') else ''}"
                        f"{quote_html(s.get('evidence'))}</li>" for s in p.scope_items)
        left.append(f'<div class="label">Scope asked</div><ul>{items}</ul>')
    if p.requirements:
        items = "".join(f"<li><b>{e(r.get('label'))}:</b> {e(r.get('value'))}{quote_html(r.get('evidence'))}</li>" for r in p.requirements)
        left.append(f'<div class="label">Requirements</div><ul>{items}</ul>')
    if p.blockers:
        right.append('<div class="label">Blockers</div><ul>' + "".join(f"<li>{e(b.get('text'))}</li>" for b in p.blockers) + "</ul>")
    if p.unresolved_questions:
        right.append('<div class="label">Open questions</div><ul>' + "".join(f"<li>{e(q)}</li>" for q in p.unresolved_questions) + "</ul>")
    if links:
        right.append('<div class="label">Shared links</div><ul>' + "".join(
            f"<li>{e(l.kind.replace('_', ' '))} — <span class='pill {'ok' if l.status == 'downloaded' else 'amber'}'>{e(l.status)}</span>"
            f"<br><span class='muted'>{e(l.url[:90])}</span></li>" for l in links) + "</ul>")
    if files:
        right.append('<div class="label">Documents</div><ul>' + "".join(
            f"<li>{e(f.name)} <span class='muted'>({e(f.doc_kind)}, {e(f.status.replace('_', ' '))})</span></li>" for f in files) + "</ul>")
    if quotes:
        right.append('<div class="label">Quotations</div><ul>' + "".join(
            f"<li>{e(q.reference)} — {e(q.status)} ({e(q.template_key)})</li>" for q in quotes) + "</ul>")
    parts.append(f'<div class="grid"><div>{"".join(left)}</div><div>{"".join(right)}</div></div>')
    if p.next_action:
        parts.append(f'<div class="next">Next: {e(p.next_action.get("label"))}</div>')
    parts.append("</div></details>")
    return "".join(parts)


def build_report(families: Optional[Iterable[str]] = None, title: Optional[str] = None) -> str:
    with session_scope() as s:
        ws = get_active_workspace(s)
        q = select(Project).where(Project.workspace_id == ws.id, Project.archived_at == None)  # noqa: E711
        projects = s.exec(q).all()
        fam = list(families) if families else None
        customers = {c.id: c for c in s.exec(select(Customer).where(Customer.workspace_id == ws.id)).all()}
        emails = s.exec(select(Email).where(Email.workspace_id == ws.id)).all()
        cats = {c.key: c for c in s.exec(select(Category).where(Category.workspace_id == ws.id)).all()}
        by_cat = Counter(em.category for em in emails)
        groups: dict[str, list[str]] = {}
        for p in sorted(projects, key=lambda x: (x.due_date or date.max, x.name)):
            enqs = s.exec(select(Enquiry).where(Enquiry.project_id == p.id).order_by(col(Enquiry.received_at))).all()
            files = s.exec(select(ProjectFile).where(ProjectFile.project_id == p.id)).all()
            links = s.exec(select(ProjectLink).where(ProjectLink.project_id == p.id)).all()
            quotes = s.exec(select(Quotation).where(Quotation.project_id == p.id)).all()
            key = p.service_family if not fam or p.service_family in fam else "related"
            groups.setdefault(key, []).append(project_card(p, customers, list(enqs), list(files), list(links), list(quotes)))
        n_enq = len(s.exec(select(Enquiry).where(Enquiry.workspace_id == ws.id)).all())
        changes = sum(1 for p in projects for c in p.changes or [] if not c.get("acknowledged"))
        blockers = sum(len(p.blockers or []) for p in projects)
        order = (fam or []) + [k for k in groups if k not in (fam or [])]
        title = title or f"{ws.name} — project brief"
        tiles = "".join(f'<div class="tile"><b>{len(groups.get(k, []))}</b>{e(FAMILY_LABELS.get(k, "Related access work" if k == "related" else k))}</div>'
                        for k in order if groups.get(k))
        tiles += f'<div class="tile"><b>{n_enq}</b>Enquiries</div><div class="tile"><b>{changes}</b>Changes to review</div>' \
                 f'<div class="tile"><b>{blockers}</b>Blockers</div>'
        inbox = "".join(f"<tr><td>{e(cats[k].label if k in cats else k)}</td><td>{n}</td></tr>"
                        for k, n in by_cat.most_common())
        nav = "".join(f'<a href="#g-{k}">{e(FAMILY_LABELS.get(k, "Related"))}</a>' for k in order if groups.get(k))
        sections = "".join(f'<h2 id="g-{k}">{e(FAMILY_LABELS.get(k, "Related access work" if k == "related" else k))}</h2>'
                           + "".join(groups[k]) for k in order if groups.get(k))
        generated = datetime.now(timezone.utc).strftime("%d %b %Y %H:%M UTC")
        return (f"<!doctype html><html lang='en'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>"
                f"<title>{e(title)}</title><style>{CSS}</style></head><body><main><h1>{e(title)}</h1>"
                f"<div class='muted'>{e(ws.company_name)} · {e(ws.primary_email)} · generated {generated}</div>"
                f"<div class='tiles'>{tiles}</div><nav>{nav}</nav><div class='tools'><button onclick=\"document.querySelectorAll('details').forEach(d=>d.open=true)\">Open all</button> "
                f"<button onclick=\"document.querySelectorAll('details').forEach(d=>d.open=false)\">Close all</button></div>{sections}"
                f"<h2>Mailbox sorting</h2><div class='card'><table><tr><th>Category</th><th>Messages</th></tr>{inbox}</table></div>"
                f"<p class='muted'>Facts show the exact sentence they came from. ✓ means the sentence was found again in the stored e-mail or file. "
                f"Prices are never filled automatically.</p></main></body></html>")


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(prog="python -m ess.report")
    ap.add_argument("out")
    ap.add_argument("--families", default="")
    ap.add_argument("--title")
    a = ap.parse_args(argv)
    init_db()
    Path(a.out).write_text(build_report([f for f in a.families.split(",") if f] or None, a.title))
    print(f"written {a.out}")


if __name__ == "__main__":
    main()
