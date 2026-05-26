import { createServer } from "node:http";
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
const furnitureCategories = new Map([
  ["bed", "beds, bed frames, mattresses and their bedding"],
  ["seating", "sofas, couches, armchairs and lounge chairs"],
  ["table", "dining tables, desks and coffee tables"],
  ["chairs", "dining chairs, desk chairs and stools"],
  ["storage", "freestanding wardrobes, dressers and cabinets"],
  ["tv_unit", "televisions and freestanding TV stands"],
  ["shelves", "freestanding shelving units and bookcases"],
  ["rug", "rugs and loose carpets"]
]);

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
  const prompt = buildEditPrompt(payload);

  if (!prompt) {
    sendJson(res, 400, { error: "Vyberte alespon jeden kus nabytku k odstraneni." });
    return;
  }

  const form = new FormData();
  form.append("model", imageModel);
  form.append("prompt", prompt);
  form.append("image", new File([imageBuffer], safeName, { type: mimeType }));
  form.append("size", `${size.width}x${size.height}`);
  form.append("quality", imageQuality);
  form.append("output_format", outputFormat);

  if (outputFormat === "jpeg" || outputFormat === "webp") {
    form.append("output_compression", "0");
  }

  const openAiResponse = await fetchOpenAiWithRetry(form);

  const responseText = await openAiResponse.text();
  let data;
  try {
    data = JSON.parse(responseText);
  } catch {
    data = null;
  }

  if (!openAiResponse.ok) {
    const message = data?.error?.message || "OpenAI API vratilo chybu pri uprave obrazku.";
    sendJson(res, openAiResponse.status, { error: message });
    return;
  }

  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) {
    sendJson(res, 502, { error: "Odpoved neobsahovala upraveny obrazek." });
    return;
  }

  sendJson(res, 200, {
    imageData: `data:image/${outputFormat};base64,${b64}`,
    mimeType: `image/${outputFormat}`,
    fileName: outputName(safeName, extension),
    width: size.width,
    height: size.height,
    usedOriginalSize: size.usedOriginalSize
  });
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
  const common = [
    "Photorealistic real estate photo edit.",
    "Always preserve any kitchen cabinetry, countertops, backsplash, integrated appliances, sink, tap and fixed kitchen island exactly as present in the original image.",
    "Preserve the original camera angle, room layout, architecture, built-in fixtures, materials, colors, exposure, contrast and overall image realism.",
    "Reconstruct any newly visible floor, walls, trim, lighting and shadows naturally.",
    "Do not add new furniture, decor, text, logos, people, watermarks or unrealistic objects."
  ];

  if (payload.removalMode !== "selected") {
    return [
      ...common,
      "Remove all movable furniture and loose household furnishing or decor items from the room, except for the preserved kitchen elements.",
      "Return the same room empty of movable furniture while keeping the kitchen intact."
    ].join(" ");
  }

  const categories = Array.isArray(payload.removeCategories)
    ? payload.removeCategories.filter((category) => furnitureCategories.has(category))
    : [];
  const selected = [...new Set(categories)].map((category) => furnitureCategories.get(category));

  if (!selected.length) return null;

  return [
    ...common,
    `Remove only these furniture categories when present: ${selected.join("; ")}.`,
    "Keep all other unselected furniture and small decorative objects unchanged.",
    "Return the same room with only the specified furniture removed."
  ].join(" ");
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
