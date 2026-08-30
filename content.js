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

// Manipula mineração padrão (Texto ou Legenda)
function handleTextMining() {
  const selection = window.getSelection();
  let selectedText = selection.toString().trim();
  let sentence = "";

  if (selectedText) {
    sentence = extractSurroundingSentence(selection, selectedText);
  } else {
    const subtitleText = getActiveSubtitleText();
    if (subtitleText) {
      selectedText = subtitleText;
      sentence = subtitleText;
    }
  }

  if (!selectedText) {
    alert("Nenhum texto ou legenda detectada!");
    return;
  }

  browser.runtime.sendMessage({
    action: "add_to_anki",
    payload: {
      word: selectedText,
      sentence: sentence
    }
  }).then(response => {
    if (response && response.success) {
      alert(`Adicionado ao Anki: ${selectedText}`);
    } else {
      alert(`Erro: ${response ? response.error : 'Sem resposta do Anki-Connect'}`);
    }
  }).catch(error => {
    alert(`Erro de comunicação: ${error.message}`);
  });
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
            alert(`OCR Concluído!\nTexto: ${res.text}`);
          } else {
            alert(`Erro no OCR: ${res && res.error ? res.error : 'Falha na comunicação'}`);
          }
        }).catch(err => {
          alert(`Erro: ${err ? err.message : 'Falha desconhecida'}`);
        });
    }
  });

  overlay.addEventListener('pointercancel', cancelSelection);
}
