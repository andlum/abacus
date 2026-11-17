import { DEFAULT_CATEGORY } from "@/db/schema";
import type { requireHousehold } from "@/lib/session";
import { ActionForm } from "../action-form";
import { addCategoryAction, removeCategoryAction, renameCategoryAction } from "../actions";

type Ctx = Awaited<ReturnType<typeof requireHousehold>>;

// The group's own list of what a cost can be for.
export function CategoriesSection({ home, categories }: Ctx) {
  const active = categories.filter((c) => !c.removedAt);
  return (
    <section aria-labelledby="categories" className="mb-10">
      <h2 id="categories">Categories</h2>
      <p className="note">
        What a cost in {home.name} can be for. Renaming a category renames it on every cost that has it. Removing
        one takes it off the list; costs that already have it keep showing its name.
      </p>
      <table>
        <thead>
          <tr>
            <th>Category</th>
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
