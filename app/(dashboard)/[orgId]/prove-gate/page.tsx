// TEMPORARY — negative control for the production-build CI gate. Delete me.
//
// In Next 16 a dynamic route's `params` is a Promise. Declaring it as a plain
// object typechecks clean under `tsc --noEmit`, because tsconfig's
// `.next/types/**/*.ts` include resolves to nothing until a build has run.
// `next build` generates those types and rejects this signature. If the
// production-build job is wired correctly it goes red here while type-check
// stays green.
export default function ProveGatePage({ params }: { params: { orgId: string } }) {
  return <div>{params.orgId}</div>;
}
