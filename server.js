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
const visionModel = process.env.OPENAI_VISION_MODEL || "gpt-4.1-mini";
const imageQuality = readImageQuality(process.env.OPENAI_IMAGE_QUALITY);
const maxOutputEdge = readPositiveInteger(process.env.OPENAI_MAX_OUTPUT_EDGE, 1536);
const maxOutputPixels = readPositiveInteger(process.env.OPENAI_MAX_OUTPUT_PIXELS, 2359296);
const draftOutputEdge = readPositiveInteger(process.env.OPENAI_DRAFT_OUTPUT_EDGE, 1024);
const draftOutputPixels = readPositiveInteger(process.env.OPENAI_DRAFT_OUTPUT_PIXELS, 1048576);
const webOutputEdge = readPositiveInteger(process.env.OPENAI_WEB_OUTPUT_EDGE, 2048);
const webOutputPixels = readPositiveInteger(process.env.OPENAI_WEB_OUTPUT_PIXELS, 4194304);
const webOutputCompression = readCompressionValue(process.env.OPENAI_WEB_OUTPUT_COMPRESSION, 5);
const maxJsonBytes = 75 * 1024 * 1024;
const openAiEditUrl = "https://api.openai.com/v1/images/edits";
const openAiResponsesUrl = "https://api.openai.com/v1/responses";
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

    if (req.method === "POST" && req.url === "/api/analyze-objects") {
      await handleAnalyzeObjects(req, res);
      return;
    }

    if (req.method === "POST" && req.url === "/api/find-object") {
      await handleFindObject(req, res);
      return;
    }

    if (req.method === "POST" && req.url === "/api/plan-edit") {
      await handlePlanEdit(req, res);
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

async function handleAnalyzeObjects(req, res) {
  if (!apiKey) {
    sendJson(res, 500, {
      error: "Chybi OPENAI_API_KEY. Doplnte ho do souboru .env nebo promenne prostredi."
    });
    return;
  }

  const body = await readRequestBody(req, maxJsonBytes);
  const payload = JSON.parse(body);
  const { imageData, mimeType } = payload;
  if (!imageData || !mimeType || !formatFromMime(mimeType)) {
    sendJson(res, 400, { error: "Chybi podporovany obrazek pro analyzu." });
    return;
  }

  const data = await fetchOpenAiJsonWithRetry(openAiResponsesUrl, {
    model: visionModel,
    input: [{
      role: "user",
      content: [
        {
          type: "input_text",
          text: [
            "Analyze this real-estate room photo and identify removable targets for an image editing UI.",
            "Return both individual objects and useful grouped targets.",
            "Important grouped targets include loose items on top of a dresser/table/bed, clutter on a surface, bedding or textiles on a bed, and movable furniture.",
            "Always include visible houseplants and flower pots as their own individual removable targets, even when they are close to another target.",
            "If an object is next to or partly in front of a selected furniture candidate, include it separately as well.",
            "Do not include fixed architecture such as windows, doors, radiators, walls, floor, ceiling or built-in kitchen.",
            "Each target must be understandable without coordinates: describe visual appearance, exact location, nearby anchors, and what should remain unchanged.",
            "Use Czech labels, descriptions, removePromptCs and keepPromptCs for the user. Also write removePrompt and keepPrompt in English for the image editing model."
          ].join(" ")
        },
        {
          type: "input_image",
          image_url: imageData,
          detail: "high"
        }
      ]
    }],
    text: {
      format: {
        type: "json_schema",
        name: "room_removal_targets",
        strict: true,
        schema: objectTargetsSchema()
      }
    }
  });

  const text = extractResponseText(data);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw publicError("Analyza nevratila platny seznam predmetu.", 502);
  }

  const targets = Array.isArray(parsed.targets) ? parsed.targets.slice(0, 18) : [];
  sendJson(res, 200, { targets });
}

async function handleFindObject(req, res) {
  if (!apiKey) {
    sendJson(res, 500, {
      error: "Chybi OPENAI_API_KEY. Doplnte ho do souboru .env nebo promenne prostredi."
    });
    return;
  }

  const body = await readRequestBody(req, maxJsonBytes);
  const payload = JSON.parse(body);
  const { imageData, mimeType, query } = payload;
  if (!imageData || !mimeType || !formatFromMime(mimeType) || !String(query || "").trim()) {
    sendJson(res, 400, { error: "Chybi obrazek nebo dotaz na predmet." });
    return;
  }

  const data = await fetchOpenAiJsonWithRetry(openAiResponsesUrl, {
    model: visionModel,
    input: [{
      role: "user",
      content: [
        {
          type: "input_text",
          text: [
            "The user is asking whether a specific object is visible in this real-estate room photo.",
            "If you can identify it, create one removable target for an image editing UI.",
            "Describe it by visual appearance, exact location, nearby anchors, and what should remain unchanged.",
            "If the object is not clearly visible, set found to false and explain briefly in Czech.",
            "Use Czech label, description, removePromptCs and keepPromptCs for the user.",
            "Also write removePrompt and keepPrompt in English for the image editing model.",
            `User query: ${sanitizeInstruction(query)}`
          ].join(" ")
        },
        {
          type: "input_image",
          image_url: imageData,
          detail: "high"
        }
      ]
    }],
    text: {
      format: {
        type: "json_schema",
        name: "single_room_removal_target",
        strict: true,
        schema: singleObjectTargetSchema()
      }
    }
  });

  const text = extractResponseText(data);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw publicError("Vyhledani predmetu nevratilo platnou odpoved.", 502);
  }

  sendJson(res, 200, parsed);
}

async function handlePlanEdit(req, res) {
  if (!apiKey) {
    sendJson(res, 500, {
      error: "Chybi OPENAI_API_KEY. Doplnte ho do souboru .env nebo promenne prostredi."
    });
    return;
  }

  const body = await readRequestBody(req, maxJsonBytes);
  const payload = JSON.parse(body);
  const { imageData, annotatedImageData, mimeType, markers, currentPlan, message } = payload;
  if (!imageData || !annotatedImageData || !mimeType || !formatFromMime(mimeType) || !Array.isArray(markers) || markers.length === 0) {
    sendJson(res, 400, { error: "Chybi fotka nebo znacky pro plan upravy." });
    return;
  }

  const markerLines = markers.slice(0, 30).map((marker) => {
    const type = marker.type === "keep" ? "KEEP / ponechat" : "REMOVE / odstranit";
    return `${marker.index}: ${type}, normalized position x=${Number(marker.x).toFixed(3)}, y=${Number(marker.y).toFixed(3)}`;
  });

  const data = await fetchOpenAiJsonWithRetry(openAiResponsesUrl, {
    model: visionModel,
    input: [{
      role: "user",
      content: [
        {
          type: "input_text",
          text: [
            "You are planning a real-estate image edit before the image editing model runs.",
            "The first image is the original/current room photo. The second image is the same photo with colored numbered markers overlaid.",
            "Red/pink numbered markers mean: remove the complete object at or nearest that marker. A marker is only a pointer to the object, not a pixel mask.",
            "Blue numbered markers mean: keep the complete object at or nearest that marker unchanged.",
            "Infer the complete object using visual context, object boundaries, legs, shadows and relationship to nearby items.",
            "Write a concise Czech edit plan that the user can review and edit.",
            "The plan must explicitly list what to remove and what to keep.",
            "Always lock unchanged architecture by default: windows, doors, radiators, walls, ceiling, floor, fixed lights, sockets, switches, trim, perspective and camera angle.",
            "Never move, resize or redesign windows. Never invent a new chandelier or lamp. Keep existing fixed lighting unless explicitly marked red.",
            "When a wardrobe/cabinet/shelf/bed/furniture is removed, reconstruct the newly visible wall or floor as the same plain wall/floor continuation, not as a ghost, print, texture or replacement furniture.",
            "Do not add new furniture, decor, text, logos, people or staging.",
            "If the user asks a follow-up, revise the current plan accordingly.",
            "Return only JSON matching the schema.",
            `Markers: ${markerLines.join(" | ")}`,
            currentPlan ? `Current plan to revise: ${sanitizeInstruction(currentPlan)}` : "No current plan yet.",
            message ? `User follow-up: ${sanitizeInstruction(message)}` : "User follow-up: create the first plan."
          ].join(" ")
        },
        {
          type: "input_image",
          image_url: imageData,
          detail: "high"
        },
        {
          type: "input_image",
          image_url: annotatedImageData,
          detail: "high"
        }
      ]
    }],
    text: {
      format: {
        type: "json_schema",
        name: "room_edit_plan",
        strict: true,
        schema: editPlanSchema()
      }
    }
  });

  const text = extractResponseText(data);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw publicError("Plan upravy nebyl vracen jako platne JSON.", 502);
  }

  sendJson(res, 200, {
    plan: parsed.plan,
    summary: parsed.summary
  });
}

async function handleRemoveFurniture(req, res) {
  if (!apiKey) {
    sendJson(res, 500, {
      error: "Chybi OPENAI_API_KEY. Doplnte ho do souboru .env nebo promenne prostredi."
    });
    return;
  }

  const body = await readRequestBody(req, maxJsonBytes);
  const payload = JSON.parse(body);
  const { imageData, mimeType, fileName, width, height, maskData } = payload;

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
  let maskBuffer = null;
  if (maskData) {
    if (!String(maskData).startsWith("data:image/png;base64,")) {
      sendJson(res, 400, { error: "Maska oznaceni musi byt odeslana jako PNG." });
      return;
    }
    maskBuffer = Buffer.from(String(maskData).replace(/^data:image\/png;base64,/i, ""), "base64");
  }
  const operation = normalizeEditOperation(payload.operation);
  const isDraft = payload.draft === true;
  const size = supportedImageSize(Number(width), Number(height), isDraft, operation);
  const extension = "jpg";
  const safeName = sanitizeFileName(fileName || `mistnost.${inputFormat === "jpeg" ? "jpg" : inputFormat}`);
  const prompt = buildEditPrompt({ ...payload, operation });

  const form = new FormData();
  form.append("model", imageModel);
  form.append("prompt", prompt);
  if (maskBuffer) {
    form.append("image[]", new File([imageBuffer], replaceExtension(safeName, "png"), { type: "image/png" }));
    form.append("mask", new File([maskBuffer], "maska-predmetu.png", { type: "image/png" }));
  } else {
    form.append("image", new File([imageBuffer], safeName, { type: mimeType }));
  }
  form.append("size", `${size.width}x${size.height}`);
  form.append("quality", isDraft ? "low" : operation === "web-quality" ? "high" : imageQuality);
  form.append("output_format", outputFormat);

  if (outputFormat === "jpeg" || outputFormat === "webp") {
    form.append("output_compression", isDraft ? "60" : operation === "web-quality" ? String(webOutputCompression) : "40");
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
    operation,
    patch: payload.patch,
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
      fileName: outputName(edit.safeName, edit.extension, edit.operation),
      width: edit.size.width,
      height: edit.size.height,
      byteSize: Buffer.byteLength(b64, "base64"),
      patch: edit.patch,
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

async function fetchOpenAiJsonWithRetry(url, payload) {
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }

      if (!response.ok) {
        throw publicError(data?.error?.message || "OpenAI API vratilo chybu pri analyze obrazku.", response.status);
      }

      return data;
    } catch (error) {
      lastError = error;
      if (error.statusCode) throw error;
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

function extractResponseText(data) {
  if (typeof data?.output_text === "string") return data.output_text;
  const parts = [];
  for (const output of data?.output || []) {
    for (const item of output.content || []) {
      if (typeof item.text === "string") parts.push(item.text);
    }
  }
  return parts.join("\n").trim();
}

function objectTargetsSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      targets: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            label: { type: "string" },
            type: {
              type: "string",
              enum: ["furniture", "loose_object", "surface_group", "textile_group", "plant", "other"]
            },
            description: { type: "string" },
            location: { type: "string" },
            removePrompt: { type: "string" },
            keepPrompt: { type: "string" },
            removePromptCs: { type: "string" },
            keepPromptCs: { type: "string" },
            confidence: { type: "number" }
          },
          required: ["id", "label", "type", "description", "location", "removePrompt", "keepPrompt", "removePromptCs", "keepPromptCs", "confidence"]
        }
      }
    },
    required: ["targets"]
  };
}

function singleObjectTargetSchema() {
  const targetSchema = objectTargetsSchema().properties.targets.items;
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      found: { type: "boolean" },
      message: { type: "string" },
      target: targetSchema
    },
    required: ["found", "message", "target"]
  };
}

function editPlanSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: { type: "string" },
      plan: { type: "string" }
    },
    required: ["summary", "plan"]
  };
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
  const operation = normalizeEditOperation(payload.operation);
  const instruction = sanitizeInstruction(payload.instruction);
  const common = [
    "Photorealistic real estate photo edit.",
    "Edit only what the current user instruction asks for.",
    "Preserve the camera angle, room layout, architecture, windows, doors, radiators, walls, floor, fixed fixtures, colors and realistic lighting.",
    "Do not move, resize, redesign or replace windows, doors, radiators, fixed lights, ceiling lights, sockets, switches, floor, ceiling, walls, trim or perspective.",
    "Do not invent or add a chandelier, lamp, furniture, decor, people, text, logos or watermarks."
  ];

  if (operation === "retouch") {
    return [
      ...common,
      "Task type: retouch the existing photo, not furniture removal.",
      "Correct only the requested imperfection or local appearance change.",
      `Current user instruction: ${instruction || "Retouch the marked area naturally."}`,
      "Return a natural, realistic result."
    ].join(" ");
  }

  if (operation === "enhance") {
    return [
      ...common,
      "Task type: professional real-estate photo enhancement and post-production, not furniture removal and not virtual staging.",
      "Make the improvement clearly visible while staying realistic and honest for a property listing.",
      "Apply professional interior photography post-production: correct exposure, open shadows, recover highlights, neutralize color cast, improve white balance, add natural contrast, moderate saturation, clarity, sharpening, noise reduction and mild vertical/perspective correction.",
      "The result should look brighter, cleaner, sharper and more attractive for selling the property, but not artificial.",
      "Do not add, remove, move, replace or redesign any object.",
      `Current user instruction: ${instruction || "Create a realistic professional interior real-estate photo edit."}`,
      "Return the same room as an honest, natural real-estate listing photograph."
    ].join(" ");
  }

  if (operation === "web-quality") {
    return [
      ...common,
      "Task type: final high-quality web output for a real-estate listing photo, not furniture removal and not virtual staging.",
      "Keep the exact same room, composition, camera angle, layout and all objects. Do not add, remove, move, replace, redesign or restage anything.",
      "Perform realistic super-resolution/upscaling and detail reconstruction for a web listing image.",
      "Improve only image quality and web presentation: remove blotchy compression artifacts, banding, smearing, blockiness and patchy wall or floor texture; reduce noise, refine fine detail, add natural sharpening, balance tones, improve local contrast, neutralize color cast and keep colors realistic.",
      "The result should look crisp, clean and professional on a real-estate website, while remaining honest and natural, with no artificial plastic look.",
      `Current user instruction: ${instruction || "Create a high-quality web-ready real-estate photo output."}`,
      "Return the same photo content with higher actual and perceived image quality."
    ].join(" ");
  }

  if (operation === "privacy") {
    return [
      ...common,
      "Task type: privacy cleanup and anonymization for a real-estate photo, not room clearing, not decluttering and not furniture removal.",
      "Remove, blur or neutralize only private or identifying content: family photos, portraits, names on documents, letters, receipts, diplomas, children's drawings with names, visible faces in reflections, license plates, ID numbers and readable personal data.",
      "If the private content is part of a larger object, such as a framed photo, paper on a table, diploma on a wall or magnet/photo on a fridge, alter only the identifying content and preserve the frame, furniture, wall, surface and surrounding object naturally.",
      "Keep all furniture, decorations, clutter, plants, tableware, rugs, curtains, architecture, lighting, camera angle and room layout unchanged unless the item itself is private identifying content.",
      "Do not generally tidy the room and do not remove ordinary decor.",
      `Current user instruction: ${instruction || "Hide private identifying items only."}`,
      "Return the same room with only private identifying content hidden naturally."
    ].join(" ");
  }

  const isRoomClearing = /vyklid|celou mistnost|vsechen pohyblivy|vsechen nabytek|clear the room|remove all furniture/i.test(instruction);
  const isDecluttering = /uklid pokoj|drobne volne|neporadek|osobni veci|declutter/i.test(instruction);
  const mentionsFloorCovering = /\b(rug|carpet)\b|koberec|koberecky|koberc/i.test(instruction);

  if (isRoomClearing) {
    return [
      ...common,
      "Task type: full room clearing for real estate. Remove movable furniture, decorations and loose objects from the room.",
      "Keep architecture and fixed elements: walls, ceiling, floor, windows, doors, radiators, built-in fixtures, lights, sockets, switches, trim and perspective.",
      "Reconstruct newly visible floor and wall areas naturally and consistently.",
      `Current user instruction: ${instruction || "Clear the room of movable furniture and loose objects."}`,
      "Return the same room emptied of movable items, with fixed room features preserved."
    ].join(" ");
  }

  if (isDecluttering) {
    return [
      ...common,
      "Task type: light decluttering, not room clearing and not furniture removal.",
      "Remove only small loose clutter, personal items and messy small objects lying on surfaces such as tables, dressers, shelves, the floor, seating or beds.",
      "If the instruction asks to hide private or identifying items, remove, blur or neutralize only the identifying/private content such as family photos, names, documents, license plates, faces in reflections, IDs or readable personal text.",
      "When anonymizing a personal item that sits on or inside furniture, preserve the supporting furniture, shelf, table, frame, wall and surrounding surface naturally.",
      "Keep all furniture and large items unchanged, including rugs/carpets, tables, chairs, sofas, armchairs, cabinets, shelves, curtains, wall art, lamps, plants, appliances and large decorations.",
      "Do not remove tableware or intentionally staged decor unless it clearly appears as small loose clutter requested by the user.",
      "Reconstruct only tiny newly visible surfaces naturally.",
      `Current user instruction: ${instruction || "Declutter the room lightly."}`,
      "Return the same room, just tidier, with furniture and larger objects still in place."
    ].join(" ");
  }

  return [
    ...common,
    "Task type: targeted local object removal, not room clearing, decluttering, staging, or removing all movable objects.",
    payload.maskData
      ? "You are editing only a cropped patch from the room. Unmasked pixels inside this crop are visual context and must stay unchanged. The full room outside this crop will be composited back unchanged. Remove only the complete object or objects described by the user inside the masked area, including legs, edges, contact shadows and small attached parts. Preserve the crop edges so it blends back into the original photo."
      : "Remove only the exact selected target object or group described by the user. Do not remove any other furniture, decorations, clutter, table, chairs, cabinet contents, plants, textiles, or loose objects unless they are explicitly named as selected targets.",
    mentionsFloorCovering
      ? "The selected target appears to be a rug or carpet. Remove only the rug/carpet floor covering. Keep all tables, chairs, sofas, cabinets, shelves, plants, tableware, dishes, bowls, decorative items, and cabinet contents exactly unchanged, even if they touch, overlap, stand on, or are near the rug/carpet."
      : "",
    "Fill the revealed area with the natural continuation of the existing floor, wall, trim, light and shadows.",
    "If a cabinet, wardrobe, shelf, bed or other furniture is removed from in front of a wall, reconstruct only the plain continuous wall and floor that would naturally be behind it. Do not leave a ghost silhouette, cabinet-shaped wall texture, fake panel, artwork, print or replacement furniture.",
    "Preserve all unselected objects exactly, even if they are movable or removable.",
    `Current user instruction: ${instruction || "Remove the requested movable object."}`,
    "Return the same room with only the requested selected target removed naturally."
  ].join(" ");
}

function normalizeEditOperation(value) {
  return ["retouch", "enhance", "web-quality", "privacy"].includes(value) ? value : "remove";
}

function sanitizeInstruction(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 4000);
}

function supportedImageSize(width, height, draft = false, operation = "remove") {
  const original = normalizeToConstraints(width, height, draft, operation);
  return {
    ...original,
    usedOriginalSize: original.width === width && original.height === height
  };
}

function normalizeToConstraints(width, height, draft = false, operation = "remove") {
  const ratio = width / height;
  let nextWidth = width;
  let nextHeight = height;
  const apiMaxEdge = 3840;
  const apiMaxPixels = 8294400;
  const isWebQuality = operation === "web-quality" && !draft;
  const targetMaxEdge = Math.min(draft ? draftOutputEdge : isWebQuality ? webOutputEdge : maxOutputEdge, apiMaxEdge);
  const targetMaxPixels = Math.min(draft ? draftOutputPixels : isWebQuality ? webOutputPixels : maxOutputPixels, apiMaxPixels);

  if (isWebQuality) {
    const maxEdge = Math.max(nextWidth, nextHeight);
    if (maxEdge < targetMaxEdge) {
      const scale = targetMaxEdge / maxEdge;
      nextWidth *= scale;
      nextHeight *= scale;
    }
  }

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

function readCompressionValue(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? clamp(parsed, 0, 100) : fallback;
}

function readImageQuality(value) {
  return ["low", "medium", "high", "auto"].includes(value) ? value : "medium";
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sanitizeFileName(fileName) {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

function replaceExtension(fileName, extension) {
  const parsed = path.parse(fileName);
  return `${parsed.name || "mistnost"}.${extension}`;
}

function outputName(fileName, extension, operation = "remove") {
  const parsed = path.parse(fileName);
  const suffix = operation === "enhance"
    ? "prodejni-foto"
    : operation === "web-quality"
      ? "web-kvalita"
      : operation === "privacy"
        ? "soukromi"
        : "bez-nabytku";
  return `${parsed.name || "mistnost"}-${suffix}.${extension}`;
}
