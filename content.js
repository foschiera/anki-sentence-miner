// Listener de atalhos de teclado
document.addEventListener('keydown', (e) => {
  // Alt + A: Mineração de texto selecionado ou legenda de vídeo
  if (e.altKey && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    handleTextMining();
  }

});

// Alt+C é declarado em `commands` no manifest. Além de funcionar mesmo quando
// o foco está em um campo da página, isso concede ao background o `activeTab`
// necessário para capturar a aba no Firefox.
browser.runtime.onMessage.addListener(request => {
  if (request.action === "start_screen_snip") {
    startScreenSnip();
  }
});

// A página também verifica a disponibilidade do Anki ao carregar. O badge da
// toolbar é atualizado pelo background e a página só é avisada em caso de falha.
function checkAnkiOnPageLoad() {
  browser.runtime.sendMessage({ action: "anki_healthcheck" })
    .then(status => {
      if (status && status.connected === false) {
        showToast({
          type: "error",
          title: "Anki desconectado",
          message: "Abra o Anki Desktop e verifique se o AnkiConnect está ativo."
        });
      }
    })
    .catch(() => {});
}

if (document.readyState === "complete") checkAnkiOnPageLoad();
else if (typeof window.addEventListener === "function") window.addEventListener("load", checkAnkiOnPageLoad, { once: true });

function showToast({ type = "success", title, message, term = "", jlpt = "", actionLabel = "", onAction = null }) {
  let region = document.getElementById("anki-miner-toast-region");
  if (!region) {
    region = document.createElement("div");
    region.id = "anki-miner-toast-region";
    region.setAttribute("aria-live", "polite");
    region.setAttribute("aria-atomic", "false");
    document.documentElement.appendChild(region);
  }

  const toast = document.createElement("div");
  toast.className = `anki-miner-toast anki-miner-toast--${type}`;
  toast.setAttribute("role", type === "error" ? "alert" : "status");

  const titleRow = document.createElement("div");
  titleRow.className = "anki-miner-toast__title";
  const titleText = document.createElement("span");
  titleText.textContent = title || (type === "success" ? "Adicionado ao Anki" : "Web Anki Miner");
  titleRow.appendChild(titleText);

  if (jlpt) {
    const badge = document.createElement("span");
    badge.className = "anki-miner-toast__badge";
    badge.textContent = jlpt;
    titleRow.appendChild(badge);
  }

  const body = document.createElement("div");
  body.className = "anki-miner-toast__message";
  body.textContent = message || term;

  const closeButton = document.createElement("button");
  closeButton.className = "anki-miner-toast__close";
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", "Fechar notificação");
  closeButton.textContent = "×";

  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    toast.className += " anki-miner-toast--leaving";
    if (typeof setTimeout === "function") setTimeout(() => toast.remove(), 180);
    else toast.remove();
  };

  closeButton.addEventListener("click", dismiss);
  toast.appendChild(titleRow);
  toast.appendChild(body);
  toast.appendChild(closeButton);

  if (actionLabel && typeof onAction === "function") {
    const actionButton = document.createElement("button");
    actionButton.className = "anki-miner-toast__action";
    actionButton.type = "button";
    actionButton.textContent = actionLabel;
    actionButton.addEventListener("click", () => {
      dismiss();
      onAction();
    });
    toast.appendChild(actionButton);
  }

  region.appendChild(toast);
  if (typeof setTimeout === "function") setTimeout(dismiss, 2500);
  return toast;
}

// Manipula mineração padrão (Texto ou Legenda)
async function handleTextMining() {
  const selection = window.getSelection();
  let selectedText = selection.toString().trim();
  let sentence = "";
  let minedSubtitle = false;

  if (selectedText) {
    sentence = extractSurroundingSentence(selection, selectedText);
  } else {
    const subtitleText = getActiveSubtitleText();
    if (subtitleText) {
      selectedText = subtitleText;
      sentence = subtitleText;
      minedSubtitle = true;
    }
  }

  if (!selectedText) {
    showToast({ type: "warning", title: "Nada para minerar", message: "Selecione um texto ou ative uma legenda no vídeo." });
    return;
  }

  const payload = { word: selectedText, sentence };
  if (minedSubtitle) {
    try {
      const stored = await browser.storage.local.get("ankiMinerSettings");
      if (stored.ankiMinerSettings?.fieldMappings?.image) {
        payload.imageBase64 = captureCurrentVideoFrame();
      }
    } catch (error) {
      console.warn("[Video Snapshot] O frame não pôde ser capturado:", error);
    }
  }

  await sendMiningRequest(payload);
}

async function sendMiningRequest(payload) {
  try {
    const response = await browser.runtime.sendMessage({ action: "add_to_anki", payload });
    if (response?.success) {
      const syncMessage = response.syncError
        ? `Cartão salvo; a sincronização falhou: ${response.syncError}`
        : response.synced ? "Cartão salvo e sincronizado com o AnkiWeb." : "Cartão criado com sucesso.";
      showToast({ type: response.syncError ? "warning" : "success", title: "Adicionado ao Anki", message: `${response.text || payload.word} — ${syncMessage}`, term: response.text, jlpt: response.jlptLevel });
      return;
    }

    if (response?.duplicate && response.requiresConfirmation) {
      showToast({
        type: "warning",
        title: "Nota duplicada",
        message: `${response.text || payload.word} já existe no baralho.`,
        term: response.text || payload.word,
        jlpt: response.jlptLevel,
        actionLabel: "Adicionar mesmo assim",
        onAction: () => sendMiningRequest({ ...payload, forceDuplicate: true })
      });
      return;
    }

    showToast({ type: "error", title: "Falha ao adicionar", message: response?.error || "Sem resposta do Anki-Connect", term: payload.word });
  } catch (error) {
    showToast({ type: "error", title: "Erro de comunicação", message: error.message || String(error), term: payload.word });
  }
}

function captureCurrentVideoFrame() {
  const videos = Array.from(document.querySelectorAll("video"))
    .filter(video => video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0)
    .sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight));
  const video = videos[0];
  if (!video) return "";

  const maxWidth = 1280;
  const scale = Math.min(1, maxWidth / video.videoWidth);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const context = canvas.getContext("2d");
  if (!context) return "";
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.84).split(",")[1] || "";
}

// Captura legendas ativas na Netflix, YouTube e players web comuns
function getActiveSubtitleText() {
  // YouTube
  const ytSub = document.querySelector('.ytp-caption-segment');
  if (ytSub && ytSub.textContent.trim()) {
    return ytSub.textContent.trim();
  }

  // Netflix
  const netflixSubNodes = document.querySelectorAll('.player-timedtext-text-container span, .player-timedtext span');
  if (netflixSubNodes.length > 0) {
    return Array.from(netflixSubNodes).map(s => s.textContent).join(' ').trim();
  }

  return "";
}

// Isola a frase ao redor da palavra usando pontuação japonesa e ocidental
function extractSurroundingSentence(selection, selectedWord) {
  const node = selection.anchorNode;
  if (!node) return selectedWord;

  const fullText = (node.nodeType === Node.TEXT_NODE ? node.textContent : node.innerText) || selectedWord;
  const delimiterRegex = /[。！？!?\n]/;
  const targetIndex = fullText.indexOf(selectedWord);
  if (targetIndex === -1) return selectedWord;

  let startIndex = 0;
  for (let i = targetIndex - 1; i >= 0; i--) {
    if (delimiterRegex.test(fullText[i])) {
      startIndex = i + 1;
      break;
    }
  }

  let endIndex = fullText.length;
  for (let i = targetIndex + selectedWord.length; i < fullText.length; i++) {
    if (delimiterRegex.test(fullText[i])) {
      endIndex = i + 1;
      break;
    }
  }

  let sentence = fullText.substring(startIndex, endIndex).trim();

  // Trunca caso o bloco seja excessivamente longo
  if (sentence.length > 160) {
    const localStart = Math.max(0, targetIndex - startIndex - 30);
    const localEnd = Math.min(sentence.length, (targetIndex - startIndex) + selectedWord.length + 30);
    sentence = "..." + sentence.substring(localStart, localEnd).trim() + "...";
  }

  // Destaca a palavra na frase em negrito
  sentence = sentence.replace(selectedWord, `<b>${selectedWord}</b>`);
  return sentence;
}

// Snipping tool visual para recorte de OCR
function startScreenSnip() {
  if (document.getElementById('anki-ocr-overlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'anki-ocr-overlay';
  overlay.setAttribute('role', 'application');
  overlay.setAttribute('aria-label', 'Selecione uma área para reconhecer o texto. Pressione Escape para cancelar.');
  overlay.tabIndex = -1;
  overlay.style.cssText = `
    position: fixed; inset: 0;
    background: rgba(0, 0, 0, 0.4); z-index: 2147483647; cursor: crosshair;
    user-select: none; touch-action: none;
  `;

  const selectionBox = document.createElement('div');
  selectionBox.style.cssText = `
    position: absolute; border: 2px dashed #58a6ff;
    background: rgba(88, 166, 255, 0.2); pointer-events: none; display: none;
  `;
  overlay.appendChild(selectionBox);
  document.documentElement.appendChild(overlay);
  overlay.focus({ preventScroll: true });

  let startX = 0;
  let startY = 0;
  let activePointerId = null;

  const clampToViewport = (x, y) => ({
    x: Math.max(0, Math.min(window.innerWidth, x)),
    y: Math.max(0, Math.min(window.innerHeight, y))
  });

  const cancelSelection = () => {
    overlay.remove();
    document.removeEventListener('keydown', handleCancel, true);
  };

  const handleCancel = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelSelection();
    }
  };

  document.addEventListener('keydown', handleCancel, true);

  const updateSelectionBox = (clientX, clientY) => {
    const current = clampToViewport(clientX, clientY);
    const left = Math.min(startX, current.x);
    const top = Math.min(startY, current.y);
    const width = Math.abs(current.x - startX);
    const height = Math.abs(current.y - startY);

    selectionBox.style.left = `${left}px`;
    selectionBox.style.top = `${top}px`;
    selectionBox.style.width = `${width}px`;
    selectionBox.style.height = `${height}px`;
  };

  overlay.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || activePointerId !== null) return;

    e.preventDefault();
    const start = clampToViewport(e.clientX, e.clientY);
    startX = start.x;
    startY = start.y;
    activePointerId = e.pointerId;
    overlay.setPointerCapture(e.pointerId);
    selectionBox.style.left = `${startX}px`;
    selectionBox.style.top = `${startY}px`;
    selectionBox.style.width = '0px';
    selectionBox.style.height = '0px';
    selectionBox.style.display = 'block';
  });

  overlay.addEventListener('pointermove', (e) => {
    if (e.pointerId !== activePointerId) return;
    updateSelectionBox(e.clientX, e.clientY);
  });

  overlay.addEventListener('pointerup', async (e) => {
    if (e.pointerId !== activePointerId) return;

    updateSelectionBox(e.clientX, e.clientY);
    activePointerId = null;
    const rect = {
      x: Number.parseFloat(selectionBox.style.left),
      y: Number.parseFloat(selectionBox.style.top),
      width: Number.parseFloat(selectionBox.style.width),
      height: Number.parseFloat(selectionBox.style.height),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight
    };

    cancelSelection();

    if (rect.width > 8 && rect.height > 8) {
      // Espera o compositor redesenhar a página sem o overlay escuro.
      await new Promise(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      });

      browser.runtime.sendMessage({ action: "crop_and_ocr", rect })
        .then(res => {
          if (res && res.success) {
            showToast({ type: "success", title: "OCR concluído", message: res.text, term: res.term, jlpt: res.jlptLevel });
          } else if (res?.duplicate && res.requiresConfirmation) {
            showToast({
              type: "warning",
              title: "Nota duplicada",
              message: `${res.term || res.text} já existe no baralho.`,
              term: res.term,
              jlpt: res.jlptLevel,
              actionLabel: "Adicionar mesmo assim",
              onAction: () => sendMiningRequest({ word: res.term || res.text, sentence: res.text, forceDuplicate: true })
            });
          } else {
            showToast({ type: "error", title: "Erro no OCR", message: res?.error || "Falha na comunicação" });
          }
        }).catch(err => {
          showToast({ type: "error", title: "Erro no OCR", message: err?.message || "Falha desconhecida" });
        });
    }
  });

  overlay.addEventListener('pointercancel', cancelSelection);
}
