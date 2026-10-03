# Free-plan service connections — 0.3.1

The Mac app supports named Groq, Mistral and SambaNova AI connections, Tavily and Exa search,
and Firecrawl v2 search/page reading. Each connection has its own encrypted local API key.
Free allowances, model availability and billing limits belong to the provider account.
ESS never purchases credits, selects a paid plan, or automatically changes provider.

## Connect

1. Open **Settings → AI engine → API key**. Choose a provider and use **Open API keys** to
   get a key from its official console. Enter the key in the app and save/test. A failed test
   leaves the previous active connection in use; the replacement remains saved for editing.
2. Refresh the model list, run the qualification exam and select an eligible model. Connection
   testing lists models; it does not prove output quality. Qualification uses synthetic cases
   and consumes tokens from the account. Groq `openai/gpt-oss-120b` is a text-only candidate
   for mail sorting. Engineering extraction, quotations and drawings retain the existing
   stricter task policy. No model has been pre-qualified by adding these adapters.
3. For Mistral, disable API data training in the provider account before confirming the
   corresponding box in ESS. Until confirmed, that connection cannot process company work.
4. Open **Settings → Mailbox & services → Web search → Add search service**. Tavily Basic
   is the initial option; Exa Fast and Firecrawl are alternatives. Save/test makes one public
   synthetic request. It does not send company documents or private mailbox text.
5. Optional: connect **Page reading → Firecrawl** to use it alongside Tavily or Exa. Individual
   public page URLs are sent to Firecrawl; this does not crawl the company archive or enable
   whole-site crawling. Search and page reading each consume the provider's allowance.

To replace a key, edit that service and save/test. To switch services, use **Use this one** on
the saved connection. Keys never cross named provider boundaries. Named AI endpoints are
fixed to official API hosts; custom hosts require a separate OpenAI-compatible connection.
Codex connector credentials are not copied into the app.

## Paused research

HTTP 401/403 (credentials) and 402/429 (credits/rate limits) pause customer research. Successful
searches and readable pages are saved atomically under the app's private data directory.
Research interrupted by an app restart is also offered for explicit resume. After changing
the key/provider or waiting for quota reset, open the customer's Research tab and click
**Resume saved research**. The report retains its ID and original research date. Cached
sources retain their original provenance; changed customer inputs invalidate the cache.

This resumability applies to customer research. Model qualification and unrelated pipeline
jobs retain their existing retry behavior. Actual remaining provider credits are not measured
by ESS. Free-plan status must be checked in the provider console.

## Verification boundary

Automated contract tests use synthetic HTTP/SDK responses to verify authentication headers,
official endpoints, schemas, quota handling, key isolation, model metadata and restart/resume.
Live authentication, free allowance and model qualification require the owner's account keys.
No private company material belongs in screenshots shared publicly, source archives or GitHub.

API references checked 2026-10-03:

- [Groq structured outputs](https://console.groq.com/docs/structured-outputs)
- [Mistral API](https://docs.mistral.ai/api)
- [Mistral API training opt-out](https://help.mistral.ai/en/articles/455207-can-i-opt-out-of-my-input-or-output-data-being-used-for-training)
- [SambaNova documentation](https://docs.sambanova.ai/)
- [Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search)
- [Exa Search](https://exa.ai/docs/reference/search)
- [Firecrawl Search](https://docs.firecrawl.dev/api-reference/endpoint/search)
- [Firecrawl Scrape](https://docs.firecrawl.dev/api-reference/endpoint/scrape)
