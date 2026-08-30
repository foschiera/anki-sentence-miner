// Listener de atalhos de teclado
document.addEventListener('keydown', (e) => {
  // Alt + A: Mineração de texto selecionado ou legenda de vídeo
  if (e.altKey && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    handleTextMining();
  }

  // Alt + C: Snipping Tool / OCR de área
  if (e.altKey && e.key.toLowerCase() === 'c') {
    e.preventDefault();
    e.stopPropagation();
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
  overlay.style.cssText = `
    position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
    background: rgba(0, 0, 0, 0.4); z-index: 999999; cursor: crosshair;
  `;

  const selectionBox = document.createElement('div');
  selectionBox.style.cssText = `
    position: absolute; border: 2px dashed #58a6ff;
    background: rgba(88, 166, 255, 0.2); pointer-events: none; display: none;
  `;
  overlay.appendChild(selectionBox);
  document.body.appendChild(overlay);

  let startX, startY, isDragging = false;

  overlay.addEventListener('mousedown', (e) => {
    startX = e.clientX;
    startY = e.clientY;
    isDragging = true;
    selectionBox.style.left = `${startX}px`;
    selectionBox.style.top = `${startY}px`;
    selectionBox.style.width = '0px';
    selectionBox.style.height = '0px';
    selectionBox.style.display = 'block';
  });

  overlay.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const currentX = e.clientX;
    const currentY = e.clientY;

    const left = Math.min(startX, currentX);
    const top = Math.min(startY, currentY);
    const width = Math.abs(currentX - startX);
    const height = Math.abs(currentY - startY);

    selectionBox.style.left = `${left}px`;
    selectionBox.style.top = `${top}px`;
    selectionBox.style.width = `${width}px`;
    selectionBox.style.height = `${height}px`;
  });

  overlay.addEventListener('mouseup', async (e) => {
    isDragging = false;
    const rect = {
      x: parseInt(selectionBox.style.left),
      y: parseInt(selectionBox.style.top),
      width: parseInt(selectionBox.style.width),
      height: parseInt(selectionBox.style.height),
      dpr: window.devicePixelRatio || 1
    };

    overlay.remove();

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
}
