# Community Contributions

Factory Skills gets better when users share what they learn. This directory holds anonymized patterns and curated foundations contributed by the community.

---

## How It Works

### 3 Levels of Contribution

| Level | What | How | Privacy |
|-------|------|-----|---------|
| **1. Anonymous Stats** | Aggregate counts (neurons per type, session count, top domains) | `factory-skills stats` | Zero content transmitted. Only numbers. |
| **2. Community Patterns** | Your NP-*.md patterns, anonymized and reviewed by you | `factory-skills contribute` | Automated stripping + manual approval. You control what gets shared. |
| **3. Curated Foundations** | Universal principles (NF-*.md) written for the community | Manual PR to this repo | You write it specifically for sharing. Full control. |

---

## Privacy Policy

### What is NEVER shared
- Source code
- File paths from your project
- Project names or repo URLs
- Issue numbers or PR references
- Error messages with stack traces
- Any content from NE (error) or ND (decision) neurons
- Anything you don't explicitly approve

### Level 1 (Stats) — What IS shared
Only aggregate numbers:
- Count of neurons per type (NE: 45, ND: 30, NP: 5, NF: 2)
- Number of unique sessions
- Top domains from frontmatter (e.g., "database", "auth", "deployment")

No content, no file names, no project identifiers. Just counts.

### Level 2 (Patterns) — What IS shared
Your pattern neurons (NP-*.md), after two layers of protection:

**Layer 1 — Automated stripping:**
- `project:` field → `[redacted]`
- Issue references (`#123`, `[[#456]]`) → `[ref]`
- File paths (`src/foo/bar.ts`) → `[file]`
- Neuron cross-references (`[[NE-045]]`) → `[[NE-ref]]`
- Dates → `[date]`
- `derived_from:` and `issue:` fields → `[ref]`

**Layer 2 — Manual review:**
- You see the exact anonymized version before it's shared
- You approve (`y`), skip (`n`), or edit in your `$EDITOR` (`e`) each pattern individually
- Nothing is submitted without your explicit `[y]` confirmation

### Level 3 (Foundations) — What IS shared
Only what you write and submit yourself via a GitHub Pull Request. These are universal principles you intentionally craft for the community.

---

## Contributing Patterns (Level 2)

### Prerequisites
- [gh CLI](https://cli.github.com) installed and authenticated
- A `neurons/patterns/` directory with `NP-*.md` files

### Steps

```bash
# From your project root (where neurons/ directory lives)
factory-skills contribute
```

The tool will:
1. Find all your `NP-*.md` pattern files
2. Anonymize each one (strip project names, paths, refs)
3. Show you the anonymized version
4. Ask for your approval: `[y]` approve, `[n]` skip, `[e]` edit
5. Fork this repo (if needed)
6. Create a PR with your approved patterns

### What makes a good community pattern?

- **Generic**: Applies beyond your specific project
- **Evidence-based**: Includes symptoms, root cause, and fix
- **Actionable**: Someone reading it knows exactly what to do
- **Self-contained**: Doesn't require context from your project

### Examples of good patterns
- "Never define React components inside other components" (focus loss)
- "Deploy frontend BEFORE migrating DB when column types change"
- "Always check NOT NULL constraints before INSERT"

### Examples that should stay private
- "Use `handleLeadSubmit()` in our portal for dedup" (project-specific)
- "The Supabase ref is xyz123" (infrastructure detail)

---

## Contributing Foundations (Level 3)

Foundation neurons are universal principles — they don't come from a single error or project. They're distilled wisdom.

### How to contribute

1. Fork this repo
2. Create a file in `community/foundations/` with this format:

```markdown
---
id: CF-YYYYMMDD-HEXRAND
type: community-foundation
author: anonymous (or your GitHub handle)
submitted: YYYY-MM-DD
---

# CF-xxx: Principle Name

## Principle
One-sentence statement of the principle.

## Why It Matters
Why this principle exists. What goes wrong without it.

## How to Apply
Concrete actions. When to invoke this principle.

## Evidence
Where this was proven (without project-specific details).
```

3. Submit a PR to this repo

### What makes a good foundation?
- Timeless (not tied to a specific framework version)
- Universal (applies across languages, stacks, teams)
- Proven (you've seen it matter in real projects)

---

## Curation Process

All contributions are reviewed before merging:

1. **Automated check**: PR must only contain files in `community/patterns/` or `community/foundations/`
2. **Privacy review**: Maintainer verifies no project-specific information leaked
3. **Quality review**: Pattern/foundation must be generic, actionable, and evidence-based
4. **Dedup check**: Not a duplicate of an existing community contribution

Typical review time: 1-3 days.

---

## Using Community Patterns

Community patterns live in this repo's `community/` directory. You can:

1. **Browse**: Read them on GitHub to learn from others' experience
2. **Adopt**: Copy relevant patterns into your own `neurons/patterns/` directory
3. **Adapt**: Modify them to fit your project's specific context

Community patterns use the `CP-` prefix (Community Pattern) and `CF-` prefix (Community Foundation) to distinguish them from your project-specific neurons.

---

## FAQ

**Q: Can someone trace a pattern back to my project?**
A: The anonymization strips all project names, file paths, issue numbers, dates, and neuron cross-references. The pattern is also assigned a random community ID. If you're still concerned, use the `[e]` option to edit before submitting.

**Q: What if I accidentally approve something with sensitive info?**
A: The PR goes through manual review before merging. If you catch it after submitting, you can close the PR on GitHub. If it's already merged, open an issue and we'll remove it immediately.

**Q: Do I need to contribute to use the skills?**
A: No. The skills work entirely locally. Contributing is optional and only helps the community.

**Q: How often should I contribute?**
A: Whenever you have a pattern that saved you significant time and would help others. Quality over quantity.
