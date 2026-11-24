/**
 * Document-card payload builder for the MCP Apps (SEP-1865) UI surface.
 *
 * get_document results get a normalized `_card` object attached (see
 * mcp-server.ts) that the ui:// document card renders from. The card is
 * progressive enhancement: every step here is best-effort, and a null return
 * simply means the host renders no card while the JSON payload is unchanged.
 *
 * The card is read-only — IT Glue is a documentation system, so there is no
 * in-card write round-trip.
 */

import type { ITGlueClient } from "./mcp-server.js";

export const DOCUMENT_CARD_RESOURCE_URI = "ui://itglue/document-card.html";

/** MCP Apps resource MIME (RESOURCE_MIME_TYPE in @modelcontextprotocol/ext-apps). */
export const MCP_APP_RESOURCE_MIME = "text/html;profile=mcp-app";

/**
 * Tool `_meta` advertising the card. Carries both the canonical flat key
 * (RESOURCE_URI_META_KEY in ext-apps) and the nested form ext-apps'
 * registerAppTool emits, so any MCP Apps host revision finds it.
 */
export const DOCUMENT_CARD_META = {
  "ui/resourceUri": DOCUMENT_CARD_RESOURCE_URI,
  ui: { resourceUri: DOCUMENT_CARD_RESOURCE_URI },
} as const;

/** Mirror of Brand in ui/document-card.ts — keep in sync. */
export interface CardBrand {
  name?: string;
  logoUrl?: string;
  primaryColor?: string;
  accentColor?: string;
  bg?: string;
  text?: string;
}

/** The BRAND_INJECT comment marker baked into the card HTML (see ui/index.html). */
const BRAND_INJECT_RE = /<!--\s*BRAND_INJECT:[\s\S]*?-->/;

/**
 * Serve-time brand injection: replace the BRAND_INJECT marker with an inline
 * `window.__BRAND__` script so self-hosters can theme the card without
 * rebuilding the bundle. An empty brand returns the HTML unchanged (the card
 * renders its neutral defaults). `<` is escaped so brand values can never
 * break out of the script tag.
 */
export function applyBrandInjection(html: string, brand: CardBrand): string {
  if (!brand || Object.values(brand).every((v) => !v)) return html;
  const json = JSON.stringify(brand).replace(/</g, "\\u003c");
  return html.replace(BRAND_INJECT_RE, `<script>window.__BRAND__=${json}</script>`);
}

/**
 * Resolve brand overrides from MCP_BRAND_* environment variables. Guarded for
 * runtimes without `process` (Cloudflare Workers), where this returns an empty
 * brand and the card serves its neutral defaults.
 */
export function resolveBrandFromEnv(): CardBrand {
  if (typeof process === "undefined" || !process.env) return {};
  const env = process.env;
  const brand: CardBrand = {};
  if (env.MCP_BRAND_NAME) brand.name = env.MCP_BRAND_NAME;
  if (env.MCP_BRAND_LOGO_URL) brand.logoUrl = env.MCP_BRAND_LOGO_URL;
  if (env.MCP_BRAND_PRIMARY_COLOR) brand.primaryColor = env.MCP_BRAND_PRIMARY_COLOR;
  if (env.MCP_BRAND_ACCENT_COLOR) brand.accentColor = env.MCP_BRAND_ACCENT_COLOR;
  if (env.MCP_BRAND_BG) brand.bg = env.MCP_BRAND_BG;
  if (env.MCP_BRAND_TEXT) brand.text = env.MCP_BRAND_TEXT;
  return brand;
}

/** Mirror of DocumentCard in ui/document-card.ts — keep in sync. */
export interface DocumentCard {
  id: string;
  name: string;
  organization?: string;
  folder?: string;
  archived?: boolean;
  createdAt?: string;
  updatedAt?: string;
  sections: Array<{ heading?: boolean; text: string }>;
}

const CARD_SECTION_LIMIT = 6;
const CARD_SECTION_MAX_LENGTH = 300;

/**
 * Resolve a display label for an IT Glue field: many resources carry a
 * resolved `*Name` string alongside the id, so prefer the name and fall back
 * to `#id`.
 */
function label(name: unknown, id: unknown): string | undefined {
  if (typeof name === "string" && name) return name;
  if (id != null) return `#${id}`;
  return undefined;
}

/** Named entities decoded for the preview. `&amp;` is handled separately, last. */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * Decode one entity reference, or return it unchanged when it is unknown or
 * names an invalid code point.
 */
function decodeEntity(match: string, ref: string): string {
  if (ref[0] === "#") {
    const hex = ref[1] === "x" || ref[1] === "X";
    const code = Number.parseInt(ref.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return match;
    if (code >= 0xd800 && code <= 0xdfff) return match;
    return String.fromCodePoint(code);
  }
  return NAMED_ENTITIES[ref.toLowerCase()] ?? match;
}

/**
 * Flatten a section's HTML body to a short plain-text preview. Vendor HTML is
 * untrusted; the card renders this string only ever as a DOM text node, so
 * this strip is about signal (a readable preview), not sanitization.
 *
 * Entities are decoded exactly once: `&amp;` is decoded last so an escaped
 * entity such as `&amp;lt;` reads as the literal text `&lt;`, not `<`.
 */
function htmlToPreview(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, ref: string) =>
      ref.toLowerCase() === "amp" ? match : decodeEntity(match, ref)
    )
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CARD_SECTION_MAX_LENGTH);
}

/** First non-empty string among `keys` on `obj`. */
function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

interface RawSection {
  body: string;
  resourceType: string;
  sort: number | undefined;
}

/**
 * Read one entry of a document's sectioned body. IT Glue hands sections back
 * in several shapes, and the client only camelCases top-level attributes, so
 * nested keys keep their wire spelling:
 *
 *   - `content` embedded on the document:
 *     `{ resource_type, resource: { content }, sort }`
 *   - `sections` embedded on the document (raw JSON:API):
 *     `{ type, attributes: { content, "rendered-content", "resource-type", sort } }`
 *   - the `/documents/:id/relationships/sections` endpoint, deserialized:
 *     `{ id, type, content, resourceType, sort }`
 *
 * A bare HTML string is accepted too. The section's own `content` wins over
 * `rendered-content`.
 */
function readSection(entry: unknown): RawSection | null {
  if (typeof entry === "string") {
    return entry ? { body: entry, resourceType: "", sort: undefined } : null;
  }
  const outer = asRecord(entry);
  if (!outer) return null;
  // Most specific first: the section resource, then JSON:API attributes, then the entry.
  const layers = [asRecord(outer.resource), asRecord(outer.attributes), outer].filter(
    (layer): layer is Record<string, unknown> => layer !== undefined
  );

  const bodyKeys = ["content", "renderedContent", "rendered-content", "rendered_content"];
  const typeKeys = ["resourceType", "resource-type", "resource_type"];
  let body: string | undefined;
  let resourceType: string | undefined;
  let sort: number | undefined;
  for (const layer of layers) {
    body ??= pickString(layer, bodyKeys);
    resourceType ??= pickString(layer, typeKeys);
    if (sort === undefined) {
      const raw = layer.sort;
      const n = typeof raw === "string" && raw.trim() ? Number(raw) : raw;
      if (typeof n === "number" && Number.isFinite(n)) sort = n;
    }
  }
  if (!body) return null;
  return { body, resourceType: resourceType ?? "", sort };
}

/**
 * Normalize a list of section entries into card sections: ordered by `sort`
 * (entries without one keep their place after the sorted ones), flattened to
 * text, headings flagged, empty bodies dropped, capped at CARD_SECTION_LIMIT.
 */
function toCardSections(entries: unknown[]): DocumentCard["sections"] {
  const raw = entries
    .map((entry, index) => ({ section: readSection(entry), index }))
    .filter((e): e is { section: RawSection; index: number } => e.section !== null);
  raw.sort((a, b) => {
    const sa = a.section.sort ?? Number.POSITIVE_INFINITY;
    const sb = b.section.sort ?? Number.POSITIVE_INFINITY;
    return sa === sb ? a.index - b.index : sa < sb ? -1 : 1;
  });

  const sections: DocumentCard["sections"] = [];
  for (const { section } of raw) {
    if (sections.length >= CARD_SECTION_LIMIT) break;
    const text = htmlToPreview(section.body);
    if (!text) continue;
    sections.push(/heading/i.test(section.resourceType) ? { heading: true, text } : { text });
  }
  return sections;
}

/**
 * The sectioned body already on the document, if any: `content` (IT Glue's
 * embedded body) first, then an embedded `sections` list. Returns null when
 * neither is an array, which is the only case that needs a fetch.
 */
function embeddedSections(doc: Record<string, unknown>): unknown[] | null {
  const candidates = [doc.content, doc.sections].filter(Array.isArray) as unknown[][];
  if (candidates.length === 0) return null;
  return candidates.find((list) => list.some((entry) => readSection(entry) !== null))
    ?? candidates[0];
}

/**
 * Build the renderable card from a get_document payload. The sections come
 * from the body already on the document (`content` or `sections`) when it is
 * there; only otherwise are they fetched, best-effort, so the card has a
 * visible content preview.
 */
export async function buildDocumentCard(
  doc: Record<string, unknown>,
  client: Pick<ITGlueClient, "request">
): Promise<DocumentCard | null> {
  if (doc?.id == null || typeof doc.name !== "string" || !doc.name) {
    return null;
  }

  const card: DocumentCard = {
    id: String(doc.id),
    name: doc.name,
    sections: [],
  };

  const organization = label(doc.organizationName, doc.organizationId);
  if (organization) card.organization = organization;
  // Folder names are a separate (tenant-gated) resource — the card shows the
  // raw id rather than fetching the whole folder tree per read.
  if (doc.documentFolderId != null) card.folder = `#${doc.documentFolderId}`;
  if (doc.archived === true) card.archived = true;
  if (doc.createdAt) card.createdAt = String(doc.createdAt);
  if (doc.updatedAt) card.updatedAt = String(doc.updatedAt);

  // A short content preview gives the card its value. Prefer the body IT Glue
  // embeds on the document; fall back to the sections endpoint.
  try {
    let body = embeddedSections(doc);
    if (body === null) {
      const response = await client.request(
        `/documents/${card.id}/relationships/sections`,
        {}
      );
      body = Array.isArray(response.data) ? response.data : null;
    }
    if (body) card.sections = toCardSections(body);
  } catch {
    // Best-effort: render the card without a preview rather than failing the tool.
  }

  return card;
}
