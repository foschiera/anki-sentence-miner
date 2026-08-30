const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');

function createBackgroundContext({ duplicate = false } = {}) {
  let messageListener;
  const ankiRequests = [];
  const storageData = {
    ankiMinerSettings: {
      deckName: 'Baralho Alvo',
      modelName: 'Modelo Dinâmico',
      fieldMappings: {
        word: 'Expressão',
        reading: 'Kana',
        jlpt: 'Nível',
        meaning: 'Definição',
        sentence: 'Contexto',
        audio: 'Som',
        image: 'Foto'
      },
      autoSync: true,
      syncBatchSize: 2
    },
    ankiMinerState: { addedSinceSync: 1 }
  };

  const browser = {
    action: {
      async setBadgeText() {},
      async setBadgeBackgroundColor() {},
      async setTitle() {}
    },
    commands: { onCommand: { addListener() {} } },
    runtime: {
      getURL(value) { return value; },
      onMessage: { addListener(listener) { messageListener = listener; } }
    },
    storage: {
      local: {
        async get(key) { return { [key]: storageData[key] }; },
        async set(values) { Object.assign(storageData, values); }
      }
    },
    tabs: { async query() { return []; } }
  };

  async function fetchMock(url, options = {}) {
    if (url.startsWith('https://jisho.org/')) {
      return {
        ok: true,
        async json() {
          return { data: [{
            japanese: [{ word: '猫', reading: 'ねこ' }],
            jlpt: ['jlpt-n5'],
            senses: [{ english_definitions: ['cat'] }]
          }] };
        }
      };
    }
    if (url.startsWith('https://translate.google.com/')) {
      return { ok: true, async json() { return [[['gato']]]; } };
    }

    const request = JSON.parse(options.body);
    ankiRequests.push(request);
    const results = {
      findNotes: duplicate ? [42] : [],
      addNote: 99,
      sync: null,
      version: 6
    };
    return { ok: true, async json() { return { result: results[request.action], error: null }; } };
  }

  const context = vm.createContext({
    AbortController,
    browser,
    clearTimeout,
    console,
    fetch: fetchMock,
    globalThis: null,
    Intl,
    setTimeout
  });
  context.globalThis = context;
  const source = fs.readFileSync(path.join(projectRoot, 'background.js'), 'utf8')
    .replace("import './tesseract.min.js';", '');
  vm.runInContext(source, context);
  return { ankiRequests, messageListener, storageData };
}

test('dynamic mappings, picture and batch sync are applied to addNote', async () => {
  const { ankiRequests, messageListener, storageData } = createBackgroundContext();
  const response = await messageListener({
    action: 'add_to_anki',
    payload: { word: '猫', sentence: '猫です。', imageBase64: 'aW1hZ2U=' }
  });

  assert.equal(response.success, true);
  assert.equal(response.synced, true);
  assert.deepEqual(ankiRequests.map(request => request.action), ['findNotes', 'addNote', 'sync']);

  const note = ankiRequests[1].params.note;
  assert.equal(note.deckName, 'Baralho Alvo');
  assert.equal(note.modelName, 'Modelo Dinâmico');
  assert.equal(note.fields['Expressão'], '猫');
  assert.equal(note.fields.Kana, 'ねこ');
  assert.equal(note.fields['Nível'], 'N5');
  assert.equal(note.audio[0].fields[0], 'Som');
  assert.equal(note.picture[0].fields[0], 'Foto');
  assert.equal(note.picture[0].data, 'aW1hZ2U=');
  assert.equal(storageData.ankiMinerState.addedSinceSync, 0);
});

test('duplicate notes require confirmation and do not call addNote', async () => {
  const { ankiRequests, messageListener } = createBackgroundContext({ duplicate: true });
  const response = await messageListener({
    action: 'add_to_anki',
    payload: { word: '猫', sentence: '猫です。' }
  });

  assert.equal(response.success, false);
  assert.equal(response.duplicate, true);
  assert.equal(response.requiresConfirmation, true);
  assert.deepEqual(ankiRequests.map(request => request.action), ['findNotes']);
  assert.match(ankiRequests[0].params.query, /deck:"Baralho Alvo"/);
  assert.match(ankiRequests[0].params.query, /Expressão:猫/);
});
