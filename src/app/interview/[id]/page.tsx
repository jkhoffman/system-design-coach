import { notFound } from "next/navigation";
import { getSession } from "@/lib/db";
import InterviewRoom from "@/components/InterviewRoom";

export const dynamic = "force-dynamic";

export default async function InterviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = getSession(id);
  if (!session) notFound();
  return <InterviewRoom session={session} />;
}
