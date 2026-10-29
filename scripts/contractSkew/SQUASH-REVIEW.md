# SCRUM-866 squash closure re-review

Reviewed source: a9f68597e1d99d65de26d43bbe7aee0aac55b2d4. All 189 entries with final evidence outside main were inspected using the checker's createImportClosure, gitCompare, backendModuleOf and rationalePaths. No unresolved closure was returned.

The 138 entries citing 0a941fb6 and 5 citing 4468503b have no changed closure member. Each of the 46 entries citing 86ea0dbf has the five files below. Each unique diff was read, then checked against each entry's argument path. No entry was refused. Expiry, identities and contract fields are unchanged.

## Changed-file effects

- components/suppliers/SupplierSelect.tsx: forwards the DOM identifier as triggerId; supplier row._id selection and onChange are unchanged.
- components/ui/searchable-select.tsx: renames only the button DOM-id prop to triggerId; option values and onValueChange are unchanged.
- convex/utils/supplierRegistry.ts: extracts readSupplierSnapshot; ordinary snapshotSupplier calls pass false and preserve the same missing, foreign and inactive checks and snapshot values.
- convex/utils/vehicleSupplierIdentity.ts: uses snapshotSupplierForProvenReplay only in resolveImportSuppliers; the intake, sourced-update and creditor resolvers used by this call keep strict snapshotSupplier.
- convex/vehicles.ts: broadens integer row-id probing only in importBulk; this call does not use that replay path.

## Argument paths

- Entry 245: Step1QuoteSetup watches vehicleId and passes it directly to approvals.requestProfitApproval; the handler reads that vehicle in the caller organization and computes profitDecision. The changed import-replay code is outside this path.
- Entries 382–402: VehicleDialog requestUpdate builds restValues and imageIds; vehicleEdits.requestUpdate uses resolveUpdateSourcedSupplier and resolveCreditorForPosting. Their ordinary supplier lookup retains the same behavior.
- Entries 429–452: VehicleDialog requestCreate builds restValues, settlement, trustPassportFields and imageIds; vehicleEdits.requestCreate calls resolveIntakeSuppliers. Its ordinary supplier lookup retains the same behavior.

This is argument-specific static inspection, with a separate advisory read-only inspection agreeing. It is not runtime certification or a review seat.

## Per-entry closure inventory

| Entry | Previous final evidence | Function | Argument | Call site | Changed closure files | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| 72 | 0a941fb6 | vehicles:get | vehicleId | components/accounting/CollectionsTab.tsx:820:5 | None | Renew |
| 245 | 86ea0dbf | approvals:requestProfitApproval | vehicleId | components/sales/wizard/steps/Step1QuoteSetup.tsx:256:13 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 265 | 0a941fb6 | vehicles:get | vehicleId | app/(dashboard)/[orgId]/sales/page.tsx:164:9 | None | Renew |
| 353 | 0a941fb6 | vehicles:generateUploadUrl | mimeType | components/vehicles/VehicleDialog.tsx:271:31 | None | Renew |
| 354 | 0a941fb6 | vehicles:generateUploadUrl | sizeInBytes | components/vehicles/VehicleDialog.tsx:271:31 | None | Renew |
| 355 | 0a941fb6 | vehicles:deleteImage | storageId | components/vehicles/VehicleDialog.tsx:364:15 | None | Renew |
| 356 | 0a941fb6 | vehicles:update | orgId | components/vehicles/VehicleDialog.tsx:442:17 | None | Renew |
| 357 | 0a941fb6 | vehicles:update | vehicleId | components/vehicles/VehicleDialog.tsx:442:17 | None | Renew |
| 358 | 0a941fb6 | vehicles:update | make | components/vehicles/VehicleDialog.tsx:442:17 | None | Renew |
| 359 | 0a941fb6 | vehicles:update | model | components/vehicles/VehicleDialog.tsx:442:17 | None | Renew |
| 360 | 0a941fb6 | vehicles:update | year | components/vehicles/VehicleDialog.tsx:442:17 | None | Renew |
| 361 | 0a941fb6 | vehicles:update | mileage | components/vehicles/VehicleDialog.tsx:442:17 | None | Renew |
| 362 | 0a941fb6 | vehicles:update | color | components/vehicles/VehicleDialog.tsx:442:17 | None | Renew |
| 363 | 0a941fb6 | vehicles:update | fuelType | components/vehicles/VehicleDialog.tsx:442:17 | None | Renew |
| 364 | 0a941fb6 | vehicles:update | transmission | components/vehicles/VehicleDialog.tsx:442:17 | None | Renew |
| 365 | 0a941fb6 | vehicles:update | sellingPrice | components/vehicles/VehicleDialog.tsx:442:17 | None | Renew |
| 366 | 0a941fb6 | vehicles:update | vin | components/vehicles/VehicleDialog.tsx:442:17 | None | Renew |
| 367 | 0a941fb6 | vehicles:update | trim | components/vehicles/VehicleDialog.tsx:442:17 | None | Renew |
| 368 | 0a941fb6 | vehicles:update | minimumProfit | components/vehicles/VehicleDialog.tsx:442:17 | None | Renew |
| 369 | 0a941fb6 | vehicles:update | status | components/vehicles/VehicleDialog.tsx:442:17 | None | Renew |
| 370 | 0a941fb6 | vehicles:update | sourceType | components/vehicles/VehicleDialog.tsx:442:17 | None | Renew |
| 371 | 0a941fb6 | vehicles:update | notes | components/vehicles/VehicleDialog.tsx:442:17 | None | Renew |
| 372 | 0a941fb6 | vehicles:update | accidentDisclosed | components/vehicles/VehicleDialog.tsx:442:17 | None | Renew |
| 373 | 0a941fb6 | vehicles:update | ownerCount | components/vehicles/VehicleDialog.tsx:442:17 | None | Renew |
| 374 | 0a941fb6 | vehicles:update | dealerGuarantee | components/vehicles/VehicleDialog.tsx:442:17 | None | Renew |
| 375 | 0a941fb6 | vehicles:update | purchasePrice | components/vehicles/VehicleDialog.tsx:442:17 | None | Renew |
| 376 | 0a941fb6 | vehicles:update | sourcedFromName | components/vehicles/VehicleDialog.tsx:442:17 | None | Renew |
| 377 | 0a941fb6 | vehicles:update | sourceCost | components/vehicles/VehicleDialog.tsx:442:17 | None | Renew |
| 378 | 0a941fb6 | vehicles:update | purchasePaymentMethod | components/vehicles/VehicleDialog.tsx:442:17 | None | Renew |
| 379 | 0a941fb6 | vehicles:update | bankAccountId | components/vehicles/VehicleDialog.tsx:442:17 | None | Renew |
| 380 | 0a941fb6 | vehicles:update | purchaseSupplierName | components/vehicles/VehicleDialog.tsx:442:17 | None | Renew |
| 381 | 0a941fb6 | vehicles:update | imageIds[*] | components/vehicles/VehicleDialog.tsx:442:17 | None | Renew |
| 382 | 86ea0dbf | vehicleEdits:requestUpdate | payload.make | components/vehicles/VehicleDialog.tsx:453:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 383 | 86ea0dbf | vehicleEdits:requestUpdate | payload.model | components/vehicles/VehicleDialog.tsx:453:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 384 | 86ea0dbf | vehicleEdits:requestUpdate | payload.year | components/vehicles/VehicleDialog.tsx:453:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 385 | 86ea0dbf | vehicleEdits:requestUpdate | payload.mileage | components/vehicles/VehicleDialog.tsx:453:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 386 | 86ea0dbf | vehicleEdits:requestUpdate | payload.color | components/vehicles/VehicleDialog.tsx:453:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 387 | 86ea0dbf | vehicleEdits:requestUpdate | payload.fuelType | components/vehicles/VehicleDialog.tsx:453:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 388 | 86ea0dbf | vehicleEdits:requestUpdate | payload.transmission | components/vehicles/VehicleDialog.tsx:453:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 389 | 86ea0dbf | vehicleEdits:requestUpdate | payload.sellingPrice | components/vehicles/VehicleDialog.tsx:453:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 390 | 86ea0dbf | vehicleEdits:requestUpdate | payload.vin | components/vehicles/VehicleDialog.tsx:453:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 391 | 86ea0dbf | vehicleEdits:requestUpdate | payload.trim | components/vehicles/VehicleDialog.tsx:453:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 392 | 86ea0dbf | vehicleEdits:requestUpdate | payload.minimumProfit | components/vehicles/VehicleDialog.tsx:453:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 393 | 86ea0dbf | vehicleEdits:requestUpdate | payload.status | components/vehicles/VehicleDialog.tsx:453:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 394 | 86ea0dbf | vehicleEdits:requestUpdate | payload.sourceType | components/vehicles/VehicleDialog.tsx:453:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 395 | 86ea0dbf | vehicleEdits:requestUpdate | payload.notes | components/vehicles/VehicleDialog.tsx:453:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 396 | 86ea0dbf | vehicleEdits:requestUpdate | payload.accidentDisclosed | components/vehicles/VehicleDialog.tsx:453:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 397 | 86ea0dbf | vehicleEdits:requestUpdate | payload.ownerCount | components/vehicles/VehicleDialog.tsx:453:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 398 | 86ea0dbf | vehicleEdits:requestUpdate | payload.dealerGuarantee | components/vehicles/VehicleDialog.tsx:453:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 399 | 86ea0dbf | vehicleEdits:requestUpdate | payload.purchasePrice | components/vehicles/VehicleDialog.tsx:453:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 400 | 86ea0dbf | vehicleEdits:requestUpdate | payload.sourcedFromName | components/vehicles/VehicleDialog.tsx:453:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 401 | 86ea0dbf | vehicleEdits:requestUpdate | payload.sourceCost | components/vehicles/VehicleDialog.tsx:453:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 402 | 86ea0dbf | vehicleEdits:requestUpdate | payload.imageIds[*] | components/vehicles/VehicleDialog.tsx:453:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 403 | 0a941fb6 | vehicles:create | idempotencyKey | components/vehicles/VehicleDialog.tsx:467:31 | None | Renew |
| 404 | 0a941fb6 | vehicles:create | orgId | components/vehicles/VehicleDialog.tsx:467:31 | None | Renew |
| 405 | 0a941fb6 | vehicles:create | make | components/vehicles/VehicleDialog.tsx:467:31 | None | Renew |
| 406 | 0a941fb6 | vehicles:create | model | components/vehicles/VehicleDialog.tsx:467:31 | None | Renew |
| 407 | 0a941fb6 | vehicles:create | year | components/vehicles/VehicleDialog.tsx:467:31 | None | Renew |
| 408 | 0a941fb6 | vehicles:create | mileage | components/vehicles/VehicleDialog.tsx:467:31 | None | Renew |
| 409 | 0a941fb6 | vehicles:create | color | components/vehicles/VehicleDialog.tsx:467:31 | None | Renew |
| 410 | 0a941fb6 | vehicles:create | fuelType | components/vehicles/VehicleDialog.tsx:467:31 | None | Renew |
| 411 | 0a941fb6 | vehicles:create | transmission | components/vehicles/VehicleDialog.tsx:467:31 | None | Renew |
| 412 | 0a941fb6 | vehicles:create | sellingPrice | components/vehicles/VehicleDialog.tsx:467:31 | None | Renew |
| 413 | 0a941fb6 | vehicles:create | vin | components/vehicles/VehicleDialog.tsx:467:31 | None | Renew |
| 414 | 0a941fb6 | vehicles:create | trim | components/vehicles/VehicleDialog.tsx:467:31 | None | Renew |
| 415 | 0a941fb6 | vehicles:create | minimumProfit | components/vehicles/VehicleDialog.tsx:467:31 | None | Renew |
| 416 | 0a941fb6 | vehicles:create | status | components/vehicles/VehicleDialog.tsx:467:31 | None | Renew |
| 417 | 0a941fb6 | vehicles:create | sourceType | components/vehicles/VehicleDialog.tsx:467:31 | None | Renew |
| 418 | 0a941fb6 | vehicles:create | notes | components/vehicles/VehicleDialog.tsx:467:31 | None | Renew |
| 419 | 0a941fb6 | vehicles:create | accidentDisclosed | components/vehicles/VehicleDialog.tsx:467:31 | None | Renew |
| 420 | 0a941fb6 | vehicles:create | ownerCount | components/vehicles/VehicleDialog.tsx:467:31 | None | Renew |
| 421 | 0a941fb6 | vehicles:create | dealerGuarantee | components/vehicles/VehicleDialog.tsx:467:31 | None | Renew |
| 422 | 0a941fb6 | vehicles:create | purchasePrice | components/vehicles/VehicleDialog.tsx:467:31 | None | Renew |
| 423 | 0a941fb6 | vehicles:create | sourcedFromName | components/vehicles/VehicleDialog.tsx:467:31 | None | Renew |
| 424 | 0a941fb6 | vehicles:create | sourceCost | components/vehicles/VehicleDialog.tsx:467:31 | None | Renew |
| 425 | 0a941fb6 | vehicles:create | purchasePaymentMethod | components/vehicles/VehicleDialog.tsx:467:31 | None | Renew |
| 426 | 0a941fb6 | vehicles:create | bankAccountId | components/vehicles/VehicleDialog.tsx:467:31 | None | Renew |
| 427 | 0a941fb6 | vehicles:create | purchaseSupplierName | components/vehicles/VehicleDialog.tsx:467:31 | None | Renew |
| 428 | 0a941fb6 | vehicles:create | imageIds[*] | components/vehicles/VehicleDialog.tsx:467:31 | None | Renew |
| 429 | 86ea0dbf | vehicleEdits:requestCreate | payload.make | components/vehicles/VehicleDialog.tsx:480:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 430 | 86ea0dbf | vehicleEdits:requestCreate | payload.model | components/vehicles/VehicleDialog.tsx:480:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 431 | 86ea0dbf | vehicleEdits:requestCreate | payload.year | components/vehicles/VehicleDialog.tsx:480:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 432 | 86ea0dbf | vehicleEdits:requestCreate | payload.mileage | components/vehicles/VehicleDialog.tsx:480:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 433 | 86ea0dbf | vehicleEdits:requestCreate | payload.color | components/vehicles/VehicleDialog.tsx:480:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 434 | 86ea0dbf | vehicleEdits:requestCreate | payload.fuelType | components/vehicles/VehicleDialog.tsx:480:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 435 | 86ea0dbf | vehicleEdits:requestCreate | payload.transmission | components/vehicles/VehicleDialog.tsx:480:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 436 | 86ea0dbf | vehicleEdits:requestCreate | payload.sellingPrice | components/vehicles/VehicleDialog.tsx:480:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 437 | 86ea0dbf | vehicleEdits:requestCreate | payload.vin | components/vehicles/VehicleDialog.tsx:480:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 438 | 86ea0dbf | vehicleEdits:requestCreate | payload.trim | components/vehicles/VehicleDialog.tsx:480:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 439 | 86ea0dbf | vehicleEdits:requestCreate | payload.minimumProfit | components/vehicles/VehicleDialog.tsx:480:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 440 | 86ea0dbf | vehicleEdits:requestCreate | payload.status | components/vehicles/VehicleDialog.tsx:480:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 441 | 86ea0dbf | vehicleEdits:requestCreate | payload.sourceType | components/vehicles/VehicleDialog.tsx:480:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 442 | 86ea0dbf | vehicleEdits:requestCreate | payload.notes | components/vehicles/VehicleDialog.tsx:480:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 443 | 86ea0dbf | vehicleEdits:requestCreate | payload.accidentDisclosed | components/vehicles/VehicleDialog.tsx:480:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 444 | 86ea0dbf | vehicleEdits:requestCreate | payload.ownerCount | components/vehicles/VehicleDialog.tsx:480:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 445 | 86ea0dbf | vehicleEdits:requestCreate | payload.dealerGuarantee | components/vehicles/VehicleDialog.tsx:480:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 446 | 86ea0dbf | vehicleEdits:requestCreate | payload.purchasePrice | components/vehicles/VehicleDialog.tsx:480:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 447 | 86ea0dbf | vehicleEdits:requestCreate | payload.sourcedFromName | components/vehicles/VehicleDialog.tsx:480:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 448 | 86ea0dbf | vehicleEdits:requestCreate | payload.sourceCost | components/vehicles/VehicleDialog.tsx:480:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 449 | 86ea0dbf | vehicleEdits:requestCreate | payload.purchasePaymentMethod | components/vehicles/VehicleDialog.tsx:480:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 450 | 86ea0dbf | vehicleEdits:requestCreate | payload.bankAccountId | components/vehicles/VehicleDialog.tsx:480:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 451 | 86ea0dbf | vehicleEdits:requestCreate | payload.purchaseSupplierName | components/vehicles/VehicleDialog.tsx:480:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 452 | 86ea0dbf | vehicleEdits:requestCreate | payload.imageIds[*] | components/vehicles/VehicleDialog.tsx:480:17 | components/suppliers/SupplierSelect.tsx<br>components/ui/searchable-select.tsx<br>convex/utils/supplierRegistry.ts<br>convex/utils/vehicleSupplierIdentity.ts<br>convex/vehicles.ts | Renew |
| 460 | 0a941fb6 | vehicles:correctAcquisitionCost | newCost | components/vehicles/CorrectAcquisitionCostDialog.tsx:125:13 | None | Renew |
| 461 | 0a941fb6 | vehicles:correctAcquisitionCost | bankAccountId | components/vehicles/CorrectAcquisitionCostDialog.tsx:125:13 | None | Renew |
| 462 | 0a941fb6 | vehicles:createReservation | idempotencyKey | components/vehicles/VehicleDetailsDialog.tsx:263:13 | None | Renew |
| 463 | 0a941fb6 | vehicles:createReservation | customerId | components/vehicles/VehicleDetailsDialog.tsx:263:13 | None | Renew |
| 464 | 0a941fb6 | vehicles:releaseReservation | reservationId | components/vehicles/VehicleDetailsDialog.tsx:299:13 | None | Renew |
| 467 | 0a941fb6 | vehicles:importBulk | purchasePaymentMethod | components/vehicles/VehicleImportDialog.tsx:955:36 | None | Renew |
| 468 | 0a941fb6 | vehicles:importBulk | vehicles | components/vehicles/VehicleImportDialog.tsx:955:36 | None | Renew |
| 481 | 4468503b | adminData:adminListByOrg | orgId | app/admin/data/page.tsx:45:5 | None | Renew |
| 482 | 4468503b | adminData:adminListByOrg | table | app/admin/data/page.tsx:45:5 | None | Renew |
| 483 | 4468503b | adminData:adminUpdateRecord | table | app/admin/data/page.tsx:65:13 | None | Renew |
| 484 | 4468503b | adminData:adminHardDelete | table | app/admin/data/page.tsx:76:13 | None | Renew |
| 485 | 4468503b | adminData:adminRestoreRecords | table | app/admin/data/page.tsx:88:34 | None | Renew |
| 592 | 0a941fb6 | vehicles:list | orgId | apps/mobile/src/features/marketplace/DealerMarketplaceScreen.tsx:247:5 | None | Renew |
| 681 | 0a941fb6 | vehicles:listAll | orgId | apps/mobile/src/features/workspace/modules/expenses.tsx:37:29 | None | Renew |
| 714 | 0a941fb6 | vehicles:listAll | orgId | apps/mobile/src/features/workspace/modules/leads.tsx:39:29 | None | Renew |
| 754 | 0a941fb6 | vehicles:listAll | orgId | apps/mobile/src/features/workspace/modules/quotes.tsx:18:29 | None | Renew |
| 786 | 0a941fb6 | vehicles:listAll | orgId | apps/mobile/src/features/workspace/modules/sales.tsx:31:29 | None | Renew |
| 822 | 0a941fb6 | vehicles:listAll | orgId | apps/mobile/src/features/workspace/modules/socialInbox.tsx:185:5 | None | Renew |
| 868 | 0a941fb6 | vehicles:list | orgId | apps/mobile/src/features/workspace/modules/vehicles.tsx:55:5 | None | Renew |
| 869 | 0a941fb6 | vehicles:listAcquisitionBankOptions | orgId | apps/mobile/src/features/workspace/modules/vehicles.tsx:64:37 | None | Renew |
| 870 | 0a941fb6 | vehicles:generateUploadUrl | orgId | apps/mobile/src/features/workspace/modules/vehicles.tsx:248:31 | None | Renew |
| 871 | 0a941fb6 | vehicles:update | orgId | apps/mobile/src/features/workspace/modules/vehicles.tsx:391:15 | None | Renew |
| 872 | 0a941fb6 | vehicles:update | vin | apps/mobile/src/features/workspace/modules/vehicles.tsx:391:15 | None | Renew |
| 873 | 0a941fb6 | vehicles:update | make | apps/mobile/src/features/workspace/modules/vehicles.tsx:391:15 | None | Renew |
| 874 | 0a941fb6 | vehicles:update | model | apps/mobile/src/features/workspace/modules/vehicles.tsx:391:15 | None | Renew |
| 875 | 0a941fb6 | vehicles:update | trim | apps/mobile/src/features/workspace/modules/vehicles.tsx:391:15 | None | Renew |
| 876 | 0a941fb6 | vehicles:update | year | apps/mobile/src/features/workspace/modules/vehicles.tsx:391:15 | None | Renew |
| 877 | 0a941fb6 | vehicles:update | mileage | apps/mobile/src/features/workspace/modules/vehicles.tsx:391:15 | None | Renew |
| 878 | 0a941fb6 | vehicles:update | color | apps/mobile/src/features/workspace/modules/vehicles.tsx:391:15 | None | Renew |
| 879 | 0a941fb6 | vehicles:update | fuelType | apps/mobile/src/features/workspace/modules/vehicles.tsx:391:15 | None | Renew |
| 880 | 0a941fb6 | vehicles:update | transmission | apps/mobile/src/features/workspace/modules/vehicles.tsx:391:15 | None | Renew |
| 881 | 0a941fb6 | vehicles:update | sellingPrice | apps/mobile/src/features/workspace/modules/vehicles.tsx:391:15 | None | Renew |
| 882 | 0a941fb6 | vehicles:update | status | apps/mobile/src/features/workspace/modules/vehicles.tsx:391:15 | None | Renew |
| 883 | 0a941fb6 | vehicles:update | notes | apps/mobile/src/features/workspace/modules/vehicles.tsx:391:15 | None | Renew |
| 884 | 0a941fb6 | vehicles:update | imageIds[*] | apps/mobile/src/features/workspace/modules/vehicles.tsx:391:15 | None | Renew |
| 885 | 0a941fb6 | vehicles:update | purchasePrice | apps/mobile/src/features/workspace/modules/vehicles.tsx:391:15 | None | Renew |
| 886 | 0a941fb6 | vehicles:update | vehicleId | apps/mobile/src/features/workspace/modules/vehicles.tsx:391:15 | None | Renew |
| 887 | 0a941fb6 | vehicles:update | purchasePaymentMethod | apps/mobile/src/features/workspace/modules/vehicles.tsx:391:15 | None | Renew |
| 888 | 0a941fb6 | vehicles:update | purchaseSupplierName | apps/mobile/src/features/workspace/modules/vehicles.tsx:391:15 | None | Renew |
| 889 | 0a941fb6 | vehicles:update | bankAccountId | apps/mobile/src/features/workspace/modules/vehicles.tsx:391:15 | None | Renew |
| 890 | 0a941fb6 | vehicles:create | orgId | apps/mobile/src/features/workspace/modules/vehicles.tsx:415:15 | None | Renew |
| 891 | 0a941fb6 | vehicles:create | vin | apps/mobile/src/features/workspace/modules/vehicles.tsx:415:15 | None | Renew |
| 892 | 0a941fb6 | vehicles:create | make | apps/mobile/src/features/workspace/modules/vehicles.tsx:415:15 | None | Renew |
| 893 | 0a941fb6 | vehicles:create | model | apps/mobile/src/features/workspace/modules/vehicles.tsx:415:15 | None | Renew |
| 894 | 0a941fb6 | vehicles:create | trim | apps/mobile/src/features/workspace/modules/vehicles.tsx:415:15 | None | Renew |
| 895 | 0a941fb6 | vehicles:create | year | apps/mobile/src/features/workspace/modules/vehicles.tsx:415:15 | None | Renew |
| 896 | 0a941fb6 | vehicles:create | mileage | apps/mobile/src/features/workspace/modules/vehicles.tsx:415:15 | None | Renew |
| 897 | 0a941fb6 | vehicles:create | color | apps/mobile/src/features/workspace/modules/vehicles.tsx:415:15 | None | Renew |
| 898 | 0a941fb6 | vehicles:create | fuelType | apps/mobile/src/features/workspace/modules/vehicles.tsx:415:15 | None | Renew |
| 899 | 0a941fb6 | vehicles:create | transmission | apps/mobile/src/features/workspace/modules/vehicles.tsx:415:15 | None | Renew |
| 900 | 0a941fb6 | vehicles:create | sellingPrice | apps/mobile/src/features/workspace/modules/vehicles.tsx:415:15 | None | Renew |
| 901 | 0a941fb6 | vehicles:create | status | apps/mobile/src/features/workspace/modules/vehicles.tsx:415:15 | None | Renew |
| 902 | 0a941fb6 | vehicles:create | notes | apps/mobile/src/features/workspace/modules/vehicles.tsx:415:15 | None | Renew |
| 903 | 0a941fb6 | vehicles:create | imageIds[*] | apps/mobile/src/features/workspace/modules/vehicles.tsx:415:15 | None | Renew |
| 904 | 0a941fb6 | vehicles:create | sourcedFromName | apps/mobile/src/features/workspace/modules/vehicles.tsx:415:15 | None | Renew |
| 905 | 0a941fb6 | vehicles:create | sourceCost | apps/mobile/src/features/workspace/modules/vehicles.tsx:415:15 | None | Renew |
| 906 | 0a941fb6 | vehicles:create | purchasePrice | apps/mobile/src/features/workspace/modules/vehicles.tsx:415:15 | None | Renew |
| 907 | 0a941fb6 | vehicles:create | purchasePaymentMethod | apps/mobile/src/features/workspace/modules/vehicles.tsx:415:15 | None | Renew |
| 908 | 0a941fb6 | vehicles:create | purchaseSupplierName | apps/mobile/src/features/workspace/modules/vehicles.tsx:415:15 | None | Renew |
| 909 | 0a941fb6 | vehicles:create | bankAccountId | apps/mobile/src/features/workspace/modules/vehicles.tsx:415:15 | None | Renew |
| 910 | 0a941fb6 | vehicles:create | idempotencyKey | apps/mobile/src/features/workspace/modules/vehicles.tsx:415:15 | None | Renew |
| 911 | 0a941fb6 | vehicles:softDelete | orgId | apps/mobile/src/features/workspace/modules/vehicles.tsx:443:21 | None | Renew |
| 912 | 0a941fb6 | vehicles:softDelete | vehicleId | apps/mobile/src/features/workspace/modules/vehicles.tsx:443:21 | None | Renew |
| 932 | 0a941fb6 | vehicles:listAll | orgId | apps/mobile/src/features/workspace/salesWizard/SalesWizardScreen.tsx:208:38 | None | Renew |
| 977 | 0a941fb6 | vehicles:get | <root> | apps/mobile/src/features/workspace/VehicleDetailScreen.tsx:165:28 | None | Renew |
| 978 | 0a941fb6 | vehicles:getRelations | <root> | apps/mobile/src/features/workspace/VehicleDetailScreen.tsx:195:30 | None | Renew |
| 981 | 0a941fb6 | vehicles:getLandedCosts | orgId | apps/mobile/src/features/workspace/VehicleDetailScreen.tsx:201:5 | None | Renew |
| 982 | 0a941fb6 | vehicles:getLandedCosts | vehicleId | apps/mobile/src/features/workspace/VehicleDetailScreen.tsx:201:5 | None | Renew |
| 983 | 0a941fb6 | vehicles:listAcquisitionBankOptions | orgId | apps/mobile/src/features/workspace/VehicleDetailScreen.tsx:205:5 | None | Renew |
| 984 | 0a941fb6 | vehicles:getPricingHistory | orgId | apps/mobile/src/features/workspace/VehicleDetailScreen.tsx:210:5 | None | Renew |
| 985 | 0a941fb6 | vehicles:getPricingHistory | vehicleId | apps/mobile/src/features/workspace/VehicleDetailScreen.tsx:210:5 | None | Renew |
| 986 | 0a941fb6 | vehicles:getReservationHistory | orgId | apps/mobile/src/features/workspace/VehicleDetailScreen.tsx:214:5 | None | Renew |
| 987 | 0a941fb6 | vehicles:getReservationHistory | vehicleId | apps/mobile/src/features/workspace/VehicleDetailScreen.tsx:214:5 | None | Renew |
| 999 | 0a941fb6 | vehicles:upsertLandedCosts | orgId | apps/mobile/src/features/workspace/VehicleDetailScreen.tsx:515:13 | None | Renew |
| 1000 | 0a941fb6 | vehicles:upsertLandedCosts | vehicleId | apps/mobile/src/features/workspace/VehicleDetailScreen.tsx:515:13 | None | Renew |
| 1001 | 0a941fb6 | vehicles:upsertLandedCosts | items[*].bankAccountId | apps/mobile/src/features/workspace/VehicleDetailScreen.tsx:515:13 | None | Renew |
| 1002 | 0a941fb6 | vehicles:createReservation | idempotencyKey | apps/mobile/src/features/workspace/VehicleDetailScreen.tsx:535:13 | None | Renew |
| 1003 | 0a941fb6 | vehicles:createReservation | orgId | apps/mobile/src/features/workspace/VehicleDetailScreen.tsx:535:13 | None | Renew |
| 1004 | 0a941fb6 | vehicles:createReservation | vehicleId | apps/mobile/src/features/workspace/VehicleDetailScreen.tsx:535:13 | None | Renew |
| 1005 | 0a941fb6 | vehicles:createReservation | customerId | apps/mobile/src/features/workspace/VehicleDetailScreen.tsx:535:13 | None | Renew |
| 1006 | 0a941fb6 | vehicles:createReservation | depositMethod | apps/mobile/src/features/workspace/VehicleDetailScreen.tsx:535:13 | None | Renew |
| 1007 | 0a941fb6 | vehicles:createReservation | depositBankAccountId | apps/mobile/src/features/workspace/VehicleDetailScreen.tsx:535:13 | None | Renew |
| 1008 | 0a941fb6 | vehicles:releaseReservation | orgId | apps/mobile/src/features/workspace/VehicleDetailScreen.tsx:577:13 | None | Renew |
| 1009 | 0a941fb6 | vehicles:releaseReservation | reservationId | apps/mobile/src/features/workspace/VehicleDetailScreen.tsx:577:13 | None | Renew |
| 1010 | 0a941fb6 | vehicles:softDelete | orgId | apps/mobile/src/features/workspace/VehicleDetailScreen.tsx:597:21 | None | Renew |
| 1011 | 0a941fb6 | vehicles:softDelete | vehicleId | apps/mobile/src/features/workspace/VehicleDetailScreen.tsx:597:21 | None | Renew |

## Sources and limits

- [GitHub pull_request payload](https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request) identifies the PR base separately from its head.
- [git merge-base --is-ancestor](https://git-scm.com/docs/git-merge-base#Documentation/git-merge-base.txt---is-ancestor) returns 0 for ancestry and 1 otherwise; other errors do not prove ancestry.
- The closure excludes generated code and dependency source according to importClosure.mjs. This re-review does not certify UNKNOWN values, runtime behavior or production fingerprints. The existing monitor must still measure them.
