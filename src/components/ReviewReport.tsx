import type { GradeReport } from "@/lib/types";
import { fmtMs } from "@/lib/rubric";

const SIGNAL_LABEL: Record<string, { label: string; cls: string }> = {
  strong_no_hire: { label: "Strong No Hire", cls: "bg-red-900 text-red-200" },
  no_hire: { label: "No Hire", cls: "bg-red-900/70 text-red-200" },
  lean_no_hire: { label: "Lean No Hire", cls: "bg-orange-900/70 text-orange-200" },
  lean_hire: { label: "Lean Hire", cls: "bg-yellow-900/70 text-yellow-200" },
  hire: { label: "Hire", cls: "bg-emerald-900/70 text-emerald-200" },
  strong_hire: { label: "Strong Hire", cls: "bg-emerald-800 text-emerald-100" },
};

function ScoreBar({ score }: { score: number }) {
  return (
    <div className="h-2 w-24 overflow-hidden rounded bg-neutral-800">
      <div
        className={`h-full ${score >= 3.5 ? "bg-emerald-500" : score >= 2.5 ? "bg-yellow-500" : "bg-red-500"}`}
        style={{ width: `${(score / 5) * 100}%` }}
      />
    </div>
  );
}

export default function ReviewReport({ grade }: { grade: GradeReport }) {
  const sig = SIGNAL_LABEL[grade.overall.signal] ?? SIGNAL_LABEL.lean_no_hire;
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between rounded-xl border border-neutral-800 bg-neutral-900 p-5">
        <div>
          <div className={`inline-block rounded-full px-3 py-1 text-sm font-semibold ${sig.cls}`}>
            {sig.label}
          </div>
          <p className="mt-2 max-w-2xl text-sm text-neutral-300">{grade.overall.summary}</p>
        </div>
        <div className="text-4xl font-bold tabular-nums">{grade.overall.score.toFixed(1)}</div>
      </div>

      <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
        <h3 className="mb-3 font-semibold">Scorecard</h3>
        <div className="space-y-3">
          {grade.dimensions.map((d) => (
            <div key={d.key} className="border-b border-neutral-800 pb-3 last:border-0 last:pb-0">
              <div className="flex items-center justify-between">
                <span className="font-medium">{d.label}</span>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-neutral-500">w={Math.round(d.weight * 100)}%</span>
                  <ScoreBar score={d.score} />
                  <span className="w-8 text-right text-sm tabular-nums">{d.score}</span>
                </div>
              </div>
              <p className="mt-1 text-sm text-neutral-400">{d.evidence}</p>
              {d.moments?.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {d.moments.map((m, i) => (
                    <span
                      key={i}
                      className="rounded bg-neutral-800 px-1.5 py-0.5 text-[11px] text-neutral-400"
                    >
                      {fmtMs(m.startMs)} · {m.note}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {grade.tradeoffAudit?.length > 0 && (
        <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
          <h3 className="mb-3 font-semibold">Trade-off audit</h3>
          <p className="mb-3 text-xs text-neutral-500">
            Every significant architectural choice — was an alternative and a reason stated?
          </p>
          <div className="space-y-2 text-sm">
            {grade.tradeoffAudit.map((t, i) => (
              <div key={i} className="flex items-start gap-3">
                <span className="mt-0.5 text-[11px] text-neutral-600">
                  {t.startMs != null ? fmtMs(t.startMs) : "—"}
                </span>
                <span className="flex-1">{t.choice}</span>
                <span className={t.alternativeStated ? "text-emerald-400" : "text-red-400"}>
                  {t.alternativeStated ? "alt ✓" : "alt ✗"}
                </span>
                <span className={t.reasonStated ? "text-emerald-400" : "text-red-400"}>
                  {t.reasonStated ? "reason ✓" : "reason ✗"}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
          <h3 className="mb-3 font-semibold text-emerald-400">Strengths</h3>
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-neutral-300">
            {grade.strengths.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </section>
        <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
          <h3 className="mb-3 font-semibold text-red-400">Anti-patterns</h3>
          <ul className="space-y-1.5 text-sm text-neutral-300">
            {grade.antiPatterns.map((a, i) => (
              <li key={i} className="flex gap-2">
                <span className="shrink-0 text-[11px] text-neutral-600">
                  {a.startMs != null ? fmtMs(a.startMs) : "—"}
                </span>
                <span>{a.description}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
          <h3 className="mb-3 font-semibold">What a strong hire would have done</h3>
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-neutral-300">
            {grade.strongHireWouldHave.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </section>
        <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
          <h3 className="mb-3 font-semibold">Drills</h3>
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-neutral-300">
            {grade.drills.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
