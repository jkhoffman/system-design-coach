import { findSession } from "@/lib/sessionLookup";
import { notFound, redirect } from "next/navigation";
import { getRecoverySession } from "@/lib/sessionQueries";
import InterviewRoom from "@/components/InterviewRoom";

export const dynamic = "force-dynamic";

export default async function InterviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = findSession(id, getRecoverySession);
  if (!session) notFound();
  if (session.status === "ended" || session.status === "graded") {
    redirect(`/interview/${id}/review`);
  }
  return <InterviewRoom session={session} />;
}
