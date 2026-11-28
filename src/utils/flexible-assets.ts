/**
 * Helpers for the flexible asset write tools.
 *
 * IT Glue flexible assets ("Apps & Services") are user-defined: each flexible asset type has its
 * own fields, identified by a `name-key` (for example `wan-ip`). Three facts shape this module:
 *
 * 1. Updating a flexible asset REPLACES its whole trait set. A field left out of the PATCH body is
 *    cleared. So an update must read the current traits and send them back with the changes.
 * 2. Tag fields read back as `{ type, values: [{ id, name, ... }] }` but are written as an array
 *    of record IDs, so a value read back has to be converted before it can be re-sent.
 * 3. Password and Upload fields cannot be re-sent safely from what a read returns, so an update
 *    that would have to carry one of them unchanged is refused instead of risking the value.
 */

/** A flexible asset type's field, as list_flexible_asset_fields returns it. */
export interface FlexibleAssetField {
  id: string;
  name: string | null;
  name_key: string;
  kind: string | null;
  required: boolean;
  tag_type: string | null;
  hint: string | null;
  default_value: unknown;
  order: number | null;
}

/** Field kinds whose stored value cannot be re-sent from what a read returns. */
const NOT_RESENDABLE_KINDS = new Set(["password", "upload"]);

/** Field kinds that hold no value (layout only). */
const VALUELESS_KINDS = new Set(["header"]);

/** Placeholder shown instead of a Password field's value. */
export const REDACTED_PASSWORD = "[redacted: password field - view it in IT Glue]";

/** One field record (deserialized: camelCase attribute keys) reduced to what callers need. */
export function toField(record: Record<string, unknown>): FlexibleAssetField | null {
  const nameKey = record.nameKey;
  if (typeof nameKey !== "string" || nameKey === "") return null;
  const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
  const order = Number(record.order);
  return {
    id: String(record.id),
    name: str(record.name),
    name_key: nameKey,
    kind: str(record.kind),
    required: record.required === true,
    tag_type: str(record.tagType),
    hint: str(record.hint),
    default_value: record.defaultValue ?? null,
    order: Number.isFinite(order) ? order : null,
  };
}

/** Fields in display order. */
export function sortFields(fields: FlexibleAssetField[]): FlexibleAssetField[] {
  return [...fields].sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));
}

function kindOf(field: FlexibleAssetField | undefined): string {
  return (field?.kind ?? "").toLowerCase();
}

/** Whether a trait value is empty (nothing stored). */
export function isEmptyTrait(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") {
    const values = (value as { values?: unknown }).values;
    if (Array.isArray(values)) return values.length === 0;
    return Object.keys(value as object).length === 0;
  }
  return false;
}

/**
 * A stored trait value in the form IT Glue accepts on write. Tag values read back as
 * `{ values: [{ id }] }` (or an array of such records) and are written as an array of IDs.
 * Returns undefined when a tag value has no usable IDs.
 */
export function toWritableValue(field: FlexibleAssetField | undefined, value: unknown): unknown {
  if (kindOf(field) !== "tag") return value;
  const records = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { values?: unknown }).values)
      ? ((value as { values: unknown[] }).values)
      : undefined;
  if (!records) return value;
  const ids = records
    .map((r) => (r && typeof r === "object" ? Number((r as { id?: unknown }).id) : Number(r)))
    .filter((n) => Number.isInteger(n) && n > 0);
  return ids.length > 0 ? ids : undefined;
}

/** Traits with every Password field's value replaced by a placeholder. Keys are left as they are. */
export function redactTraits(
  traits: Record<string, unknown> | undefined,
  fields: FlexibleAssetField[]
): Record<string, unknown> {
  const byKey = new Map(fields.map((f) => [f.name_key, f]));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(traits ?? {})) {
    out[key] = kindOf(byKey.get(key)) === "password" && !isEmptyTrait(value) ? REDACTED_PASSWORD : value;
  }
  return out;
}

/** Validates the traits object a caller supplied: a plain object whose keys are field keys. */
export function checkSuppliedTraits(
  traits: unknown,
  fields: FlexibleAssetField[]
): { traits: Record<string, unknown> } | { error: string } {
  if (!traits || typeof traits !== "object" || Array.isArray(traits)) {
    return { error: "traits must be an object of field keys to values (see list_flexible_asset_fields)" };
  }
  const supplied = traits as Record<string, unknown>;
  if (Object.keys(supplied).length === 0) {
    return { error: "traits must set at least one field" };
  }
  const byKey = new Map(fields.map((f) => [f.name_key, f]));
  const unknown = Object.keys(supplied).filter((k) => !byKey.has(k));
  if (unknown.length > 0) {
    return {
      error:
        `Unknown field key(s): ${unknown.join(", ")}. Valid keys for this type: ` +
        `${fields.filter((f) => !VALUELESS_KINDS.has(kindOf(f))).map((f) => f.name_key).join(", ")}`,
    };
  }
  const headers = Object.keys(supplied).filter((k) => VALUELESS_KINDS.has(kindOf(byKey.get(k))));
  if (headers.length > 0) {
    return { error: `Header field(s) hold no value: ${headers.join(", ")}` };
  }
  return { traits: supplied };
}

/** Required fields a new flexible asset would be missing. */
export function missingRequired(traits: Record<string, unknown>, fields: FlexibleAssetField[]): string[] {
  return fields
    .filter((f) => f.required && !VALUELESS_KINDS.has(kindOf(f)) && isEmptyTrait(traits[f.name_key]))
    .map((f) => f.name_key);
}

/**
 * The full trait set to send when updating: the current values in writable form, with the
 * supplied ones replacing them (null clears a field). Refuses when a Password or Upload field
 * holds a value that would have to be re-sent unchanged.
 */
export function mergeTraitsForUpdate(
  current: Record<string, unknown> | undefined,
  updates: Record<string, unknown>,
  fields: FlexibleAssetField[]
): { traits: Record<string, unknown> } | { error: string } {
  const merged: Record<string, unknown> = {};
  const blocked: string[] = [];
  for (const field of fields) {
    const key = field.name_key;
    if (VALUELESS_KINDS.has(kindOf(field))) continue;
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      const value = updates[key];
      if (value !== null && value !== undefined) merged[key] = value;
      continue;
    }
    const existing = current?.[key];
    if (isEmptyTrait(existing)) continue;
    if (NOT_RESENDABLE_KINDS.has(kindOf(field))) {
      blocked.push(`${key} (${field.kind})`);
      continue;
    }
    const writable = toWritableValue(field, existing);
    if (writable !== undefined) merged[key] = writable;
  }
  if (blocked.length > 0) {
    return {
      error:
        `This asset has a value in ${blocked.join(", ")}. IT Glue replaces every field on update, and ` +
        "that value cannot be re-sent safely, so it would be lost. Make this change in IT Glue instead, " +
        "or include those fields in traits.",
    };
  }
  return { traits: merged };
}
