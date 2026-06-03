# Graph Report - .  (2026-06-03)

## Corpus Check
- Corpus is ~45,283 words - fits in a single context window. You may not need a graph.

## Summary
- 168 nodes · 157 edges · 23 communities (17 shown, 6 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Root TSConfig Options|Root TSConfig Options]]
- [[_COMMUNITY_Package JSON Config|Package JSON Config]]
- [[_COMMUNITY_Skills Lock Convex|Skills Lock Convex]]
- [[_COMMUNITY_Convex Functions & Actions|Convex Functions & Actions]]
- [[_COMMUNITY_Convex TSConfig Options|Convex TSConfig Options]]
- [[_COMMUNITY_NextJS App Pages|NextJS App Pages]]
- [[_COMMUNITY_Package DevDependencies|Package DevDependencies]]
- [[_COMMUNITY_App Layout Providers|App Layout Providers]]
- [[_COMMUNITY_Convex Schema & Datamodel|Convex Schema & Datamodel]]
- [[_COMMUNITY_Generated Server Contexts|Generated Server Contexts]]
- [[_COMMUNITY_AI Agent Files|AI Agent Files]]
- [[_COMMUNITY_Convex Create Component Skill|Convex Create Component Skill]]
- [[_COMMUNITY_Convex Performance Audit Skill|Convex Performance Audit Skill]]
- [[_COMMUNITY_Convex Quickstart Skill|Convex Quickstart Skill]]
- [[_COMMUNITY_NextJS Middleware Config|NextJS Middleware Config]]
- [[_COMMUNITY_NextJS Config|NextJS Config]]
- [[_COMMUNITY_PostCSS Config|PostCSS Config]]
- [[_COMMUNITY_Generated Internal Actions|Generated Internal Actions]]
- [[_COMMUNITY_Generated Internal Queries|Generated Internal Queries]]

## God Nodes (most connected - your core abstractions)
1. `compilerOptions` - 16 edges
2. `compilerOptions` - 14 edges
3. `skills` - 7 edges
4. `scripts` - 5 edges
5. `convex` - 5 edges
6. `convex-create-component` - 5 edges
7. `convex-migration-helper` - 5 edges
8. `convex-performance-audit` - 5 edges
9. `convex-quickstart` - 5 edges
10. `convex-setup-auth` - 5 edges

## Surprising Connections (you probably didn't know these)
- None detected - all connections are within the same source files.

## Import Cycles
- None detected.

## Communities (23 total, 6 thin omitted)

### Community 0 - "Root TSConfig Options"
Cohesion: 0.10
Nodes (19): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+11 more)

### Community 1 - "Package JSON Config"
Cohesion: 0.11
Nodes (17): dependencies, clerk, @clerk/nextjs, convex, next, pnpm, react, react-dom (+9 more)

### Community 2 - "Skills Lock Convex"
Cohesion: 0.11
Nodes (17): computedHash, computedHash, skillPath, source, sourceType, computedHash, skillPath, source (+9 more)

### Community 3 - "Convex Functions & Actions"
Cohesion: 0.13
Nodes (12): http, addNumber, listNumbers, myAction, deleteUser, updateOrCreateUser, internal, action (+4 more)

### Community 4 - "Convex TSConfig Options"
Cohesion: 0.12
Nodes (16): compilerOptions, allowJs, allowSyntheticDefaultImports, forceConsistentCasingInFileNames, isolatedModules, jsx, lib, module (+8 more)

### Community 6 - "Package DevDependencies"
Cohesion: 0.18
Nodes (11): devDependencies, @convex-dev/eslint-plugin, eslint, eslint-config-next, prettier, tailwindcss, @tailwindcss/postcss, @types/node (+3 more)

### Community 7 - "App Layout Providers"
Cohesion: 0.25
Nodes (4): geistMono, geistSans, metadata, convex

### Community 8 - "Convex Schema & Datamodel"
Cohesion: 0.33
Nodes (4): DataModel, Doc, Id, TableNames

### Community 9 - "Generated Server Contexts"
Cohesion: 0.33
Nodes (5): ActionCtx, DatabaseReader, DatabaseWriter, MutationCtx, QueryCtx

### Community 10 - "AI Agent Files"
Cohesion: 0.40
Nodes (4): agentSkillsSha, agentsMdSectionHash, claudeMdHash, guidelinesHash

### Community 11 - "Convex Create Component Skill"
Cohesion: 0.40
Nodes (5): computedHash, skillPath, source, sourceType, convex-create-component

### Community 12 - "Convex Performance Audit Skill"
Cohesion: 0.40
Nodes (5): computedHash, skillPath, source, sourceType, convex-performance-audit

### Community 13 - "Convex Quickstart Skill"
Cohesion: 0.40
Nodes (5): computedHash, skillPath, source, sourceType, convex-quickstart

## Knowledge Gaps
- **118 isolated node(s):** `geistSans`, `geistMono`, `metadata`, `convex`, `guidelinesHash` (+113 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **6 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `skills` connect `Skills Lock Convex` to `Convex Create Component Skill`, `Convex Performance Audit Skill`, `Convex Quickstart Skill`?**
  _High betweenness centrality (0.031) - this node is a cross-community bridge._
- **Why does `devDependencies` connect `Package DevDependencies` to `Package JSON Config`?**
  _High betweenness centrality (0.016) - this node is a cross-community bridge._
- **What connects `geistSans`, `geistMono`, `metadata` to the rest of the system?**
  _118 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Root TSConfig Options` be split into smaller, more focused modules?**
  _Cohesion score 0.1 - nodes in this community are weakly interconnected._
- **Should `Package JSON Config` be split into smaller, more focused modules?**
  _Cohesion score 0.1111111111111111 - nodes in this community are weakly interconnected._
- **Should `Skills Lock Convex` be split into smaller, more focused modules?**
  _Cohesion score 0.1111111111111111 - nodes in this community are weakly interconnected._
- **Should `Convex Functions & Actions` be split into smaller, more focused modules?**
  _Cohesion score 0.1323529411764706 - nodes in this community are weakly interconnected._