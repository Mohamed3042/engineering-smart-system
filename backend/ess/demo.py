"""Neutral sample workspace (invented companies only) so a fresh install has something to show."""
from __future__ import annotations

DEMO_WORKSPACE = {
    "name": "Sample workspace",
    "company_name": "Sample Access Systems Co.",
    "primary_email": "sales@sample-access.example",
    "region": "Gulf / Middle East",
    "country": "KW",
    "languages": ["en", "ar"],
    "currency": "KWD",
    "timezone": "Asia/Kuwait",
}


def _email(id_, thread, sender, name, subject, date, body, category, project_ref=None, customer_ref=None,
           priority="high", direction="inbound", links=None, attachments=None, unsub=None):
    return {"id": id_, "thread_id": thread, "direction": direction, "from_name": name, "from_email": sender,
            "to": ["sales@sample-access.example"], "cc": [], "subject": subject, "date": date,
            "snippet": body[:180], "body_text": body, "labels": ["INBOX"], "attachments": attachments or [],
            "links": links or [], "list_unsubscribe": unsub, "category": category, "category_confidence": 0.9,
            "category_reason": "sample", "priority": priority, "state": "new", "project_ref": project_ref,
            "customer_ref": customer_ref}


MARINA_RFQ = (
    "Dear Sales Team,\n\nWe are seeking a proposal for a Building Maintenance Unit (BMU) for Marina Tower A at "
    "North Quay Development. The tower is 120 m high with a unitised glazing façade. The roof parapet height is 1.1 m. "
    "Please include budget pricing and lead times, and an option for a 24-month maintenance package.\n"
    "Tender closing date: 30/10/2026.\nDrawings: https://drive.google.com/drive/folders/1SAMPLEfolderId\n\n"
    "Kind regards,\nSarah Mitchell\nProject Manager, North Quay Development"
)
MARINA_EXT = (
    "Dear Sir,\n\nPlease be informed that the above tender closing date has been extended to 12/11/2026.\n\n"
    "Best regards,\nSarah Mitchell"
)
CRESCENT_RFQ = (
    "Dear Sir,\n\nKindly submit your quotation for the window cleaning system works (monorail with cradle and davit "
    "arms) for Crescent School. The façade is 18 m high. Closing date: 08/10/2026.\n"
    "Tender documents: https://we.tl/t-SAMPLE123\n\nRegards,\nDavid Chen\nEstimation Engineer, Harbor Facilities"
)
CRESCENT_EXT = (
    "Dear Sir,\n\nPlease note the closing date has been extended to 22/10/2026 as per Addendum No. 2.\n\n"
    "Regards,\nDavid Chen"
)
EAST_QUAY = (
    "Dear Eng.,\n\nWith reference to your proposal, we are proceeding with two (2) construction hoists for East Quay "
    "Plant. Revision R03: the mast height changed from 20 m to 24 m. There is no reliance on the adjacent wall.\n"
    "Please send the technical proposal by 15/10/2026.\n\nBest regards,\nOlivia Bennett, Coastal Build"
)
HARBOR_AMC = (
    "Hello,\n\nWe request a maintenance quote for the BMU at Harbor Offices: 24 months plus an optional 12 months. "
    "Monthly inspections and the annual load test are required.\n\nThanks,\nLiam O'Connor, Harbor Facilities"
)

DEMO_SNAPSHOT = {
    "format": "ess-workspace-snapshot/1",
    "generator": "demo",
    "workspace": DEMO_WORKSPACE,
    "emails": [
        _email("demo-m1", "demo-t1", "sarah.mitchell@nqd.example", "Sarah Mitchell", "BMU proposal request — Marina Tower A",
               "2026-09-24T09:12:00Z", MARINA_RFQ, "bmu", "P-DEMO-MARINA", "nqd.example",
               links=[{"url": "https://drive.google.com/drive/folders/1SAMPLEfolderId", "kind": "google_drive_folder"}],
               attachments=[{"filename": "Marina-Tower-A-roof-plan.pdf", "mime": "application/pdf", "size": 4200000}]),
        _email("demo-m2", "demo-t1", "sarah.mitchell@nqd.example", "Sarah Mitchell", "RE: BMU proposal request — Marina Tower A",
               "2026-09-29T08:00:00Z", MARINA_EXT, "bmu", "P-DEMO-MARINA", "nqd.example"),
        _email("demo-c1", "demo-t2", "david.chen@harborfacilities.example", "David Chen", "RFQ: Window cleaning system — Crescent School",
               "2026-09-20T10:30:00Z", CRESCENT_RFQ, "wce", "P-DEMO-CRESCENT", "harborfacilities.example",
               links=[{"url": "https://we.tl/t-SAMPLE123", "kind": "wetransfer"}]),
        _email("demo-c2", "demo-t2", "david.chen@harborfacilities.example", "David Chen", "RE: RFQ: Window cleaning system — Crescent School",
               "2026-09-28T07:45:00Z", CRESCENT_EXT, "wce", "P-DEMO-CRESCENT", "harborfacilities.example"),
        _email("demo-e1", "demo-t3", "olivia.bennett@coastalbuild.example", "Olivia Bennett", "Technical proposal — two construction hoists (R03)",
               "2026-09-29T11:00:00Z", EAST_QUAY, "hoist", "P-DEMO-EASTQUAY", "coastalbuild.example",
               attachments=[{"filename": "Hoist-requirements-R03.pdf", "mime": "application/pdf", "size": 900000},
                            {"filename": "Hoist-layout-R03.pdf", "mime": "application/pdf", "size": 1200000}]),
        _email("demo-h1", "demo-t4", "liam.oconnor@harborfacilities.example", "Liam O'Connor", "BMU maintenance quote — Harbor Offices",
               "2026-09-26T13:15:00Z", HARBOR_AMC, "bmu", "P-DEMO-HARBOR", "harborfacilities.example"),
        _email("demo-p1", "demo-t5", "news@equipment-market.example", "Equipment Market", "Weekly auction listings",
               "2026-09-27T02:00:00Z", "This week's auctions: boom lifts, scissor lifts and more. Unsubscribe any time.",
               "promotions", priority="low", unsub="<https://equipment-market.example/unsub?u=1>"),
        _email("demo-b1", "demo-t6", "billing@telco.example", "Telco Billing", "Your invoice for September",
               "2026-09-25T06:00:00Z", "Your invoice INV-2209 is ready. Amount due by 10 October.", "bills", priority="normal"),
        _email("demo-v1", "demo-t7", "partners@hoist-oem.example", "Hoist OEM", "Additional construction-hoist OEM source",
               "2026-09-30T07:19:00Z", "We are a manufacturer of construction hoists and would like to become your supplier.",
               "vendor_offer", priority="low"),
    ],
    "customers": [
        {"ref": "nqd.example", "name": "North Quay Development", "domain": "nqd.example", "kind": "developer",
         "tags": ["Developer", "High-rise towers"],
         "contacts": [{"name": "Sarah Mitchell", "email": "sarah.mitchell@nqd.example", "title": "Project Manager"}]},
        {"ref": "harborfacilities.example", "name": "Harbor Facilities", "domain": "harborfacilities.example",
         "kind": "facility_management", "tags": ["Facility management", "Schools", "Offices"],
         "contacts": [{"name": "David Chen", "email": "david.chen@harborfacilities.example", "title": "Estimation Engineer"},
                      {"name": "Liam O'Connor", "email": "liam.oconnor@harborfacilities.example", "title": "Operations"}]},
        {"ref": "coastalbuild.example", "name": "Coastal Build", "domain": "coastalbuild.example", "kind": "main_contractor",
         "tags": ["Main contractor", "Industrial plants"],
         "contacts": [{"name": "Olivia Bennett", "email": "olivia.bennett@coastalbuild.example", "title": "Project Engineer"}]},
    ],
    "projects": [
        {
            "ref": "P-DEMO-MARINA", "name": "Marina Tower A", "service_family": "bmu", "work_type": "supply_installation",
            "request_kind": "tender_rfq", "customer_ref": "nqd.example", "priority": "high",
            "summary": "Roof-mounted BMU for a 120 m tower with unitised glazing; budget price, lead time and a 24-month maintenance option requested.",
            "enquiries": [{"ref": "E-DEMO-MARINA-NQD", "customer_ref": "nqd.example",
                           "contact": {"name": "Sarah Mitchell", "email": "sarah.mitchell@nqd.example"},
                           "email_ids": ["demo-m1", "demo-m2"], "thread_ids": ["demo-t1"], "received_at": "2026-09-24T09:12:00Z",
                           "due_date": "2026-11-12", "due_date_history": [{"value": "2026-10-30", "changed_at": "2026-09-29T08:00:00Z"}]}],
            "requirements": [
                {"field": "building_height", "label": "Building height", "value": "120 m",
                 "evidence": {"quote": "The tower is 120 m high", "source_type": "email", "source_id": "demo-m1"}},
                {"field": "facade_type", "label": "Façade type", "value": "Unitised glazing",
                 "evidence": {"quote": "unitised glazing façade", "source_type": "email", "source_id": "demo-m1"}},
                {"field": "parapet_height", "label": "Parapet height", "value": "1.1 m",
                 "evidence": {"quote": "The roof parapet height is 1.1 m", "source_type": "email", "source_id": "demo-m1"}},
            ],
            "scope_items": [{"description": "Roof-mounted BMU with telescopic jib and cradle", "qty": 1, "unit": "No.",
                             "evidence": {"quote": "Building Maintenance Unit (BMU) for Marina Tower A", "source_type": "email", "source_id": "demo-m1"}},
                            {"description": "Maintenance package, 24 months", "qty": 24, "unit": "month",
                             "evidence": {"quote": "an option for a 24-month maintenance package", "source_type": "email", "source_id": "demo-m1"}}],
            "unresolved_questions": ["Confirm roof load capacity for the proposed BMU."],
            "changes": [{"kind": "deadline_changed", "title": "Closing date extended", "old_value": "2026-10-30",
                         "new_value": "2026-11-12", "date": "2026-09-29T08:00:00Z",
                         "evidence": {"quote": "closing date has been extended to 12/11/2026", "source_type": "email", "source_id": "demo-m2"}}],
            "links": [{"url": "https://drive.google.com/drive/folders/1SAMPLEfolderId", "kind": "google_drive_folder",
                       "email_id": "demo-m1", "status": "found"}],
            "attachments": [{"email_id": "demo-m1", "filename": "Marina-Tower-A-roof-plan.pdf", "mime": "application/pdf",
                             "size": 4200000, "doc_kind": "drawing"}],
            "recommended_template": "tenders",
        },
        {
            "ref": "P-DEMO-CRESCENT", "name": "Crescent School", "service_family": "wce", "work_type": "supply_installation",
            "request_kind": "tender_rfq", "customer_ref": "harborfacilities.example", "priority": "high",
            "summary": "Window cleaning system (monorail, cradle, davit arms) for an 18 m school façade.",
            "enquiries": [{"ref": "E-DEMO-CRESCENT-HF", "customer_ref": "harborfacilities.example",
                           "contact": {"name": "David Chen", "email": "david.chen@harborfacilities.example"},
                           "email_ids": ["demo-c1", "demo-c2"], "thread_ids": ["demo-t2"], "received_at": "2026-09-20T10:30:00Z",
                           "due_date": "2026-10-22"}],
            "requirements": [{"field": "facade_height", "label": "Façade height", "value": "18 m",
                              "evidence": {"quote": "The façade is 18 m high", "source_type": "email", "source_id": "demo-c1"}}],
            "scope_items": [{"description": "Monorail track with trolley, cradle and davit arms", "qty": None, "unit": "lot",
                             "evidence": {"quote": "monorail with cradle and davit arms", "source_type": "email", "source_id": "demo-c1"}}],
            "changes": [{"kind": "deadline_changed", "title": "Closing date extended", "old_value": "2026-10-08",
                         "new_value": "2026-10-22", "date": "2026-09-28T07:45:00Z",
                         "evidence": {"quote": "the closing date has been extended to 22/10/2026", "source_type": "email", "source_id": "demo-c2"}}],
            "links": [{"url": "https://we.tl/t-SAMPLE123", "kind": "wetransfer", "email_id": "demo-c1", "status": "found"}],
            "recommended_template": "tenders",
        },
        {
            "ref": "P-DEMO-EASTQUAY", "name": "East Quay Plant", "service_family": "hoist", "work_type": "supply_installation",
            "request_kind": "revision", "customer_ref": "coastalbuild.example", "priority": "high",
            "summary": "Two construction hoists; revision R03 raises the mast from 20 m to 24 m, no tie to the adjacent wall.",
            "enquiries": [{"ref": "E-DEMO-EQ-CB", "customer_ref": "coastalbuild.example",
                           "contact": {"name": "Olivia Bennett", "email": "olivia.bennett@coastalbuild.example"},
                           "email_ids": ["demo-e1"], "thread_ids": ["demo-t3"], "received_at": "2026-09-29T11:00:00Z",
                           "due_date": "2026-10-15"}],
            "scope_items": [{"description": "Construction hoist, rack and pinion", "qty": 2, "unit": "No.",
                             "evidence": {"quote": "two (2) construction hoists", "source_type": "email", "source_id": "demo-e1"}}],
            "changes": [{"kind": "technical_revision", "title": "Revision R03: mast 20 m → 24 m", "old_value": "20 m",
                         "new_value": "24 m", "date": "2026-09-29T11:00:00Z",
                         "evidence": {"quote": "the mast height changed from 20 m to 24 m", "source_type": "email", "source_id": "demo-e1"}}],
            "blockers": [{"kind": "question", "text": "Free-standing mast at 24 m: confirm base and anchorage design"}],
            "attachments": [{"email_id": "demo-e1", "filename": "Hoist-requirements-R03.pdf", "mime": "application/pdf", "doc_kind": "specification"},
                            {"email_id": "demo-e1", "filename": "Hoist-layout-R03.pdf", "mime": "application/pdf", "doc_kind": "drawing"}],
            "recommended_template": "supply_installation",
        },
        {
            "ref": "P-DEMO-HARBOR", "name": "Harbor Offices", "service_family": "bmu", "work_type": "annual_maintenance",
            "request_kind": "direct_rfq", "customer_ref": "harborfacilities.example", "priority": "normal",
            "summary": "BMU maintenance contract: 24 months plus optional 12 months, monthly inspections and annual load test.",
            "enquiries": [{"ref": "E-DEMO-HARBOR-HF", "customer_ref": "harborfacilities.example",
                           "contact": {"name": "Liam O'Connor", "email": "liam.oconnor@harborfacilities.example"},
                           "email_ids": ["demo-h1"], "thread_ids": ["demo-t4"], "received_at": "2026-09-26T13:15:00Z"}],
            "scope_items": [{"description": "BMU preventive maintenance, monthly inspections", "qty": 24, "unit": "month",
                             "evidence": {"quote": "24 months plus an optional 12 months", "source_type": "email", "source_id": "demo-h1"}},
                            {"description": "Annual load test", "qty": 2, "unit": "No.",
                             "evidence": {"quote": "the annual load test are required", "source_type": "email", "source_id": "demo-h1"}}],
            "recommended_template": "annual_maintenance",
        },
    ],
}
