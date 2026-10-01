# Workspace snapshot format (`ess-workspace-snapshot/1`)

A snapshot moves a scanned mailbox into the app: **Settings → Workspace → Import**, or
`python -m ess.seed path/to/snapshot.json`. Scanners (the built-in scanner, an AI client
connected over MCP, or an offline analysis) all write this one shape. Import is idempotent:
records are matched by `id` / `ref` and updated.

Rules that every writer must follow:

* **Evidence or nothing.** Every extracted fact carries `evidence.quote`, copied *verbatim* from
  the source (email body, file text). The importer re-checks each quote against the stored source
  text and marks the fact `verified: false` when the quote is not found.
* **No invented prices.** Prices never come from AI. `unit_price` / `total` stay `null` until an
  engineer fills them.
* Dates are ISO-8601 (`2026-09-21T08:48:41Z` or `2026-09-21`). Unknown values are `null`, never `""`.

```jsonc
{
  "format": "ess-workspace-snapshot/1",
  "generated_at": "2026-10-01T14:00:00Z",
  "generator": "scan-agent",                      // who produced it
  "workspace": {
    "name": "Medmack",                            // short display name
    "company_name": "Medmac Kuwait Co. General Trading and Contracting",
    "primary_email": "sales@medmack.com",
    "region": "Kuwait / GCC",
    "country": "KW",
    "languages": ["en", "ar"],
    "currency": "KWD",
    "timezone": "Asia/Kuwait"
  },
  "scan": {
    "date_from": "2026-08-01", "date_to": "2026-10-01",
    "queries": ["after:2026/08/01 (BMU OR gondola ...)"],
    "threads_scanned": 41, "threads_matched": 18,
    "notes": "free text: limits, what could not be read and why"
  },
  "emails": [{
    "id": "18f0c0ffee000001",                     // provider message id
    "thread_id": "18f0c0ffee000001",
    "direction": "inbound",                       // inbound | outbound
    "from_name": "A. Engineer", "from_email": "a.engineer@example.com",
    "to": ["sales@medmack.com"], "cc": [],
    "subject": "RFQ: ...", "date": "2026-08-26T08:20:26Z",
    "snippet": "first 200 chars", "body_text": "full plain-text body (quoted history may be trimmed)",
    "labels": ["INBOX", "IMPORTANT"],
    "attachments": [{"attachment_id": null, "filename": "BOQ.pdf", "mime": "application/pdf", "size": 123456}],
    "links": [{"url": "https://drive.google.com/drive/folders/...", "kind": "google_drive_folder"}],
    "list_unsubscribe": null,
    "view_url": "https://mail.google.com/mail/?authuser=...#all/thread-f:...",
    "category": "bmu",                            // key from `categories` (see below)
    "category_confidence": 0.95,                  // 0..1
    "category_reason": "Subject and body ask for 'BMU work' quotation",
    "category_evidence": [{"quote": "quotation for BMU work", "source": "body"}],
    "priority": "high",                           // high | normal | low
    "state": "needs_review",                      // new | needs_review | linked | update | archived
    "project_ref": "P-HARBOUR-TOWER",           // null when not project mail
    "customer_ref": "contractor.example"
  }],
  "customers": [{
    "ref": "contractor.example",                           // usually the email domain
    "name": "Example Contracting Co.", "domain": "contractor.example",
    "kind": "main_contractor",                    // main_contractor | subcontractor | consultant | developer | government | facility_management | supplier | other
    "country": "KW", "city": "Kuwait City",
    "tags": ["Main contractor", "High-rise towers", "Tender participant"],
    "contacts": [{"name": "A. Engineer", "email": "a.engineer@contractor.example", "phone": null, "title": "Estimation Engineer"}],
    "notes": "how we know them, with dates"
  }],
  "projects": [{
    // One project = one building / tender. Several contractors bidding the same tender each
    // send us their own enquiry; each enquiry gets its own quotation addressed to that contractor.
    "ref": "P-HARBOUR-TOWER",
    "name": "Harbour Tower, Plot 12",
    "service_family": "bmu",                      // WHAT we sell: bmu | wce | cradle | hoist | crane | access_rental | scaffolding | space_frame | other_work
    "work_type": "supply_installation",           // WHY they ask: supply_installation | annual_maintenance | equipment_rental | service_repair | inspection_certification
    "request_kind": "tender_rfq",                 // tender_rfq | direct_rfq | o_and_m | info_request | revision
    "customer_ref": "contractor.example",                  // first / main enquirer
    "enquiries": [{
      "ref": "E-EXAMPLE-HARBOUR",
      "customer_ref": "contractor.example",
      "contact": {"name": "A. Engineer", "email": "a.engineer@contractor.example"},
      "email_ids": ["..."], "thread_ids": ["..."],
      "received_at": "2026-08-26T08:20:26Z",
      "due_date": "2026-09-10",
      "due_date_history": [{"value": "2026-09-06", "changed_at": "2026-08-31", "evidence": {"quote": "...", "source_type": "email", "source_id": "..."}}],
      "status": "open",                           // open | quoted | declined | lost | won | closed
      "our_response": {"status": "none", "date": null, "detail": null}   // none | forwarded | quoted | declined
    }],
    "stage": "received",                          // received | files_ready | analysis | engineer_review | quotation | approved | sent | archived
    "status_note": "Waiting for tender documents from link",
    "priority": "high",
    "due_date": "2026-09-10",                     // earliest open enquiry closing date
    "tender_no": null, "location": "Kuwait City",
    "owner_client": null, "consultant": null, "main_contractor": null,
    "summary": "2-4 sentence plain summary of what they ask",
    "changes": [{"kind": "deadline_changed",      // deadline_changed | addendum | technical_revision | scope_change | reminder
                 "title": "Closing date extended", "old_value": "2026-09-13", "new_value": "2026-10-18",
                 "date": "2026-09-21T05:38:07Z", "evidence": {"quote": "...", "source_type": "email", "source_id": "..."}}],
    "blockers": [{"kind": "missing_files", "text": "Tender drawings only on WeTransfer link (expired)", "evidence": null}],
                                                  // missing_files | expired_link | missing_drawing | unclear_scope | needs_site_visit | question
    "next_action": {"kind": "review_change", "label": "Review amendment"},
    "scope_items": [{"description": "Roof-mounted BMU ...", "qty": null, "unit": "lot",
                      "evidence": {"quote": "...", "source_type": "email", "source_id": "18f0...", "source_label": "RFQ email 26 Aug"}}],
    "requirements": [{"field": "building_height", "label": "Building height", "value": "120 m",
                      "evidence": {"quote": "...", "source_type": "email|file", "source_id": "...", "source_label": "...", "page": null}}],
    "unresolved_questions": ["Roof load capacity not stated"],
    "links": [{"url": "...", "kind": "wetransfer", "email_id": "...", "status": "found",
               "note": "expires 7 days after 26 Aug"}],
    "attachments": [{"email_id": "...", "filename": "...", "mime": "...", "size": 0, "doc_kind": "boq|drawing|specification|tender_doc|addendum|photo|other"}],
    "files": [{"name": "BOQ.pdf", "path": "files/P-HARBOUR-TOWER/BOQ.pdf", "source": "google_drive", "source_url": "...",
               "sha256": "...", "size": 0, "mime": "application/pdf", "doc_kind": "boq", "summary": "what the file says, with page refs"}],
    "thread_ids": ["..."], "email_ids": ["..."],
    "timeline": [{"date": "2026-08-26T08:20:26Z", "title": "RFQ received", "detail": "..."}],
    "our_response": {"status": "none", "date": null, "detail": null}, // none | forwarded | quoted | declined
    "recommended_template": "tenders",            // tenders | supply_installation | annual_maintenance | equipment_rental | service_repair
    "related_project_refs": []
  }],
  "knowledge": [],                                 // optional, see docs/architecture.md (KnowledgeItem)
  "activity": [{"date": "...", "kind": "email_received", "title": "...", "project_ref": "..."}]
}
```

## Categories

Work types come from the workspace's business identity. For Medmack the starting set is:

| key | label | group |
|---|---|---|
| `bmu` | Building Maintenance Units | work |
| `wce` | Window Cleaning Equipment (monorails, davits, façade cleaning systems, cradles for cleaning) | work |
| `cradle` | Suspended platforms / temporary cradles | work |
| `hoist` | Construction hoists & personnel lifts | work |
| `crane` | Cranes & lifting | work |
| `access_rental` | Man-lifts, scissor lifts, boom rental | work |
| `scaffolding` | Scaffolding | work |
| `space_frame` | Space frames & shades | work |
| `other_work` | Other work requests | work |
| `vendor_offer` | Supplier & OEM offers | other |
| `bills` | Bills, invoices, payments | bills |
| `promotions` | Newsletters, ads, marketplaces | promotions |
| `internal` | Internal / colleagues | other |
| `notifications` | System notifications | other |
| `other` | Everything else | other |
