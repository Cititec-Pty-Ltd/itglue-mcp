/**
 * Flexible asset field listing, get, create and update.
 *
 * The update tests pin the behaviour that matters most: IT Glue replaces a flexible asset's whole
 * trait set on PATCH, so every field the caller did not mention must be sent back unchanged (tag
 * fields as ID arrays), and an asset whose Password or Upload value would have to be re-sent is
 * refused before anything is written.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { createMcpServer } from "../index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  REDACTED_PASSWORD,
  checkSuppliedTraits,
  mergeTraitsForUpdate,
  missingRequired,
  redactTraits,
  toField,
  toWritableValue,
  type FlexibleAssetField,
} from "../utils/flexible-assets.js";

function field(nameKey: string, kind: string, extra: Partial<FlexibleAssetField> = {}): FlexibleAssetField {
  return {
    id: nameKey,
    name: nameKey,
    name_key: nameKey,
    kind,
    required: false,
    tag_type: null,
    hint: null,
    default_value: null,
    order: null,
    ...extra,
  };
}

const FIELDS: FlexibleAssetField[] = [
  field("name", "Text", { required: true }),
  field("details", "Header"),
  field("isp", "Text"),
  field("wan-ip", "Text"),
  field("devices", "Tag", { tag_type: "Configurations" }),
  field("notes", "Textbox"),
];

describe("flexible asset helpers", () => {
  it("reduces a deserialized field record and skips one without a name key", () => {
    expect(toField({ id: "7", name: "WAN IP", nameKey: "wan-ip", kind: "Text", required: true, order: 3 })).toEqual({
      id: "7", name: "WAN IP", name_key: "wan-ip", kind: "Text", required: true,
      tag_type: null, hint: null, default_value: null, order: 3,
    });
    expect(toField({ id: "8", name: "No key" })).toBeNull();
  });

  it("turns a tag value read back into the ID array IT Glue takes on write", () => {
    const tag = field("devices", "Tag");
    expect(toWritableValue(tag, { type: "Configurations", values: [{ id: 11, name: "FW-01" }, { id: "12" }] })).toEqual([11, 12]);
    expect(toWritableValue(tag, [{ id: 5 }])).toEqual([5]);
    expect(toWritableValue(tag, { values: [] })).toBeUndefined();
    expect(toWritableValue(field("isp", "Text"), "Example ISP")).toBe("Example ISP");
  });

  it("refuses unknown keys, header keys and a non-object", () => {
    expect(checkSuppliedTraits({ "wan-ipp": "x" }, FIELDS)).toEqual({
      error: expect.stringContaining("Unknown field key(s): wan-ipp"),
    });
    expect(checkSuppliedTraits({ details: "x" }, FIELDS)).toEqual({ error: expect.stringContaining("Header") });
    expect(checkSuppliedTraits([], FIELDS)).toEqual({ error: expect.stringContaining("must be an object") });
    expect(checkSuppliedTraits({}, FIELDS)).toEqual({ error: expect.stringContaining("at least one field") });
    expect(checkSuppliedTraits({ isp: "x" }, FIELDS)).toEqual({ traits: { isp: "x" } });
  });

  it("lists required fields left empty", () => {
    expect(missingRequired({ isp: "x" }, FIELDS)).toEqual(["name"]);
    expect(missingRequired({ name: "Main office" }, FIELDS)).toEqual([]);
  });

  it("keeps every unmentioned field, converts tags, and applies changes and clears", () => {
    const current = {
      name: "Main office",
      isp: "Old ISP",
      "wan-ip": "203.0.113.10",
      devices: { type: "Configurations", values: [{ id: 41, name: "FW-01" }] },
      notes: "",
    };
    expect(mergeTraitsForUpdate(current, { isp: "New ISP", "wan-ip": null }, FIELDS)).toEqual({
      traits: { name: "Main office", isp: "New ISP", devices: [41] },
    });
  });

  it("refuses when a Password or Upload value would have to be re-sent", () => {
    const fields = [...FIELDS, field("admin-password", "Password"), field("diagram", "Upload")];
    const current = { name: "Main office", "admin-password": "secret", diagram: [{ id: 3, name: "net.png" }] };
    const result = mergeTraitsForUpdate(current, { isp: "New ISP" }, fields);
    expect(result).toEqual({ error: expect.stringContaining("admin-password (Password), diagram (Upload)") });
    // Supplying those fields explicitly is allowed.
    expect(mergeTraitsForUpdate(current, { "admin-password": "new", diagram: null }, fields)).toEqual({
      traits: { name: "Main office", "admin-password": "new" },
    });
  });

  it("redacts Password values only", () => {
    const fields = [...FIELDS, field("admin-password", "Password")];
    expect(redactTraits({ isp: "Example ISP", "admin-password": "secret" }, fields)).toEqual({
      isp: "Example ISP",
      "admin-password": REDACTED_PASSWORD,
    });
  });
});

// --- Through the MCP server, with a mocked IT Glue API ------------------------------------------

function respond(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

const FIELD_RECORDS = {
  data: [
    { id: "1", type: "flexible-asset-fields", attributes: { name: "Name", "name-key": "name", kind: "Text", required: true, order: 1 } },
    { id: "2", type: "flexible-asset-fields", attributes: { name: "ISP", "name-key": "isp", kind: "Text", required: false, order: 2 } },
    { id: "3", type: "flexible-asset-fields", attributes: { name: "WAN IP", "name-key": "wan-ip", kind: "Text", required: false, order: 3 } },
    { id: "4", type: "flexible-asset-fields", attributes: { name: "Devices", "name-key": "devices", kind: "Tag", "tag-type": "Configurations", required: false, order: 4 } },
    { id: "5", type: "flexible-asset-fields", attributes: { name: "Admin password", "name-key": "admin-password", kind: "Password", required: false, order: 5 } },
  ],
  meta: { "current-page": 1, "next-page": null, "prev-page": null, "total-pages": 1, "total-count": 5 },
};

function asset(traits: Record<string, unknown>) {
  return {
    data: {
      id: "900",
      type: "flexible-assets",
      attributes: { name: "Main office", "organization-id": 10, "flexible-asset-type-id": 77, traits },
    },
  };
}

async function connect(): Promise<Client> {
  const server = createMcpServer({ apiKey: "test-api-key" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "flexible-asset-test", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

function text(result: unknown): string {
  return (result as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "";
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

function call(i: number): { url: string; method: string; body: unknown } {
  const [url, init] = mockFetch.mock.calls[i] as [string, RequestInit | undefined];
  return {
    url: decodeURIComponent(url),
    method: init?.method ?? "GET",
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  };
}

describe("flexible asset tools", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("list_flexible_asset_fields returns name keys and kinds in order", async () => {
    const client = await connect();
    mockFetch.mockReturnValueOnce(respond(FIELD_RECORDS));
    const result = await client.callTool({ name: "list_flexible_asset_fields", arguments: { flexible_asset_type_id: 77 } });
    expect(call(0).url).toContain("/flexible_asset_types/77/relationships/flexible_asset_fields");
    const out = text(result);
    expect(out).toContain('"name_key": "wan-ip"');
    expect(out).toContain('"tag_type": "Configurations"');
    expect(out.indexOf('"name_key": "name"')).toBeLessThan(out.indexOf('"name_key": "isp"'));
  });

  it("get_flexible_asset keeps the real trait keys and redacts passwords", async () => {
    const client = await connect();
    mockFetch
      .mockReturnValueOnce(respond(asset({ name: "Main office", "wan-ip": "203.0.113.10", "admin-password": "secret" })))
      .mockReturnValueOnce(respond(FIELD_RECORDS));
    const result = await client.callTool({ name: "get_flexible_asset", arguments: { id: 900 } });
    expect(call(0).url).toBe("https://api.itglue.com/flexible_assets/900");
    const out = text(result);
    expect(out).toContain('"wan-ip": "203.0.113.10"');
    expect(out).not.toContain("wanIp");
    expect(out).not.toContain("secret");
    expect(out).toContain(REDACTED_PASSWORD);
  });

  it("create_flexible_asset posts the traits after checking keys and required fields", async () => {
    const client = await connect();
    mockFetch
      .mockReturnValueOnce(respond(FIELD_RECORDS))
      .mockReturnValueOnce(respond(asset({ name: "Main office", isp: "Example ISP" })));
    const result = await client.callTool({
      name: "create_flexible_asset",
      arguments: { organization_id: 10, flexible_asset_type_id: 77, traits: { name: "Main office", isp: "Example ISP" } },
    });
    expect(isError(result)).toBe(false);
    expect(call(1)).toEqual({
      url: "https://api.itglue.com/flexible_assets",
      method: "POST",
      body: {
        data: {
          type: "flexible-assets",
          attributes: { organization_id: 10, flexible_asset_type_id: 77, traits: { name: "Main office", isp: "Example ISP" } },
        },
      },
    });
  });

  it("create_flexible_asset refuses a missing required field without writing", async () => {
    const client = await connect();
    mockFetch.mockReturnValueOnce(respond(FIELD_RECORDS));
    const result = await client.callTool({
      name: "create_flexible_asset",
      arguments: { organization_id: 10, flexible_asset_type_id: 77, traits: { isp: "Example ISP" } },
    });
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("required field(s) not set: name");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("update_flexible_asset sends every unchanged field back with the change", async () => {
    const client = await connect();
    mockFetch
      .mockReturnValueOnce(
        respond(asset({
          name: "Main office",
          isp: "Old ISP",
          "wan-ip": "203.0.113.10",
          devices: { type: "Configurations", values: [{ id: 41, name: "FW-01" }] },
        }))
      )
      .mockReturnValueOnce(respond(FIELD_RECORDS))
      .mockReturnValueOnce(respond(asset({})));
    const result = await client.callTool({ name: "update_flexible_asset", arguments: { id: 900, traits: { isp: "New ISP" } } });
    expect(isError(result)).toBe(false);
    expect(call(2)).toEqual({
      url: "https://api.itglue.com/flexible_assets/900",
      method: "PATCH",
      body: {
        data: {
          type: "flexible-assets",
          attributes: { traits: { name: "Main office", isp: "New ISP", "wan-ip": "203.0.113.10", devices: [41] } },
        },
      },
    });
    expect(text(result)).toContain('"fields_changed"');
  });

  it("update_flexible_asset refuses an asset with a password value, before writing", async () => {
    const client = await connect();
    mockFetch
      .mockReturnValueOnce(respond(asset({ name: "Main office", "admin-password": "secret" })))
      .mockReturnValueOnce(respond(FIELD_RECORDS));
    const result = await client.callTool({ name: "update_flexible_asset", arguments: { id: 900, traits: { isp: "New ISP" } } });
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("admin-password (Password)");
    expect(text(result)).not.toContain("secret");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("update_flexible_asset refuses an unknown key, before writing", async () => {
    const client = await connect();
    mockFetch
      .mockReturnValueOnce(respond(asset({ name: "Main office" })))
      .mockReturnValueOnce(respond(FIELD_RECORDS));
    const result = await client.callTool({ name: "update_flexible_asset", arguments: { id: 900, traits: { wan_ip: "x" } } });
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("Unknown field key(s): wan_ip");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
