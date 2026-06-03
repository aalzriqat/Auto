# Graph Report - .  (2026-06-03)

## Corpus Check
- 7 files · ~47,637 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 172 nodes · 201 edges · 21 communities (16 shown, 5 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Memberships & Auth|Memberships & Auth]]
- [[_COMMUNITY_Root TSConfig|Root TSConfig]]
- [[_COMMUNITY_Package Config & DevDeps|Package Config & DevDeps]]
- [[_COMMUNITY_Convex Functions & HTTP|Convex Functions & HTTP]]
- [[_COMMUNITY_Convex TSConfig|Convex TSConfig]]
- [[_COMMUNITY_Skills Lock|Skills Lock]]
- [[_COMMUNITY_Next.js App Pages|Next.js App Pages]]
- [[_COMMUNITY_Package Dependencies|Package Dependencies]]
- [[_COMMUNITY_App Layout & Providers|App Layout & Providers]]
- [[_COMMUNITY_Generated Server Contexts|Generated Server Contexts]]
- [[_COMMUNITY_AI Agent State|AI Agent State]]
- [[_COMMUNITY_Convex Schema & Datamodel|Convex Schema & Datamodel]]
- [[_COMMUNITY_Next.js Middleware|Next.js Middleware]]
- [[_COMMUNITY_PostCSS Config|PostCSS Config]]
- [[_COMMUNITY_Generated Internal Actions|Generated Internal Actions]]
- [[_COMMUNITY_Generated Internal Queries|Generated Internal Queries]]

## God Nodes (most connected - your core abstractions)
1. `compilerOptions` - 16 edges
2. `compilerOptions` - 14 edges
3. `skills` - 7 edges
4. `source` - 6 edges
5. `sourceType` - 6 edges
6. `skillPath` - 6 edges
7. `computedHash` - 6 edges
8. `requireTenantAuth()` - 6 edges
9. `scripts` - 5 edges
10. `convex` - 5 edges

## Surprising Connections (you probably didn't know these)
- None detected - all connections are within the same source files.

## Import Cycles
- None detected.

## Communities (21 total, 5 thin omitted)

### Community 0 - "Memberships & Auth"
Cohesion: 0.11
Nodes (22): add, getMyMembership, leave, list, remove, updateRole, create, get (+14 more)

### Community 1 - "Root TSConfig"
Cohesion: 0.10
Nodes (19): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+11 more)

### Community 2 - "Package Config & DevDeps"
Cohesion: 0.11
Nodes (18): devDependencies, @convex-dev/eslint-plugin, eslint, eslint-config-next, prettier, tailwindcss, @tailwindcss/postcss, @types/node (+10 more)

### Community 3 - "Convex Functions & HTTP"
Cohesion: 0.13
Nodes (13): http, addNumber, listNumbers, myAction, deleteUser, getMe, updateOrCreateUser, internal (+5 more)

### Community 4 - "Convex TSConfig"
Cohesion: 0.12
Nodes (16): compilerOptions, allowJs, allowSyntheticDefaultImports, forceConsistentCasingInFileNames, isolatedModules, jsx, lib, module (+8 more)

### Community 5 - "Skills Lock"
Cohesion: 0.41
Nodes (12): computedHash, skillPath, source, sourceType, skills, convex, convex-create-component, convex-migration-helper (+4 more)

### Community 7 - "Package Dependencies"
Cohesion: 0.22
Nodes (9): dependencies, clerk, @clerk/nextjs, convex, next, pnpm, react, react-dom (+1 more)

### Community 8 - "App Layout & Providers"
Cohesion: 0.29
Nodes (4): geistMono, geistSans, metadata, convex

### Community 9 - "Generated Server Contexts"
Cohesion: 0.33
Nodes (5): ActionCtx, DatabaseReader, DatabaseWriter, MutationCtx, QueryCtx

### Community 10 - "AI Agent State"
Cohesion: 0.40
Nodes (4): agentSkillsSha, agentsMdSectionHash, claudeMdHash, guidelinesHash

### Community 11 - "Convex Schema & Datamodel"
Cohesion: 0.40
Nodes (3): Doc, Id, TableNames

## Knowledge Gaps
- **108 isolated node(s):** `geistSans`, `geistMono`, `metadata`, `convex`, `guidelinesHash` (+103 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `query` connect `Convex Functions & HTTP` to `Memberships & Auth`?**
  _High betweenness centrality (0.026) - this node is a cross-community bridge._
- **Why does `mutation` connect `Convex Functions & HTTP` to `Memberships & Auth`?**
  _High betweenness centrality (0.019) - this node is a cross-community bridge._
- **What connects `geistSans`, `geistMono`, `metadata` to the rest of the system?**
  _108 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Memberships & Auth` be split into smaller, more focused modules?**
  _Cohesion score 0.10826210826210826 - nodes in this community are weakly interconnected._
- **Should `Root TSConfig` be split into smaller, more focused modules?**
  _Cohesion score 0.1 - nodes in this community are weakly interconnected._
- **Should `Package Config & DevDeps` be split into smaller, more focused modules?**
  _Cohesion score 0.10526315789473684 - nodes in this community are weakly interconnected._
- **Should `Convex Functions & HTTP` be split into smaller, more focused modules?**
  _Cohesion score 0.13071895424836602 - nodes in this community are weakly interconnected._