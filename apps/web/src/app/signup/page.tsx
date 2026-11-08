import { Suspense } from "react";
import { TopBar } from "@/components/TopBar";
import { AuthForm } from "@/components/AuthForm";

export default function Page() {
  return (
    <>
      <TopBar />
      <main className="shell page">
        <Suspense>
          <AuthForm mode="signup" />
        </Suspense>
      </main>
    </>
  );
}
