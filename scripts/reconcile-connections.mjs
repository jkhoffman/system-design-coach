import "./register-source.mjs";
const { getDb, closeDb } = await import("../src/lib/database.ts");
const { reconcileConnections } = await import("../src/lib/connectionCleanup.ts");
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
try {
  if (args.includes("--attempt")) {
    const generation = Number(value("--attempt"));
    if (!Number.isSafeInteger(generation) || generation <= 0) throw new Error("A valid --attempt generation is required");
    const row = getDb().prepare("SELECT session_id FROM connection_attempts WHERE generation = ? AND state = 'retired' AND cleanup = 'unknown'").get(generation);
    if (!row) throw new Error("Only retired attempts with unknown provider outcome may be reconciled manually");
    if (args.includes("--upstream-id")) {
      const upstream = value("--upstream-id");
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(upstream ?? "")) throw new Error("Invalid --upstream-id");
      if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required to hang up the identified session");
      getDb().prepare("UPDATE connection_attempts SET upstream_id = ?, cleanup = 'pending', cleanup_error = NULL WHERE generation = ? AND cleanup = 'unknown'").run(upstream, generation);
      await reconcileConnections(String(row.session_id));
    } else if (args.includes("--confirm-no-upstream")) {
      // Operator assertion after checking provider records; never inferred from elapsed time.
      getDb().prepare("UPDATE connection_attempts SET cleanup = 'done', cleanup_error = 'Operator verified no upstream session remains' WHERE generation = ? AND cleanup = 'unknown'").run(generation);
    } else throw new Error("Supply --upstream-id ID or --confirm-no-upstream after checking provider records");
  } else if (args.includes("--retry")) {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required to retry provider cleanup");
    await reconcileConnections();
  } else if (args.length && !args.includes("--list")) throw new Error("Use --list, --retry, or --attempt GENERATION with an explicit resolution");
  console.log(JSON.stringify(getDb().prepare(`SELECT generation, session_id, state, upstream_id, cleanup, cleanup_error
    FROM connection_attempts WHERE cleanup IN ('unknown', 'pending') ORDER BY generation`).all(), null, 2));
} finally { closeDb(); }
