import { notFound, redirect } from "next/navigation";
import { getRecoverySession } from "@/lib/sessionQueries";
import { validSessionId } from "@/lib/schemas";
import InterviewRoom from "@/components/InterviewRoom";

export const dynamic = "force-dynamic";

export default async function InterviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!validSessionId(id)) notFound();
  const session = getRecoverySession(id);
  if (!session) notFound();
  if (session.status === "ended" || session.status === "graded") {
    redirect(`/interview/${id}/review`);
  }
  return <InterviewRoom session={session} />;
}
