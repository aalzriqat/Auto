import { MessagesPageClient } from "@/components/messages/MessagesPageClient";

interface Props {
  params: Promise<{ orgId: string }>;
}

export default async function MessagesPage({ params }: Props) {
  const { orgId } = await params;
  return (
    <div className="absolute inset-0 overflow-hidden">
      <MessagesPageClient orgId={orgId as any} />
    </div>
  );
}
