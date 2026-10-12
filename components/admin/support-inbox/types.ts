import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";

export type SupportThread = FunctionReturnType<typeof api.support.listThreads>["page"][number];
export type ThreadData = FunctionReturnType<typeof api.support.getThreadMessages>;
export type SupportMessage = ThreadData["messages"][number];

export type CategoryTab = "people" | "automated";
export type StatusFilter = "ALL" | "OPEN" | "CLOSED";
