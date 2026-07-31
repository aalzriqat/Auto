import { defineApp } from "convex/server";
import rateLimiter from "@convex-dev/rate-limiter/convex.config.js";
import aggregate from "@convex-dev/aggregate/convex.config.js";

const app = defineApp();
app.use(rateLimiter);

// Maintained counts for the dashboard's aggregate queries. Reading whole
// documents to produce a handful of numbers was 67% of this project's database
// bandwidth; a B-tree answers the same questions in O(log n) without reading
// the rows. One mount per aggregate — they cannot share a component instance.
app.use(aggregate, { name: "vehiclesByOrg" });

export default app;
