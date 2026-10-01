import { ChevronRight, Ellipsis, Search, X } from "lucide-react";
import { Dialog as D } from "radix-ui";
import { Suspense, useEffect, useState } from "react";
import { Link, NavLink, Navigate, Outlet, useLocation } from "react-router";
import { useSession } from "@/api/session";
import { cn } from "@/lib/cn";
import { roleLabel } from "@/lib/labels";
import { Avatar, ErrorState, PageLoading } from "@/ui";
import { GlobalSearch } from "./GlobalSearch";
import { MORE_NAV, PHONE_TABS, PRIMARY_NAV } from "./nav";
import { NotificationsButton } from "./Notifications";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

function useSearchShortcut(setOpen: (o: boolean) => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);
}

function Sidebar({ onSearch }: { onSearch: () => void }) {
  const { data } = useSession();
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  return (
    <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-line bg-surface lg:flex">
      <div className="px-4 pb-4 pt-6">
        <WorkspaceSwitcher />
      </div>
      <div className="px-4 pb-3">
        <button
          type="button"
          onClick={onSearch}
          className="flex h-10 w-full items-center gap-2.5 rounded-lg border border-line bg-canvas px-3 text-sm text-ink-3 hover:border-line-strong hover:text-ink-2"
        >
          <Search className="size-4" aria-hidden />
          <span className="flex-1 text-left">Search</span>
          <kbd className="rounded border border-line bg-surface px-1.5 font-sans text-xs">{isMac ? "⌘K" : "Ctrl K"}</kbd>
        </button>
      </div>
      <nav aria-label="Main" className="flex-1 space-y-0.5 overflow-y-auto px-3">
        {PRIMARY_NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn(
                "relative flex h-11 items-center gap-3 rounded-lg px-3 text-[0.9375rem] font-medium transition-colors",
                isActive
                  ? "bg-brand-soft text-brand-ink"
                  : "text-ink-2 hover:bg-hover hover:text-ink",
              )
            }
          >
            <Icon className="size-5 shrink-0" aria-hidden />
            {label}
          </NavLink>
        ))}
      </nav>
      <div className="space-y-1 border-t border-line px-3 py-3">
        <NotificationsButton />
        {data?.user ? (
          <Link to="/settings/account" className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-hover">
            <Avatar name={data.user.name} initials={data.user.initials} size="sm" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-ink">{data.user.name}</span>
              <span className="block text-xs text-ink-3">{roleLabel(data.user.role)}</span>
            </span>
          </Link>
        ) : null}
      </div>
    </aside>
  );
}

function PhoneHeader({ onSearch }: { onSearch: () => void }) {
  return (
    <header className="sticky top-0 z-30 flex items-center gap-1 border-b border-line bg-surface/95 px-2 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] backdrop-blur lg:hidden">
      <div className="min-w-0 flex-1">
        <WorkspaceSwitcher size="sm" />
      </div>
      <button
        type="button"
        onClick={onSearch}
        aria-label="Search"
        className="grid size-10 place-items-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink"
      >
        <Search className="size-5" />
      </button>
      <NotificationsButton compact />
    </header>
  );
}

function PhoneTabBar() {
  const [moreOpen, setMoreOpen] = useState(false);
  const location = useLocation();
  const { data } = useSession();
  useEffect(() => setMoreOpen(false), [location.pathname]);
  const onTab = PHONE_TABS.some((t) => (t.end ? location.pathname === t.to : location.pathname.startsWith(t.to)));

  const tabCls = (active: boolean) =>
    cn(
      "flex h-full flex-1 flex-col items-center justify-center gap-0.5 text-xs font-medium",
      active ? "text-brand-ink" : "text-ink-3",
    );

  return (
    <>
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 backdrop-blur safe-bottom lg:hidden"
      >
        <div className="flex h-16">
          {PHONE_TABS.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => tabCls(isActive)}>
              <Icon className="size-6" aria-hidden />
              {label}
            </NavLink>
          ))}
          <button type="button" onClick={() => setMoreOpen(true)} className={tabCls(!onTab || moreOpen)} aria-haspopup="dialog">
            <Ellipsis className="size-6" aria-hidden />
            More
          </button>
        </div>
      </nav>
      <D.Root open={moreOpen} onOpenChange={setMoreOpen}>
        <D.Portal>
          <D.Overlay className="fixed inset-0 z-50 bg-ink/25 animate-fade-in lg:hidden" />
          <D.Content className="fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col rounded-t-xl bg-surface shadow-pop outline-none animate-sheet-in safe-bottom lg:hidden">
            <div className="flex items-center gap-3 border-b border-line px-5 py-4">
              <div className="min-w-0 flex-1">
                <D.Title className="text-lg font-semibold text-ink">Workspace menu</D.Title>
                <D.Description className="text-sm text-ink-3">{data?.workspace?.name}</D.Description>
              </div>
              {data?.user ? (
                <span className="flex items-center gap-2">
                  <Avatar name={data.user.name} initials={data.user.initials} size="sm" />
                  <span className="text-sm">
                    <span className="block font-medium text-ink">{data.user.name}</span>
                    <span className="block text-xs text-ink-3">{roleLabel(data.user.role)}</span>
                  </span>
                </span>
              ) : null}
              <D.Close aria-label="Close menu" className="grid size-10 place-items-center rounded-lg text-ink-3 hover:bg-hover">
                <X className="size-5" />
              </D.Close>
            </div>
            <ul className="overflow-y-auto px-3 py-2">
              {MORE_NAV.map(({ to, label, icon: Icon }) => (
                <li key={label}>
                  <Link to={to} className="flex h-14 items-center gap-4 rounded-lg px-2 text-base font-medium text-ink hover:bg-hover">
                    <Icon className="size-6 text-ink-2" aria-hidden />
                    <span className="flex-1">{label}</span>
                    <ChevronRight className="size-5 text-ink-3" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          </D.Content>
        </D.Portal>
      </D.Root>
    </>
  );
}

/** App frame: sidebar on desktop; header + bottom tabs on phones. Needs an active workspace. */
export function AppShell() {
  const session = useSession();
  const [searchOpen, setSearchOpen] = useState(false);
  useSearchShortcut(setSearchOpen);
  const location = useLocation();
  useEffect(() => {
    document.getElementById("main")?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [location.pathname]);

  if (session.isLoading) return <PageLoading />;
  if (session.isError) return <ErrorState error={session.error} onRetry={() => session.refetch()} className="min-h-dvh justify-center" />;
  if (!session.data?.workspace) return <Navigate to="/setup/workspace" replace />;

  return (
    <div className="flex min-h-dvh">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-brand px-3 py-2 text-white focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
      >
        Skip to content
      </a>
      <Sidebar onSearch={() => setSearchOpen(true)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <PhoneHeader onSearch={() => setSearchOpen(true)} />
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 outline-none">
          <Suspense fallback={<PageLoading />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
      <PhoneTabBar />
      <GlobalSearch open={searchOpen} onOpenChange={setSearchOpen} />
    </div>
  );
}
