import { Navigate, Outlet, createBrowserRouter } from "react-router";
import { AuthPage } from "../features/auth/AuthPage";
import { useSession } from "../features/auth/session";
import { CategoriesPage } from "../features/catalogue/CategoriesPage";
import { ProductsPage } from "../features/catalogue/ProductsPage";
import { StockPage } from "../features/catalogue/StockPage";
import { CounterBilling } from "../features/counter/CounterBilling";
import { DashboardPage } from "../features/dashboard/DashboardPage";
import { KhataCustomerPage } from "../features/khata/KhataCustomerPage";
import { KhataPage } from "../features/khata/KhataPage";
import { KhataLedgerPage, KhataOutstandingPage, KhataPaymentsPage } from "../features/khata/KhataViews";
import { ShopOrdersPage } from "../features/shop/ShopOrdersPage";
import { ShopPage } from "../features/shop/ShopPage";
import { ShopQrPage } from "../features/shop/ShopQrPage";
import { ShopStorefrontPage } from "../features/shop/ShopStorefrontPage";
import { CartPage } from "../features/store/CartPage";
import { CheckoutPage } from "../features/store/CheckoutPage";
import { OrderPage } from "../features/store/OrderPage";
import { StoreLayout } from "../features/store/StoreLayout";
import { StorefrontPage } from "../features/store/StorefrontPage";
import { AppShell } from "./AppShell";
import { ComingSoon, FullPageMessage } from "./ui";

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

/** The customer-facing storefront. Public: it sits outside RequireAuth and needs no merchant session. */
export const storeRoutes = {
  path: "/store/:storeSlug",
  element: <StoreLayout />,
  children: [
    { index: true, element: <StorefrontPage /> },
    { path: "cart", element: <CartPage /> },
    { path: "checkout", element: <CheckoutPage /> },
    { path: "order/:orderId", element: <OrderPage /> },
  ],
};

/** The merchant's Shop section. Rendered inside RequireAuth. */
export const shopRoutes = {
  path: "shop",
  element: <ShopPage />,
  children: [
    { index: true, element: <Navigate to="/shop/orders" replace /> },
    { path: "orders", element: <ShopOrdersPage /> },
    { path: "storefront", element: <ShopStorefrontPage /> },
    { path: "qr", element: <ShopQrPage /> },
  ],
};

/**
 * The Counter section. Every billing input is the one Counter page (CounterBilling): those routes share
 * its element, so the open bill stays mounted while the merchant moves between them.
 */
export const counterRoutes = {
  path: "counter",
  children: [
    {
      element: <CounterBilling />,
      children: [
        { index: true },
        { path: "vision" },
        { path: "barcode" },
        { path: "photo" },
        { path: "parchi" },
        { path: "voice" },
      ],
    },
    {
      path: "returns",
      element: (
        <ComingSoon title="Returns" available={[{ to: "/counter", label: "Manual Billing" }]}>
          <p>Taking back sold items is coming soon.</p>
          <p>Until then a return is not recorded in DukaanOS: bills, stock and khata are not changed by it.</p>
        </ComingSoon>
      ),
    },
  ],
};

/** Catalogue: the products, categories and stock that the Counter and the Shop both sell from. */
export const catalogueRoutes = {
  path: "catalogue",
  children: [
    { index: true, element: <Navigate to="/catalogue/products" replace /> },
    { path: "products", element: <ProductsPage /> },
    { path: "categories", element: <CategoriesPage /> },
    { path: "stock", element: <StockPage /> },
    {
      path: "offers",
      element: (
        <ComingSoon title="Offers" available={[{ to: "/catalogue/products", label: "Products" }]}>
          <p>Offers and automatic discounts are coming soon.</p>
          <p>Today a product sells at the price set under Products, and a discount can be given on a bill at the Counter.</p>
        </ComingSoon>
      ),
    },
  ],
};

/** Khata. The fixed pages are listed before a customer's own page, whose id takes the same place in the path. */
export const khataRoutes = {
  path: "khata",
  children: [
    { index: true, element: <KhataPage /> },
    { path: "ledger", element: <KhataLedgerPage /> },
    { path: "outstanding", element: <KhataOutstandingPage /> },
    { path: "payments", element: <KhataPaymentsPage /> },
    { path: ":customerId", element: <KhataCustomerPage /> },
  ],
};

/** Every route of the app. Exported so tests can mount the real tree in a memory router. */
export const routes = [
  { element: <GuestOnly />, children: [{ path: "/login", element: <AuthPage /> }] },
  storeRoutes,
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppShell />,
        children: [
          { index: true, element: <DashboardPage /> },
          counterRoutes,
          catalogueRoutes,
          shopRoutes,
          khataRoutes,
        ],
      },
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
];

export const router = createBrowserRouter(routes);
