---
name: neuron-system
description: |
  Persistent learning memory for AI coding agents. Captures errors (NE), decisions (ND),
  and patterns (NP) as markdown neurons with YAML frontmatter. Neurons accumulate across
  sessions, auto-validate through hit/miss counters, and get routed to agents by semantic
  relevance. Turns every debugging session into institutional knowledge.
triggers:
  - session start (bootstrap protocol)
  - session end (knowledge capture)
  - error encountered during coding
  - pattern detected across multiple issues
  - architecture decision made
version: 1.0.0
author: JB Coding IoT (factory@jbcoding.io)
license: MIT
tags: [memory, learning, patterns, debugging, knowledge-management, agent-memory]
---

# Neuron System — Persistent Learning Memory for AI Agents

> Every error you debug, every decision you make, every pattern you notice — captured, scored, and recalled when it matters.

## What This Skill Does

The Neuron System turns your AI coding agent into a **learning system** that gets smarter across sessions. Instead of losing context when a conversation ends, neurons persist as markdown files that are automatically recalled when relevant.

### The Problem It Solves

Without persistent memory:
- You fix the same bug 3 times across 3 sessions
- You forget why you chose architecture A over B last month
- A pattern that took 5 hours to discover vanishes when context compacts
- New team members repeat every mistake the team already solved

With neurons:
- First occurrence → create NE-001 neuron
- Second occurrence → neuron auto-recalled, fix applied in minutes
- Third occurrence → pattern promoted to validated rule
- Every session makes the system smarter

---

## Core Concepts

### 4 Neuron Types

| Type | Prefix | Purpose | Lifespan |
|------|--------|---------|----------|
| **Error** | `NE-###` | Runtime errors, bugs, CI failures | Episodic — decays if not hit |
| **Decision** | `ND-###` | Architecture choices, trade-offs, rationale | Episodic — decays if not hit |
| **Pattern** | `NP-###` | Recurrent clusters across multiple issues | Long-lived — validated statistically |
| **Foundation** | `NF-###` | Universal axioms, team principles | Immortal — never decays |

### Neuron Lifecycle

```
[Error occurs] → NE-001 created (status: new)
                     ↓
[Same error in another session] → occurrences++
                     ↓
[3+ hits across 10+ sessions] → promoted to VALIDATED
                     ↓
[7+ hits across 20+ sessions] → promoted to GRADUATED (becomes team rule)
                     ↓
[0 hits in 25+ sessions] → ARCHIVED (stale knowledge)
```

---

## Setup

### 1. Create the neurons directory

```bash
mkdir -p neurons/{errors,decisions,patterns,foundations}
```

### 2. Add to your CLAUDE.md (or equivalent agent config)

Add this to your project's root instruction file:

```markdown
## Session Bootstrap (run BEFORE any action)

1. Read the 5 most recent neurons:
   ```bash
   ls -lt neurons/errors/ | head -5
   ls -lt neurons/decisions/ | head -5
   ls -lt neurons/patterns/ | head -5
   ```
2. Read PROJECT_MEMORY.md for current state
3. Do NOT execute any action until bootstrap completes

## Session Close (run BEFORE ending)

1. Create neurons for new errors (NE-xxx) and decisions (ND-xxx)
2. Update pattern counters (hits/misses/sessions_seen)
3. Evaluate lifecycle gates (promotion/archival)
4. Update PROJECT_MEMORY.md with session results
```

### 3. Define lifecycle constants

Add to your governance config:

```yaml
pattern_lifecycle_gates:
  constants:
    validated_min_hits: 3          # new → validated
    validated_min_sessions: 10
    graduated_min_hits: 7          # validated → graduated
    graduated_min_sessions: 20
    graduated_requires_operator: true
    archival_min_sessions_idle: 25 # sessions without hit → archive
    max_active_patterns: 40        # capacity ceiling
    trend_threshold_pct: 20        # ±20% for direction
```

---

## Neuron Format

### Error Neuron (NE-xxx)

```markdown
---
tags: [neuron, error, <domain>]
type: error-memory
project: <ProjectName>
component: <component-domain>
severity: p0|p1|p2|p3
occurrences: 1
status: new
created: 2026-03-25
---

# NE-001: Null value in column violates not-null constraint

## What happened
INSERT into `leads` table failed with HTTP 500.

## Root cause
Edge Function assumed `metadata` column was nullable. It has NOT NULL constraint.

## Fix applied
Default JSONB columns to `{}`, TEXT to `''`, arrays to `'{}'`.

## Rule learned
Always check `information_schema.columns` for NOT NULL before any INSERT.

## Connections
- [[ND-005]] — Decision to add default values
- [[#32]] — Original issue
```

### Decision Neuron (ND-xxx)

```markdown
---
tags: [neuron, decision, architecture]
type: decision-memory
project: <ProjectName>
component: <component-domain>
created: 2026-03-25
---

# ND-001: Use Edge Functions for all public writes

## Context
Frontend was inserting directly to Supabase client, bypassing notification pipeline.

## Alternatives considered
- A) Direct Supabase inserts (fast, but no emails/webhooks)
- B) Edge Function proxy (slower, but full pipeline)

## Decision
Option B — all public writes go through Edge Functions.

## Result
Notification pipeline works. Emails sent. WhatsApp alerts triggered.
```

### Pattern (in CLAUDE.md)

```markdown
<!-- pattern-meta id: PAT-UV-001 | status: new | hits: 0 | misses: 0 | sessions_seen: 0 | added: 2026-03-25 | last_hit: null | source_errors: [NE-001] | domain: database end-meta -->

### PAT-UV-001: Always check NOT NULL constraints before INSERT
**When**: Writing an INSERT into any database table
**Symptom**: HTTP 500, null value violates not-null constraint
**Why**: Functions assume columns are nullable when they're not
**Detect BEFORE**: Check schema columns before writing INSERT
**Fix**: Default JSONB→`{}`, TEXT→`''`, arrays→`'{}'`, timestamps→`now()`
**Evidence**: NE-001, leads table, 2026-03-25
```

---

## NeuronRouter — Semantic Relevance Scoring

When an agent starts a task, the NeuronRouter scores all neurons and injects the most relevant ones into the prompt.

### Scoring Formula

```
score = (keyword_relevance × 3.0 + occurrence_score × 1.0)
        × temporal_decay
        × agent_affinity
        × status_multiplier
        × scope_bonus
```

### Scoring Dimensions

| Dimension | How It Works |
|-----------|-------------|
| **Keyword Relevance** | Word overlap between task description and neuron content (0-1) |
| **Temporal Decay** | Foundation neurons = immortal (1.0). Project neurons = exponential decay with 30-day half-life |
| **Occurrences** | `log(occurrences + 1)` — more hits = higher confidence |
| **Agent Affinity** | 1.3x bonus if neuron was created by the same agent type |
| **Status Multiplier** | validated: 1.5x, applied: 1.3x, new: 1.0x |
| **Scope Bonus** | Factory-wide neurons: 1.2x (universal knowledge valued higher) |

### Risk-Aware Thresholds

Different task types have different thresholds for neuron injection:

| Task | Threshold | Rationale |
|------|-----------|-----------|
| Triage | 0.3 | Permissive — cast wide net |
| Plan | 0.5 | Moderate — relevant context |
| Implement | 0.4 | Moderate — prevent known errors |
| Review | 0.8 | Conservative — only high-confidence |
| QA | 0.7 | Conservative — validated patterns only |
| Security | 0.8 | Conservative — proven knowledge only |

---

## Session Ceremonies

### Bootstrap (session start)

1. Read 5 most recent neurons per category
2. Read PROJECT_MEMORY.md
3. Read daily note (if using Obsidian or similar)
4. Read board/issue tracker state
5. **Do NOT execute any action until steps 1-4 complete**

### Close (session end)

| Step | Action |
|------|--------|
| 1. Error Inventory | List all errors with root cause and E-code |
| 2. Pattern Scan | Classify each active pattern: HIT, MISS, or DORMANT |
| 3. Lifecycle Check | Evaluate promotion/archival gates |
| 4. New Pattern Creation | Create patterns for uncovered error clusters |
| 5. Trend Update | Update monthly error rate and direction |
| 6. Memory Update | Write counters to CLAUDE.md, session log to MEMORY.md |

### Trend Tracking

```markdown
## Session Trend

| Month    | Sessions | Errors | Rate | Direction |
|----------|----------|--------|------|-----------|
| 2026-03  | 10       | 35     | 3.5  | —         |
| 2026-04  | 12       | 20     | 1.7  | IMPROVING |
```

Direction: rate dropped >20% → IMPROVING, rose >20% → DEGRADING, within ±20% → STABLE.

---

## Cross-Project Patterns (PAT-FX-xxx)

When a pattern recurs in DIFFERENT projects, promote it to factory scope:

```markdown
### PAT-FX-001: Never define React components inside other components
**When**: Creating helper components used inside a parent
**Symptom**: Input fields lose focus after every keystroke
**Why**: Inner component gets new identity on every render → unmount/remount
**Fix**: Move to module scope. Pass data as props.
**Evidence**: UrbanVista (ConfigPage), PeopleSynapse (EntrevistaForm)
```

Factory-scope patterns have `scope_bonus: 1.2x` and never decay.

---

## Why This Works

1. **Evidence-first**: Every neuron links to real errors, real issues, real code
2. **Self-validating**: Patterns must prove their value through hits before becoming rules
3. **Anti-stale**: Unused patterns automatically archive after 25 idle sessions
4. **Scalable**: Works with 10 neurons or 10,000 — the router handles relevance
5. **Framework-agnostic**: Works with any language, any framework, any project

---

## Built With

Created by [JB Coding IoT](https://github.com/ASINOSE12345) — battle-tested across 25+ sessions, 175 error neurons, 146 decision neurons, and 2 production projects (UrbanVista Capital, PeopleSynapse).
