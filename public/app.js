const fileInput = document.querySelector("#fileInput");
const cameraInput = document.querySelector("#cameraInput");
const removeButton = document.querySelector("#removeButton");
const downloadButton = document.querySelector("#downloadButton");
const originalImage = document.querySelector("#originalImage");
const resultImage = document.querySelector("#resultImage");
const originalFrame = document.querySelector("#originalFrame");
const resultFrame = document.querySelector("#resultFrame");
const statusText = document.querySelector("#statusText");
const resultPlaceholder = document.querySelector("#resultPlaceholder");
const spinner = document.querySelector("#spinner");

let selectedFile = null;
let originalDataUrl = null;
let originalSize = null;

fileInput.addEventListener("change", () => handleFileSelection(fileInput));
cameraInput.addEventListener("change", () => handleFileSelection(cameraInput));

async function handleFileSelection(input) {
  const [file] = input.files;
  if (!file) return;

  resetResult();
  selectedFile = file;
  originalDataUrl = await readAsDataUrl(file);
  originalSize = await getImageSize(originalDataUrl);

  originalImage.src = originalDataUrl;
  originalFrame.classList.remove("empty");
  removeButton.disabled = false;
  statusText.textContent = `${file.name} | ${originalSize.width} x ${originalSize.height}px`;
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
        height: originalSize.height
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

    const sizeNote = payload.usedOriginalSize
      ? "Rozliseni zustalo stejne."
      : `Vystupni rozmer byl upraven na ${payload.width} x ${payload.height}px kvuli limitum modelu.`;
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
  removeButton.disabled = isBusy || !selectedFile;
  fileInput.disabled = isBusy;
  cameraInput.disabled = isBusy;
}

function resetResult() {
  resultImage.removeAttribute("src");
  resultFrame.classList.add("empty");
  resultFrame.classList.remove("error");
  resultPlaceholder.hidden = false;
  resultPlaceholder.textContent = "Vysledek se zobrazi tady";
  downloadButton.removeAttribute("href");
  downloadButton.classList.add("disabled");
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Soubor se nepodarilo nacist."));
    reader.readAsDataURL(file);
  });
}

function getImageSize(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error("Obrazek se nepodarilo zobrazit."));
    image.src = src;
  });
}
