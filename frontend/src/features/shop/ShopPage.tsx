import { Outlet } from "react-router";
import { PageHeader } from "../../app/ui";

/**
 * The merchant's side of the Shop: orders placed on the storefront, the storefront itself, and the QR code
 * that leads customers to it. The app's navigation moves between them.
 */
export function ShopPage() {
  return (
    <>
      <PageHeader title="Shop" subtitle="Manage your online storefront and incoming orders." />
      <Outlet />
    </>
  );
}
