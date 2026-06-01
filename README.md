# factory-skills

**Your AI coding agent forgets everything between sessions. This fixes that.**

factory-skills turns errors, decisions, and patterns into persistent knowledge — so your AI agent learns from experience instead of repeating the same mistakes.

```
Session 12: "Why is this failing?"
  → Agent searches neurons → finds NE-047 (same error from Session 3)
  → Applies the fix in 30 seconds instead of 45 minutes
```

Works with **Claude Code**, **Cursor**, and **Gemini CLI**. Zero cloud dependencies — everything stays local.

---

## The problem

Your AI agent has amnesia. Every session starts from zero.

- You fix the same bug 3 times across 3 sessions
- A pattern that took 5 hours to discover vanishes when context resets
- You say "continue the migration" and the agent has no idea what migration
- Your team repeats every mistake you already solved last week

factory-skills gives your agent a memory that survives sessions, compactions, and context limits.

---

## 90-second setup

```bash
# Clone and build
git clone https://github.com/ASINOSE12345/factory-skills.git
cd factory-skills/mcp-server && npm install && npm run build

# Initialize in your project
cd /path/to/your/project
/path/to/factory-skills/bin/factory-skills init
```

That's it. The `init` command auto-detects your agent and configures everything:

- Creates the `neurons/` directory structure
- Installs the MCP server (9 tools your agent can call)
- Sets up auto-bootstrap hooks (loads knowledge at session start)
- Sets up auto-capture hooks (detects errors automatically)

**Start a new session** and your agent is already smarter.

---

## How it works

Every time your agent encounters an error, makes a decision, or spots a pattern, it creates a **neuron** — a small markdown file that captures the knowledge.

```
neurons/
├── errors/
│   ├── NE-001.md    # "Null value violates not-null constraint"
│   ├── NE-002.md    # "CSS fixed inset-0 invisible with Tailwind v4"
│   └── NE-089.md    # "HMAC verification used wrong env var name"
│
├── decisions/
│   ├── ND-001.md    # "Use Edge Functions for all public writes"
│   └── ND-067.md    # "Lead dedup at application level, not DB"
│
├── patterns/
│   ├── NP-001.md    # "Always deploy with --no-verify-jwt"
│   └── NP-005.md    # "Deploy frontend BEFORE database migration"
│
└── foundations/
    ├── NF-001.md    # "Document to persist — memory is sacred"
    └── NF-003.md    # "Evidence over intention — verify, don't assume"
```

Each neuron has YAML frontmatter (type, domain, severity, occurrences) and a markdown body (what happened, root cause, fix, rule learned). Plain text, version-controlled, yours forever.

### The three automatic hooks

| Hook | When | What it does |
|------|------|-------------|
| **Auto-bootstrap** | Session starts | Loads the 5 most recent neurons per type as context |
| **Auto-capture** | Bash command fails | Classifies the error and creates a neuron automatically |
| **MCP server** | Agent needs knowledge | 9 tools: search, think, scan, create, update counters, get stats |

### Auto-capture in action

When a Bash command fails, the auto-capture engine:

1. Classifies the error (TypeScript, ESLint, missing module, DB constraint, auth, git, build, test...)
2. Generates a fingerprint to avoid duplicates
3. Creates a new neuron or bumps occurrences on an existing one
4. If the same error hits 3+ times, suggests creating a pattern

No human intervention required. Your agent learns from every failure.

### Pattern lifecycle

Patterns earn trust through usage:

```
New (0 hits) → Validated (3+ hits) → Graduated (7+ hits) → Archived (25 idle sessions)
```

The system self-cleans. Patterns that aren't useful fade away. Patterns that prove their value get promoted.

---

## MCP Server — 9 tools

The MCP server exposes your neurons as tools any AI agent can call:

| Tool | What it does |
|------|-------------|
| `search_neurons` | Keyword search across all neurons with relevance scoring |
| `think_neurons` | Like `search_neurons`, plus a deterministic, read-only gap report: stale, superseded, near-duplicate, unreliable patterns, project-mix |
| `dream_scan` | Read-only, corpus-wide health scan (not query-driven): near-duplicates, superseded, stale, unreliable patterns, unknown-scope. Proposals only — no writes, no LLM |
| `get_neuron` | Read the full content of a specific neuron |
| `create_neuron` | Create a new neuron (error, decision, pattern, foundation) |
| `update_pattern_counter` | Record a hit or miss — drives lifecycle gates |
| `get_bootstrap` | Get recent neurons formatted for session injection |
| `get_stats` | Aggregate stats: counts per type, domains, total |
| `list_patterns` | List all patterns with lifecycle status and counters |

The MCP server is configured automatically by `init`. To add it manually:

```json
{
  "mcpServers": {
    "factory-neurons": {
      "command": "node",
      "args": ["/path/to/factory-skills/mcp-server/dist/server.js", "/path/to/your/project"]
    }
  }
}
```

### Read-only CLI: `dream-scan`

A deterministic, corpus-wide health scan you can run from the terminal:

```bash
dream-scan <projectRoot|neuronsDir> --threshold 0.93 --max-pairs 100 --format json
```

Surfaces near-duplicates, superseded, stale, unreliable patterns, and unknown-scope neurons. Accepts a project root or a `neurons/` dir. **Read-only — proposals only, no LLM, writes nothing.**

---

## What a session looks like

```
Session Start
    │
    ▼
[Bootstrap] ── Hook fires → loads 5 recent errors, 5 decisions, 5 patterns
    │
    ▼
[Work] ──────── search_neurons("null constraint") → finds NE-001 with the fix
    │           Bash fails with TS2304 → auto-capture creates NE-090
    │           Agent chooses architecture → create_neuron("decisions", ...)
    │           Agent notices recurring issue → create_neuron("patterns", ...)
    │
    ▼
[End] ───────── update_pattern_counter(NP-003, hit) → validated
                Next session starts informed, not blind
```

---

## Real numbers

Built and battle-tested across 3 production projects:

| Metric | Value |
|--------|-------|
| Sessions tested | 35+ |
| Error neurons (NE) | 260 |
| Decision neurons (ND) | 237 |
| Pattern neurons (NP) | 13 |
| Foundation neurons (NF) | 10 |
| **Total neurons** | **520** |
| Lost context incidents (post-implementation) | **0** |

---

## Manual setup

If you prefer manual control, or use an agent other than Claude Code:

<details>
<summary>Copy skills to your project (teams)</summary>

```bash
mkdir -p .claude/skills
cp -r /path/to/factory-skills/neuron-system .claude/skills/
cp -r /path/to/factory-skills/project-memory .claude/skills/
```
</details>

<details>
<summary>Copy skills globally (solo developers)</summary>

```bash
cp -r /path/to/factory-skills/neuron-system ~/.claude/skills/
cp -r /path/to/factory-skills/project-memory ~/.claude/skills/
```
</details>

<details>
<summary>Other agents (Cursor, Codex, Gemini CLI)</summary>

```bash
# Cursor
cp factory-skills/neuron-system/SKILL.md .cursor/rules/neuron-system.md

# Gemini CLI
cp factory-skills/neuron-system/SKILL.md .gemini/instructions/neuron-system.md
```
</details>

<details>
<summary>Create neurons directory manually</summary>

```bash
mkdir -p neurons/{errors,decisions,patterns,foundations}
```
</details>

---

## Community

factory-skills has an optional community feedback loop. Your neurons stay private — you choose what to share.

### Level 1: Anonymous stats

Share aggregate counts only — zero content, zero project info.

```bash
factory-skills stats
```

### Level 2: Share patterns

Share your validated patterns, anonymized and reviewed by you before submission.

```bash
factory-skills contribute
```

Each pattern goes through automated stripping (project names, file paths, env vars, URLs removed), your manual review, and a GitHub PR you can track.

### Level 3: Foundations

Universal principles that transcend any project. Contributed via Pull Request to `community/foundations/`.

See [community/README.md](./community/README.md) for details and privacy policy.

---

## FAQ

**Do my neurons get uploaded anywhere?**
No. Everything stays in your local `neurons/` directory. The community features are opt-in and require explicit approval.

**How many neurons before it gets slow?**
Tested with 520+ neurons across 3 projects with no performance issues. The search uses relevance scoring, so only the most relevant neurons surface.

**Can I use this across multiple projects?**
Yes. Use a shared `neurons/` directory at your workspace root for cross-project knowledge, or separate directories per project.

**Does it work without Claude Code?**
Yes. The skills are plain markdown instructions. Copy the SKILL.md content into any agent's system prompt. The MCP server works with any MCP-compatible client. Auto-capture hooks are Claude Code specific.

---

## Prerequisites

- **Node.js** >= 20
- **gh CLI** — for community features only ([install](https://cli.github.com))

---

## Contributing

Found a bug? Want to add a neuron type? PRs welcome.

1. Fork the repo
2. Create your feature branch
3. Run `test/test-autocapture.sh` to verify
4. Submit a PR with evidence of the feature working

---

## License

MIT

---

Built by [JB Coding IoT](https://github.com/ASINOSE12345)
