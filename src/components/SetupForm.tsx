"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { PublicPrompt } from "@/lib/publicPrompt";
import { PRESET_DURATIONS, durationSeconds, type DurationSelection } from "@/lib/duration";
import { fetchJson } from "@/lib/clientApi";
import { usePromptGeneration } from "./usePromptGeneration";
import BriefingFields from "./BriefingFields";
import Field from "./Field";
import type { Briefing, Mode } from "@/lib/types";

export default function SetupForm({ prompts }: { prompts: PublicPrompt[] }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("library");
  const [promptId, setPromptId] = useState(prompts[0].id);
  const [description, setDescription] = useState("");
  const [briefing, setBriefing] = useState<Briefing>({
    company: "",
    position: "",
    level: "L5",
    jobDescription: "",
  });
  const [duration, setDuration] = useState<DurationSelection>({ kind: "preset", seconds: 45 * 60 });
  const [customMin, setCustomMin] = useState("60");
  const durationSec = durationSeconds(duration);
  const isCustom = duration.kind === "custom";
  const customValid = durationSeconds({ kind: "custom", minutes: customMin }) !== null;
  const customMinutes = Number(customMin);
  const generation = usePromptGeneration();
  const { generated, generating, invalidate } = generation;
  const startRequest = useRef<AbortController | null>(null);
  useEffect(() => () => startRequest.current?.abort(), []);
  const [starting, setStarting] = useState(false);
  const busy = starting ? "start" : generating ? "gen" : null;
  const [startError, setError] = useState<string | null>(null);
  const error = startError ?? generation.error;
  const generate = () => { setError(null); return generation.generate(mode, briefing, description); };

  const start = async () => {
    if (startRequest.current || durationSec == null || (mode !== "library" && !generated)) return;
    const controller = new AbortController();
    startRequest.current = controller;
    setStarting(true);
    setError(null);
    try {
      const data = await fetchJson<{ session: { id: string } }>("/api/sessions", {
        method: "POST",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          briefing,
          promptId: mode === "library" ? promptId : generated?.id,
          durationSec,
        }),
      });
      if (controller.signal.aborted) return;
      router.push(`/interview/${data.session.id}`);
    } catch (e) {
      startRequest.current = null;
      if (controller.signal.aborted) return;
      setError(e instanceof Error ? e.message : String(e));
      setStarting(false);
    }
  };

  const updateBriefing = (patch: Partial<Briefing>) => {
    setBriefing((current) => ({ ...current, ...patch }));
    invalidate();
  };

  const canStart = (mode === "library" || generated !== null) && durationSec !== null;

  const generateRow = (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <button
          onClick={() => void generate()}
          disabled={
            busy !== null ||
            (mode === "freeform"
              ? !description.trim()
              : !briefing.company || !briefing.position)
          }
          className="rounded-lg border border-neutral-700 px-4 py-2 text-sm hover:bg-neutral-800 disabled:opacity-40"
        >
          {busy === "gen" ? "Generating…" : generated ? "Regenerate prompt" : "Generate prompt"}
        </button>
        {generated && mode === "custom" && (
          <span className="text-sm text-emerald-400">
            Ready: “{generated.title}” — revealed when the interviewer speaks.
          </span>
        )}
      </div>
      {generated && mode === "freeform" && (
        <div className="rounded-lg border border-emerald-900 bg-emerald-950/30 p-3 text-sm">
          <div className="font-medium text-emerald-400">{generated.title}</div>
          <div className="mt-1 text-neutral-300">“{generated.question}”</div>
        </div>
      )}
    </div>
  );

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <div className="flex rounded-lg border border-neutral-800 p-1">
        {(["library", "custom", "freeform"] as const).map((m) => (
          <button
            key={m}
            onClick={() => {
              setMode(m);
              invalidate();
            }}
            className={`flex-1 rounded-md py-2 text-sm font-medium capitalize ${
              mode === m ? "bg-neutral-800 text-white" : "text-neutral-400 hover:text-neutral-200"
            }`}
          >
            {m === "library"
              ? "Prompt library"
              : m === "custom"
                ? "Custom (job briefing)"
                : "Describe your own"}
          </button>
        ))}
      </div>

      {mode === "library" ? (
        <div className="space-y-3">
          <label className="block text-sm text-neutral-400">Prompt</label>
          <div className="grid gap-2 sm:grid-cols-2">
            {prompts.map((p) => (
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
          <BriefingFields briefing={briefing} update={updateBriefing} flavor />
        </div>
      ) : mode === "custom" ? (
        <div className="space-y-3">
          <BriefingFields briefing={briefing} update={updateBriefing} />
          <Field label="Job description (optional — paste for sharper prompts)">
            <textarea
              value={briefing.jobDescription}
              onChange={(e) => updateBriefing({ jobDescription: e.target.value })}
              rows={5}
              placeholder="Paste the job post…"
              className="input"
            />
          </Field>
          {generateRow}
        </div>
      ) : (
        <div className="space-y-3">
          <Field label="Describe the interview you want">
            <textarea
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
                invalidate();
              }}
              rows={5}
              placeholder={
                'e.g. "Design a payments ledger for a marketplace" — or paste a detailed spec with scale, scope, and constraints.'
              }
              className="input"
            />
          </Field>
          <BriefingFields briefing={briefing} update={updateBriefing} />
          {generateRow}
        </div>
      )}

      <Field label="Interview length">
        <div className="flex flex-wrap items-center gap-2">
          {PRESET_DURATIONS.map((d) => (
            <button
              key={d}
              onClick={() => setDuration({ kind: "preset", seconds: d })}
              className={`rounded-lg border px-4 py-2 text-sm ${
                !isCustom && durationSec === d
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
                setDuration({ kind: "custom", minutes: e.target.value });
              }}
              onFocus={() => setDuration({ kind: "custom", minutes: customMin })}
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
