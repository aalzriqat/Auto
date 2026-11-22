// @vitest-environment node
// Replay scenarios resolve these literal registrations in this file.
import { test } from "vitest";
import * as navigation from "../../test-utils/supplierNavigationAudit/navigationCases";
import * as callers from "../../test-utils/supplierNavigationAudit/callerCases";
import * as runnerReferences from "../../test-utils/supplierNavigationAudit/runnerReferenceCases";
import * as closure from "../../test-utils/supplierNavigationAudit/sourceClosureCases";
import * as authorization from "../../test-utils/supplierNavigationAudit/authorizationCases";

test(
  "supplier navigation census refuses switch arrow and method controls",
  navigation.checkSupplierNavigationCensusRefusesSwitchArrowAndMethodControls,
);
test(
  "supplier navigation census refuses alias binding write and nullable controls",
  navigation.checkSupplierNavigationCensusRefusesAliasBindingWriteAndNullableControls,
);
test(
  "supplier navigation ownership calls and permission gates retain every declared door row",
  navigation.checkSupplierNavigationOwnershipCallsAndPermissionGatesRetainEveryDeclaredDoorRow,
);
test(
  "supplier navigation schema exemptions retain both impossible deletion states",
  navigation.checkSupplierNavigationSchemaExemptionsRetainBothImpossibleDeletionStates,
);
test(
  "every declared supplier navigation row names one active literal test registration",
  navigation.checkEveryDeclaredSupplierNavigationRowNamesOneActiveLiteralTestRegistration,
);
test(
  "every supplier navigation door covers its round six core and new base choice pairs",
  navigation.checkEverySupplierNavigationDoorCoversItsRoundSixCoreAndNewBaseChoicePairs,
);
test(
  "supplier navigation statement fingerprints require a reviewed door table for every token change",
  navigation.checkSupplierNavigationStatementFingerprintsRequireAReviewedDoorTableForEveryTokenChange,
);
test(
  "supplier navigation caller census pins every permission scope and binds public query behaviour",
  callers.checkSupplierNavigationCallerCensusPinsEveryPermissionScopeAndBindsPublicQueryBehaviour,
);
test(
  "supplier navigation caller bindings retain every permission scope and forwarding contract",
  callers.checkSupplierNavigationCallerBindingsRetainEveryPermissionScopeAndForwardingContract,
);
test(
  "supplier navigation caller sweep quarter 0 enumerates its recursive production files",
  callers.checkSupplierNavigationCallerSweepQuarter0EnumeratesItsRecursiveProductionFiles,
);
test(
  "supplier navigation caller sweep quarter 1 enumerates its recursive production files",
  callers.checkSupplierNavigationCallerSweepQuarter1EnumeratesItsRecursiveProductionFiles,
);
test(
  "supplier navigation caller sweep quarter 2 enumerates its recursive production files",
  callers.checkSupplierNavigationCallerSweepQuarter2EnumeratesItsRecursiveProductionFiles,
);
test(
  "supplier navigation caller sweep quarter 3 enumerates its recursive production files",
  callers.checkSupplierNavigationCallerSweepQuarter3EnumeratesItsRecursiveProductionFiles,
);
test(
  "supplier navigation runner envelope contract retains reviewed imports bindings and bodies",
  callers.checkSupplierNavigationRunnerEnvelopeContractRetainsReviewedImportsBindingsAndBodies,
);
test(
  "supplier navigation runner even contract retains reviewed imports bindings and bodies",
  callers.checkSupplierNavigationRunnerEvenContractRetainsReviewedImportsBindingsAndBodies,
);
test(
  "supplier navigation runner odd contract retains reviewed imports bindings and bodies",
  callers.checkSupplierNavigationRunnerOddContractRetainsReviewedImportsBindingsAndBodies,
);
test(
  "caller fixture hook pins reject changed setup bodies",
  callers.checkCallerFixtureHookPinsRejectChangedSetupBodies,
);
test(
  "navigation export census includes renamed arrays and imported scope types",
  callers.checkNavigationExportCensusIncludesRenamedArraysAndImportedScopeTypes,
);
test(
  "navigation census refuses literal dynamic imports and require loaders",
  callers.checkNavigationCensusRefusesLiteralDynamicImportsAndRequireLoaders,
);
test(
  "caller runner census refuses whole-file overrides",
  callers.checkCallerRunnerCensusRefusesWholeFileOverrides,
);
test(
  "caller runner census refuses an unreviewed side effect import",
  callers.checkCallerRunnerCensusRefusesAnUnreviewedSideEffectImport,
);
test(
  "caller runner census refuses an unlisted void statement",
  callers.checkCallerRunnerCensusRefusesAnUnlistedVoidStatement,
);
test(
  "caller runner census refuses an unlisted empty statement",
  callers.checkCallerRunnerCensusRefusesAnUnlistedEmptyStatement,
);
test(
  "caller runner census accepts comment-only envelope controls",
  callers.checkCallerRunnerCensusAcceptsCommentOnlyEnvelopeControls,
);
test(
  "caller runner census accepts comment-only even controls",
  callers.checkCallerRunnerCensusAcceptsCommentOnlyEvenControls,
);
test(
  "caller runner census accepts comment-only odd controls",
  callers.checkCallerRunnerCensusAcceptsCommentOnlyOddControls,
);
test(
  "caller runner census accepts whitespace-only envelope controls",
  callers.checkCallerRunnerCensusAcceptsWhitespaceOnlyEnvelopeControls,
);
test(
  "caller runner census accepts whitespace-only even controls",
  callers.checkCallerRunnerCensusAcceptsWhitespaceOnlyEvenControls,
);
test(
  "caller runner census accepts whitespace-only odd controls",
  callers.checkCallerRunnerCensusAcceptsWhitespaceOnlyOddControls,
);
test(
  "caller receipt oracle rejects a count that disagrees with independently declared cells",
  callers.checkCallerReceiptOracleRejectsACountThatDisagreesWithIndependentlyDeclaredCells,
);
test(
  "supplier cache fingerprints refuse unreviewed changes to both cache functions",
  callers.checkSupplierCacheFingerprintsRefuseUnreviewedChangesToBothCacheFunctions,
);
test(
  "caller runner census refuses iteration writes to protected targets",
  runnerReferences.checkCallerRunnerCensusRefusesIterationWritesToProtectedTargets,
);
test(
  "caller runner census unwraps erased types before checking protected writes",
  runnerReferences.checkCallerRunnerCensusUnwrapsErasedTypesBeforeCheckingProtectedWrites,
);
test(
  "caller admitted reference table refuses variable second bindings group 1",
  runnerReferences.checkCallerAdmittedReferenceTableRefusesVariableSecondBindingsGroup1,
);
test(
  "caller admitted reference table refuses variable second bindings group 2",
  runnerReferences.checkCallerAdmittedReferenceTableRefusesVariableSecondBindingsGroup2,
);
test(
  "caller admitted reference table refuses destructured and parameter second bindings group 1",
  runnerReferences.checkCallerAdmittedReferenceTableRefusesDestructuredAndParameterSecondBindingsGroup1,
);
test(
  "caller admitted reference table refuses destructured and parameter second bindings group 2",
  runnerReferences.checkCallerAdmittedReferenceTableRefusesDestructuredAndParameterSecondBindingsGroup2,
);
test(
  "caller admitted reference table refuses function second bindings group 1",
  runnerReferences.checkCallerAdmittedReferenceTableRefusesFunctionSecondBindingsGroup1,
);
test(
  "caller admitted reference table refuses function second bindings group 2",
  runnerReferences.checkCallerAdmittedReferenceTableRefusesFunctionSecondBindingsGroup2,
);
test(
  "caller admitted reference table refuses class catch and import second bindings",
  runnerReferences.checkCallerAdmittedReferenceTableRefusesClassCatchAndImportSecondBindings,
);
test(
  "caller admitted reference table closes every registration callback envelope",
  runnerReferences.checkCallerAdmittedReferenceTableClosesEveryRegistrationCallbackEnvelope,
);
test(
  "caller admitted reference table refuses receipt writes aliases and typeof group 1",
  runnerReferences.checkCallerAdmittedReferenceTableRefusesReceiptWritesAliasesAndTypeofGroup1,
);
test(
  "caller admitted reference table refuses receipt writes aliases and typeof group 2",
  runnerReferences.checkCallerAdmittedReferenceTableRefusesReceiptWritesAliasesAndTypeofGroup2,
);
test(
  "caller admitted reference table refuses receipt spreads and mutation methods group 1",
  runnerReferences.checkCallerAdmittedReferenceTableRefusesReceiptSpreadsAndMutationMethodsGroup1,
);
test(
  "caller admitted reference table refuses receipt spreads and mutation methods group 2",
  runnerReferences.checkCallerAdmittedReferenceTableRefusesReceiptSpreadsAndMutationMethodsGroup2,
);
test(
  "caller admitted reference table refuses global assignments updates and deletion group 1",
  runnerReferences.checkCallerAdmittedReferenceTableRefusesGlobalAssignmentsUpdatesAndDeletionGroup1,
);
test(
  "caller admitted reference table refuses global assignments updates and deletion group 2",
  runnerReferences.checkCallerAdmittedReferenceTableRefusesGlobalAssignmentsUpdatesAndDeletionGroup2,
);
test(
  "caller admitted reference table refuses intrinsic rebinding and object mutators group 1",
  runnerReferences.checkCallerAdmittedReferenceTableRefusesIntrinsicRebindingAndObjectMutatorsGroup1,
);
test(
  "caller admitted reference table refuses intrinsic rebinding and object mutators group 2",
  runnerReferences.checkCallerAdmittedReferenceTableRefusesIntrinsicRebindingAndObjectMutatorsGroup2,
);
test(
  "caller admitted reference table refuses reflect mutators and dynamic imports group 1",
  runnerReferences.checkCallerAdmittedReferenceTableRefusesReflectMutatorsAndDynamicImportsGroup1,
);
test(
  "caller admitted reference table refuses reflect mutators and dynamic imports group 2",
  runnerReferences.checkCallerAdmittedReferenceTableRefusesReflectMutatorsAndDynamicImportsGroup2,
);
test(
  "caller admitted reference table admits direct local object mutation controls",
  runnerReferences.checkCallerAdmittedReferenceTableAdmitsDirectLocalObjectMutationControls,
);
test(
  "caller intrinsic admissions refuse literal and parenthesized global mutators group 1",
  runnerReferences.checkCallerIntrinsicAdmissionsRefuseLiteralAndParenthesizedGlobalMutatorsGroup1,
);
test(
  "caller intrinsic admissions refuse literal and parenthesized global mutators group 2",
  runnerReferences.checkCallerIntrinsicAdmissionsRefuseLiteralAndParenthesizedGlobalMutatorsGroup2,
);
test(
  "caller intrinsic admissions refuse wrapped mutators aliases and call escapes group 1",
  runnerReferences.checkCallerIntrinsicAdmissionsRefuseWrappedMutatorsAliasesAndCallEscapesGroup1,
);
test(
  "caller intrinsic admissions refuse wrapped mutators aliases and call escapes group 2",
  runnerReferences.checkCallerIntrinsicAdmissionsRefuseWrappedMutatorsAliasesAndCallEscapesGroup2,
);
test(
  "caller intrinsic admissions admit direct local literal member controls",
  runnerReferences.checkCallerIntrinsicAdmissionsAdmitDirectLocalLiteralMemberControls,
);
test(
  "executable closure pins every behavioural statement including unbound callbacks",
  closure.checkExecutableClosurePinsEveryBehaviouralStatementIncludingUnboundCallbacks,
);
test(
  "executable closure pins census statement half 0 including its own checks",
  closure.checkExecutableClosurePinsCensusStatementHalf0IncludingItsOwnChecks,
);
test(
  "executable closure pins census statement half 1 including its own checks",
  closure.checkExecutableClosurePinsCensusStatementHalf1IncludingItsOwnChecks,
);
test(
  "executable closure pins suite setup and its configured entry points",
  closure.checkExecutableClosurePinsSuiteSetupAndItsConfiguredEntryPoints,
);
test(
  "census form helpers refuse empty evidence instead of passing vacuously",
  closure.checkCensusFormHelpersRefuseEmptyEvidenceInsteadOfPassingVacuously,
);
test(
  "executable closure refuses intrinsic indirection without knowing its spelling",
  closure.checkExecutableClosureRefusesIntrinsicIndirectionWithoutKnowingItsSpelling,
);
test(
  "behavioural executable closure accepts LF and CRLF checkouts",
  closure.checkBehaviouralExecutableClosureAcceptsLFAndCRLFCheckouts,
);
test(
  "census executable closure accepts LF checkout statement half 0",
  closure.checkCensusExecutableClosureAcceptsLFCheckoutStatementHalf0,
);
test(
  "census executable closure accepts LF checkout statement half 1",
  closure.checkCensusExecutableClosureAcceptsLFCheckoutStatementHalf1,
);
test(
  "census executable closure accepts CRLF checkout statement half 0",
  closure.checkCensusExecutableClosureAcceptsCRLFCheckoutStatementHalf0,
);
test(
  "census executable closure accepts CRLF checkout statement half 1",
  closure.checkCensusExecutableClosureAcceptsCRLFCheckoutStatementHalf1,
);
test(
  "authorization condition census requires distinguishing literal row pairs for every evaluated decision",
  authorization.checkAuthorizationConditionCensusRequiresDistinguishingLiteralRowPairsForEveryEvaluatedDecision,
);
test(
  "authorization condition census refuses an unlisted admission branch",
  authorization.checkAuthorizationConditionCensusRefusesAnUnlistedAdmissionBranch,
);
test(
  "authorization condition census refuses changed owner predicates",
  authorization.checkAuthorizationConditionCensusRefusesChangedOwnerPredicates,
);
test(
  "authorization condition census refuses comparisons stored as data",
  authorization.checkAuthorizationConditionCensusRefusesComparisonsStoredAsData,
);
test(
  "authorization condition census refuses nullish decisions",
  authorization.checkAuthorizationConditionCensusRefusesNullishDecisions,
);
test(
  "authorization condition census refuses optional access",
  authorization.checkAuthorizationConditionCensusRefusesOptionalAccess,
);
test(
  "authorization condition census refuses computed access",
  authorization.checkAuthorizationConditionCensusRefusesComputedAccess,
);
test(
  "authorization condition census refuses constructor decisions",
  authorization.checkAuthorizationConditionCensusRefusesConstructorDecisions,
);
test(
  "closure refuses reserved-name insertion in the behavioural suite",
  closure.checkClosureRefusesReservedNameInsertionInTheBehaviouralSuite,
);
test(
  "closure refuses a second pin table in the census suite",
  closure.checkClosureRefusesASecondPinTableInTheCensusSuite,
);
test(
  "closure refuses reserved-name insertion in setup",
  closure.checkClosureRefusesReservedNameInsertionInSetup,
);
test(
  "closure refuses reserved-name insertion in config",
  closure.checkClosureRefusesReservedNameInsertionInConfig,
);
test(
  "closure pins imported fixture and census helper implementations",
  closure.checkClosurePinsImportedFixtureAndCensusHelperImplementations,
);
test("closure pins the cache behavioural oracle", closure.checkClosurePinsTheCacheBehaviouralOracle);
test(
  "closure pins the authentication behavioural oracle",
  closure.checkClosurePinsTheAuthenticationBehaviouralOracle,
);
test(
  "closure refuses loader comments in the behavioural suite",
  closure.checkClosureRefusesLoaderCommentsInTheBehaviouralSuite,
);
test(
  "closure refuses loader comments in the census suite",
  closure.checkClosureRefusesLoaderCommentsInTheCensusSuite,
);
test(
  "closure refuses loader comments in the authentication suite",
  closure.checkClosureRefusesLoaderCommentsInTheAuthenticationSuite,
);
test(
  "closure refuses setup masking config inheritance and computed configuration",
  closure.checkClosureRefusesSetupMaskingConfigInheritanceAndComputedConfiguration,
);
test(
  "closure refuses compiler annotations inside pinned statements",
  closure.checkClosureRefusesCompilerAnnotationsInsidePinnedStatements,
);
test(
  "closure pins module resolution installation and config discovery inputs",
  closure.checkClosurePinsModuleResolutionInstallationAndConfigDiscoveryInputs,
);
test(
  "authorization census follows authentication and context classification decisions",
  authorization.checkAuthorizationCensusFollowsAuthenticationAndContextClassificationDecisions,
);
test(
  "authorization graph resolves local aliases and refuses unreviewed helper bodies",
  authorization.checkAuthorizationGraphResolvesLocalAliasesAndRefusesUnreviewedHelperBodies,
);
test(
  "authorization graph refuses reexports computed calls and module initialization writes",
  authorization.checkAuthorizationGraphRefusesReexportsComputedCallsAndModuleInitializationWrites,
);
test(
  "main settled combined-family completeness and totals assertions remain at least as strong",
  authorization.checkMainSettledCombinedFamilyCompletenessAndTotalsAssertionsRemainAtLeastAsStrong,
);
test(
  "literal body indexing refuses duplicate registrations and separates source images",
  authorization.checkLiteralBodyIndexingRefusesDuplicateRegistrationsAndSeparatesSourceImages,
);
