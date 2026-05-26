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
const removalModes = document.querySelectorAll('input[name="removalMode"]');
const categoryPanel = document.querySelector("#categoryPanel");
const categoryInputs = document.querySelectorAll('input[name="removeCategory"]');

let selectedFile = null;
let originalDataUrl = null;
let originalSize = null;
let resultFile = null;

fileInput.addEventListener("change", () => handleFileSelection(fileInput));
cameraInput.addEventListener("change", () => handleFileSelection(cameraInput));
removalModes.forEach((input) => input.addEventListener("change", updateRemovalControls));
categoryInputs.forEach((input) => input.addEventListener("change", updateRemoveButton));

async function handleFileSelection(input) {
  const [file] = input.files;
  if (!file) return;

  resetResult();
  statusText.textContent = "Nacitam fotku...";

  const normalized = await normalizeSelectedImage(file);
  selectedFile = normalized.file;
  originalDataUrl = normalized.dataUrl;
  originalSize = await getImageSize(originalDataUrl);

  originalImage.src = originalDataUrl;
  originalFrame.classList.remove("empty");
  updateRemoveButton();
  const conversionNote = normalized.converted ? " | prevedeno na JPEG pro zpracovani" : " | pripraveno pro zpracovani";
  statusText.textContent = `${selectedFile.name} | ${originalSize.width} x ${originalSize.height}px${conversionNote}`;
}

removeButton.addEventListener("click", async () => {
  if (!selectedFile || !originalDataUrl || !originalSize) return;

  setBusy(true);
  resetResult();
  statusText.textContent = "Mazani nabytku muze trvat az nekolik minut...";

  try {
    const response = await fetch("/api/remove-furniture", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        imageData: originalDataUrl,
        mimeType: selectedFile.type,
        fileName: selectedFile.name,
        width: originalSize.width,
        height: originalSize.height,
        removalMode: selectedRemovalMode(),
        removeCategories: selectedCategories()
      })
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Uprava fotky se nepodarila.");
    }

    resultImage.src = payload.imageData;
    resultFrame.classList.remove("empty", "error");
    resultPlaceholder.hidden = true;
    downloadButton.href = payload.imageData;
    downloadButton.download = payload.fileName || "mistnost-bez-nabytku.png";
    downloadButton.classList.remove("disabled");
    resultFile = dataUrlToFile(payload.imageData, downloadButton.download, payload.mimeType);
    shareButton.disabled = !canShareResult(resultFile);

    const sizeNote = payload.usedOriginalSize
      ? "Rozliseni zustalo stejne."
      : `Webovy vystup: ${payload.width} x ${payload.height}px ve vysoke kvalite.`;
    statusText.textContent = `Hotovo. ${sizeNote}`;
  } catch (error) {
    resultFrame.classList.add("error");
    resultPlaceholder.hidden = false;
    resultPlaceholder.textContent = error.message;
    statusText.textContent = "Fotku se nepodarilo upravit.";
  } finally {
    setBusy(false);
  }
});

function setBusy(isBusy) {
  spinner.hidden = !isBusy;
  removeButton.disabled = isBusy || !canRequestEdit();
  shareButton.disabled = isBusy || !canShareResult(resultFile);
  fileInput.disabled = isBusy;
  cameraInput.disabled = isBusy;
  removalModes.forEach((input) => { input.disabled = isBusy; });
  categoryInputs.forEach((input) => { input.disabled = isBusy; });
}

function resetResult() {
  resultFile = null;
  resultImage.removeAttribute("src");
  resultFrame.classList.add("empty");
  resultFrame.classList.remove("error");
  resultPlaceholder.hidden = false;
  resultPlaceholder.textContent = "Vysledek se zobrazi tady";
  downloadButton.removeAttribute("href");
  downloadButton.classList.add("disabled");
  shareButton.disabled = true;
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

function updateRemovalControls() {
  categoryPanel.hidden = selectedRemovalMode() !== "selected";
  updateRemoveButton();
}

function updateRemoveButton() {
  removeButton.disabled = !canRequestEdit();
}

function selectedRemovalMode() {
  return document.querySelector('input[name="removalMode"]:checked')?.value || "all";
}

function selectedCategories() {
  return Array.from(categoryInputs)
    .filter((input) => input.checked)
    .map((input) => input.value);
}

function canRequestEdit() {
  return Boolean(selectedFile) && (selectedRemovalMode() === "all" || selectedCategories().length > 0);
}

updateRemovalControls();
