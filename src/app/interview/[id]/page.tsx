import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/db";
import { toClientSession } from "@/lib/sessionDto";
import { validSessionId } from "@/lib/schemas";
import InterviewRoom from "@/components/InterviewRoom";

export const dynamic = "force-dynamic";

export default async function InterviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!validSessionId(id)) notFound();
  const session = getSession(id);
  if (!session) notFound();
  if (session.status === "ended" || session.status === "graded") {
    redirect(`/interview/${id}/review`);
  }
  return <InterviewRoom session={toClientSession(session)} />;
}
