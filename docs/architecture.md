# Engineering Smart System — architecture

Local-first automation app: reads a company mailbox, learns what the company does, sorts mail,
turns enquiries into projects, fetches the files customers send (attachments, Google Drive,
WeTransfer, Dropbox, OneDrive), studies them, drafts the company's official quotation, and stops
at a **human engineer gate** before anything leaves the building.

```
frontend/  React + TypeScript + Vite + Tailwind (served by the backend in production)
backend/ess/
  main.py          FastAPI app, serves /api and the built frontend
  config.py        paths (everything under data/, git-ignored)
  chromium.py      shared Chromium launcher (PDF + browser automation)
  db.py, models.py SQLite via SQLModel
  schemas.py       API shapes
  api/             REST routers (one per area)
  mcp_server.py    "Engine via MCP": exposes the work queue as MCP tools to an AI client
  pipeline/        ingest → classify → link/attachment fetch → extract → project → analyse → draft
  ai/              providers, model registry, eligibility policy, qualification tests, guards, task prompts
  sources/         mail connectors (Gmail API, IMAP, MCP), link extraction
  browser/         Playwright downloader (Drive, WeTransfer, Dropbox, OneDrive, direct links)
  documents/       PDF / DOCX / XLSX / image / ZIP extraction, BOQ parsing, page rendering
  quotation/       official templates (HTML → PDF), numbering, letterhead assets
  knowledge/       business identity mining, terminology by region, standards
  customers/       tagging, service-gap opportunities, research & monitoring, evidence standards
  automations/     workflow definitions and runner
```

## Non-negotiable rules (enforced in code, not only in prompts)

1. **Human gate.** Nothing is sent, replied, unsubscribed or downloaded from an unknown host
   without an explicit approval record (`who`, `when`). Quotations need an approved engineer review.
2. **Evidence.** Every AI-extracted fact stores a verbatim quote + source. `ess.ai.guards`
   rejects facts whose quote is not found in the source text.
3. **No invented prices.** AI never writes `unit_price`/`total`. Historical prices are shown as
   dated guidance only.
4. **Model eligibility.** Only models that pass the workspace policy (capabilities + qualification
   test) can run. Refused models cannot be selected through the UI, the API or MCP.
5. **Private data stays local.** Mail, files, letterheads, signatures and stamps live in `data/`
   (git-ignored). The repository ships code and neutral sample data only.

## Module interfaces (stable contracts between packages)

### `ess.ai`
```python
from ess.ai.engine import AIEngine, AIError
engine = AIEngine(provider="openai"|"anthropic"|"google"|"azure_openai"|"openai_compatible",
                  model="...", api_key="...", base_url=None, extra={})
engine.complete_json(system: str, user: str | list[dict], schema: dict, *, max_tokens=4000,
                     images: list[bytes] | None = None) -> dict   # schema-validated
engine.describe() -> dict          # provider/model/capabilities

from ess.ai.registry import load_registry, ModelSpec                # curated model catalogue
from ess.ai.policy import DEFAULT_POLICY, evaluate_model             # -> EligibilityResult(status, reasons)
from ess.ai.providers import list_remote_models                      # live model list per provider
from ess.ai.qualification import run_qualification                   # golden-set exam -> score/passed/cases
from ess.ai.guards import verify_evidence, strip_prices, validate_schema
from ess.ai import tasks   # classify_email, extract_request, analyze_document, analyze_drawing,
                           # draft_quotation, discover_business, research_customer
from ess.ai.rules import RuleClassifier  # deterministic keyword classifier (works with no AI)
```

### `ess.sources`
```python
from ess.sources.base import MailMessage, MailAttachment, MailSource
# MailSource: search(query, after, before, max_results) -> list[str thread_id]
#             get_thread(thread_id) -> list[MailMessage]
#             download_attachment(message_id, attachment_id) -> bytes
#             create_draft(to, subject, body_text, attachments=[(name, bytes, mime)], in_reply_to=None) -> str
#             send_draft(draft_id) -> str          (only after approval)
#             test() -> dict(ok, account, error)
from ess.sources.gmail_api import GmailApiSource, gmail_auth_url, gmail_exchange_code
from ess.sources.imap import ImapSource
from ess.sources.mcp_mail import McpMailSource
from ess.sources.links import extract_links      # -> [{url, kind}]
```

### `ess.browser`
```python
from ess.browser.downloader import download_link   # async
result = await download_link(url, kind, dest_dir)  # -> DownloadResult(status, files, error, log, screenshots)
# status: ok | expired | needs_login | blocked | failed | unsupported
```

### `ess.documents`
```python
from ess.documents.extract import extract_document, render_pdf_page, classify_document
doc = extract_document(path)   # -> DocExtract(kind, text, pages[{n,text}], tables, boq_items, images, meta, warnings)
png = render_pdf_page(path, page_number, dpi=110)
```

### `ess.quotation`
```python
from ess.quotation.templates import TEMPLATES, choose_template
from ess.quotation.numbering import next_reference          # "AA/26/0118"
from ess.quotation.render import render_quotation_html, render_quotation_pdf   # async PDF
from ess.quotation.assets import LetterheadAssets           # data/private/letterhead/* or neutral default
```

### `ess.knowledge` / `ess.customers`
```python
from ess.knowledge.base import load_region_terms, load_standards, default_categories
from ess.knowledge.miner import mine_corpus, build_identity
from ess.customers.tagging import tag_customer, infer_customer_kind
from ess.customers.opportunities import match_services
from ess.customers.research import research_customer, EVIDENCE_STANDARDS
from ess.customers.search import get_search_provider
```
