# Graph Report - Auto  (2026-06-08)

## Corpus Check
- 206 files · ~207,500 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1403 nodes · 2975 edges · 108 communities (92 shown, 16 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 5 edges (avg confidence: 0.84)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `3372b280`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 35|Community 35]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 37|Community 37]]
- [[_COMMUNITY_Community 38|Community 38]]
- [[_COMMUNITY_Community 39|Community 39]]
- [[_COMMUNITY_Community 40|Community 40]]
- [[_COMMUNITY_Community 41|Community 41]]
- [[_COMMUNITY_Community 42|Community 42]]
- [[_COMMUNITY_Community 43|Community 43]]
- [[_COMMUNITY_Community 44|Community 44]]
- [[_COMMUNITY_Community 45|Community 45]]
- [[_COMMUNITY_Community 46|Community 46]]
- [[_COMMUNITY_Community 47|Community 47]]
- [[_COMMUNITY_Community 48|Community 48]]
- [[_COMMUNITY_Community 49|Community 49]]
- [[_COMMUNITY_Community 50|Community 50]]
- [[_COMMUNITY_Community 51|Community 51]]
- [[_COMMUNITY_Community 52|Community 52]]
- [[_COMMUNITY_Community 53|Community 53]]
- [[_COMMUNITY_Community 54|Community 54]]
- [[_COMMUNITY_Community 55|Community 55]]
- [[_COMMUNITY_Community 56|Community 56]]
- [[_COMMUNITY_Community 57|Community 57]]
- [[_COMMUNITY_Community 58|Community 58]]
- [[_COMMUNITY_Community 59|Community 59]]
- [[_COMMUNITY_Community 60|Community 60]]
- [[_COMMUNITY_Community 61|Community 61]]
- [[_COMMUNITY_Community 62|Community 62]]
- [[_COMMUNITY_Community 63|Community 63]]
- [[_COMMUNITY_Community 64|Community 64]]
- [[_COMMUNITY_Community 65|Community 65]]
- [[_COMMUNITY_Community 66|Community 66]]
- [[_COMMUNITY_Community 67|Community 67]]
- [[_COMMUNITY_Community 68|Community 68]]
- [[_COMMUNITY_Community 69|Community 69]]
- [[_COMMUNITY_Community 70|Community 70]]
- [[_COMMUNITY_Community 71|Community 71]]
- [[_COMMUNITY_Community 72|Community 72]]
- [[_COMMUNITY_Community 73|Community 73]]
- [[_COMMUNITY_Community 74|Community 74]]
- [[_COMMUNITY_Community 75|Community 75]]
- [[_COMMUNITY_Community 76|Community 76]]
- [[_COMMUNITY_Community 78|Community 78]]
- [[_COMMUNITY_Community 79|Community 79]]
- [[_COMMUNITY_Community 80|Community 80]]
- [[_COMMUNITY_Community 82|Community 82]]
- [[_COMMUNITY_Community 85|Community 85]]
- [[_COMMUNITY_Community 86|Community 86]]
- [[_COMMUNITY_Community 88|Community 88]]
- [[_COMMUNITY_Community 89|Community 89]]
- [[_COMMUNITY_Community 91|Community 91]]
- [[_COMMUNITY_Community 95|Community 95]]
- [[_COMMUNITY_Community 96|Community 96]]
- [[_COMMUNITY_Community 97|Community 97]]
- [[_COMMUNITY_Community 100|Community 100]]
- [[_COMMUNITY_Community 103|Community 103]]
- [[_COMMUNITY_Community 104|Community 104]]
- [[_COMMUNITY_Community 106|Community 106]]
- [[_COMMUNITY_Community 107|Community 107]]
- [[_COMMUNITY_Community 108|Community 108]]
- [[_COMMUNITY_Community 109|Community 109]]
- [[_COMMUNITY_Community 110|Community 110]]
- [[_COMMUNITY_Community 116|Community 116]]
- [[_COMMUNITY_Community 117|Community 117]]

## God Nodes (most connected - your core abstractions)
1. `useOrg()` - 95 edges
2. `useLanguage()` - 91 edges
3. `api` - 49 edges
4. `Button` - 45 edges
5. `cn()` - 38 edges
6. `DialogHeader()` - 31 edges
7. `DialogContent` - 30 edges
8. `DialogTitle` - 30 edges
9. `PERMISSIONS` - 30 edges
10. `requireTenantAuth()` - 29 edges

## Surprising Connections (you probably didn't know these)
- `Onboarding()` --calls--> `useOrg()`  [EXTRACTED]
  app/(dashboard)/layout.tsx → components/providers/OrgProvider.tsx
- `DashboardWrapper()` --calls--> `useOrg()`  [EXTRACTED]
  app/(dashboard)/layout.tsx → components/providers/OrgProvider.tsx
- `DropdownMenuShortcut()` --calls--> `cn()`  [EXTRACTED]
  components/ui/dropdown-menu.tsx → lib/utils.ts
- `SheetFooter()` --calls--> `cn()`  [EXTRACTED]
  components/ui/sheet.tsx → lib/utils.ts
- `Clerk Auth Integration` --references--> `convex/auth.config.ts`  [EXTRACTED]
  .claude/skills/convex-setup-auth/references/clerk.md → convex/auth.config.ts

## Import Cycles
- None detected.

## Communities (108 total, 16 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.05
Nodes (150): AccountingClient(), ClaimsTab(), FixedAssetsTab(), GeneralLedgerTab(), PartnerEquityTab(), ApplicationDetailsDialog(), ApplicationClient(), BranchesClient() (+142 more)

### Community 1 - "Community 1"
Cohesion: 0.05
Nodes (41): dependencies, @base-ui/react, class-variance-authority, clerk, @clerk/nextjs, clsx, convex, date-fns (+33 more)

### Community 2 - "Community 2"
Cohesion: 0.13
Nodes (16): Advanced Component Patterns, Class-based client wrappers, Deriving validators from schema, Function Handles for callbacks, Static configuration with a globals table, Advanced Patterns, Authentication and environment access, Client-facing API (+8 more)

### Community 3 - "Community 3"
Cohesion: 0.07
Nodes (37): 1. Bound your reads, 2. Read smaller shapes, 3. Break large mutations into batches, 4. Move heavy work to actions, 5. Trim return values, 6. Replace `ctx.runQuery` and `ctx.runMutation` with helper functions, 7. Avoid unnecessary `runAction` calls, Common Causes (+29 more)

### Community 4 - "Community 4"
Cohesion: 0.09
Nodes (27): createFromQuote, finalizeDeal, get, list, updateStatus, create, expenseCategory, list (+19 more)

### Community 5 - "Community 5"
Cohesion: 0.10
Nodes (31): Cancel a Running Migration, Check Migration Status, Configuration Options, Custom Batch Size, Define a Migration, Dry Run, Installation, Migrate a Subset Using an Index (+23 more)

### Community 6 - "Community 6"
Cohesion: 0.10
Nodes (20): commonAr, commonEn, customersAr, customersEn, dashboardAr, dashboardEn, expensesAr, expensesEn (+12 more)

### Community 7 - "Community 7"
Cohesion: 0.08
Nodes (24): Agent Mode, Checklist, Convex Quickstart, Development vs Production, Environment variables, Install, Next.js (App Router), Next Steps (+16 more)

### Community 8 - "Community 8"
Cohesion: 0.16
Nodes (22): Checklist, Concrete Steps, Convex Auth, Expected Files and Decisions, Gotchas, Human Handoff, Production, Validation (+14 more)

### Community 9 - "Community 9"
Cohesion: 0.09
Nodes (22): Action guidelines, Authentication guidelines, Convex guidelines, Cron guidelines, File storage guidelines, Full text search guidelines, Function calling, Function guidelines (+14 more)

### Community 10 - "Community 10"
Cohesion: 0.09
Nodes (19): stats, sendTaskAlarm, sendTeamInvite, http, add, createAccount, finalizeDirectAccount, getMyMembership (+11 more)

### Community 11 - "Community 11"
Cohesion: 0.07
Nodes (26): useIsMobile(), Sidebar, SidebarContent, SidebarContext, SidebarContextProps, SidebarFooter, SidebarGroup, SidebarGroupAction (+18 more)

### Community 12 - "Community 12"
Cohesion: 0.16
Nodes (13): create, get, listMine, remove, update, deleteUser, getMe, getUser (+5 more)

### Community 13 - "Community 13"
Cohesion: 0.17
Nodes (20): Checklist, Concrete Steps, Files and Env Vars To Expect, Gotchas, Key Setup Areas, Production, Validation, What To Do (+12 more)

### Community 14 - "Community 14"
Cohesion: 0.10
Nodes (19): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+11 more)

### Community 15 - "Community 15"
Cohesion: 0.11
Nodes (17): Adding Index, Adding New Table, Adding Optional Field, Breaking Changes: The Deployment Workflow, Common Migration Patterns, Common Pitfalls, Convex Migration Helper, Don't Delete Data (+9 more)

### Community 16 - "Community 16"
Cohesion: 0.11
Nodes (17): aliases, components, hooks, lib, ui, utils, iconLibrary, rsc (+9 more)

### Community 17 - "Community 17"
Cohesion: 0.10
Nodes (17): add, list, migrateToDefaultBranch, update, crons, triggerAlarms, backfillPermissions, grantTaskPermissionsToAll (+9 more)

### Community 18 - "Community 18"
Cohesion: 0.12
Nodes (16): Advanced Patterns, Authentication and environment access, Checklist, Choose the Shape, Client-facing API, Component Skeleton, Convex Create Component, Critical Rules (+8 more)

### Community 19 - "Community 19"
Cohesion: 0.12
Nodes (16): compilerOptions, allowJs, allowSyntheticDefaultImports, forceConsistentCasingInFileNames, isolatedModules, jsx, lib, module (+8 more)

### Community 20 - "Community 20"
Cohesion: 0.12
Nodes (15): 1. Scope the problem, 2. Trace the full read and write set, 3. Apply fixes from the relevant reference, 4. Fix sibling functions together, 5. Verify before finishing, Checklist, Convex Performance Audit, Escalate Larger Fixes (+7 more)

### Community 21 - "Community 21"
Cohesion: 0.12
Nodes (15): 1. Reduce read set size, 2. Split hot documents, 3. Move non-critical work to scheduled functions, 4. Combine competing writes, Broad read sets causing false conflicts, Common Causes, Core Principle, Fan-out from triggers or cascading writes (+7 more)

### Community 22 - "Community 22"
Cohesion: 0.12
Nodes (15): 1. Scope the problem, 2. Trace the full read and write set, 3. Apply fixes from the relevant reference, 4. Fix sibling functions together, 5. Verify before finishing, Checklist, Convex Performance Audit, Escalate Larger Fixes (+7 more)

### Community 23 - "Community 23"
Cohesion: 0.20
Nodes (9): DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuShortcut(), DropdownMenuSubContent (+1 more)

### Community 24 - "Community 24"
Cohesion: 0.06
Nodes (47): 1. Push Filters To Storage, 2. Minimize Data Sources, 3. Minimize Row Size, 4. Isolate Frequently-Updated Fields, 5. Match Consistency To Read Patterns, Aggregates, Backfills, Check for redundant indexes (+39 more)

### Community 25 - "Community 25"
Cohesion: 0.16
Nodes (18): Adding Index, Adding New Table, Adding Optional Field, Breaking Changes: The Deployment Workflow, Common Migration Patterns, Common Pitfalls, Convex Migration Helper, Don't Delete Data (+10 more)

### Community 26 - "Community 26"
Cohesion: 0.28
Nodes (12): Checklist, Choose the Shape, Component Skeleton, Convex Create Component, Critical Rules, Default Approach, Reference Files, Validation (+4 more)

### Community 27 - "Community 27"
Cohesion: 0.06
Nodes (42): Checklist, Default Advice, Hybrid Convex Components, Risks, What This Means, Checklist, Default Layout, Local Convex Components (+34 more)

### Community 28 - "Community 28"
Cohesion: 0.17
Nodes (11): Adding a Required Field, Changing a Field Type, Cleaning Up Orphaned Documents, Deleting a Field, Dual Read, Dual Write (Preferred), Migration Patterns Reference, Small Table Shortcut (+3 more)

### Community 29 - "Community 29"
Cohesion: 0.19
Nodes (12): cn(), buttonVariants, Calendar(), CalendarProps, DateTimePicker(), DateTimePickerProps, EmptyState(), EmptyStateProps (+4 more)

### Community 30 - "Community 30"
Cohesion: 0.30
Nodes (11): Agent Mode, Checklist, Convex Quickstart, Development vs Production, Next Steps, Verify the Setup, When Not to Use, When to Use (+3 more)

### Community 31 - "Community 31"
Cohesion: 0.18
Nodes (10): Auth0, Checklist, Concrete Steps, Files and Env Vars To Expect, Gotchas, Key Setup Areas, Production, Validation (+2 more)

### Community 32 - "Community 32"
Cohesion: 0.18
Nodes (10): Checklist, Clerk, Concrete Steps, Files and Env Vars To Expect, Gotchas, Key Setup Areas, Production, Validation (+2 more)

### Community 33 - "Community 33"
Cohesion: 0.18
Nodes (10): After Choosing a Provider, Checklist, Convex Authentication Setup, Core Pattern: Protecting Backend Functions, First Step: Choose the Auth Provider, Provider References, Reference Files, When Not to Use (+2 more)

### Community 34 - "Community 34"
Cohesion: 0.18
Nodes (10): Auth0, Checklist, Concrete Steps, Files and Env Vars To Expect, Gotchas, Key Setup Areas, Production, Validation (+2 more)

### Community 35 - "Community 35"
Cohesion: 0.18
Nodes (10): Checklist, Clerk, Concrete Steps, Files and Env Vars To Expect, Gotchas, Key Setup Areas, Production, Validation (+2 more)

### Community 36 - "Community 36"
Cohesion: 0.18
Nodes (10): After Choosing a Provider, Checklist, Convex Authentication Setup, Core Pattern: Protecting Backend Functions, First Step: Choose the Auth Provider, Provider References, Reference Files, When Not to Use (+2 more)

### Community 37 - "Community 37"
Cohesion: 0.18
Nodes (10): create, deleteImage, generateUploadUrl, get, getByVin, getRelations, list, remove (+2 more)

### Community 38 - "Community 38"
Cohesion: 0.17
Nodes (12): LanguageSwitcher(), OrgSwitcher(), navigation, TopNav(), SheetContent, SheetContentProps, SheetDescription, SheetFooter() (+4 more)

### Community 39 - "Community 39"
Cohesion: 0.20
Nodes (10): 1. Use point-in-time reads when live updates are not valuable, 2. Batch related data into fewer queries, 3. Use skip to avoid unnecessary subscriptions, 4. Isolate frequently-updated fields into separate documents, 5. Use the aggregate component for counts and sums, 6. Narrow query read sets, 7. Remove `Date.now()` from queries, 8. Consider pagination strategy (+2 more)

### Community 40 - "Community 40"
Cohesion: 0.20
Nodes (10): 1. Use point-in-time reads when live updates are not valuable, 2. Batch related data into fewer queries, 3. Use skip to avoid unnecessary subscriptions, 4. Isolate frequently-updated fields into separate documents, 5. Use the aggregate component for counts and sums, 6. Narrow query read sets, 7. Remove `Date.now()` from queries, 8. Consider pagination strategy (+2 more)

### Community 41 - "Community 41"
Cohesion: 0.29
Nodes (11): Convex Performance Audit Agent, computedHash, computedHash, skillPath, source, sourceType, skillPath, source (+3 more)

### Community 42 - "Community 42"
Cohesion: 0.20
Nodes (8): DashboardWrapper(), Onboarding(), OrgProvider(), SidebarInset, SidebarProvider, SidebarTrigger, Toaster(), ToasterProps

### Community 43 - "Community 43"
Cohesion: 0.13
Nodes (15): devDependencies, @convex-dev/eslint-plugin, convex-test, eslint, eslint-config-next, jsdom, prettier, tailwindcss (+7 more)

### Community 44 - "Community 44"
Cohesion: 0.18
Nodes (7): cairo, geistMono, geistSans, inter, metadata, convex, LanguageProvider()

### Community 45 - "Community 45"
Cohesion: 0.15
Nodes (12): Sheet1, Sheet2, اثاث وديكورات, ادارية وعمومية, ارباح وخسائر, التدفقات, السيارات , راسمال الشركاء (+4 more)

### Community 46 - "Community 46"
Cohesion: 0.29
Nodes (6): getExpensesReport, getInventoryReport, getLeadConversionReport, getProfitAndLoss, getSalesAndProfitReport, getSalespersonPerformance

### Community 47 - "Community 47"
Cohesion: 0.20
Nodes (9): name, private, scripts, build, dev, lint, start, test (+1 more)

### Community 48 - "Community 48"
Cohesion: 0.27
Nodes (7): PERMISSION_GROUPS, RolePermissionsEditor(), AccordionContent, AccordionItem, AccordionTrigger, Checkbox, Switch

### Community 49 - "Community 49"
Cohesion: 0.27
Nodes (9): Core Principle, Subscription Cost, Symptoms, Verification, Core Principle, Subscription Cost, Symptoms, Verification (+1 more)

### Community 50 - "Community 50"
Cohesion: 0.25
Nodes (8): Environment variables, Install, Next.js (App Router), Other frameworks, Path 2: Add Convex to an Existing App, Provision and push, React (Vite), Wire up the provider

### Community 51 - "Community 51"
Cohesion: 0.25
Nodes (7): Build Flow, Checklist, Default Approach, Package Exports, Packaged Convex Components, Testing, When to Choose This

### Community 52 - "Community 52"
Cohesion: 0.25
Nodes (7): create, get, getByEmail, getRelations, list, remove, update

### Community 53 - "Community 53"
Cohesion: 0.13
Nodes (16): addRule, generateUploadUrl, getForApplication, listRules, removeRule, saveDocumentFile, updateDocumentStatus, fixExistingRoles (+8 more)

### Community 54 - "Community 54"
Cohesion: 0.29
Nodes (6): createCompany, deleteCompany, listCompanies, listValuations, saveValuation, updateCompany

### Community 55 - "Community 55"
Cohesion: 0.29
Nodes (6): create, get, list, remove, saleStatus, update

### Community 56 - "Community 56"
Cohesion: 0.33
Nodes (5): getHistory, listPending, requestCreate, requestUpdate, resolve

### Community 57 - "Community 57"
Cohesion: 0.40
Nodes (4): add, list, remove, update

### Community 58 - "Community 58"
Cohesion: 0.24
Nodes (11): Broad read sets causing false conflicts, Common Causes, Core Principle, Fan-out from triggers or cascading writes, Hot documents, OCC Conflict Resolution, Related: Invalidation Scope, Symptoms (+3 more)

### Community 59 - "Community 59"
Cohesion: 0.33
Nodes (6): Common Causes, Frequently-updated fields on widely-read documents, Overly broad queries, Paginated queries keeping all pages live, Reactive queries on low-freshness flows, Too many subscriptions per page

### Community 60 - "Community 60"
Cohesion: 0.33
Nodes (6): Path 1: New Project (Recommended), Pick a template, Provision the deployment and push code, Scaffold the project, Start the dev loop, What you get

### Community 61 - "Community 61"
Cohesion: 0.33
Nodes (5): Checklist, Default Advice, Hybrid Convex Components, Risks, What This Means

### Community 62 - "Community 62"
Cohesion: 0.33
Nodes (5): Checklist, Default Layout, Local Convex Components, When to Choose This, Workflow Notes

### Community 63 - "Community 63"
Cohesion: 0.40
Nodes (4): add, list, remove, update

### Community 64 - "Community 64"
Cohesion: 0.33
Nodes (6): Common Causes, Frequently-updated fields on widely-read documents, Overly broad queries, Paginated queries keeping all pages live, Reactive queries on low-freshness flows, Too many subscriptions per page

### Community 65 - "Community 65"
Cohesion: 0.47
Nodes (6): Clerk Auth Integration, convex/auth.config.ts, Convex Auth (Native), convex/schema.ts, Convex Auth Configuration, WorkOS AuthKit Integration

### Community 66 - "Community 66"
Cohesion: 0.40
Nodes (4): add, list, remove, update

### Community 67 - "Community 67"
Cohesion: 0.40
Nodes (4): add, list, remove, update

### Community 68 - "Community 68"
Cohesion: 0.33
Nodes (5): create, get, list, remove, update

### Community 69 - "Community 69"
Cohesion: 0.33
Nodes (5): create, getHistory, list, remove, update

### Community 70 - "Community 70"
Cohesion: 0.33
Nodes (5): ActionCtx, DatabaseReader, DatabaseWriter, MutationCtx, QueryCtx

### Community 73 - "Community 73"
Cohesion: 0.40
Nodes (5): 1. Reduce read set size, 2. Split hot documents, 3. Move non-critical work to scheduled functions, 4. Combine competing writes, Fix Order

### Community 75 - "Community 75"
Cohesion: 0.40
Nodes (4): Convex, Route to the Right Skill, Start Here, When Not to Use

### Community 76 - "Community 76"
Cohesion: 0.40
Nodes (4): agentSkillsSha, agentsMdSectionHash, claudeMdHash, guidelinesHash

### Community 78 - "Community 78"
Cohesion: 0.40
Nodes (4): Convex, Route to the Right Skill, Start Here, When Not to Use

### Community 79 - "Community 79"
Cohesion: 0.40
Nodes (4): Convex + Next.js + Clerk App README, Convex Routing Skill, Convex Performance Audit Skill, Convex Setup Auth Skill

### Community 80 - "Community 80"
Cohesion: 0.33
Nodes (4): DataModel, Doc, Id, TableNames

### Community 82 - "Community 82"
Cohesion: 0.40
Nodes (4): Get started, Join the community, Learn more, Welcome to your Convex + Next.js + Clerk app

### Community 85 - "Community 85"
Cohesion: 0.11
Nodes (17): computedHash, skillPath, source, sourceType, computedHash, skillPath, source, sourceType (+9 more)

### Community 86 - "Community 86"
Cohesion: 0.67
Nodes (3): Convex AI Agents, Claude Convex Configuration, Convex AI Guidelines

### Community 88 - "Community 88"
Cohesion: 0.40
Nodes (4): complete, create, list, remove

### Community 91 - "Community 91"
Cohesion: 0.25
Nodes (7): CompanyInfo, CustomerInfo, generateBillOfSale(), generateFinanceQuote(), generateQuote(), PricingInfo, VehicleInfo

### Community 116 - "Community 116"
Cohesion: 0.40
Nodes (5): computedHash, skillPath, source, sourceType, convex-quickstart

## Knowledge Gaps
- **741 isolated node(s):** `metadata`, `metadata`, `STAGES`, `defaultEndDate`, `defaultStartDate` (+736 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **16 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Convex Performance Audit Skill` connect `Community 27` to `Community 24`, `Community 49`, `Community 58`, `Community 3`?**
  _High betweenness centrality (0.028) - this node is a cross-community bridge._
- **Why does `Convex Create Component Skill` connect `Community 27` to `Community 2`?**
  _High betweenness centrality (0.026) - this node is a cross-community bridge._
- **What connects `metadata`, `metadata`, `STAGES` to the rest of the system?**
  _741 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.05103359173126615 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.04878048780487805 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.13071895424836602 - nodes in this community are weakly interconnected._
- **Should `Community 3` be split into smaller, more focused modules?**
  _Cohesion score 0.06612685560053981 - nodes in this community are weakly interconnected._