import { useState, type FormEvent } from "react";
import { Card, PageHeader } from "../../app/ui";
import { APP_LANGUAGES, setAppLanguage, useTranslation, type AppLanguage } from "../../i18n";
import { useSession, useUpdateMerchant } from "../auth/session";

const input = "w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none";
const primary = "rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50";

/** Store profile fields the owner can change after registration. Today: just the GSTIN, shown on every bill once set. */
export function SettingsPage() {
  const { t, language } = useTranslation();
  const { data: session } = useSession();
  const update = useUpdateMerchant();
  const [gstin, setGstin] = useState(session?.merchant.gstin ?? "");
  const [saved, setSaved] = useState(false);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    update.mutate({ gstin: gstin.trim() || null }, { onSuccess: () => setSaved(true) });
  }

  return (
    <>
      <PageHeader title={t("settings.title")} subtitle={t("settings.subtitle")} />
      <div className="mb-4">
        <Card title={t("settings.language")}>
          <label className="block max-w-sm text-sm text-slate-600">
            {t("settings.appLanguage")}
            <select
              value={language}
              onChange={(e) => setAppLanguage(e.target.value as AppLanguage)}
              className={`mt-1 bg-white ${input}`}
            >
              {APP_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code} lang={l.htmlLang}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          <p className="mt-2 max-w-sm text-xs text-slate-500">{t("settings.languageHelp")}</p>
        </Card>
      </div>
      <Card title={session?.merchant.store_name}>
        <form onSubmit={onSubmit} className="max-w-sm space-y-3">
          <label className="block text-sm text-slate-600">
            {t("settings.gstin")}
            <input
              value={gstin}
              onChange={(e) => {
                setGstin(e.target.value);
                setSaved(false);
              }}
              placeholder={t("settings.gstinPlaceholder")}
              maxLength={15}
              className={`mt-1 ${input}`}
            />
          </label>
          <p className="text-xs text-slate-500">
            {t("settings.gstinHelp")}
          </p>
          {update.error && (
            <p role="alert" className="text-sm text-red-600">
              {update.error.message}
            </p>
          )}
          {saved && !update.error && <p className="text-sm text-emerald-700">{t("common.saved")}</p>}
          <button type="submit" className={primary} disabled={update.isPending}>
            {update.isPending ? t("common.saving") : t("common.save")}
          </button>
        </form>
      </Card>
    </>
  );
}
