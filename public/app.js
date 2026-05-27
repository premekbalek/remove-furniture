const fileInput = document.querySelector("#fileInput");
const cameraInput = document.querySelector("#cameraInput");
const removeButton = document.querySelector("#removeButton");
const shareButton = document.querySelector("#shareButton");
const downloadButton = document.querySelector("#downloadButton");
const originalImage = document.querySelector("#originalImage");
const resultImage = document.querySelector("#resultImage");
const originalFrame = document.querySelector("#originalFrame");
const resultFrame = document.querySelector("#resultFrame");
const statusText = document.querySelector("#statusText");
const resultPlaceholder = document.querySelector("#resultPlaceholder");
const spinner = document.querySelector("#spinner");
const chatThread = document.querySelector("#chatThread");
const instructionForm = document.querySelector("#instructionForm");
const instructionInput = document.querySelector("#instructionInput");
const instructionButton = document.querySelector("#instructionButton");
const modeInputs = document.querySelectorAll('input[name="editMode"]');
const modeHelp = document.querySelector("#modeHelp");
const selectionCanvas = document.querySelector("#selectionCanvas");
const brushSize = document.querySelector("#brushSize");
const clearSelectionButton = document.querySelector("#clearSelectionButton");
const activeJobStorageKey = "removeFurniture.activeJobId";
const pollDelayMs = 2500;

let selectedFile = null;
let originalDataUrl = null;
let originalSize = null;
let workingDataUrl = null;
let workingMimeType = null;
let workingFileName = null;
let workingSize = null;
let resultFile = null;
let editMode = "remove";
let isBusy = false;
let selectionStrokes = [];
let activeStroke = null;

fileInput.addEventListener("change", () => handleFileSelection(fileInput));
cameraInput.addEventListener("change", () => handleFileSelection(cameraInput));
instructionInput.addEventListener("input", updateActionButtons);
modeInputs.forEach((input) => input.addEventListener("change", handleModeChange));
clearSelectionButton.addEventListener("click", clearSelection);
selectionCanvas.addEventListener("pointerdown", startSelectionStroke);
selectionCanvas.addEventListener("pointermove", continueSelectionStroke);
selectionCanvas.addEventListener("pointerup", endSelectionStroke);
selectionCanvas.addEventListener("pointercancel", endSelectionStroke);
window.addEventListener("resize", renderSelection);

async function handleFileSelection(input) {
  const [file] = input.files;
  if (!file) return;

  resetResult();
  resetConversation();
  statusText.textContent = "Nacitam fotku...";

  const normalized = await normalizeSelectedImage(file);
  selectedFile = normalized.file;
  originalDataUrl = normalized.dataUrl;
  originalSize = await getImageSize(originalDataUrl);
  workingDataUrl = originalDataUrl;
  workingMimeType = selectedFile.type;
  workingFileName = selectedFile.name;
  workingSize = originalSize;

  originalImage.src = originalDataUrl;
  originalFrame.classList.remove("empty");
  resultImage.src = workingDataUrl;
  resultFrame.classList.remove("empty");
  resultPlaceholder.hidden = true;
  clearSelection();
  updateActionButtons();
  const conversionNote = normalized.converted ? " | prevedeno na JPEG pro zpracovani" : " | pripraveno pro zpracovani";
  statusText.textContent = `${selectedFile.name} | ${originalSize.width} x ${originalSize.height}px${conversionNote}`;
}

removeButton.addEventListener("click", () => {
  clearSelection();
  submitInstruction(
    "Odstran vsechen pohyblivy nabytek a volne predmety. Nic krome kuchynske linky neponechavej.",
    "remove"
  );
});

instructionForm.addEventListener("submit", (event) => {
  event.preventDefault();
  submitInstruction(instructionInput.value, editMode);
});

function submitInstruction(value, operation) {
  if (!workingDataUrl || !workingSize) return;
  const instruction = value.trim();
  if (!instruction) return;

  const hasMask = selectionStrokes.length > 0;
  const operationName = operation === "retouch" ? "Retus" : "Odstraneni";
  appendChatMessage("user", `${operationName}${hasMask ? " (oznacena oblast)" : ""}: ${instruction}`);
  instructionInput.value = "";
  const maskData = hasMask ? createMaskDataUrl() : null;
  updateActionButtons();
  void requestEdit({ instruction, operation, maskData });
}

async function requestEdit(edit) {
  if (!workingDataUrl || !workingSize) return;

  setBusy(true);
  showProcessingStatus("Odesilam fotku ke zpracovani...");

  try {
    const maskedImage = edit.maskData ? await convertImageDataUrlToPng(workingDataUrl) : null;
    const response = await fetch("/api/remove-furniture", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        imageData: maskedImage || workingDataUrl,
        mimeType: maskedImage ? "image/png" : workingMimeType,
        fileName: maskedImage ? replaceExtension(workingFileName, "png") : workingFileName,
        width: workingSize.width,
        height: workingSize.height,
        operation: edit.operation,
        instruction: edit.instruction,
        maskData: edit.maskData
      })
    });

    const payload = await readJsonPayload(response);
    if (!response.ok) {
      throw new Error(payload.error || "Uprava fotky se nepodarila.");
    }

    if (!payload.jobId) {
      throw new Error("Server nevratil identifikator zpracovani.");
    }

    localStorage.setItem(activeJobStorageKey, payload.jobId);
    showProcessingStatus("Fotka se zpracovava. Muzete se vratit pozdeji.");
    await pollEditJob(payload.jobId);
  } catch (error) {
    showEditError(error.message);
  } finally {
    setBusy(false);
  }
}

function setBusy(busy) {
  isBusy = busy;
  spinner.hidden = !busy;
  removeButton.disabled = busy || !canRequestEdit();
  instructionInput.disabled = busy;
  instructionButton.disabled = busy || !canSubmitInstruction();
  shareButton.disabled = busy || !canShareResult(resultFile);
  fileInput.disabled = busy;
  cameraInput.disabled = busy;
  modeInputs.forEach((input) => {
    input.disabled = busy;
  });
  brushSize.disabled = busy || !canRequestEdit();
  clearSelectionButton.disabled = busy || selectionStrokes.length === 0;
}

function resetResult() {
  workingDataUrl = null;
  workingMimeType = null;
  workingFileName = null;
  workingSize = null;
  resultFile = null;
  resultImage.removeAttribute("src");
  resultFrame.classList.add("empty");
  resultFrame.classList.remove("error");
  resultPlaceholder.hidden = false;
  resultPlaceholder.textContent = "Vysledek se zobrazi tady";
  downloadButton.removeAttribute("href");
  downloadButton.classList.add("disabled");
  shareButton.disabled = true;
  clearSelection();
}

function showProcessingStatus(message) {
  spinner.hidden = false;
  resultFrame.classList.remove("error");
  if (!workingDataUrl) {
    resultFrame.classList.add("empty");
    resultPlaceholder.hidden = false;
    resultPlaceholder.textContent = "Zpracovavam fotku...";
  }
  statusText.textContent = message;
}

function showEditResult(payload) {
  spinner.hidden = true;
  workingDataUrl = payload.imageData;
  workingMimeType = payload.mimeType;
  workingFileName = payload.fileName;
  workingSize = { width: payload.width, height: payload.height };
  resultImage.src = payload.imageData;
  resultFrame.classList.remove("empty", "error");
  resultPlaceholder.hidden = true;
  downloadButton.href = payload.imageData;
  downloadButton.download = payload.fileName || "mistnost-bez-nabytku.png";
  downloadButton.classList.remove("disabled");
  resultFile = dataUrlToFile(payload.imageData, downloadButton.download, payload.mimeType);
  shareButton.disabled = !canShareResult(resultFile);
  updateModeCopy();
  clearSelection();
  appendChatMessage("assistant", "Uprava je hotova. Muzete pokracovat dalsim odstranenim nebo retusi.");

  const sizeNote = payload.usedOriginalSize
    ? "Rozliseni zustalo stejne."
    : `Webovy vystup: ${payload.width} x ${payload.height}px.`;
  statusText.textContent = `Hotovo. ${sizeNote}`;
}

function showEditError(message) {
  spinner.hidden = true;
  resultFrame.classList.add("error");
  if (workingDataUrl) {
    resultPlaceholder.hidden = true;
  } else {
    resultFrame.classList.add("empty");
    resultPlaceholder.hidden = false;
    resultPlaceholder.textContent = message;
  }
  statusText.textContent = `Fotku se nepodarilo upravit: ${message}`;
}

async function pollEditJob(jobId) {
  while (true) {
    let response;
    try {
      response = await fetch(`/api/remove-furniture/${encodeURIComponent(jobId)}`, {
        cache: "no-store"
      });
    } catch {
      statusText.textContent = "Obnovuji spojeni se zpracovanim...";
      await delay(pollDelayMs);
      continue;
    }

    const payload = await readJsonPayload(response);
    if (!response.ok) {
      localStorage.removeItem(activeJobStorageKey);
      throw new Error(payload.error || "Stav zpracovani neni dostupny.");
    }

    if (payload.status === "completed") {
      localStorage.removeItem(activeJobStorageKey);
      showEditResult(payload);
      return;
    }

    if (payload.status === "failed") {
      localStorage.removeItem(activeJobStorageKey);
      throw new Error(payload.error || "Uprava fotky se nepodarila.");
    }

    await delay(pollDelayMs);
  }
}

async function resumePendingJob() {
  const jobId = localStorage.getItem(activeJobStorageKey);
  if (!jobId) return;

  resetResult();
  setBusy(true);
  showProcessingStatus("Obnovuji probihajici zpracovani...");

  try {
    await pollEditJob(jobId);
  } catch (error) {
    showEditError(error.message);
  } finally {
    setBusy(false);
  }
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Soubor se nepodarilo nacist."));
    reader.readAsDataURL(file);
  });
}

async function normalizeSelectedImage(file) {
  const dataUrl = await readAsDataUrl(file);

  const jpegDataUrl = await convertImageDataUrlToJpeg(dataUrl);
  const jpegName = replaceExtension(file.name || "mistnost", "jpg");
  return {
    file: dataUrlToFile(jpegDataUrl, jpegName, "image/jpeg"),
    dataUrl: jpegDataUrl,
    converted: file.type !== "image/jpeg"
  };
}

async function convertImageDataUrlToJpeg(dataUrl) {
  const image = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;

  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0);

  return canvas.toDataURL("image/jpeg", 0.96);
}

async function convertImageDataUrlToPng(dataUrl) {
  const image = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext("2d").drawImage(image, 0, 0);
  return canvas.toDataURL("image/png");
}

function getImageSize(src) {
  return loadImage(src).then((image) => ({
    width: image.naturalWidth,
    height: image.naturalHeight
  }));
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Obrazek se nepodarilo zobrazit."));
    image.src = src;
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJsonPayload(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Server nevratil platnou odpoved. Zkuste upravu znovu za chvili.");
  }
}

shareButton.addEventListener("click", async () => {
  if (!resultFile || !canShareResult(resultFile)) return;

  try {
    await navigator.share({
      files: [resultFile],
      title: "Mistnost bez nabytku"
    });
  } catch (error) {
    if (error.name !== "AbortError") {
      statusText.textContent = "Sdileni se nepodarilo. Zkuste Stahnout vysledek.";
    }
  }
});

function canShareResult(file) {
  return Boolean(navigator.canShare && file && navigator.canShare({ files: [file] }));
}

function dataUrlToFile(dataUrl, fileName, mimeType) {
  const [header, base64] = dataUrl.split(",");
  const detectedMime = mimeType || header.match(/^data:([^;]+);/)?.[1] || "image/png";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new File([bytes], fileName, { type: detectedMime });
}

function replaceExtension(fileName, extension) {
  const baseName = fileName.replace(/\.[^.]+$/, "") || "mistnost";
  return `${baseName}.${extension}`;
}

function updateActionButtons() {
  removeButton.disabled = !canRequestEdit();
  instructionButton.disabled = !canSubmitInstruction();
  brushSize.disabled = !canRequestEdit();
  clearSelectionButton.disabled = selectionStrokes.length === 0;
}

function resetConversation() {
  instructionInput.value = "";
  chatThread.replaceChildren();
  appendChatMessage("assistant", "Zvolte akci, pripadne oznacte cast pracovni fotky a napiste zadani.");
  updateModeCopy();
}

function appendChatMessage(role, text) {
  const message = document.createElement("p");
  message.className = `chat-message ${role}`;
  message.textContent = text;
  chatThread.append(message);
  chatThread.scrollTop = chatThread.scrollHeight;
}

function canRequestEdit() {
  return Boolean(workingDataUrl);
}

function canSubmitInstruction() {
  return Boolean(workingDataUrl && instructionInput.value.trim());
}

function handleModeChange(event) {
  if (!event.target.checked) return;
  editMode = event.target.value;
  updateModeCopy();
}

function updateModeCopy() {
  if (editMode === "retouch") {
    modeHelp.textContent = 'Oznacte misto na pracovni fotce a napiste napr. "Odstran skvrnu na stene" nebo "Oprav poskozeni podlahy".';
    instructionInput.placeholder = "Napr. Odstran skvrnu na stene.";
    instructionButton.textContent = "Retusovat fotku";
    return;
  }

  modeHelp.textContent = 'Napiste napr. "Odstran stul a zidle", nebo predmet na pracovni fotce oznacte a napiste "Vymazat".';
  instructionInput.placeholder = "Napr. Odstran stul a zidle.";
  instructionButton.textContent = "Odstranit nabytek";
}

function startSelectionStroke(event) {
  if (!canRequestEdit() || isBusy) return;
  const point = selectionPoint(event);
  if (!point) return;
  event.preventDefault();
  selectionCanvas.setPointerCapture(event.pointerId);
  const displayedRect = getDisplayedImageRect();
  activeStroke = {
    width: Number(brushSize.value) / Math.min(displayedRect.width, displayedRect.height),
    points: [point]
  };
  selectionStrokes.push(activeStroke);
  renderSelection();
  updateActionButtons();
}

function continueSelectionStroke(event) {
  if (!activeStroke || !selectionCanvas.hasPointerCapture(event.pointerId)) return;
  const point = selectionPoint(event);
  if (!point) return;
  event.preventDefault();
  activeStroke.points.push(point);
  renderSelection();
}

function endSelectionStroke(event) {
  if (!activeStroke) return;
  if (selectionCanvas.hasPointerCapture(event.pointerId)) {
    selectionCanvas.releasePointerCapture(event.pointerId);
  }
  activeStroke = null;
}

function clearSelection() {
  selectionStrokes = [];
  activeStroke = null;
  renderSelection();
  clearSelectionButton.disabled = true;
}

function selectionPoint(event) {
  const frameRect = selectionCanvas.getBoundingClientRect();
  const imageRect = getDisplayedImageRect();
  const x = event.clientX - frameRect.left - imageRect.x;
  const y = event.clientY - frameRect.top - imageRect.y;
  if (x < 0 || y < 0 || x > imageRect.width || y > imageRect.height) return null;
  return { x: x / imageRect.width, y: y / imageRect.height };
}

function getDisplayedImageRect() {
  const width = selectionCanvas.clientWidth;
  const height = selectionCanvas.clientHeight;
  if (!workingSize || !width || !height) return { x: 0, y: 0, width, height };
  const scale = Math.min(width / workingSize.width, height / workingSize.height);
  const imageWidth = workingSize.width * scale;
  const imageHeight = workingSize.height * scale;
  return {
    x: (width - imageWidth) / 2,
    y: (height - imageHeight) / 2,
    width: imageWidth,
    height: imageHeight
  };
}

function renderSelection() {
  const width = selectionCanvas.clientWidth;
  const height = selectionCanvas.clientHeight;
  const scale = window.devicePixelRatio || 1;
  selectionCanvas.width = Math.max(1, Math.round(width * scale));
  selectionCanvas.height = Math.max(1, Math.round(height * scale));
  const context = selectionCanvas.getContext("2d");
  context.scale(scale, scale);
  context.strokeStyle = "rgba(15, 118, 110, 0.58)";
  context.fillStyle = "rgba(15, 118, 110, 0.58)";
  const imageRect = getDisplayedImageRect();
  for (const stroke of selectionStrokes) {
    paintStroke(context, stroke, imageRect);
  }
}

function createMaskDataUrl() {
  const canvas = document.createElement("canvas");
  canvas.width = workingSize.width;
  canvas.height = workingSize.height;
  const context = canvas.getContext("2d");
  context.fillStyle = "#000000";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.globalCompositeOperation = "destination-out";
  const imageRect = { x: 0, y: 0, width: canvas.width, height: canvas.height };
  for (const stroke of selectionStrokes) {
    paintStroke(context, stroke, imageRect);
  }
  return canvas.toDataURL("image/png");
}

function paintStroke(context, stroke, imageRect) {
  const lineWidth = stroke.width * Math.min(imageRect.width, imageRect.height);
  const firstPoint = stroke.points[0];
  if (!firstPoint) return;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = lineWidth;
  context.beginPath();
  context.moveTo(imageRect.x + firstPoint.x * imageRect.width, imageRect.y + firstPoint.y * imageRect.height);
  for (const point of stroke.points.slice(1)) {
    context.lineTo(imageRect.x + point.x * imageRect.width, imageRect.y + point.y * imageRect.height);
  }
  context.stroke();
  context.beginPath();
  context.arc(
    imageRect.x + firstPoint.x * imageRect.width,
    imageRect.y + firstPoint.y * imageRect.height,
    lineWidth / 2,
    0,
    Math.PI * 2
  );
  context.fill();
}

void resumePendingJob();
