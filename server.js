import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import axios from "axios";
import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";
import PPTXGenJS from "pptxgenjs";

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ---------- CONFIG ----------
const PORT = process.env.PORT || 3000;
const NOTION_KEY = process.env.NOTION_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const SEARCH_API_KEY = process.env.SEARCH_API_KEY;

// ---------- HELPERS ----------
function makeTempFile(fileName) {
  return path.join("/tmp", fileName);
}

function makePublicURL(fileName) {
  // Replace with your storage bucket if you want persistence
  return `https://sol-agent-server.onrender.com/files/${fileName}`;
}

// ---------- ENDPOINT: GENERATE DOCUMENT ----------
app.post("/generate_document", async (req, res) => {
  try {
    const { title, content, format } = req.body;

    if (!title || !content || !format) {
      return res.status(400).json({ ok: false, error: "Missing required fields" });
    }

    let filePath;
    if (format === "pdf") {
      filePath = makeTempFile(`${title}.pdf`);
      const doc = new PDFDocument();
      doc.pipe(fs.createWriteStream(filePath));
      doc.fontSize(20).text(title, { align: "center" });
      doc.moveDown();
      doc.fontSize(12).text(content);
      doc.end();
    } else if (format === "pptx") {
      filePath = makeTempFile(`${title}.pptx`);
      const pptx = new PPTXGenJS();
      const slides = content.split("###");
      slides.forEach((slideText, idx) => {
        const slide = pptx.addSlide();
        slide.addText(slideText.trim(), { x: 0.5, y: 0.5, fontSize: 18, color: "363636" });
      });
      await pptx.writeFile(filePath);
    } else if (format === "md") {
      filePath = makeTempFile(`${title}.md`);
      fs.writeFileSync(filePath, content);
    } else {
      return res.status(400).json({ ok: false, error: "Unsupported format" });
    }

    return res.status(200).json({ ok: true, doc_url: makePublicURL(path.basename(filePath)) });
  } catch (err) {
    console.error("Document generation failed:", err);
    res.status(500).json({ ok: false, error: "Failed to generate document" });
  }
});

// ---------- ENDPOINT: UPDATE TASK ----------
app.post("/update_task", async (req, res) => {
  try {
    const { title, status, notes, task_id } = req.body;

    if (!title || !status) {
      return res.status(400).json({ ok: false, error: "Missing required fields" });
    }

    const notionUrl = "https://api.notion.com/v1/pages";
    const payload = {
      parent: { database_id: NOTION_DATABASE_ID },
      properties: {
        Name: { title: [{ text: { content: title } }] },
        Status: { select: { name: status } },
        Notes: notes ? { rich_text: [{ text: { content: notes } }] } : undefined,
      },
    };

    const headers = {
      "Authorization": `Bearer ${NOTION_KEY}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    };

    const { data } = await axios.post(notionUrl, payload, { headers });
    res.status(200).json({ ok: true, task_id: data.id, title, status });
  } catch (err) {
    console.error("Notion update failed:", err);
    res.status(500).json({ ok: false, error: "Failed to update task" });
  }
});

// ---------- ENDPOINT: SEARCH WEB ----------
app.post("/search_web", async (req, res) => {
  try {
    const { query, recency_days } = req.body;
    if (!query) return res.status(400).json({ ok: false, error: "Missing query" });

    const { data } = await axios.get("https://api.bing.microsoft.com/v7.0/search", {
      headers: { "Ocp-Apim-Subscription-Key": SEARCH_API_KEY },
      params: { q: query, freshness: recency_days ? `Day:${recency_days}` : undefined },
    });

    const results = data.webPages.value.map(r => ({
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

// ---------- START SERVER ----------
app.listen(PORT, () => console.log(`🚀 Sol v3 agent running at http://localhost:${PORT}`));