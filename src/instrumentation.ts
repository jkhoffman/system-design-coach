export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.OPENAI_API_KEY) {
    const { reconcileConnections } = await import("./lib/connectionCleanup");
    await reconcileConnections();
  }
}
