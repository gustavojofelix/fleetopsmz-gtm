# FleetOps MZ GTM Intelligence System: Architecture

Status: all four phases are implemented: foundation, Agent 1 (Minerador), Agent 2 (Pesquisador), Agent 3 (Copywriter) and pipeline orchestration with reports.
All tests use fakes for the model and search APIs. The agents have not yet been run against the live Anthropic or Serper APIs.

## 1. Principles

- **Evidence before assumptions.** Every material claim about a company is a `Fact` with sources. Hypotheses are stored separately and can never be read as confirmed.
- **Code does what code can.** Normalization, identity, deduplication, score arithmetic and hand-off gates are deterministic TypeScript. The model only classifies, extracts and writes.
- **Nothing is sent.** The system prepares drafts. It contains no email, WhatsApp or LinkedIn client, and an agent cannot mark anything as approved.
- **Nothing is overwritten.** Raw files are read-only. Every run writes to its own folder.
- **One identifier.** `lead_id` is the only identifier for a company, stable across runs.

## 2. Layers

Business logic never imports an SDK. External services sit behind interfaces (ports), and agents never call each other: the orchestrator passes validated records between them.

| Layer | Responsibility | May depend on |
|---|---|---|
| `src/schemas/` | Zod schemas; all TypeScript types are inferred from them | nothing |
| `src/domain/` | Pure rules: normalization, identity, dedup, scoring, qualification, hand-off gates, capability gate | schemas |
| `src/ports/` | `LlmClient`, `SearchProvider`, `RecordStore`, `Clock` | schemas |
| `src/infra/` | Errors, structured logger, retry, rate limiter, concurrency, hashing | ports |
| `src/config/` | Environment and `config/*.json` loading with validation | schemas, infra |
| `src/agents/` | `Agent<I, O>` contract, shared structured model call, the three agents | domain, ports |
| `src/adapters/` | Anthropic, Serper, filesystem | ports |
| `src/tools/` | CSV, raw import, search service, review files | schemas |
| `src/orchestration/` | Stage runs, run folders, caches, loaders | agents, domain |
| `src/reporting/` | CSV exports, dossier and outreach documents, summaries, KPI report | schemas |
| `src/cli/` | Command wiring with real adapters | all |
| `src/pipeline.ts` | CLI entry: dispatch only | cli |

## 3. Folder structure

```text
fleetopsmz-gtm/
├── CLAUDE.md
├── README.md
├── package.json  tsconfig.json  tsconfig.build.json  .gitignore  .env.example
├── config/
│   ├── product-capabilities.json    # owned by a person; all entries start "unverified"
│   ├── scoring.json                 # criterion maxima, A/B/C bands, coverage threshold, point tables
│   ├── geography.json               # city to province, regional priority, corridors
│   └── outreach.json                # sender identity, persona and draft limits
├── docs/
│   ├── FleetOpsMZ_Commercial_Brief.md
│   └── ARCHITECTURE.md
├── prompts/                         # 01_minerador.md, 02_pesquisador.md, 03_copywriter.md
├── templates/
│   ├── raw_companies_template.csv   # standard raw input header
│   ├── raw_companies_template.json  # same schema as JSON
│   ├── promotions_template.csv      # manual promotion ledger header
│   └── approvals_template.csv       # outreach approval ledger header
├── data/                            # contents are git-ignored
│   ├── raw/                         # your input files, never modified
│   ├── registry/                    # registry.json plus snapshots/<run_id>.json
│   ├── qualified/runs/<run_id>/     # Agent 1 output
│   ├── qualified/cache/             # validated model assessments, reused across runs
│   ├── researched/runs/<run_id>/    # Agent 2 output
│   ├── researched/cache/            # search results and model readings
│   ├── outreach_ready/runs/<run_id>/# Agent 3 output
│   ├── outreach_ready/approved/     # approved drafts exported for manual sending
│   ├── runs/                        # per-run options and log (<run_id>.json, <run_id>.log.jsonl)
│   ├── reports/                     # KPI reports
│   └── reviews/                     # promotions.csv and approvals.csv, edited by a person
├── src/                             # see section 2
└── tests/
    ├── fixtures.ts  helpers.ts      # fictional data only
    ├── unit/
    └── integration/
```

Run IDs look like `2026-11-12T1840Z_k3f9a2` (UTC time plus a random suffix). Each stage folder holds a `LATEST` pointer file naming its newest run; run folders themselves are never rewritten.

## 4. Data contracts

The authoritative definitions are in `src/schemas/`. Persisted fields use snake_case. Unknown values are `null`, never guessed.

### 4.1 Raw input (`RawCompanyInput`)

CSV or JSON with the same columns:

| Column | Rule |
|---|---|
| `company_name` | required, non-blank |
| `city`, `province`, `phone`, `email`, `website` | optional; blank becomes `null` |
| `business_category`, `business_description` | optional |
| `source_url`, `source_name`, `collected_at` | optional |

Values are kept as collected and normalized later, so a messy phone number or URL does not reject a row. Columns outside the template are preserved in `extra`. A row without `company_name` goes to a rejected-rows report with the reason. Each imported row becomes a `RawCompanyRecord` carrying the source file name, its SHA-256 and the row number.

### 4.2 Shared building blocks

| Type | Purpose | Key rules |
|---|---|---|
| `SourceRef` | Where information came from | URL, source name and type, retrieval timestamp, search provider |
| `Fact` | One claim about a company | `verified` needs at least one source with a URL; `hypothesis` is AI-generated |
| `PublicContact` | A public business contact | `corporate` or `named_person`; a named person needs a name and a source |
| `Provenance` | Processing metadata | run ID, agent, model, prompt version, timestamp |
| `Confidence` | `high`, `medium`, `low` | as defined in CLAUDE.md section 8 |

### 4.3 Stable `lead_id`

Format: `lead_` plus 16 hex characters. It is minted once from the normalized name and country, with a salt when a different company already holds that ID. The registry in `data/registry/registry.json` maps every known identity key to that ID.

| Key | Source | Match |
|---|---|---|
| `domain` | the company's own website or email domain (social networks, site builders and webmail excluded) | strong |
| `phone` | normalized phone number | strong |
| `name_city` | normalized name plus canonical city | strong |
| `name_only` | normalized name, for records with no city | matches only other records with no city |

A record sharing a strong key with a lead joins it, and its raw row is added to `merged_raw_ids`. Records that share only a name (for example the same name in two cities) stay separate leads and are both flagged `possible_duplicate` for manual review. A record whose keys point at two different leads joins the first and is flagged the same way.

### 4.4 Agent 1 output (`QualifiedLead`)

The primary company record: identity and location fields, `fleet_evidence`, `public_contacts`, `source_urls`, the ICP assessment, qualification status, confidence and provenance.

The ICP assessment holds one entry per criterion with points, maximum, basis (`evidence`, `inference` or `unknown`), rationale and fact references. `coverage` is the share of the 100 points belonging to criteria whose basis is not `unknown`.

What the model does and what code does in Agent 1:

| Step | Done by |
|---|---|
| Segment and sub-segment | model |
| Points and rationale for six criteria | model proposes; code rounds and clamps |
| `geographic_relevance` and `contact_availability` | code, from `config/geography.json`, `config/scoring.json` and collected channels |
| Evidence statements | model restates the record; code keeps only those tied to a description or category, and drops any containing a number not in the record |
| Fact kind | code: `verified` only if the row has a source URL, otherwise `hypothesis` |
| Total, coverage, priority, status | code |
| `business_description` | copied verbatim from the source row |

Phone numbers and email addresses are not sent to the model at this stage.

| Condition, checked in this order | `qualification_status` | Next step |
|---|---|---|
| Possible duplicate of another lead | `manual_review` (`possible_duplicate`) | held for a person to merge or separate |
| Coverage below `coverage_threshold` (default 0.5) | `manual_review` (`insufficient_information`) | held, whatever the score |
| Score 60 to 100 (priority A or B) | `qualified` | proceeds to Agent 2 automatically |
| Score 40 to 59 (priority C) | `manual_review` (`priority_c`) | held until promoted |
| Score below 40 | `low_priority` | archived, never deleted |

Missing information therefore leads to review, not rejection. A person promotes or archives held leads by adding rows to `data/reviews/promotions.csv`.

### 4.5 Agent 2 output (`ResearchDossier`)

A snapshot of the lead after research, plus: `identity_verified` with `identity_evidence`, `facts` (verified only), `challenge_hypotheses` (hypotheses only), `current_tools_observed`, language, the `searches` that were run, `research_status`, `recommended_next_action`, confidence and provenance. Decision-makers are the `named_person` entries of `lead.public_contacts`, so the lead stays one record with its contacts attached.

Agent 2 runs four searches per company (identity, activity, contact channels, leadership) and reads the result titles and snippets only. It does not open pages. What the model does and what code does:

| Step | Done by |
|---|---|
| Which results are about this company, and what they say | model |
| A fact is kept | code: it must cite real results and contain no number absent from them |
| Fact confidence | code: `high` from the official site, `medium` from two or more domains, `low` otherwise |
| Identity verified | code: the model must say so and a cited result must contain the company's identifying name words |
| Official website | code: the model's choice is accepted only if it is not a shared host and names the company |
| A contact is kept | code: its value must literally appear in the cited result; a person's name must too, or the contact is dropped; a role that does not appear is cleared |
| ICP re-score, research status, dossier confidence | code |

When identity is not verified, facts are marked low confidence and no contact, website or score change is attached to the lead.

### 4.6 Agent 3 output (`OutreachPackage`)

One or more drafts per lead, each for a persona and channel, with `fact_refs` (dossier facts it relies on), `capability_refs` (registry capabilities it mentions), a call to action, an opt-out line and `review_flags` for the reviewer. `approval.status` can only be `pending_human_review`.

Recipients are chosen by code (`src/agents/copywriter/targets.ts`), not by the model: up to `max_personas` decision-makers, named people found by research first, then the segment's default roles (for transport: Managing Director, Operations Director, Fleet Manager). Email goes to the person's public email or the corporate one, LinkedIn to a public profile when one was found, WhatsApp once to the corporate number. The model writes only the text; the signature comes from `config/outreach.json`.

Each draft is checked before it is kept (`src/agents/copywriter/validate.ts`). A draft is rejected when it:

- cites no verified fact, or a fact that was not offered;
- declares a capability that fails the capability gate;
- names a capability keyword in a sentence that also names the product, unless that capability is presentable and declared (in an institutional introduction, never);
- contains a percentage, a price or a placeholder;
- exceeds the channel length limit, or lacks a subject (email) or an opt-out line.

The model gets one chance to correct rejected drafts. Drafts that still fail are dropped; if none pass, the company fails with `grounding_violation`. Capability keywords that appear outside a product sentence (for example a question about the prospect's own trips) are not rejected but listed in `review_flags`.

| `draft_type` | Content | Capability rule |
|---|---|---|
| `institutional_intro` | Neutral introduction of FleetOps MZ and a request for a conversation | must reference no capability |
| `commercial` | Mentions specific product capabilities | every reference must pass the capability gate |

A draft is addressed to a named person only when the dossier holds that name from a public source; otherwise it is addressed to the role.

### 4.7 Capability registry and gate

`config/product-capabilities.json` lists each product capability with one of five statuses. The gate is `src/domain/capability-gate.ts`.

| Status | In customer-facing text |
|---|---|
| `implemented` | may be presented as available |
| `partially_implemented` | only with the registry's `limitations` stated; the draft is flagged for explicit approval |
| `planned`, `unverified`, `not_available` | never |
| key not in the registry | never |

`implemented` and `partially_implemented` are rejected by the schema unless `verified_by` and `verified_at` are filled in. Until at least one capability is `implemented`, Agent 3 produces institutional introductions only. Agents 1 and 2 do not read the registry.

### 4.8 Hand-off gates

| Hand-off | Passes when | Otherwise |
|---|---|---|
| Raw file to Minerador | row validates as `RawCompanyInput` | rejected-rows report |
| Minerador to Pesquisador | `qualified`, or promoted by a person | stays in `data/qualified/` |
| Minerador to Pesquisador (override) | a reviewer's latest row in `data/reviews/promotions.csv`: `promote` sends a held lead, `archive` stops a qualified one | |
| Pesquisador to Copywriter | identity verified, at least one high or medium confidence fact, at least one corporate contact channel | dossier saved, no drafts, next action is manual research |
| Copywriter to human review | every `fact_ref` resolves to a verified fact and the capability gate allows the draft | one regeneration, then the draft is rejected |
| Human review to sending | a reviewer's latest row in `data/reviews/approvals.csv` is `approved` | the draft is never exported |

## 5. Agent contract

```ts
interface Agent<Input, Output> {
  readonly name: AgentName;
  readonly promptVersion: string;
  readonly inputSchema: ZodType<Input>;
  readonly outputSchema: ZodType<Output>;
  run(input: Input, context: RunContext): Promise<AgentResult<Output>>;
}

type AgentResult<Output> =
  | { status: 'ok'; output: Output; usage: LlmUsage | null }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: PipelineError };
```

| Agent | Input | Output | External ports |
|---|---|---|---|
| Minerador | `LeadCandidate` (raw rows merged per lead) | `QualifiedLead` | `LlmClient` |
| Pesquisador | `QualifiedLead` | `ResearchDossier` | `LlmClient`, `SearchProvider` |
| Copywriter | `ResearchDossier` + capability registry | `OutreachPackage` | `LlmClient` |

`SearchProvider` returns normalized `SearchResult` records carrying provider, query, rank and retrieval time. Serper is the first adapter. Adding Tavily means writing one adapter and setting `SEARCH_PROVIDER=tavily`; agents and the pipeline do not change.

## 6. Execution flow

```text
data/raw/*.csv|json
   │  import: validate rows, hash the file, report rejected rows
   ▼
deduplicate and resolve lead_id against the registry
   ▼
Agent 1 Minerador ──► data/qualified/runs/<run_id>/
   │  gate: qualified (A or B), or promoted by a person
   ▼
Agent 2 Pesquisador ──► data/researched/runs/<run_id>/
   │  gate: identity verified, usable fact, corporate channel
   ▼
Agent 3 Copywriter ──► data/outreach_ready/runs/<run_id>/
   │  gate: fact references and capability references valid
   ▼
Human review ──► data/reviews/approvals.csv ──► sent manually by a person
```

Per record and stage: validate the input, look up the cached model result (keyed by a hash of prompt version, model and the exact input sent), call the model only on a miss, validate the reply, assemble and validate the output. A failing record is written to `failures.jsonl` and the batch continues. `manifest.json` records each record's status.

Recovery after an interruption is by re-running the same command: every assessment completed before the interruption is reused from the cache, so only unfinished companies reach the model. Each attempt gets its own run folder.

Commands:

```bash
npm run pipeline -- check-config
npm run pipeline -- run --input data/raw/beira.csv --dry-run
npm run pipeline -- run --input data/raw/beira.csv
npm run pipeline -- run --agents pesquisador,copywriter
npm run pipeline -- run --input data/raw/beira.csv --agents minerador,pesquisador,copywriter
npm run pipeline -- run --company "Company name" --city Beira
npm run pipeline -- run --agents pesquisador --lead <lead_id> --from-run <run_id>
npm run pipeline -- resume <run_id>
npm run pipeline -- report
npm run pipeline -- export-approved
```

A run of several agents uses one run ID across the stage folders. Starting at Agent 2 or 3 reads the newest run of the previous stage, or the one named by `--from-run`. `resume` repeats an earlier run with the same options under a new run ID; finished work comes from the caches. The batch limit defaults to 5, and a larger `--limit` needs `--confirm-large`.

## 7. Error handling

All failures are a `PipelineError` with a code, a `retryable` flag and log-safe context.

| Code | Handling |
|---|---|
| `config` | fail fast before any record is processed |
| `input_validation` | quarantine the record, continue |
| `provider_transient` | retry with exponential backoff and jitter, 3 attempts in total |
| `rate_limited` | retry, waiting at least the provider's retry-after hint |
| `provider_permanent` | fail the record, no retry |
| `model_output_invalid` | one repair attempt with the validation errors, then fail the record |
| `grounding_violation` | one regeneration, then reject the draft |
| `budget_exceeded` | stop the run cleanly, leaving it resumable |
| `io`, `internal` | fail the record or the run, depending on scope |

## 8. Logging

`src/infra/logger.ts` writes one JSON object per line with `time`, `level`, `event` and bound context (`run_id`, `agent`, `lead_id`). Fields named like credentials are replaced with `[REDACTED]`, and configured secret values are scrubbed from every string, including error messages. Callers log IDs and counts, not contact values. Each run will also write `run.log.jsonl`, `summary.md` and `summary.json` to its folder.

## 9. Testing

Tests use Node's built-in test runner through `tsx`, with no network access.

| Level | Covers |
|---|---|
| Schema tests | valid and invalid fixtures for every contract |
| Contract tests | each agent's real output is used as the next agent's input |
| Domain tests | normalization, dedup, scoring boundaries, qualification, gates, capability gate |
| Infrastructure tests | errors, retry, rate limiter, logger redaction, environment, CSV, filesystem store |
| Config tests | shipped config files validate; all capabilities unverified; sender unset |
| Agent tests | scripted model and search: repair, retries, cache, grounding of facts, contacts and drafts |
| Adapter tests | Anthropic and Serper request shape and error mapping, against fakes |
| Pipeline tests | three agents in sequence, recovery, idempotency, promotions, batch limit, no overwrite |
| Safety tests | the source contains no mail or messaging client and makes outbound requests only to the search API |

Not covered by automated tests: the live Anthropic and Serper APIs, and the quality of what a real model writes. Follow the small-batch review in CLAUDE.md section 13 before scaling.

## 10. Phase plan

| Phase | Delivers |
|---|---|
| 0. Foundation | setup, schemas, config, registry, templates, errors, logger, retry, capability gate |
| 1. Minerador | import, normalization, `lead_id` registry, dedup, scoring, Agent 1, exports |
| 2. Pesquisador | Serper adapter, rate limiter, search cache, Agent 2, evidence tracking, promotions |
| 3. Copywriter | targets, draft checks, Agent 3, sender signature, approvals, approved export |
| 4. Orchestration | multi-agent runs, single company and single lead, resume, KPI report |

All phases are implemented.

Runtime dependencies are `zod` and `@anthropic-ai/sdk` only. CSV handling is a small built-in module (`src/tools/csv.ts`) and Serper is called with the built-in `fetch`.

The Anthropic SDK is imported in one file, `src/adapters/anthropic-sdk.ts`. The request building, reply handling and error mapping live in `src/adapters/anthropic.ts` and are tested against a fake API. Structured output is obtained by forcing a single tool call whose input schema is the expected JSON schema; the reply is then validated with Zod before use.

Known limits:

- Research is based on search result snippets. A fact that only appears deep in a page is not found, and a snippet can be out of date.
- Tavily is declared as a provider name but has no adapter yet. Adding one means implementing `SearchProvider` and selecting it in `src/cli/commands.ts`.
- Leads are read from one qualification run at a time (the newest, or `--from-run`).
- Outcomes after approval (sent, replied, meeting) are not recorded here.
