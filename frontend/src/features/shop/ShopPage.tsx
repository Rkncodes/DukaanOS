import { Outlet } from "react-router";
import { PageHeader } from "../../app/ui";
import { useTranslation } from "../../i18n";

/**
 * The merchant's side of the Shop: orders placed on the storefront, the storefront itself, and the QR code
 * that leads customers to it. The app's navigation moves between them.
 */
export function ShopPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t("nav.shop")} subtitle={t("shop.subtitle")} />
      <Outlet />
    </>
  );
}
