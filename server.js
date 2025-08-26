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

// ─────────────────────────── App & Static ───────────────────────────
const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(bodyParser.json());

// Serve generated files from ./public/files
const filesDir = path.join(process.cwd(), "public", "files");
fs.mkdirSync(filesDir, { recursive: true });
app.use("/files", express.static(filesDir));

// ─────────────────────────── Config ───────────────────────────
const PORT = process.env.PORT || 3000;

// Support NOTION_KEY and NOTION-KEY, plus 3 DB ids
const NOTION_KEY = process.env.NOTION_KEY || process.env["NOTION-KEY"] || "";
const NOTION_DATABASE_ID =
  process.env.NOTION_DATABASE_ID || process.env.DOCS_DATABASE_ID || "";
const ROADMAP_DATABASE_ID = process.env.ROADMAP_DATABASE_ID || "";
const TASK_TRACKER_DATABASE_ID = process.env.TASK_TRACKER_DATABASE_ID || "";
const SEARCH_API_KEY = process.env.SEARCH_API_KEY || "";

const BASE_URL = process.env.BASE_URL || "";
const VERSION = process.env.SOL_VERSION || "v3.1.0";
const SERVER_TOKEN = process.env.SERVER_TOKEN || ""; // when set, mutating routes require this

// ─────────────────────────── Tiny Utils ───────────────────────────
function normId(s) {
  return String(s || "").replace(/-/g, "").toLowerCase();
}
function toDashedUuid(s) {
  const raw = String(s || "").replace(/-/g, "");
  if (/^[0-9a-fA-F]{32}$/.test(raw)) {
    return `${raw.slice(0,8)}-${raw.slice(8,12)}-${raw.slice(12,16)}-${raw.slice(16,20)}-${raw.slice(20)}`;
  }
  return String(s || "");
}
function safeName(name) {
  return String(name).replace(/[^\w\-]+/g, "_").slice(0, 80);
}
function filePathFor(fileName) {
  return path.join(filesDir, fileName);
}
function makePublicURL(req, fileName) {
  const base =
    BASE_URL ||
    `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}`;
  return `${base}/files/${encodeURIComponent(fileName)}`;
}

// Optional auth for mutating routes
function requireSolAuth(req, res, next) {
  if (!SERVER_TOKEN) return next(); // open mode
  const tok = req.headers["x-sol-token"] || req.headers["authorization"];
  const bearer = typeof tok === "string" && tok.startsWith("Bearer ") ? tok.slice(7) : tok;
  if (bearer && String(bearer) === String(SERVER_TOKEN)) return next();
  return res.status(401).json({ ok: false, error: "unauthorized" });
}

function getNotionDbId(dbKey) {
  const key = String(dbKey || "").toLowerCase();
  if (key === "docs" || key === "documents" || key === "document") return NOTION_DATABASE_ID || "";
  if (key === "roadmap" || key === "road") return ROADMAP_DATABASE_ID || "";
  if (key === "tasks" || key === "task" || key === "tracker") return TASK_TRACKER_DATABASE_ID || "";
  return NOTION_DATABASE_ID || TASK_TRACKER_DATABASE_ID || ROADMAP_DATABASE_ID || "";
}

function notionHeaders() {
  return {
    "Authorization": `Bearer ${NOTION_KEY}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28",
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Generic Notion call with retry/backoff for 409/429
async function doNotion(method, url, { headers, data, params } = {}) {
  let attempt = 0;
  const max = 5;
  let lastErr;
  while (attempt < max) {
    try {
      return await axios({ method, url, headers, data, params });
    } catch (err) {
      const status = err?.response?.status;
      if (status === 409 || status === 429) {
        const wait = Math.min(2000, 250 * Math.pow(2, attempt)) + Math.floor(Math.random() * 100);
        await sleep(wait);
        attempt++;
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error("Unknown Notion error");
}

// ─────────────────────────── Notion Helpers ───────────────────────────
async function resolveTitleToId(dbId, headers, titleStr) {
  try {
    const schema = await doNotion("get", `https://api.notion.com/v1/databases/${dbId}`, { headers });
    let titleProp = null;
    for (const [k, v] of Object.entries(schema.data?.properties || {})) {
      if (v.type === "title") { titleProp = k; break; }
    }
    if (!titleProp) return null;

    // exact
    let q = await doNotion("post", `https://api.notion.com/v1/databases/${dbId}/query`, {
      headers,
      data: { filter: { property: titleProp, title: { equals: titleStr } }, page_size: 1 }
    });
    let match = (q.data?.results || [])[0];

    // contains
    if (!match) {
      q = await doNotion("post", `https://api.notion.com/v1/databases/${dbId}/query`, {
        headers,
        data: { filter: { property: titleProp, title: { contains: titleStr } }, page_size: 5 }
      });
      match = (q.data?.results || [])[0];
    }

    // global search filtered to db
    if (!match) {
      const s = await doNotion("post", "https://api.notion.com/v1/search", {
        headers,
        data: {
          query: titleStr,
          filter: { property: "object", value: "page" },
          sort: { direction: "descending", timestamp: "last_edited_time" }
        }
      });
      const candidates = (s.data?.results || []).filter(p => {
        const pid = p?.parent?.database_id;
        return pid && normId(pid) === normId(dbId);
      });
      for (const p of candidates) {
        const tRich = p.properties?.[titleProp]?.title || [];
        const t = (tRich.map(x => x?.plain_text || "").join("") || "").trim();
        if (t.toLowerCase() === String(titleStr).toLowerCase()) { match = p; break; }
      }
      if (!match && candidates.length) match = candidates[0];
    }
    return match?.id || null;
  } catch {
    return null;
  }
}

async function listAllUsers(headers) {
  const byEmail = new Map();
  const byId = new Map();
  let next = undefined;
  for (let i = 0; i < 10; i++) {
    const url = next ? `https://api.notion.com/v1/users?start_cursor=${encodeURIComponent(next)}` : "https://api.notion.com/v1/users";
    const resp = await doNotion("get", url, { headers });
    const results = resp.data?.results || [];
    results.forEach(u => {
      if (u.id) byId.set(u.id, u);
      const email = u?.person?.email;
      if (email) byEmail.set(email.toLowerCase(), u);
    });
    if (resp.data?.has_more && resp.data?.next_cursor) next = resp.data.next_cursor; else break;
  }
  return { byEmail, byId };
}

function buildBlocksFromContent(content) {
  const blocks = [];
  if (!content) return blocks;

  // description → paragraphs
  if (typeof content.description === "string" && content.description.trim()) {
    const parts = content.description.split(/\n+/).filter((s) => s.trim().length);
    parts.forEach((p) =>
      blocks.push({
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [{ type: "text", text: { content: p } }] },
      })
    );
  }

  // explicit blocks
  if (Array.isArray(content.blocks)) {
    for (const b of content.blocks) {
      if (!b || typeof b !== "object") continue;
      const text = (b.text ?? "").toString();
      const rich_text = [{ type: "text", text: { content: text } }];
      switch (b.type) {
        case "heading_1":
        case "heading_2":
        case "heading_3":
          blocks.push({ object: "block", type: b.type, [b.type]: { rich_text } });
          break;
        case "bulleted_list_item":
        case "numbered_list_item":
        case "paragraph":
          blocks.push({ object: "block", type: b.type, [b.type]: { rich_text } });
          break;
        case "callout":
          blocks.push({
            object: "block",
            type: "callout",
            callout: {
              icon: b.icon ? { type: "emoji", emoji: String(b.icon) } : undefined,
              rich_text,
            },
          });
          break;
        case "toggle":
          blocks.push({ object: "block", type: "toggle", toggle: { rich_text } });
          break;
        case "code":
          blocks.push({
            object: "block",
            type: "code",
            code: { rich_text, language: b.language || "plain text" },
          });
          break;
        default:
          break;
      }
    }
  }

  // to-do subtasks
  if (Array.isArray(content.subtasks)) {
    for (const it of content.subtasks) {
      if (!it || !it.text) continue;
      blocks.push({
        object: "block",
        type: "to_do",
        to_do: {
          rich_text: [{ type: "text", text: { content: String(it.text) } }],
          checked: Boolean(it.checked),
        },
      });
    }
  }

  // external files
  if (Array.isArray(content.files)) {
    const inferName = (u) => {
      try {
        const wq = String(u).split("?")[0];
        const seg = wq.split("/").filter(Boolean).pop() || "file";
        return seg.slice(0, 100);
      } catch { return "file"; }
    };
    for (const f of content.files) {
      let url = null; let name = null;
      if (typeof f === "string") { url = f; name = inferName(f); }
      else if (f && typeof f === "object") {
        url = f.url || f.href || (f.external && f.external.url) || null;
        name = f.name || (url ? inferName(url) : null);
      }
      if (url) {
        blocks.push({ object: "block", type: "file", file: { type: "external", external: { url } } });
        if (name) {
          blocks.push({
            object: "block",
            type: "paragraph",
            paragraph: { rich_text: [{ type: "text", text: { content: name }, annotations: { italic: true } }] },
          });
        }
      }
    }
  }

  return blocks;
}

async function appendBlocks(headers, pageId, blocks) {
  const url = `https://api.notion.com/v1/blocks/${pageId}/children`;
  return doNotion("patch", url, { headers, data: { children: blocks } });
}


// ─────────────────────────── Request Logging (debug) ───────────────────────────
app.use((req, _res, next) => {
  try {
    const ua = req.get("user-agent") || "";
    const ip = req.ip;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ip=${ip} ua="${ua}"`);
  } catch (_) { /* ignore */ }
  next();
});

// ─────────────────────────── Endpoints ───────────────────────────

// Generate DOC/PPT/PDF/MD
app.post("/generate_document", requireSolAuth, async (req, res) => {
  try {
    const { title, content, format } = req.body;
    if (!title || !content || !format) {
      return res.status(400).json({ ok: false, error: "Missing required fields" });
    }

    const safeTitle = safeName(title);
    let filePath, fileName;

    if (format === "pdf") {
      fileName = `${safeTitle}.pdf`;
      filePath = filePathFor(fileName);
      const doc = new PDFDocument({ margin: 48 });
      doc.pipe(fs.createWriteStream(filePath));
      doc.fontSize(22).text(title, { align: "center" });
      doc.moveDown();
      doc.fontSize(12).text(content);
      doc.end();
    } else if (format === "pptx") {
      fileName = `${safeTitle}.pptx`;
      filePath = filePathFor(fileName);
      const pptx = new PPTXGenJS();
      const slides = String(content).split(/(?:^|\n)###\s*/).filter(Boolean);
      slides.forEach((slideText) => {
        const slide = pptx.addSlide();
        slide.addText(slideText.trim(), { x: 0.5, y: 0.5, fontSize: 18 });
      });
      await pptx.writeFile({ fileName: filePath });
    } else if (format === "docx") {
      fileName = `${safeTitle}.docx`;
      filePath = filePathFor(fileName);
      const lines = String(content).split(/\n+/);
      const paragraphs = lines.map((line) =>
        new Paragraph({ children: [new TextRun(String(line))] })
      );
      const docx = new Document({ sections: [{ properties: {}, children: paragraphs }] });
      const buffer = await Packer.toBuffer(docx);
      fs.writeFileSync(filePath, buffer);
    } else if (format === "md") {
      fileName = `${safeTitle}.md`;
      filePath = filePathFor(fileName);
      fs.writeFileSync(filePath, content);
    } else {
      return res.status(400).json({ ok: false, error: "Unsupported format" });
    }

    return res.status(200).json({
      ok: true,
      doc_url: makePublicURL(req, path.basename(filePath)),
      title,
      format
    });
  } catch (err) {
    console.error("Document generation failed:", err);
    res.status(500).json({ ok: false, error: "Failed to generate document" });
  }
});

// Update/create a simple task (kept for compatibility)
app.post("/update_task", requireSolAuth, async (req, res) => {
  try {
    const { title, status, notes, task_id } = req.body;
    const dbSelector = (req.query?.db || req.body?.db || "").toString().toLowerCase();
    const targetDatabaseId = getNotionDbId(dbSelector);

    if (!title || !status) {
      return res.status(400).json({ ok: false, error: "Missing required fields" });
    }
    if (!NOTION_KEY || !targetDatabaseId) {
      return res.status(200).json({
        ok: true, simulating: true, db: dbSelector || "auto",
        database_id: targetDatabaseId || null, task_id: task_id || "SIMULATED_TASK_ID",
        title, status, notes: notes || ""
      });
    }

    const headers = notionHeaders();

    // detect prop names
    let titlePropName = null;
    let statusPropName = null;
    let notesPropName = null;
    try {
      const schemaResp = await doNotion("get", `https://api.notion.com/v1/databases/${targetDatabaseId}`, { headers });
      const props = schemaResp.data?.properties || {};
      for (const [k, v] of Object.entries(props)) {
        if (v.type === "title") { titlePropName = k; break; }
      }
      let firstSelect = null;
      for (const [k, v] of Object.entries(props)) {
        if (v.type === "status" && !statusPropName) statusPropName = k;
        if (k.toLowerCase() === "status") statusPropName = k;
        if (v.type === "select" && !firstSelect) firstSelect = k;
      }
      if (!statusPropName && firstSelect) statusPropName = firstSelect;
      let firstRich = null;
      for (const [k, v] of Object.entries(props)) {
        if (v.type === "rich_text" && !firstRich) firstRich = k;
      }
      if (!notesPropName && firstRich) notesPropName = firstRich;
    } catch (e) {
      console.warn("Schema fetch failed; falling back to defaults:", e?.response?.status || e.message);
    }
    if (!titlePropName) {
      return res.status(400).json({ ok: false, error: "No title property found in database" });
    }

    const properties = {};
    properties[titlePropName] = { title: [{ text: { content: title } }] };

    if (status && statusPropName) {
      try {
        const schemaResp2 = await doNotion("get", `https://api.notion.com/v1/databases/${targetDatabaseId}`, { headers });
        const propDef = schemaResp2.data?.properties?.[statusPropName];
        if (propDef && (propDef.type === "select" || propDef.type === "status")) {
          const options = (propDef.select?.options || propDef.status?.options || []).map(o => o.name);
          const hasOption = options.some(o => (o || "").toLowerCase() === status.toLowerCase());
          if (hasOption) {
            properties[statusPropName] = propDef.type === "status"
              ? { status: { name: status } }
              : { select: { name: status } };
          } else {
            console.warn(`Skipping status '${status}' – not found in options for ${statusPropName}`);
            req._sol_status_skipped = { requested: status, property: statusPropName, available: options };
          }
        }
      } catch {
        /* ignore */
      }
    }

    if (notes && notesPropName) {
      properties[notesPropName] = { rich_text: [{ text: { content: notes } }] };
    }

    const payload = { parent: { database_id: targetDatabaseId }, properties };
    const createResp = await doNotion("post", "https://api.notion.com/v1/pages", { headers, data: payload });
    res.status(200).json({
      ok: true,
      db: dbSelector || "auto",
      database_id: targetDatabaseId,
      task_id: createResp.data.id,
      title,
      status: status || null,
      used_props: { title: titlePropName, status: status ? statusPropName : null, notes: notes ? notesPropName : null },
      status_skipped: req._sol_status_skipped || null
    });
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    console.error("Notion update failed:", status, data || err.message);
    res.status(500).json({ ok: false, error: "Failed to update task", status, details: data || err.message });
  }
});

// Debug: DB schema (types + options)
app.get("/notion_schema", async (req, res) => {
  try {
    const dbSelector = (req.query?.db || "").toString().toLowerCase();
    const targetDatabaseId = getNotionDbId(dbSelector);
    if (!NOTION_KEY || !targetDatabaseId) {
      return res.status(200).json({
        ok: true, simulating: true, db: dbSelector || "auto",
        database_id: targetDatabaseId || null,
        note: "Provide NOTION_KEY and a valid database id to fetch schema."
      });
    }
    const headers = notionHeaders();
    const schemaResp = await doNotion("get", `https://api.notion.com/v1/databases/${targetDatabaseId}`, { headers });
    const data = schemaResp.data;

    const props = Object.fromEntries(
      Object.entries(data.properties || {}).map(([k, v]) => {
        const base = { type: v.type };
        if (v.type === "status") base.options = (v.status?.options || []).map(o => o.name);
        else if (v.type === "select") base.options = (v.select?.options || []).map(o => o.name);
        return [k, base];
      })
    );
    res.status(200).json({ ok: true, db: dbSelector || "auto", database_id: targetDatabaseId, title_property: data.title, properties: props });
  } catch (err) {
    const status = err?.response?.status; const data = err?.response?.data;
    res.status(500).json({ ok: false, error: "Failed to get schema", status, details: data || err.message });
  }
});

// Debug: Raw props
app.get("/notion_raw_props", async (req, res) => {
  try {
    const dbSelector = (req.query?.db || "").toString().toLowerCase();
    const targetDatabaseId = getNotionDbId(dbSelector);
    if (!NOTION_KEY || !targetDatabaseId) {
      return res.status(200).json({ ok: true, simulating: true, db: dbSelector || "auto", database_id: targetDatabaseId || null });
    }
    const headers = notionHeaders();
    const schemaResp = await doNotion("get", `https://api.notion.com/v1/databases/${targetDatabaseId}`, { headers });
    res.status(200).json({ ok: true, db: dbSelector || "auto", database_id: targetDatabaseId, raw_properties: schemaResp.data.properties || {} });
  } catch (err) {
    const status = err?.response?.status; const data = err?.response?.data;
    res.status(500).json({ ok: false, error: "Failed to fetch raw props", status, details: data || err.message });
  }
});

// Debug: list Notion users
app.get("/notion_users", async (_req, res) => {
  try {
    if (!NOTION_KEY) return res.status(200).json({ ok: true, simulating: true, note: "Set NOTION_KEY to fetch users." });
    const headers = notionHeaders();
    const idx = await listAllUsers(headers);
    const users = [];
    idx.byId.forEach((u, id) => users.push({ id, name: u?.name || null, email: u?.person?.email || null }));
    res.status(200).json({ ok: true, users });
  } catch (err) {
    const status = err?.response?.status; const data = err?.response?.data;
    res.status(500).json({ ok: false, error: "Failed to list users", status, details: data || err.message });
  }
});

// Debug: create simple page
app.post("/notion_test_create", requireSolAuth, async (req, res) => {
  try {
    const dbSelector = (req.query?.db || req.body?.db || "").toString().toLowerCase();
    const targetDatabaseId = getNotionDbId(dbSelector);
    const title = (req.body?.title || "Sol v3 Health Check").toString();
    if (!NOTION_KEY || !targetDatabaseId) {
      return res.status(200).json({
        ok: true, simulating: true, db: dbSelector || "auto",
        database_id: targetDatabaseId || null,
        note: "Provide NOTION_KEY and a valid database id to create a page."
      });
    }
    const headers = notionHeaders();

    let titlePropName = null;
    try {
      const schemaResp = await doNotion("get", `https://api.notion.com/v1/databases/${targetDatabaseId}`, { headers });
      const props = schemaResp.data?.properties || {};
      for (const [k, v] of Object.entries(props)) if (v.type === "title") { titlePropName = k; break; }
    } catch { /* ignore */ }

    if (!titlePropName) {
      return res.status(400).json({ ok: false, error: "No title property found; cannot create test page" });
    }

    const payload = { parent: { database_id: targetDatabaseId }, properties: { [titlePropName]: { title: [{ text: { content: title } }] } } };
    const createResp = await doNotion("post", "https://api.notion.com/v1/pages", { headers, data: payload });
    res.status(200).json({ ok: true, db: dbSelector || "auto", database_id: targetDatabaseId, task_id: createResp.data.id, title, used_props: { title: titlePropName } });
  } catch (err) {
    const status = err?.response?.status; const data = err?.response?.data;
    res.status(500).json({ ok: false, error: "Failed test create", status, details: data || err.message });
  }
});

// Flexible upsert (create/update) with field normalization + content append
app.post("/upsert_page", requireSolAuth, async (req, res) => {
  try {
    const dbSelector = (req.query?.db || req.body?.db || "").toString().toLowerCase();
    const targetDatabaseId = getNotionDbId(dbSelector);
    let pageId = (req.body?.page_id || "").toString().trim() || null;
    const title = req.body?.title;
    const fields = req.body?.fields || req.body?.properties || {};

    // Shim: allow properties to ride inside content.meta (to bypass strict action validators)
    // If present, merge content.meta → fields unless key already provided explicitly.
    const __incomingContent = req.body?.content || null;
    if (__incomingContent && __incomingContent.meta && typeof __incomingContent.meta === "object") {
      try {
        // Prefer page_id from content.meta if not explicitly provided
        const metaPid = __incomingContent.meta.page_id || __incomingContent.meta.id || null;
        if (!pageId && metaPid) {
          pageId = String(metaPid).trim() || null;
        }

        // Merge meta → fields, but skip control keys that are not Notion property names
        const CONTROL_KEYS = new Set(["page_id", "id", "_update", "_mode"]);
        for (const [mk, mv] of Object.entries(__incomingContent.meta)) {
          if (CONTROL_KEYS.has(String(mk))) continue;
          if (fields[mk] === undefined) {
            fields[mk] = mv;
          }
        }
      } catch (_) { /* ignore meta merge errors */ }
    }

    if (!NOTION_KEY || !targetDatabaseId) {
      return res.status(200).json({
        ok: true, simulating: true, db: dbSelector || "auto",
        database_id: targetDatabaseId || null,
        note: "Provide NOTION_KEY and a valid database id to upsert."
      });
    }

    const headers = notionHeaders();
    const schemaResp = await doNotion("get", `https://api.notion.com/v1/databases/${targetDatabaseId}`, { headers });
    const props = schemaResp.data?.properties || {};

    // Normalize relation fields by title (Roadmap or Tasks self-relation)
    const normalizedFields = { ...fields };
    try {
      const relationTargets = {};
      for (const [k, v] of Object.entries(props)) {
        if (v.type === "relation" && v.relation && v.relation.database_id) {
          relationTargets[k] = v.relation.database_id;
        } else if (v.type === "relation") {
          const name = String(k).toLowerCase();
          if (name === "roadmap" && ROADMAP_DATABASE_ID) relationTargets[k] = ROADMAP_DATABASE_ID;
          else if (TASK_TRACKER_DATABASE_ID && (name === "parent task" || name === "parent" || name === "sub tasks" || name === "subtasks" || name === "children")) {
            relationTargets[k] = TASK_TRACKER_DATABASE_ID;
          }
        }
      }
      for (const [k, v] of Object.entries(fields)) {
        const targetDb = relationTargets[k];
        if (!targetDb) continue;
        const isRoadmapRelation =
          ROADMAP_DATABASE_ID && normId(targetDb) === normId(ROADMAP_DATABASE_ID);
        const isTasksSelfRelation =
          TASK_TRACKER_DATABASE_ID && normId(targetDb) === normId(TASK_TRACKER_DATABASE_ID);

        if (isRoadmapRelation || isTasksSelfRelation) {
          const lookupDb = isRoadmapRelation ? ROADMAP_DATABASE_ID : TASK_TRACKER_DATABASE_ID;
          if (typeof v === "string") {
            const id = await resolveTitleToId(lookupDb, headers, v);
            if (id) normalizedFields[k] = [id];
          } else if (Array.isArray(v)) {
            const out = [];
            for (const item of v) {
              if (typeof item === "string") {
                const id = await resolveTitleToId(lookupDb, headers, item);
                if (id) out.push(id);
              } else if (item && typeof item === "object" && item.id) {
                out.push(item.id);
              }
            }
            if (out.length) normalizedFields[k] = out;
          }
        }
      }

      // Report unresolved titles (only for roadmap/tasks relations)
      const uuidRe = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
      const unresolved = [];
      for (const [k, v] of Object.entries(normalizedFields)) {
        const targetDb = relationTargets[k];
        const isRoadmapRelation =
          (targetDb && ROADMAP_DATABASE_ID && normId(targetDb) === normId(ROADMAP_DATABASE_ID)) ||
          String(k).toLowerCase() === "roadmap";
        const isTasksSelfRelation =
          targetDb && TASK_TRACKER_DATABASE_ID && normId(targetDb) === normId(TASK_TRACKER_DATABASE_ID);
        if (!isRoadmapRelation && !isTasksSelfRelation) continue;

        const vals = Array.isArray(v) ? v : [v];
        const bad = vals.filter(x => typeof x === "string" && !uuidRe.test(toDashedUuid(x)));
        if (bad.length) unresolved.push({ property: k, value: v });
      }
      if (unresolved.length) {
        try {
          let titles = [];
          let dbForSuggest = ROADMAP_DATABASE_ID || TASK_TRACKER_DATABASE_ID;
          let titleProp = null;
          if (dbForSuggest) {
            const schema = await doNotion("get", `https://api.notion.com/v1/databases/${dbForSuggest}`, { headers });
            for (const [rk, rv] of Object.entries(schema.data?.properties || {})) {
              if (rv.type === "title") { titleProp = rk; break; }
            }
            if (titleProp) {
              const q = await doNotion("post", `https://api.notion.com/v1/databases/${dbForSuggest}/query`, { headers, data: { page_size: 10 } });
              titles = (q.data?.results || []).map(p => {
                const r = p.properties?.[titleProp]?.title || [];
                return r.map(t => t?.plain_text || "").join("");
              }).filter(Boolean);
            }
          }
          return res.status(400).json({
            ok: false,
            error: "relation_title_not_found",
            hint: "No matching page title could be resolved for a relation. Use an exact title or supply the page ID.",
            unresolved, suggestions: titles
          });
        } catch {
          return res.status(400).json({
            ok: false,
            error: "relation_title_not_found",
            hint: "No matching page title could be resolved for a relation. Use an exact title or supply the page ID.",
            unresolved
          });
        }
      }
      req._sol_relation_normalized = Object.keys(normalizedFields).filter(k => fields[k] !== normalizedFields[k]);
    } catch (e) {
      console.warn("Relation normalization by title failed:", e?.response?.status || e.message);
    }

    // Build properties from schema
    async function buildProp(propName, value) {
      const def = props[propName];
      if (!def) return { skip: true, reason: "unknown_property" };
      switch (def.type) {
        case "title":
          if (!value) return { error: "title_required" };
          return { value: { title: [{ text: { content: String(value) } }] } };
        case "rich_text":
          return { value: { rich_text: [{ text: { content: String(value) } }] } };
        case "select": {
          const options = (def.select?.options || []).map(o => o.name);
          const name = String(value);
          const has = options.some(o => o.toLowerCase() === name.toLowerCase());
          if (!has) return { skip: true, reason: "unknown_option", available: options };
          return { value: { select: { name } } };
        }
        case "multi_select": {
          const options = (def.multi_select?.options || []).map(o => o.name);
          const arr = Array.isArray(value) ? value : [value];
          const valid = arr.filter(v => options.some(o => o.toLowerCase() === String(v).toLowerCase()));
          if (!valid.length) return { skip: true, reason: "unknown_option", available: options };
          return { value: { multi_select: valid.map(name => ({ name })) } };
        }
        case "status": {
          const options = (def.status?.options || []).map(o => o.name);
          const name = String(value);
          const has = options.some(o => o.toLowerCase() === name.toLowerCase());
          if (!has) return { skip: true, reason: "unknown_option", available: options };
          return { value: { status: { name } } };
        }
        case "date": {
          if (typeof value === "string") return { value: { date: { start: value } } };
          if (value && (value.start || value.end)) {
            const { start, end, time_zone } = value;
            return { value: { date: { start, end, time_zone } } };
          }
          return { skip: true, reason: "invalid_date" };
        }
        case "number":
          if (typeof value !== "number") return { skip: true, reason: "invalid_number" };
          return { value: { number: value } };
        case "checkbox":
          return { value: { checkbox: Boolean(value) } };
        case "url":
          return { value: { url: String(value) } };
        case "people": {
          const vals = Array.isArray(value) ? value : [value];
          if (!globalThis.__solUsersIndex) {
            globalThis.__solUsersIndex = await listAllUsers(headers);
          }
          const idx = globalThis.__solUsersIndex;
          const people = [];
          for (const v of vals) {
            if (!v) continue;
            if (typeof v === "string") {
              const s = v.trim();
              if (s.includes("@")) {
                const u = idx.byEmail.get(s.toLowerCase());
                if (u) people.push({ id: u.id });
              } else {
                people.push({ id: s });
              }
            } else if (v && v.id) {
              people.push({ id: String(v.id) });
            }
          }
          if (!people.length) return { skip: true, reason: "unknown_people" };
          return { value: { people } };
        }
        case "files": {
          const vals = Array.isArray(value) ? value : [value];
          const files = [];
          function inferNameFromUrl(u) {
            try {
              const withoutQuery = String(u).split("?")[0];
              const seg = withoutQuery.split("/").filter(Boolean).pop() || "file";
              return seg.length > 100 ? seg.slice(0, 100) : seg;
            } catch { return "file"; }
          }
          for (const v of vals) {
            if (!v) continue;
            if (typeof v === "string") {
              const urlStr = v.trim();
              const name = inferNameFromUrl(urlStr);
              files.push({ type: "external", name, external: { url: urlStr } });
            } else if (typeof v === "object") {
              if (v.external?.url) {
                const name = v.name || inferNameFromUrl(v.external.url);
                files.push({ type: "external", name, external: { url: v.external.url } });
              } else if (v.url) {
                const name = v.name || inferNameFromUrl(v.url);
                files.push({ type: "external", name, external: { url: v.url } });
              } else if (v.name && v.href) {
                files.push({ type: "external", name: String(v.name), external: { url: String(v.href) } });
              }
            }
          }
          if (!files.length) return { skip: true, reason: "invalid_files" };
          return { value: { files } };
        }
        case "relation": {
          const ids = Array.isArray(value) ? value : [value];
          const rel = ids
            .map(v => (typeof v === "string" ? v.trim() : (v && v.id ? String(v.id) : null)))
            .filter(Boolean)
            .map(id => ({ id: toDashedUuid(id) }));
          if (!rel.length) return { skip: true, reason: "invalid_relation" };
          return { value: { relation: rel } };
        }
        default:
          return { skip: true, reason: "unsupported_type", type: def.type };
      }
    }

    const properties = {};
    const skips = {};
    if (process.env.SOL_DEBUG === "1") {
      try { console.log("upsert_page: incoming keys", Object.keys(req.body || {})); } catch {}
      try { console.log("upsert_page: field keys", Object.keys(fields || {})); } catch {}
    }
    for (const [k, v] of Object.entries(normalizedFields)) {
      const built = await buildProp(k, v);
      if (built.error) {
        return res.status(400).json({ ok: false, error: built.error, field: k });
      }
      if (built.skip) {
        skips[k] = built.reason === "unknown_option" ? { reason: built.reason, available: built.available } : { reason: built.reason, type: built.type };
        continue;
      }
      properties[k] = built.value;
    }

    // Ensure we have a title on create
    if (!pageId) {
      let titlePropName = null;
      for (const [k, v] of Object.entries(props)) { if (v.type === "title") { titlePropName = k; break; } }
      if (!title && !properties[titlePropName]) {
        return res.status(400).json({ ok: false, error: "title_required_on_create", hint: `Provide 'title' or set the '${titlePropName || "title"}' property inside 'fields' (or 'properties').` });
      }
      if (title && titlePropName && !properties[titlePropName]) {
        properties[titlePropName] = { title: [{ text: { content: String(title) } }] };
      }
    }

    async function maybeAppendContent(targetPageId) {
      if (!__incomingContent) return null;
      const blocks = buildBlocksFromContent(__incomingContent);
      if (!blocks.length) return null;
      return appendBlocks(notionHeaders(), targetPageId, blocks);
    }

    if (pageId) {
      // UPDATE
      const updateResp = await doNotion("patch", `https://api.notion.com/v1/pages/${pageId}`, { headers, data: { properties } });
      await maybeAppendContent(updateResp.data.id);
      return res.status(200).json({
        ok: true, mode: "update", db: dbSelector || "auto",
        database_id: targetDatabaseId, page_id: updateResp.data.id,
        skipped: Object.keys(skips).length ? skips : null,
        relation_normalized: req._sol_relation_normalized || null
      });
    } else {
      // CREATE
      const createResp = await doNotion("post", "https://api.notion.com/v1/pages", { headers, data: { parent: { database_id: targetDatabaseId }, properties } });
      await maybeAppendContent(createResp.data.id);
      return res.status(200).json({
        ok: true, mode: "create", db: dbSelector || "auto",
        database_id: targetDatabaseId, page_id: createResp.data.id,
        skipped: Object.keys(skips).length ? skips : null,
        relation_normalized: req._sol_relation_normalized || null
      });
    }

  } catch (err) {
    const status = err?.response?.status; const data = err?.response?.data;
    console.error("Notion upsert failed:", status, data || err.message);
    res.status(500).json({ ok: false, error: "Failed to upsert page", status, details: data || err.message });
  }
});

// Archive (delete) a Notion page by page_id or by db+title
app.post("/delete_page", requireSolAuth, async (req, res) => {
  try {
    // Prefer explicit page_id; otherwise resolve via db+title
    let pageId = (req.body?.page_id || "").toString().trim() || null;
    const dbSelector = (req.query?.db || req.body?.db || "").toString().toLowerCase();
    const title = (req.body?.title || "").toString().trim() || null;
    const dryRun = Boolean(req.body?.dry_run);
    const reason = (req.body?.reason || "").toString();

    const targetDatabaseId = getNotionDbId(dbSelector);

    if (!NOTION_KEY) {
      return res.status(200).json({
        ok: true,
        simulating: true,
        note: "Provide NOTION_KEY to perform archive operations.",
        page_id: pageId || null,
        db: dbSelector || "auto",
        title: title || null,
        dry_run: dryRun
      });
    }

    const headers = notionHeaders();

    // Resolve by db+title if no page_id provided
    if (!pageId) {
      if (!targetDatabaseId || !title) {
        return res.status(400).json({ ok: false, error: "missing_identifier", hint: "Provide 'page_id' or ('db' and exact 'title')." });
      }
      const resolved = await resolveTitleToId(targetDatabaseId, headers, title);
      if (!resolved) {
        return res.status(404).json({ ok: false, error: "not_found", hint: `No page titled '${title}' found in the selected database.` });
      }
      pageId = resolved;
    }

    if (dryRun) {
      return res.status(200).json({
        ok: true,
        dry_run: true,
        action: "archive",
        page_id: pageId,
        reason: reason || null
      });
    }

    // Archive the page (safe delete)
    const resp = await doNotion("patch", `https://api.notion.com/v1/pages/${pageId}`, {
      headers,
      data: { archived: true }
    });

    return res.status(200).json({
      ok: true,
      archived: true,
      page_id: resp.data?.id || pageId,
      reason: reason || null
    });
  } catch (err) {
    const status = err?.response?.status; const data = err?.response?.data;
    console.error("Notion delete (archive) failed:", status, data || err.message);
    res.status(500).json({ ok: false, error: "Failed to archive page", status, details: data || err.message });
  }
});

// Web search (optional; simulated without key)
app.post("/search_web", async (req, res) => {
  try {
    const { query, recency_days } = req.body;
    if (!query) return res.status(400).json({ ok: false, error: "Missing query" });

    if (!SEARCH_API_KEY) {
      return res.status(200).json({
        ok: true,
        simulating: true,
        results: [{ title: `Simulated result for: ${query}`, url: "https://example.com/1", snippet: "Stubbed snippet (set SEARCH_API_KEY for live search)" }]
      });
    }

    const { data } = await axios.get("https://api.bing.microsoft.com/v7.0/search", {
      headers: { "Ocp-Apim-Subscription-Key": SEARCH_API_KEY },
      params: { q: query, freshness: recency_days ? `Day:${recency_days}` : undefined },
    });

    const results = (data.webPages?.value || []).map(r => ({ title: r.name, url: r.url, snippet: r.snippet }));
    res.status(200).json({ ok: true, results });
  } catch (err) {
    console.error("Web search failed:", err);
    res.status(500).json({ ok: false, error: "Search failed" });
  }
});

// Health
app.get("/health", (req, res) => {
  const notionConfigured = Boolean(NOTION_KEY && (NOTION_DATABASE_ID || ROADMAP_DATABASE_ID || TASK_TRACKER_DATABASE_ID));
  const searchConfigured = Boolean(SEARCH_API_KEY);
  const base =
    BASE_URL ||
    `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}`;
  res.json({
    ok: true,
    service: "sol-v3-agent",
    version: VERSION,
    base_url: base,
    notion: notionConfigured ? "configured" : "not_configured",
    notion_databases: {
      docs: Boolean(NOTION_DATABASE_ID),
      roadmap: Boolean(ROADMAP_DATABASE_ID),
      tasks: Boolean(TASK_TRACKER_DATABASE_ID)
    },
    notion_default_order: ["docs", "tasks", "roadmap"].filter(Boolean),
    search: searchConfigured ? "configured" : "not_configured",
    auth: SERVER_TOKEN ? "protected" : "open"
  });
});

// Whoami / header echo (debug)
app.get("/whoami", (req, res) => {
  res.json({
    ok: true,
    method: req.method,
    ip: req.ip,
    ips: req.ips,
    headers: {
      host: req.get("host"),
      "user-agent": req.get("user-agent"),
      "x-forwarded-for": req.get("x-forwarded-for") || null,
      "x-sol-token": req.get("x-sol-token") ? "<present>" : null,
      authorization: req.get("authorization") ? "<present>" : null,
      "content-type": req.get("content-type") || null
    }
  });
});

// Root
app.get("/", (_req, res) => res.json({ ok: true, service: "sol-v3-agent" }));

// Find pages by title (exact/contains/recent)
app.post("/find_pages", async (req, res) => {
  try {
    const dbSelector = (req.query?.db || req.body?.db || "").toString().toLowerCase();
    const targetDatabaseId = getNotionDbId(dbSelector);
    const titleQuery = (req.body?.title || "").toString().trim();
    const exact = Boolean(req.body?.exact);

    if (!NOTION_KEY || !targetDatabaseId) {
      return res.status(200).json({
        ok: true, simulating: true, db: dbSelector || "auto",
        database_id: targetDatabaseId || null,
        note: "Provide NOTION_KEY and a valid database id to search."
      });
    }

    const headers = notionHeaders();

    const schema = await doNotion("get", `https://api.notion.com/v1/databases/${targetDatabaseId}`, { headers });
    let titlePropName = null;
    for (const [k, v] of Object.entries(schema.data?.properties || {})) {
      if (v.type === "title") { titlePropName = k; break; }
    }
    if (!titlePropName) return res.status(400).json({ ok: false, error: "no_title_property" });

    const results = [];

    if (titleQuery) {
      const exactResp = await doNotion("post", `https://api.notion.com/v1/databases/${targetDatabaseId}/query`, {
        headers,
        data: { filter: { property: titlePropName, title: { equals: titleQuery } }, page_size: 5 },
      });
      for (const p of (exactResp.data?.results || [])) {
        const tRich = p.properties?.[titlePropName]?.title || [];
        const t = (tRich.map((x) => x?.plain_text || "").join("") || "").trim();
        results.push({ id: p.id, title: t });
      }
    }

    if (!exact && titleQuery) {
      const containsResp = await doNotion("post", `https://api.notion.com/v1/databases/${targetDatabaseId}/query`, {
        headers,
        data: { filter: { property: titlePropName, title: { contains: titleQuery } }, page_size: 10 },
      });
      for (const p of (containsResp.data?.results || [])) {
        const tRich = p.properties?.[titlePropName]?.title || [];
        const t = (tRich.map((x) => x?.plain_text || "").join("") || "").trim();
        if (!results.find((r) => r.id === p.id)) results.push({ id: p.id, title: t });
      }
    }

    if (!titleQuery || results.length === 0) {
      const listResp = await doNotion("post", `https://api.notion.com/v1/databases/${targetDatabaseId}/query`, {
        headers,
        data: { page_size: 10, sorts: [{ timestamp: "last_edited_time", direction: "descending" }] },
      });
      for (const p of (listResp.data?.results || [])) {
        const tRich = p.properties?.[titlePropName]?.title || [];
        const t = (tRich.map((x) => x?.plain_text || "").join("") || "").trim();
        results.push({ id: p.id, title: t });
      }
    }

    return res.status(200).json({ ok: true, db: dbSelector || "auto", database_id: targetDatabaseId, results });
  } catch (err) {
    const status = err?.response?.status; const data = err?.response?.data;
    res.status(500).json({ ok: false, error: "Failed to find pages", status, details: data || err.message });
  }
});

// Append rich content to a page
app.post("/append_task_content", requireSolAuth, async (req, res) => {
  try {
    const pageId = String(req.body?.page_id || "").trim();
    if (!pageId) return res.status(400).json({ ok: false, error: "page_id_required" });
    if (!NOTION_KEY) return res.status(200).json({ ok: true, simulating: true, page_id: pageId });

    const headers = notionHeaders();
    const content = {
      description: req.body?.description,
      subtasks: Array.isArray(req.body?.subtasks) ? req.body.subtasks : [],
      files: Array.isArray(req.body?.files) ? req.body.files : [],
      blocks: Array.isArray(req.body?.blocks) ? req.body.blocks : undefined,
    };
    const blocks = buildBlocksFromContent(content);
    if (!blocks.length) return res.status(400).json({ ok: false, error: "no_content" });

    const resp = await appendBlocks(headers, pageId, blocks);
    return res.status(200).json({
      ok: true,
      page_id: pageId,
      appended: blocks.length,
      notion_request_id: resp?.headers?.["x-request-id"] || null,
    });
  } catch (err) {
    const status = err?.response?.status; const data = err?.response?.data;
    res.status(500).json({ ok: false, error: "Failed to append content", status, details: data || err.message });
  }
});

// ─────────────────────────── Boot ───────────────────────────
app.listen(PORT, () => {
  const base = BASE_URL || `http://localhost:${PORT}`;
  console.log(`🚀 Sol v3 agent running v${VERSION}. Public base: ${base} — auth: ${SERVER_TOKEN ? "protected" : "open"}`);
});