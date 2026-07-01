import { SignUp } from "@clerk/nextjs";

type SignUpPageProps = {
  searchParams?: Promise<{ invite?: string | string[] }>;
};

export default async function SignUpPage({ searchParams }: SignUpPageProps) {
  const params = searchParams ? await searchParams : {};
  const inviteParam = Array.isArray(params.invite) ? params.invite[0] : params.invite;
  const inviteRedirect = inviteParam
    ? `/accept-invite?token=${encodeURIComponent(inviteParam)}`
    : undefined;

  return (
    <div className="flex min-h-screen items-center justify-center">
      <SignUp
        forceRedirectUrl={inviteRedirect}
        fallbackRedirectUrl="/dashboard"
      />
    </div>
  );
}
