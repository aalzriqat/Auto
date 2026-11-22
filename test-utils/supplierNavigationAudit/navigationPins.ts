import ts from "typescript";
import { navigationStatementName, navigationFingerprint } from "./fingerprints";
import { updateTable } from "./source";
import { expect } from "vitest";

const NAVIGATION_FINGERPRINTS = [
  {
    "name": "import:convex/values",
    "kind": "ImportDeclaration",
    "hash": "5106e8a966e46428ebbcf36041d101a476f0438ac3692189e523764e9919f244"
  },
  {
    "name": "import:../_generated/dataModel",
    "kind": "ImportDeclaration",
    "hash": "8c150751d0cb726a5d922138a83c77df3958feae59af847ce0aff328cd27801a"
  },
  {
    "name": "import:../_generated/server",
    "kind": "ImportDeclaration",
    "hash": "5b69da67a2b780050ba5bcd4ee4036232776bc178ac9da19a396ec13501b54c4"
  },
  {
    "name": "import:./permissions",
    "kind": "ImportDeclaration",
    "hash": "a4c7b60af30dc07582d703b18d64378c66ecc7798f69764175e31a4b0c20f301"
  },
  {
    "name": "import:./supplierObligationDue",
    "kind": "ImportDeclaration",
    "hash": "a331510388f1a1c9ffdc3598012e74f52613fdd00f59af0a1c4823fd4aa3d148"
  },
  {
    "name": "import:./supplierSettledRows",
    "kind": "ImportDeclaration",
    "hash": "e7c0cdb007b0708b6e5aa7c80d71bb9e1b5d8a560f68f7e191edaff51513f620"
  },
  {
    "name": "import:./supplierReadCache",
    "kind": "ImportDeclaration",
    "hash": "580f60b66be3b64d6cee271ef90475ba5bd27e9e66fea94bb1a134376ae68c78"
  },
  {
    "name": "import:./transactionReadHeadroom",
    "kind": "ImportDeclaration",
    "hash": "cc733012011c8fb16404bee10facd8236b49903cf8e5211357b832d235640716"
  },
  {
    "name": "supplierSourceValidator",
    "kind": "VariableStatement",
    "hash": "0a4bfbda3d1572b6634e79285346df745232df953ee6be60867e6c763b55df4d"
  },
  {
    "name": "supplierRowContextValidator",
    "kind": "VariableStatement",
    "hash": "92673c2ac29a8ef2792130d2ae8d8e521ee8a430eac4a924a336eec24f91383f"
  },
  {
    "name": "Source",
    "kind": "TypeAliasDeclaration",
    "hash": "8cb4154ad9e1b5d0440a1753a98de93a9c64460618f6e4011b05c4c3286d264c"
  },
  {
    "name": "Context",
    "kind": "TypeAliasDeclaration",
    "hash": "784a5261582c596e72c1835b8a654967a43fc551250c34b0c9de333e4c139040"
  },
  {
    "name": "NavigationArgs",
    "kind": "TypeAliasDeclaration",
    "hash": "7aca8dfcbd344dfe9f981218f0a01045965263b03cdb4cc92064a10728462765"
  },
  {
    "name": "owned",
    "kind": "FunctionDeclaration",
    "hash": "67fadd48e9594cfa7bc85007d4d22f3104066fc0df538c86bb2b0ebf3085d3e8"
  },
  {
    "name": "supplierVehicleLabel",
    "kind": "FunctionDeclaration",
    "hash": "b44cd378a7434e46002b533752e73a2c7fd663590c8da842a4378eca0598a259"
  },
  {
    "name": "supplierVehicleHref",
    "kind": "FunctionDeclaration",
    "hash": "0244ecbcfcb6a6347f2cc8e3e87cdb9f80895e3969c12ffac332618221fe4383"
  },
  {
    "name": "saleSource",
    "kind": "FunctionDeclaration",
    "hash": "a4628fe7306d90a16387ee3d3b2989dd7ac0513b7c27980055e64db25c5cbb16"
  },
  {
    "name": "vehicleSource",
    "kind": "FunctionDeclaration",
    "hash": "1302866cdeb998ab09cc064dc8999eb5c4fafce8662014d6157100e7644e25cd"
  },
  {
    "name": "sourceFor",
    "kind": "FunctionDeclaration",
    "hash": "7812496c941d9f17e133d2fb15e6c5a040e8bc12bbe2424f71789ef75cb93846"
  },
  {
    "name": "addSupplierRowContext",
    "kind": "FunctionDeclaration",
    "hash": "df2b0c1c97cce688e2c99cf5d51e532d160a5b7ae722da27b3834c63cd92b51e"
  },
  {
    "name": "READ_FAILURE_MESSAGE",
    "kind": "VariableStatement",
    "hash": "cfc0ef9e4d36568f150f5c12b0969861933e0edda3a5766943b4052eb74901c3"
  },
  {
    "name": "supplierNavigationFailure",
    "kind": "FunctionDeclaration",
    "hash": "17b1463410dd7a424bf750b3c79c7bfbfbb73c54c044d29e513c4e146d6d3174"
  }
];

export function assertNavigationFingerprints(source: ts.SourceFile) {
  const actual = source.statements.map(node => ({ name: navigationStatementName(node, source),
    kind: ts.isVariableStatement(node) ? "VariableStatement" : ts.SyntaxKind[node.kind], hash: navigationFingerprint(node, source) }));
  const refusals: string[] = [];
  for (let index = 0; index < Math.max(actual.length, NAVIGATION_FINGERPRINTS.length); index++) {
    const expected = NAVIGATION_FINGERPRINTS[index];
    const current = actual[index];
    if (JSON.stringify(current) === JSON.stringify(expected)) continue;
    refusals.push(`Fingerprint ${expected?.name ?? "extra statement"} -> ${current?.name ?? "missing statement"} (${current?.kind ?? expected?.kind}) at ${source.fileName}:${source.getLineAndCharacterOfPosition(source.statements[index]?.getStart(source) ?? source.end).line + 1}; new hash ${current?.hash ?? "MISSING"}. Re-derive the door rows, axes and cells for that function, rerun the mutant runner, then update NAVIGATION_FINGERPRINTS. ${updateTable}`);
  }
  expect(refusals, `Navigation fingerprint review required: ${refusals.join("\n")}`).toStrictEqual([]);
}
