# FleetOps MZ — Go-to-Market Intelligence System

## 1. Project Overview

This repository contains the commercial intelligence and go-to-market automation system for **FleetOps MZ**, a B2B SaaS platform designed for fleet management, transport operations and logistics companies in Mozambique.

The objective is to build a structured, evidence-based commercial acquisition pipeline that identifies potential customers, researches their businesses, qualifies opportunities and prepares personalized B2B outreach.

The system uses AI agents orchestrated through TypeScript and the Anthropic API.

### Primary business objective

Help FleetOps MZ acquire its first paying business customers by:

1. Identifying transport, logistics and fleet-intensive companies.
2. Collecting and organizing publicly available business information.
3. Qualifying companies according to their potential fit.
4. Researching relevant business context and decision-makers where publicly available.
5. Generating personalized commercial dossiers and outreach messages.
6. Supporting a repeatable sales pipeline with measurable results.

This is a commercial intelligence and sales enablement system, not a mass-spamming tool.

---

## 2. Product Context

### Product

**Name:** FleetOps MZ  
**Category:** B2B SaaS — Fleet Management and Transport Operations  
**Initial market:** Mozambique  
**Initial commercial focus:** Beira and the central logistics corridor.

### Product positioning

FleetOps MZ helps transport and logistics companies centralize fleet operations, improve operational visibility and gain better control over transport-related costs.

### Current development status

The product is approximately 70% developed.

- User interface and main operational workflows are substantially implemented.
- Supabase integration is already in progress.
- The product is being prepared for commercial validation.
- Some features, integrations and production-readiness requirements may still be under development.

**Important:** Never assume a feature is production-ready simply because it appears in a UI or product plan. Verify its implementation status before mentioning it in customer-facing material.

The single source of truth for feature status is `config/product-capabilities.json`. Statuses are set by a person, never inferred. Only `implemented` capabilities may be presented as available; `partially_implemented` capabilities need their limitations stated and explicit human approval; `planned`, `unverified` and `not_available` capabilities must never be presented as existing features.

### Potential product capabilities

The platform's commercial scope includes:

- Fleet and vehicle management.
- Driver management.
- Trailer management.
- Customer management.
- Trip and transport operation management.
- Dispatch and operational workflows.
- Fuel purchase and consumption control.
- Operational expenses.
- Vehicle maintenance.
- Trip cost and profitability analysis.
- Reports and operational dashboards.
- Document management.
- User roles and permissions.
- Driver mobile application.
- Future GPS, telematics and third-party integrations.

These capabilities are not automatically confirmed as available. The current product implementation and feature status must be checked.

---

## 3. Commercial Geography

### Initial market

Mozambique.

### Priority regions

1. Beira — initial commercial priority.
2. Maputo and Matola.
3. Tete.
4. Nacala.
5. Other relevant transport and logistics hubs.

### Strategic corridors

- Beira Corridor.
- Maputo Corridor.
- Nacala Corridor.
- Tete and regional cross-border transport routes.

### Future expansion

The long-term opportunity includes the Southern African Development Community (SADC), subject to product localization, market validation, regulatory requirements and commercial readiness.

Do not prioritize regional expansion over validation in Mozambique.

---

## 4. Ideal Customer Profile (ICP)

Prioritize organizations that operate vehicles commercially and have recurring transport or logistics activities.

### Primary segments

**A. Transport companies**

- Road freight operators.
- Heavy truck fleets.
- Domestic and international transport.
- Container transport.
- Bulk cargo transport.
- Cross-border operators.

**B. Logistics companies**

- Freight forwarding.
- Port and corridor logistics.
- Warehousing and distribution.
- Cargo handling and transport coordination.

**C. Distribution companies**

- FMCG distribution.
- Wholesale distribution.
- Retail distribution.
- Last-mile delivery fleets.

**D. Fleet-intensive companies**

- Construction companies.
- Mining contractors.
- Industrial service providers.
- Companies with significant internal vehicle fleets.

### Company size

Prioritize companies with:

- Multiple operational vehicles.
- Recurring trips or transport operations.
- Dedicated fleet or operations personnel.
- Meaningful fuel, maintenance and operational expenses.
- A need for operational reporting and cost control.

Do not automatically exclude smaller companies. Their commercial fit should be evaluated based on operational complexity and willingness to pay.

### Target decision-makers

Where publicly identifiable and relevant:

- Managing Director / CEO.
- Owner / Founder.
- Operations Director.
- Fleet Manager.
- Transport Manager.
- Logistics Manager.
- Finance Director / CFO.
- Procurement Manager.

Do not invent names, positions, email addresses or telephone numbers.

---

## 5. Commercial Problems to Investigate

The agents should investigate whether a company may experience any of the following challenges:

1. Limited visibility over vehicle operations.
2. Manual trip registration and tracking.
3. Fragmented operational information.
4. Difficulty controlling fuel expenditure.
5. Limited visibility over maintenance costs.
6. Difficulty calculating trip costs and profitability.
7. Inefficient driver and vehicle coordination.
8. Dependence on spreadsheets and paper records.
9. Difficulty producing reliable management reports.
10. Lack of integration between operational processes.

These are hypotheses to investigate, not facts to attribute to every company.

Never claim that a company has a problem without evidence.

---

## 6. System Architecture

The project is organized as follows:

```text
fleetopsmz-gtm/
├── CLAUDE.md
├── README.md
├── config/
│   ├── product-capabilities.json
│   ├── scoring.json
│   └── geography.json
├── docs/
│   ├── FleetOpsMZ_Commercial_Brief.md
│   └── ARCHITECTURE.md
├── prompts/
│   ├── 01_minerador.md
│   ├── 02_pesquisador.md
│   └── 03_copywriter.md
├── templates/
├── data/
│   ├── raw/
│   ├── registry/
│   ├── qualified/
│   ├── researched/
│   ├── outreach_ready/
│   └── reviews/
├── src/
│   ├── pipeline.ts
│   ├── schemas/
│   ├── domain/
│   ├── agents/
│   ├── ports/
│   ├── adapters/
│   ├── tools/
│   ├── orchestration/
│   ├── infra/
│   └── reporting/
├── tests/
└── .env
```

See `docs/ARCHITECTURE.md` for the full design.

### Data flow

```text
Public Sources / Imported Data
             |
             v
         data/raw/
             |
             v
     Agent 1: Minerador
             |
             v
      data/qualified/
             |
             v
     Agent 2: Pesquisador
             |
             v
      data/researched/
             |
             v
     Agent 3: Copywriter
             |
             v
    data/outreach_ready/
             |
             v
     Human Sales Review
             |
             v
      CRM / Outreach
```

### Agent responsibilities

**Agent 1 — Minerador**

- Processes raw business data.
- Identifies relevant companies.
- Removes duplicates.
- Normalizes company names and locations.
- Classifies business segments.
- Evaluates preliminary ICP fit.
- Produces structured qualified-company records.

**Agent 2 — Pesquisador**

- Researches qualified companies.
- Verifies company identity and business activities.
- Finds official websites and public business channels.
- Identifies publicly documented fleet and logistics activities.
- Finds relevant public business contacts where available.
- Records sources, dates and confidence levels.
- Produces a commercial research dossier.

**Agent 3 — Copywriter**

- Uses verified company research.
- Creates personalized outreach messages.
- Prepares email, LinkedIn and WhatsApp drafts.
- Adapts tone and message length to the channel.
- Uses a relevant business problem as the conversation opener.
- Creates a clear call to action, preferably requesting a short demonstration.

The agents must follow their individual instructions in `/prompts`.

---

## 7. Technical Standards

### Stack

- TypeScript.
- Node.js.
- Anthropic API.
- Serper API for search, where appropriate.
- Apify for permitted data extraction workflows.
- Tavily may be considered as an alternative web research provider.
- CSV and JSON for data exchange.

### Engineering principles

- Modular architecture.
- Strong TypeScript typing.
- Small, testable functions.
- Separation of business logic and external integrations.
- Centralized configuration.
- Structured logging.
- Explicit error handling.
- Retry logic with reasonable limits.
- Rate limiting for external services.
- Deduplication and idempotent processing.
- Reusable tools and agent prompts.
- Validation of all external and model-generated data.

Do not build a monolithic pipeline.

### API and environment variables

Use environment variables for all API credentials.

Expected variables:

```env
ANTHROPIC_API_KEY=
SERPER_API_KEY=
APIFY_TOKEN=
TAVILY_API_KEY=
```

Only configure the providers actually used.

Never:

- Hardcode API credentials.
- Print secrets in logs.
- Commit `.env`.
- Expose credentials to generated reports.
- Store API keys in CSV or JSON outputs.

Create and maintain `.env.example` with empty placeholders.

### Model usage

Use Anthropic models through the official SDK.

- Keep model selection configurable.
- Use structured outputs and schema validation wherever possible.
- Keep prompts in `/prompts`, not embedded in `pipeline.ts`.
- Handle API limits and transient failures.
- Avoid unnecessary repeated model calls.
- Record model name and processing timestamp where appropriate.

---

## 8. Data Standards

All company records should have a consistent structure.

Recommended company fields:

```json
{
  "lead_id": "lead_0123456789abcdef",
  "company_name": "Company Name",
  "normalized_name": "company name",
  "website": null,
  "business_segment": "transport",
  "sub_segment": "road_freight",
  "city": "Beira",
  "province": "Sofala",
  "country": "Mozambique",
  "business_description": null,
  "fleet_evidence": [],
  "public_contacts": [],
  "source_urls": [],
  "icp": { "criteria": [], "score": 0, "coverage": 0, "priority": "low" },
  "qualification_status": "manual_review",
  "review_reason": "insufficient_information",
  "duplicate_of": null,
  "merged_raw_ids": [],
  "confidence": "low",
  "provenance": {},
  "created_at": "ISO-8601",
  "updated_at": "ISO-8601"
}
```

`lead_id` is the only identifier for a company. It is stable across runs and is used in every schema, file, report and agent contract. Do not introduce a second identifier for the same lead.

Each lead is one primary company record with its business contacts attached in `public_contacts`.

The authoritative definitions are the Zod schemas in `src/schemas/`. Evolve them carefully and keep the three agents compatible.

### Data quality rules

- Normalize company names.
- Use stable `lead_id` values so the same company is never duplicated across runs.
- Deduplicate records using multiple identifying attributes.
- Preserve original source information.
- Keep source URLs and retrieval dates.
- Distinguish verified facts from AI-generated hypotheses.
- Use `null` when information is unknown.
- Never fill missing fields with fabricated values.
- Keep raw source data separate from qualified records.

### Evidence levels

**High confidence**

- Confirmed by an official company website, official company publication or authoritative business source.

**Medium confidence**

- Supported by multiple credible public sources, but not directly confirmed by the company.

**Low confidence**

- Based on a single indirect source, incomplete listing or unverified inference.

A low-confidence record must not be presented as a confirmed fact.

---

## 9. ICP Scoring Framework

Use a 100-point preliminary scoring model.

| Criterion                                   | Maximum |
| ------------------------------------------- | ------: |
| Business segment relevance                  |      20 |
| Evidence of commercial fleet activity       |      20 |
| Operational complexity                      |      15 |
| Geographic relevance                        |      15 |
| Evidence of recurring transport activity    |      10 |
| Potential need for fleet cost control       |      10 |
| Public business contact availability        |       5 |
| Evidence of digital or operational maturity |       5 |
| **Total**                                   | **100** |

### Preliminary classification

- 80–100: Priority A.
- 60–79: Priority B.
- 40–59: Priority C.
- Below 40: Low priority / review.

The score indicates potential commercial fit, not purchase intent.

Missing information should not be treated as negative evidence automatically. Record uncertainty and explain the score.

---

## 10. Research and Compliance Rules

The system must use responsible business research practices.

1. Prefer official company websites, public company profiles, public directories and legitimate business publications.
2. Respect source terms of service, robots restrictions, API usage policies and rate limits.
3. Do not bypass logins, paywalls, CAPTCHAs or access controls.
4. Do not scrape private groups or restricted personal profiles.
5. Do not collect sensitive personal information.
6. Do not infer private telephone numbers or personal email addresses.
7. Prefer published corporate contact channels.
8. Keep source attribution for every important factual claim.
9. Do not send unsolicited bulk messages automatically.
10. Require human review before external outreach.
11. Provide a clear way to stop further contact.
12. Apply relevant Mozambican privacy, electronic communications and data protection requirements, and applicable platform rules.

The system prepares sales intelligence and message drafts. It does not independently authorize contact or guarantee legal compliance.

---

## 11. Outreach Standards

All generated messages must:

- Be written in professional Portuguese appropriate for Mozambique by default.
- Use natural business language.
- Avoid exaggerated claims.
- Avoid generic mass-marketing expressions.
- Reference only verified information about the company.
- Explain a relevant FleetOps MZ benefit.
- Be concise and respectful.
- Have one clear call to action.
- Avoid claiming that FleetOps MZ has integrations or capabilities that are not confirmed as available.

English may be used when the target company communicates primarily in English.

### Preferred call to action

Request a short meeting or product demonstration to understand the company's operational needs.

### Human approval

Every outreach message must be reviewed and approved by a person before it is sent.

---

## 12. Output Requirements

### Agent 1 output

Save normalized qualified company records to:

`data/qualified/`

Recommended outputs:

- `qualified_companies.json`
- `qualified_companies.csv`
- `qualification_summary.md`

### Agent 2 and Agent 3 outputs

Save research dossiers to:

`data/researched/`

Save message drafts and outreach-ready exports to:

`data/outreach_ready/`

Every stage writes into a versioned run folder (`runs/<run_id>/`).

Recommended outputs:

- One company dossier per company.
- One outreach message set per company.
- A consolidated outreach-ready CSV.
- A research summary.

Each dossier should contain:

- Company profile.
- Business segment.
- Geographic presence.
- Evidence of fleet or transport activity.
- Potential operational challenges, clearly marked as hypotheses.
- Publicly available business contacts.
- Decision-maker information, if verified.
- Source URLs and dates.
- ICP score and rationale.
- Confidence level.
- Recommended next action.

### File naming

Use safe, normalized filenames.

Example:

`beira_company-name_2026-11-12.json`

Never overwrite raw data. Preserve previous outputs or use versioned run folders.

---

## 13. Pipeline Execution

The pipeline should support:

- Processing a single company.
- Processing a CSV or JSON batch.
- Running all three agents sequentially.
- Running selected agents independently.
- Resuming interrupted processing.
- Skipping already processed records where appropriate.
- Exporting CSV and JSON.
- Producing execution summaries.

Never execute all agents against a large dataset without first testing with a small batch.

### Initial test

Start with:

- 5 raw company records.
- 5 Agent 1 outputs.
- Research on 2–3 qualified companies.
- Copywriting for the same 2–3 companies.
- Manual quality review.

Only scale after validating the outputs.

---

## 14. Business KPIs

Track both operational and commercial performance.

### Acquisition KPIs

- Companies discovered.
- Companies qualified.
- Priority A and B companies.
- Research completion rate.
- Verified business contact rate.
- Outreach messages prepared.
- Outreach messages approved.
- Outreach responses.
- Meetings booked.
- Product demonstrations completed.
- Pilot opportunities.
- Paying customers acquired.

### Quality KPIs

- Duplicate rate.
- Percentage of records with source URLs.
- Percentage of records with verified business identity.
- Percentage of records with high or medium confidence.
- Percentage of messages requiring substantial correction.

Do not optimize for the number of scraped companies. Optimize for qualified opportunities and paying customers.

---

## 15. Development Workflow for Claude Code

When working in this repository:

1. Read this `CLAUDE.md` first.
2. Read `docs/FleetOpsMZ_Commercial_Brief.md`.
3. Read the relevant agent prompt before modifying agent behavior.
4. Inspect the existing code before changing it.
5. Preserve existing architecture and working functionality.
6. Avoid unnecessary dependencies.
7. Validate inputs and outputs.
8. Add or update tests for business logic.
9. Run TypeScript checks and relevant tests.
10. Document configuration and execution commands.
11. Never run an external outreach action without explicit human approval.

### Implementation priorities

**Priority 1**

- Project setup.
- Data schemas.
- CSV and JSON import.
- Deduplication.
- Agent 1.

**Priority 2**

- Search provider integration.
- Agent 2.
- Source verification and evidence tracking.

**Priority 3**

- Agent 3.
- Message templates.
- Outreach-ready exports.

**Priority 4**

- Pipeline orchestration.
- Logging and resumability.
- Reports and commercial KPI summaries.

**Priority 5**

- Optional CRM integration and additional data providers.

---

## 16. Definition of Success

The system is successful when it consistently produces:

1. A reliable list of relevant Mozambican transport and logistics companies.
2. Evidence-backed company profiles.
3. Transparent commercial qualification scores.
4. Useful and accurate research dossiers.
5. Personalized outreach drafts.
6. A measurable flow of qualified sales opportunities.
7. A repeatable process that helps FleetOps MZ acquire and retain paying customers.

**Core principle: Evidence before assumptions. Qualified opportunities before volume. Commercial conversion before vanity metrics.**
