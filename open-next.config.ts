import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// SCRUM-996 trial: default overrides only (no R2 incremental cache, no queue,
// no tag cache). Source: https://opennext.js.org/cloudflare/get-started
export default defineCloudflareConfig({});
