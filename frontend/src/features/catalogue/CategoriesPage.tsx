import { useState, type FormEvent } from "react";
import { Card, PageHeader, QueryState } from "../../app/ui";
import { useTranslation } from "../../i18n";
import { useAllProducts, useCategories, useDeleteCategory, useSaveCategory, type Category } from "./api";
import { CatalogueSummary } from "./CatalogueSummary";

const input = "rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none";
const primary = "rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50";
const secondary = "rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-50 disabled:opacity-50";

/** Groups for the merchant's products. A product has one category or none. */
export function CategoriesPage() {
  const { t, problem } = useTranslation();
  const categories = useCategories();
  const products = useAllProducts();
  const save = useSaveCategory();
  const [name, setName] = useState("");

  const countIn = (id: string) => products.data?.filter((p) => p.category_id === id).length;

  function onAdd(e: FormEvent) {
    e.preventDefault();
    save.mutate({ id: null, name: name.trim() }, { onSuccess: () => setName("") });
  }

  return (
    <>
      <PageHeader title={t("nav.categories")} subtitle={t("categories.subtitle")} />
      <CatalogueSummary />

      <div className="max-w-2xl space-y-4">
        <Card title={t("categories.add")}>
          <form onSubmit={onAdd} className="flex flex-wrap gap-2">
            <input
              aria-label={t("categories.name")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={80}
              placeholder={t("categories.placeholder")}
              className={`min-w-40 flex-1 ${input}`}
            />
            <button type="submit" className={primary} disabled={save.isPending || !name.trim()}>
              {t("categories.add")}
            </button>
          </form>
          {save.error && save.variables?.id === null && (
            <p role="alert" className="mt-2 text-sm text-red-600">
              {problem(save.error)}
            </p>
          )}
        </Card>

        <Card title={t("categories.yours")}>
          <QueryState isPending={categories.isPending} error={categories.error} />
          {categories.data?.length === 0 && <p className="py-4 text-center text-sm text-slate-500">{t("categories.none")}</p>}
          <ul className="divide-y divide-slate-100">
            {categories.data?.map((category) => (
              <CategoryRow key={category.id} category={category} products={countIn(category.id)} />
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}

function CategoryRow({ category, products }: { category: Category; products: number | undefined }) {
  const { t, problem } = useTranslation();
  const save = useSaveCategory();
  const remove = useDeleteCategory();
  const [state, setState] = useState<"view" | "rename" | "delete">("view");
  const [name, setName] = useState(category.name);
  const error = save.error ?? remove.error;

  function onRename(e: FormEvent) {
    e.preventDefault();
    save.mutate({ id: category.id, name: name.trim() }, { onSuccess: () => setState("view") });
  }

  return (
    <li aria-label={category.name} className="py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        {state === "rename" ? (
          <form onSubmit={onRename} className="flex flex-1 flex-wrap gap-2">
            <input
              aria-label={t("categories.newNameFor", { name: category.name })}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={80}
              autoFocus
              className={`min-w-40 flex-1 ${input}`}
            />
            <button type="submit" className={secondary} disabled={save.isPending || !name.trim()}>
              {t("common.save")}
            </button>
            <button type="button" className={secondary} onClick={() => setState("view")}>
              {t("common.cancel")}
            </button>
          </form>
        ) : (
          <>
            <span className="flex-1 font-medium text-slate-900">
              {category.name}
              {products !== undefined && (
                <span className="ml-2 font-normal text-slate-500">
                  {t(products === 1 ? "categories.productCount.one" : "categories.productCount.other", { count: products })}
                </span>
              )}
            </span>
            {state === "view" ? (
              <>
                <button type="button" className={secondary} onClick={() => setState("rename")}>
                  {t("categories.rename")}
                </button>
                <button type="button" className={secondary} onClick={() => setState("delete")}>
                  {t("categories.delete")}
                </button>
              </>
            ) : (
              <>
                <span className="text-slate-600">{t("categories.confirmDelete")}</span>
                <button type="button" className={secondary} disabled={remove.isPending} onClick={() => remove.mutate(category.id)}>
                  {t("categories.yesDelete")}
                </button>
                <button type="button" className={secondary} onClick={() => setState("view")}>
                  {t("categories.keep")}
                </button>
              </>
            )}
          </>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-1 text-red-600">
          {problem(error)}
        </p>
      )}
    </li>
  );
}
