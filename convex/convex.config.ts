import { defineApp } from "convex/server";
import rateLimiter from "@convex-dev/rate-limiter/convex.config.js";
import aggregate from "@convex-dev/aggregate/convex.config.js";

const app = defineApp();
app.use(rateLimiter);

// Maintained counts for the dashboard's aggregate queries. Reading whole
// documents to produce a handful of numbers was 67% of this project's database
// bandwidth; a B-tree answers the same questions in O(log n) without reading
// the rows. One mount per aggregate — they cannot share a component instance.
//
// Keep this list in step with `test-utils/convexTest.ts`'s AGGREGATE_COMPONENTS
// and with the backfills in `convex/migrations.ts`; a mount with no backfill
// reports a believable partial count rather than an obviously broken zero.
app.use(aggregate, { name: "vehiclesByOrg" });
app.use(aggregate, { name: "vehicleQualityByOrg" });
app.use(aggregate, { name: "customersByOrg" });
app.use(aggregate, { name: "leadsByOrg" });
app.use(aggregate, { name: "membershipsByOrg" });

export default app;
