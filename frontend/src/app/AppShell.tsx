import { useState } from "react";
import { NavLink, Outlet } from "react-router";
import { useLogout, useSession } from "../features/auth/session";
import { SalaahkaarPanel } from "../features/salaahkaar/SalaahkaarPanel";

const NAV = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/counter", label: "Counter" },
  { to: "/shop", label: "Shop" },
  { to: "/khata", label: "Khata" },
];

export function AppShell() {
  const { data: session } = useSession();
  const logout = useLogout();
  const [assistantOpen, setAssistantOpen] = useState(false);

  return (
    <div className="flex min-h-screen bg-slate-50 text-slate-800">
      <aside className="flex w-56 shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="px-5 py-4 text-lg font-bold text-emerald-700">DukaanOS</div>
        <nav className="flex flex-col gap-1 px-3">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `rounded-md px-3 py-2 text-sm ${isActive ? "bg-emerald-50 font-medium text-emerald-800" : "hover:bg-slate-100"}`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
          <div>
            <div className="font-medium">{session?.merchant.store_name}</div>
            <div className="text-xs text-slate-500">{session?.user.name}</div>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setAssistantOpen(true)}
              className="rounded-full bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
            >
              Ask Salaahkaar
            </button>
            <button
              type="button"
              onClick={() => logout.mutate()}
              className="text-sm text-slate-500 hover:text-slate-800"
            >
              Log out
            </button>
          </div>
        </header>
        <main className="flex-1 p-6">
          <Outlet />
        </main>
      </div>

      <SalaahkaarPanel open={assistantOpen} onClose={() => setAssistantOpen(false)} />
    </div>
  );
}
