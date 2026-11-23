import ts from "typescript";
import { updateTable } from "./source";

export const CALLABLES = [
  "owned",
  "supplierVehicleLabel",
  "supplierVehicleHref",
  "saleSource",
  "vehicleSource",
  "sourceFor",
  "addSupplierRowContext",
  "supplierNavigationFailure"
];

export const IMPORT_FORMS = [
  "import{ConvexError,v,typeInfer}from\"convex/values\";",
  "importtype{Doc,Id}from\"../_generated/dataModel\";",
  "importtype{QueryCtx}from\"../_generated/server\";",
  "import{PERMISSIONS}from\"./permissions\";",
  "importtype{ObligationKind}from\"./supplierObligationDue\";",
  "importtype{SupplierObligation}from\"./supplierSettledRows\";",
  "import{readCached,SupplierReadBudgetExhausted,typeCachedTable,typeSupplierReadCache}from\"./supplierReadCache\";",
  "import{inTurn}from\"./transactionReadHeadroom\";"
];

const PROPERTY_FORMS = [
  "module:v.object",
  "module:v.union",
  "module:v.literal",
  "module:v.string",
  "module:v.null",
  "module:v.number",
  "module:v.optional",
  "owned:doc.orgId",
  "owned:doc.isDeleted",
  "supplierVehicleLabel:vehicle.year",
  "supplierVehicleLabel:vehicle.make",
  "supplierVehicleLabel:vehicle.model",
  "supplierVehicleHref:permissions.includes",
  "supplierVehicleHref:PERMISSIONS.VIEW_VEHICLES",
  "saleSource:args.orgId",
  "saleSource:args.cache.sales",
  "saleSource:args.cache",
  "saleSource:args.permissions.includes",
  "saleSource:args.permissions",
  "saleSource:PERMISSIONS.VIEW_SALES",
  "saleSource:sale.dealNumber",
  "saleSource:sale._id",
  "saleSource:sale.applicationId",
  "saleSource:args.cache.applications",
  "saleSource:app._id",
  "vehicleSource:vehicle._id",
  "vehicleSource:args.orgId",
  "vehicleSource:args.permissions",
  "sourceFor:obligation.origin",
  "sourceFor:args.orgId",
  "sourceFor:args.cache.openings",
  "sourceFor:args.cache",
  "sourceFor:obligation.openingBalanceDraftId",
  "sourceFor:draft?.status",
  "sourceFor:args.permissions.includes",
  "sourceFor:args.permissions",
  "sourceFor:PERMISSIONS.MANAGE_FINANCE",
  "sourceFor:draft._id",
  "sourceFor:obligation.title",
  "sourceFor:args.cache.expenses",
  "sourceFor:obligation.expenseId",
  "sourceFor:args.cache.vehicles",
  "sourceFor:obligation.vehicleId",
  "sourceFor:expense._id",
  "sourceFor:expense.title",
  "sourceFor:obligation.saleId",
  "addSupplierRowContext:section.rows",
  "addSupplierRowContext:Number.isSafeInteger",
  "addSupplierRowContext:obligation.createdAt",
  "addSupplierRowContext:Math.abs",
  "addSupplierRowContext:row.kind",
  "addSupplierRowContext:obligation.sourcedFromName",
  "addSupplierRowContext:Object.assign",
  "addSupplierRowContext:rows.push",
  "supplierNavigationFailure:error.data",
  "supplierNavigationFailure:console.error"
];

const CALL_FORMS = [
  "module:v.object",
  "module:v.union",
  "module:v.literal",
  "module:v.string",
  "module:v.null",
  "module:v.number",
  "module:v.optional",
  "owned:readCached",
  "supplierVehicleHref:permissions.includes",
  "saleSource:owned",
  "saleSource:args.permissions.includes",
  "vehicleSource:supplierVehicleLabel",
  "vehicleSource:supplierVehicleHref",
  "sourceFor:owned",
  "sourceFor:args.permissions.includes",
  "sourceFor:vehicleSource",
  "sourceFor:saleSource",
  "sourceFor:supplierVehicleLabel",
  "addSupplierRowContext:inTurn",
  "addSupplierRowContext:Number.isSafeInteger",
  "addSupplierRowContext:Math.abs",
  "addSupplierRowContext:Object.assign",
  "addSupplierRowContext:sourceFor",
  "addSupplierRowContext:rows.push",
  "supplierNavigationFailure:console.error"
];

export const READ_FORMS = [
  "owned:readCached(ctx,cache,id)",
  "saleSource:owned(ctx,args.orgId,args.cache.sales,saleId)",
  "saleSource:owned(ctx,args.orgId,args.cache.applications,sale.applicationId)",
  "sourceFor:owned(ctx,args.orgId,args.cache.openings,obligation.openingBalanceDraftId)",
  "sourceFor:owned(ctx,args.orgId,args.cache.expenses,obligation.expenseId)",
  "sourceFor:owned(ctx,args.orgId,args.cache.vehicles,obligation.vehicleId)",
  "sourceFor:owned(ctx,args.orgId,args.cache.vehicles,obligation.vehicleId)"
];

export const CONDITION_AXIS : Readonly<Record<string, readonly string[]>> = {
  "owned:!doc||!(\"orgId\"indoc)||doc.orgId!==orgId": [
    "saleTarget",
    "applicationTarget",
    "expenseTarget",
    "draftTarget",
    "vehicle"
  ],
  "owned:!doc||!(\"orgId\"indoc)": [
    "saleTarget",
    "applicationTarget",
    "expenseTarget",
    "draftTarget",
    "vehicle"
  ],
  "owned:!doc": [
    "saleTarget",
    "applicationTarget",
    "expenseTarget",
    "draftTarget",
    "vehicle"
  ],
  "owned:!(\"orgId\"indoc)": [
    "saleTarget",
    "applicationTarget",
    "expenseTarget",
    "draftTarget",
    "vehicle"
  ],
  "owned:\"orgId\"indoc": [
    "saleTarget",
    "applicationTarget",
    "expenseTarget",
    "draftTarget",
    "vehicle"
  ],
  "owned:doc.orgId!==orgId": [
    "saleTarget",
    "applicationTarget",
    "expenseTarget",
    "draftTarget",
    "vehicle"
  ],
  "owned:\"isDeleted\"indoc&&doc.isDeleted": [
    "saleTarget",
    "applicationTarget",
    "expenseTarget",
    "draftTarget",
    "vehicle"
  ],
  "owned:\"isDeleted\"indoc": [
    "saleTarget",
    "applicationTarget",
    "expenseTarget",
    "draftTarget",
    "vehicle"
  ],
  "supplierVehicleHref:permissions.includes(PERMISSIONS.VIEW_VEHICLES)": [
    "viewVehicles"
  ],
  "saleSource:!sale": [
    "saleTarget"
  ],
  "saleSource:sale.dealNumber": [
    "dealNumber"
  ],
  "saleSource:vehicleLabel??sale._id": [
    "vehicle",
    "identity"
  ],
  "saleSource:!sale.applicationId": [
    "shape"
  ],
  "saleSource:canOpen": [
    "viewSales"
  ],
  "saleSource:!app": [
    "applicationTarget"
  ],
  "vehicleSource:vehicle": [
    "vehicle"
  ],
  "sourceFor:\"origin\"inobligation&&obligation.origin===\"OPENING\"": [
    "shape"
  ],
  "sourceFor:\"origin\"inobligation": [
    "shape"
  ],
  "sourceFor:obligation.origin===\"OPENING\"": [
    "shape"
  ],
  "sourceFor:draft?.status!==\"POSTED\"": [
    "draftTarget",
    "status"
  ],
  "sourceFor:draft?.status": [
    "draftTarget",
    "status"
  ],
  "sourceFor:canOpen": [
    "manageFinance"
  ],
  "sourceFor:!(\"vehicleId\"inobligation)": [
    "shape"
  ],
  "sourceFor:\"vehicleId\"inobligation": [
    "shape"
  ],
  "sourceFor:\"expenseId\"inobligation": [
    "shape"
  ],
  "sourceFor:!expense": [
    "expenseTarget"
  ],
  "sourceFor:\"saleId\"inobligation&&obligation.saleId": [
    "shape"
  ],
  "sourceFor:\"saleId\"inobligation": [
    "shape"
  ],
  "sourceFor:vehicle": [
    "vehicle"
  ],
  "addSupplierRowContext:Number.isSafeInteger(obligation.createdAt)&&Math.abs(obligation.createdAt)<=8.64e15": [
    "timestamp"
  ],
  "addSupplierRowContext:Math.abs(obligation.createdAt)<=8.64e15": [
    "timestamp"
  ],
  "addSupplierRowContext:row.kind===\"PAYABLE\"": [
    "role"
  ],
  "addSupplierRowContext:error": [
    "budget"
  ],
  "addSupplierRowContext:!(errorinstanceofSupplierReadBudgetExhausted)": [
    "budget"
  ],
  "addSupplierRowContext:errorinstanceofSupplierReadBudgetExhausted": [
    "budget"
  ],
  "supplierNavigationFailure:code===\"SUPPLIER_ATTENTION_UNAVAILABLE\"&&errorinstanceofConvexError&&typeoferror.data===\"object\"&&error.data!==null&&\"code\"inerror.data": [
    "serialization"
  ],
  "supplierNavigationFailure:code===\"SUPPLIER_ATTENTION_UNAVAILABLE\"&&errorinstanceofConvexError&&typeoferror.data===\"object\"&&error.data!==null": [
    "serialization"
  ],
  "supplierNavigationFailure:code===\"SUPPLIER_ATTENTION_UNAVAILABLE\"&&errorinstanceofConvexError&&typeoferror.data===\"object\"": [
    "serialization"
  ],
  "supplierNavigationFailure:code===\"SUPPLIER_ATTENTION_UNAVAILABLE\"&&errorinstanceofConvexError": [
    "serialization"
  ],
  "supplierNavigationFailure:code===\"SUPPLIER_ATTENTION_UNAVAILABLE\"": [
    "serialization"
  ],
  "supplierNavigationFailure:errorinstanceofConvexError": [
    "serialization"
  ],
  "supplierNavigationFailure:typeoferror.data===\"object\"": [
    "serialization"
  ],
  "supplierNavigationFailure:error.data!==null": [
    "serialization"
  ],
  "supplierNavigationFailure:\"code\"inerror.data": [
    "serialization"
  ]
};

export function unsupported(source: ts.SourceFile, node: ts.Node, form: string): never {
  const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  throw new Error(`Unsupported navigation ${form}: ${ts.SyntaxKind[node.kind]} at ${source.fileName}:${line}: ${node.getText(source).slice(0, 160)}; ${updateTable}; update SUPPLIER_NAVIGATION_DOORS, CONDITION_AXIS and the named form table`);
}

export const compact = (node: ts.Node, source: ts.SourceFile) => node.getText(source).replace(/\s+/g, "");

export function conditionNode(source: ts.SourceFile, node: ts.Node): ts.Node | undefined {
  switch (node.kind) {
    case ts.SyntaxKind.IfStatement: return (node as ts.IfStatement).expression;
    case ts.SyntaxKind.CatchClause: return (node as ts.CatchClause).variableDeclaration?.name ?? node;
    case ts.SyntaxKind.ConditionalExpression: return (node as ts.ConditionalExpression).condition;
    case ts.SyntaxKind.PrefixUnaryExpression: checkUnaryForm(source, node as ts.PrefixUnaryExpression); return node;
    case ts.SyntaxKind.BinaryExpression: checkBinaryForm(source, node as ts.BinaryExpression); return node;
    case ts.SyntaxKind.PropertyAccessExpression: case ts.SyntaxKind.CallExpression: case ts.SyntaxKind.ElementAccessExpression:
      return (node as ts.PropertyAccessExpression | ts.CallExpression | ts.ElementAccessExpression).questionDotToken ? node : undefined;
    case ts.SyntaxKind.Identifier:
    case ts.SyntaxKind.ObjectLiteralExpression:
    case ts.SyntaxKind.AwaitExpression:
    case ts.SyntaxKind.NewExpression:
    case ts.SyntaxKind.TypeOfExpression:
    case ts.SyntaxKind.SpreadAssignment:
    case ts.SyntaxKind.ObjectBindingPattern:
    case ts.SyntaxKind.SourceFile:
    case ts.SyntaxKind.ImportDeclaration:
    case ts.SyntaxKind.ImportClause:
    case ts.SyntaxKind.NamedImports:
    case ts.SyntaxKind.ImportSpecifier:
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.VariableStatement:
    case ts.SyntaxKind.ExportKeyword:
    case ts.SyntaxKind.VariableDeclarationList:
    case ts.SyntaxKind.VariableDeclaration:
    case ts.SyntaxKind.FunctionDeclaration:
    case ts.SyntaxKind.AsyncKeyword:
    case ts.SyntaxKind.Parameter:
    case ts.SyntaxKind.Block:
    case ts.SyntaxKind.ReturnStatement:
    case ts.SyntaxKind.NullKeyword:
    case ts.SyntaxKind.ParenthesizedExpression:
    case ts.SyntaxKind.TemplateExpression:
    case ts.SyntaxKind.TemplateHead:
    case ts.SyntaxKind.TemplateSpan:
    case ts.SyntaxKind.TemplateMiddle:
    case ts.SyntaxKind.TemplateTail:
    case ts.SyntaxKind.PropertyAssignment: case ts.SyntaxKind.ShorthandPropertyAssignment:
    case ts.SyntaxKind.QuestionToken:
    case ts.SyntaxKind.ColonToken:
    case ts.SyntaxKind.QuestionDotToken:
    case ts.SyntaxKind.ArrayLiteralExpression:
    case ts.SyntaxKind.ExpressionStatement:
    case ts.SyntaxKind.ArrowFunction:
    case ts.SyntaxKind.EqualsGreaterThanToken:
    case ts.SyntaxKind.BindingElement:
    case ts.SyntaxKind.DotDotDotToken:
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.TryStatement:
    case ts.SyntaxKind.ThrowStatement:
    case ts.SyntaxKind.EndOfFileToken:
    case ts.SyntaxKind.BarBarToken:
    case ts.SyntaxKind.AmpersandAmpersandToken:
    case ts.SyntaxKind.InKeyword:
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.QuestionQuestionToken:
    case ts.SyntaxKind.LessThanEqualsToken:
    case ts.SyntaxKind.InstanceOfKeyword: return undefined;
    default: unsupported(source, node, "unlisted condition kind; update conditionNode and checkRuntimeForm");
  }
}

export function checkPermissionForm(source: ts.SourceFile, node: ts.Node): string | undefined {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
  const receiver = node.expression.expression;
  const text = compact(receiver, source);
  if (!text.includes("permissions")) return;
  if (!["permissions", "args.permissions"].includes(text) || node.expression.name.text !== "includes" || node.arguments.length !== 1) unsupported(source, node, "permission read (only permissions.includes(PERMISSIONS.NAME))");
  const permission = node.arguments[0]!;
  if (!ts.isPropertyAccessExpression(permission) || !ts.isIdentifier(permission.expression) || permission.expression.text !== "PERMISSIONS") unsupported(source, node, "permission argument (requires PERMISSIONS.NAME; no string literal)");
  return permission.name.text;
}

export function checkCallable(source: ts.SourceFile, node: ts.Node, fn: string): string {
  if (ts.isFunctionDeclaration(node)) {
    if (!node.name || !CALLABLES.includes(node.name.text)) unsupported(source, node, "function declaration");
    return node.name.text;
  }
  if (ts.isArrowFunction(node)) {
    const call = node.parent;
    if (!ts.isCallExpression(call) || call.expression.getText(source) !== "inTurn" || call.arguments[1] !== node || compact(node.parameters[0]!, source) !== "entry") unsupported(source, node, "arrow helper");
  }
  if (ts.isFunctionExpression(node) || ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node) || ts.isConstructorDeclaration(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) unsupported(source, node, "local callable");
  return fn;
}

function checkPermissionArrayRead(source: ts.SourceFile, node: ts.PropertyAccessExpression, fn: string) {
  if (node.name.text !== "permissions") return;
  const parent = node.parent;
  const includes = ts.isPropertyAccessExpression(parent) && parent.expression === node && parent.name.text === "includes";
  const forward = fn === "vehicleSource" && ts.isCallExpression(parent) && parent.expression.getText(source) === "supplierVehicleHref" && parent.arguments[2] === node;
  if (!includes && !forward) unsupported(source, node, "permission array read (only includes or the listed vehicleSource forwarding site)");
}

function checkPropertyRead(source: ts.SourceFile, node: ts.PropertyAccessExpression, fn: string) {
    checkPermissionArrayRead(source, node, fn);
    if (node.name.text === "db") unsupported(source, node, "document read ctx.db");
    if (!PROPERTY_FORMS.includes(`${fn}:${compact(node, source)}`)) unsupported(source, node, "property read");
}

function checkBarePermissionRead(source: ts.SourceFile, node: ts.Node, fn: string) {
  if (!ts.isIdentifier(node) || node.text !== "permissions" || fn !== "supplierVehicleHref") return;
  const parent = node.parent;
  if (ts.isParameter(parent) && parent.name === node) return;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node && parent.name.text === "includes") return;
  unsupported(source, node, "permission array binding / read");
}

const OBJECT_FORMS = [
  "module:{kind:v.union(v.literal(\"VEHICLE\"),v.literal(\"SALE\"),v.literal(\"APPLICATION\"),v.literal(\"EXPENSE\"),v.literal(\"OPENING\")),id:v.string(),label:v.string(),href:v.union(v.string(),v.null()),}",
  "module:{role:v.union(v.literal(\"AP\"),v.literal(\"AR\")),occurredAt:v.union(v.number(),v.null()),counterparty:v.string(),source:v.union(supplierSourceValidator,v.null()),vehicleSource:v.optional(v.union(supplierSourceValidator,v.null())),}",
  "saleSource:{kind:\"SALE\",id:sale._id,label,href:canOpen?`/${args.orgId}/sales/${sale._id}/deal`:null}",
  "saleSource:{kind:\"SALE\",id:sale._id,label,href:null}",
  "saleSource:{kind:\"APPLICATION\",id:app._id,label,href:canOpen?`/${args.orgId}/applications/${app._id}/deal`:null}",
  "vehicleSource:{kind:\"VEHICLE\",id:vehicle._id,label:supplierVehicleLabel(vehicle),href:supplierVehicleHref(args.orgId,vehicle._id,args.permissions)}",
  "sourceFor:{source:null}",
  "sourceFor:{source:{kind:\"OPENING\",id:draft._id,label:obligation.title,href:canOpen?`/${args.orgId}/accounting?section=settings`:null}}",
  "sourceFor:{kind:\"OPENING\",id:draft._id,label:obligation.title,href:canOpen?`/${args.orgId}/accounting?section=settings`:null}",
  "sourceFor:{source:{kind:\"EXPENSE\",id:expense._id,label:expense.title,href:null},vehicleSource:vehicleSource(args,vehicle)}",
  "sourceFor:{kind:\"EXPENSE\",id:expense._id,label:expense.title,href:null}",
  "sourceFor:{source:awaitsaleSource(ctx,args,obligation.saleId,vehicle?supplierVehicleLabel(vehicle):null)}",
  "sourceFor:{source:vehicleSource(args,vehicle)}",
  "addSupplierRowContext:{role:row.kind===\"PAYABLE\"?\"AP\":\"AR\",occurredAt,counterparty:obligation.sourcedFromName,source:null,vehicleSource:null}",
  "addSupplierRowContext:{...row,context}",
  "addSupplierRowContext:{...section,rows}",
  "module:{SUPPLIER_NAVIGATION_UNAVAILABLE:\"Supplierrecordscouldnotbeloaded.Pleasetryagain.\",SUPPLIER_ATTENTION_UNAVAILABLE:\"Supplierattentioncouldnotbeloaded.Pleasetryagain.\",}",
  "supplierNavigationFailure:{code,message:READ_FAILURE_MESSAGE[code]}",
];

const CALL_ARGUMENT_FORMS = [
  "saleSource:owned(ctx,args.orgId,args.cache.sales,saleId)",
  "saleSource:owned(ctx,args.orgId,args.cache.applications,sale.applicationId)",
  "vehicleSource:supplierVehicleLabel(vehicle)",
  "vehicleSource:supplierVehicleHref(args.orgId,vehicle._id,args.permissions)",
  "sourceFor:owned(ctx,args.orgId,args.cache.openings,obligation.openingBalanceDraftId)",
  "sourceFor:owned(ctx,args.orgId,args.cache.expenses,obligation.expenseId)",
  "sourceFor:owned(ctx,args.orgId,args.cache.vehicles,obligation.vehicleId)",
  "sourceFor:vehicleSource(args,vehicle)",
  "sourceFor:saleSource(ctx,args,obligation.saleId,vehicle?supplierVehicleLabel(vehicle):null)",
  "sourceFor:supplierVehicleLabel(vehicle)",
  "addSupplierRowContext:Object.assign(context,awaitsourceFor(ctx,args,obligation))",
  "addSupplierRowContext:sourceFor(ctx,args,obligation)",
];

const AWAIT_FORMS = [
  "owned:awaitreadCached(ctx,cache,id)",
  "saleSource:awaitowned(ctx,args.orgId,args.cache.sales,saleId)",
  "saleSource:awaitowned(ctx,args.orgId,args.cache.applications,sale.applicationId)",
  "sourceFor:awaitowned(ctx,args.orgId,args.cache.openings,obligation.openingBalanceDraftId)",
  "sourceFor:awaitowned(ctx,args.orgId,args.cache.expenses,obligation.expenseId)",
  "sourceFor:awaitowned(ctx,args.orgId,args.cache.vehicles,obligation.vehicleId)",
  "sourceFor:awaitsaleSource(ctx,args,obligation.saleId,vehicle?supplierVehicleLabel(vehicle):null)",
  "addSupplierRowContext:awaitsourceFor(ctx,args,obligation)",
];

const BINARY_OPERATORS = [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.InKeyword,
  ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.InstanceOfKeyword];

const NAVIGATION_GLOBALS = ["Number", "Math", "Object", "console"];

function checkBinaryForm(source: ts.SourceFile, node: ts.BinaryExpression) {
  if (!BINARY_OPERATORS.includes(node.operatorToken.kind)) unsupported(source, node.operatorToken, "binary operator; update BINARY_OPERATORS");
}

function checkUnaryForm(source: ts.SourceFile, node: ts.PrefixUnaryExpression) {
  if (node.operator !== ts.SyntaxKind.ExclamationToken) unsupported(source, node, "unary operator; update checkRuntimeForm");
}

function checkCallArguments(source: ts.SourceFile, node: ts.CallExpression, fn: string) {
  const name = compact(node.expression, source);
  if (!CALL_FORMS.includes(`${fn}:${name}`)) unsupported(source, node, "call / permission member; update CALL_FORMS");
  if (["sourceFor", "saleSource", "vehicleSource", "supplierVehicleHref", "supplierVehicleLabel", "owned", "Object.assign"].includes(name) &&
    !CALL_ARGUMENT_FORMS.includes(`${fn}:${compact(node, source)}`)) unsupported(source, node, "call arguments; update CALL_ARGUMENT_FORMS");
}

function checkObjectForm(source: ts.SourceFile, node: ts.ObjectLiteralExpression, fn: string) {
  if (!OBJECT_FORMS.includes(`${fn}:${compact(node, source)}`)) unsupported(source, node, "object literal; update OBJECT_FORMS (no permissions or args spread)");
}

function checkAwaitForm(source: ts.SourceFile, node: ts.AwaitExpression, fn: string) {
  const turn = fn === "addSupplierRowContext" && ts.isExpressionStatement(node.parent) &&
    ts.isCallExpression(node.expression) && compact(node.expression.expression, source) === "inTurn";
  if (!turn && !AWAIT_FORMS.includes(`${fn}:${compact(node, source)}`)) unsupported(source, node, "await site; update AWAIT_FORMS");
}

function checkSpecialForm(source: ts.SourceFile, node: ts.Node, fn: string) {
  const special: Readonly<Record<number, readonly string[]>> = {
    [ts.SyntaxKind.NewExpression]: ['supplierNavigationFailure:newConvexError({code,message:READ_FAILURE_MESSAGE[code]})'],
    [ts.SyntaxKind.TypeOfExpression]: ['supplierNavigationFailure:typeoferror.data'],
    [ts.SyntaxKind.SpreadAssignment]: ['addSupplierRowContext:...row', 'addSupplierRowContext:...section'],
    [ts.SyntaxKind.ElementAccessExpression]: ['supplierNavigationFailure:READ_FAILURE_MESSAGE[code]'],
    [ts.SyntaxKind.ObjectBindingPattern]: ['addSupplierRowContext:{document:obligation,...row}'],
  };
  if (!special[node.kind]?.includes(`${fn}:${compact(node, source)}`)) unsupported(source, node, "special form; update checkSpecialForm");
}

export function identifierChecker(source: ts.SourceFile): ts.TypeChecker {
  // Bind this source with the compiler, including lexical block/parameter scopes.
  // No library or imported body is loaded; those bindings are pinned separately.
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, target: ts.ScriptTarget.Latest };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = file => file === source.fileName ? source : undefined;
  return ts.createProgram([source.fileName], options, host).getTypeChecker();
}

function checkIdentifier(source: ts.SourceFile, node: ts.Identifier, checker: ts.TypeChecker) {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return; // PROPERTY_FORMS pins the entire access.
  if (ts.isPropertyAssignment(parent) && parent.name === node) return; // OBJECT_FORMS pins its name and value.
  if (ts.isBindingElement(parent) && parent.propertyName === node) return; // Binding shape is pinned.
  if (NAVIGATION_GLOBALS.includes(node.text)) return;
  const symbol = ts.isShorthandPropertyAssignment(parent) ? checker.getShorthandAssignmentValueSymbol(parent) : checker.getSymbolAtLocation(node);
  const declared = symbol?.declarations?.some(declaration => declaration.getSourceFile() === source &&
    [ts.SyntaxKind.Parameter, ts.SyntaxKind.VariableDeclaration, ts.SyntaxKind.BindingElement, ts.SyntaxKind.FunctionDeclaration,
      ts.SyntaxKind.ImportSpecifier, ts.SyntaxKind.TypeParameter, ts.SyntaxKind.TypeAliasDeclaration].includes(declaration.kind));
  if (!declared) unsupported(source, node, "unresolved identifier; update NAVIGATION_GLOBALS or the pinned import/local bindings");
}

export function checkRuntimeForm(source: ts.SourceFile, node: ts.Node, fn: string, checker: ts.TypeChecker) {
  checkBarePermissionRead(source, node, fn);
  switch (node.kind) {
    case ts.SyntaxKind.Identifier: checkIdentifier(source, node as ts.Identifier, checker); return;
    case ts.SyntaxKind.BinaryExpression: checkBinaryForm(source, node as ts.BinaryExpression); return;
    case ts.SyntaxKind.PrefixUnaryExpression: checkUnaryForm(source, node as ts.PrefixUnaryExpression); return;
    case ts.SyntaxKind.CallExpression: checkCallArguments(source, node as ts.CallExpression, fn); return;
    case ts.SyntaxKind.PropertyAccessExpression: checkPropertyRead(source, node as ts.PropertyAccessExpression, fn); return;
    case ts.SyntaxKind.ObjectLiteralExpression: checkObjectForm(source, node as ts.ObjectLiteralExpression, fn); return;
    case ts.SyntaxKind.AwaitExpression: checkAwaitForm(source, node as ts.AwaitExpression, fn); return;
    case ts.SyntaxKind.NewExpression: case ts.SyntaxKind.TypeOfExpression: case ts.SyntaxKind.SpreadAssignment:
    case ts.SyntaxKind.ElementAccessExpression: case ts.SyntaxKind.ObjectBindingPattern: checkSpecialForm(source, node, fn); return;
    case ts.SyntaxKind.SourceFile: case ts.SyntaxKind.ImportDeclaration: case ts.SyntaxKind.ImportClause:
    case ts.SyntaxKind.NamedImports: case ts.SyntaxKind.ImportSpecifier: case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.VariableStatement: case ts.SyntaxKind.ExportKeyword: case ts.SyntaxKind.VariableDeclarationList:
    case ts.SyntaxKind.VariableDeclaration: case ts.SyntaxKind.FunctionDeclaration: case ts.SyntaxKind.AsyncKeyword:
    case ts.SyntaxKind.Parameter: case ts.SyntaxKind.Block: case ts.SyntaxKind.IfStatement: case ts.SyntaxKind.ReturnStatement:
    case ts.SyntaxKind.NullKeyword: case ts.SyntaxKind.ParenthesizedExpression: case ts.SyntaxKind.TemplateExpression:
    case ts.SyntaxKind.TemplateHead: case ts.SyntaxKind.TemplateSpan: case ts.SyntaxKind.TemplateMiddle: case ts.SyntaxKind.TemplateTail:
    case ts.SyntaxKind.ConditionalExpression: case ts.SyntaxKind.PropertyAssignment: case ts.SyntaxKind.ShorthandPropertyAssignment: case ts.SyntaxKind.QuestionToken:
    case ts.SyntaxKind.ColonToken: case ts.SyntaxKind.QuestionDotToken: case ts.SyntaxKind.ArrayLiteralExpression:
    case ts.SyntaxKind.ExpressionStatement: case ts.SyntaxKind.ArrowFunction: case ts.SyntaxKind.EqualsGreaterThanToken:
    case ts.SyntaxKind.BindingElement: case ts.SyntaxKind.DotDotDotToken: case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.TryStatement: case ts.SyntaxKind.CatchClause: case ts.SyntaxKind.ThrowStatement: case ts.SyntaxKind.EndOfFileToken:
    case ts.SyntaxKind.BarBarToken: case ts.SyntaxKind.AmpersandAmpersandToken: case ts.SyntaxKind.InKeyword:
    case ts.SyntaxKind.ExclamationEqualsEqualsToken: case ts.SyntaxKind.EqualsEqualsEqualsToken: case ts.SyntaxKind.QuestionQuestionToken:
    case ts.SyntaxKind.LessThanEqualsToken: case ts.SyntaxKind.InstanceOfKeyword: return;
    default: unsupported(source, node, "unlisted runtime kind; update checkRuntimeForm and conditionNode");
  }
}

export type NavigationScan = {imports: string[]; functions: string[]; reads: string[]; arrows: number};

export function recordNavigationDeclarations(source: ts.SourceFile, node: ts.Node, fn: string, scan: NavigationScan) {
    if (ts.isImportDeclaration(node)) {
      if (!IMPORT_FORMS.includes(compact(node, source))) unsupported(source, node, "import");
      if (scan.imports.includes(compact(node, source))) unsupported(source, node, "duplicate import");
      scan.imports.push(compact(node, source));
    }
    if (ts.isFunctionDeclaration(node)) { if (scan.functions.includes(fn)) unsupported(source, node, "duplicate function declaration"); scan.functions.push(fn); }
    if (ts.isArrowFunction(node)) { if (scan.arrows > 0) unsupported(source, node, "duplicate arrow helper"); scan.arrows++; }
}

export function recordNavigationRead(source: ts.SourceFile, node: ts.Node, fn: string, scan: NavigationScan) {
    if (ts.isCallExpression(node) && ["owned", "readCached"].includes(node.expression.getText(source))) {
      const key = `${fn}:${compact(node, source)}`;
      if (!READ_FORMS.includes(key) || scan.reads.filter(read => read === key).length >= READ_FORMS.filter(read => read === key).length) unsupported(source, node, "document read owned/readCached site");
      scan.reads.push(key);
    }
}

export function assertNavigationSyntax(source: ts.SourceFile) {
  const diagnostic = ts.transpileModule(source.text, {fileName: source.fileName, reportDiagnostics: true,
    compilerOptions: {target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext}}).diagnostics?.find(item => item.category === ts.DiagnosticCategory.Error);
  if (!diagnostic) return;
  const line = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1;
  throw new Error(`Unsupported navigation syntax: SourceFile at ${source.fileName}:${line}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}; update SUPPLIER_NAVIGATION_DOORS and the form tables. ${updateTable}`);
}
