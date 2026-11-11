# Job sources

One adapter per file in `services/scout/scout_service/sources/`, registered in
`sources/__init__.py` (`ALL_SOURCES`, `get_source`). Settings live in `config/sources.yaml`
under the adapter's name; the `enabled:` map there decides which adapters run by default.
Adapters marked **scraped** additionally need `ENABLE_SCRAPED_SOURCES=true`.

Status was checked with one live fetch per adapter on 2026-11-11 (keywords "AI Engineer",
"Machine Learning Engineer", "LLM", "Data Scientist"; limit 50).

| Adapter | Endpoint | Auth | Limits / terms | Status |
|---|---|---|---|---|
| `greenhouse` | `boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true` | none | Public board API. 20 verified slugs. | Works. ~4,500 postings across the boards. |
| `lever` | `api.lever.co/v0/postings/{slug}?mode=json` | none | Public postings API. 14 verified slugs. No company name in the API: `names:` in settings, else the title-cased slug. | Works. Slowest adapter (~25 s). |
| `ashby` | `api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true` | none | Public posting API. 20 verified slugs. No company name in the API (same `names:` rule). | Works. |
| `remoteok` | `remoteok.com/api` (`?tag=` per configured tag) | none | **Terms: link back to the Remote OK URL and credit Remote OK as the source.** | Works. 123 postings for tags ai, machine-learning, python. Text is double-encoded UTF-8 in the feed; the adapter repairs it. |
| `remotive` | `remotive.com/api/remote-jobs` | none | **Terms: link back and credit Remotive; at most ~4 requests a day; no re-posting to other job boards.** Jobs are delayed 24 h. The adapter sends at most one request per 6 h (request guard, below). | Works, but the public feed is tiny (13 jobs) and ignores `search`, `category` and `limit`, so the adapter sends one unfiltered request. |
| `weworkremotely` | RSS: `/categories/remote-programming-jobs.rss`, `/remote-jobs.rss` | none | Public RSS feeds. | Works. 122 postings after de-duplication. |
| `hn_hiring` | `hn.algolia.com/api/v1/search_by_date` (find thread), `/items/{id}` (comments) | none | Public Algolia HN API. | Works. 202 postings from the November 2026 thread. Company / role / location come from the free-text first line, best-effort; comments without a `A \| B` first line are skipped, and a post with no recognisable role gets the title "Hiring (see post)". |
| `yc_jobs` | `www.ycombinator.com/jobs`, `/jobs/role/{role}` | none | No API. Reads the JSON the page embeds in a `data-page` attribute. | Works, moderately fragile (breaks if YC changes the embedded blob; it then raises a clear error, also when the blob no longer has a `jobPostings` list). 64 postings from 3 pages. No full description and no posting date in the listing. |
| `jobicy` | `jobicy.com/api/jobs?count=100` (+ `industry`, `geo`, `tag`) | none | **Terms: no more than one sync per hour; credit Jobicy with a link to the job URL.** The adapter sends at most one request per hour (request guard, below). | Works. 82 postings for `industry=data-science`. |
| `startup_jobs` | MCP server `api.startup.jobs/mcp`, tool `search_jobs` (one call per keyword) | none | **Terms: link the title to the job URL and credit Startup Jobs.** 20 HTTP requests per minute, handshake included. Free tier covers the last 14 days. Each MCP request times out after 30 s. A failed call keeps the jobs of the earlier calls; nothing is retried. | Works. 199 postings. Search results are summaries: **no description**. The REST API (`api.startup.jobs/v1`) was not used because it requires an API key. |
| `teamtailor` | `{site}/jobs.rss` (paged with `offset`, 100 per page, at most 4 pages) | none | Public feed of each Teamtailor career site. Location per office: its name (else its city) and country. | Works. 173 postings from `jobs.ethikos.es`. |
| `zoho_recruit` | `{site}` listing page, e.g. `www.talent40.com/jobs` | none | No API. Reads the Zoho `JobOpening` records from the Next.js flight payload in the page. The company is the site's entry in `names:` (else its hostname); the record's department, an internal team code on staffing sites, becomes a tag. | Works for `talent40.com` (41 postings). Fragile and **only verified against that site**: it fits Zoho-backed sites built the same way, not the classic `*.zohorecruit.com` career pages. |
| `freelancermap` | `www.freelancermap.com/projects?query=…`, `/projects/{category}` | none | No API. `robots.txt` allows generic bots (`User-agent: *` / `Disallow:` empty), so it is not marked scraped. Reads the JSON embedded for the `ProjectSearch` component. The RSS feed the site links to returns 404. | Works, moderately fragile. 48 postings (3 keyword searches + 1 category page). |
| `linkedin` | `www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search` | none | **Scraped, off by default.** LinkedIn's terms forbid automated access. One request per keyword (max 3), 3 s apart, first page only. It stops at the first failed request and keeps what the earlier ones found; nothing is retried. | Worked in the live check (29 postings) but can be blocked at any time (HTTP 429/999 raise "LinkedIn blocked the request"). Cards carry **no description**. |
| `indeed` | `www.indeed.com/jobs?q=…&l=…` | none | **Scraped, off by default.** Indeed's terms forbid automated access. | **Blocked.** Cloudflare answers a plain HTTP client with 403; the adapter raises `Indeed blocked the request (HTTP 403)`. The parser is untested against a real results page (its test uses a synthetic fixture). |

## Shared behaviour

- **Limit.** Adapters return everything they read. The runner ranks the postings (titles
  with a whole keyword phrase first, then titles with a keyword word-stem, then the rest;
  whole words only, so "AI" does not match "Email") and forwards up to `limit_per_source`
  postings **not seen before**. Seen postings do not use up the limit, so a later run reaches
  further down the list; with `force` the first `limit` are sent again.
- **Delivery.** A posting is published to `jobs.raw` first and marked seen afterwards, so a
  crash in between repeats it on a later run instead of losing it.
- **Malformed records.** Each record is converted on its own (`common.build_postings`): one
  that raises, or a posting without title, company or an `http(s)` URL, is logged and skipped.
  The count is reported as `skipped` in `source.finished`, together with postings the runner
  could not encode.
- **Failures.** Any error of one source (its settings section, the fetch, ranking, publishing)
  becomes that source's `source.failed`; the other sources carry on. Transient errors
  (timeouts, dropped connections, HTTP 429/5xx) are retried twice, except by adapters that
  raise `SourceGaveUp` because a retry would repeat requests the site counts: Remotive,
  Jobicy, LinkedIn and startup.jobs.
- **Request guard** (Remotive, Jobicy; `sources/guard.py`). The guard is kept in Redis, so it
  survives a scout restart, and it is armed before the request, so a failed request counts
  too. Until it expires a run reuses the last successful result, or reports that the next
  request is not yet allowed when there is none.
- **Fail-soft.** In multi-board adapters one failing slug, feed or site is logged and skipped;
  if every one fails, the first error is raised so the run reports it (`common.fetch_each`).
- **Descriptions** are plain text, at most 12,000 characters. HTML is stripped of its tags
  before entities are unescaped (`text.html_to_text`), so an escaped `&lt;` stays a literal
  `<`; fields that are already plain text (Lever, Ashby, Zoho) only get their whitespace
  normalised (`text.tidy_text`).

## Adding a company or site

Add the slug or URL to the adapter's list in `config/sources.yaml`. Check a board slug first;
a wrong one returns 404 and is skipped with a warning:

```
curl -s -o /dev/null -w '%{http_code}\n' https://boards-api.greenhouse.io/v1/boards/<slug>/jobs
curl -s -o /dev/null -w '%{http_code}\n' 'https://api.lever.co/v0/postings/<slug>?mode=json'
curl -s -o /dev/null -w '%{http_code}\n' https://api.ashbyhq.com/posting-api/job-board/<slug>
```
