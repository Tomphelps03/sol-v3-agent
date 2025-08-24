import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import axios from "axios";
import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";
import PPTXGenJS from "pptxgenjs";

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(bodyParser.json());

// Serve generated files from ./public/files
const filesDir = path.join(process.cwd(), "public", "files");
fs.mkdirSync(filesDir, { recursive: true });
app.use("/files", express.static(filesDir));

// ---------- CONFIG ----------
const PORT = process.env.PORT || 3000;
// Support both NOTION_KEY and NOTION-KEY (dash variant), plus multiple DB IDs
const NOTION_KEY = process.env.NOTION_KEY || process.env["NOTION-KEY"] || "";
const NOTION_DATABASE_ID =
  process.env.NOTION_DATABASE_ID || process.env.DOCS_DATABASE_ID || "";
const ROADMAP_DATABASE_ID = process.env.ROADMAP_DATABASE_ID || "";
const TASK_TRACKER_DATABASE_ID = process.env.TASK_TRACKER_DATABASE_ID || "";
const SEARCH_API_KEY = process.env.SEARCH_API_KEY || "";

const BASE_URL = process.env.BASE_URL || "";

// Normalize Notion IDs for comparison (strip dashes, lowercase)
function normId(s) {
  return String(s || "").replace(/-/g, "").toLowerCase();
}

// Map a database key to an actual Notion database id
function getNotionDbId(dbKey) {
  const key = String(dbKey || "").toLowerCase();
  if (key === "docs" || key === "documents" || key === "document") return NOTION_DATABASE_ID || "";
  if (key === "roadmap" || key === "road") return ROADMAP_DATABASE_ID || "";
  if (key === "tasks" || key === "task" || key === "tracker") return TASK_TRACKER_DATABASE_ID || "";
  // default preference order if none provided
  return NOTION_DATABASE_ID || TASK_TRACKER_DATABASE_ID || ROADMAP_DATABASE_ID || "";
}

// ---------- HELPERS ----------
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

// ---------- ENDPOINT: GENERATE DOCUMENT ----------
app.post("/generate_document", async (req, res) => {
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

// ---------- ENDPOINT: UPDATE TASK ----------
app.post("/update_task", async (req, res) => {
  try {
    const { title, status, notes, task_id } = req.body;

    // Allow caller to choose which Notion DB to use: ?db=docs|roadmap|tasks or body.db
    const dbSelector = (req.query?.db || req.body?.db || "").toString().toLowerCase();
    const targetDatabaseId = getNotionDbId(dbSelector);

    if (!title || !status) {
      return res.status(400).json({ ok: false, error: "Missing required fields" });
    }

    if (!NOTION_KEY || !targetDatabaseId) {
      return res.status(200).json({
        ok: true,
        simulating: true,
        db: dbSelector || "auto",
        database_id: targetDatabaseId || null,
        task_id: task_id || "SIMULATED_TASK_ID",
        title,
        status,
        notes: notes || ""
      });
    }

    const notionUrl = "https://api.notion.com/v1/pages";
    const headers = {
      "Authorization": `Bearer ${NOTION_KEY}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    };

    // ---- AUTO-DETECT PROPERTY NAMES FROM SCHEMA ----
    let titlePropName = null;
    let statusPropName = null;
    let notesPropName = null;
    try {
      const schemaResp = await axios.get(`https://api.notion.com/v1/databases/${targetDatabaseId}`, { headers });
      const props = schemaResp.data?.properties || {};
      // title: first property whose type is "title"
      for (const [k, v] of Object.entries(props)) {
        if (v.type === "title") { titlePropName = k; break; }
      }
      // status/select: prefer "Status", else first "status" (newer Notion) or "select"
      let firstSelect = null;
      for (const [k, v] of Object.entries(props)) {
        if (v.type === "status" && !statusPropName) statusPropName = k;
        if (k.toLowerCase() === "status") statusPropName = k;
        if (v.type === "select" && !firstSelect) firstSelect = k;
      }
      if (!statusPropName && firstSelect) statusPropName = firstSelect;
      // notes: prefer "Notes", else first rich_text
      let firstRich = null;
      for (const [k, v] of Object.entries(props)) {
        if (v.type === "rich_text" && !firstRich) firstRich = k;
      }
      if (!notesPropName && firstRich) notesPropName = firstRich;
    } catch (e) {
      console.warn("Schema fetch failed; falling back to defaults:", e?.response?.status || e.message);
    }

    if (!titlePropName) {
      return res.status(400).json({
        ok: false,
        error: "No title property found in target Notion database",
        hint: "Add a title property (e.g., 'Name' or 'Doc name') to the database."
      });
    }

    // ---- BUILD PROPERTIES USING DETECTED NAMES ----
    const properties = {};
    properties[titlePropName] = { title: [{ text: { content: title } }] };

    // Only include Status if schema supports a matching select/status option
    if (status) {
      try {
        const schemaResp2 = await axios.get(`https://api.notion.com/v1/databases/${targetDatabaseId}`, { headers });
        const propDef = schemaResp2.data?.properties?.[statusPropName];
        if (propDef && (propDef.type === "select" || propDef.type === "status")) {
          // Validate option exists (case-insensitive); if not, omit Status to avoid 400
          const options = (propDef.select?.options || propDef.status?.options || []).map(o => o.name);
          const hasOption = options.some(o => (o || "").toLowerCase() === status.toLowerCase());
          if (hasOption) {
            properties[statusPropName] = { select: { name: status } };
            if (propDef.type === "status") {
              properties[statusPropName] = { status: { name: status } };
            }
          } else {
            console.warn(`Skipping status '${status}' – not found in options for ${statusPropName}`);
            // Attach a hint we can return later
            req._sol_status_skipped = {
              requested: status,
              property: statusPropName,
              available: options
            };
          }
        }
      } catch (e) {
        console.warn("Status validation skipped due to schema fetch error.");
      }
    }

    if (notes && notesPropName) {
      properties[notesPropName] = { rich_text: [{ text: { content: notes } }] };
    }

    const payload = {
      parent: { database_id: targetDatabaseId },
      properties
    };

    const createResp = await axios.post(notionUrl, payload, { headers });
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
    res.status(500).json({
      ok: false,
      error: "Failed to update task",
      status,
      details: data || err.message
    });
  }
});

// ---------- ENDPOINT: NOTION SCHEMA (debug) ----------
app.get("/notion_schema", async (req, res) => {
  try {
    const dbSelector = (req.query?.db || "").toString().toLowerCase();
    const targetDatabaseId = getNotionDbId(dbSelector);
    if (!NOTION_KEY || !targetDatabaseId) {
      return res.status(200).json({
        ok: true,
        simulating: true,
        db: dbSelector || "auto",
        database_id: targetDatabaseId || null,
        note: "Provide NOTION_KEY and a valid database id to fetch schema."
      });
    }
    const headers = {
      "Authorization": `Bearer ${NOTION_KEY}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    };
    const { data } = await axios.get(`https://api.notion.com/v1/databases/${targetDatabaseId}`, { headers });
    // Return only essential schema bits, including options for status/select
    const props = Object.fromEntries(
      Object.entries(data.properties || {}).map(([k, v]) => {
        const base = { type: v.type };
        if (v.type === "status") {
          base.options = (v.status?.options || []).map(o => o.name);
        } else if (v.type === "select") {
          base.options = (v.select?.options || []).map(o => o.name);
        }
        return [k, base];
      })
    );
    res.status(200).json({
      ok: true,
      db: dbSelector || "auto",
      database_id: targetDatabaseId,
      title_property: data.title,
      properties: props
    });
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    console.error("Notion schema fetch failed:", status, data || err.message);
    res.status(500).json({ ok: false, error: "Failed to get schema", status, details: data || err.message });
  }
});

// ---------- ENDPOINT: NOTION RAW PROPS (debug) ----------
app.get("/notion_raw_props", async (req, res) => {
  try {
    const dbSelector = (req.query?.db || "").toString().toLowerCase();
    const targetDatabaseId = getNotionDbId(dbSelector);
    if (!NOTION_KEY || !targetDatabaseId) {
      return res.status(200).json({ ok: true, simulating: true, db: dbSelector || "auto", database_id: targetDatabaseId || null });
    }
    const headers = {
      "Authorization": `Bearer ${NOTION_KEY}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    };
    const { data } = await axios.get(`https://api.notion.com/v1/databases/${targetDatabaseId}`, { headers });
    res.status(200).json({ ok: true, db: dbSelector || "auto", database_id: targetDatabaseId, raw_properties: data.properties || {} });
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    res.status(500).json({ ok: false, error: "Failed to fetch raw props", status, details: data || err.message });
  }
});

// ---------- ENDPOINT: NOTION TEST CREATE (debug) ----------
app.post("/notion_test_create", async (req, res) => {
  try {
    const dbSelector = (req.query?.db || req.body?.db || "").toString().toLowerCase();
    const targetDatabaseId = getNotionDbId(dbSelector);
    const title = (req.body?.title || "Sol v3 Health Check").toString();
    if (!NOTION_KEY || !targetDatabaseId) {
      return res.status(200).json({
        ok: true,
        simulating: true,
        db: dbSelector || "auto",
        database_id: targetDatabaseId || null,
        note: "Provide NOTION_KEY and a valid database id to create a page."
      });
    }
    const headers = {
      "Authorization": `Bearer ${NOTION_KEY}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    };
    // Detect title property
    let titlePropName = null;
    try {
      const schemaResp = await axios.get(`https://api.notion.com/v1/databases/${targetDatabaseId}`, { headers });
      const props = schemaResp.data?.properties || {};
      for (const [k, v] of Object.entries(props)) {
        if (v.type === "title") { titlePropName = k; break; }
      }
    } catch (e) {
      console.warn("Schema fetch failed in notion_test_create");
    }
    if (!titlePropName) {
      return res.status(400).json({
        ok: false,
        error: "No title property found; cannot create test page",
        hint: "Add a title property to this database in Notion."
      });
    }
    const payload = {
      parent: { database_id: targetDatabaseId },
      properties: {
        [titlePropName]: { title: [{ text: { content: title } }] }
      }
    };
    const { data } = await axios.post("https://api.notion.com/v1/pages", payload, { headers });
    res.status(200).json({
      ok: true,
      db: dbSelector || "auto",
      database_id: targetDatabaseId,
      task_id: data.id,
      title,
      used_props: { title: titlePropName }
    });
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    console.error("Notion test create failed:", status, data || err.message);
    res.status(500).json({ ok: false, error: "Failed test create", status, details: data || err.message });
  }
});

// ---------- ENDPOINT: NOTION UPSERT (flexible fields) ----------
// Creates a page when page_id is omitted; updates when page_id is provided.
// Body:
// {
//   "db": "docs|roadmap|tasks",
//   "page_id": "optional-when-updating",
//   "title": "optional-on-update (required on create)",
//   "fields": {
//      "Status": "In Progress",                 // status/select (string)
//      "Priority": "High",                      // select
//      "Task type": ["Content","Video"],        // multi_select
//      "Summary": "Short text",                 // rich_text
//      "Description": "Longer text here",       // rich_text
//      "Due date": {"start":"2025-09-01"},      // date (start/end)
//      "Effort": 3,                             // number
//      "Done": true,                            // checkbox
//      "URL": "https://example.com"             // url
//   }
// }
app.post("/upsert_page", async (req, res) => {
  try {
    const dbSelector = (req.query?.db || req.body?.db || "").toString().toLowerCase();
    const targetDatabaseId = getNotionDbId(dbSelector);
    const pageId = (req.body?.page_id || "").toString().trim() || null;
    const title = req.body?.title;
    const fields = req.body?.fields || {};

    if (!NOTION_KEY || !targetDatabaseId) {
      return res.status(200).json({
        ok: true,
        simulating: true,
        db: dbSelector || "auto",
        database_id: targetDatabaseId || null,
        note: "Provide NOTION_KEY and a valid database id to upsert."
      });
    }

    const headers = {
      "Authorization": `Bearer ${NOTION_KEY}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    };

    // Fetch schema to know property types & valid options
    const schemaResp = await axios.get(`https://api.notion.com/v1/databases/${targetDatabaseId}`, { headers });
    const props = schemaResp.data?.properties || {};

    // Normalize relation fields by title when the relation targets the ROADMAP database.
    // This lets callers pass a phase name (string) instead of page IDs for the Roadmap relation.
    const normalizedFields = { ...fields };
    try {
      // Build a map of relation prop name -> target database id
      const relationTargets = {};
      for (const [k, v] of Object.entries(props)) {
        if (v.type === "relation" && v.relation && v.relation.database_id) {
          relationTargets[k] = v.relation.database_id;
        } else if (v.type === "relation" && String(k).toLowerCase() === "roadmap" && ROADMAP_DATABASE_ID) {
          // Fallback: if the property is literally named "Roadmap", assume it targets the ROADMAP DB
          relationTargets[k] = ROADMAP_DATABASE_ID;
        }
      }

      // Enhanced: resolve a single roadmap title to a page id, with /v1/search fallback
      async function resolveRoadmapTitleToId(titleStr) {
        // Detect title property in roadmap db
        const roadmapSchema = await axios.get(`https://api.notion.com/v1/databases/${ROADMAP_DATABASE_ID}`, { headers });
        let roadmapTitleProp = null;
        for (const [rk, rv] of Object.entries(roadmapSchema.data?.properties || {})) {
          if (rv.type === "title") { roadmapTitleProp = rk; break; }
        }
        if (!roadmapTitleProp) return null;

        // 1) exact match
        let q = await axios.post(`https://api.notion.com/v1/databases/${ROADMAP_DATABASE_ID}/query`, {
          filter: { property: roadmapTitleProp, title: { equals: titleStr } },
          page_size: 1
        }, { headers });
        let match = (q.data?.results || [])[0];

        // 2) contains fallback
        if (!match) {
          q = await axios.post(`https://api.notion.com/v1/databases/${ROADMAP_DATABASE_ID}/query`, {
            filter: { property: roadmapTitleProp, title: { contains: titleStr } },
            page_size: 5
          }, { headers });
          match = (q.data?.results || [])[0];
        }

        // 3) global search fallback (filter pages that belong to ROADMAP DB)
        if (!match) {
          const s = await axios.post("https://api.notion.com/v1/search", {
            query: titleStr,
            filter: { property: "object", value: "page" },
            sort: { direction: "descending", timestamp: "last_edited_time" }
          }, { headers });
          const candidates = (s.data?.results || []).filter(p => {
            const pid = p?.parent?.database_id;
            return pid && normId(pid) === normId(ROADMAP_DATABASE_ID);
          });
          // prefer exact (case-insensitive) title, else first contains
          for (const p of candidates) {
            const titleRich = p.properties?.[roadmapTitleProp]?.title || [];
            const t = (titleRich.map(x => x?.plain_text || "").join("") || "").trim();
            if (t.toLowerCase() === String(titleStr).toLowerCase()) { match = p; break; }
          }
          if (!match && candidates.length) {
            match = candidates[0];
          }
        }
        return match?.id || null;
      }

      // Iterate over provided fields: if a field is a relation to the ROADMAP DB and user provided a string/array of strings,
      // resolve by title(s) to page id(s).
      for (const [k, v] of Object.entries(fields)) {
        const targetDb = relationTargets[k];
        const looksLikeRoadmapProp = String(k).toLowerCase() === "roadmap";
        const isRoadmapRelation =
          (targetDb && ROADMAP_DATABASE_ID && normId(targetDb) === normId(ROADMAP_DATABASE_ID)) ||
          looksLikeRoadmapProp;

        if (isRoadmapRelation) {
          if (typeof v === "string") {
            const id = await resolveRoadmapTitleToId(v);
            if (id) {
              normalizedFields[k] = [id];
            }
          } else if (Array.isArray(v)) {
            const out = [];
            for (const item of v) {
              if (typeof item === "string") {
                const id = await resolveRoadmapTitleToId(item);
                if (id) out.push(id);
              } else if (item && typeof item === "object" && item.id) {
                out.push(item.id);
              }
            }
            if (out.length) {
              normalizedFields[k] = out;
            }
          }
        }
      }

      // If any roadmap relation values are still strings after normalization, return a 400 with suggestions
      const unresolved = [];
      for (const [k, v] of Object.entries(normalizedFields)) {
        const looksLikeRoadmapProp = String(k).toLowerCase() === "roadmap";
        const targetDb = relationTargets[k];
        const isRoadmapRelation =
          (targetDb && ROADMAP_DATABASE_ID && normId(targetDb) === normId(ROADMAP_DATABASE_ID)) ||
          looksLikeRoadmapProp;
        if (isRoadmapRelation) {
          if (typeof v === "string" || (Array.isArray(v) && v.some(x => typeof x === "string"))) {
            unresolved.push({ property: k, value: v });
          }
        }
      }
      if (unresolved.length) {
        try {
          // Pull a few phase titles to suggest
          const schema = await axios.get(`https://api.notion.com/v1/databases/${ROADMAP_DATABASE_ID}`, { headers });
          let roadmapTitleProp = null;
          for (const [rk, rv] of Object.entries(schema.data?.properties || {})) {
            if (rv.type === "title") { roadmapTitleProp = rk; break; }
          }
          let titles = [];
          if (roadmapTitleProp) {
            const q = await axios.post(`https://api.notion.com/v1/databases/${ROADMAP_DATABASE_ID}/query`, { page_size: 10 }, { headers });
            titles = (q.data?.results || []).map(p => {
              const r = p.properties?.[roadmapTitleProp]?.title || [];
              return r.map(t => t?.plain_text || "").join("");
            }).filter(Boolean);
          }
          return res.status(400).json({
            ok: false,
            error: "roadmap_title_not_found",
            hint: "No matching Roadmap phase title could be resolved. Use an exact title or supply the page ID.",
            unresolved,
            suggestions: titles
          });
        } catch (e) {
          return res.status(400).json({
            ok: false,
            error: "roadmap_title_not_found",
            hint: "No matching Roadmap phase title could be resolved. Use an exact title or supply the page ID.",
            unresolved
          });
        }
      }
      // Attach a hint for debugging
      req._sol_relation_normalized = Object.keys(normalizedFields).filter(k => fields[k] !== normalizedFields[k]);
    } catch (e) {
      console.warn("Relation normalization by title failed:", e?.response?.status || e.message);
    }

    // Helper: build a Notion property from a simple value based on schema type
    function buildProp(propName, value) {
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
          // accepts {start, end, time_zone?} or ISO string
          if (typeof value === "string") {
            return { value: { date: { start: value } } };
          }
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
        case "relation": {
          const ids = Array.isArray(value) ? value : [value];
          const rel = ids
            .map(v => (typeof v === "string" ? v.trim() : (v && v.id ? String(v.id) : null)))
            .filter(Boolean)
            .map(id => ({ id }));
          if (!rel.length) return { skip: true, reason: "invalid_relation" };
          return { value: { relation: rel } };
        }
        default:
          return { skip: true, reason: "unsupported_type", type: def.type };
      }
    }

    // Build properties from provided fields
    const properties = {};
    const skips = {};
    for (const [k, v] of Object.entries(normalizedFields)) {
      const built = buildProp(k, v);
      if (built.error) {
        return res.status(400).json({ ok: false, error: built.error, field: k });
      }
      if (built.skip) {
        skips[k] = built.reason === "unknown_option" ? { reason: built.reason, available: built.available } : { reason: built.reason, type: built.type };
        continue;
      }
      properties[k] = built.value;
    }

    // Ensure we have a title when creating
    // If user didn't provide title in body fields and schema has a title prop, try to map it from fields if present
    if (!pageId) {
      // find title prop
      let titlePropName = null;
      for (const [k, v] of Object.entries(props)) {
        if (v.type === "title") { titlePropName = k; break; }
      }
      if (!title && !properties[titlePropName]) {
        return res.status(400).json({ ok: false, error: "title_required_on_create", hint: `Provide 'title' or set the '${titlePropName || "title"}' field in 'fields'.` });
      }
      // If title provided but not placed yet, put it
      if (title && titlePropName && !properties[titlePropName]) {
        properties[titlePropName] = { title: [{ text: { content: String(title) } }] };
      }
    }

    if (pageId) {
      // UPDATE (PATCH)
      const updateResp = await axios.patch(`https://api.notion.com/v1/pages/${pageId}`, { properties }, { headers });
      return res.status(200).json({
        ok: true,
        mode: "update",
        db: dbSelector || "auto",
        database_id: targetDatabaseId,
        page_id: updateResp.data.id,
        skipped: Object.keys(skips).length ? skips : null,
        relation_normalized: req._sol_relation_normalized || null
      });
    } else {
      // CREATE (POST)
      const createResp = await axios.post("https://api.notion.com/v1/pages", { parent: { database_id: targetDatabaseId }, properties }, { headers });
      return res.status(200).json({
        ok: true,
        mode: "create",
        db: dbSelector || "auto",
        database_id: targetDatabaseId,
        page_id: createResp.data.id,
        skipped: Object.keys(skips).length ? skips : null,
        relation_normalized: req._sol_relation_normalized || null
      });
    }
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    console.error("Notion upsert failed:", status, data || err.message);
    res.status(500).json({ ok: false, error: "Failed to upsert page", status, details: data || err.message });
  }
});

// ---------- ENDPOINT: SEARCH WEB ----------
app.post("/search_web", async (req, res) => {
  try {
    const { query, recency_days } = req.body;
    if (!query) return res.status(400).json({ ok: false, error: "Missing query" });

    if (!SEARCH_API_KEY) {
      return res.status(200).json({
        ok: true,
        simulating: true,
        results: [
          {
            title: `Simulated result for: ${query}`,
            url: "https://example.com/1",
            snippet: "Stubbed snippet (set SEARCH_API_KEY for live search)"
          }
        ]
      });
    }

    const { data } = await axios.get("https://api.bing.microsoft.com/v7.0/search", {
      headers: { "Ocp-Apim-Subscription-Key": SEARCH_API_KEY },
      params: { q: query, freshness: recency_days ? `Day:${recency_days}` : undefined },
    });

    const results = (data.webPages?.value || []).map(r => ({
      title: r.name,
      url: r.url,
      snippet: r.snippet,
    }));

    res.status(200).json({ ok: true, results });
  } catch (err) {
    console.error("Web search failed:", err);
    res.status(500).json({ ok: false, error: "Search failed" });
  }
});

// ---------- HEALTH ----------
app.get("/health", (_req, res) => {
  const notionConfigured = Boolean(NOTION_KEY && (NOTION_DATABASE_ID || ROADMAP_DATABASE_ID || TASK_TRACKER_DATABASE_ID));
  const searchConfigured = Boolean(SEARCH_API_KEY);
  res.json({
    ok: true,
    service: "sol-v3-agent",
    base_url: BASE_URL || null,
    notion: notionConfigured ? "configured" : "not_configured",
    notion_databases: {
      docs: Boolean(NOTION_DATABASE_ID),
      roadmap: Boolean(ROADMAP_DATABASE_ID),
      tasks: Boolean(TASK_TRACKER_DATABASE_ID)
    },
    notion_default_order: ["docs","tasks","roadmap"],
    search: searchConfigured ? "configured" : "not_configured"
  });
});

app.get("/", (_req, res) => res.json({ ok: true, service: "sol-v3-agent" }));

// ---------- START SERVER ----------
app.listen(PORT, () => {
  const base = BASE_URL || `http://localhost:${PORT}`;
  console.log(`🚀 Sol v3 agent running. Public base: ${base}`);
});