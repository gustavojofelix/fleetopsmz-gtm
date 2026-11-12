# FleetOps MZ GTM Intelligence System

Commercial intelligence pipeline for FleetOps MZ. It qualifies companies, researches them from public search results and prepares outreach drafts for human review.

**It never sends anything.** There is no email, WhatsApp or LinkedIn client in the code. The pipeline ends with a CSV of drafts you approved, which you send yourself.

- Project rules: [`CLAUDE.md`](CLAUDE.md)
- Design: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Commercial context: [`docs/FleetOpsMZ_Commercial_Brief.md`](docs/FleetOpsMZ_Commercial_Brief.md)

## What it does

| Stage | Agent | Input | Output |
|---|---|---|---|
| 1 | Minerador | your CSV or JSON of companies | scored, deduplicated leads in `data/qualified/` |
| 2 | Pesquisador | qualified leads | research dossiers in `data/researched/` |
| 3 | Copywriter | dossiers | outreach drafts in `data/outreach_ready/`, pending your review |

## One-time setup

Requirements: Node.js 22 or newer.

### 1. Install and verify

```bash
npm install
npm test
npm run build
```

### 2. Create `.env`

Copy `.env.example` to `.env` and fill in:

| Variable | Needed for | Where to get it |
|---|---|---|
| `ANTHROPIC_API_KEY` | all agents | Anthropic Console |
| `ANTHROPIC_MODEL` | all agents | the model ID you want to use; there is no default |
| `SERPER_API_KEY` | Agent 2 | serper.dev |

Leave `APIFY_TOKEN` and `TAVILY_API_KEY` empty: they are not used. Never commit `.env`.

### 3. Fill in the sender: `config/outreach.json`

Agent 3 refuses to run until it knows who the messages are from. Replace the `null` values:

```json
"sender": {
  "name": "Your full name",
  "role": "Your role",
  "company": "FleetOps MZ",
  "email": "you@your-domain",
  "phone": "+258...",
  "website": "https://your-site"
}
```

`name` and at least one of `email` or `phone` are required. The signature is added to every draft automatically.

### 4. Verify product capabilities: `config/product-capabilities.json`

Every capability ships as `unverified`. While none is `implemented`, Agent 3 writes neutral institutional introductions that make no product claims. To allow commercial drafts, mark what you have checked in the product:

```json
{ "key": "trips", "status": "implemented", "verified_by": "Your name", "verified_at": "2026-11-12T16:00:00Z" }
```

| Status | Effect in drafts |
|---|---|
| `implemented` | may be presented as available |
| `partially_implemented` | allowed only with `limitations` filled in; the draft is flagged for your explicit approval |
| `planned`, `unverified`, `not_available` | never presented as a product feature |

`implemented` and `partially_implemented` need `verified_by` and `verified_at`. Change only `status`, `limitations`, `verified_by`, `verified_at` and `notes`.

### 5. Check the configuration

```bash
npm run check-config
```

It prints one JSON line. Look at `missing_by_agent` (should be empty lists), `outreach_sender_problems` (should be empty) and `commercial_drafts_enabled`.

## Running the pipeline

### 1. Prepare a company file

Copy `templates/raw_companies_template.csv` to `data/raw/` and add one company per row.

```text
company_name,city,province,phone,email,website,business_category,business_description,source_url,source_name,collected_at
```

- Only `company_name` is required. Leave unknown values empty.
- Fill in `business_description` and `source_url` when you can: a statement counts as sourced evidence only when its row has a source URL.
- Comma and semicolon separators both work, so a CSV saved from Excel is fine. JSON with the same keys is also accepted.
- `collected_at` is read as an ISO date (`2026-11-12`).
- Raw files are never modified.

### 2. Check the file (free)

```bash
npm run pipeline -- run --input data/raw/beira.csv --dry-run
```

No API calls and nothing written. It reports rows read, rejected and merged.

### 3. Run a small batch

Start with Agent 1 alone and review its output before spending on research:

```bash
npm run pipeline -- run --input data/raw/beira.csv
```

Then research and draft for the companies that qualified:

```bash
npm run pipeline -- run --agents pesquisador,copywriter
```

Or run all three in one go:

```bash
npm run pipeline -- run --input data/raw/beira.csv --agents minerador,pesquisador,copywriter
```

Each command prints the path of its summary files when it finishes. The default batch is 5 companies; for more, add `--limit 40 --confirm-large`.

### 4. Review the output

| What | Where |
|---|---|
| Scores and statuses | `data/qualified/runs/<run_id>/qualification_summary.md` and `qualified_companies.csv` |
| Research results | `data/researched/runs/<run_id>/research_summary.md` and `dossiers/*.md` |
| Drafts to review | `data/outreach_ready/runs/<run_id>/outreach_summary.md`, `outreach_ready.csv` and `companies/<company>/outreach.md` |
| Run log | `data/runs/<run_id>.log.jsonl` |

`data/<stage>/LATEST` names the newest run of each stage. Earlier run folders are never changed.

### 5. Promote or archive held leads (optional)

Leads with priority C, too little information or a possible duplicate are held. To decide, create `data/reviews/promotions.csv` from `templates/promotions_template.csv`:

```text
lead_id,decision,reviewer,decided_at,note
lead_0123456789abcdef,promote,Your name,2026-11-13,
```

`decision` is `promote`, `archive` or `keep_in_review`. Then run Agent 2 again.

### 6. Approve drafts

Read each draft in `outreach.md`, including its "Check before approving" notes. Record decisions in `data/reviews/approvals.csv` (from `templates/approvals_template.csv`):

```text
draft_id,lead_id,decision,reviewer,decided_at,note
draft_513dd0bd0eab,lead_01d9c691700f089c,approved,Your name,2026-11-13,
```

`decision` is `approved`, `rejected` or `changes_requested`. Then:

```bash
npm run pipeline -- export-approved
```

This writes `data/outreach_ready/approved/approved_<time>.csv` with the final text of each approved message and where to send it. Send them yourself.

### 7. Track results

```bash
npm run pipeline -- report
```

Writes a KPI report to `data/reports/`. Responses, meetings, demonstrations and customers are outside this system: record them in your CRM.

## Command reference

```bash
npm run pipeline -- check-config
npm run pipeline -- run [options]
npm run pipeline -- resume <run_id>
npm run pipeline -- report
npm run pipeline -- export-approved
```

| `run` option | Effect |
|---|---|
| `--agents <list>` | `minerador`, `pesquisador`, `copywriter`; comma-separated, adjacent stages. Default: `minerador` |
| `--input <file>` | raw file for Agent 1; repeat for several files |
| `--company "<name>"` | assess one company without a file; add `--city` and `--website` if known |
| `--from-run <run_id>` | run to read from when starting at Agent 2 or 3. Default: the newest run of the previous stage |
| `--lead <lead_id>` | process only this lead (Agents 2 and 3) |
| `--limit <n>` | maximum companies. Default: `DEFAULT_BATCH_LIMIT` (5) |
| `--confirm-large` | required when `--limit` is above the default |
| `--dry-run` | Agent 1 only: import and deduplicate |
| `--force` | ignore cached results and call the providers again |

## Costs and interruptions

- Agent 1 makes one model call per company.
- Agent 2 makes four searches and one model call per company.
- Agent 3 makes one model call per company, two if a draft has to be corrected.

Every search result and model result is cached under `data/*/cache/`. If a run is interrupted, run the same command again, or `npm run pipeline -- resume <run_id>`: finished work is reused and nothing is paid for twice. A changed prompt, model or company record is processed again automatically.

## How accuracy is enforced

- **Agent 1** only sees the row you supplied. Facts are kept only if they restate the description or category, and are dropped if they contain a number that is not in the row.
- **Agent 2** reads search result titles and snippets only; it does not open pages. A fact is kept only if it cites real results. A contact is kept only if its value, and any person's name, literally appear in the cited result. If the results do not clearly name the company, identity stays unverified and nothing is attached to the lead.
- **Agent 3** is offered only verified facts with medium or high confidence. Drafts are produced only when identity is verified, at least one such fact exists and a public corporate contact exists. Product claims are checked against the capability registry; drafts with percentages, prices or placeholders are rejected.
- Recipients, channels and contact details are chosen by code from the dossier, never written by the model.

These checks reduce errors; they do not replace your review. Read every dossier and draft before using it.

## Data and privacy

- Everything under `data/` is git-ignored because it contains business contact details.
- `data/registry/registry.json` keeps `lead_id` values stable across runs. Do not edit or delete it.
- Only business fields are sent to the model for Agents 1 and 2. Phone numbers and email addresses from your files are not sent.
- Research uses public search results. It does not log in anywhere, bypass access controls or scrape profiles.
- You remain responsible for complying with Mozambican privacy and electronic communications rules and with each platform's terms when you send messages.
