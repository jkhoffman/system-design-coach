import Link from "next/link";
import { notFound } from "next/navigation";
import { getSession } from "@/lib/db";
import { toClientSession } from "@/lib/sessionDto";
import { validSessionId } from "@/lib/schemas";
import ReviewReport from "@/components/ReviewReport";
import ReplayScrubber from "@/components/ReplayScrubber";
import GradeGate from "@/components/GradeGate";

export const dynamic = "force-dynamic";

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!validSessionId(id)) notFound();
  const session = getSession(id);
  if (!session) notFound();
  const clientSession = toClientSession(session);

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">{session.prompt.title}</h1>
          <p className="mt-1 text-sm text-neutral-400">
            {session.briefing.company || "—"} · {session.briefing.level}{" "}
            {session.briefing.position} · {Math.round(session.durationSec / 60)} min ·{" "}
            {new Date(session.createdAt).toLocaleString()}
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/history"
            className="rounded-lg border border-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-900"
          >
            History
          </Link>
          <Link
            href="/"
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium hover:bg-emerald-500"
          >
            New interview
          </Link>
        </div>
      </div>

      {session.grade ? <ReviewReport grade={session.grade} /> : <GradeGate sessionId={id} />}

      <section className="mt-8">
        <h3 className="mb-3 font-semibold">Replay</h3>
        <ReplayScrubber session={clientSession} />
      </section>

      {session.finalImage && (
        <section className="mt-8">
          <h3 className="mb-3 font-semibold">Final whiteboard</h3>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={session.finalImage}
            alt="Final whiteboard"
            className="max-w-full rounded-xl border border-neutral-800"
          />
        </section>
      )}
    </main>
  );
}
