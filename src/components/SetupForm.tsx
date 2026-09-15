"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PROMPT_LIBRARY } from "@/lib/prompts";
import type { Briefing, PromptSpec } from "@/lib/types";

const LEVELS = ["L4", "L5", "L6", "Staff"];
const DURATIONS = [20 * 60, 30 * 60, 45 * 60];

export default function SetupForm() {
  const router = useRouter();
  const [mode, setMode] = useState<"library" | "custom">("library");
  const [promptId, setPromptId] = useState(PROMPT_LIBRARY[0].id);
  const [briefing, setBriefing] = useState<Briefing>({
    company: "",
    position: "",
    level: "L5",
    jobDescription: "",
  });
  const [durationSec, setDurationSec] = useState(45 * 60);
  const [customMin, setCustomMin] = useState("60");
  const customMinutes = Number(customMin);
  const customValid = Number.isInteger(customMinutes) && customMinutes >= 5 && customMinutes <= 120;
  const isCustom = !DURATIONS.includes(durationSec);
  const [generated, setGenerated] = useState<PromptSpec | null>(null);
  const [busy, setBusy] = useState<"gen" | "start" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const generate = async () => {
    setBusy("gen");
    setError(null);
    try {
      const res = await fetch("/api/prompts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(briefing),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "generation failed");
      setGenerated(data.prompt as PromptSpec);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const start = async () => {
    setBusy("start");
    setError(null);
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          briefing,
          promptId: mode === "library" ? promptId : undefined,
          prompt: mode === "custom" ? generated : undefined,
          durationSec,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "failed to create session");
      router.push(`/interview/${data.session.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  const updateBriefing = (patch: Partial<Briefing>) => {
    setBriefing((current) => ({ ...current, ...patch }));
    setGenerated(null);
  };

  const canStart = (mode === "library" || generated !== null) && (!isCustom || customValid);

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <div className="flex rounded-lg border border-neutral-800 p-1">
        {(["library", "custom"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`flex-1 rounded-md py-2 text-sm font-medium capitalize ${
              mode === m ? "bg-neutral-800 text-white" : "text-neutral-400 hover:text-neutral-200"
            }`}
          >
            {m === "library" ? "Prompt library" : "Custom (job briefing)"}
          </button>
        ))}
      </div>

      {mode === "library" ? (
        <div className="space-y-3">
          <label className="block text-sm text-neutral-400">Prompt</label>
          <div className="grid gap-2 sm:grid-cols-2">
            {PROMPT_LIBRARY.map((p) => (
              <button
                key={p.id}
                onClick={() => setPromptId(p.id)}
                className={`rounded-lg border p-3 text-left text-sm ${
                  promptId === p.id
                    ? "border-emerald-600 bg-emerald-950/40"
                    : "border-neutral-800 bg-neutral-900 hover:border-neutral-700"
                }`}
              >
                <div className="font-medium">{p.title}</div>
                <div className="mt-1 line-clamp-2 text-xs text-neutral-500">{p.question}</div>
              </button>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Company (flavor)">
              <input
                value={briefing.company}
                onChange={(e) => updateBriefing({ company: e.target.value })}
                placeholder="e.g. Google"
                className="input"
              />
            </Field>
            <Field label="Position">
              <input
                value={briefing.position}
                onChange={(e) => updateBriefing({ position: e.target.value })}
                placeholder="e.g. Backend SWE"
                className="input"
              />
            </Field>
            <Field label="Level">
              <select
                value={briefing.level}
                onChange={(e) => updateBriefing({ level: e.target.value })}
                className="input"
              >
                {LEVELS.map((l) => (
                  <option key={l}>{l}</option>
                ))}
              </select>
            </Field>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Company">
              <input
                value={briefing.company}
                onChange={(e) => updateBriefing({ company: e.target.value })}
                placeholder="e.g. Stripe"
                className="input"
              />
            </Field>
            <Field label="Position">
              <input
                value={briefing.position}
                onChange={(e) => updateBriefing({ position: e.target.value })}
                placeholder="e.g. Backend engineer"
                className="input"
              />
            </Field>
            <Field label="Level">
              <select
                value={briefing.level}
                onChange={(e) => updateBriefing({ level: e.target.value })}
                className="input"
              >
                {LEVELS.map((l) => (
                  <option key={l}>{l}</option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Job description (optional — paste for sharper prompts)">
            <textarea
              value={briefing.jobDescription}
              onChange={(e) => updateBriefing({ jobDescription: e.target.value })}
              rows={5}
              placeholder="Paste the job post…"
              className="input"
            />
          </Field>
          <div className="flex items-center gap-3">
            <button
              onClick={() => void generate()}
              disabled={busy !== null || !briefing.company || !briefing.position}
              className="rounded-lg border border-neutral-700 px-4 py-2 text-sm hover:bg-neutral-800 disabled:opacity-40"
            >
              {busy === "gen" ? "Generating…" : generated ? "Regenerate prompt" : "Generate prompt"}
            </button>
            {generated && (
              <span className="text-sm text-emerald-400">
                Ready: “{generated.title}” — revealed when the interviewer speaks.
              </span>
            )}
          </div>
        </div>
      )}

      <Field label="Interview length">
        <div className="flex flex-wrap items-center gap-2">
          {DURATIONS.map((d) => (
            <button
              key={d}
              onClick={() => setDurationSec(d)}
              className={`rounded-lg border px-4 py-2 text-sm ${
                durationSec === d
                  ? "border-emerald-600 bg-emerald-950/40"
                  : "border-neutral-800 hover:border-neutral-700"
              }`}
            >
              {d / 60} min
            </button>
          ))}
          <div
            className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
              isCustom
                ? "border-emerald-600 bg-emerald-950/40"
                : "border-neutral-800"
            }`}
          >
            <input
              type="number"
              min={5}
              max={120}
              value={customMin}
              onChange={(e) => {
                setCustomMin(e.target.value);
                const m = Number(e.target.value);
                if (Number.isInteger(m) && m >= 5 && m <= 120) setDurationSec(m * 60);
              }}
              onFocus={() => {
                if (customValid) setDurationSec(customMinutes * 60);
              }}
              className="w-16 bg-transparent outline-none"
            />
            <span className="text-neutral-400">min custom</span>
          </div>
        </div>
        {isCustom && !customValid && (
          <p className="mt-1 text-xs text-amber-500">Custom length must be a whole number from 5 to 120 minutes.</p>
        )}
        {isCustom && customValid && customMinutes > 60 && (
          <p className="mt-1 text-xs text-amber-500">
            Sessions past ~60 min may hit the platform duration cap — an early end will
            auto-grade what was recorded.
          </p>
        )}
      </Field>

      <button
        onClick={() => void start()}
        disabled={busy !== null || !canStart}
        className="w-full rounded-lg bg-emerald-600 py-3 font-semibold hover:bg-emerald-500 disabled:opacity-40"
      >
        {busy === "start" ? "Setting up…" : "Start interview →"}
      </button>
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm text-neutral-400">{label}</span>
      {children}
    </label>
  );
}
