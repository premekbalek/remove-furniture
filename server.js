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
const imageQuality = readImageQuality(process.env.OPENAI_IMAGE_QUALITY);
const maxOutputEdge = readPositiveInteger(process.env.OPENAI_MAX_OUTPUT_EDGE, 2048);
const maxOutputPixels = readPositiveInteger(process.env.OPENAI_MAX_OUTPUT_PIXELS, 3686400);
const maxJsonBytes = 75 * 1024 * 1024;
const openAiEditUrl = "https://api.openai.com/v1/images/edits";
const editJobTtlMs = 60 * 60 * 1000;
const maxStoredJobs = 10;
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

    if (req.method === "DELETE" && req.url.startsWith("/api/remove-furniture/")) {
      handleCancelEditJob(req, res);
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
  const { imageData, mimeType, fileName, width, height, markerData } = payload;

  if (!imageData || !mimeType || !width || !height) {
    sendJson(res, 400, { error: "Chybi obrazek nebo jeho rozmery." });
    return;
  }

  const inputFormat = formatFromMime(mimeType);
  if (!inputFormat) {
    sendJson(res, 400, { error: "Podporovane formaty jsou JPEG, PNG a WebP." });
    return;
  }

  const outputFormat = "jpeg";
  const base64 = String(imageData).replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
  const imageBuffer = Buffer.from(base64, "base64");
  let markerBuffer = null;
  if (markerData) {
    if (!String(markerData).startsWith("data:image/jpeg;base64,")) {
      sendJson(res, 400, { error: "Oznaceny referencni obrazek musi byt odeslan jako JPEG." });
      return;
    }
    markerBuffer = Buffer.from(String(markerData).replace(/^data:image\/jpeg;base64,/i, ""), "base64");
  }
  const size = supportedImageSize(Number(width), Number(height));
  const extension = "jpg";
  const safeName = sanitizeFileName(fileName || `mistnost.${inputFormat === "jpeg" ? "jpg" : inputFormat}`);
  const prompt = buildEditPrompt(payload);

  const form = new FormData();
  form.append("model", imageModel);
  form.append("prompt", prompt);
  if (markerBuffer) {
    form.append("image[]", new File([imageBuffer], safeName, { type: mimeType }));
    form.append("image[]", new File([markerBuffer], "oznaceny-predmet.jpg", { type: "image/jpeg" }));
  } else {
    form.append("image", new File([imageBuffer], safeName, { type: mimeType }));
  }
  form.append("size", `${size.width}x${size.height}`);
  form.append("quality", imageQuality);
  form.append("output_format", outputFormat);

  if (outputFormat === "jpeg" || outputFormat === "webp") {
    form.append("output_compression", "0");
  }

  pruneEditJobs();
  const jobId = randomUUID();
  editJobs.set(jobId, {
    status: "processing",
    createdAt: Date.now()
  });

  sendJson(res, 202, { jobId, status: "processing" });

  void processEditJob(jobId, {
    form,
    outputFormat,
    extension,
    safeName,
    size
  });
}

function handleEditJobStatus(req, res) {
  pruneEditJobs();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const jobId = url.pathname.split("/").pop();
  const job = editJobs.get(jobId);

  if (!job) {
    sendJson(res, 404, { error: "Uloha uz neni dostupna. Zpracujte fotku znovu." });
    return;
  }

  if (job.status === "completed") {
    sendJson(res, 200, { status: job.status, ...job.result });
    return;
  }

  if (job.status === "failed") {
    sendJson(res, 200, { status: job.status, error: job.error });
    return;
  }

  if (job.status === "canceled") {
    sendJson(res, 200, { status: job.status });
    return;
  }

  sendJson(res, 200, { status: job.status });
}

function handleCancelEditJob(req, res) {
  pruneEditJobs();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const jobId = url.pathname.split("/").pop();
  const job = editJobs.get(jobId);

  if (job) {
    job.status = "canceled";
    job.finishedAt = Date.now();
  }

  sendJson(res, 200, { status: "canceled" });
}

async function processEditJob(jobId, edit) {
  try {
    const openAiResponse = await fetchOpenAiWithRetry(edit.form);
    const responseText = await openAiResponse.text();
    let data;
    try {
      data = JSON.parse(responseText);
    } catch {
      data = null;
    }

    if (!openAiResponse.ok) {
      throw publicError(
        data?.error?.message || "OpenAI API vratilo chybu pri uprave obrazku.",
        openAiResponse.status
      );
    }

    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) {
      throw publicError("Odpoved neobsahovala upraveny obrazek.", 502);
    }

    const job = editJobs.get(jobId);
    if (!job || job.status === "canceled") return;
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
    if (!job || job.status === "canceled") return;
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

  const storedResults = [...editJobs.entries()]
    .filter(([, job]) => job.status !== "processing")
    .sort((a, b) => a[1].finishedAt - b[1].finishedAt);

  while (storedResults.length > maxStoredJobs) {
    const [jobId] = storedResults.shift();
    editJobs.delete(jobId);
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

function buildEditPrompt(payload) {
  const operation = payload.operation === "retouch" ? "retouch" : "remove";
  const instruction = sanitizeInstruction(payload.instruction);
  const markerGuidance = payload.markerData
    ? "A second reference image is supplied with a red user mark. The red mark is only a pointer to identify the intended object or local area; it is not the full edit boundary. Remove or retouch the complete object or issue described by the user that the red mark points to. Do not leave half of the object behind just because only part of it was marked. Do not reproduce the red mark in the output."
    : "No red reference mark is supplied. Identify only the subject described in the user's current instruction.";
  const common = [
    "Photorealistic real estate photo edit.",
    "Preserve an actual fixed kitchen installation exactly as present only when it is clearly identifiable by food-preparation features such as a continuous countertop, backsplash, sink, tap, cooktop, oven or integrated appliance, including its connected cabinetry and fixed island.",
    "A freestanding or living-room wall unit, display cabinet, vitrine, sideboard, bookcase, wardrobe, dresser or storage cabinet is not a kitchen, even if its wooden appearance resembles kitchen cabinetry.",
    "Preserve the original camera angle, room layout, architecture, built-in fixtures, materials, colors, exposure, contrast and overall image realism.",
    "Outside the explicitly requested local edit, preserve all visible surfaces, their patterns, color, texture, reflections and perspective.",
    "Never change the room architecture or layout. Never add, remove, move, or redesign doors, windows, window openings, frames, radiators, ceiling edges, wall corners, switches or outlets unless the user explicitly asks for that exact architectural change.",
    "When removing curtains, drapes, blinds, shades or window coverings, remove only the fabric or covering itself. Preserve the existing window opening, glass, frame, sill, wall, radiator, incoming daylight and shadows; reveal only the natural continuation of the already visible window and wall.",
    "Do not add new furniture, decor, text, logos, people, watermarks or unrealistic objects."
  ];

  if (operation === "retouch") {
    return [
      ...common,
      "Task type: retouch the existing photo, not furniture removal.",
      markerGuidance,
      "Correct only the requested imperfection or local appearance change, including a marked wall or floor surface when requested.",
      "If the user asks to remove a local object or covering during retouching, remove only that named object inside the marked area and inpaint with the physically expected continuation of the existing scene. Do not replace it with a different object or architectural feature.",
      `Current user instruction: ${instruction || "Retouch the marked area naturally."}`,
      "Return the same room with a natural, invisible photographic retouch."
    ].join(" ");
  }

  return [
    ...common,
    "Task type: remove existing furniture or movable objects.",
    markerGuidance,
    "Do not alter any floor surface that is already visible in the input image: preserve its exact material, plank or tile pattern, direction, plank width, seams, color, texture, wear, reflections and perspective.",
    "Where removed furniture or rugs reveal hidden floor, extend the nearest visible original flooring seamlessly with the same material, plank or tile direction, scale, seam alignment, color and perspective; never redesign or replace the floor.",
    "Reconstruct only newly revealed hidden areas of floor, walls and trim, together with necessary lighting and shadows.",
    "A described or marked freestanding storage item must be treated as removable furniture, not preserved as a kitchen.",
    "Remove the entire object or objects identified by the current user instruction and, when present, the red reference mark. If the mark touches only part of a chair, table, cabinet, curtain or other object, remove the complete referenced object, not only the marked pixels. If the user explicitly asks to remove everything, remove all movable furniture and loose objects except the preserved kitchen.",
    "For curtains, drapes, blinds, shades or window coverings, remove only the fabric or covering and preserve the existing window, wall and daylight conditions.",
    "The preservation rules for a clearly identifiable fixed kitchen, architecture and already visible surfaces are mandatory. Do not use kitchen preservation to retain ambiguous storage furniture.",
    `Current user instruction: ${instruction || "Remove the marked movable object."}`,
    "Return the same room with the requested object removed and the revealed surfaces reconstructed naturally."
  ].join(" ");
}

function sanitizeInstruction(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 1000);
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
  const apiMaxEdge = 3840;
  const apiMaxPixels = 8294400;
  const targetMaxEdge = Math.min(maxOutputEdge, apiMaxEdge);
  const targetMaxPixels = Math.min(maxOutputPixels, apiMaxPixels);

  const maxEdge = Math.max(nextWidth, nextHeight);
  if (maxEdge > targetMaxEdge) {
    const scale = targetMaxEdge / maxEdge;
    nextWidth *= scale;
    nextHeight *= scale;
  }

  const pixels = nextWidth * nextHeight;
  if (pixels > targetMaxPixels) {
    const scale = Math.sqrt(targetMaxPixels / pixels);
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

  while (nextWidth * nextHeight > targetMaxPixels) {
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

  nextWidth = clamp(nextWidth, 16, apiMaxEdge);
  nextHeight = clamp(nextHeight, 16, apiMaxEdge);

  return { width: nextWidth, height: nextHeight };
}

function roundToMultiple(value, multiple) {
  return Math.max(multiple, Math.round(value / multiple) * multiple);
}

function ceilToMultiple(value, multiple) {
  return Math.max(multiple, Math.ceil(value / multiple) * multiple);
}

function readPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readImageQuality(value) {
  return ["low", "medium", "high", "auto"].includes(value) ? value : "high";
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
