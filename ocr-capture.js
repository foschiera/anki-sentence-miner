const captureId = new URLSearchParams(location.search).get("capture") || "";
const elements = {
  close: document.querySelector("#close-window"),
  windowTitle: document.querySelector("#window-title"),
  captureSection: document.querySelector("#capture-section"),
  stage: document.querySelector("#capture-stage"),
  canvas: document.querySelector("#capture-canvas"),
  selection: document.querySelector("#selection-box"),
  captureStatus: document.querySelector("#capture-status"),
  reviewSection: document.querySelector("#review-section"),
  metadata: document.querySelector("#ocr-metadata"),
  term: document.querySelector("#term-input"),
  text: document.querySelector("#text-input"),
  deck: document.querySelector("#deck-select"),
  reviewStatus: document.querySelector("#review-status"),
  back: document.querySelector("#back-to-selection"),
  send: document.querySelector("#send-to-anki"),
  successSection: document.querySelector("#success-section"),
  successMessage: document.querySelector("#success-message"),
  finish: document.querySelector("#finish")
};

let startPoint = null;
let activePointerId = null;
let currentRect = null;
let deckOptionsPromise = null;

function closeCapture() {
  browser.runtime.sendMessage({ action: "discard_pending_capture", captureId }).catch(() => {});
  window.close();
}

function canvasPoint(event) {
  const bounds = elements.canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(elements.canvas.width, (event.clientX - bounds.left) * elements.canvas.width / bounds.width)),
    y: Math.max(0, Math.min(elements.canvas.height, (event.clientY - bounds.top) * elements.canvas.height / bounds.height))
  };
}

function updateSelection(point) {
  const bounds = elements.canvas.getBoundingClientRect();
  const left = Math.min(startPoint.x, point.x);
  const top = Math.min(startPoint.y, point.y);
  const width = Math.abs(point.x - startPoint.x);
  const height = Math.abs(point.y - startPoint.y);
  currentRect = { left, top, width, height };
  elements.selection.style.left = `${left * bounds.width / elements.canvas.width}px`;
  elements.selection.style.top = `${top * bounds.height / elements.canvas.height}px`;
  elements.selection.style.width = `${width * bounds.width / elements.canvas.width}px`;
  elements.selection.style.height = `${height * bounds.height / elements.canvas.height}px`;
}

function loadDeckOptions() {
  if (!deckOptionsPromise) {
    deckOptionsPromise = browser.runtime.sendMessage({ action: "get_deck_options" });
  }
  return deckOptionsPromise.then(result => {
    const decks = Array.isArray(result?.decks) ? result.decks : [];
    elements.deck.replaceChildren();
    for (const deckName of decks) {
      const option = document.createElement("option");
      option.value = deckName;
      option.textContent = deckName;
      elements.deck.appendChild(option);
    }
    if (!decks.length) throw new Error("Nenhum deck foi encontrado no Anki.");
    elements.deck.value = decks.includes(result.selectedDeck) ? result.selectedDeck : decks[0];
    elements.deck.disabled = false;
    elements.send.disabled = false;
  });
}

function showReview(result) {
  elements.captureSection.hidden = true;
  elements.reviewSection.hidden = false;
  elements.term.value = result.term || result.text || "";
  elements.text.value = result.text || "";
  elements.metadata.replaceChildren();
  if (Number.isFinite(result.confidence)) {
    const badge = document.createElement("span");
    badge.textContent = `Confiança: ${result.confidence}%`;
    elements.metadata.appendChild(badge);
  }
  const layoutNames = {
    vertical: "Texto vertical",
    "single-line": "Linha única",
    "text-line": "Linha de texto",
    "text-block": "Bloco de texto"
  };
  if (result.layout) {
    const badge = document.createElement("span");
    badge.textContent = layoutNames[result.layout] || result.layout;
    elements.metadata.appendChild(badge);
  }
  loadDeckOptions().catch(error => {
    elements.reviewStatus.textContent = error.message || String(error);
  });
  elements.term.focus();
}

async function recognizeSelection() {
  if (!currentRect || currentRect.width <= 8 || currentRect.height <= 8) return;
  elements.captureStatus.textContent = "Analisando a seleção…";
  elements.canvas.style.pointerEvents = "none";
  try {
    const result = await browser.runtime.sendMessage({
      action: "ocr_captured_image",
      captureId,
      rect: {
        x: currentRect.left,
        y: currentRect.top,
        width: currentRect.width,
        height: currentRect.height,
        viewportWidth: elements.canvas.width,
        viewportHeight: elements.canvas.height
      }
    });
    if (!result?.success) throw new Error(result?.error || "Não foi possível reconhecer o texto.");
    showReview(result);
  } catch (error) {
    elements.captureStatus.textContent = error.message || String(error);
    elements.canvas.style.pointerEvents = "auto";
  }
}

async function sendToAnki(forceDuplicate = false) {
  const word = elements.term.value.trim();
  const sentence = elements.text.value.trim() || word;
  if (!word) {
    elements.reviewStatus.textContent = "Informe o termo que será adicionado.";
    elements.term.focus();
    return;
  }
  if (!elements.deck.value) {
    elements.reviewStatus.textContent = "Escolha o deck que receberá a nota.";
    return;
  }

  elements.send.disabled = true;
  elements.reviewStatus.textContent = "Enviando ao Anki…";
  try {
    const response = await browser.runtime.sendMessage({
      action: "add_to_anki",
      payload: { word, sentence, deckName: elements.deck.value, forceDuplicate }
    });
    if (response?.duplicate && response.requiresConfirmation) {
      elements.send.disabled = false;
      elements.reviewStatus.textContent = "";
      if (window.confirm(`${response.text || word} já existe neste deck. Adicionar mesmo assim?`)) {
        await sendToAnki(true);
      }
      return;
    }
    if (!response?.success) throw new Error(response?.error || "Não foi possível criar a nota.");

    elements.reviewSection.hidden = true;
    elements.successSection.hidden = false;
    elements.successMessage.textContent = `${response.text || word} foi adicionado ao deck ${response.deckName || elements.deck.value}.`;
    elements.finish.focus();
  } catch (error) {
    elements.reviewStatus.textContent = error.message || String(error);
    elements.send.disabled = false;
  }
}

elements.canvas.addEventListener("pointerdown", event => {
  if (event.button !== 0 || activePointerId !== null) return;
  event.preventDefault();
  activePointerId = event.pointerId;
  startPoint = canvasPoint(event);
  currentRect = null;
  elements.canvas.setPointerCapture(event.pointerId);
  elements.selection.hidden = false;
  updateSelection(startPoint);
});

elements.canvas.addEventListener("pointermove", event => {
  if (event.pointerId === activePointerId) updateSelection(canvasPoint(event));
});

elements.canvas.addEventListener("pointerup", event => {
  if (event.pointerId !== activePointerId) return;
  updateSelection(canvasPoint(event));
  activePointerId = null;
  recognizeSelection();
});

elements.close.addEventListener("click", closeCapture);
elements.finish.addEventListener("click", closeCapture);
elements.back.addEventListener("click", () => {
  elements.reviewSection.hidden = true;
  elements.captureSection.hidden = false;
  elements.selection.hidden = true;
  elements.canvas.style.pointerEvents = "auto";
  elements.captureStatus.textContent = "Arraste para selecionar outra área.";
});
elements.send.addEventListener("click", () => sendToAnki());
document.addEventListener("keydown", event => {
  if (event.key === "Escape") closeCapture();
});

browser.runtime.sendMessage({ action: "get_pending_capture", captureId })
  .then(result => {
    if (!result?.success) throw new Error(result?.error || "A captura não está disponível.");
    if (result.selectedText) {
      elements.windowTitle.textContent = "Revisar texto do PDF";
      elements.back.hidden = true;
      showReview({ term: result.term, text: result.selectedText });
      return;
    }
    const image = new Image();
    image.addEventListener("load", () => {
      elements.canvas.width = image.naturalWidth;
      elements.canvas.height = image.naturalHeight;
      elements.canvas.getContext("2d").drawImage(image, 0, 0);
      elements.captureStatus.textContent = "Arraste sobre o texto que deseja reconhecer.";
    });
    image.addEventListener("error", () => {
      elements.captureStatus.textContent = "Não foi possível carregar a captura.";
    });
    image.src = result.dataUrl;
  })
  .catch(error => {
    elements.captureStatus.textContent = error.message || String(error);
  });
