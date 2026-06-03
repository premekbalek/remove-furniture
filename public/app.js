const fileInput = document.querySelector("#fileInput");
const cameraInput = document.querySelector("#cameraInput");
const removeButton = document.querySelector("#removeButton");
const cleanRoomButton = document.querySelector("#cleanRoomButton");
const hidePrivateButton = document.querySelector("#hidePrivateButton");
const enhanceButton = document.querySelector("#enhanceButton");
const webQualityButton = document.querySelector("#webQualityButton");
const cancelButton = document.querySelector("#cancelButton");
const undoButton = document.querySelector("#undoButton");
const shareButton = document.querySelector("#shareButton");
const downloadButton = document.querySelector("#downloadButton");
const originalImage = document.querySelector("#originalImage");
const resultImage = document.querySelector("#resultImage");
const originalFrame = document.querySelector("#originalFrame");
const resultFrame = document.querySelector("#resultFrame");
const markerCanvas = document.querySelector("#markerCanvas");
const statusText = document.querySelector("#statusText");
const resultPlaceholder = document.querySelector("#resultPlaceholder");
const spinner = document.querySelector("#spinner");
const chatThread = document.querySelector("#chatThread");
const analyzeObjectsButton = document.querySelector("#analyzeObjectsButton");
const objectList = document.querySelector("#objectList");
const objectQueryForm = document.querySelector("#objectQueryForm");
const objectQueryInput = document.querySelector("#objectQueryInput");
const findObjectButton = document.querySelector("#findObjectButton");
const semanticPromptInput = document.querySelector("#semanticPromptInput");
const removeSelectedObjectsButton = document.querySelector("#removeSelectedObjectsButton");
const removeMarkModeButton = document.querySelector("#removeMarkModeButton");
const keepMarkModeButton = document.querySelector("#keepMarkModeButton");
const clearMarksButton = document.querySelector("#clearMarksButton");
const markerList = document.querySelector("#markerList");
const createPlanButton = document.querySelector("#createPlanButton");
const editPlanInput = document.querySelector("#editPlanInput");
const planQuestionForm = document.querySelector("#planQuestionForm");
const planQuestionInput = document.querySelector("#planQuestionInput");
const revisePlanButton = document.querySelector("#revisePlanButton");
const runPlanButton = document.querySelector("#runPlanButton");
const activeJobStorageKey = "removeFurniture.activeJobId";
const pollDelayMs = 2500;
const maxEditEdge = 1536;
const maxEditPixels = 2359296;
const draftEditEdge = 1024;
const draftEditPixels = 1048576;
const highQualityEditEdge = 2048;
const highQualityEditPixels = 4194304;

let selectedFile = null;
let originalDataUrl = null;
let originalSize = null;
let workingDataUrl = null;
let workingMimeType = null;
let workingFileName = null;
let workingSize = null;
let resultFile = null;
let resultObjectUrl = null;
let isBusy = false;
let undoStack = [];
let activeJobId = null;
let isCanceling = false;
let detectedTargets = [];
let markers = [];
let markerMode = "remove";

fileInput.addEventListener("change", () => handleFileSelection(fileInput));
cameraInput.addEventListener("change", () => handleFileSelection(cameraInput));
analyzeObjectsButton.addEventListener("click", () => {
  void analyzeObjects();
});
removeSelectedObjectsButton.addEventListener("click", () => {
  void removeSelectedObjects();
});
objectQueryForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void findObjectTarget();
});
objectQueryInput.addEventListener("input", updateActionButtons);
semanticPromptInput.addEventListener("input", updateActionButtons);
editPlanInput.addEventListener("input", updateActionButtons);
planQuestionInput.addEventListener("input", updateActionButtons);
removeMarkModeButton.addEventListener("click", () => setMarkerMode("remove"));
keepMarkModeButton.addEventListener("click", () => setMarkerMode("keep"));
clearMarksButton.addEventListener("click", clearMarkers);
createPlanButton.addEventListener("click", () => {
  void createEditPlan();
});
runPlanButton.addEventListener("click", () => {
  void runEditPlan();
});
planQuestionForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void reviseEditPlan();
});
markerCanvas.addEventListener("click", handleMarkerCanvasClick);
window.addEventListener("resize", drawMarkers);
cancelButton.addEventListener("click", () => {
  void cancelActiveJob();
});
undoButton.addEventListener("click", undoLastEdit);

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
  detectedTargets = [];
  markers = [];
  renderObjectTargets([]);
  renderMarkers();
  semanticPromptInput.value = "";
  objectQueryInput.value = "";
  editPlanInput.value = "";
  planQuestionInput.value = "";

  originalImage.src = originalDataUrl;
  originalFrame.classList.remove("empty");
  resultImage.src = workingDataUrl;
  resultImage.addEventListener("load", drawMarkers, { once: true });
  resultFrame.classList.remove("empty", "error");
  resultPlaceholder.hidden = true;
  downloadButton.download = workingFileName || "mistnost.jpg";
  resultFile = dataUrlToFile(workingDataUrl, downloadButton.download, workingMimeType);
  setDownloadFile(resultFile);
  updateActionButtons();
  const conversionNote = normalized.converted ? " | prevedeno na JPEG pro zpracovani" : " | pripraveno pro zpracovani";
  statusText.textContent = `${selectedFile.name} | ${originalSize.width} x ${originalSize.height}px${conversionNote}`;
}

removeButton.addEventListener("click", () => {
  void submitInstruction(
    "Vyklid celou mistnost: odstran vsechen pohyblivy nabytek, dekorace a volne predmety. Zachovej architekturu mistnosti, steny, podlahu, strop, okna, dvere, radiatory, svetla a pevne vestavene prvky.",
    "remove"
  );
});

cleanRoomButton.addEventListener("click", () => {
  void submitInstruction(
    "Uklid pokoj: odstran pouze drobne volne predmety, neporadek a osobni veci lezici na stolech, komodach, policich, podlaze, sedacim nabytku nebo posteli. Ponech vsechen nabytek, koberec, stoly, zidle, pohovky, kresla, skrine, police, zavesy, obrazy, lampy, rostliny, velke dekorace, spotrebice, architekturu, podlahu a perspektivu mistnosti. Nevyklizej pokoj a neodstranuj zadny vetsi predmet. Rodinne fotografie, obrazy, dekorace a predmety se sentimentalnim vzhledem ponech, pokud nejsou zjevny drobny neporadek.",
    "remove"
  );
});

hidePrivateButton.addEventListener("click", () => {
  void submitInstruction(
    "Skryj osobni veci a citlive udaje: odstran nebo neutralizuj rodinne fotografie a portrety, jmena na dokumentech, dopisy, uctenky, diplomy, detske kresby se jmenem, viditelne obliceje v odrazech, SPZ, cisla dokladu a jine citelne osobni udaje. Pokud je osobni vec soucasti vetsiho predmetu, napr. fotka v ramecku nebo text na papiru, odstran nebo neutralizuj jen osobni obsah a ponech okolni nabytek, dekorace, povrchy, kompozici a realny stav mistnosti prirozene. Neuklizej pokoj obecne, neodstranuj nabytek ani bezne dekorace.",
    "privacy"
  );
});

enhanceButton.addEventListener("click", () => {
  void submitInstruction(
    "Vylepsi fotku jako profesionalni interierovy fotograf pro prodej nemovitosti. Vysledek ma byt viditelne kvalitnejsi, svetlejsi, cistsi a prodejni, ale stale realisticky. Zachovej realny stav prostoru, vsechny predmety i dispozici. Uprav pouze expozici, vyvazeni bile, svetla, stiny, kontrast, barvy, ostrost, sum, svislice a celkovy realitni dojem.",
    "enhance"
  );
});

webQualityButton.addEventListener("click", () => {
  void submitInstruction(
    "Finalni webova kvalita a doplneni pixelu: vytvor kvalitni webovy vystup z aktualni fotky jako realisticky super-resolution/upscale. Zachovej obsah, kompozici, predmety, dispozici a realisticky stav presne stejne. Nemaz, nepridavej ani nepresouvej zadne objekty. Dopln jemne obrazove detaily a texturu tak, aby zmizely kompresni fleky, mapy, bloky a rozpad detailu. Uprav pouze cistotu obrazu, jemne doostreni, odsumeni, mikro-kontrast, tonovou vyvazenost, prirozene barvy a citelnost detailu. Vysledek ma byt kvalitni, cisty a profesionalni pro web, bez umeleho vzhledu.",
    "web-quality",
    { highResolution: true }
  );
});

async function submitInstruction(value, operation, options = {}) {
  if (!workingDataUrl || !workingSize) return;
  const instruction = value.trim();
  if (!instruction) return;

  const operationName = operationLabel(operation);
  appendChatMessage("user", `${operationName}: ${instruction}`);
  updateActionButtons();
  void requestEdit({
    instruction,
    operation,
    draft: Boolean(options.draft),
    highResolution: Boolean(options.highResolution)
  });
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
  showProcessingStatus(processingStartMessage(editContext.operation));

  try {
    const requestImage = await prepareScaledEdit(editContext.baseDataUrl, editContext.baseSize, edit.draft, edit.highResolution);

    const response = await fetch("/api/remove-furniture", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        imageData: requestImage.imageData,
        mimeType: requestImage.mimeType,
        fileName: workingFileName,
        width: requestImage.width,
        height: requestImage.height,
        operation: editContext.operation,
        instruction: editContext.instruction,
        draft: Boolean(edit.draft),
        highResolution: Boolean(edit.highResolution)
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
    showProcessingStatus(processingWaitMessage(editContext.operation));
    await pollEditJob(payload.jobId, editContext);
  } catch (error) {
    if (!isCanceling) {
      showEditError(error.message, editContext.operation);
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
  cleanRoomButton.disabled = busy || !canRequestEdit();
  hidePrivateButton.disabled = busy || !canRequestEdit();
  enhanceButton.disabled = busy || !canRequestEdit();
  webQualityButton.disabled = busy || !canRequestEdit();
  cancelButton.disabled = !busy || !activeJobId;
  undoButton.disabled = busy || undoStack.length === 0;
  analyzeObjectsButton.disabled = busy || !canRequestEdit();
  objectQueryInput.disabled = busy || !canRequestEdit();
  findObjectButton.disabled = busy || !canRequestEdit() || !objectQueryInput.value.trim();
  semanticPromptInput.disabled = busy || !canRequestEdit();
  removeSelectedObjectsButton.disabled = busy || !semanticPromptInput.value.trim();
  removeMarkModeButton.disabled = busy || !canRequestEdit();
  keepMarkModeButton.disabled = busy || !canRequestEdit();
  clearMarksButton.disabled = busy || markers.length === 0;
  createPlanButton.disabled = busy || !canRequestEdit() || markers.length === 0;
  editPlanInput.disabled = busy || !canRequestEdit();
  planQuestionInput.disabled = busy || !canRequestEdit();
  revisePlanButton.disabled = busy || !canRequestEdit() || markers.length === 0 || !planQuestionInput.value.trim();
  runPlanButton.disabled = busy || !canRequestEdit() || !editPlanInput.value.trim();
  shareButton.disabled = busy || !canShareResult(resultFile);
  downloadButton.classList.toggle("disabled", busy || !resultFile);
  fileInput.disabled = busy;
  cameraInput.disabled = busy;
}

function resetResult() {
  workingDataUrl = null;
  workingMimeType = null;
  workingFileName = null;
  workingSize = null;
  resultFile = null;
  clearDownloadFile();
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
  detectedTargets = [];
  markers = [];
  renderObjectTargets([]);
  renderMarkers();
  semanticPromptInput.value = "";
  objectQueryInput.value = "";
  editPlanInput.value = "";
  planQuestionInput.value = "";
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
  pushUndoState();
  const finalPayload = payload;
  workingDataUrl = finalPayload.imageData;
  workingMimeType = finalPayload.mimeType;
  workingFileName = finalPayload.fileName;
  workingSize = { width: finalPayload.width, height: finalPayload.height };
  markers = [];
  editPlanInput.value = "";
  planQuestionInput.value = "";
  resultImage.src = finalPayload.imageData;
  resultImage.addEventListener("load", drawMarkers, { once: true });
  resultFrame.classList.remove("empty", "error");
  resultPlaceholder.hidden = true;
  downloadButton.download = finalPayload.fileName || "mistnost-bez-nabytku.jpg";
  resultFile = dataUrlToFile(finalPayload.imageData, downloadButton.download, finalPayload.mimeType);
  setDownloadFile(resultFile);
  renderMarkers();
  appendChatMessage("assistant", completionMessage(editContext?.operation));

  const fileSizeNote = resultFile ? ` Soubor: ${formatBytes(resultFile.size)}.` : "";
  const sizeNote = finalPayload.usedOriginalSize
    ? "Rozliseni zustalo stejne."
    : `Webovy vystup: ${finalPayload.width} x ${finalPayload.height}px.`;
  statusText.textContent = `Hotovo. ${sizeNote}${fileSizeNote}`;
}

function showEditError(message, operation = null) {
  spinner.hidden = true;
  resultFrame.classList.add("error");
  if (workingDataUrl) {
    resultPlaceholder.hidden = true;
  } else {
    resultFrame.classList.add("empty");
    resultPlaceholder.hidden = false;
    resultPlaceholder.textContent = message;
  }
  const prefix = operation === "web-quality"
    ? "Webovou kvalitu se nepodarilo vytvorit. Stahnout lze jen aktualni puvodni/pracovni fotku"
    : "Fotku se nepodarilo upravit";
  statusText.textContent = `${prefix}: ${message}`;
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

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "kB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`;
}

function setDownloadFile(file) {
  clearDownloadFile();
  resultObjectUrl = URL.createObjectURL(file);
  downloadButton.href = resultObjectUrl;
  downloadButton.classList.remove("disabled");
  shareButton.disabled = !canShareResult(file);
}

function clearDownloadFile() {
  if (resultObjectUrl) {
    URL.revokeObjectURL(resultObjectUrl);
    resultObjectUrl = null;
  }
  downloadButton.removeAttribute("href");
  downloadButton.classList.add("disabled");
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
  cleanRoomButton.disabled = isBusy || !canRequestEdit();
  hidePrivateButton.disabled = isBusy || !canRequestEdit();
  enhanceButton.disabled = isBusy || !canRequestEdit();
  webQualityButton.disabled = isBusy || !canRequestEdit();
  analyzeObjectsButton.disabled = isBusy || !canRequestEdit();
  objectQueryInput.disabled = isBusy || !canRequestEdit();
  findObjectButton.disabled = isBusy || !canRequestEdit() || !objectQueryInput.value.trim();
  semanticPromptInput.disabled = isBusy || !canRequestEdit();
  removeSelectedObjectsButton.disabled = isBusy || !semanticPromptInput.value.trim();
  removeMarkModeButton.disabled = isBusy || !canRequestEdit();
  keepMarkModeButton.disabled = isBusy || !canRequestEdit();
  clearMarksButton.disabled = isBusy || markers.length === 0;
  createPlanButton.disabled = isBusy || !canRequestEdit() || markers.length === 0;
  editPlanInput.disabled = isBusy || !canRequestEdit();
  planQuestionInput.disabled = isBusy || !canRequestEdit();
  revisePlanButton.disabled = isBusy || !canRequestEdit() || markers.length === 0 || !planQuestionInput.value.trim();
  runPlanButton.disabled = isBusy || !canRequestEdit() || !editPlanInput.value.trim();
  cancelButton.disabled = !isBusy || !activeJobId;
  undoButton.disabled = isBusy || undoStack.length === 0;
  shareButton.disabled = isBusy || !canShareResult(resultFile);
  downloadButton.classList.toggle("disabled", isBusy || !resultFile);
}

function resetConversation() {
  chatThread.replaceChildren();
  appendChatMessage("assistant", "Nahrajte fotku. Muzete vybrat rozpoznane predmety, nebo kliknout znacky do pracovni fotky a nechat model vytvorit plan upravy.");
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

function operationLabel(operation) {
  if (operation === "enhance") return "Profesionalni tuning";
  if (operation === "web-quality") return "Webova kvalita";
  if (operation === "privacy") return "Skryti osobnich veci";
  return "Odstraneni";
}

function processingStartMessage(operation) {
  if (operation === "enhance") return "Odesilam fotku na profesionalni tuning...";
  if (operation === "web-quality") return "Odesilam fotku do webove kvality...";
  if (operation === "privacy") return "Odesilam fotku na skryti osobnich veci...";
  return "Odesilam fotku ke zpracovani...";
}

function processingWaitMessage(operation) {
  if (operation === "enhance") return "Profesionalni tuning se zpracovava. Muzete se vratit pozdeji.";
  if (operation === "web-quality") return "Webova kvalita se zpracovava. Muzete se vratit pozdeji.";
  if (operation === "privacy") return "Skryti osobnich veci se zpracovava. Muzete se vratit pozdeji.";
  return "Fotka se zpracovava. Muzete se vratit pozdeji.";
}

function completionMessage(operation) {
  if (operation === "enhance") return "Profesionalni tuning je hotovy. Muzete pokracovat dalsi upravou.";
  if (operation === "web-quality") return "Webova kvalita je hotova. Fotka je pripravena pro web.";
  if (operation === "privacy") return "Skryti osobnich veci je hotove. Zkontrolujte, co se zmenilo.";
  return "Uprava je hotova. Muzete pokracovat dalsim odstranenim.";
}

function setMarkerMode(mode) {
  markerMode = mode;
  removeMarkModeButton.classList.toggle("active", mode === "remove");
  keepMarkModeButton.classList.toggle("active", mode === "keep");
}

function handleMarkerCanvasClick(event) {
  if (!workingDataUrl || isBusy) return;
  const imageRect = displayedImageRect();
  if (!imageRect) return;
  const clientX = event.clientX;
  const clientY = event.clientY;
  if (
    clientX < imageRect.left ||
    clientX > imageRect.right ||
    clientY < imageRect.top ||
    clientY > imageRect.bottom
  ) {
    return;
  }

  const x = (clientX - imageRect.left) / imageRect.width;
  const y = (clientY - imageRect.top) / imageRect.height;
  markers.push({
    id: crypto.randomUUID(),
    type: markerMode,
    x,
    y
  });
  editPlanInput.value = "";
  renderMarkers();
  updateActionButtons();
}

function clearMarkers() {
  markers = [];
  editPlanInput.value = "";
  planQuestionInput.value = "";
  renderMarkers();
  updateActionButtons();
}

function renderMarkers() {
  markerList.replaceChildren();
  markerList.hidden = markers.length === 0;
  markers.forEach((marker, index) => {
    const item = document.createElement("span");
    item.className = `marker-chip ${marker.type}`;
    item.textContent = `${markerLabel(marker.type)} ${index + 1}`;
    markerList.append(item);
  });
  drawMarkers();
}

function drawMarkers() {
  const frameRect = resultFrame.getBoundingClientRect();
  markerCanvas.width = Math.max(1, Math.round(frameRect.width));
  markerCanvas.height = Math.max(1, Math.round(frameRect.height));
  const context = markerCanvas.getContext("2d");
  context.clearRect(0, 0, markerCanvas.width, markerCanvas.height);
  if (!markers.length || resultFrame.classList.contains("empty")) return;

  const imageRect = displayedImageRect();
  if (!imageRect) return;
  const frameLeft = frameRect.left;
  const frameTop = frameRect.top;

  markers.forEach((marker, index) => {
    const x = imageRect.left - frameLeft + marker.x * imageRect.width;
    const y = imageRect.top - frameTop + marker.y * imageRect.height;
    drawMarkerDot(context, x, y, marker.type, index + 1);
  });
}

function drawMarkerDot(context, x, y, type, index) {
  const fill = type === "keep" ? "#2563eb" : "#e11d48";
  context.save();
  context.beginPath();
  context.arc(x, y, 15, 0, Math.PI * 2);
  context.fillStyle = fill;
  context.globalAlpha = 0.88;
  context.fill();
  context.globalAlpha = 1;
  context.lineWidth = 3;
  context.strokeStyle = "#ffffff";
  context.stroke();
  context.fillStyle = "#ffffff";
  context.font = "700 13px system-ui, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(String(index), x, y);
  context.restore();
}

function displayedImageRect() {
  if (!resultImage.naturalWidth || !resultImage.naturalHeight || resultFrame.classList.contains("empty")) return null;
  const frameRect = resultFrame.getBoundingClientRect();
  const imageRatio = resultImage.naturalWidth / resultImage.naturalHeight;
  const frameRatio = frameRect.width / frameRect.height;
  let width = frameRect.width;
  let height = frameRect.height;
  let left = frameRect.left;
  let top = frameRect.top;

  if (frameRatio > imageRatio) {
    width = height * imageRatio;
    left += (frameRect.width - width) / 2;
  } else {
    height = width / imageRatio;
    top += (frameRect.height - height) / 2;
  }

  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height
  };
}

function markerLabel(type) {
  return type === "keep" ? "Ponechat" : "Odstranit";
}

async function createAnnotatedImage(baseDataUrl = workingDataUrl) {
  const image = await loadImage(baseDataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);

  const radius = Math.max(28, Math.round(Math.max(canvas.width, canvas.height) * 0.018));
  markers.forEach((marker, index) => {
    const x = marker.x * canvas.width;
    const y = marker.y * canvas.height;
    drawAnnotatedMarker(context, x, y, radius, marker.type, index + 1);
  });

  return canvas.toDataURL("image/jpeg", 0.92);
}

function drawAnnotatedMarker(context, x, y, radius, type, index) {
  const fill = type === "keep" ? "#2563eb" : "#e11d48";
  context.save();
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fillStyle = fill;
  context.globalAlpha = 0.9;
  context.fill();
  context.globalAlpha = 1;
  context.lineWidth = Math.max(4, radius * 0.16);
  context.strokeStyle = "#ffffff";
  context.stroke();
  context.fillStyle = "#ffffff";
  context.font = `800 ${Math.round(radius * 0.9)}px system-ui, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(String(index), x, y);
  context.restore();
}

async function createEditPlan() {
  await requestEditPlan("");
}

async function reviseEditPlan() {
  const question = planQuestionInput.value.trim();
  if (!question) return;
  await requestEditPlan(question);
}

async function requestEditPlan(message) {
  if (!workingDataUrl || !workingSize || markers.length === 0 || isBusy) return;
  setBusy(true);
  statusText.textContent = message ? "Upravuji plan podle dotazu..." : "Model premysli nad oznacenymi objekty...";

  try {
    const planImage = await prepareScaledEdit(workingDataUrl, workingSize, true);
    const annotatedImageData = await createAnnotatedImage(planImage.imageData);
    const response = await fetch("/api/plan-edit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        imageData: planImage.imageData,
        annotatedImageData,
        mimeType: planImage.mimeType,
        markers: markers.map((marker, index) => ({
          index: index + 1,
          type: marker.type,
          x: marker.x,
          y: marker.y
        })),
        currentPlan: editPlanInput.value,
        message
      })
    });
    const payload = await readJsonPayload(response);
    if (!response.ok) {
      throw new Error(payload.error || "Plan se nepodarilo vytvorit.");
    }

    editPlanInput.value = payload.plan || "";
    if (payload.summary) appendChatMessage("assistant", payload.summary);
    planQuestionInput.value = "";
    statusText.textContent = "Plan je pripraveny. Muzete ho upravit nebo spustit.";
  } catch (error) {
    showEditError(error.message);
  } finally {
    setBusy(false);
  }
}

async function runEditPlan() {
  const plan = editPlanInput.value.trim();
  if (!plan) return;
  await submitInstruction(plan, "remove");
}

async function analyzeObjects() {
  if (!workingDataUrl || !workingSize || isBusy) return;
  setBusy(true);
  statusText.textContent = "Hledam predmety a skupiny veci ve fotce...";

  try {
    const image = await prepareScaledEdit(workingDataUrl, workingSize, true);
    const response = await fetch("/api/analyze-objects", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        imageData: image.imageData,
        mimeType: image.mimeType
      })
    });
    const payload = await readJsonPayload(response);
    if (!response.ok) {
      throw new Error(payload.error || "Predmety se nepodarilo rozpoznat.");
    }

    detectedTargets = Array.isArray(payload.targets) ? payload.targets : [];
    renderObjectTargets(detectedTargets);
    appendChatMessage("assistant", `Nasel jsem ${detectedTargets.length} moznych cilu. Vyberte predmety nebo skupiny a spustte odstraneni.`);
    statusText.textContent = "Predmety jsou pripravene k vyberu.";
  } catch (error) {
    showEditError(error.message);
  } finally {
    setBusy(false);
  }
}

async function findObjectTarget() {
  const query = objectQueryInput.value.trim();
  if (!workingDataUrl || !workingSize || !query || isBusy) return;
  setBusy(true);
  statusText.textContent = "Hledam konkretni predmet ve fotce...";

  try {
    const image = await prepareScaledEdit(workingDataUrl, workingSize, true);
    const response = await fetch("/api/find-object", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        imageData: image.imageData,
        mimeType: image.mimeType,
        query
      })
    });
    const payload = await readJsonPayload(response);
    if (!response.ok) {
      throw new Error(payload.error || "Predmet se nepodarilo najit.");
    }

    if (!payload.found || !payload.target) {
      appendChatMessage("assistant", payload.message || "Tenhle predmet ve fotce nevidim dostatecne jasne.");
      statusText.textContent = "Predmet nebyl spolehlive nalezen.";
      return;
    }

    const target = {
      ...payload.target,
      id: uniqueTargetId(payload.target.id || "manual")
    };
    detectedTargets = [...detectedTargets, target];
    renderObjectTargets(detectedTargets);
    const checkbox = objectList.querySelector(`input[value="${CSS.escape(target.id)}"]`);
    if (checkbox) checkbox.checked = true;
    semanticPromptInput.value = buildSemanticRemovalPrompt(selectedObjectTargets());
    objectQueryInput.value = "";
    appendChatMessage("assistant", `Doplnil jsem cil: ${target.label}.`);
    statusText.textContent = "Predmet byl doplnen do seznamu.";
  } catch (error) {
    showEditError(error.message);
  } finally {
    setBusy(false);
  }
}

function renderObjectTargets(targets) {
  objectList.replaceChildren();
  objectList.hidden = targets.length === 0;

  for (const target of targets) {
    const label = document.createElement("label");
    label.className = "object-target";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = target.id;
    checkbox.addEventListener("change", () => {
      semanticPromptInput.value = buildSemanticRemovalPrompt(selectedObjectTargets());
      updateActionButtons();
    });

    const content = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = target.label || target.id;
    const description = document.createElement("small");
    description.textContent = [target.description, target.location].filter(Boolean).join(" | ");

    content.append(title, description);
    label.append(checkbox, content);
    objectList.append(label);
  }

  updateActionButtons();
}

function selectedObjectTargets() {
  const selectedIds = new Set(
    [...objectList.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value)
  );
  return detectedTargets.filter((target) => selectedIds.has(target.id));
}

function uniqueTargetId(base) {
  const normalized = String(base || "manual").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 24) || "manual";
  const existing = new Set(detectedTargets.map((target) => target.id));
  let next = normalized;
  let index = 1;
  while (existing.has(next)) {
    index += 1;
    next = `${normalized}_${index}`;
  }
  return next;
}

async function removeSelectedObjects() {
  const targets = selectedObjectTargets();
  const instruction = semanticPromptInput.value.trim() || buildSemanticRemovalPrompt(targets);
  if (!instruction) return;
  await submitInstruction(instruction, "remove", { forceNoMask: true });
}

function buildSemanticRemovalPrompt(targets) {
  const removeLines = targets.map((target) => {
    const removePrompt = target.removePromptCs || target.description || target.label;
    return `- ${target.id}: ${removePrompt}`;
  });
  const selectedIds = new Set(targets.map((target) => target.id));
  const unselectedLines = detectedTargets
    .filter((target) => !selectedIds.has(target.id))
    .slice(0, 10)
    .map((target) => `- ${target.label}: ${target.description || target.location || "nevybrany predmet"}`);
  const hasRugTarget = targets.some((target) => {
    const text = `${target.label} ${target.description} ${target.removePromptCs}`.toLowerCase();
    return text.includes("koberec") || text.includes("rug") || text.includes("carpet");
  });

  return [
    "Toto je cilena lokalni uprava, ne uklid ani vyklizeni mistnosti.",
    "Odstran pouze tyto vybrane predmety nebo skupiny:",
    ...removeLines,
    "Kazdy vybrany cil interpretuj podle vzhledu, polohy a vztahu k okolnim predmetum.",
    "Neodstranuj zadny jiny nabytek, dekorace ani volne predmety jen proto, ze jsou pohyblive.",
    "Pokud je vybrany cil skupina volnych veci na povrchu, odstran vsechny volne pohyblive veci v teto skupine, ale ponech samotny nosny nabytek nebo povrch.",
    "Ponech beze zmeny:",
    "- vsechny nevybrane predmety, nabytek a dekorace",
    hasRugTarget ? "- stul, zidle, kresla, skrine, police, veci na stole, veci ve skrini a vsechny predmety na nabytku; pokud se odstranuje koberec, odstran pouze koberec" : "",
    ...unselectedLines,
    "- okna, dvere, radiator, steny, strop, svetlo, podlahu a perspektivu mistnosti",
    "- nosny nabytek nebo povrch, pokud se odstranuji pouze volne predmety na nem",
    "Vsechny nevybrane predmety ponech beze zmeny. Rekonstruuj pouze nove odkryty povrch prirozene."
  ].filter(Boolean).join("\n");
}

async function prepareScaledEdit(baseDataUrl, baseSize, draft = false, highResolution = false) {
  const image = await loadImage(baseDataUrl);
  const size = supportedClientEditSize(baseSize.width, baseSize.height, draft, highResolution);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, size.width, size.height);
  context.drawImage(image, 0, 0, size.width, size.height);

  return {
    imageData: canvas.toDataURL("image/jpeg", highResolution ? 0.97 : draft ? 0.82 : 0.9),
    mimeType: "image/jpeg",
    width: size.width,
    height: size.height
  };
}

function supportedClientEditSize(width, height, draft = false, highResolution = false) {
  const ratio = width / height;
  let nextWidth = width;
  let nextHeight = height;
  const targetMaxEdge = highResolution ? highQualityEditEdge : draft ? draftEditEdge : maxEditEdge;
  const targetMaxPixels = highResolution ? highQualityEditPixels : draft ? draftEditPixels : maxEditPixels;

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

  return {
    width: Math.max(16, nextWidth),
    height: Math.max(16, nextHeight)
  };
}

function roundToMultiple(value, multiple) {
  return Math.max(multiple, Math.round(value / multiple) * multiple);
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
  markers = [];
  editPlanInput.value = "";
  planQuestionInput.value = "";
  resultImage.src = workingDataUrl;
  resultImage.addEventListener("load", drawMarkers, { once: true });
  resultFrame.classList.remove("empty", "error");
  resultPlaceholder.hidden = true;
  downloadButton.download = workingFileName || "mistnost-bez-nabytku.jpg";
  resultFile = dataUrlToFile(workingDataUrl, downloadButton.download, workingMimeType);
  setDownloadFile(resultFile);
  appendChatMessage("assistant", "Vracim posledni krok. Muzete zadat upravu znovu.");
  statusText.textContent = "Vraceno o jeden krok zpet.";
  renderMarkers();
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

void resumePendingJob();
