import { Navigate, Outlet, createBrowserRouter } from "react-router";
import { AnalyticsPage } from "../features/analytics/AnalyticsPage";
import { AuthPage } from "../features/auth/AuthPage";
import { useSession } from "../features/auth/session";
import { CategoriesPage } from "../features/catalogue/CategoriesPage";
import { ProductsPage } from "../features/catalogue/ProductsPage";
import { StockPage } from "../features/catalogue/StockPage";
import { CounterBilling } from "../features/counter/CounterBilling";
import { DashboardPage } from "../features/dashboard/DashboardPage";
import { InsightsPage } from "../features/insights/InsightsPage";
import { KhataCustomerPage } from "../features/khata/KhataCustomerPage";
import { KhataPage } from "../features/khata/KhataPage";
import { KhataLedgerPage, KhataOutstandingPage, KhataPaymentsPage } from "../features/khata/KhataViews";
import { SettingsPage } from "../features/settings/SettingsPage";
import { ShopOrdersPage } from "../features/shop/ShopOrdersPage";
import { ShopPage } from "../features/shop/ShopPage";
import { ShopQrPage } from "../features/shop/ShopQrPage";
import { ShopStorefrontPage } from "../features/shop/ShopStorefrontPage";
import { CartPage } from "../features/store/CartPage";
import { CheckoutPage } from "../features/store/CheckoutPage";
import { OrderPage } from "../features/store/OrderPage";
import { StoreLayout } from "../features/store/StoreLayout";
import { StorefrontPage } from "../features/store/StorefrontPage";
import { useTranslation } from "../i18n";
import { AppShell } from "./AppShell";
import { ComingSoon, FullPageMessage } from "./ui";

function RequireAuth() {
  const { t } = useTranslation();
  const { data: session, isPending, error } = useSession();
  if (isPending) return <FullPageMessage>{t("common.loading")}</FullPageMessage>;
  if (error) return <FullPageMessage>{t("app.apiUnreachable")}</FullPageMessage>;
  if (!session) return <Navigate to="/login" replace />;
  return <Outlet />;
}

function GuestOnly() {
  const { t } = useTranslation();
  const { data: session, isPending } = useSession();
  if (isPending) return <FullPageMessage>{t("common.loading")}</FullPageMessage>;
  return session ? <Navigate to="/" replace /> : <Outlet />;
}

/** Pages for what is not built yet. Components, so their text follows the chosen language. */
function ReturnsSoon() {
  const { t } = useTranslation();
  return (
    <ComingSoon title={t("nav.returns")} available={[{ to: "/counter", label: t("nav.manualBilling") }]}>
      <p>{t("returns.line1")}</p>
      <p>{t("returns.line2")}</p>
    </ComingSoon>
  );
}

function OffersSoon() {
  const { t } = useTranslation();
  return (
    <ComingSoon title={t("nav.offers")} available={[{ to: "/catalogue/products", label: t("nav.products") }]}>
      <p>{t("offers.line1")}</p>
      <p>{t("offers.line2")}</p>
    </ComingSoon>
  );
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
      element: <ReturnsSoon />,
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
      element: <OffersSoon />,
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
          { path: "insights", element: <InsightsPage /> },
          { path: "analytics", element: <AnalyticsPage /> },
          { path: "settings", element: <SettingsPage /> },
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
