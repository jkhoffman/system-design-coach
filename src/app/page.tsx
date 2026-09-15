import Link from "next/link";
import SetupForm from "@/components/SetupForm";

export default function Home() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <div className="mb-8 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">Mock system design interview</h1>
          <p className="mt-1 text-sm text-neutral-400">
            A live voice interviewer, a whiteboard, a real clock — then a scorecard.
          </p>
        </div>
        <Link
          href="/history"
          className="rounded-lg border border-neutral-800 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-900"
        >
          Past sessions
        </Link>
      </div>
      <SetupForm />
    </main>
  );
}
