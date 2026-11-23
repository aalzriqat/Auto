import { execFileSync } from "node:child_process";

const ID = "[1-9][0-9]{0,14}";
const SHA = "[a-f0-9]{40}";
const READ_ROUTE = new RegExp(`^(?:/pulls/${ID}|/pulls\\?state=open&per_page=100&page=[1-3]|` +
  `/actions/runs/${ID}|/actions/workflows/(?:scenario-runner|browser-attack-swarm)\\.yml|` +
  `/actions/workflows/scenario-runner\\.yml/runs\\?event=pull_request&head_sha=${SHA}&per_page=100|` +
  `/commits/${SHA}/check-runs\\?check_name=(?:authenticated-pr-e2e|pr-scenario-runner)&filter=all&per_page=100|` +
  `/git/ref/pull/${ID}/merge|/git/commits/${SHA})$`, "u");

/**
 * Only repository reads and one named check are reachable with the controller token.
 * @param {{repository: string, token: string}} context
 * @param {(file: string, args: string[], options: import("node:child_process").ExecFileSyncOptionsWithStringEncoding) => string} [execute]
 */
export function createScenarioCompletionApi({ repository, token }, execute = execFileSync) {
  if (typeof repository !== "string" || !/^[\w-]+\/[\w.-]+$/u.test(repository) ||
      /\/(?:\.|\.\.)$/u.test(repository) || typeof token !== "string" || !token) {
    throw new Error("SCENARIO_COMPLETION_TRANSPORT_INVALID");
  }
  const request = (method, route, body) => {
    const read = method === "GET" && READ_ROUTE.test(route) && body === undefined;
    const write = ((method === "POST" && route === "/check-runs") ||
      (method === "PATCH" && new RegExp(`^/check-runs/${ID}$`, "u").test(route))) &&
      body?.name === "pr-scenario-runner";
    if (!read && !write) throw new Error("SCENARIO_COMPLETION_ROUTE_REFUSED");
    const args = ["api", "--hostname", "github.com", "--method", method, `repos/${repository}${route}`];
    if (write) args.push("--input", "-");
    const raw = execute("/usr/bin/gh", args, {
      env: { GH_TOKEN: token, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", HOME: process.env.HOME },
      ...(write ? { input: JSON.stringify(body) } : {}),
      encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 30_000, stdio: ["pipe", "pipe", "pipe"],
    });
    return JSON.parse(raw);
  };
  return { api: route => request("GET", route), request };
}
