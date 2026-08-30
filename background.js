import './tesseract.min.js';

const ANKI_CONNECT_URL = "http://localhost:8765";
const SETTINGS_KEY = "ankiMinerSettings";
const STATE_KEY = "ankiMinerState";
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

async function healthcheck() {
  try {
    const version = await invokeAnki("version");
    await setConnectionBadge(true);
    return { connected: true, version };
  } catch (error) {
    await setConnectionBadge(false);
    return { connected: false, error: error.message || String(error) };
  }
}

// Mantém um único worker para evitar recarregar o modelo japonês a cada recorte.
let tesseractWorker = null;

// A command invocation counts as an explicit extension action and grants the
// temporary `activeTab` permission needed by captureVisibleTab.
browser.commands.onCommand.addListener(async command => {
  if (command !== "start-area-selection") return;

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab || typeof tab.id !== "number") return;

  try {
    await browser.tabs.sendMessage(tab.id, { action: "start_screen_snip" });
  } catch (error) {
    console.error("[Area Selection Error] A seleção não está disponível nesta página.", error);
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
      .then(extractedText => {
        const word = extractDictionaryKeyword(extractedText);
        return processAndSendNote({ word, sentence: extractedText })
          .then(result => ({ result, extractedText }));
      })
      .then(({ result, extractedText }) => ({
        success: !result.duplicate,
        ...result,
        term: result.text,
        text: extractedText
      }))
      .catch(error => {
        console.error("[Crop & OCR Error]", error);
        return { success: false, error: error.message || String(error) };
      });
  }

  if (request.action === "anki_healthcheck") return healthcheck();
  if (request.action === "get_settings") return getSettings();
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

// Processamento do OCR na aba ativa
async function handleBrowserOcr(rect, windowId) {
  const dataUrl = await browser.tabs.captureVisibleTab(windowId, { format: "png" });
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

  const ocrScale = 2;
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

  const croppedBlob = await canvas.convertToBlob({ type: "image/png" });
  const worker = await getOcrWorker();
  const { data: { text } } = await worker.recognize(croppedBlob);

  const cleanText = text
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.replace(/[\t ]+/g, ' ').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
  if (!cleanText) {
    throw new Error("Nenhum caractere reconhecido na área.");
  }

  return cleanText;
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

async function processAndSendNote({ word, sentence = "", imageBase64 = "", forceDuplicate = false }) {
  if (!word || !String(word).trim()) throw new Error("Nenhum termo foi informado para mineração.");

  const settings = await getSettings();
  if (!settings.deckName || !settings.modelName || !settings.fieldMappings.word) {
    throw new Error("Configure o baralho, o tipo de nota e o campo Palavra no popup da extensão.");
  }

  const dictData = await fetchDictionaryEntry(word);
  const cleanSentence = sentence.replace(/<[^>]*>/g, "").trim();
  const translatedSentence = await translateSentence(cleanSentence || dictData.baseWord);
  const sentenceWithTranslation = `${sentence}<br><span class="sentence-translation">${escapeHtml(translatedSentence)}</span>`;

  if (!forceDuplicate) {
    const fieldSearch = `${settings.fieldMappings.word}:${dictData.baseWord}`;
    const query = `deck:"${escapeAnkiQueryValue(settings.deckName)}" "${escapeAnkiQueryValue(fieldSearch)}"`;
    const existingNoteIds = await invokeAnki("findNotes", { query });
    if (Array.isArray(existingNoteIds) && existingNoteIds.length > 0) {
      return {
        duplicate: true,
        requiresConfirmation: true,
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
    deckName: settings.deckName,
    modelName: settings.modelName,
    fields,
    tags
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
    text: dictData.baseWord,
    extractedText: word,
    jlptLevel: dictData.jlptLevel,
    ...syncState
  };
}
