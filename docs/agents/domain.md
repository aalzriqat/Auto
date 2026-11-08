# Domain Docs

Configured layout: **single-context**. AutoFlow web, Convex, mobile and shared code use one root `GLOSSARY.md` and `docs/adr/`. Existing owner rulings and repository instructions take precedence.

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Who writes the glossary and ADRs

`domain-modeling`, usually through `/grill-with-docs`, is the only skill that creates or updates `GLOSSARY.md` and ADRs. The owner approved this on 2026-11-08 in SCRUM-933, for SCRUM-418 §6 A4 and A10. Every other skill only reads them. Glossary and ADR changes ship in a normal reviewed PR. ADR file names follow the existing `docs/adr/YYYY-MM-DD-<slug>.md` pattern.

An ADR is written in two cases:

- **Before every money or permission PR.** The ADR states the invariant and the role policy (owner ruling 2026-11-02, SCRUM-760 c24361). It is always required. `domain-modeling`'s test for when to offer an ADR does not apply to it, and the agent may write it with or without that skill.
- **During grilling.** `domain-modeling` records a decision only when it is hard to reverse, surprising without context, and a real trade-off.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root, or
- **`GLOSSARY-MAP.md`** at the repo root if it exists: it points at one `GLOSSARY.md` per context. Read each one relevant to the topic.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in. In multi-context repos, also check `src/<context>/docs/adr/` for context-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence or suggest creating them upfront. A skill records a new decision as an ADR only in the two cases in "Who writes the glossary and ADRs" above. Other authorized work, such as a CI or release change, may also add an ADR. The existing repository review gates apply to every ADR.

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
