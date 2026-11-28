// What a business group's expense can say beyond its description: who was
// paid, what it was for, and how much of it was for the business.
export function DetailFields({ vendor, note, businessUseBp, useBasis }: { vendor?: string | null; note?: string | null; businessUseBp?: number; useBasis?: string | null }) {
  return (
    <div className="row">
      <label>
        Vendor
        <input name="vendor" defaultValue={vendor ?? ""} maxLength={500} />
      </label>
      <label className="max-sm:basis-full">
        Note
        <input name="note" defaultValue={note ?? ""} maxLength={500} placeholder="What it was for" />
      </label>
      <label>
        Business use %
        <input name="businessUse" inputMode="decimal" size={6} defaultValue={String((businessUseBp ?? 10000) / 100)} required />
      </label>
      <label className="max-sm:basis-full">
        Why, if less than 100%
        <input name="useBasis" defaultValue={useBasis ?? ""} maxLength={500} placeholder="Half the calls are clients" />
      </label>
    </div>
  );
}
