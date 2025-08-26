// server.js
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import axios from "axios";
import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";
import PPTXGenJS from "pptxgenjs";
import { Document, Packer, Paragraph, TextRun } from "docx";

// ─────────────────────────── App Setup ───────────────────────────
const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(bodyParser.json());

// Files dir
const filesDir = path.join(process.cwd(), "public", "files");
fs.mkdirSync(filesDir, { recursive: true });
app.use("/files", express.static(filesDir));

// ─────────────────────────── Config ───────────────────────────
const PORT = process.env.PORT || 3000;

const NOTION_KEY = process.env.NOTION_KEY || "";
const DOCS_DB = process.env.NOTION_DATABASE_ID || process.env.DOCS_DATABASE_ID || "";
const ROADMAP_DB = process.env.ROADMAP_DATABASE_ID || "";
const TASKS_DB = process.env.TASK_TRACKER_DATABASE_ID || "";
const SEARCH_API_KEY = process.env.SEARCH_API_KEY || "";

const BASE_URL = process.env.BASE_URL || "";
const VERSION = process.env.SOL_VERSION || "v3.2.0";
const SERVER_TOKEN = process.env.SERVER_TOKEN || "";
const AUTO_AUTH = String(process.env.AUTO_AUTH || "true").toLowerCase() === "true";
const STRICT_MODE = String(process.env.STRICT_MODE || "true").toLowerCase() === "true";

// ─────────────────────────── Utils ───────────────────────────
const normId = (s) => String(s || "").replace(/-/g, "").toLowerCase();
const toDashedUuid = (s) => {
  const raw = String(s || "").replace(/-/g, "");
  return /^[0-9a-fA-F]{32}$/.test(raw)
    ? `${raw.slice(0,8)}-${raw.slice(8,12)}-${raw.slice(16,16)}-${raw.slice(16,20)}-${raw.slice(20)}`
    : String(s || "");
};
const safeName = (n) => String(n).replace(/[^\w\\-]+/g, "_").slice(0, 80);
const filePathFor = (n) => path.join(filesDir, n);
const makePublicURL = (req, name) => {
  const base = BASE_URL || `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}`;
  return `${base}/files/${encodeURIComponent(name)}`;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─────────────────────────── Auth Middleware ───────────────────────────
function requireSolAuth(req, res, next) {
  const path = (req.path || "").toLowerCase();
  const tier1 = ["/health", "/whoami", "/find_pages", "/get_page", "/page_blocks", "/page_markdown",
    "/notion_schema", "/notion_raw_props", "/notion_users", "/search_web", "/memory_notes"];

  const tier2 = ["/upsert_page", "/append_task_content", "/generate_document", "/memory_note",
    "/update_fields", "/batch_update_fields", "/replace_page_content", "/delete_page"];

  if (AUTO_AUTH && (tier1.includes(path) || (!STRICT_MODE && tier2.includes(path)))) return next();
  if (!SERVER_TOKEN) return next();

  const tok = req.headers["x-sol-token"] || req.headers["authorization"];
  const bearer = typeof tok === "string" && tok.startsWith("Bearer ") ? tok.slice(7) : tok;
  if (bearer && String(bearer) === String(SERVER_TOKEN)) return next();

  return res.status(401).json({ ok: false, error: "unauthorized" });
}

// ─────────────────────────── Notion Helpers ───────────────────────────
const getDbId = (db) => {
  db = String(db || "").toLowerCase();
  if (["docs", "documents"].includes(db)) return DOCS_DB;
  if (["roadmap", "road"].includes(db)) return ROADMAP_DB;
  if (["tasks", "task", "tracker"].includes(db)) return TASKS_DB;
  return DOCS_DB || TASKS_DB || ROADMAP_DB;
};
const notionHeaders = () => ({
  "Authorization": `Bearer ${NOTION_KEY}`,
  "Content-Type": "application/json",
  "Notion-Version": "2022-06-28",
});

// Retry wrapper
async function doNotion(method, url, opts = {}) {
  let attempt = 0, lastErr;
  while (attempt < 5) {
    try { return await axios({ method, url, ...opts }); }
    catch (err) {
      const status = err?.response?.status;
      if (status === 409 || status === 429) {
        await sleep(Math.min(2000, 250 * 2 ** attempt) + Math.random() * 100);
        attempt++; lastErr = err; continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error("Unknown Notion error");
}

// Build blocks from content object
function buildBlocksFromContent(content) {
  const blocks = [];
  if (!content) return blocks;

  if (content.description) {
    content.description.split(/\\n+/).forEach(p => {
      if (p.trim()) blocks.push({ object: "block", type: "paragraph",
        paragraph: { rich_text: [{ type: "text", text: { content: p } }] } });
    });
  }
  if (Array.isArray(content.blocks)) {
    for (const b of content.blocks) {
      const text = b.text || "";
      const rich_text = [{ type: "text", text: { content: text } }];
      if (["heading_1","heading_2","heading_3","paragraph","bulleted_list_item","numbered_list_item"].includes(b.type))
        blocks.push({ object: "block", type: b.type, [b.type]: { rich_text } });
      if (b.type === "callout")
        blocks.push({ object: "block", type: "callout", callout: { icon: b.icon ? { type: "emoji", emoji: b.icon } : undefined, rich_text } });
      if (b.type === "toggle")
        blocks.push({ object: "block", type: "toggle", toggle: { rich_text } });
      if (b.type === "code")
        blocks.push({ object: "block", type: "code", code: { rich_text, language: b.language || "plain text" } });
    }
  }
  if (Array.isArray(content.subtasks)) {
    for (const it of content.subtasks) {
      blocks.push({ object: "block", type: "to_do", to_do: { rich_text: [{ type: "text", text: { content: it.text } }], checked: !!it.checked } });
    }
  }
  if (Array.isArray(content.files)) {
    for (const f of content.files) {
      const url = typeof f === "string" ? f : f.url || f.href || f.external?.url;
      if (url) blocks.push({ object: "block", type: "file", file: { type: "external", external: { url } } });
    }
  }
  return blocks;
}
const appendBlocks = (headers, pageId, blocks) =>
  doNotion("patch", `https://api.notion.com/v1/blocks/${pageId}/children`, { headers, data: { children: blocks } });

// Health check
app.get("/health", (req, res) => {
  const base = BASE_URL || `${req.protocol}://${req.get("host")}`;
  res.json({
    ok: true,
    service: "sol-v3-agent",
    version: VERSION,
    base_url: base,
    notion: NOTION_KEY ? "configured" : "not_configured",
    notion_databases: {
      docs: !!DOCS_DB,
      roadmap: !!ROADMAP_DB,
      tasks: !!TASKS_DB,
    },
    search: SEARCH_API_KEY ? "configured" : "not_configured",
    auth: SERVER_TOKEN ? "protected" : "open",
  });
});

// Whoami
app.get("/whoami", (req, res) => {
  res.json({ ok: true, ip: req.ip, headers: req.headers });
});

// Find pages (single merged version with filters + pagination)
app.post("/find_pages", requireSolAuth, async (req, res) => {
  try {
    const dbId = getDbId(req.body?.db);
    if (!NOTION_KEY || !dbId) {
      return res.json({ ok: true, simulating: true, db: req.body?.db, database_id: dbId });
    }

    const headers = notionHeaders();
    const { page_size = 25, start_cursor, filter = {}, sort } = req.body || {};

    const queryPayload = { page_size: Math.min(100, page_size) };
    if (start_cursor) queryPayload.start_cursor = start_cursor;
    if (filter && Object.keys(filter).length) queryPayload.filter = filter;
    if (sort) queryPayload.sorts = sort;

    const resp = await doNotion("post", `https://api.notion.com/v1/databases/${dbId}/query`, {
      headers,
      data: queryPayload,
    });

    const results =
      resp.data?.results.map((p) => ({
        id: p.id,
        title: Object.values(p.properties)
          .find((x) => x.type === "title")
          ?.title?.map((t) => t.plain_text)
          .join(""),
        properties: p.properties,
        last_edited_time: p.last_edited_time,
        created_time: p.created_time,
      })) || [];

    res.json({
      ok: true,
      db: req.body?.db,
      database_id: dbId,
      results,
      has_more: resp.data?.has_more,
      next_cursor: resp.data?.next_cursor,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Get page
app.get("/get_page", requireSolAuth, async (req, res) => {
  try {
    const pageId = req.query.page_id;
    const headers = notionHeaders();
    const resp = await doNotion("get", `https://api.notion.com/v1/pages/${pageId}`, { headers });
    res.json({ ok: true, page_id: pageId, properties: resp.data?.properties });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Page blocks
app.get("/page_blocks", requireSolAuth, async (req, res) => {
  try {
    const pageId = req.query.page_id;
    const headers = notionHeaders();
    const resp = await doNotion("get", `https://api.notion.com/v1/blocks/${pageId}/children`, { headers });
    res.json({ ok: true, page_id: pageId, blocks: resp.data?.results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Page markdown
app.get("/page_markdown", requireSolAuth, async (req, res) => {
  try {
    const pageId = req.query.page_id;
    const headers = notionHeaders();
    const children = await doNotion("get", `https://api.notion.com/v1/blocks/${pageId}/children`, { headers });
    const lines = [];
    for (const b of children.data?.results || []) {
      const text = (b[b.type]?.rich_text || []).map((x) => x.plain_text).join("");
      if (b.type === "heading_1") lines.push(`# ${text}`);
      else if (b.type === "heading_2") lines.push(`## ${text}`);
      else if (b.type === "heading_3") lines.push(`### ${text}`);
      else if (b.type === "bulleted_list_item") lines.push(`- ${text}`);
      else if (b.type === "numbered_list_item") lines.push(`1. ${text}`);
      else if (b.type === "to_do") lines.push(`- [${b.to_do?.checked ? "x" : " "}] ${text}`);
      else if (b.type === "paragraph") lines.push(text);
    }
    res.json({ ok: true, page_id: pageId, markdown: lines.join("\n") });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Append content
app.post("/append_task_content", requireSolAuth, async (req, res) => {
  try {
    const { page_id, content } = req.body;
    const headers = notionHeaders();
    const blocks = buildBlocksFromContent(content);
    if (blocks.length) await appendBlocks(headers, page_id, blocks);
    res.json({ ok: true, page_id, appended: blocks.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Replace page content
app.post("/replace_page_content", requireSolAuth, async (req, res) => {
  try {
    const { page_id, content } = req.body;
    const headers = notionHeaders();
    const children = await doNotion("get", `https://api.notion.com/v1/blocks/${page_id}/children`, { headers });
    for (const b of children.data?.results || []) {
      await doNotion("delete", `https://api.notion.com/v1/blocks/${b.id}`, { headers });
    }
    const blocks = buildBlocksFromContent(content);
    if (blocks.length) await appendBlocks(headers, page_id, blocks);
    res.json({ ok: true, page_id, replaced: blocks.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Upsert page
app.post("/upsert_page", requireSolAuth, async (req, res) => {
  try {
    const { db, page_id, title, fields, properties, content } = req.body || {};
    const dbId = getDbId(db);
    const headers = notionHeaders();

    const data = { parent: { database_id: dbId }, properties: {} };

    if (title) {
      const schemaResp = await doNotion("get", `https://api.notion.com/v1/databases/${dbId}`, { headers });
      const schema = schemaResp.data?.properties || {};
      const titleKey = Object.keys(schema).find((k) => schema[k].type === "title");
      if (titleKey) data.properties[titleKey] = { title: [{ text: { content: title } }] };
    }

    const f = fields || properties || {};
    for (const [k, v] of Object.entries(f)) {
      data.properties[k] = { rich_text: [{ text: { content: String(v) } }] };
    }

    let resp;
    if (page_id) {
      resp = await doNotion("patch", `https://api.notion.com/v1/pages/${page_id}`, { headers, data: { properties: data.properties } });
    } else {
      resp = await doNotion("post", `https://api.notion.com/v1/pages`, { headers, data });
    }

    if (content) {
      const blocks = buildBlocksFromContent(content);
      if (blocks.length) await appendBlocks(headers, resp.data.id, blocks);
    }

    res.json({ ok: true, page_id: resp.data.id, mode: page_id ? "update" : "create" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Helper to build Notion property values for update_fields
async function buildPropertyValue(props, headers, key, value) {
  const p = props[key];
  if (!p) return { value: null };

  switch (p.type) {
    case "title":
      return { value: { title: [{ text: { content: String(value) } }] } };
    case "rich_text":
      return { value: { rich_text: [{ text: { content: String(value) } }] } };
    case "number":
      return { value: { number: Number(value) } };
    case "checkbox":
      return { value: { checkbox: Boolean(value) } };
    case "date":
      return { value: { date: { start: String(value) } } };
    case "select":
      return { value: { select: { name: String(value) } } };
    case "multi_select":
      return { value: { multi_select: Array.isArray(value) ? value.map((v) => ({ name: String(v) })) : [{ name: String(value) }] } };
    case "status":
      return { value: { status: { name: String(value) } } };
    case "relation":
      return { value: { relation: Array.isArray(value) ? value.map((id) => ({ id })) : [{ id: String(value) }] } };
    default:
      return { value: null };
  }
}

// Update fields
app.post("/update_fields", requireSolAuth, async (req, res) => {
  try {
    const { db, page_id, fields, properties } = req.body;
    const dbId = getDbId(db);
    const headers = notionHeaders();
    const schemaResp = await doNotion("get", `https://api.notion.com/v1/databases/${dbId}`, { headers });
    const props = schemaResp.data?.properties || {};

    const updates = fields || properties || {};
    const propertiesPayload = {};
    for (const [k, v] of Object.entries(updates)) {
      const built = await buildPropertyValue(props, headers, k, v);
      if (built.value) propertiesPayload[k] = built.value;
    }

    const resp = await doNotion("patch", `https://api.notion.com/v1/pages/${page_id}`, {
      headers,
      data: { properties: propertiesPayload },
    });

    res.json({ ok: true, page_id, updated: Object.keys(propertiesPayload) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Batch update fields
app.post("/batch_update_fields", requireSolAuth, async (req, res) => {
  try {
    const { db, updates } = req.body;
    const dbId = getDbId(db);
    const headers = notionHeaders();
    const schemaResp = await doNotion("get", `https://api.notion.com/v1/databases/${dbId}`, { headers });
    const props = schemaResp.data?.properties || {};

    const results = [];
    for (const u of updates) {
      const pageId = u.page_id;
      const f = u.fields || u.properties || {};
      const propertiesPayload = {};
      for (const [k, v] of Object.entries(f)) {
        const built = await buildPropertyValue(props, headers, k, v);
        if (built.value) propertiesPayload[k] = built.value;
      }
      if (Object.keys(propertiesPayload).length) {
        await doNotion("patch", `https://api.notion.com/v1/pages/${pageId}`, {
          headers,
          data: { properties: propertiesPayload },
        });
        results.push({ page_id: pageId, updated: Object.keys(propertiesPayload) });
      }
    }

    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Memory note (write)
app.post("/memory_note", requireSolAuth, async (req, res) => {
  try {
    const { title, topic, content } = req.body || {};
    const dbId = getDbId("docs");
    const headers = notionHeaders();

    const schemaResp = await doNotion("get", `https://api.notion.com/v1/databases/${dbId}`, { headers });
    const schema = schemaResp.data?.properties || {};
    const titleKey = Object.keys(schema).find((k) => schema[k].type === "title");

    const data = {
      parent: { database_id: dbId },
      properties: {},
    };

    if (titleKey) data.properties[titleKey] = { title: [{ text: { content: title || topic || "Memory Note" } }] };
    if (topic && schema["Topic"])
      data.properties["Topic"] = { rich_text: [{ text: { content: topic } }] };

    const resp = await doNotion("post", `https://api.notion.com/v1/pages`, { headers, data });

    if (content) {
      const blocks = buildBlocksFromContent(content);
      if (blocks.length) await appendBlocks(headers, resp.data.id, blocks);
    }

    res.json({ ok: true, page_id: resp.data.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Memory notes (read by topic)
app.get("/memory_notes", requireSolAuth, async (req, res) => {
  try {
    const dbId = getDbId("docs");
    const headers = notionHeaders();
    const topic = req.query.topic;

    const filter = topic ? { filter: { property: "Topic", rich_text: { contains: topic } } } : {};
    const resp = await doNotion("post", `https://api.notion.com/v1/databases/${dbId}/query`, { headers, data: filter });

    res.json({ ok: true, results: resp.data?.results || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Memory pack export
app.get("/memory_pack_export", requireSolAuth, async (req, res) => {
  try {
    const dbId = getDbId("docs");
    const headers = notionHeaders();
    const { topic, format = "docx" } = req.query;

    // Query notes
    const filter = topic ? { filter: { property: "Topic", rich_text: { contains: topic } } } : {};
    const resp = await doNotion("post", `https://api.notion.com/v1/databases/${dbId}/query`, { headers, data: filter });
    const notes = resp.data?.results || [];

    // Extract plain text
    const items = notes.map((n) => {
      const title = Object.values(n.properties)
        .find((x) => x.type === "title")
        ?.title?.map((t) => t.plain_text)
        .join("") || "Untitled";
      return `## ${title}`;
    });

    if (!items.length) return res.json({ ok: true, count: 0, message: "No memory notes found" });

    const safe = safeName(topic ? `memory_pack_${topic}` : "memory_pack_all");
    const filePath = filePathFor(`${safe}.${format}`);
    const url = makePublicURL(req, `${safe}.${format}`);

    if (format === "docx") {
      const doc = new Document({
        sections: [
          {
            children: items.map((t) => new Paragraph({ children: [new TextRun(t)] })),
          },
        ],
      });
      const buffer = await Packer.toBuffer(doc);
      fs.writeFileSync(filePath, buffer);
    } else if (format === "md") {
      fs.writeFileSync(filePath, items.join("\n\n"));
    } else {
      return res.status(400).json({ ok: false, error: "unsupported_format" });
    }

    res.json({ ok: true, count: items.length, format, doc_url: url });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Memory delete
app.post("/memory_delete", requireSolAuth, async (req, res) => {
  try {
    const { page_id } = req.body;
    if (!page_id) return res.status(400).json({ ok: false, error: "missing_page_id" });

    const headers = notionHeaders();
    await doNotion("patch", `https://api.notion.com/v1/pages/${page_id}`, {
      headers,
      data: { archived: true }
    });

    res.json({ ok: true, page_id, deleted: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Generate document
app.post("/generate_document", requireSolAuth, async (req, res) => {
  try {
    const { title, content, format } = req.body || {};
    if (!title || !content || !format) return res.status(400).json({ ok: false, error: "missing_inputs" });

    const safe = safeName(title);
    const filePath = filePathFor(`${safe}.${format}`);
    const url = makePublicURL(req, `${safe}.${format}`);

    if (format === "pdf") {
      const doc = new PDFDocument();
      doc.pipe(fs.createWriteStream(filePath));
      doc.text(content);
      doc.end();
    } else if (format === "pptx") {
      const pptx = new PPTXGenJS();
      const slide = pptx.addSlide();
      slide.addText(content, { x: 1, y: 1, fontSize: 18, color: "363636" });
      await pptx.writeFile(filePath);
    } else if (format === "docx") {
      const doc = new Document({
        sections: [{ children: [new Paragraph({ children: [new TextRun(content)] })] }],
      });
      const buffer = await Packer.toBuffer(doc);
      fs.writeFileSync(filePath, buffer);
    } else if (format === "md") {
      fs.writeFileSync(filePath, content);
    } else {
      return res.status(400).json({ ok: false, error: "unsupported_format" });
    }

    res.json({ ok: true, title, format, doc_url: url });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Delete page
app.post("/delete_page", requireSolAuth, async (req, res) => {
  try {
    const { page_id } = req.body;
    const headers = notionHeaders();
    if (!page_id) return res.status(400).json({ ok: false, error: "missing_page_id" });

    await doNotion("patch", `https://api.notion.com/v1/pages/${page_id}`, {
      headers,
      data: { archived: true },
    });

    res.json({ ok: true, page_id, deleted: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Notion schema
app.get("/notion_schema", requireSolAuth, async (req, res) => {
  try {
    const dbId = getDbId(req.query.db);
    const headers = notionHeaders();
    const resp = await doNotion("get", `https://api.notion.com/v1/databases/${dbId}`, { headers });
    res.json({ ok: true, db: req.query.db, schema: resp.data?.properties });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Notion raw props
app.get("/notion_raw_props", requireSolAuth, async (req, res) => {
  try {
    const dbId = getDbId(req.query.db);
    const headers = notionHeaders();
    const resp = await doNotion("get", `https://api.notion.com/v1/databases/${dbId}`, { headers });
    res.json({ ok: true, raw: resp.data?.properties });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Notion users
app.get("/notion_users", requireSolAuth, async (req, res) => {
  try {
    const headers = notionHeaders();
    const resp = await doNotion("get", `https://api.notion.com/v1/users`, { headers });
    res.json({ ok: true, users: resp.data?.results || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Notion test create
app.post("/notion_test_create", requireSolAuth, async (req, res) => {
  try {
    const { db, title } = req.body || {};
    const dbId = getDbId(db);
    const headers = notionHeaders();
    const schemaResp = await doNotion("get", `https://api.notion.com/v1/databases/${dbId}`, { headers });
    const schema = schemaResp.data?.properties || {};
    const titleKey = Object.keys(schema).find((k) => schema[k].type === "title");

    const data = { parent: { database_id: dbId }, properties: {} };
    if (titleKey) data.properties[titleKey] = { title: [{ text: { content: title || "Sol v3 Health Check" } }] };

    const resp = await doNotion("post", `https://api.notion.com/v1/pages`, { headers, data });
    res.json({ ok: true, db, page_id: resp.data.id, title: title || "Sol v3 Health Check" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Search web
app.post("/search_web", async (req, res) => {
  try {
    const { query, recency_days } = req.body || {};
    if (!SEARCH_API_KEY) return res.json({ ok: true, simulating: true, results: [] });
    // Here you’d implement a real search API if you connect one
    res.json({ ok: true, simulating: true, query, recency_days, results: [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Serve OpenAPI schema directly
app.get("/openapi.json", (req, res) => {
  res.sendFile(path.join(process.cwd(), "openapi.json"));
});

// ─────────────────────────── Boot ───────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Sol v3 agent v${VERSION} running at http://localhost:${PORT}`);
});