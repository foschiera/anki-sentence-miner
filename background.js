import './tesseract.min.js';

const ANKI_CONNECT_URL = "http://localhost:8765";
const SETTINGS_KEY = "ankiMinerSettings";
const STATE_KEY = "ankiMinerState";
const DISCONNECT_NOTICE_KEY = "ankiMinerDisconnectNoticeShown";
const DEFAULT_SETTINGS = Object.freeze({
  deckName: "日本語",
  modelName: "Japones",
  fieldMappings: {
    word: "Palavra",
    reading: "Leitura",
    jlpt: "JLPT",
    meaning: "Significado",
    sentence: "Frase",
    audio: "Audio",
    image: ""
  },
  autoSync: false,
  syncBatchSize: 10
});
const FIELD_ALIASES = Object.freeze({
  word: ["palavra", "word", "expression", "expressao", "termo", "kanji", "漢字", "front", "frente"],
  reading: ["leitura", "reading", "kana", "hiragana", "furigana", "読み方", "よみかた", "ひらがな"],
  jlpt: ["jlpt", "nivel", "level"],
  meaning: ["significado", "meaning", "definition", "definicao", "sentido", "english", "ingles", "traducao", "back", "verso"],
  sentence: ["frase", "sentence", "contexto", "example", "exemplo"],
  audio: ["audio", "som", "sound"],
  image: ["imagem", "image", "picture", "screenshot", "foto"]
});

browser.runtime.onInstalled?.addListener(async () => {
  const stored = await browser.storage.local.get(SETTINGS_KEY);
  if (!stored[SETTINGS_KEY]) {
    await browser.storage.local.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
  }
});

async function getSettings() {
  const stored = await browser.storage.local.get(SETTINGS_KEY);
  const settings = stored[SETTINGS_KEY] || {};
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    fieldMappings: {
      ...DEFAULT_SETTINGS.fieldMappings,
      ...(settings.fieldMappings || {})
    }
  };
}

async function invokeAnki(action, params = undefined) {
  const controller = new AbortController();
  const timeoutMs = action === "sync" ? 120000 : 10000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(ANKI_CONNECT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, version: 6, ...(params === undefined ? {} : { params }) }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Anki-Connect respondeu com HTTP ${response.status}.`);
    }

    const data = await response.json();
    if (data.error) throw new Error(data.error);
    return data.result;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("O Anki-Connect não respondeu a tempo.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function setConnectionBadge(connected) {
  if (!browser.action) return;
  await browser.action.setBadgeText({ text: connected ? "●" : "!" });
  await browser.action.setBadgeBackgroundColor({ color: connected ? "#15803d" : "#b91c1c" });
  await browser.action.setTitle({
    title: connected ? "Web Anki Miner — Anki conectado" : "Web Anki Miner — Anki desconectado"
  });
}

// Serializa a leitura e escrita para que duas abas carregadas ao mesmo tempo
// não reivindiquem a mesma notificação de desconexão.
let disconnectNoticeQueue = Promise.resolve();

function updateDisconnectNoticeState(connected) {
  const operation = disconnectNoticeQueue.then(async () => {
    if (connected) {
      await browser.storage.local.set({ [DISCONNECT_NOTICE_KEY]: false });
      return false;
    }

    const stored = await browser.storage.local.get(DISCONNECT_NOTICE_KEY);
    if (stored[DISCONNECT_NOTICE_KEY]) return false;
    await browser.storage.local.set({ [DISCONNECT_NOTICE_KEY]: true });
    return true;
  });
  disconnectNoticeQueue = operation.catch(() => {});
  return operation;
}

async function healthcheck({ claimDisconnectNotice = false } = {}) {
  try {
    const version = await invokeAnki("version");
    await setConnectionBadge(true);
    await updateDisconnectNoticeState(true);
    return { connected: true, version, shouldNotify: false };
  } catch (error) {
    await setConnectionBadge(false);
    const shouldNotify = claimDisconnectNotice
      ? await updateDisconnectNoticeState(false)
      : false;
    return { connected: false, shouldNotify, error: error.message || String(error) };
  }
}

// Mantém um único worker para evitar recarregar o modelo japonês a cada recorte.
let tesseractWorker = null;
const pendingCaptures = new Map();

function deletePendingCapture(captureId) {
  const capture = pendingCaptures.get(captureId);
  if (capture?.expirationTimer) clearTimeout(capture.expirationTimer);
  pendingCaptures.delete(captureId);
}

function storePendingCapture(data) {
  const captureId = globalThis.crypto?.randomUUID?.() ||
    `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const expirationTimer = setTimeout(() => deletePendingCapture(captureId), 10 * 60 * 1000);
  pendingCaptures.set(captureId, { ...data, expirationTimer });
  return captureId;
}

async function openCaptureWindow(captureId, tab) {
  await browser.windows.create({
    url: browser.runtime.getURL(`ocr-capture.html?capture=${encodeURIComponent(captureId)}`),
    type: "popup",
    width: Math.max(640, Math.min(Number(tab.width) || 1100, 1200)),
    height: Math.max(520, Math.min(Number(tab.height) || 800, 900))
  });
}

async function openStandaloneCapture(tab) {
  const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const captureId = storePendingCapture({ dataUrl });

  try {
    await openCaptureWindow(captureId, tab);
  } catch (error) {
    deletePendingCapture(captureId);
    throw error;
  }
}

async function openSelectedTextReview(selectedText, tab) {
  const text = String(selectedText || "").trim();
  if (!text) return;
  const captureId = storePendingCapture({ selectedText: text });
  try {
    await openCaptureWindow(captureId, tab);
  } catch (error) {
    deletePendingCapture(captureId);
    throw error;
  }
}

if (browser.menus) {
  browser.menus.create({
    id: "mine-selected-text",
    title: "Minerar texto selecionado no Anki",
    contexts: ["selection"]
  }, () => void browser.runtime.lastError);

  browser.menus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== "mine-selected-text") return;
    return openSelectedTextReview(info.selectionText, tab).catch(error => {
      console.error("[PDF Text Selection Error]", error);
    });
  });
}

// A command invocation counts as an explicit extension action and grants the
// temporary `activeTab` permission needed by captureVisibleTab.
browser.commands.onCommand.addListener(async command => {
  if (command !== "start-area-selection") return;

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab || typeof tab.id !== "number") return;

  try {
    await browser.tabs.sendMessage(tab.id, { action: "start_screen_snip" });
  } catch (error) {
    // O visualizador PDF e outras páginas privilegiadas não aceitam content
    // scripts. Nesses casos, fazemos o recorte em uma janela da extensão.
    try {
      await openStandaloneCapture(tab);
    } catch (fallbackError) {
      console.error("[Area Selection Error] Não foi possível iniciar a seleção.", fallbackError);
    }
  }
});

async function getOcrWorker() {
  const T = globalThis.Tesseract;

  if (typeof T === "undefined") {
    throw new Error("Tesseract.js não foi encontrado no escopo global. Verifique a ordem no manifest.json.");
  }

  if (!tesseractWorker) {
    console.log("[OCR] Inicializando worker do Tesseract...");
    tesseractWorker = await T.createWorker('jpn', 1, {
      workerPath: browser.runtime.getURL('vendor/tesseract/worker.min.js'),
      // Firefox MV3 does not allow blob: in worker-src. Load the packaged
      // same-origin worker directly instead of Tesseract's default blob wrapper.
      workerBlobURL: false,
      corePath: browser.runtime.getURL('vendor/tesseract/tesseract-core-simd.wasm.js'),
      langPath: browser.runtime.getURL('tessdata'),
      logger: m => console.log("[Tesseract]", m)
    });
    await tesseractWorker.setParameters({
      tessedit_pageseg_mode: '7',
      preserve_interword_spaces: '1'
    });
    console.log("[OCR] Worker pronto!");
  }
  return tesseractWorker;
}

// Listener de mensagens
browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "add_to_anki") {
    return processAndSendNote(request.payload)
      .then(result => result.duplicate
        ? { success: false, ...result }
        : { success: true, ...result })
      .catch(error => {
        console.error("[Add Note Error]", error);
        return { success: false, error: error.message || String(error) };
      });
  }

  if (request.action === "crop_and_ocr") {
    return handleBrowserOcr(request.rect, sender.tab?.windowId)
      .then(ocrResult => {
        const word = extractDictionaryKeyword(ocrResult.text);
        return {
          success: true,
          term: word,
          ...ocrResult
        };
      })
      .catch(error => {
        console.error("[Crop & OCR Error]", error);
        return { success: false, error: error.message || String(error) };
      });
  }

  if (request.action === "get_pending_capture") {
    const capture = pendingCaptures.get(request.captureId);
    return Promise.resolve(capture
      ? {
          success: true,
          ...(capture.dataUrl ? { dataUrl: capture.dataUrl } : {}),
          ...(capture.selectedText ? {
            selectedText: capture.selectedText,
            term: extractDictionaryKeyword(capture.selectedText)
          } : {})
        }
      : { success: false, error: "A captura expirou. Pressione Alt+C novamente." });
  }

  if (request.action === "discard_pending_capture") {
    deletePendingCapture(request.captureId);
    return Promise.resolve({ success: true });
  }

  if (request.action === "ocr_captured_image") {
    const capture = pendingCaptures.get(request.captureId);
    if (!capture) {
      return Promise.resolve({ success: false, error: "A captura expirou. Pressione Alt+C novamente." });
    }
    return recognizeCapturedRegion(capture.dataUrl, request.rect)
      .then(ocrResult => {
        return {
          success: true,
          term: extractDictionaryKeyword(ocrResult.text),
          ...ocrResult
        };
      })
      .catch(error => {
        console.error("[Standalone OCR Error]", error);
        return { success: false, error: error.message || String(error) };
      });
  }

  if (request.action === "anki_healthcheck") {
    return healthcheck({ claimDisconnectNotice: Boolean(request.claimDisconnectNotice) });
  }
  if (request.action === "get_settings") return getSettings();
  if (request.action === "get_deck_options") {
    return Promise.all([getSettings(), invokeAnki("deckNames")])
      .then(([settings, decks]) => ({ decks, selectedDeck: settings.deckName }));
  }
  if (request.action === "anki_deck_names") return invokeAnki("deckNames");
  if (request.action === "anki_model_names") return invokeAnki("modelNames");
  if (request.action === "anki_model_fields") {
    return invokeAnki("modelFieldNames", { modelName: request.modelName });
  }
  if (request.action === "anki_sync") {
    return invokeAnki("sync").then(async result => {
      await browser.storage.local.set({ [STATE_KEY]: { addedSinceSync: 0 } });
      return { success: true, result };
    });
  }
});

// Usa a segmentação nativa do navegador para não consultar uma frase inteira
// como se fosse uma única entrada de dicionário.
function extractDictionaryKeyword(text) {
  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter('ja', { granularity: 'word' });
    const segment = Array.from(segmenter.segment(text))
      .find(item => item.isWordLike);
    if (segment) return segment.segment;
  }

  return text.split(/\s+/)[0].replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '') || text;
}

// Deconjugação e lematização heurística
function generateDeinflections(word) {
  const candidates = [word];

  const rules = [
    { suffix: "ました", replace: ["る", "う", "く", "ぐ", "す", "つ", "ぬ", "ぶ", "む"] },
    { suffix: "ません", replace: ["る", "う", "く", "ぐ", "す", "つ", "ぬ", "ぶ", "む"] },
    { suffix: "ます", replace: ["る", "う", "く", "ぐ", "す", "つ", "ぬ", "ぶ", "む"] },
    { suffix: "った", replace: ["う", "つ", "る"] },
    { suffix: "って", replace: ["う", "つ", "る"] },
    { suffix: "いた", replace: ["く"] },
    { suffix: "いて", replace: ["く"] },
    { suffix: "いだ", replace: ["ぐ"] },
    { suffix: "いで", replace: ["ぐ"] },
    { suffix: "した", replace: ["す", "する"] },
    { suffix: "して", replace: ["す", "する"] },
    { suffix: "んだ", replace: ["む", "ぶ", "ぬ"] },
    { suffix: "んで", replace: ["む", "ぶ", "ぬ"] },
    { suffix: "た", replace: ["る"] },
    { suffix: "て", replace: ["る"] },
    { suffix: "なかった", replace: ["い", "る", "う", "く", "ぐ", "す", "つ", "ぬ", "ぶ", "む"] },
    { suffix: "ない", replace: ["る", "う", "く", "ぐ", "す", "つ", "ぬ", "ぶ", "む"] },
    { suffix: "られた", replace: ["る"] },
    { suffix: "られる", replace: ["る"] },
    { suffix: "された", replace: ["する", "す"] },
    { suffix: "させる", replace: ["する", "る"] },
    { suffix: "させた", replace: ["する", "る"] },
    { suffix: "せられた", replace: ["す", "る"] },
    { suffix: "かった", replace: ["い"] },
    { suffix: "く", replace: ["い"] }
  ];

  for (const rule of rules) {
    if (word.endsWith(rule.suffix)) {
      const stem = word.slice(0, -rule.suffix.length);
      for (const rep of rule.replace) {
        candidates.push(stem + rep);
      }
    }
  }

  return [...new Set(candidates)];
}

// Consulta de vocabulário e JLPT no Jisho
async function fetchDictionaryEntry(keyword) {
  const wordsToTry = generateDeinflections(keyword);

  for (const queryWord of wordsToTry) {
    try {
      const url = `https://jisho.org/api/v1/search/words?keyword=${encodeURIComponent(queryWord)}`;
      const res = await fetch(url);
      if (!res.ok) continue;

      const data = await res.json();
      if (data.data && data.data.length > 0) {
        const firstEntry = data.data[0];
        const reading = firstEntry.japanese?.[0]?.reading || "";
        const baseWord = firstEntry.japanese?.[0]?.word || queryWord;

        let jlptLevel = "";
        if (firstEntry.jlpt && firstEntry.jlpt.length > 0) {
          jlptLevel = firstEntry.jlpt[0].replace("jlpt-", "").toUpperCase();
        }

        const definitionsList = firstEntry.senses
          .slice(0, 3)
          .map((sense, index) => `${index + 1}. ${sense.english_definitions.join(", ")}`)
          .join("<br>");

        return {
          baseWord,
          reading,
          jlptLevel,
          definitions: definitionsList
        };
      }
    } catch (err) {
      console.error(`Erro ao consultar ${queryWord}:`, err);
    }
  }

  return { baseWord: keyword, reading: "", jlptLevel: "", definitions: "Sem definição encontrada." };
}

function cleanOcrText(text, layout) {
  return String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map(line => line.replace(/[\t ]+/g, " ").trim())
    .filter(Boolean)
    .join(layout === "vertical" ? "" : " ")
    .trim();
}

function chooseOcrLayout(width, height) {
  const ratio = width / height;
  if (ratio < 0.75) {
    return { layout: "vertical", modes: ["5", "6"] };
  }
  if (ratio >= 4) {
    return { layout: "single-line", modes: ["7", "8", "6"] };
  }
  if (ratio >= 1.35) {
    return { layout: "text-line", modes: ["7", "6", "8"] };
  }
  return { layout: "text-block", modes: ["6", "7", "8"] };
}

function otsuThreshold(values) {
  const histogram = new Uint32Array(256);
  for (const value of values) histogram[value] += 1;

  let totalSum = 0;
  for (let i = 0; i < histogram.length; i++) totalSum += i * histogram[i];

  let backgroundWeight = 0;
  let backgroundSum = 0;
  let bestVariance = -1;
  let threshold = 127;

  for (let i = 0; i < histogram.length; i++) {
    backgroundWeight += histogram[i];
    if (!backgroundWeight) continue;
    const foregroundWeight = values.length - backgroundWeight;
    if (!foregroundWeight) break;

    backgroundSum += i * histogram[i];
    const backgroundMean = backgroundSum / backgroundWeight;
    const foregroundMean = (totalSum - backgroundSum) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * ((backgroundMean - foregroundMean) ** 2);
    if (variance > bestVariance) {
      bestVariance = variance;
      threshold = i;
    }
  }
  return threshold;
}

// Normaliza texto claro/escuro e adiciona uma margem limpa para fontes com
// contorno, sombra ou caracteres muito próximos da borda da seleção.
function createThresholdCanvas(sourceCanvas, reversePolarity = false) {
  const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
  if (!sourceContext?.getImageData) return null;

  const sourceImage = sourceContext.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
  const grayValues = new Uint8Array(sourceCanvas.width * sourceCanvas.height);
  let grayIndex = 0;
  for (let i = 0; i < sourceImage.data.length; i += 4) {
    grayValues[grayIndex++] = Math.round(
      sourceImage.data[i] * 0.299 +
      sourceImage.data[i + 1] * 0.587 +
      sourceImage.data[i + 2] * 0.114
    );
  }

  const threshold = otsuThreshold(grayValues);
  let edgeSum = 0;
  let edgeCount = 0;
  const width = sourceCanvas.width;
  const height = sourceCanvas.height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x > 1 && x < width - 2 && y > 1 && y < height - 2) continue;
      edgeSum += grayValues[y * width + x];
      edgeCount += 1;
    }
  }
  const backgroundIsLight = edgeCount ? edgeSum / edgeCount >= threshold : true;
  // A variação normal sempre entrega texto escuro sobre fundo claro; a segunda
  // passagem testa exatamente a polaridade oposta.
  const outputBackgroundIsLight = !reversePolarity;
  const padding = Math.max(10, Math.round(Math.min(width, height) * 0.08));
  const output = new OffscreenCanvas(width + padding * 2, height + padding * 2);
  const outputContext = output.getContext("2d");
  if (!outputContext?.createImageData || !outputContext?.putImageData) return null;

  outputContext.fillStyle = outputBackgroundIsLight ? "#fff" : "#000";
  outputContext.fillRect(0, 0, output.width, output.height);
  const binaryImage = outputContext.createImageData(width, height);
  for (let i = 0; i < grayValues.length; i++) {
    let value = grayValues[i] > threshold ? 255 : 0;
    if (!backgroundIsLight) value = 255 - value;
    if (reversePolarity) value = 255 - value;
    const offset = i * 4;
    binaryImage.data[offset] = value;
    binaryImage.data[offset + 1] = value;
    binaryImage.data[offset + 2] = value;
    binaryImage.data[offset + 3] = 255;
  }
  outputContext.putImageData(binaryImage, padding, padding);
  return output;
}

async function recognizeOcrCandidate(worker, canvas, mode, layout, variant) {
  await worker.setParameters({
    tessedit_pageseg_mode: mode,
    preserve_interword_spaces: "1"
  });
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const { data = {} } = await worker.recognize(blob);
  const text = cleanOcrText(data.text, layout);
  const numericConfidence = Number(data.confidence);
  return {
    text,
    confidence: Number.isFinite(numericConfidence) ? Math.round(numericConfidence) : null,
    mode,
    variant
  };
}

function candidateScore(candidate) {
  if (!candidate.text) return -1;
  const japaneseCharacters = (candidate.text.match(/[\u3040-\u30ff\u3400-\u9fff]/g) || []).length;
  const usefulCharacters = candidate.text.replace(/\s/g, "").length || 1;
  const languageBonus = (japaneseCharacters / usefulCharacters) * 12;
  return (candidate.confidence ?? 50) + languageBonus;
}

// Processamento do OCR na aba ativa
async function handleBrowserOcr(rect, windowId) {
  const dataUrl = await browser.tabs.captureVisibleTab(windowId, { format: "png" });
  return recognizeCapturedRegion(dataUrl, rect);
}

async function recognizeCapturedRegion(dataUrl, rect) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const img = await createImageBitmap(blob);

  const dimensions = rect && [
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    rect.viewportWidth,
    rect.viewportHeight
  ];
  if (!dimensions || !dimensions.every(Number.isFinite) ||
      rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0 ||
      rect.viewportWidth <= 0 || rect.viewportHeight <= 0) {
    img.close();
    throw new Error("As dimensões da área selecionada são inválidas.");
  }

  // A captura pode usar uma escala diferente de devicePixelRatio por causa do
  // zoom da página, escala do sistema ou implementação do navegador.
  const scaleX = img.width / rect.viewportWidth;
  const scaleY = img.height / rect.viewportHeight;
  const sourceX = Math.max(0, Math.floor(rect.x * scaleX));
  const sourceY = Math.max(0, Math.floor(rect.y * scaleY));
  const sourceRight = Math.min(img.width, Math.ceil((rect.x + rect.width) * scaleX));
  const sourceBottom = Math.min(img.height, Math.ceil((rect.y + rect.height) * scaleY));
  const sourceWidth = sourceRight - sourceX;
  const sourceHeight = sourceBottom - sourceY;

  if (sourceWidth <= 0 || sourceHeight <= 0) {
    img.close();
    throw new Error("A área selecionada está fora da parte visível da página.");
  }

  // Fontes pequenas ganham mais ampliação, sem deixar seleções grandes criarem
  // bitmaps maiores do que o necessário para o worker.
  const desiredScale = Math.max(2, Math.min(4, 96 / sourceHeight));
  const ocrScale = Math.min(desiredScale, 4096 / sourceWidth, 4096 / sourceHeight);
  const canvas = new OffscreenCanvas(sourceWidth * ocrScale, sourceHeight * ocrScale);
  const ctx = canvas.getContext('2d');

  if (!ctx) {
    img.close();
    throw new Error("Não foi possível preparar a imagem para o OCR.");
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  ctx.drawImage(
    img,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    canvas.width,
    canvas.height
  );
  img.close();

  const worker = await getOcrWorker();
  const layoutConfig = chooseOcrLayout(sourceWidth, sourceHeight);
  const candidates = [];
  candidates.push(await recognizeOcrCandidate(
    worker, canvas, layoutConfig.modes[0], layoutConfig.layout, "original"
  ));

  // Evita múltiplas passagens quando a leitura original já é confiável.
  if ((candidates[0].confidence ?? 0) < 78) {
    const normalizedCanvas = createThresholdCanvas(canvas);
    const invertedCanvas = createThresholdCanvas(canvas, true);
    if (normalizedCanvas) {
      candidates.push(await recognizeOcrCandidate(
        worker, normalizedCanvas, layoutConfig.modes[0], layoutConfig.layout, "high-contrast"
      ));
      candidates.push(await recognizeOcrCandidate(
        worker, normalizedCanvas, layoutConfig.modes[1], layoutConfig.layout, "alternate-layout"
      ));
    }
    if (invertedCanvas) {
      candidates.push(await recognizeOcrCandidate(
        worker, invertedCanvas, layoutConfig.modes[0], layoutConfig.layout, "inverted"
      ));
    }
  }

  const best = candidates.reduce((currentBest, candidate) =>
    candidateScore(candidate) > candidateScore(currentBest) ? candidate : currentBest
  );
  if (!best.text) {
    throw new Error("Nenhum caractere reconhecido na área.");
  }

  return {
    text: best.text,
    confidence: best.confidence,
    layout: layoutConfig.layout,
    attempts: candidates.length
  };
}

// Traduz a frase japonesa para português usando o endpoint web do Google Translate.
async function translateSentence(text) {
  if (!text) return "";

  const url = "https://translate.google.com/translate_a/single" +
    `?client=gtx&sl=ja&tl=pt&dt=t&q=${encodeURIComponent(text)}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Não foi possível traduzir a frase (HTTP ${response.status}).`);
  }

  const data = await response.json();
  const translation = Array.isArray(data?.[0])
    ? data[0].map(part => part?.[0] || "").join("").trim()
    : "";

  if (!translation) {
    throw new Error("O serviço de tradução não retornou uma tradução para a frase.");
  }

  return translation;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Criação e envio da nota para o Anki
function escapeAnkiQueryValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function assignMappedField(fields, fieldName, value) {
  if (fieldName) fields[fieldName] = value ?? "";
}

function normalizeFieldName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function fieldMatchesAliases(fieldName, aliases) {
  const normalizedField = normalizeFieldName(fieldName);
  return aliases.some(alias => {
    const normalizedAlias = normalizeFieldName(alias);
    return normalizedField === normalizedAlias ||
      (normalizedAlias.length >= 4 && normalizedField.includes(normalizedAlias));
  });
}

function adaptFieldMappings(configuredMappings, availableFields) {
  const mappings = {};
  const usedFields = new Set();
  for (const key of Object.keys(FIELD_ALIASES)) {
    const configuredField = configuredMappings?.[key];
    if (availableFields.includes(configuredField) && !usedFields.has(configuredField)) {
      mappings[key] = configuredField;
      usedFields.add(configuredField);
      continue;
    }
    mappings[key] = availableFields.find(field =>
      !usedFields.has(field) && fieldMatchesAliases(field, FIELD_ALIASES[key])
    ) || "";
    if (mappings[key]) usedFields.add(mappings[key]);
  }

  // Modelos básicos normalmente têm apenas Frente/Verso. Esses fallbacks
  // garantem que ao menos termo e significado sejam preenchidos.
  if (!mappings.word) {
    mappings.word = availableFields.find(field => !usedFields.has(field)) || "";
    if (mappings.word) usedFields.add(mappings.word);
  }
  if (!mappings.meaning) {
    mappings.meaning = availableFields.find(field => !usedFields.has(field)) || "";
    if (mappings.meaning) usedFields.add(mappings.meaning);
  }
  return mappings;
}

async function resolveDeckModel(settings, deckName) {
  const escapedDeck = escapeAnkiQueryValue(deckName);
  const noteIds = await invokeAnki("findNotes", {
    query: `deck:"${escapedDeck}" -deck:"${escapedDeck}::*"`
  });
  if (!Array.isArray(noteIds) || !noteIds.length) {
    return { modelName: settings.modelName, fieldMappings: settings.fieldMappings };
  }

  // IDs de notas são crescentes; a nota mais nova representa melhor o modelo
  // usado mais recentemente pelo usuário naquele deck.
  const latestNoteId = noteIds.reduce((latest, noteId) =>
    Number(noteId) > Number(latest) ? noteId : latest
  );
  const notes = await invokeAnki("notesInfo", { notes: [latestNoteId] });
  const modelName = notes?.[0]?.modelName || settings.modelName;
  if (!modelName || modelName === settings.modelName) {
    return { modelName, fieldMappings: settings.fieldMappings };
  }

  const availableFields = await invokeAnki("modelFieldNames", { modelName });
  return {
    modelName,
    fieldMappings: adaptFieldMappings(settings.fieldMappings, availableFields || [])
  };
}

async function registerSuccessfulAddition(settings) {
  if (!settings.autoSync) return {};

  const stored = await browser.storage.local.get(STATE_KEY);
  const current = Number(stored[STATE_KEY]?.addedSinceSync) || 0;
  const addedSinceSync = current + 1;
  const batchSize = Math.max(1, Number(settings.syncBatchSize) || DEFAULT_SETTINGS.syncBatchSize);

  if (addedSinceSync < batchSize) {
    await browser.storage.local.set({ [STATE_KEY]: { addedSinceSync } });
    return { addedSinceSync };
  }

  try {
    await invokeAnki("sync");
    await browser.storage.local.set({ [STATE_KEY]: { addedSinceSync: 0 } });
    return { addedSinceSync: 0, synced: true };
  } catch (error) {
    await browser.storage.local.set({ [STATE_KEY]: { addedSinceSync } });
    return { addedSinceSync, syncError: error.message || String(error) };
  }
}

async function processAndSendNote({ word, sentence = "", imageBase64 = "", deckName = "", forceDuplicate = false }) {
  if (!word || !String(word).trim()) throw new Error("Nenhum termo foi informado para mineração.");

  const configuredSettings = await getSettings();
  const selectedDeckName = String(deckName || configuredSettings.deckName).trim();
  const deckModel = selectedDeckName
    ? await resolveDeckModel(configuredSettings, selectedDeckName)
    : { modelName: configuredSettings.modelName, fieldMappings: configuredSettings.fieldMappings };
  const settings = {
    ...configuredSettings,
    modelName: deckModel.modelName,
    fieldMappings: deckModel.fieldMappings
  };
  if (!selectedDeckName || !settings.modelName || !settings.fieldMappings.word) {
    throw new Error("Configure o baralho, o tipo de nota e o campo Palavra no popup da extensão.");
  }

  const dictData = await fetchDictionaryEntry(word);
  const cleanSentence = sentence.replace(/<[^>]*>/g, "").trim();
  const translatedSentence = await translateSentence(cleanSentence || dictData.baseWord);
  const sentenceWithTranslation = `${sentence}<br><span class="sentence-translation">${escapeHtml(translatedSentence)}</span>`;

  if (!forceDuplicate) {
    const fieldSearch = `${settings.fieldMappings.word}:${dictData.baseWord}`;
    const query = `deck:"${escapeAnkiQueryValue(selectedDeckName)}" "${escapeAnkiQueryValue(fieldSearch)}"`;
    const existingNoteIds = await invokeAnki("findNotes", { query });
    if (Array.isArray(existingNoteIds) && existingNoteIds.length > 0) {
      return {
        duplicate: true,
        requiresConfirmation: true,
        deckName: selectedDeckName,
        text: dictData.baseWord,
        jlptLevel: dictData.jlptLevel,
        existingNoteIds
      };
    }
  }

  const ttsAudioUrl = `https://translate.google.com/translate_tts?ie=UTF-8&tl=ja&client=tw-ob&q=${encodeURIComponent(cleanSentence || dictData.baseWord)}`;

  const tags = ["web-miner", "audio-tts"];
  if (dictData.jlptLevel) {
    tags.push(`jlpt-${dictData.jlptLevel.toLowerCase()}`);
  }

  const fields = {};
  assignMappedField(fields, settings.fieldMappings.word, dictData.baseWord);
  assignMappedField(fields, settings.fieldMappings.reading, dictData.reading);
  assignMappedField(fields, settings.fieldMappings.jlpt, dictData.jlptLevel);
  assignMappedField(fields, settings.fieldMappings.meaning, dictData.definitions);
  assignMappedField(fields, settings.fieldMappings.sentence, sentenceWithTranslation);
  assignMappedField(fields, settings.fieldMappings.audio, "");
  assignMappedField(fields, settings.fieldMappings.image, "");

  const note = {
    deckName: selectedDeckName,
    modelName: settings.modelName,
    fields,
    tags,
    options: {
      // A mesma expressão pode existir em decks diferentes. Dentro do deck
      // escolhido, duplicatas continuam bloqueadas até a confirmação explícita.
      allowDuplicate: Boolean(forceDuplicate),
      duplicateScope: "deck",
      duplicateScopeOptions: {
        deckName: selectedDeckName,
        checkChildren: false,
        checkAllModels: false
      }
    }
  };

  if (settings.fieldMappings.audio) {
    note.audio = [{
      url: ttsAudioUrl,
      filename: `tts_${Date.now()}.mp3`,
      fields: [settings.fieldMappings.audio]
    }];
  }

  if (imageBase64 && settings.fieldMappings.image) {
    note.picture = [{
      data: imageBase64,
      filename: `frame_${Date.now()}.jpg`,
      fields: [settings.fieldMappings.image]
    }];
  }

  const noteId = await invokeAnki("addNote", { note });
  const syncState = await registerSuccessfulAddition(settings);
  return {
    data: noteId,
    deckName: selectedDeckName,
    text: dictData.baseWord,
    extractedText: word,
    jlptLevel: dictData.jlptLevel,
    ...syncState
  };
}
