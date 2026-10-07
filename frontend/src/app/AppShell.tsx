import { useEffect, useState } from "react";
import { Link, Outlet, useLocation } from "react-router";
import { useLogout, useSession } from "../features/auth/session";
import { SalaahkaarPanel } from "../features/salaahkaar/SalaahkaarPanel";
import { Icon } from "./icons";
import { HOME, TOP_BAR_SECTIONS, locate } from "./navigation";
import { PRODUCT_LINE, type ShellContext } from "./shell";

/**
 * The merchant app's frame: a top bar with the logo (home: the Dashboard) and the sections (Counter, Shop, Khata) and, beside the
 * page, the navigation of whichever section the page belongs to. Below the `lg` breakpoint that section
 * navigation is a drawer opened from the top bar.
 */
export function AppShell() {
  const { data: session } = useSession();
  const logout = useLogout();
  const { pathname } = useLocation();
  const { section, item: current } = locate(pathname);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  // The drawer is for getting somewhere: arriving closes it.
  useEffect(() => setMenuOpen(false), [pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  return (
    <div className="flex min-h-screen flex-col bg-slate-50 text-slate-800">
      <header className="border-b border-slate-200 bg-white print:hidden">
        <div className="flex flex-wrap items-stretch gap-x-5 px-4 sm:px-6">
          <div className="flex shrink-0 items-center gap-2 py-2.5">
            <button
              type="button"
              aria-label="Menu"
              aria-expanded={menuOpen}
              aria-controls="section-nav"
              onClick={() => setMenuOpen((open) => !open)}
              className="-ml-1 rounded-md p-1.5 text-slate-600 hover:bg-slate-100 lg:hidden"
            >
              <Icon name="menu" />
            </button>
            <Link
              to={HOME.to}
              aria-label="DukaanOS, go to Dashboard"
              aria-current={section === HOME ? "page" : undefined}
              className="flex items-center gap-2.5 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600"
            >
              <span className="rounded-lg bg-emerald-600 p-1.5 text-white">
                <Icon name="store" className="h-5 w-5" />
              </span>
              <span className="leading-tight">
                <span className="block text-base font-bold tracking-tight text-slate-900">DukaanOS</span>
                <span className="hidden text-[11px] text-slate-500 xl:block">{PRODUCT_LINE}</span>
              </span>
            </Link>
          </div>

          {/*
            The sections read as tabs of the header: the current one is underlined. From `lg` up they sit on
            the logo's row and never shrink; below it they take a row of their own. Nothing here scrolls:
            every part keeps its natural width and the three sections fit a phone.
          */}
          <nav
            aria-label="Main"
            className="order-last flex w-full shrink-0 gap-1 border-t border-slate-100 lg:order-none lg:w-auto lg:border-t-0"
          >
            {TOP_BAR_SECTIONS.map((s) => {
              const active = s.id === section.id;
              return (
                <Link
                  key={s.id}
                  to={s.to}
                  aria-current={active ? "page" : undefined}
                  className={`flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm ${
                    active
                      ? "border-emerald-600 font-semibold text-emerald-800"
                      : "border-transparent text-slate-600 hover:border-slate-300 hover:text-slate-900"
                  }`}
                >
                  <Icon name={s.icon} className={`h-[18px] w-[18px] ${active ? "text-emerald-600" : "text-slate-400"}`} />
                  {s.label}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex shrink-0 items-center gap-3 py-2">
            <button
              type="button"
              aria-label="Ask Salaahkaar"
              onClick={() => setAssistantOpen(true)}
              className="flex items-center gap-1.5 whitespace-nowrap rounded-full bg-emerald-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 sm:px-4"
            >
              <Icon name="sparkle" className="h-4 w-4" />
              {/* On a phone the button is its icon; the name is still what it is called. */}
              <span className="hidden sm:inline">Ask Salaahkaar</span>
            </button>
            <div className="hidden items-center gap-2 border-l border-slate-200 pl-3 md:flex">
              <span
                aria-hidden="true"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-sm font-semibold text-slate-600"
              >
                {session?.merchant.store_name.trim().charAt(0).toUpperCase()}
              </span>
              <div className="leading-tight">
                <div className="max-w-40 truncate text-sm font-medium text-slate-900">{session?.merchant.store_name}</div>
                <div className="max-w-40 truncate text-xs text-slate-500">{session?.user.name}</div>
              </div>
            </div>
            <button
              type="button"
              disabled={logout.isPending}
              onClick={() => logout.mutate()}
              className="whitespace-nowrap rounded-md px-2 py-1.5 text-sm text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-50"
            >
              Log out
            </button>
          </div>
        </div>
        {logout.error && (
          <p role="alert" className="border-t border-red-200 bg-red-50 px-6 py-2 text-sm text-red-700">
            Could not log out: {logout.error.message}. You are still logged in.
          </p>
        )}
      </header>

      <div className="flex min-w-0 flex-1">
        {menuOpen && <div className="fixed inset-0 z-20 bg-slate-900/30 lg:hidden" onClick={() => setMenuOpen(false)} />}
        <aside
          id="section-nav"
          className={`${
            menuOpen ? "fixed inset-y-0 left-0 z-30 flex shadow-xl" : "hidden"
          } w-60 shrink-0 flex-col gap-5 overflow-y-auto border-r border-slate-200 bg-white px-3 py-4 lg:static lg:z-auto lg:flex lg:shadow-none print:hidden`}
        >
          {section.groups.map((group) => (
            <nav key={group.title} aria-label={group.title}>
              <h2 className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{group.title}</h2>
              <ul className="flex flex-col gap-0.5">
                {group.items.map((item) => {
                  const active = item === current;
                  return (
                    <li key={item.to}>
                      <Link
                        to={item.to}
                        aria-current={active ? "page" : undefined}
                        onClick={() => setMenuOpen(false)}
                        className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-sm ${
                          active ? "bg-emerald-50 font-medium text-emerald-800" : "text-slate-700 hover:bg-slate-100"
                        }`}
                      >
                        <Icon name={item.icon} className={`h-[18px] w-[18px] ${active ? "text-emerald-700" : "text-slate-400"}`} />
                        {item.label}
                        {item.soon && (
                          <span className="ml-auto rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500">
                            Soon
                          </span>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </nav>
          ))}
        </aside>

        <main className="min-w-0 flex-1 p-4 sm:p-6">
          <Outlet context={{ openAssistant: () => setAssistantOpen(true) } satisfies ShellContext} />
        </main>
      </div>

      <SalaahkaarPanel open={assistantOpen} onClose={() => setAssistantOpen(false)} />
    </div>
  );
}
