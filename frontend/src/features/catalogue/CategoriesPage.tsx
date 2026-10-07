import { useState, type FormEvent } from "react";
import { Card, PageHeader, QueryState } from "../../app/ui";
import { useAllProducts, useCategories, useDeleteCategory, useSaveCategory, type Category } from "./api";
import { CatalogueSummary } from "./CatalogueSummary";

const input = "rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none";
const primary = "rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50";
const secondary = "rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-50 disabled:opacity-50";

/** Groups for the merchant's products. A product has one category or none. */
export function CategoriesPage() {
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
      <PageHeader title="Categories" subtitle="Group your products. Set a product's category under Products." />
      <CatalogueSummary />

      <div className="max-w-2xl space-y-4">
        <Card title="Add category">
          <form onSubmit={onAdd} className="flex flex-wrap gap-2">
            <input
              aria-label="Category name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={80}
              placeholder="e.g. Snacks"
              className={`min-w-40 flex-1 ${input}`}
            />
            <button type="submit" className={primary} disabled={save.isPending || !name.trim()}>
              Add category
            </button>
          </form>
          {save.error && save.variables?.id === null && (
            <p role="alert" className="mt-2 text-sm text-red-600">
              {save.error.message}
            </p>
          )}
        </Card>

        <Card title="Your categories">
          <QueryState isPending={categories.isPending} error={categories.error} />
          {categories.data?.length === 0 && <p className="py-4 text-center text-sm text-slate-500">No categories yet.</p>}
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
              aria-label={`New name for ${category.name}`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={80}
              autoFocus
              className={`min-w-40 flex-1 ${input}`}
            />
            <button type="submit" className={secondary} disabled={save.isPending || !name.trim()}>
              Save
            </button>
            <button type="button" className={secondary} onClick={() => setState("view")}>
              Cancel
            </button>
          </form>
        ) : (
          <>
            <span className="flex-1 font-medium text-slate-900">
              {category.name}
              {products !== undefined && (
                <span className="ml-2 font-normal text-slate-500">
                  {products} {products === 1 ? "product" : "products"}
                </span>
              )}
            </span>
            {state === "view" ? (
              <>
                <button type="button" className={secondary} onClick={() => setState("rename")}>
                  Rename
                </button>
                <button type="button" className={secondary} onClick={() => setState("delete")}>
                  Delete
                </button>
              </>
            ) : (
              <>
                <span className="text-slate-600">Delete it? Its products stay, without a category.</span>
                <button type="button" className={secondary} disabled={remove.isPending} onClick={() => remove.mutate(category.id)}>
                  Yes, delete
                </button>
                <button type="button" className={secondary} onClick={() => setState("view")}>
                  Keep
                </button>
              </>
            )}
          </>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-1 text-red-600">
          {error.message}
        </p>
      )}
    </li>
  );
}
