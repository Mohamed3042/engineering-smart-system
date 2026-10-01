import { Suspense, useMemo } from "react";
import { Link, Navigate, Outlet, useLocation } from "react-router";
import { useSession } from "@/api/session";
import { ErrorState, PageLoading, Stepper } from "@/ui";
import { SETUP_ORDER, SETUP_STEPS, SetupNavContext, stepIndex, useSetupNavValue } from "./setup";

/** Full-screen setup wizard (no app navigation). Steps are child routes: /setup/<step>. */
export function SetupLayout() {
  const session = useSession();
  const location = useLocation();
  const step = location.pathname.split("/")[2] || "workspace";
  const nav = useSetupNavValue(step);
  const saved = session.data?.workspace?.setup_step ?? "workspace";
  const creatingNew = new URLSearchParams(location.search).get("new") === "1";
  const done = useMemo(() => {
    const upto = creatingNew ? 0 : stepIndex(saved);
    return new Set(SETUP_ORDER.slice(0, upto));
  }, [saved, creatingNew]);

  if (session.isLoading) return <PageLoading />;
  if (session.isError) return <ErrorState error={session.error} onRetry={() => session.refetch()} className="min-h-dvh justify-center" />;
  // Without a workspace only the first step makes sense.
  if (!session.data?.workspace && step !== "workspace") return <Navigate to="/setup/workspace" replace />;

  return (
    <SetupNavContext.Provider value={nav}>
      <div className="min-h-dvh bg-canvas lg:grid lg:grid-cols-[300px_1fr]">
        <aside className="border-b border-line bg-surface px-5 py-5 lg:sticky lg:top-0 lg:h-dvh lg:border-b-0 lg:border-r lg:px-5 lg:py-8">
          <div className="mb-5 flex items-center justify-between lg:mb-8 lg:block">
            <div>
              <p className="text-xl font-bold tracking-[-0.01em] text-brand-ink">Engineering Smart System</p>
              <p className="text-sm text-ink-3">Set up a company workspace</p>
            </div>
            {session.data?.workspace && !creatingNew ? (
              <Link to="/" className="text-sm font-medium text-brand-ink hover:underline lg:mt-3 lg:inline-block">
                Leave setup
              </Link>
            ) : null}
          </div>
          <Stepper steps={SETUP_STEPS} current={step} done={done} onSelect={(k) => nav.goTo(k)} />
        </aside>
        <main className="mx-auto w-full max-w-3xl px-4 pb-16 pt-6 sm:px-8 lg:pt-12">
          <Suspense fallback={<PageLoading />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </SetupNavContext.Provider>
  );
}
