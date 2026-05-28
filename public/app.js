const fileInput = document.querySelector("#fileInput");
const cameraInput = document.querySelector("#cameraInput");
const removeButton = document.querySelector("#removeButton");
const cancelButton = document.querySelector("#cancelButton");
const undoButton = document.querySelector("#undoButton");
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
const maxEditEdge = 2048;
const maxEditPixels = 3686400;

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
let undoStack = [];
let activeJobId = null;
let isCanceling = false;

fileInput.addEventListener("change", () => handleFileSelection(fileInput));
cameraInput.addEventListener("change", () => handleFileSelection(cameraInput));
instructionInput.addEventListener("input", updateActionButtons);
modeInputs.forEach((input) => input.addEventListener("change", handleModeChange));
cancelButton.addEventListener("click", () => {
  void cancelActiveJob();
});
undoButton.addEventListener("click", undoLastEdit);
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
  undoStack = [];

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
  void submitInstruction(
    "Odstran vsechen pohyblivy nabytek a volne predmety. Nic krome kuchynske linky neponechavej.",
    "remove"
  );
});

instructionForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitInstruction(instructionInput.value, editMode);
});

async function submitInstruction(value, operation) {
  if (!workingDataUrl || !workingSize) return;
  const editStrokeCount = countSelectionStrokes("edit");
  const hasEditMask = editStrokeCount > 0;
  const instruction = value.trim();
  if (!instruction) return;

  const operationName = operation === "retouch" ? "Retus" : "Odstraneni";
  const selectionNote = hasEditMask ? "oznacena oblast" : "";
  appendChatMessage("user", `${operationName}${selectionNote ? ` (${selectionNote})` : ""}: ${instruction}`);
  instructionInput.value = "";
  const maskData = hasEditMask ? true : null;
  updateActionButtons();
  void requestEdit({ instruction, operation, maskData });
}

async function requestEdit(edit) {
  if (!workingDataUrl || !workingSize) return;

  const editContext = {
    ...edit,
    baseDataUrl: workingDataUrl,
    baseMimeType: workingMimeType,
    baseFileName: workingFileName,
    baseSize: { ...workingSize }
  };
  setBusy(true);
  showProcessingStatus("Odesilam fotku ke zpracovani...");

  try {
    const maskedEdit = editContext.maskData
      ? await prepareMaskedEdit(editContext.baseDataUrl, editContext.baseSize)
      : null;
    if (maskedEdit) {
      editContext.maskData = maskedEdit.maskData;
    }
    const response = await fetch("/api/remove-furniture", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        imageData: maskedEdit?.imageData || workingDataUrl,
        mimeType: maskedEdit ? "image/png" : workingMimeType,
        fileName: maskedEdit ? replaceExtension(workingFileName, "png") : workingFileName,
        width: maskedEdit?.width || workingSize.width,
        height: maskedEdit?.height || workingSize.height,
        operation: editContext.operation,
        instruction: editContext.instruction,
        maskData: editContext.maskData
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
    activeJobId = payload.jobId;
    isCanceling = false;
    updateActionButtons();
    showProcessingStatus("Fotka se zpracovava. Muzete se vratit pozdeji.");
    await pollEditJob(payload.jobId, editContext);
  } catch (error) {
    if (!isCanceling) {
      showEditError(error.message);
    }
  } finally {
    activeJobId = null;
    isCanceling = false;
    setBusy(false);
  }
}

function setBusy(busy) {
  isBusy = busy;
  spinner.hidden = !busy;
  removeButton.disabled = busy || !canRequestEdit();
  cancelButton.disabled = !busy || !activeJobId;
  undoButton.disabled = busy || undoStack.length === 0;
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
  undoStack = [];
  activeJobId = null;
  isCanceling = false;
  resultImage.removeAttribute("src");
  resultFrame.classList.add("empty");
  resultFrame.classList.remove("error");
  resultPlaceholder.hidden = false;
  resultPlaceholder.textContent = "Vysledek se zobrazi tady";
  downloadButton.removeAttribute("href");
  downloadButton.classList.add("disabled");
  shareButton.disabled = true;
  undoButton.disabled = true;
  cancelButton.disabled = true;
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

async function showEditResult(payload, editContext = null) {
  spinner.hidden = true;
  if (editContext?.maskData) {
    payload = await lockEditToMask(payload, editContext);
  }
  pushUndoState();
  workingDataUrl = payload.imageData;
  workingMimeType = payload.mimeType;
  workingFileName = payload.fileName;
  workingSize = { width: payload.width, height: payload.height };
  resultImage.src = payload.imageData;
  resultFrame.classList.remove("empty", "error");
  resultPlaceholder.hidden = true;
  downloadButton.href = payload.imageData;
  downloadButton.download = payload.fileName || "mistnost-bez-nabytku.jpg";
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

async function pollEditJob(jobId, editContext = null) {
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
      if (isCanceling || activeJobId !== jobId) return;
      await showEditResult(payload, editContext);
      return;
    }

    if (payload.status === "canceled") {
      localStorage.removeItem(activeJobStorageKey);
      statusText.textContent = "Zpracovani bylo zruseno.";
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

  activeJobId = jobId;
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
  removeButton.disabled = isBusy || !canRequestEdit();
  instructionButton.disabled = isBusy || !canSubmitInstruction();
  brushSize.disabled = isBusy || !canRequestEdit();
  clearSelectionButton.disabled = isBusy || selectionStrokes.length === 0;
  cancelButton.disabled = !isBusy || !activeJobId;
  undoButton.disabled = isBusy || undoStack.length === 0;
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

  modeHelp.textContent = 'Cervenou muzete oznacit misto, ktere mate na mysli. Do chatu vzdy napiste, co se ma stat.';
  instructionInput.placeholder = "Napr. Odstran oznacenou skrin.";
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
    type: "edit",
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
  updateActionButtons();
}

function clearSelection() {
  selectionStrokes = [];
  activeStroke = null;
  renderSelection();
  clearSelectionButton.disabled = true;
  updateActionButtons();
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
  const imageRect = getDisplayedImageRect();
  for (const stroke of selectionStrokes) {
    context.strokeStyle = strokeColor();
    context.fillStyle = strokeColor();
    paintStroke(context, stroke, imageRect);
  }
}

function createMaskDataUrl(width = workingSize.width, height = workingSize.height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.fillStyle = "#000000";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.globalCompositeOperation = "destination-out";
  const imageRect = { x: 0, y: 0, width: canvas.width, height: canvas.height };
  for (const stroke of selectionStrokes.filter((item) => item.type === "edit")) {
    paintStroke(context, stroke, imageRect);
  }
  return canvas.toDataURL("image/png");
}

async function prepareMaskedEdit(baseDataUrl, baseSize) {
  const image = await loadImage(baseDataUrl);
  const size = supportedClientEditSize(baseSize.width, baseSize.height);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, size.width, size.height);

  return {
    imageData: canvas.toDataURL("image/png"),
    maskData: createMaskDataUrl(size.width, size.height),
    width: size.width,
    height: size.height
  };
}

function strokeColor() {
  return "rgba(225, 29, 72, 0.58)";
}

function countSelectionStrokes(type) {
  return selectionStrokes.filter((stroke) => stroke.type === type).length;
}

function supportedClientEditSize(width, height) {
  const ratio = width / height;
  let nextWidth = width;
  let nextHeight = height;

  const maxEdge = Math.max(nextWidth, nextHeight);
  if (maxEdge > maxEditEdge) {
    const scale = maxEditEdge / maxEdge;
    nextWidth *= scale;
    nextHeight *= scale;
  }

  const pixels = nextWidth * nextHeight;
  if (pixels > maxEditPixels) {
    const scale = Math.sqrt(maxEditPixels / pixels);
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

  while (nextWidth * nextHeight > maxEditPixels) {
    if (nextWidth >= nextHeight) {
      nextWidth -= 16;
    } else {
      nextHeight -= 16;
    }
  }

  return {
    width: Math.max(16, nextWidth),
    height: Math.max(16, nextHeight)
  };
}

function roundToMultiple(value, multiple) {
  return Math.max(multiple, Math.round(value / multiple) * multiple);
}

async function lockEditToMask(payload, editContext) {
  const [baseImage, editedImage, maskImage] = await Promise.all([
    loadImage(editContext.baseDataUrl),
    loadImage(payload.imageData),
    loadImage(editContext.maskData)
  ]);
  const width = payload.width || editedImage.naturalWidth;
  const height = payload.height || editedImage.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(baseImage, 0, 0, width, height);

  const editedLayer = document.createElement("canvas");
  editedLayer.width = width;
  editedLayer.height = height;
  const editedContext = editedLayer.getContext("2d");
  editedContext.drawImage(editedImage, 0, 0, width, height);

  const alphaMask = document.createElement("canvas");
  alphaMask.width = width;
  alphaMask.height = height;
  const maskContext = alphaMask.getContext("2d");
  maskContext.drawImage(maskImage, 0, 0, width, height);
  const maskPixels = maskContext.getImageData(0, 0, width, height);
  for (let index = 0; index < maskPixels.data.length; index += 4) {
    const editableAlpha = 255 - maskPixels.data[index + 3];
    maskPixels.data[index] = 255;
    maskPixels.data[index + 1] = 255;
    maskPixels.data[index + 2] = 255;
    maskPixels.data[index + 3] = editableAlpha;
  }
  maskContext.putImageData(maskPixels, 0, 0);

  editedContext.globalCompositeOperation = "destination-in";
  editedContext.drawImage(alphaMask, 0, 0);
  context.drawImage(editedLayer, 0, 0);

  const imageData = canvas.toDataURL("image/jpeg", 0.96);
  return {
    ...payload,
    imageData,
    mimeType: "image/jpeg",
    fileName: replaceExtension(payload.fileName || editContext.baseFileName || "mistnost-bez-nabytku.jpg", "jpg"),
    width,
    height
  };
}

function pushUndoState() {
  if (!workingDataUrl || !workingSize) return;
  undoStack.push({
    dataUrl: workingDataUrl,
    mimeType: workingMimeType,
    fileName: workingFileName,
    size: { ...workingSize }
  });
  if (undoStack.length > 10) undoStack.shift();
}

function undoLastEdit() {
  if (isBusy || undoStack.length === 0) return;
  const previous = undoStack.pop();
  workingDataUrl = previous.dataUrl;
  workingMimeType = previous.mimeType;
  workingFileName = previous.fileName;
  workingSize = previous.size;
  resultImage.src = workingDataUrl;
  resultFrame.classList.remove("empty", "error");
  resultPlaceholder.hidden = true;
  downloadButton.href = workingDataUrl;
  downloadButton.download = workingFileName || "mistnost-bez-nabytku.jpg";
  downloadButton.classList.remove("disabled");
  resultFile = dataUrlToFile(workingDataUrl, downloadButton.download, workingMimeType);
  shareButton.disabled = !canShareResult(resultFile);
  clearSelection();
  appendChatMessage("assistant", "Vracim posledni krok. Muzete zadat upravu znovu.");
  statusText.textContent = "Vraceno o jeden krok zpet.";
  updateActionButtons();
}

async function cancelActiveJob() {
  if (!activeJobId) return;
  const jobId = activeJobId;
  isCanceling = true;
  localStorage.removeItem(activeJobStorageKey);
  activeJobId = null;
  setBusy(false);
  spinner.hidden = true;
  statusText.textContent = "Rusim zpracovani...";

  try {
    await fetch(`/api/remove-furniture/${encodeURIComponent(jobId)}`, {
      method: "DELETE",
      cache: "no-store"
    });
  } catch {
    // Local cancellation is enough for the UI; the server may still finish the remote request.
  }

  statusText.textContent = "Zpracovani bylo zruseno.";
  appendChatMessage("assistant", "Zpracovani bylo zruseno. Zadani muzete upravit a spustit znovu.");
  updateActionButtons();
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
