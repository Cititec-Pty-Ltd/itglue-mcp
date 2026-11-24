/**
 * MCP Apps (SEP-1865) contract tests — mirrors the checks an MCP Apps host
 * performs to render the document card:
 *   1. the renderable tool advertises the UI resource via _meta
 *   2. the ui:// resource lists and reads back as profile=mcp-app HTML,
 *      neutral by default and brandable via MCP_BRAND_* injection
 *   3. buildDocumentCard normalizes an IT Glue document into the card payload
 *      the iframe renders from, best-effort
 *   4. get_document attaches _card without changing the rest of the payload
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fetch globally before importing the server factory.
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { createMcpServer } from "../mcp-server.js";
import { listResources, readResource } from "../resources.js";
import {
  buildDocumentCard,
  applyBrandInjection,
  DOCUMENT_CARD_RESOURCE_URI,
  MCP_APP_RESOURCE_MIME,
} from "../card.builder.js";
import { DOCUMENT_CARD_HTML } from "../generated/document-card-html.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const RENDERABLE_TOOLS = ["get_document"];

async function connectClient(): Promise<Client> {
  const server = createMcpServer({ apiKey: "test-api-key" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "mcp-apps-test", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

function jsonApiResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

describe("MCP Apps document card", () => {
  describe("tool _meta advertisement", () => {
    it.each(RENDERABLE_TOOLS)("%s links the card via _meta", async (name) => {
      const client = await connectClient();
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === name);
      expect(tool).toBeDefined();
      // Canonical flat key (ext-apps RESOURCE_URI_META_KEY) …
      expect(tool?._meta?.["ui/resourceUri"]).toBe(DOCUMENT_CARD_RESOURCE_URI);
      // … and the nested form registerAppTool also emits.
      expect((tool?._meta?.ui as { resourceUri?: string })?.resourceUri).toBe(
        DOCUMENT_CARD_RESOURCE_URI
      );
    });

    it("no other tools carry UI metadata", async () => {
      const client = await connectClient();
      const { tools } = await client.listTools();
      const others = tools.filter(
        (t) => t._meta && !RENDERABLE_TOOLS.includes(t.name)
      );
      expect(others).toEqual([]);
    });
  });

  describe("ui:// resource", () => {
    it("is listed with the MCP Apps MIME type", () => {
      const card = listResources().find((r) => r.uri === DOCUMENT_CARD_RESOURCE_URI);
      expect(card?.mimeType).toBe(MCP_APP_RESOURCE_MIME);
    });

    it("lists and reads over the wire (resources capability)", async () => {
      const client = await connectClient();
      const { resources } = await client.listResources();
      expect(resources.map((r) => r.uri)).toContain(DOCUMENT_CARD_RESOURCE_URI);
      const { contents } = await client.readResource({
        uri: DOCUMENT_CARD_RESOURCE_URI,
      });
      expect(contents[0]?.mimeType).toBe(MCP_APP_RESOURCE_MIME);
      expect(contents[0]?.text).toContain("<!doctype html>");
    });

    it("reads back as profile=mcp-app HTML containing the card app", () => {
      const content = readResource(DOCUMENT_CARD_RESOURCE_URI);
      expect(content.mimeType).toBe(MCP_APP_RESOURCE_MIME);
      // No MCP_BRAND_* env set → the embedded HTML is served byte-identical.
      expect(content.text).toBe(DOCUMENT_CARD_HTML);
      expect(content.text).toContain("card__bar");
      expect(content.text).toContain("BRAND_INJECT");
      // The vite build must have inlined the bridge script — a bare <script src>
      // would be unloadable from a resources/read HTML string.
      expect(content.text).not.toContain('src="./document-card.ts"');
    });

    it("serves neutral defaults with no vendor identity", () => {
      const { text } = readResource(DOCUMENT_CARD_RESOURCE_URI);
      expect(text).not.toMatch(/WYRE/i);
      expect(text).not.toContain("00c9db"); // WYRE cyan
      expect(text).not.toContain("ede947"); // WYRE yellow
      expect(text).not.toContain("fonts.googleapis.com"); // no external fetches
    });

    it("injects MCP_BRAND_* env vars into the served HTML", () => {
      vi.stubEnv("MCP_BRAND_NAME", "Acme MSP");
      vi.stubEnv("MCP_BRAND_PRIMARY_COLOR", "#ff0000");
      try {
        const { text } = readResource(DOCUMENT_CARD_RESOURCE_URI);
        expect(text).toContain(
          '<script>window.__BRAND__={"name":"Acme MSP","primaryColor":"#ff0000"}</script>'
        );
        expect(text).not.toContain("BRAND_INJECT");
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("rejects unknown resource URIs", () => {
      expect(() => readResource("ui://itglue/nope.html")).toThrow(/Unknown resource/);
    });
  });

  describe("applyBrandInjection", () => {
    const html = DOCUMENT_CARD_HTML;

    it("replaces the marker with an inline window.__BRAND__ script", () => {
      const out = applyBrandInjection(html, { name: "Acme", primaryColor: "#123456" });
      expect(out).toContain('window.__BRAND__={"name":"Acme","primaryColor":"#123456"}');
      expect(out).not.toContain("BRAND_INJECT");
    });

    it("escapes < so brand values cannot break out of the script tag", () => {
      const out = applyBrandInjection(html, { name: "</script><script>alert(1)" });
      expect(out).not.toContain("</script><script>alert(1)");
      expect(out).toContain("\\u003c/script>\\u003cscript>alert(1)");
    });

    it("returns the HTML unchanged for an empty brand", () => {
      expect(applyBrandInjection(html, {})).toBe(html);
      expect(applyBrandInjection(html, { name: "" })).toBe(html);
    });
  });

  describe("buildDocumentCard", () => {
    const doc = {
      id: "9001",
      type: "documents",
      name: "Server Room Access Runbook",
      organizationId: 77,
      organizationName: "Acme Corp",
      documentFolderId: 12,
      archived: false,
      createdAt: "2026-07-01T09:00:00Z",
      updatedAt: "2026-07-15T17:30:00Z",
    };

    const mockRequest = vi.fn(async () => ({
      data: [
        {
          id: "1",
          type: "document-sections",
          content: "<h1>Overview</h1>",
          resourceType: "Document::Heading",
        },
        {
          id: "2",
          type: "document-sections",
          content: "<p>Badge in at the <b>rear</b> entrance.</p>",
          resourceType: "Document::Text",
        },
      ],
      meta: { currentPage: 1, nextPage: null, prevPage: null, totalPages: 1, totalCount: 2 },
    }));
    const client = { request: mockRequest };

    it("normalizes labels and section previews into the card payload", async () => {
      const card = await buildDocumentCard(doc, client as never);
      expect(card).toMatchObject({
        id: "9001",
        name: "Server Room Access Runbook",
        organization: "Acme Corp",
        folder: "#12",
        createdAt: "2026-07-01T09:00:00Z",
        updatedAt: "2026-07-15T17:30:00Z",
        sections: [
          { heading: true, text: "Overview" },
          { text: "Badge in at the rear entrance." },
        ],
      });
      // archived:false is dropped, not rendered as a stale badge.
      expect(card?.archived).toBeUndefined();
    });

    it("uses the document's embedded content array without refetching", async () => {
      mockRequest.mockClear();
      const withBody = {
        ...doc,
        content: [
          { content: "<h2>Steps</h2>", "resource-type": "Document::Heading" },
          { content: "<p>" + "x".repeat(600) + "</p>" },
        ],
      };
      const card = await buildDocumentCard(withBody, client as never);
      expect(mockRequest).not.toHaveBeenCalled();
      expect(card?.sections[0]).toEqual({ heading: true, text: "Steps" });
      // Long section bodies are truncated so the card payload stays small.
      expect(card?.sections[1].text).toHaveLength(300);
    });

    it("caps the preview at six sections", async () => {
      const withBody = {
        ...doc,
        content: Array.from({ length: 10 }, (_, i) => ({
          content: `<p>Section ${i}</p>`,
        })),
      };
      const card = await buildDocumentCard(withBody, client as never);
      expect(card?.sections).toHaveLength(6);
    });

    it("falls back to #id labels when the API omits resolved names", async () => {
      const bare = { id: "1", name: "Printer setup", organizationId: 4 };
      const card = await buildDocumentCard(bare, client as never);
      expect(card?.organization).toBe("#4");
      expect(card?.folder).toBeUndefined();
    });

    it("flags archived documents", async () => {
      const card = await buildDocumentCard({ ...doc, archived: true }, client as never);
      expect(card?.archived).toBe(true);
    });

    it("returns null for payloads that are not a document", async () => {
      expect(await buildDocumentCard({ id: "1" }, client as never)).toBeNull();
      expect(await buildDocumentCard({ name: "no id" }, client as never)).toBeNull();
    });

    describe("sections already in the payload", () => {
      // Shapes as get_document returns them: the client camelCases only the
      // document's top-level attributes, so entries inside `content` and
      // `sections` keep IT Glue's wire spelling.
      const embeddedContent = [
        {
          resource_type: "Document::Text",
          resource: { content: "<p>Restart the <b>print spooler</b> service.</p>" },
          sort: 2,
        },
        {
          resource_type: "Document::Heading",
          resource: { content: "Procedure" },
          sort: 1,
        },
        {
          resource_type: "Document::Text",
          resource: { content: "<ol><li>Open Services</li><li>Find the spooler</li></ol>" },
          sort: 0,
        },
      ];
      const embeddedSections = [
        {
          type: "document-sections",
          attributes: {
            content: "<p>Check the queue is empty.</p>",
            "rendered-content": "<p>Check the queue is empty.</p>",
            "resource-type": "Document::Text",
            sort: 1,
          },
        },
        {
          type: "document-sections",
          attributes: {
            content: "<ol><li>Sign in to the server</li></ol>",
            "rendered-content": "<ol><li>Sign in to the server</li></ol>",
            "resource-type": "Document::Text",
            sort: 0,
          },
        },
        {
          type: "document-sections",
          attributes: {
            content: "Before you start",
            "rendered-content": "Before you start",
            "resource-type": "Document::Heading",
            sort: -1,
          },
        },
      ];

      it("reads the embedded content shape (body under resource), sorted by sort", async () => {
        mockRequest.mockClear();
        const card = await buildDocumentCard({ ...doc, content: embeddedContent }, client as never);
        expect(mockRequest).not.toHaveBeenCalled();
        expect(card?.sections).toEqual([
          { text: "Open Services Find the spooler" },
          { heading: true, text: "Procedure" },
          { text: "Restart the print spooler service." },
        ]);
      });

      it("reads the embedded JSON:API sections shape (kebab-case attributes), sorted by sort", async () => {
        mockRequest.mockClear();
        const card = await buildDocumentCard({ ...doc, sections: embeddedSections }, client as never);
        expect(mockRequest).not.toHaveBeenCalled();
        expect(card?.sections).toEqual([
          { heading: true, text: "Before you start" },
          { text: "Sign in to the server" },
          { text: "Check the queue is empty." },
        ]);
      });

      it("prefers content when both shapes are present", async () => {
        mockRequest.mockClear();
        const card = await buildDocumentCard(
          { ...doc, content: embeddedContent, sections: embeddedSections },
          client as never
        );
        expect(mockRequest).not.toHaveBeenCalled();
        expect(card?.sections[0]).toEqual({ text: "Open Services Find the spooler" });
        expect(card?.sections).toHaveLength(3);
      });

      it("uses sections when content has nothing readable", async () => {
        mockRequest.mockClear();
        const card = await buildDocumentCard(
          {
            ...doc,
            content: [{ resource_type: "Document::Gallery", resource: {}, sort: 0 }],
            sections: embeddedSections,
          },
          client as never
        );
        expect(mockRequest).not.toHaveBeenCalled();
        expect(card?.sections[0]).toEqual({ heading: true, text: "Before you start" });
      });

      it("falls back to rendered-content when content is missing", async () => {
        const card = await buildDocumentCard(
          {
            ...doc,
            sections: [
              {
                type: "document-sections",
                attributes: {
                  "rendered-content": "<p>Rendered only</p>",
                  "resource-type": "Document::Text",
                  sort: 0,
                },
              },
            ],
          },
          client as never
        );
        expect(card?.sections).toEqual([{ text: "Rendered only" }]);
      });

      it("treats other section types as plain text and skips empty ones", async () => {
        const card = await buildDocumentCard(
          {
            ...doc,
            content: [
              { resource_type: "Document::Step", resource: { content: "<p>Step one</p>" }, sort: 0 },
              { resource_type: "Document::Gallery", resource: {}, sort: 1 },
              { resource_type: "Document::Text", resource: { content: "<p> </p>" }, sort: 2 },
            ],
          },
          client as never
        );
        expect(card?.sections).toEqual([{ text: "Step one" }]);
      });

      it("does not fetch for a document whose embedded body is empty", async () => {
        mockRequest.mockClear();
        const card = await buildDocumentCard({ ...doc, content: [] }, client as never);
        expect(mockRequest).not.toHaveBeenCalled();
        expect(card?.sections).toEqual([]);
      });

      it("sorts fetched sections by sort too", async () => {
        const fetching = {
          request: vi.fn(async () => ({
            data: [
              { id: "2", type: "document-sections", content: "<p>Second</p>", resourceType: "Document::Text", sort: 1 },
              { id: "1", type: "document-sections", content: "First", resourceType: "Document::Heading", sort: 0 },
            ],
            meta: { currentPage: 1, nextPage: null, prevPage: null, totalPages: 1, totalCount: 2 },
          })),
        };
        const card = await buildDocumentCard(doc, fetching as never);
        expect(fetching.request).toHaveBeenCalledWith("/documents/9001/relationships/sections", {});
        expect(card?.sections).toEqual([{ heading: true, text: "First" }, { text: "Second" }]);
      });

      it("strips markup and decodes entities exactly once", async () => {
        const card = await buildDocumentCard(
          {
            ...doc,
            content: [
              {
                resource_type: "Document::Text",
                resource: {
                  content:
                    "<script>alert(1)</script><style>p{}</style>" +
                    "<p>Use &lt;b&gt; tags, not &amp;lt;b&amp;gt; &#8212; R&amp;D&nbsp;&#x27;ok&#39;</p>" +
                    "<img src=x onerror=alert(2)>",
                },
                sort: 0,
              },
            ],
          },
          client as never
        );
        const text = card?.sections[0].text;
        expect(text).toBe("Use <b> tags, not &lt;b&gt; — R&D 'ok'");
        expect(text).not.toMatch(/alert|onerror|<img|<script/);
      });
    });

    it("survives section-fetch failures (card is best-effort)", async () => {
      const failing = {
        request: vi.fn(async () => {
          throw new Error("IT Glue 500");
        }),
      };
      const card = await buildDocumentCard(doc, failing as never);
      expect(card).toMatchObject({ id: "9001", sections: [] });
      expect(card?.organization).toBe("Acme Corp");
    });
  });

  describe("get_document result", () => {
    // get_document carries an untrusted-content marker by default (see
    // utils/untrusted-content.ts) — its result is a document body, exactly
    // the free text that module exists to label. These tests are about the
    // _card mechanism, not the marker wrapper, so they opt out of it the
    // same way any strict consumer would, and assert the raw JSON payload.
    beforeEach(() => {
      vi.stubEnv("ITGLUE_UNTRUSTED_MARKERS", "off");
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("attaches _card while leaving the document payload unchanged", async () => {
      mockFetch.mockReset();
      // 1st call: the document itself (with its embedded sectioned body).
      mockFetch.mockReturnValueOnce(
        jsonApiResponse({
          data: {
            id: "9001",
            type: "documents",
            attributes: {
              name: "Server Room Access Runbook",
              "organization-id": 77,
              "organization-name": "Acme Corp",
              "document-folder-id": 12,
              archived: false,
              "created-at": "2026-07-01T09:00:00Z",
              "updated-at": "2026-07-15T17:30:00Z",
              content: [{ content: "<p>Badge in at the rear entrance.</p>" }],
            },
          },
        })
      );

      const client = await connectClient();
      const result = (await client.callTool({
        name: "get_document",
        arguments: { organization_id: 77, id: "9001" },
      })) as { content: Array<{ text: string }>; isError?: boolean };

      expect(result.isError).toBeFalsy();
      expect(mockFetch).toHaveBeenCalledTimes(1); // embedded body → no sections refetch
      // Model-facing content is now a short text summary (SEP-1865
      // content/structuredContent split), not a JSON dump.
      expect(result.content[0].text).toBe(
        'Retrieved document "Server Room Access Runbook".'
      );
      const structured = (result as { structuredContent?: Record<string, unknown> })
        .structuredContent as Record<string, unknown>;
      expect(structured).toBeDefined();
      // Full payload unchanged apart from the additive _card, now carried in
      // structuredContent instead of the content JSON dump.
      expect(structured.name).toBe("Server Room Access Runbook");
      expect(structured.content).toEqual([
        { content: "<p>Badge in at the rear entrance.</p>" },
      ]);
      expect(structured._card).toMatchObject({
        id: "9001",
        name: "Server Room Access Runbook",
        organization: "Acme Corp",
        folder: "#12",
        sections: [{ text: "Badge in at the rear entrance." }],
      });
    });

    it("fills the card from the document's own content and sections (no refetch)", async () => {
      mockFetch.mockReset();
      mockFetch.mockReturnValueOnce(
        jsonApiResponse({
          data: {
            id: "9003",
            type: "documents",
            attributes: {
              name: "Printer Queue Reset",
              "organization-id": 77,
              "organization-name": "Example Org",
              content: [
                {
                  resource_type: "Document::Text",
                  resource: { content: "<ol><li>Stop the spooler</li></ol>" },
                  sort: 1,
                },
                {
                  resource_type: "Document::Heading",
                  resource: { content: "Steps" },
                  sort: 0,
                },
              ],
              sections: [
                {
                  type: "document-sections",
                  attributes: {
                    content: "<ol><li>Stop the spooler</li></ol>",
                    "rendered-content": "<ol><li>Stop the spooler</li></ol>",
                    "resource-type": "Document::Text",
                    sort: 0,
                  },
                },
              ],
            },
          },
        })
      );

      const client = await connectClient();
      const result = (await client.callTool({
        name: "get_document",
        arguments: { organization_id: 77, id: "9003" },
      })) as { structuredContent?: Record<string, unknown>; isError?: boolean };

      expect(result.isError).toBeFalsy();
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.structuredContent?._card).toMatchObject({
        id: "9003",
        sections: [{ heading: true, text: "Steps" }, { text: "Stop the spooler" }],
      });
    });

    it("drops the card (not the result) when the payload is not card-worthy", async () => {
      mockFetch.mockReset();
      // Document with no name → builder returns null → no _card key.
      mockFetch.mockReturnValueOnce(
        jsonApiResponse({
          data: { id: "9002", type: "documents", attributes: {} },
        })
      );
      // Defensive: if the builder tries the sections fallback anyway, don't hang.
      mockFetch.mockReturnValue(jsonApiResponse({ data: [] }));

      const client = await connectClient();
      const result = (await client.callTool({
        name: "get_document",
        arguments: { organization_id: 77, id: "9002" },
      })) as {
        content: Array<{ text: string }>;
        structuredContent?: Record<string, unknown>;
        isError?: boolean;
      };

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.id).toBe("9002");
      expect(structured._card).toBeUndefined();
    });
  });
});
