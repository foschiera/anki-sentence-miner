const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');

test('extension CSP permits only packaged Tesseract workers', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'manifest.json'), 'utf8'));
  const policy = manifest.content_security_policy.extension_pages;

  assert.match(policy, /worker-src[^;]*'self'/);
  assert.doesNotMatch(policy, /worker-src[^;]*blob:/);
});

class EventTargetMock {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    this.listeners.set(type, listeners.filter(item => item !== listener));
  }

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }
}

class ElementMock extends EventTargetMock {
  constructor(tagName) {
    super();
    this.tagName = tagName;
    this.children = [];
    this.style = {};
    this.id = '';
  }

  appendChild(child) {
    child.parent = this;
    this.children.push(child);
  }

  replaceChildren(...children) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    for (const child of children) this.appendChild(child);
  }

  focus() {}

  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }

  setAttribute() {}
  setPointerCapture() {}
}

function createContentContext({ selectedText = '' } = {}) {
  const document = new EventTargetMock();
  document.documentElement = new ElementMock('html');
  document.createElement = tagName => new ElementMock(tagName);
  document.getElementById = id => {
    const findById = element => {
      if (element.id === id) return element;
      for (const child of element.children || []) {
        const match = findById(child);
        if (match) return match;
      }
      return null;
    };
    return findById(document.documentElement);
  };

  let contentMessageListener;
  const sentMessages = [];
  const context = vm.createContext({
    alert() {},
    browser: {
      runtime: {
        onMessage: { addListener(listener) { contentMessageListener = listener; } },
        sendMessage(message) {
          sentMessages.push(message);
          if (message.action === 'crop_and_ocr') {
            return Promise.resolve({
              success: true,
              term: '日本語',
              text: '日本語',
              confidence: 91,
              layout: 'text-line'
            });
          }
          if (message.action === 'get_deck_options') {
            return Promise.resolve({
              decks: ['Baralho padrão', 'Leitura::Japonês'],
              selectedDeck: 'Baralho padrão'
            });
          }
          return Promise.resolve({ success: true, text: '日本語' });
        }
      }
    },
    console,
    document,
    Node: { TEXT_NODE: 3 },
    requestAnimationFrame(callback) { callback(); },
    window: {
      innerWidth: 800,
      innerHeight: 600,
      getSelection() {
        return {
          anchorNode: selectedText ? { nodeType: 3, textContent: `これは${selectedText}です。` } : null,
          toString() { return selectedText; }
        };
      }
    }
  });

  const source = fs.readFileSync(path.join(projectRoot, 'content.js'), 'utf8');
  vm.runInContext(source, context);
  return { contentMessageListener, document, sentMessages };
}

test('Alt+C message starts a reverse-direction area selection with viewport metadata', async () => {
  const { contentMessageListener, document, sentMessages } = createContentContext();

  contentMessageListener({ action: 'start_screen_snip' });
  const overlay = document.getElementById('anki-ocr-overlay');
  assert.ok(overlay);

  overlay.dispatch('pointerdown', {
    button: 0,
    pointerId: 7,
    clientX: 500,
    clientY: 350,
    preventDefault() {}
  });
  overlay.dispatch('pointerup', { pointerId: 7, clientX: 100, clientY: 50 });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(document.getElementById('anki-ocr-overlay'), null);
  assert.deepEqual(JSON.parse(JSON.stringify(sentMessages[0])), {
    action: 'crop_and_ocr',
    rect: {
      x: 100,
      y: 50,
      width: 400,
      height: 300,
      viewportWidth: 800,
      viewportHeight: 600
    }
  });
});

test('Escape cancels area selection without starting OCR', () => {
  const { contentMessageListener, document, sentMessages } = createContentContext();
  contentMessageListener({ action: 'start_screen_snip' });

  document.dispatch('keydown', {
    key: 'Escape',
    preventDefault() {},
    stopPropagation() {}
  });

  assert.equal(document.getElementById('anki-ocr-overlay'), null);
  assert.equal(sentMessages.length, 0);
});

test('OCR crop uses the captured bitmap scale instead of devicePixelRatio', async () => {
  let commandListener;
  let backgroundMessageListener;
  let workerOptions;
  let drawArguments;
  let imageClosed = false;
  let recognitionCount = 0;
  let contentScriptAvailable = true;
  const createdWindows = [];
  let menuClickListener;
  let menuDefinition;
  const worker = {
    async setParameters() {},
    async recognize() {
      recognitionCount += 1;
      const results = [
        { text: ' 誤\n', confidence: 45 },
        { text: ' 日本語\n', confidence: 92 },
        { text: ' 日本語\n', confidence: 80 },
        { text: ' 日本語\n', confidence: 70 }
      ];
      return { data: results[recognitionCount - 1] || { text: ' 日本語\n', confidence: 92 } };
    }
  };

  class OffscreenCanvasMock {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this.context = {
        drawImage(...args) { drawArguments = args; },
        imageSmoothingEnabled: false,
        imageSmoothingQuality: 'low',
        fillStyle: '',
        fillRect() {},
        getImageData: () => {
          const data = new Uint8ClampedArray(this.width * this.height * 4);
          for (let i = 0; i < data.length; i += 4) {
            const pixel = i / 4 < this.width * this.height / 2 ? 0 : 255;
            data[i] = pixel;
            data[i + 1] = pixel;
            data[i + 2] = pixel;
            data[i + 3] = 255;
          }
          return { data };
        },
        createImageData: (imageWidth, imageHeight) => ({
          data: new Uint8ClampedArray(imageWidth * imageHeight * 4)
        }),
        putImageData() {}
      };
    }

    getContext() {
      return this.context;
    }

    async convertToBlob() { return {}; }
  }

  const context = vm.createContext({
    browser: {
      commands: { onCommand: { addListener(listener) { commandListener = listener; } } },
      runtime: {
        getURL(value) { return value; },
        onMessage: { addListener(listener) { backgroundMessageListener = listener; } }
      },
      tabs: {
        async captureVisibleTab() { return 'data:image/png;base64,test'; },
        async query() { return [{ id: 12, windowId: 3, width: 1000, height: 700 }]; },
        async sendMessage() {
          if (!contentScriptAvailable) throw new Error('Receiving end does not exist');
        }
      },
      windows: {
        async create(options) { createdWindows.push(options); }
      },
      menus: {
        create(definition, callback) {
          menuDefinition = definition;
          if (callback) callback();
        },
        onClicked: {
          addListener(listener) { menuClickListener = listener; }
        }
      }
    },
    console,
    clearTimeout,
    createImageBitmap: async () => ({
      width: 2000,
      height: 1000,
      close() { imageClosed = true; }
    }),
    fetch: async () => ({ blob: async () => ({}) }),
    globalThis: null,
    OffscreenCanvas: OffscreenCanvasMock,
    setTimeout
  });
  context.globalThis = context;
  context.Tesseract = {
    async createWorker(language, engineMode, options) {
      workerOptions = options;
      return worker;
    }
  };

  const source = fs.readFileSync(path.join(projectRoot, 'background.js'), 'utf8')
    .replace("import './tesseract.min.js';", '');
  vm.runInContext(source, context);

  await commandListener('start-area-selection');
  const text = await vm.runInContext(`handleBrowserOcr({
    x: 100, y: 50, width: 200, height: 100,
    viewportWidth: 1000, viewportHeight: 500
  })`, context);

  assert.deepEqual(JSON.parse(JSON.stringify(text)), {
    text: '日本語',
    confidence: 92,
    layout: 'text-line',
    attempts: 4
  });
  assert.equal(imageClosed, true);
  assert.equal(workerOptions.workerBlobURL, false);
  assert.deepEqual(drawArguments.slice(1), [200, 100, 400, 200, 0, 0, 800, 400]);

  const response = await backgroundMessageListener({
    action: 'crop_and_ocr',
    rect: {
      x: 100, y: 50, width: 200, height: 100,
      viewportWidth: 1000, viewportHeight: 500
    }
  }, { tab: { windowId: 3 } });
  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    success: true,
    term: '日本語',
    text: '日本語',
    confidence: 92,
    layout: 'text-line',
    attempts: 1
  });

  const layouts = await vm.runInContext(`[
    chooseOcrLayout(600, 100),
    chooseOcrLayout(200, 100),
    chooseOcrLayout(100, 200),
    chooseOcrLayout(100, 100)
  ]`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(layouts.map(item => item.layout))), [
    'single-line', 'text-line', 'vertical', 'text-block'
  ]);

  contentScriptAvailable = false;
  await commandListener('start-area-selection');
  assert.equal(createdWindows.length, 1);
  assert.equal(createdWindows[0].type, 'popup');
  assert.match(createdWindows[0].url, /ocr-capture\.html\?capture=/);

  const captureId = new URL(createdWindows[0].url, 'moz-extension://test/').searchParams.get('capture');
  const pendingCapture = await backgroundMessageListener({
    action: 'get_pending_capture',
    captureId
  });
  assert.equal(pendingCapture.success, true);
  assert.equal(pendingCapture.dataUrl, 'data:image/png;base64,test');
  await backgroundMessageListener({ action: 'discard_pending_capture', captureId });

  assert.equal(menuDefinition.id, 'mine-selected-text');
  assert.deepEqual(JSON.parse(JSON.stringify(menuDefinition.contexts)), ['selection']);
  await menuClickListener({
    menuItemId: 'mine-selected-text',
    selectionText: '日本語'
  }, { id: 12, windowId: 3, width: 1000, height: 700 });
  assert.equal(createdWindows.length, 2);
  const textCaptureId = new URL(
    createdWindows[1].url,
    'moz-extension://test/'
  ).searchParams.get('capture');
  const selectedTextCapture = await backgroundMessageListener({
    action: 'get_pending_capture',
    captureId: textCaptureId
  });
  assert.equal(selectedTextCapture.success, true);
  assert.equal(selectedTextCapture.selectedText, '日本語');
  assert.equal(selectedTextCapture.term, '日本語');
  await backgroundMessageListener({ action: 'discard_pending_capture', captureId: textCaptureId });
});

test('standalone PDF capture page ships its script and stylesheet', () => {
  const html = fs.readFileSync(path.join(projectRoot, 'ocr-capture.html'), 'utf8');
  assert.match(html, /ocr-capture\.css/);
  assert.match(html, /ocr-capture\.js/);
  assert.equal(fs.existsSync(path.join(projectRoot, 'ocr-capture.css')), true);
  assert.equal(fs.existsSync(path.join(projectRoot, 'ocr-capture.js')), true);
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'manifest.json'), 'utf8'));
  assert.ok(manifest.permissions.includes('menus'));
});

test('OCR result is reviewed before a note is sent to Anki', async () => {
  const { contentMessageListener, document, sentMessages } = createContentContext();

  contentMessageListener({ action: 'start_screen_snip' });
  const overlay = document.getElementById('anki-ocr-overlay');
  overlay.dispatch('pointerdown', {
    button: 0,
    pointerId: 8,
    clientX: 10,
    clientY: 10,
    preventDefault() {}
  });
  overlay.dispatch('pointerup', { pointerId: 8, clientX: 110, clientY: 60 });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  const review = document.getElementById('anki-miner-ocr-review');
  assert.ok(review);
  assert.equal(sentMessages.length, 2);
  assert.equal(sentMessages[0].action, 'crop_and_ocr');
  assert.equal(sentMessages[1].action, 'get_deck_options');

  const termInput = document.getElementById('anki-miner-review-term');
  const textInput = document.getElementById('anki-miner-review-text');
  assert.equal(termInput.value, '日本語');
  assert.equal(textInput.value, '日本語');
  assert.equal(review.children[0].children[2].children[0].textContent, 'Confiança: 91%');

  termInput.value = '日本';
  const deckSelect = document.getElementById('anki-miner-review-deck');
  assert.equal(deckSelect.value, 'Baralho padrão');
  deckSelect.value = 'Leitura::Japonês';
  const actions = review.children[0].children.at(-1);
  actions.children[1].dispatch('click');
  await Promise.resolve();

  assert.equal(document.getElementById('anki-miner-ocr-review'), null);
  assert.deepEqual(JSON.parse(JSON.stringify(sentMessages[2])), {
    action: 'add_to_anki',
    payload: {
      word: '日本',
      sentence: '日本語',
      deckName: 'Leitura::Japonês'
    }
  });
});

test('discarding the OCR review does not send a note to Anki', async () => {
  const { contentMessageListener, document, sentMessages } = createContentContext();

  contentMessageListener({ action: 'start_screen_snip' });
  const overlay = document.getElementById('anki-ocr-overlay');
  overlay.dispatch('pointerdown', {
    button: 0,
    pointerId: 9,
    clientX: 10,
    clientY: 10,
    preventDefault() {}
  });
  overlay.dispatch('pointerup', { pointerId: 9, clientX: 110, clientY: 60 });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  const review = document.getElementById('anki-miner-ocr-review');
  const actions = review.children[0].children.at(-1);
  actions.children[0].dispatch('click');

  assert.equal(document.getElementById('anki-miner-ocr-review'), null);
  assert.equal(sentMessages.length, 2);
  assert.equal(sentMessages[0].action, 'crop_and_ocr');
});

test('selected text is reviewed with a deck choice before sending', async () => {
  const { document, sentMessages } = createContentContext({ selectedText: '猫' });

  document.dispatch('keydown', {
    altKey: true,
    key: 'a',
    preventDefault() {}
  });
  await Promise.resolve();
  await Promise.resolve();

  const review = document.getElementById('anki-miner-ocr-review');
  assert.ok(review);
  assert.equal(review.children[0].children[0].textContent, 'Revisar texto selecionado');
  assert.equal(sentMessages[0].action, 'get_deck_options');

  const deckSelect = document.getElementById('anki-miner-review-deck');
  deckSelect.value = 'Leitura::Japonês';
  const actions = review.children[0].children.at(-1);
  actions.children[1].dispatch('click');
  await Promise.resolve();

  assert.deepEqual(JSON.parse(JSON.stringify(sentMessages[1])), {
    action: 'add_to_anki',
    payload: {
      word: '猫',
      sentence: 'これは<b>猫</b>です。',
      deckName: 'Leitura::Japonês'
    }
  });
});
