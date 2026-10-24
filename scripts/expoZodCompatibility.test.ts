import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";

const mobileRequire = createRequire(path.resolve("apps/mobile/package.json"));
const expoRequire = createRequire(mobileRequire.resolve("expo/package.json"));
const cliRequire = createRequire(expoRequire.resolve("@expo/cli/package.json"));
const shadcnRequire = createRequire(realpathSync("node_modules/shadcn/package.json"));
const sdkRequire = createRequire(shadcnRequire.resolve("@modelcontextprotocol/sdk/server/mcp.js"));

function exportedMember(requireModule: NodeJS.Require, moduleName: string, name: string): unknown {
  const exports: unknown = requireModule(moduleName);
  if (exports === null || typeof exports !== "object" || !(name in exports)) throw new Error(`Missing ${name}`);
  return Reflect.get(exports, name);
}

function invokeMethod(owner: unknown, name: string, ...args: unknown[]): unknown {
  if (owner === null || typeof owner !== "object") throw new Error(`Invalid owner for ${name}`);
  const method: unknown = Reflect.get(owner, name);
  if (typeof method !== "function") throw new Error(`Missing ${name}`);
  return Reflect.apply(method, owner, args);
}

function sdkInstance(moduleName: string, name: string, ...args: unknown[]): unknown {
  const constructor = exportedMember(sdkRequire, moduleName, name);
  if (typeof constructor !== "function") throw new Error(`Missing constructor ${name}`);
  return Reflect.construct(constructor, args);
}

const plugin = {
  packageName: "synthetic-plugin", packageRoot: "/synthetic",
  cliExtensions: { description: "Synthetic command", entryPoint: "synthetic.js", commands: [
    { name: "inspect", title: "Inspect", environments: ["mcp"], parameters: [{ name: "count", type: "number" }] },
  ] },
};

test("the Expo 57 dependency override preserves exported plugin and output validation", () => {
  const pluginSchema = exportedMember(cliRequire, "./build/src/start/server/DevToolsPlugin.schema.js", "PluginSchema");
  const outputSchema = exportedMember(cliRequire, "./build/src/start/server/DevToolsPlugin.schema.js", "DevToolsPluginOutputSchema");
  if (!(pluginSchema instanceof z.ZodType) || !(outputSchema instanceof z.ZodType)) throw new Error("Expo must use the patched native Zod graph");
  expect(pluginSchema.parse(plugin)).toEqual(plugin);
  expect(pluginSchema.safeParse({ ...plugin, packageName: "" }).success).toBe(false);
  const output = [{ type: "text", text: "Synthetic result", level: "info" }];
  expect(outputSchema.parse(output)).toEqual(output);
  expect(outputSchema.safeParse([{ type: "image", url: "invalid-url" }]).success).toBe(false);
});

test("Expo command schemas register with the installed MCP SDK and reject invalid calls", async () => {
  const createSchema = exportedMember(cliRequire, "./build/src/start/server/createMCPDevToolsExtensionSchema.js", "createMCPDevToolsExtensionSchema");
  const addCapabilities = exportedMember(cliRequire, "./build/src/start/server/MCPDevToolsPluginCLIExtensions.js", "addMcpCapabilities");
  if (typeof createSchema !== "function" || typeof addCapabilities !== "function") throw new Error("Expo MCP exports unavailable");
  const schema: unknown = createSchema(plugin);
  if (!(schema instanceof z.ZodType)) throw new Error("Expo MCP schema must use patched Zod");
  expect(schema.parse({ command: "inspect", count: 2 })).toEqual({ command: "inspect", count: 2 });
  expect(schema.safeParse({ command: "inspect", count: "invalid" }).success).toBe(false);
  const server = sdkInstance("@modelcontextprotocol/sdk/server/mcp.js", "McpServer", { name: "synthetic-server", version: "1" });
  const client = sdkInstance("@modelcontextprotocol/sdk/client/index.js", "Client", { name: "synthetic-client", version: "1" });
  const transportClass = exportedMember(sdkRequire, "@modelcontextprotocol/sdk/inMemory.js", "InMemoryTransport");
  if (typeof transportClass !== "function") throw new Error("In-memory MCP transport unavailable");
  const pairFactory: unknown = Reflect.get(transportClass, "createLinkedPair");
  if (typeof pairFactory !== "function") throw new Error("MCP transport pair factory unavailable");
  const pair: unknown = Reflect.apply(pairFactory, transportClass, []);
  if (!Array.isArray(pair) || pair.length !== 2) throw new Error("Invalid MCP transport pair");
  try {
    await addCapabilities(server, { devtoolsPluginManager: { queryPluginsAsync: async () => [plugin] } });
    await invokeMethod(server, "connect", pair[0]);
    await invokeMethod(client, "connect", pair[1]);
    const listed = await invokeMethod(client, "listTools");
    expect(listed).toMatchObject({ tools: [expect.objectContaining({ name: "synthetic-plugin",
      inputSchema: expect.objectContaining({ type: "object", properties: expect.objectContaining({ parameters: expect.any(Object) }) }) })] });
    const rejected = await invokeMethod(client, "callTool", { name: "synthetic-plugin", arguments: { parameters: { command: "inspect", count: "invalid" } } });
    expect(rejected).toMatchObject({ isError: true });
  } finally {
    await invokeMethod(client, "close");
    await invokeMethod(server, "close");
  }
}, 10_000);
