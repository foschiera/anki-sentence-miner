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

  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }

  setAttribute() {}
  setPointerCapture() {}
  focus() {}
}

function createContentContext() {
  const document = new EventTargetMock();
  document.documentElement = new ElementMock('html');
  document.createElement = tagName => new ElementMock(tagName);
  document.getElementById = id => document.documentElement.children.find(child => child.id === id) || null;

  let contentMessageListener;
  const sentMessages = [];
  const context = vm.createContext({
    alert() {},
    browser: {
      runtime: {
        onMessage: { addListener(listener) { contentMessageListener = listener; } },
        sendMessage(message) {
          sentMessages.push(message);
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
      getSelection() { return { toString() { return ''; } }; }
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
  let workerOptions;
  let drawArguments;
  let imageClosed = false;
  const worker = {
    async setParameters() {},
    async recognize() { return { data: { text: ' 日本語\n' } }; }
  };

  class OffscreenCanvasMock {
    constructor(width, height) {
      this.width = width;
      this.height = height;
    }

    getContext() {
      return {
        drawImage(...args) { drawArguments = args; },
        imageSmoothingEnabled: false,
        imageSmoothingQuality: 'low'
      };
    }

    async convertToBlob() { return {}; }
  }

  const context = vm.createContext({
    browser: {
      commands: { onCommand: { addListener(listener) { commandListener = listener; } } },
      runtime: {
        getURL(value) { return value; },
        onMessage: { addListener() {} }
      },
      tabs: {
        async captureVisibleTab() { return 'data:image/png;base64,test'; },
        async query() { return [{ id: 12 }]; },
        async sendMessage() {}
      }
    },
    console,
    createImageBitmap: async () => ({
      width: 2000,
      height: 1000,
      close() { imageClosed = true; }
    }),
    fetch: async () => ({ blob: async () => ({}) }),
    globalThis: null,
    OffscreenCanvas: OffscreenCanvasMock
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

  assert.equal(text, '日本語');
  assert.equal(imageClosed, true);
  assert.equal(workerOptions.workerBlobURL, false);
  assert.deepEqual(drawArguments.slice(1), [200, 100, 400, 200, 0, 0, 800, 400]);
});
