# Firth Skills

This directory holds the **Skills bundle** for Firth — Markdown files in the [Anthropic Skills format](https://docs.claude.com) that teach AI coding agents how to operate cloud platforms in the context of a Firth project.

## Layout (planned)

```
skills/
├── README.md                       ← you are here
├── stack-overview/
│   └── SKILL.md                    ← what stack this project uses, why
├── deploy-flow/
│   └── SKILL.md                    ← how `firth deploy` actually works
├── debug-runbook/
│   └── SKILL.md                    ← what to do when a deploy / migration / build fails
├── cost-and-scaling/
│   └── SKILL.md                    ← free-tier limits, when to scale up, how
├── handoff/
│   └── SKILL.md                    ← how to produce a context dump for a fresh agent
│
├── neon/                           ← provider-specific Skills
│   ├── connection-pooling/
│   │   └── SKILL.md
│   └── ...
├── vercel/
│   └── ...
├── railway/
│   └── ...
└── ...
```

## Skill format

Each Skill is a single `SKILL.md` file with YAML frontmatter:

```markdown
---
name: <skill-name>
description: <one-line description used by the agent to decide whether to invoke this Skill>
---

# <Skill title>

<Markdown body — instructions, examples, gotchas, references to firth CLI commands>
```

See the Anthropic Skills documentation for full schema details.

## Authoring guidelines (early draft)

- **One Skill, one capability.** Don't write a 2,000-line "everything about Vercel" Skill. Split by task: `vercel-deploy`, `vercel-env-vars`, `vercel-debug-build`.
- **Reference the Firth CLI.** Skills should tell the agent which `firth` command to invoke, not how to call provider APIs directly. Provider-specific knowledge lives behind the CLI.
- **Include known failure modes.** A Skill is most valuable when it teaches the agent what can go wrong and how to recover.
- **Keep examples runnable.** Code blocks should be copy-pasteable; agents will execute them.

## Status

Empty for now. The first batch of Skills will land alongside the first golden path (Next.js + Hono + Neon + Vercel + Railway).
