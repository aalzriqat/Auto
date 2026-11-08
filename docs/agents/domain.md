# Domain Docs

Configured layout: **single-context**. AutoFlow web, Convex, mobile and shared code use one root `GLOSSARY.md` and `docs/adr/`. Existing owner rulings and repository instructions take precedence.

Writers: `domain-modeling`, usually through `/grill-with-docs`, creates and updates `GLOSSARY.md` and ADRs. The owner approved this on 2026-11-08 in SCRUM-933, for SCRUM-418 §6 A4 and A10. Every other skill only reads them. Glossary and ADR changes ship in a normal reviewed PR. ADR file names follow the existing `docs/adr/YYYY-MM-DD-<slug>.md` pattern.

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root, or
- **`GLOSSARY-MAP.md`** at the repo root if it exists: it points at one `GLOSSARY.md` per context. Read each one relevant to the topic.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in. In multi-context repos, also check `src/<context>/docs/adr/` for context-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence or suggest creating them upfront. Record new domain decisions only through `domain-modeling` or other authorized work, under the existing repository review gates.

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
