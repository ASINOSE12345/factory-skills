# Factory Skills

**Persistent learning and memory skills for AI coding agents.**

Your AI agent forgets everything when a session ends. These skills fix that — turning every error, every decision, and every pattern into institutional knowledge that persists and improves across sessions.

Built by [JB Coding IoT](https://github.com/ASINOSE12345) — battle-tested across 35+ sessions, 520+ neurons, and 3 production projects.

---

## The Problem

AI coding agents (Claude Code, Cursor, Codex, Gemini CLI) have a fundamental limitation: **they forget everything between sessions**. Every new session starts from zero.

This means:
- You fix the same bug 3 times across 3 sessions
- You forget why you chose architecture A over B last month
- A pattern that took 5 hours to discover vanishes when context compacts
- New team members repeat every mistake the team already solved
- You say "continue the migration" and the agent has no idea what migration

**Factory Skills solves this with two complementary systems:**

| Skill | What it does | Analogy |
|-------|-------------|---------|
| **neuron-system** | Captures errors, decisions, and patterns as persistent knowledge | The team's *institutional memory* |
| **project-memory** | Tracks project state across sessions (PRs, board, version, next steps) | The team's *daily standup notes* |

Together, they make your AI agent **learn from experience** and **never lose context**.

---

## Skills

### [neuron-system](./neuron-system/) — Learn from every session

Turn your AI agent into a learning system that gets smarter over time.

**How it works:** Every time your agent encounters an error, makes a decision, or spots a pattern, it creates a "neuron" — a small markdown file that captures the knowledge. Next session, when the agent encounters a similar situation, the neuron is recalled and the knowledge is applied instantly.

- **4 neuron types**: Errors (NE), Decisions (ND), Patterns (NP), Foundations (NF)
- **Auto-validation**: Patterns must prove their value through hit/miss counters before becoming rules
- **Self-cleaning**: Unused patterns automatically archive after 25 idle sessions
- **Your neurons are yours**: The skill teaches the *system*; you create your own *experience*

### [project-memory](./project-memory/) — Never lose context again

Keep track of where you left off, across sessions, across days, across context compactions.

**How it works:** Two mandatory ceremonies — read state at session start (bootstrap), capture results at session end (close). A living `PROJECT_MEMORY.md` document tracks everything: current version, open PRs, board state, errors resolved, and next steps.

- **Bootstrap protocol**: Read project state BEFORE any action
- **Close protocol**: Capture results BEFORE ending session
- **Two-level architecture**: PROJECT_MEMORY.md per project + MEMORY.md global index
- **Single source of truth**: One living document per project, no duplicate systems

---

## Quick Start (5 minutes)

### Step 1: Clone the repo

```bash
git clone https://github.com/ASINOSE12345/factory-skills.git
```

### Step 2: Choose your integration method

#### Option A: Project-level (recommended for teams)

Add the skills to a specific project. Every session in that project will use them.

```bash
# From your project root
mkdir -p .claude/skills

# Copy the skills you want
cp -r /path/to/factory-skills/neuron-system .claude/skills/
cp -r /path/to/factory-skills/project-memory .claude/skills/
```

#### Option B: Global (recommended for solo developers)

Add the skills to your global Claude config. Every session, in every project, will use them.

```bash
# Copy to global skills directory
cp -r /path/to/factory-skills/neuron-system ~/.claude/skills/
cp -r /path/to/factory-skills/project-memory ~/.claude/skills/
```

#### Option C: Other AI agents (Cursor, Codex, Gemini CLI)

The skills are plain markdown. Copy the `SKILL.md` content into your agent's system prompt, instruction file, or rules file.

```bash
# For Cursor: copy into .cursor/rules/
cp factory-skills/neuron-system/SKILL.md .cursor/rules/neuron-system.md
cp factory-skills/project-memory/SKILL.md .cursor/rules/project-memory.md

# For Codex: copy into codex instructions
# For Gemini CLI: copy into .gemini/instructions/
```

### Step 3: Create the neurons directory

```bash
# From your project root (or factory root if using globally)
mkdir -p neurons/{errors,decisions,patterns,foundations}
```

### Step 4: Create your PROJECT_MEMORY.md

```bash
# Per project
mkdir -p .factory/outputs
touch .factory/outputs/PROJECT_MEMORY.md
```

Initialize it with:

```markdown
# {YourProject} — PROJECT MEMORY
**Last updated**: YYYY-MM-DD

## Current State
- **Version**: v1.0.0
- **Branch**: main

## Next Steps
1. (your first task)
```

### Step 5: Add bootstrap instructions to your project's CLAUDE.md

Add this to your project's root instruction file (CLAUDE.md, .cursorrules, etc.):

```markdown
## Session Bootstrap (MANDATORY — run BEFORE any action)

1. Read the 5 most recent neurons:
   ```bash
   ls -lt neurons/errors/ | head -5
   ls -lt neurons/decisions/ | head -5
   ls -lt neurons/patterns/ | head -5
   ```
2. Read PROJECT_MEMORY.md for current state
3. Do NOT execute any action until steps 1-2 complete

## Session Close (MANDATORY — run BEFORE ending)

1. Create neurons for new errors (NE-xxx) and decisions (ND-xxx)
2. Update PROJECT_MEMORY.md with what happened and what's next
3. Update pattern counters (hits/misses)
```

### Step 6: Start a session

That's it. Your agent will now:
1. **Read** existing neurons and project state at session start
2. **Create** new neurons as it encounters errors and makes decisions
3. **Save** everything at session end

Each session builds on the last. Your neurons directory will grow with your project's unique knowledge.

---

## How They Work Together

```
Session Start
    │
    ▼
[Bootstrap] ── Read PROJECT_MEMORY.md (where did I leave off?)
    │           Read recent neurons (what do I already know?)
    │
    ▼
[Work] ──────── Agent encounters error → creates NE-045
    │           Agent makes architecture decision → creates ND-023
    │           Agent notices recurring pattern → creates NP-007
    │
    ▼
[Close] ─────── Update PROJECT_MEMORY.md (what happened today?)
                Update pattern counters (did old patterns help?)
                Next session starts informed, not blind
```

---

## What Your Neurons Directory Looks Like After 30 Sessions

```
neurons/
├── errors/
│   ├── NE-001.md    # "Null value violates not-null constraint"
│   ├── NE-002.md    # "CSS fixed inset-0 invisible with Tailwind v4"
│   ├── ...
│   └── NE-089.md    # "HMAC verification used wrong env var name"
│
├── decisions/
│   ├── ND-001.md    # "Use Edge Functions for all public writes"
│   ├── ND-002.md    # "JWT auth in middleware, not per-route"
│   ├── ...
│   └── ND-067.md    # "Lead dedup at application level, not DB constraint"
│
├── patterns/
│   ├── NP-001.md    # "Always deploy with --no-verify-jwt"
│   └── NP-005.md    # "Deploy frontend BEFORE DB migration"
│
└── foundations/
    ├── NF-001.md    # "Memory is Sacred — document to persist"
    └── NF-003.md    # "Evidence over intention — verify, don't assume"
```

Every file is yours. Every neuron reflects your project's unique challenges and solutions. The skill taught the system; the knowledge is entirely yours.

---

## Numbers (from our production usage)

| Metric | Value |
|--------|-------|
| Sessions tested | 35+ |
| Error neurons (NE) | 260 |
| Decision neurons (ND) | 237 |
| Pattern neurons (NP) | 13 |
| Foundation neurons (NF) | 10 |
| **Total neurons** | **520** |
| Cross-project patterns | 22 |
| Production projects | 3 |
| Lost context incidents (post-implementation) | **0** |

---

## FAQ

**Q: Do I need both skills?**
A: They work best together, but you can use either one independently. `neuron-system` alone gives you learning; `project-memory` alone gives you state persistence.

**Q: Will my neurons be shared or uploaded anywhere?**
A: No. Your neurons live in your local `neurons/` directory. They are your project's private knowledge. The skill is the logic; the neurons are your data.

**Q: Does this work with agents other than Claude Code?**
A: Yes. The skills are plain markdown instructions. Copy the SKILL.md content into any agent's system prompt or instruction file.

**Q: How many neurons before it gets slow?**
A: We've tested with 520+ neurons across 3 projects with no performance issues. The NeuronRouter uses relevance scoring, so only the most relevant neurons are loaded per session.

**Q: Can I use this across multiple projects?**
A: Yes. Use a shared `neurons/` directory at your workspace root for cross-project knowledge, or separate directories per project for isolation.

---

## Community — Help the System Get Smarter

Factory Skills has an optional community feedback loop. Your neurons stay private — but you can choose to share anonymized insights that help everyone.

### Level 1: Anonymous Stats (passive)

Share aggregate counts — zero content, zero project info.

```bash
# Install the CLI (one-time)
chmod +x bin/factory-skills

# Run from your project root (where neurons/ lives)
factory-skills stats
```

What gets shared: neuron counts per type, session count, top domains. That's it.

### Level 2: Community Patterns (opt-in)

Share your pattern neurons (NP-*.md), anonymized and reviewed by you before submission.

```bash
factory-skills contribute
```

Each pattern goes through:
1. **Automated stripping** — project names, file paths, issue refs, dates all removed
2. **Your review** — you see the exact anonymized version and approve/skip/edit each one
3. **PR submission** — creates a Pull Request you can track on GitHub

### Level 3: Curated Foundations (manual)

Universal principles that transcend any single project. Contributed via Pull Request to `community/foundations/`.

See [community/README.md](./community/README.md) for full details, privacy policy, and contribution guidelines.

### Prerequisites

- [gh CLI](https://cli.github.com) — installed and authenticated (`gh auth login`)
- A `neurons/` directory in your project

---

## Contributing

Found a bug? Want to add a neuron type? PRs welcome.

1. Fork the repo
2. Create your feature branch (`git checkout -b feature/new-neuron-type`)
3. Test the skill in your own environment
4. Submit a PR with evidence of the skill working

---

## License

MIT

---

Built with care by **JB Coding IoT** — makers of [PeopleSynapse](https://github.com/ASINOSE12345/PeopleSynapse), [UrbanVista Capital](https://github.com/ASINOSE12345/UrbanVistaCapital-portal-inmobiliario), and [Olgui's Class](https://github.com/ASINOSE12345/Olgui-s_Class).
