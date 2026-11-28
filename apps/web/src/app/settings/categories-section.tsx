import { DEFAULT_CATEGORY } from "@/db/schema";
import type { requireHousehold } from "@/lib/session";
import { ActionForm } from "../action-form";
import { missingStarters } from "@/lib/categories";
import { addCategoryAction, addStarterCategoriesAction, removeCategoryAction, renameCategoryAction, setCategoryTaxAction } from "../actions";

type Ctx = Awaited<ReturnType<typeof requireHousehold>>;

// The group's own list of what a cost can be for.
export async function CategoriesSection({ db, home, categories }: Ctx) {
  const active = categories.filter((c) => !c.removedAt);
  const business = home.kind === "business";
  const missing = business ? await missingStarters(db, home.id, home.kind) : [];
  return (
    <section aria-labelledby="categories" className="mb-10">
      <h2 id="categories">Categories</h2>
      <p className="note">
        What a cost in {home.name} can be for. Renaming a category renames it on every cost that has it. Removing
        one takes it off the list; costs that already have it keep showing its name.
        {business &&
          " The tax line is where a category goes on Schedule C, part II. It is a guide: which line a cost belongs on is your call, and the form's line numbers can change from year to year."}
      </p>
      <table>
        <thead>
          <tr>
            <th>Category</th>
            {business && <th>Tax line</th>}
            <th />
          </tr>
        </thead>
        <tbody>
          {active.map((c) => (
            <tr key={c.slug}>
              <td>
                <ActionForm action={renameCategoryAction} done="Renamed" className="row">
                  <input type="hidden" name="slug" value={c.slug} />
                  <input name="label" defaultValue={c.label} aria-label={`Name of ${c.label}`} maxLength={40} required />
                  <button className="quiet">Rename</button>
                </ActionForm>
              </td>
              {business && (
                <td>
                  <ActionForm action={setCategoryTaxAction} done="Saved" className="row">
                    <input type="hidden" name="slug" value={c.slug} />
                    <input name="taxLine" defaultValue={c.taxLine ?? ""} aria-label={`Tax line of ${c.label}`} maxLength={12} size={5} placeholder="none" />
                    <label className="check">
                      <input type="checkbox" name="half" defaultChecked={c.halfDeductible} aria-label={`${c.label} counts at half`} /> Meals, at half
                    </label>
                    <button className="quiet">Save</button>
                  </ActionForm>
                </td>
              )}
              <td>
                {c.slug === DEFAULT_CATEGORY ? (
                  <span className="note">for costs with no category</span>
                ) : (
                  <ActionForm action={removeCategoryAction} done="Removed">
                    <input type="hidden" name="slug" value={c.slug} />
                    <button className="quiet">Remove</button>
                  </ActionForm>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {missing.length > 0 && (
        <ActionForm action={addStarterCategoriesAction} done="Added" className="my-4">
          <p className="note">
            The tax form has lines this list does not cover yet: {missing.map((s) => (s.taxLine ? `${s.label} (${s.taxLine})` : s.label)).join(", ")}.
          </p>
          <button>
            Add the {missing.length} missing {missing.length === 1 ? "category" : "categories"}
          </button>
        </ActionForm>
      )}
      <ActionForm action={addCategoryAction} done="Added" className="row">
        <label>
          New category
          <input name="label" maxLength={40} required />
        </label>
        <button>Add category</button>
      </ActionForm>
    </section>
  );
}
