import { Navigate, Outlet, createBrowserRouter } from "react-router";
import { AuthPage } from "../features/auth/AuthPage";
import { useSession } from "../features/auth/session";
import { CounterPage } from "../features/counter/CounterPage";
import { DashboardPage } from "../features/dashboard/DashboardPage";
import { KhataPage } from "../features/khata/KhataPage";
import { ShopPage } from "../features/shop/ShopPage";
import { AppShell } from "./AppShell";
import { FullPageMessage } from "./ui";

function RequireAuth() {
  const { data: session, isPending, error } = useSession();
  if (isPending) return <FullPageMessage>Loading…</FullPageMessage>;
  if (error) return <FullPageMessage>Cannot reach the DukaanOS API. Is the backend running?</FullPageMessage>;
  if (!session) return <Navigate to="/login" replace />;
  return <Outlet />;
}

function GuestOnly() {
  const { data: session, isPending } = useSession();
  if (isPending) return <FullPageMessage>Loading…</FullPageMessage>;
  return session ? <Navigate to="/" replace /> : <Outlet />;
}

export const router = createBrowserRouter([
  { element: <GuestOnly />, children: [{ path: "/login", element: <AuthPage /> }] },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppShell />,
        children: [
          { index: true, element: <DashboardPage /> },
          { path: "counter", element: <CounterPage /> },
          { path: "shop", element: <ShopPage /> },
          { path: "khata", element: <KhataPage /> },
        ],
      },
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
]);
