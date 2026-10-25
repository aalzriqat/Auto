# Domain Docs

Configured layout: **single-context**. AutoFlow web, Convex, mobile and shared code use one root `GLOSSARY.md` and `docs/adr/`. This consumer configuration creates neither a glossary nor ADRs. Existing owner rulings and repository instructions take precedence.

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root, or
- **`GLOSSARY-MAP.md`** at the repo root if it exists: it points at one `GLOSSARY.md` per context. Read each one relevant to the topic.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in. In multi-context repos, also check `src/<context>/docs/adr/` for context-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence or suggest creating them upfront. This setup neither installs nor invokes additional domain-modeling skills. Record new domain decisions only within separately authorized work and the existing repository review gates.

## File structure

Configured shared layout:

```
/
├── GLOSSARY.md
├── docs/adr/
│   └── <existing-or-authorized-decision>.md
├── app/
├── convex/
├── apps/mobile/
└── packages/shared/
```

Separate domain contexts can be configured later if the owner chooses them. Workspace/package boundaries alone do not establish different business vocabularies.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in an existing glossary, check current owner rulings and repository sources. Do not invent a new business meaning to fill the gap.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

State the actual ADR identifier, the conflicting statement and the proposed reason. Existing financial rulings, tenancy protections and release gates remain binding.
