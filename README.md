# Factory Skills

**Persistent learning and memory skills for AI coding agents.**

Built by [JB Coding IoT](https://github.com/ASINOSE12345) — battle-tested across 35+ sessions, 520+ neurons, and 3 production projects.

---

## Skills

### [neuron-system](./neuron-system/)

Turn your AI agent into a learning system that gets smarter across sessions.

- **4 neuron types**: Errors (NE), Decisions (ND), Patterns (NP), Foundations (NF)
- **Auto-validation**: Patterns must prove their value through hit/miss counters before becoming rules
- **Semantic routing**: NeuronRouter scores neurons by keyword relevance, temporal decay, occurrences, and agent affinity
- **Self-cleaning**: Unused patterns automatically archive after 25 idle sessions
- **Risk-aware**: Different confidence thresholds for triage vs. implementation vs. security review

### [project-memory](./project-memory/)

Never lose context between sessions again.

- **Bootstrap protocol**: Read project state BEFORE any action
- **Close protocol**: Capture results BEFORE ending session
- **Two-level architecture**: PROJECT_MEMORY.md per project + MEMORY.md factory index
- **4 memory types**: User, Feedback, Project, Reference
- **Single source of truth**: One living document per project, no duplicate systems

---

## Installation

### Claude Code

Copy the skill folder into your `.claude/skills/` directory:

```bash
# Clone the repo
git clone https://github.com/ASINOSE12345/factory-skills.git

# Copy skills you want
cp -r factory-skills/neuron-system ~/.claude/skills/
cp -r factory-skills/project-memory ~/.claude/skills/
```

Or reference directly from the repo:

```bash
# Add as a skill source
claude skills add /path/to/factory-skills/neuron-system
claude skills add /path/to/factory-skills/project-memory
```

### Other AI Agents (Cursor, Codex, Gemini CLI)

The skills are plain markdown — copy the `SKILL.md` content into your agent's system prompt or instruction file.

---

## How They Work Together

```
Session Start
    │
    ▼
[Bootstrap] ── Read PROJECT_MEMORY.md (project-memory)
    │           Read recent neurons (neuron-system)
    │           Read board state
    │
    ▼
[Work] ──────── NeuronRouter injects relevant neurons into agent prompts
    │           Agent creates new NE/ND neurons as it encounters errors/decisions
    │
    ▼
[Close] ─────── Update PROJECT_MEMORY.md with session results
                Update pattern counters (hits/misses/sessions_seen)
                Evaluate lifecycle gates (promote/archive patterns)
                Log session to MEMORY.md
```

---

## Origin Story

These skills emerged from building a **Software Factory** — an AI-augmented development platform managing multiple production projects simultaneously. After losing context repeatedly during long sessions, we built the neuron system to capture and recall knowledge automatically. After losing track of project state across sessions, we built project-memory to make forgetting impossible.

The result: **zero lost-context incidents** since implementation, and an error rate that dropped from 3.5/session to trending downward.

---

## Numbers

| Metric | Value |
|--------|-------|
| Sessions tested | 35+ |
| Error neurons (NE) | 260 |
| Decision neurons (ND) | 237 |
| Pattern neurons (NP) | 13 |
| Foundation neurons (NF) | 10 |
| **Total neurons** | **520** |
| Cross-project patterns (PAT-FX) | 22 |
| Production projects | 3 |
| Lost context incidents (post-implementation) | 0 |

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
