# Graph Report - Auto  (2026-06-06)

## Corpus Check
- 163 files · ~95,919 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1210 nodes · 2034 edges · 96 communities (85 shown, 11 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `a851db70`
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
- [[_COMMUNITY_Community 77|Community 77]]
- [[_COMMUNITY_Community 78|Community 78]]
- [[_COMMUNITY_Community 79|Community 79]]
- [[_COMMUNITY_Community 80|Community 80]]
- [[_COMMUNITY_Community 81|Community 81]]
- [[_COMMUNITY_Community 82|Community 82]]
- [[_COMMUNITY_Community 83|Community 83]]
- [[_COMMUNITY_Community 84|Community 84]]
- [[_COMMUNITY_Community 85|Community 85]]
- [[_COMMUNITY_Community 86|Community 86]]
- [[_COMMUNITY_Community 87|Community 87]]
- [[_COMMUNITY_Community 88|Community 88]]
- [[_COMMUNITY_Community 89|Community 89]]
- [[_COMMUNITY_Community 90|Community 90]]
- [[_COMMUNITY_Community 91|Community 91]]
- [[_COMMUNITY_Community 92|Community 92]]
- [[_COMMUNITY_Community 93|Community 93]]

## God Nodes (most connected - your core abstractions)
1. `useOrg()` - 57 edges
2. `useLanguage()` - 40 edges
3. `cn()` - 32 edges
4. `api` - 31 edges
5. `Button` - 28 edges
6. `DialogHeader()` - 23 edges
7. `DialogContent` - 22 edges
8. `DialogTitle` - 22 edges
9. `DialogDescription` - 22 edges
10. `Input` - 20 edges

## Surprising Connections (you probably didn't know these)
- `Onboarding()` --calls--> `useOrg()`  [EXTRACTED]
  app/(dashboard)/layout.tsx → components/providers/OrgProvider.tsx
- `DashboardWrapper()` --calls--> `useOrg()`  [EXTRACTED]
  app/(dashboard)/layout.tsx → components/providers/OrgProvider.tsx
- `ReportsPage()` --calls--> `useOrg()`  [EXTRACTED]
  app/(dashboard)/reports/page.tsx → components/providers/OrgProvider.tsx
- `DropdownMenuShortcut()` --calls--> `cn()`  [EXTRACTED]
  components/ui/dropdown-menu.tsx → lib/utils.ts
- `SheetFooter()` --calls--> `cn()`  [EXTRACTED]
  components/ui/sheet.tsx → lib/utils.ts

## Import Cycles
- None detected.

## Communities (96 total, 11 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.08
Nodes (47): CustomerDialogProps, CustomerFormValues, customerSchema, ExpenseDialog(), ExpenseDialogProps, ExpenseFormValues, expenseSchema, LeadDialogProps (+39 more)

### Community 1 - "Community 1"
Cohesion: 0.05
Nodes (37): dependencies, @base-ui/react, class-variance-authority, clerk, @clerk/nextjs, clsx, convex, date-fns (+29 more)

### Community 2 - "Community 2"
Cohesion: 0.09
Nodes (22): useIsMobile(), Sidebar, SidebarContent, SidebarContext, SidebarContextProps, SidebarFooter, SidebarGroup, SidebarGroupAction (+14 more)

### Community 3 - "Community 3"
Cohesion: 0.18
Nodes (7): cairo, geistMono, geistSans, inter, metadata, convex, LanguageProvider()

### Community 4 - "Community 4"
Cohesion: 0.10
Nodes (19): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+11 more)

### Community 5 - "Community 5"
Cohesion: 0.16
Nodes (22): CustomerDetailsDialog(), CustomerDialog(), CustomersPage(), DashboardPage(), ExpensesPage(), NotificationsBell(), LeadDialog(), LeadsPage() (+14 more)

### Community 6 - "Community 6"
Cohesion: 0.11
Nodes (17): aliases, components, hooks, lib, ui, utils, iconLibrary, rsc (+9 more)

### Community 7 - "Community 7"
Cohesion: 0.12
Nodes (16): compilerOptions, allowJs, allowSyntheticDefaultImports, forceConsistentCasingInFileNames, isolatedModules, jsx, lib, module (+8 more)

### Community 8 - "Community 8"
Cohesion: 0.17
Nodes (12): LanguageSwitcher(), OrgSwitcher(), navigation, TopNav(), SheetContent, SheetContentProps, SheetDescription, SheetFooter() (+4 more)

### Community 10 - "Community 10"
Cohesion: 0.13
Nodes (12): crons, triggerAlarms, sendTaskAlarm, sendTeamInvite, http, list, markAllAsRead, markAsRead (+4 more)

### Community 11 - "Community 11"
Cohesion: 0.16
Nodes (15): stats, create, get, listMine, remove, update, deleteUser, getMe (+7 more)

### Community 12 - "Community 12"
Cohesion: 0.17
Nodes (13): DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuShortcut(), DropdownMenuSubContent (+5 more)

### Community 13 - "Community 13"
Cohesion: 0.10
Nodes (32): computedHash, computedHash, skillPath, source, sourceType, computedHash, skillPath, source (+24 more)

### Community 14 - "Community 14"
Cohesion: 0.18
Nodes (11): devDependencies, @convex-dev/eslint-plugin, eslint, eslint-config-next, prettier, tailwindcss, @tailwindcss/postcss, @types/node (+3 more)

### Community 15 - "Community 15"
Cohesion: 0.22
Nodes (8): name, private, scripts, build, dev, lint, start, version

### Community 16 - "Community 16"
Cohesion: 0.28
Nodes (19): STAGES, Badge(), BadgeProps, badgeVariants, Button, DialogContent, DialogDescription, DialogFooter() (+11 more)

### Community 17 - "Community 17"
Cohesion: 0.18
Nodes (10): create, deleteImage, generateUploadUrl, get, getByVin, getRelations, list, remove (+2 more)

### Community 18 - "Community 18"
Cohesion: 0.25
Nodes (7): create, get, getByEmail, getRelations, list, remove, update

### Community 19 - "Community 19"
Cohesion: 0.14
Nodes (17): cn(), ButtonProps, buttonVariants, Calendar(), CalendarProps, DateTimePicker(), DateTimePickerProps, Label (+9 more)

### Community 20 - "Community 20"
Cohesion: 0.12
Nodes (19): create, expenseCategory, list, remove, update, create, get, leadStage (+11 more)

### Community 21 - "Community 21"
Cohesion: 0.17
Nodes (11): add, createAccount, finalizeDirectAccount, getMyMembership, leave, list, prepareDirectAccount, remove (+3 more)

### Community 22 - "Community 22"
Cohesion: 0.29
Nodes (6): create, get, list, remove, saleStatus, update

### Community 23 - "Community 23"
Cohesion: 0.29
Nodes (6): CompanyInfo, CustomerInfo, generateBillOfSale(), generateQuote(), PricingInfo, VehicleInfo

### Community 24 - "Community 24"
Cohesion: 0.15
Nodes (15): defaultEndDate, defaultStartDate, ReportsPage(), Card, CardContent, CardDescription, CardFooter, CardHeader (+7 more)

### Community 25 - "Community 25"
Cohesion: 0.08
Nodes (24): Agent Mode, Checklist, Convex Quickstart, Development vs Production, Environment variables, Install, Next.js (App Router), Next Steps (+16 more)

### Community 26 - "Community 26"
Cohesion: 0.17
Nodes (10): fixExistingRoles, create, get, list, remove, update, internalMutation, ALL_PERMISSIONS (+2 more)

### Community 27 - "Community 27"
Cohesion: 0.33
Nodes (5): ActionCtx, DatabaseReader, DatabaseWriter, MutationCtx, QueryCtx

### Community 28 - "Community 28"
Cohesion: 0.33
Nodes (3): fs, map, path

### Community 29 - "Community 29"
Cohesion: 0.40
Nodes (4): agentSkillsSha, agentsMdSectionHash, claudeMdHash, guidelinesHash

### Community 30 - "Community 30"
Cohesion: 0.33
Nodes (4): DataModel, Doc, Id, TableNames

### Community 31 - "Community 31"
Cohesion: 0.50
Nodes (3): config, isProtectedRoute, isPublicRoute

### Community 37 - "Community 37"
Cohesion: 0.08
Nodes (24): Agent Mode, Checklist, Convex Quickstart, Development vs Production, Environment variables, Install, Next.js (App Router), Next Steps (+16 more)

### Community 40 - "Community 40"
Cohesion: 0.08
Nodes (23): 1. Push Filters To Storage, 2. Minimize Data Sources, 3. Minimize Row Size, 4. Isolate Frequently-Updated Fields, 5. Match Consistency To Read Patterns, Aggregates, Backfills, Check for redundant indexes (+15 more)

### Community 41 - "Community 41"
Cohesion: 0.08
Nodes (23): 1. Push Filters To Storage, 2. Minimize Data Sources, 3. Minimize Row Size, 4. Isolate Frequently-Updated Fields, 5. Match Consistency To Read Patterns, Aggregates, Backfills, Check for redundant indexes (+15 more)

### Community 42 - "Community 42"
Cohesion: 0.13
Nodes (16): commonAr, commonEn, customersAr, customersEn, dashboardAr, dashboardEn, leadsAr, leadsEn (+8 more)

### Community 43 - "Community 43"
Cohesion: 0.20
Nodes (12): CustomerDetailsDialogProps, api, components, LanguageContext, LanguageContextType, OrgContext, OrgContextType, TaskHistoryDialogProps (+4 more)

### Community 44 - "Community 44"
Cohesion: 0.10
Nodes (20): 1. Use point-in-time reads when live updates are not valuable, 2. Batch related data into fewer queries, 3. Use skip to avoid unnecessary subscriptions, 4. Isolate frequently-updated fields into separate documents, 5. Use the aggregate component for counts and sums, 6. Narrow query read sets, 7. Remove `Date.now()` from queries, 8. Consider pagination strategy (+12 more)

### Community 45 - "Community 45"
Cohesion: 0.10
Nodes (20): Action guidelines, Authentication guidelines, Convex guidelines, Cron guidelines, File storage guidelines, Full text search guidelines, Function calling, Function guidelines (+12 more)

### Community 46 - "Community 46"
Cohesion: 0.10
Nodes (20): 1. Use point-in-time reads when live updates are not valuable, 2. Batch related data into fewer queries, 3. Use skip to avoid unnecessary subscriptions, 4. Isolate frequently-updated fields into separate documents, 5. Use the aggregate component for counts and sums, 6. Narrow query read sets, 7. Remove `Date.now()` from queries, 8. Consider pagination strategy (+12 more)

### Community 47 - "Community 47"
Cohesion: 0.11
Nodes (18): 1. Bound your reads, 2. Read smaller shapes, 3. Break large mutations into batches, 4. Move heavy work to actions, 5. Trim return values, 6. Replace `ctx.runQuery` and `ctx.runMutation` with helper functions, 7. Avoid unnecessary `runAction` calls, Common Causes (+10 more)

### Community 48 - "Community 48"
Cohesion: 0.11
Nodes (18): 1. Bound your reads, 2. Read smaller shapes, 3. Break large mutations into batches, 4. Move heavy work to actions, 5. Trim return values, 6. Replace `ctx.runQuery` and `ctx.runMutation` with helper functions, 7. Avoid unnecessary `runAction` calls, Common Causes (+10 more)

### Community 49 - "Community 49"
Cohesion: 0.12
Nodes (15): grantTaskPermissionsToAll, complete, create, list, remove, create, listPending, resolve (+7 more)

### Community 50 - "Community 50"
Cohesion: 0.11
Nodes (17): Adding Index, Adding New Table, Adding Optional Field, Breaking Changes: The Deployment Workflow, Common Migration Patterns, Common Pitfalls, Convex Migration Helper, Don't Delete Data (+9 more)

### Community 51 - "Community 51"
Cohesion: 0.11
Nodes (17): Adding Index, Adding New Table, Adding Optional Field, Breaking Changes: The Deployment Workflow, Common Migration Patterns, Common Pitfalls, Convex Migration Helper, Don't Delete Data (+9 more)

### Community 52 - "Community 52"
Cohesion: 0.12
Nodes (16): Advanced Patterns, Authentication and environment access, Checklist, Choose the Shape, Client-facing API, Component Skeleton, Convex Create Component, Critical Rules (+8 more)

### Community 53 - "Community 53"
Cohesion: 0.12
Nodes (16): Advanced Patterns, Authentication and environment access, Checklist, Choose the Shape, Client-facing API, Component Skeleton, Convex Create Component, Critical Rules (+8 more)

### Community 54 - "Community 54"
Cohesion: 0.12
Nodes (15): Cancel a Running Migration, Check Migration Status, Configuration Options, Custom Batch Size, Define a Migration, Dry Run, Installation, Migrate a Subset Using an Index (+7 more)

### Community 55 - "Community 55"
Cohesion: 0.12
Nodes (15): 1. Reduce read set size, 2. Split hot documents, 3. Move non-critical work to scheduled functions, 4. Combine competing writes, Broad read sets causing false conflicts, Common Causes, Core Principle, Fan-out from triggers or cascading writes (+7 more)

### Community 56 - "Community 56"
Cohesion: 0.12
Nodes (15): 1. Scope the problem, 2. Trace the full read and write set, 3. Apply fixes from the relevant reference, 4. Fix sibling functions together, 5. Verify before finishing, Checklist, Convex Performance Audit, Escalate Larger Fixes (+7 more)

### Community 57 - "Community 57"
Cohesion: 0.12
Nodes (15): Cancel a Running Migration, Check Migration Status, Configuration Options, Custom Batch Size, Define a Migration, Dry Run, Installation, Migrate a Subset Using an Index (+7 more)

### Community 58 - "Community 58"
Cohesion: 0.12
Nodes (15): 1. Reduce read set size, 2. Split hot documents, 3. Move non-critical work to scheduled functions, 4. Combine competing writes, Broad read sets causing false conflicts, Common Causes, Core Principle, Fan-out from triggers or cascading writes (+7 more)

### Community 59 - "Community 59"
Cohesion: 0.12
Nodes (15): 1. Scope the problem, 2. Trace the full read and write set, 3. Apply fixes from the relevant reference, 4. Fix sibling functions together, 5. Verify before finishing, Checklist, Convex Performance Audit, Escalate Larger Fixes (+7 more)

### Community 60 - "Community 60"
Cohesion: 0.17
Nodes (11): Adding a Required Field, Changing a Field Type, Cleaning Up Orphaned Documents, Deleting a Field, Dual Read, Dual Write (Preferred), Migration Patterns Reference, Small Table Shortcut (+3 more)

### Community 61 - "Community 61"
Cohesion: 0.17
Nodes (11): Checklist, Concrete Steps, Convex Auth, Expected Files and Decisions, Gotchas, Human Handoff, Production, Validation (+3 more)

### Community 62 - "Community 62"
Cohesion: 0.17
Nodes (11): Adding a Required Field, Changing a Field Type, Cleaning Up Orphaned Documents, Deleting a Field, Dual Read, Dual Write (Preferred), Migration Patterns Reference, Small Table Shortcut (+3 more)

### Community 63 - "Community 63"
Cohesion: 0.17
Nodes (11): Checklist, Concrete Steps, Convex Auth, Expected Files and Decisions, Gotchas, Human Handoff, Production, Validation (+3 more)

### Community 64 - "Community 64"
Cohesion: 0.18
Nodes (10): Auth0, Checklist, Concrete Steps, Files and Env Vars To Expect, Gotchas, Key Setup Areas, Production, Validation (+2 more)

### Community 65 - "Community 65"
Cohesion: 0.18
Nodes (10): Checklist, Clerk, Concrete Steps, Files and Env Vars To Expect, Gotchas, Key Setup Areas, Production, Validation (+2 more)

### Community 66 - "Community 66"
Cohesion: 0.18
Nodes (10): Checklist, Concrete Steps, Files and Env Vars To Expect, Gotchas, Key Setup Areas, Production, Validation, What To Do (+2 more)

### Community 67 - "Community 67"
Cohesion: 0.18
Nodes (10): After Choosing a Provider, Checklist, Convex Authentication Setup, Core Pattern: Protecting Backend Functions, First Step: Choose the Auth Provider, Provider References, Reference Files, When Not to Use (+2 more)

### Community 68 - "Community 68"
Cohesion: 0.18
Nodes (10): Auth0, Checklist, Concrete Steps, Files and Env Vars To Expect, Gotchas, Key Setup Areas, Production, Validation (+2 more)

### Community 69 - "Community 69"
Cohesion: 0.18
Nodes (10): Checklist, Clerk, Concrete Steps, Files and Env Vars To Expect, Gotchas, Key Setup Areas, Production, Validation (+2 more)

### Community 70 - "Community 70"
Cohesion: 0.18
Nodes (10): Checklist, Concrete Steps, Files and Env Vars To Expect, Gotchas, Key Setup Areas, Production, Validation, What To Do (+2 more)

### Community 71 - "Community 71"
Cohesion: 0.18
Nodes (10): After Choosing a Provider, Checklist, Convex Authentication Setup, Core Pattern: Protecting Backend Functions, First Step: Choose the Auth Provider, Provider References, Reference Files, When Not to Use (+2 more)

### Community 72 - "Community 72"
Cohesion: 0.20
Nodes (8): DashboardWrapper(), Onboarding(), OrgProvider(), SidebarInset, SidebarProvider, SidebarTrigger, Toaster(), ToasterProps

### Community 73 - "Community 73"
Cohesion: 0.25
Nodes (7): Build Flow, Checklist, Default Approach, Package Exports, Packaged Convex Components, Testing, When to Choose This

### Community 74 - "Community 74"
Cohesion: 0.25
Nodes (7): Build Flow, Checklist, Default Approach, Package Exports, Packaged Convex Components, Testing, When to Choose This

### Community 75 - "Community 75"
Cohesion: 0.33
Nodes (5): Advanced Component Patterns, Class-based client wrappers, Deriving validators from schema, Function Handles for callbacks, Static configuration with a globals table

### Community 76 - "Community 76"
Cohesion: 0.33
Nodes (5): Checklist, Default Advice, Hybrid Convex Components, Risks, What This Means

### Community 77 - "Community 77"
Cohesion: 0.33
Nodes (5): Checklist, Default Layout, Local Convex Components, When to Choose This, Workflow Notes

### Community 78 - "Community 78"
Cohesion: 0.33
Nodes (5): Advanced Component Patterns, Class-based client wrappers, Deriving validators from schema, Function Handles for callbacks, Static configuration with a globals table

### Community 79 - "Community 79"
Cohesion: 0.33
Nodes (5): Checklist, Default Advice, Hybrid Convex Components, Risks, What This Means

### Community 80 - "Community 80"
Cohesion: 0.33
Nodes (5): Checklist, Default Layout, Local Convex Components, When to Choose This, Workflow Notes

### Community 81 - "Community 81"
Cohesion: 0.33
Nodes (5): getExpensesReport, getInventoryReport, getLeadConversionReport, getSalesAndProfitReport, getSalespersonPerformance

### Community 82 - "Community 82"
Cohesion: 0.33
Nodes (5): create, getHistory, list, remove, update

### Community 83 - "Community 83"
Cohesion: 0.40
Nodes (4): Convex, Route to the Right Skill, Start Here, When Not to Use

### Community 84 - "Community 84"
Cohesion: 0.40
Nodes (4): Convex, Route to the Right Skill, Start Here, When Not to Use

### Community 85 - "Community 85"
Cohesion: 0.40
Nodes (4): Get started, Join the community, Learn more, Welcome to your Convex + Next.js + Clerk app

## Knowledge Gaps
- **801 isolated node(s):** `STAGES`, `defaultEndDate`, `defaultStartDate`, `inter`, `cairo` (+796 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **11 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `api` connect `Community 43` to `Community 0`, `Community 72`, `Community 9`, `Community 10`, `Community 8`, `Community 12`, `Community 16`, `Community 19`, `Community 24`?**
  _High betweenness centrality (0.011) - this node is a cross-community bridge._
- **Why does `useOrg()` connect `Community 5` to `Community 0`, `Community 72`, `Community 8`, `Community 10`, `Community 43`, `Community 12`, `Community 16`, `Community 19`, `Community 24`?**
  _High betweenness centrality (0.010) - this node is a cross-community bridge._
- **Why does `query` connect `Community 11` to `Community 10`, `Community 81`, `Community 18`, `Community 82`, `Community 20`, `Community 21`, `Community 22`, `Community 49`, `Community 17`, `Community 26`?**
  _High betweenness centrality (0.008) - this node is a cross-community bridge._
- **What connects `STAGES`, `defaultEndDate`, `defaultStartDate` to the rest of the system?**
  _801 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.08135593220338982 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.05405405405405406 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.08666666666666667 - nodes in this community are weakly interconnected._