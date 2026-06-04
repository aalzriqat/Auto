# Graph Report - .  (2026-06-04)

## Corpus Check
- 63 files · ~68,968 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 462 nodes · 928 edges · 40 communities (37 shown, 3 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

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
- [[_COMMUNITY_Community 37|Community 37]]
- [[_COMMUNITY_Community 38|Community 38]]

## God Nodes (most connected - your core abstractions)
1. `useOrg()` - 31 edges
2. `api` - 24 edges
3. `cn()` - 22 edges
4. `Button` - 20 edges
5. `DialogHeader()` - 17 edges
6. `compilerOptions` - 16 edges
7. `DialogContent` - 16 edges
8. `DialogTitle` - 16 edges
9. `DialogDescription` - 16 edges
10. `Input` - 16 edges

## Surprising Connections (you probably didn't know these)
- `CustomersPage()` --calls--> `useOrg()`  [EXTRACTED]
  app/(dashboard)/customers/page.tsx → components/providers/OrgProvider.tsx
- `DashboardPage()` --calls--> `useOrg()`  [EXTRACTED]
  app/(dashboard)/dashboard/page.tsx → components/providers/OrgProvider.tsx
- `ExpensesPage()` --calls--> `useOrg()`  [EXTRACTED]
  app/(dashboard)/expenses/page.tsx → components/providers/OrgProvider.tsx
- `Onboarding()` --calls--> `useOrg()`  [EXTRACTED]
  app/(dashboard)/layout.tsx → components/providers/OrgProvider.tsx
- `DashboardWrapper()` --calls--> `useOrg()`  [EXTRACTED]
  app/(dashboard)/layout.tsx → components/providers/OrgProvider.tsx

## Import Cycles
- None detected.

## Communities (40 total, 3 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.10
Nodes (59): CustomerFormValues, customerSchema, ExpenseDialogProps, ExpenseFormValues, expenseSchema, api, LeadDialogProps, LeadFormValues (+51 more)

### Community 1 - "Community 1"
Cohesion: 0.06
Nodes (32): dependencies, @base-ui/react, class-variance-authority, clerk, @clerk/nextjs, clsx, convex, @hookform/resolvers (+24 more)

### Community 2 - "Community 2"
Cohesion: 0.09
Nodes (27): useIsMobile(), navigation, Sidebar, SidebarContext, SidebarContextProps, SidebarFooter, SidebarGroup, SidebarGroupAction (+19 more)

### Community 3 - "Community 3"
Cohesion: 0.11
Nodes (13): cairo, geistMono, geistSans, inter, metadata, convex, ar, en (+5 more)

### Community 4 - "Community 4"
Cohesion: 0.10
Nodes (19): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+11 more)

### Community 5 - "Community 5"
Cohesion: 0.13
Nodes (15): CustomersPage(), DashboardWrapper(), Onboarding(), DashboardPage(), ExpensesPage(), LeadsPage(), useOrg(), SalesPage() (+7 more)

### Community 6 - "Community 6"
Cohesion: 0.11
Nodes (17): aliases, components, hooks, lib, ui, utils, iconLibrary, rsc (+9 more)

### Community 7 - "Community 7"
Cohesion: 0.12
Nodes (16): compilerOptions, allowJs, allowSyntheticDefaultImports, forceConsistentCasingInFileNames, isolatedModules, jsx, lib, module (+8 more)

### Community 8 - "Community 8"
Cohesion: 0.16
Nodes (12): cn(), DropdownMenuShortcut(), Separator, SheetContent, SheetContentProps, SheetDescription, SheetFooter(), SheetHeader() (+4 more)

### Community 9 - "Community 9"
Cohesion: 0.13
Nodes (4): http, components, internal, httpAction

### Community 10 - "Community 10"
Cohesion: 0.15
Nodes (11): crons, triggerAlarms, grantTaskPermissionsToAll, list, markAllAsRead, markAsRead, create, list (+3 more)

### Community 11 - "Community 11"
Cohesion: 0.22
Nodes (11): create, get, listMine, remove, update, ALL_PERMISSIONS, DEFAULT_ROLE_TEMPLATES, requireAuth() (+3 more)

### Community 12 - "Community 12"
Cohesion: 0.20
Nodes (11): DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSubContent, DropdownMenuSubTrigger (+3 more)

### Community 13 - "Community 13"
Cohesion: 0.41
Nodes (12): computedHash, skillPath, source, sourceType, skills, convex, convex-create-component, convex-migration-helper (+4 more)

### Community 14 - "Community 14"
Cohesion: 0.20
Nodes (10): devDependencies, @convex-dev/eslint-plugin, eslint, eslint-config-next, prettier, tailwindcss, @tailwindcss/postcss, @types/node (+2 more)

### Community 15 - "Community 15"
Cohesion: 0.22
Nodes (8): name, private, scripts, build, dev, lint, start, version

### Community 16 - "Community 16"
Cohesion: 0.25
Nodes (6): stats, deleteUser, getMe, updateOrCreateUser, internalMutation, query

### Community 17 - "Community 17"
Cohesion: 0.25
Nodes (7): create, get, getByVin, list, remove, update, vehicleStatus

### Community 18 - "Community 18"
Cohesion: 0.29
Nodes (6): create, get, getByEmail, list, remove, update

### Community 19 - "Community 19"
Cohesion: 0.29
Nodes (5): sendTaskAlarm, addNumber, listNumbers, myAction, action

### Community 20 - "Community 20"
Cohesion: 0.29
Nodes (6): create, get, leadStage, list, remove, update

### Community 21 - "Community 21"
Cohesion: 0.29
Nodes (6): add, getMyMembership, leave, list, remove, updateRole

### Community 22 - "Community 22"
Cohesion: 0.29
Nodes (6): create, get, list, remove, saleStatus, update

### Community 23 - "Community 23"
Cohesion: 0.29
Nodes (6): CompanyInfo, CustomerInfo, generateBillOfSale(), generateQuote(), PricingInfo, VehicleInfo

### Community 24 - "Community 24"
Cohesion: 0.29
Nodes (6): Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle

### Community 25 - "Community 25"
Cohesion: 0.33
Nodes (5): create, expenseCategory, list, remove, update

### Community 26 - "Community 26"
Cohesion: 0.33
Nodes (5): create, get, list, remove, update

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
Cohesion: 0.40
Nodes (3): Doc, Id, TableNames

### Community 31 - "Community 31"
Cohesion: 0.50
Nodes (3): config, isProtectedRoute, isPublicRoute

## Knowledge Gaps
- **265 isolated node(s):** `geistSans`, `geistMono`, `metadata`, `convex`, `guidelinesHash` (+260 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **3 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `api` connect `Community 0` to `Community 5`, `Community 9`, `Community 10`, `Community 12`, `Community 19`?**
  _High betweenness centrality (0.074) - this node is a cross-community bridge._
- **Why does `query` connect `Community 16` to `Community 10`, `Community 11`, `Community 17`, `Community 18`, `Community 19`, `Community 20`, `Community 21`, `Community 22`, `Community 25`, `Community 26`?**
  _High betweenness centrality (0.062) - this node is a cross-community bridge._
- **Why does `mutation` connect `Community 10` to `Community 11`, `Community 17`, `Community 18`, `Community 19`, `Community 20`, `Community 21`, `Community 22`, `Community 25`, `Community 26`?**
  _High betweenness centrality (0.060) - this node is a cross-community bridge._
- **What connects `geistSans`, `geistMono`, `metadata` to the rest of the system?**
  _265 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.10167499265354099 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.0625 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.0896551724137931 - nodes in this community are weakly interconnected._