import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");

loadDotenv();

const port = Number(process.env.PORT || 3000);
const apiKey = process.env.OPENAI_API_KEY;
const imageModel = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2";
const maxJsonBytes = 75 * 1024 * 1024;
const openAiEditUrl = "https://api.openai.com/v1/images/edits";
const editJobTtlMs = 30 * 60 * 1000;
const maxStoredJobs = 2;
const editJobs = new Map();

const mimeByExt = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"]
]);

const server = createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/remove-furniture") {
      await handleRemoveFurniture(req, res);
      return;
    }

    if (req.method === "GET" && req.url.startsWith("/api/remove-furniture/")) {
      handleEditJobStatus(req, res);
      return;
    }

    if (req.method === "GET") {
      await serveStatic(req, res);
      return;
    }

    sendJson(res, 405, { error: "Metoda neni podporovana." });
  } catch (error) {
    console.error(error);
    sendJson(res, error.statusCode || 500, {
      error: error.statusCode ? error.message : "Neocekavana chyba serveru."
    });
  }
});

server.listen(port, () => {
  console.log(`Aplikace bezi na http://localhost:${port}`);
});

async function handleRemoveFurniture(req, res) {
  if (!apiKey) {
    sendJson(res, 500, {
      error: "Chybi OPENAI_API_KEY. Doplnte ho do souboru .env nebo promenne prostredi."
    });
    return;
  }

  const body = await readRequestBody(req, maxJsonBytes);
  const payload = JSON.parse(body);
  const { imageData, mimeType, fileName, width, height } = payload;

  if (!imageData || !mimeType || !width || !height) {
    sendJson(res, 400, { error: "Chybi obrazek nebo jeho rozmery." });
    return;
  }

  const outputFormat = formatFromMime(mimeType);
  if (!outputFormat) {
    sendJson(res, 400, { error: "Podporovane formaty jsou JPEG, PNG a WebP." });
    return;
  }

  const base64 = String(imageData).replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
  const imageBuffer = Buffer.from(base64, "base64");
  const size = supportedImageSize(Number(width), Number(height));
  const extension = outputFormat === "jpeg" ? "jpg" : outputFormat;
  const safeName = sanitizeFileName(fileName || `mistnost.${extension}`);

  const prompt = [
    "Photorealistic real estate photo edit.",
    "Remove all furniture and movable household items from this room.",
    "Reconstruct the empty floor, walls, windows, doors, trim, fixtures, lighting, shadows, and perspective naturally.",
    "Preserve the original camera angle, room layout, architecture, materials, colors, exposure, contrast, and overall image realism.",
    "Do not add new furniture, decor, text, logos, people, watermarks, or unrealistic objects.",
    "Return only the same room as an empty, unfurnished room."
  ].join(" ");

  const form = new FormData();
  form.append("model", imageModel);
  form.append("prompt", prompt);
  form.append("image", new File([imageBuffer], safeName, { type: mimeType }));
  form.append("size", `${size.width}x${size.height}`);
  form.append("quality", "high");
  form.append("output_format", outputFormat);

  if (outputFormat === "jpeg" || outputFormat === "webp") {
    form.append("output_compression", "0");
  }

  pruneEditJobs();
  const jobId = randomUUID();
  editJobs.set(jobId, { status: "processing", createdAt: Date.now() });
  sendJson(res, 202, { jobId, status: "processing" });

  void processEditJob(jobId, { form, outputFormat, extension, safeName, size });
}

function handleEditJobStatus(req, res) {
  pruneEditJobs();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const job = editJobs.get(url.pathname.split("/").pop());

  if (!job) {
    sendJson(res, 404, { error: "Uloha uz neni dostupna. Zpracujte fotku znovu." });
    return;
  }

  if (job.status === "completed") {
    sendJson(res, 200, { status: job.status, ...job.result });
    return;
  }

  sendJson(res, 200, job.status === "failed"
    ? { status: job.status, error: job.error }
    : { status: job.status });
}

async function processEditJob(jobId, edit) {
  try {
    const openAiResponse = await fetchOpenAiWithRetry(edit.form);
    const responseText = await openAiResponse.text();
    const data = parseJsonResponse(responseText);

    if (!openAiResponse.ok) {
      throw publicError(
        data?.error?.message || "OpenAI API vratilo chybu pri uprave obrazku.",
        openAiResponse.status
      );
    }

    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) throw publicError("Odpoved neobsahovala upraveny obrazek.", 502);

    const job = editJobs.get(jobId);
    if (!job) return;
    job.status = "completed";
    job.finishedAt = Date.now();
    job.result = {
      imageData: `data:image/${edit.outputFormat};base64,${b64}`,
      mimeType: `image/${edit.outputFormat}`,
      fileName: outputName(edit.safeName, edit.extension),
      width: edit.size.width,
      height: edit.size.height,
      usedOriginalSize: edit.size.usedOriginalSize
    };
  } catch (error) {
    console.error(error);
    const job = editJobs.get(jobId);
    if (!job) return;
    job.status = "failed";
    job.finishedAt = Date.now();
    job.error = error.statusCode ? error.message : "Neocekavana chyba serveru.";
  }

  pruneEditJobs();
}

function pruneEditJobs() {
  const now = Date.now();
  for (const [jobId, job] of editJobs) {
    if (job.status !== "processing" && now - job.finishedAt > editJobTtlMs) {
      editJobs.delete(jobId);
    }
  }

  const results = [...editJobs.entries()]
    .filter(([, job]) => job.status !== "processing")
    .sort((a, b) => a[1].finishedAt - b[1].finishedAt);

  while (results.length > maxStoredJobs) {
    editJobs.delete(results.shift()[0]);
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const decodedPath = decodeURIComponent(requestedPath);
  const filePath = path.normalize(path.join(publicDir, decodedPath));

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const content = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": mimeByExt.get(ext) || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Nenalezeno");
  }
}

function readRequestBody(req, limit) {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      received += chunk.length;
      if (received > limit) {
        reject(new Error("Nahrany soubor je prilis velky."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function parseJsonResponse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function publicError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function fetchOpenAiWithRetry(form) {
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await fetch(openAiEditUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`
        },
        body: form
      });
    } catch (error) {
      lastError = error;
      if (attempt < 3) await delay(attempt * 1500);
    }
  }

  const networkError = new Error(
    "Nepodarilo se pripojit k OpenAI API. Zkontrolujte internetove pripojeni, VPN/firewall nebo to zkuste za chvili znovu."
  );
  networkError.cause = lastError;
  networkError.statusCode = 502;
  throw networkError;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadDotenv() {
  const envPath = path.join(__dirname, ".env");
  if (!existsSync(envPath)) return;

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...valueParts] = trimmed.split("=");
    if (!process.env[key]) {
      process.env[key] = valueParts.join("=").replace(/^["']|["']$/g, "");
    }
  }
}

function formatFromMime(mimeType) {
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") return "jpeg";
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  return null;
}

function supportedImageSize(width, height) {
  const original = normalizeToConstraints(width, height);
  return {
    ...original,
    usedOriginalSize: original.width === width && original.height === height
  };
}

function normalizeToConstraints(width, height) {
  const ratio = width / height;
  let nextWidth = width;
  let nextHeight = height;
  const maxPixels = 8294400;

  const maxEdge = Math.max(nextWidth, nextHeight);
  if (maxEdge > 3840) {
    const scale = 3840 / maxEdge;
    nextWidth *= scale;
    nextHeight *= scale;
  }

  const pixels = nextWidth * nextHeight;
  if (pixels > maxPixels) {
    const scale = Math.sqrt(maxPixels / pixels);
    nextWidth *= scale;
    nextHeight *= scale;
  }

  if (Math.max(ratio, 1 / ratio) > 3) {
    if (ratio > 3) {
      nextWidth = nextHeight * 3;
    } else {
      nextHeight = nextWidth * 3;
    }
  }

  nextWidth = roundToMultiple(nextWidth, 16);
  nextHeight = roundToMultiple(nextHeight, 16);

  while (nextWidth * nextHeight > maxPixels) {
    if (nextWidth >= nextHeight) {
      nextWidth -= 16;
    } else {
      nextHeight -= 16;
    }
  }

  const minPixels = 655360;
  if (nextWidth * nextHeight < minPixels) {
    const scale = Math.sqrt(minPixels / (nextWidth * nextHeight));
    nextWidth = ceilToMultiple(nextWidth * scale, 16);
    nextHeight = ceilToMultiple(nextHeight * scale, 16);
  }

  nextWidth = clamp(nextWidth, 16, 3840);
  nextHeight = clamp(nextHeight, 16, 3840);

  return { width: nextWidth, height: nextHeight };
}

function roundToMultiple(value, multiple) {
  return Math.max(multiple, Math.round(value / multiple) * multiple);
}

function ceilToMultiple(value, multiple) {
  return Math.max(multiple, Math.ceil(value / multiple) * multiple);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sanitizeFileName(fileName) {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

function outputName(fileName, extension) {
  const parsed = path.parse(fileName);
  return `${parsed.name || "mistnost"}-bez-nabytku.${extension}`;
}
