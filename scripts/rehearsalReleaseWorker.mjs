/**
 * ONE release attempt, in its own process, fired at an agreed instant.
 *
 * This exists because "concurrent" is easy to claim and easy to get wrong. Node's
 * global `fetch` shares one connection pool per process, so several requests
 * issued together from a single process can be serialised onto one socket by the
 * HTTP client. A `Promise.all` that quietly became a queue would report a green
 * concurrency result for a test that never ran concurrently — and on this command
 * that is the difference between proving a free balance cannot be paid twice and
 * proving nothing at all.
 *
 * So each attempt gets its own process, its own connection pool, its own socket,
 * and its own authenticated client. The parent hands every child the SAME
 * `startAt` wall-clock instant; each child sleeps until then and only then issues
 * its single request, so process startup does not stagger them.
 *
 * The child prints ONE json object and exits. It deliberately does not interpret
 * the result: the parent reads the economic state back and decides.
 *
 * argv: <startAtEpochMs> <argsJson>   ·   env: REHEARSAL_TOKEN, REHEARSAL_CONVEX_URL
 *
 * The destination travels in the environment rather than argv, alongside the
 * credential it is used with. argv is readable from the process table; a token
 * and the host it will be sent to are the same secret in two halves, and there
 * is no reason to put one of them where anything on the machine can read it.
 */
const [, , startAtRaw, argsJson] = process.argv;
const convexUrl = process.env.REHEARSAL_CONVEX_URL;

async function run() {
  // ⚠️ VALIDATED INLINE, NOT IN A HELPER, and that is a deliberate concession to
  // how taint analysis actually works. With the same check behind a function
  // call, Sonar kept S8703 open: a value returned from elsewhere is just a
  // string at the point it reaches `fetch`, and the guarantee is invisible both
  // to the analyser and to whoever reads this line next.
  //
  // The concern is real rather than theoretical here. This process attaches a
  // LIVE SESSION TOKEN to whatever host it is pointed at, so a wrong value —
  // from the environment, a typo in the caller, or a preview name resolved
  // against the wrong deployment — must produce a refusal, not a credential
  // delivered somewhere unintended. Moving the URL out of argv removed one way
  // to set it wrongly; it did not remove the need to check.
  const targetMatch = /^https:\/\/[a-z0-9-]{1,64}\.convex\.cloud$/.exec(
    typeof convexUrl === "string" ? convexUrl : ""
  );
  if (targetMatch === null) {
    throw new Error(
      `Refusing to send an authenticated mutation to ${String(convexUrl)} — only a Convex cloud deployment URL is accepted.`
    );
  }
  const target = targetMatch[0];
  const startAt = Number(startAtRaw);
  if (!Number.isFinite(startAt)) {
    throw new Error("startAt must be an epoch-milliseconds number");
  }
  const args = JSON.parse(argsJson);
  const token = process.env.REHEARSAL_TOKEN;
  if (!token) throw new Error("REHEARSAL_TOKEN is required");

  // Busy-wait only for the final few milliseconds; sleep for the rest. A plain
  // setTimeout can wake late enough to stagger the attempts by more than the
  // window being tested.
  const coarse = startAt - Date.now() - 5;
  if (coarse > 0) await new Promise((resolve) => setTimeout(resolve, coarse));
  while (Date.now() < startAt) {
    /* spin to the instant */
  }

  const sentAt = Date.now();
  const response = await fetch(`${target}/api/mutation`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ path: "deposits:release", args, format: "json" }),
  });
  const body = await response.json().catch(() => ({ status: "error", errorMessage: "non-JSON response" }));
  process.stdout.write(
    JSON.stringify({
      sentAt,
      receivedAt: Date.now(),
      httpStatus: response.status,
      status: body.status ?? null,
      // HTTP success is never the proof here; it is recorded so the parent can
      // show what each attempt was TOLD, next to what actually happened.
      error: body.status === "error" ? String(body.errorData?.message ?? body.errorData ?? body.errorMessage) : null,
    })
  );
}

run().catch((error) => {
  process.stdout.write(JSON.stringify({ status: "worker_error", error: String(error?.message ?? error) }));
  process.exit(1);
});
