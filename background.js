import './tesseract.min.js';

// Mantém um único worker para evitar recarregar o modelo japonês a cada recorte.
let tesseractWorker = null;

async function getOcrWorker() {
  const T = globalThis.Tesseract;

  if (typeof T === "undefined") {
    throw new Error("Tesseract.js não foi encontrado no escopo global. Verifique a ordem no manifest.json.");
  }

  if (!tesseractWorker) {
    console.log("[OCR] Inicializando worker do Tesseract...");
    tesseractWorker = await T.createWorker('jpn', 1, {
      workerPath: browser.runtime.getURL('vendor/tesseract/worker.min.js'),
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
      .then(result => ({ success: true, text: result.extractedText, data: result.data }))
      .catch(error => {
        console.error("[Add Note Error]", error);
        return { success: false, error: error.message || String(error) };
      });
  }

  if (request.action === "crop_and_ocr") {
    return handleBrowserOcr(request.rect)
      .then(extractedText => {
        const word = extractDictionaryKeyword(extractedText);
        return processAndSendNote({ word, sentence: extractedText })
          .then(result => ({ result, extractedText }));
      })
      .then(({ result, extractedText }) => ({
        success: true,
        text: extractedText,
        data: result.data
      }))
      .catch(error => {
        console.error("[Crop & OCR Error]", error);
        return { success: false, error: error.message || String(error) };
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
async function handleBrowserOcr(rect) {
  const dataUrl = await browser.tabs.captureVisibleTab(null, { format: "png" });
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const img = await createImageBitmap(blob);

  const sourceWidth = Math.max(1, Math.round(rect.width * rect.dpr));
  const sourceHeight = Math.max(1, Math.round(rect.height * rect.dpr));
  const ocrScale = 2;
  const canvas = new OffscreenCanvas(sourceWidth * ocrScale, sourceHeight * ocrScale);
  const ctx = canvas.getContext('2d');

  if (!ctx) {
    throw new Error("Não foi possível preparar a imagem para o OCR.");
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  ctx.drawImage(
    img,
    Math.round(rect.x * rect.dpr),
    Math.round(rect.y * rect.dpr),
    sourceWidth,
    sourceHeight,
    0,
    0,
    canvas.width,
    canvas.height
  );

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
async function processAndSendNote({ word, sentence }) {
  const dictData = await fetchDictionaryEntry(word);
  const cleanSentence = sentence.replace(/<[^>]*>/g, "").trim();
  const translatedSentence = await translateSentence(cleanSentence || dictData.baseWord);
  const sentenceWithTranslation = `${sentence}<br><span class="sentence-translation">${escapeHtml(translatedSentence)}</span>`;

  const ttsAudioUrl = `https://translate.google.com/translate_tts?ie=UTF-8&tl=ja&client=tw-ob&q=${encodeURIComponent(cleanSentence || dictData.baseWord)}`;

  const tags = ["web-miner", "audio-tts"];
  if (dictData.jlptLevel) {
    tags.push(`jlpt-${dictData.jlptLevel.toLowerCase()}`);
  }

  const payload = {
    action: "addNote",
    version: 6,
    params: {
      note: {
        deckName: "日本語",
        modelName: "Japones",
        fields: {
          Palavra: dictData.baseWord,
          PalavraMinerada: word,
          Leitura: dictData.reading,
          JLPT: dictData.jlptLevel,
          Significado: dictData.definitions,
          Frase: sentenceWithTranslation,
          Audio: ""
        },
        audio: [{
          url: ttsAudioUrl,
          filename: `tts_${Date.now()}.mp3`,
          fields: ["Audio"]
        }],
        tags: tags
      }
    }
  };

  const response = await fetch("http://localhost:8765", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  if (data.error) {
    throw new Error(data.error);
  }

  return { data: data.result, extractedText: word };
}
