import Link from "next/link";
import { listSessions } from "@/lib/db";

export const dynamic = "force-dynamic";

export default function HistoryPage() {
  const sessions = listSessions();
  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Past sessions</h1>
        <Link
          href="/"
          className="rounded-lg border border-neutral-800 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-900"
        >
          New interview
        </Link>
      </div>
      {sessions.length === 0 && (
        <p className="text-neutral-500">No interviews yet. Run one — it only costs a few dollars of voice minutes.</p>
      )}
      <div className="space-y-2">
        {sessions.map((s) => (
          <Link
            key={s.id}
            href={s.status === "graded" || s.status === "ended" ? `/interview/${s.id}/review` : `/interview/${s.id}`}
            className="flex items-center justify-between rounded-lg border border-neutral-800 bg-neutral-900 p-4 hover:border-neutral-700"
          >
            <div>
              <div className="font-medium">{s.prompt.title}</div>
              <div className="text-xs text-neutral-500">
                {s.briefing.company || "—"} · {s.briefing.level} · {Math.round(s.durationSec / 60)}min ·{" "}
                {new Date(s.createdAt).toLocaleString()}
              </div>
            </div>
            <div className="text-right text-sm">
              {s.grade ? (
                <span className="text-emerald-400">{s.grade.overall.score.toFixed(1)} / 5</span>
              ) : (
                <span className="text-neutral-500">{s.status}</span>
              )}
            </div>
          </Link>
        ))}
      </div>
    </main>
  );
}
