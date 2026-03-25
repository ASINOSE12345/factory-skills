---
name: project-memory
description: |
  Structured session persistence for AI coding agents. Implements mandatory bootstrap
  (read state before acting) and close (capture results before ending) protocols.
  Maintains a living PROJECT_MEMORY.md per project and a factory-level MEMORY.md index.
  Prevents the "what was I doing?" problem across context compactions and session restarts.
triggers:
  - session start (mandatory bootstrap)
  - session end (mandatory close)
  - context compaction detected
  - switching between projects
  - user asks "what's the current state?"
version: 1.0.0
author: JB Coding IoT (factory@jbcoding.io)
license: MIT
tags: [memory, persistence, session-management, context, project-management, state-tracking]
---

# Project Memory — Never Lose Context Again

> Context compacts every ~3 hours. Without persistent memory, your AI agent forgets everything. This skill makes forgetting impossible.

## What This Skill Does

Project Memory implements a **two-ceremony system** — bootstrap at session start, close at session end — that keeps a living document of project state. When context compacts or a new session starts, the agent reads this document first and knows exactly where things stand.

### The Problem It Solves

Without session persistence:
- Agent starts fresh → re-explores entire codebase → wastes 20 minutes
- You say "continue the migration" → agent has no idea what migration
- PR was half-done yesterday → agent creates a new branch instead of finishing
- 3 sessions later, nobody knows which issues are really done vs "done"

With Project Memory:
- Agent reads PROJECT_MEMORY.md → knows current sprint, open PRs, pending issues
- You say "continue" → agent picks up exactly where it left off
- Every session builds on the last one — no wasted work

---

## Architecture

### Two Levels of Memory

```
Factory Root (cross-project)
├── MEMORY.md              ← Index of all memories + session log
├── memory/
│   ├── user_*.md          ← Who you are, preferences, role
│   ├── feedback_*.md      ← How to approach work (corrections + confirmations)
│   ├── project_*.md       ← Ongoing initiatives, deadlines, decisions
│   └── reference_*.md     ← Where to find things in external systems
│
└── ProjectA/
    └── .factory/outputs/
        └── PROJECT_MEMORY.md  ← Living state document for this project
```

| Level | Scope | What It Contains |
|-------|-------|-----------------|
| **MEMORY.md** | All projects | Quick reference, key paths, conventions, session logs, operator tasks |
| **PROJECT_MEMORY.md** | Single project | Version, PRs, board state, backlog, errors, DB changes, next steps |

---

## Setup

### 1. Create the memory structure

```bash
# Factory-level
mkdir -p .claude/projects/memory

# Per-project
mkdir -p ProjectA/.factory/outputs
touch ProjectA/.factory/outputs/PROJECT_MEMORY.md
```

### 2. Initialize PROJECT_MEMORY.md

```markdown
# ProjectName — PROJECT MEMORY
**Last updated**: YYYY-MM-DD HH:MM

## Current State

### Version
- **main**: v1.0.0
- **staging**: v1.0.1 (2 commits ahead)

### Active PRs
| PR | Description | Status |
|----|-------------|--------|
| #12 | Add auth middleware | In review |

### Board State
| Column | Count | Notes |
|--------|-------|-------|
| Backlog | 15 | Prioritized |
| In Progress | 2 | #12, #14 |
| Done | 8 | This sprint |

## Errors Resolved This Session
_None yet_

## Next Steps
1. Finish PR #12 review
2. Start #15 (payment integration)
```

### 3. Add ceremonies to CLAUDE.md

```markdown
## Session Bootstrap (MANDATORY — run BEFORE any action)

1. Read PROJECT_MEMORY.md for current state
2. Read last 5 neurons (if using neuron-system skill)
3. Check board/issue tracker state
4. **Do NOT execute any action until bootstrap completes**

## Session Close (MANDATORY — run BEFORE ending)

1. Update PROJECT_MEMORY.md with:
   - Issues worked and their final status
   - Files modified and why
   - Errors encountered and how resolved
   - What's pending for next session
2. Create neurons for new errors/decisions (if using neuron-system skill)
3. Verify board reflects reality
```

---

## PROJECT_MEMORY.md — Complete Template

```markdown
# {ProjectName} — PROJECT MEMORY
**Last updated**: YYYY-MM-DD HH:MM UTC

## Current State — Post-Sprint {N}

### Version
- **Canonical**: vX.Y.Z
- **staging**: vX.Y.Z (N commits ahead of main)
- **main**: vX.Y.Z
- **package.json**: X.Y.Z

### Active PRs
| PR | Description | Status | Blockers |
|----|-------------|--------|----------|
| #N | Description | Draft/Review/Approved | None |

### Board State (verified)
| Column | Count | Notable Issues |
|--------|-------|---------------|
| Backlog | N | |
| Ready | N | |
| In Progress | N | #X, #Y |
| In Review | N | PR #Z |
| Done | N | This sprint |

### Current Backlog (prioritized)
| # | Type | Summary | Priority |
|---|------|---------|----------|
| 1 | Bug | Auth timeout on mobile | P1 |
| 2 | Feature | Dark mode toggle | P2 |

## Session History

### Session YYYY-MM-DD — {Sprint/Task Name}

**Worked on:**
| Issue | Result | PR |
|-------|--------|-----|
| #12 | Completed | PR #34 merged |
| #15 | In progress | Draft PR #36 |

**Errors encountered:**
- NE-045: Supabase RLS blocked insert → fixed with policy update

**Files modified:**
- `src/auth/middleware.ts` — Added session refresh logic
- `supabase/migrations/20260325_rls.sql` — New RLS policy

**Pending for next session:**
1. Finish PR #36 (payment integration)
2. Run e2e tests for auth flow
3. Deploy staging and smoke test

## DB Changes (production)
| Date | Change | Migration |
|------|--------|-----------|
| 2026-03-25 | Added `payments` table | 20260325_payments.sql |

## Secrets & Config
| Key | Status | Notes |
|-----|--------|-------|
| STRIPE_SECRET_KEY | Missing | Needed for #15 |
| SUPABASE_URL | Configured | .env.local |
```

---

## MEMORY.md — Factory-Level Index

```markdown
# Factory Memory Index

## Quick Reference
- **Root**: /path/to/factory
- **Projects**: ProjectA (portal), ProjectB (SaaS)
- **Policy**: path/to/policy.yaml

## Key Memories
- [User role and preferences](memory/user_role.md)
- [Feedback: always use Spanish](memory/feedback_language.md)
- [Project A: current sprint](memory/project_a_sprint.md)

## Projects
- **ProjectA**: React+Vite, Supabase, Board #8
  - State: Sprint 3, 5 issues in progress
  - Next: Payment integration (#15)
- **ProjectB**: React+Express+MongoDB
  - State: Security hardening, 3 PRs pending

## Session Log (current)
| Issue | Result | PR |
|-------|--------|-----|
| #12 | Completed | #34 |

## Operator Pending
- [ ] Review PR #36 (payment integration)
- [ ] Add STRIPE_SECRET_KEY to production
```

---

## Memory Types (in memory/ folder)

Each memory is a separate `.md` file with frontmatter:

### User Memory
```markdown
---
name: user-role
description: Developer role and expertise level
type: user
---
Senior full-stack developer. Deep React/TypeScript expertise.
New to Supabase Edge Functions. Prefers Spanish communication.
```

### Feedback Memory
```markdown
---
name: feedback-no-mocks
description: Never use mocks in integration tests
type: feedback
---
Integration tests must hit a real database, not mocks.
**Why:** Prior incident where mock/prod divergence masked a broken migration.
**How to apply:** Any test that verifies data persistence must use real DB.
```

### Project Memory
```markdown
---
name: project-merge-freeze
description: Merge freeze for mobile release
type: project
---
Merge freeze begins 2026-03-28 for mobile release cut.
**Why:** Mobile team is cutting a release branch, conflicts would block them.
**How to apply:** Flag any non-critical PR work scheduled after that date.
```

### Reference Memory
```markdown
---
name: reference-linear-bugs
description: Bug tracker location
type: reference
---
Pipeline bugs are tracked in Linear project "INGEST".
All CI failures should be cross-referenced there before investigating.
```

---

## Rules

### Bootstrap is Non-Negotiable
The bootstrap protocol runs BEFORE any action — not after, not "when convenient". This exists because:
- Context compacts every ~3 hours and details are lost
- Neurons and PROJECT_MEMORY are the **real** persistent memory
- Acting without reading state leads to duplicate work, wrong branches, stale PRs

### Close is Non-Negotiable
The close protocol runs BEFORE ending — not "if I remember", not "next time". This exists because:
- If you don't capture what happened, the next session starts blind
- PROJECT_MEMORY.md is the single source of truth for project state
- Session logs in MEMORY.md create an audit trail

### Single Source of Truth
- **PROJECT_MEMORY.md** is authoritative for project state
- **MEMORY.md** is authoritative for cross-project index
- If they conflict with git/board/code, update the memory docs — don't create a parallel system

---

## Anti-Patterns

| Don't | Do Instead |
|-------|-----------|
| Skip bootstrap because "I remember from last time" | Always read — context compacts unpredictably |
| Write vague close notes ("worked on stuff") | Be specific: issue numbers, file paths, error codes |
| Create multiple memory systems | One PROJECT_MEMORY per project, one MEMORY.md for factory |
| Store code patterns in memory | Use neurons for patterns; memory is for state and decisions |
| Forget to update board state | Board must reflect reality after every session |

---

## Integration with Neuron System

If you're also using the `neuron-system` skill:

| Project Memory handles | Neuron System handles |
|-----------------------|-----------------------|
| Current state (PRs, board, version) | Learned knowledge (errors, patterns) |
| Session log (what happened today) | Persistent rules (what to avoid/do) |
| Next steps (what to do tomorrow) | Relevance scoring (what to recall) |
| Operator tasks (human decisions needed) | Lifecycle gates (when to promote/archive) |

They complement each other — Project Memory is the **state**, Neuron System is the **knowledge**.

---

## Built With

Created by [JB Coding IoT](https://github.com/ASINOSE12345) — proven across 25+ sessions, 2 production projects, and 0 lost context incidents since implementation.
