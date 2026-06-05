---
status: proposed
date: 2026-06-05
---

# ADR-0001: Factory Knowledge Architecture

## Status

Proposed.

## Context

`factory-skills` is currently documented as a local-first knowledge toolkit for AI agents: it stores durable neurons, exposes MCP tools, runs hooks, scans the corpus, reflects on knowledge, and keeps live writes gated by default.

`factory-os` is documented separately as the Software Factory Operating System: a multi-AI platform with a neural moat, self-control loop, collaboration layer, governance triangle, tenant-scoped access model, registries, learning rights, and future neuron migration.

The project registry in `mcp-server/config/projects.json` is a first, inert map of observed project/repo aliases. It is useful, but it is still a flat project registry. It does not yet model the real ontology behind Factory: company ownership, memory, skills/tooling, runtime OS, clients, projects, repos, and source lineage.

The Paperclip case exposed the limitation. Paperclip was not a Factory project or client. It was a previous external operating system/orchestrator used by Factory, studied during the JBCodingIoT work, and later replaced by the first-party FactoryOS direction. Paperclip knowledge must be preserved as lineage, not modeled as a `project_id`.

## Options Considered

### Option A — Treat `factory-skills` as FactoryOS

Rejected. `factory-skills` is documented and implemented as a local-first memory/tooling layer for agents. It exposes MCP tools, hooks, CLIs, scanners, reflection, redaction, gates, and guarded write paths. It is not the product runtime that operates companies, tenants, projects, UI, adapters, cost ledgers, RLS, or workflow state.

### Option B — Store all knowledge directly inside FactoryOS

Rejected. FactoryOS is the operating system/runtime. Storing the memory only inside FactoryOS would couple the knowledge substrate to one consumer and make it harder for Claude Code, Codex, jobs, dashboards, APIs, or future runtimes to use the same memory.

### Option C — Keep a flat project registry as the final model

Rejected as a final architecture. A flat `project_id` registry is useful for the current coverage auditor and alias cleanup, but it cannot accurately represent organization ownership, Factory Memory, Factory Skills, FactoryOS, clients, projects, repos, and source-lineage tools such as Paperclip.

### Option D — Separate Factory Memory, Factory Skills, and FactoryOS

Accepted. This preserves the current implementation while giving future registry and scope work a richer ontology.

## Decision

Use this conceptual split:

- **JB Coding IoT** is the parent company / owner.
- **Factory** is the knowledge and intelligence platform owned by JB Coding IoT.
- **Factory Memory** is the persistent knowledge substrate: neurons, embeddings, registry data, lineage, and audit context.
- **Factory Skills** is the cognitive toolkit over Factory Memory: MCP tools, search, thinking, reflection, scans, coverage, embeddings, redaction, gates, and guarded write paths.
- **FactoryOS** is the first-party operating system/runtime that consumes Factory Skills and Factory Memory to operate clients and projects.
- **Paperclip** is a legacy/source-lineage system: the previous external orchestrator used by Factory, not a project and not a client.
- **Clients and projects** such as UrbanVista Capital, PeopleSynapse, Olgui's Class, and future clients generate memory into Factory and are operated through FactoryOS.

The registry is semantic classification. It is not ownership, access control, or runtime authorization. A neuron's `project` or `scope` describes what the neuron is about; it does not decide who may consume it. FactoryOS may consume all relevant knowledge through Factory Skills, subject to future privacy, tenant, and policy controls.

## Conceptual Hierarchy

```text
JB Coding IoT
└── Factory
    ├── Factory Memory
    │   ├── neurons
    │   ├── embeddings
    │   ├── registry
    │   └── lineage / audit context
    ├── Factory Skills
    │   ├── MCP tools
    │   ├── search / think / reflect / scan
    │   ├── coverage auditor
    │   ├── embeddings tooling
    │   ├── redaction
    │   └── gates / guarded writes
    ├── Paperclip
    │   └── legacy external orchestrator / source lineage
    └── FactoryOS
        └── operating system that consumes Factory Skills + Factory Memory

Clients / domains operated through FactoryOS:
├── UrbanVista Capital
├── PeopleSynapse
├── Olgui's Class
└── future clients such as Cartones SA
```

## Definitions

- **Organization / owner**: the company that owns the platform. Here: JB Coding IoT.
- **Factory**: the knowledge/intelligence platform, not just one repository.
- **Factory Memory**: the persistent memory layer where knowledge is stored and classified.
- **Factory Skills**: the reusable toolkit that reads, audits, reasons over, and governs Factory Memory.
- **FactoryOS**: the operating system/runtime that applies Factory knowledge to real client and project work.
- **Client / tenant**: a business context operated through FactoryOS.
- **Project**: a specific domain of work inside a client or internal product.
- **Repo**: a source-code repository or checkout that may implement a project or component.
- **Source lineage**: historical/source tool context, such as Paperclip, that explains where a lesson came from without making that source a project.
- **Global intelligence**: curated, reusable knowledge that is safe and useful beyond one tenant/project.

## Registry Implications

The current `projects.json` remains valid as registry v1. It maps observed projects, aliases, and repos, and it is intentionally inert until adoption work is done.

Future registry evolution should be additive and backward-compatible. Do not break the current loader or project-coverage auditor. Candidate optional fields for a registry v2:

- `entity_type`: `organization | platform | memory | toolkit | operating_system | client | project | repo | source_lineage`
- `owner_id`
- `parent_id`
- `tenant_id`
- `project_id`
- `repo_id`
- `visibility`: `global | tenant_private | project_private | internal | public_pattern`
- `lineage` / `source_tool`
- `status`: `active | archived | legacy | external`
- `aliases`

This allows `factory-skills` to keep the current project-level behavior while preparing for a richer Factory Memory model.

## Current Implementation Boundaries

Current implementation facts:

- `factory-skills` remains local-first and zero-cloud by default.
- `mcp-server/config/projects.json` is registry v1 and is still inert for live MCP scope resolution.
- The project-coverage auditor can measure registry projection with `--registry`.
- Live write tools remain gated.
- CP3 staged writes remain inert unless explicitly configured.
- FactoryOS currently has its own runtime architecture, registries, tenant-scoped access model, and future neuron migration path.

Future/multi-tenant language in this ADR is architectural direction, not a claim that all commercial tenant isolation and promotion policy is implemented today.

## Memory and Reuse Model

Factory stores all neurons. FactoryOS consumes Factory Memory through Factory Skills.

Project-specific and tenant-specific memory must remain scoped. FactoryOS can use that scoped knowledge when operating in the matching context. It should not blindly apply private client context to another tenant.

Reusable lessons can be promoted into global intelligence only after privacy, redaction, and abstraction checks. Globalizing knowledge means extracting safe patterns, not leaking private client data.

A safe promotion flow is:

```text
project-specific neuron
→ candidate reusable pattern
→ privacy / redaction review
→ global neuron
→ reusable by FactoryOS across tenants and projects
```

## Paperclip Decision

Paperclip was the previous external operating system/orchestrator used by Factory. It is source lineage, not a `project_id`.

Paperclip-related neurons should preserve the Paperclip relationship in fields such as `domain`, `component`, `tags`, or text. If the work happened in the JBCodingIoT context, the semantic project may be `jbcodingiot`; Paperclip remains the source/tool lineage.

Do not add Paperclip to `projects.json` as a project.

## Consequences

Positive consequences:

- Avoids mixing company, platform, memory, toolkit, runtime, clients, projects, repos, and tools.
- Keeps Factory Skills reusable by FactoryOS and other consumers such as Claude Code, Codex, jobs, dashboards, or APIs.
- Preserves the current local-first `factory-skills` behavior while allowing Factory Memory to evolve.
- Prevents the registry from becoming an accidental ownership or access-control mechanism.
- Provides a path toward multi-tenant memory without requiring an immediate migration.

Trade-offs:

- Delays wiring `neurons.ts` directly to the registry until the ontology is stable.
- Requires additive schema evolution before full registry adoption.
- Leaves the current `projects.json` as a v1 project/repo map rather than the final Factory Memory registry.

## Implications for Next PRs

- PR-3C should not wire the flat registry as final truth without preserving this ontology.
- The next registry work should extend schema additively, or explicitly document why v1 fields are enough for a narrow slice.
- The coverage auditor should eventually report organization/platform/client/project/lineage coverage separately.
- `neurons.ts` should consume registry data only with a no-loss gate against current scope resolution.
- Corpus re-scope work remains separate from registry wiring.

## Runtime Guardrails

Any PR that changes registry or neuron scope resolution must preserve these guardrails:

- Do not treat `project` or `scope` as ownership or access control.
- Do not make Paperclip a project.
- Do not collapse `factory`, `softwarefactory`, and `factory-os` into one meaning.
- Keep global knowledge distinct from tenant/project-specific memory.
- Preserve lineage when extracting reusable patterns.
- Prove no-loss behavior before replacing seed aliases or changing live MCP scope resolution.

## Non-Goals

- No corpus migration in this ADR.
- No Paperclip neuron re-scope in this ADR.
- No live writes or CP3 activation.
- No runtime, MCP config, embedding, or hook changes.
- No seed deletion from `neurons.ts`.
- No privacy enforcement implementation.

## Open Questions

- What is the exact tenant/client model for commercial FactoryOS deployments?
- Who approves promotion from tenant/project memory to global intelligence?
- How should private client knowledge be represented and enforced?
- Should Factory Memory remain one central multi-tenant store, support per-client deployments, or both?
- How should derived global neurons link back to source lineage without leaking sensitive context?
- Should FactoryOS be the only privileged runtime consumer, or one of several consumers of Factory Skills?

## Conexiones

- `mcp-server/config/projects.json`
- `mcp-server/src/registry.ts`
- `mcp-server/src/project-coverage-cli.ts`
- future `neurons.ts` registry wiring
- FactoryOS README / architecture
