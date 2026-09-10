const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');

function createBackgroundContext({
  duplicate = false,
  deckModelName = '',
  deckModelFields = [],
  ankiConnected = true
} = {}) {
  let messageListener;
  const ankiRequests = [];
  let currentAnkiConnection = ankiConnected;
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
    if (!currentAnkiConnection && request.action === 'version') {
      throw new Error('Anki desconectado');
    }
    let result;
    if (request.action === 'findNotes') {
      result = request.params.query.includes(' -deck:')
        ? (deckModelName ? [100, 300] : [])
        : (duplicate ? [42] : []);
    } else if (request.action === 'notesInfo') {
      result = [{ noteId: 300, modelName: deckModelName }];
    } else if (request.action === 'modelFieldNames') {
      result = deckModelFields;
    } else {
      const results = {
      deckNames: ['Baralho Alvo', 'Baralho Escolhido'],
      addNote: 99,
      sync: null,
      version: 6
      };
      result = results[request.action];
    }
    return { ok: true, async json() { return { result, error: null }; } };
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
  return {
    ankiRequests,
    messageListener,
    storageData,
    setAnkiConnected(value) { currentAnkiConnection = value; }
  };
}

test('disconnect notification appears once and resets after reconnection', async () => {
  const { messageListener, storageData, setAnkiConnected } = createBackgroundContext({
    ankiConnected: false
  });

  const silentPopupCheck = await messageListener({ action: 'anki_healthcheck' });
  assert.equal(silentPopupCheck.shouldNotify, false);
  assert.equal(storageData.ankiMinerDisconnectNoticeShown, undefined);

  const firstFailure = await messageListener({
    action: 'anki_healthcheck',
    claimDisconnectNotice: true
  });
  const repeatedFailure = await messageListener({
    action: 'anki_healthcheck',
    claimDisconnectNotice: true
  });
  assert.equal(firstFailure.connected, false);
  assert.equal(firstFailure.shouldNotify, true);
  assert.equal(repeatedFailure.connected, false);
  assert.equal(repeatedFailure.shouldNotify, false);
  assert.equal(storageData.ankiMinerDisconnectNoticeShown, true);

  setAnkiConnected(true);
  const recovery = await messageListener({ action: 'anki_healthcheck' });
  assert.equal(recovery.connected, true);
  assert.equal(recovery.shouldNotify, false);
  assert.equal(storageData.ankiMinerDisconnectNoticeShown, false);

  setAnkiConnected(false);
  const newFailure = await messageListener({
    action: 'anki_healthcheck',
    claimDisconnectNotice: true
  });
  assert.equal(newFailure.connected, false);
  assert.equal(newFailure.shouldNotify, true);
});

test('deck options expose names and the configured default without model selection', async () => {
  const { ankiRequests, messageListener } = createBackgroundContext();
  const response = await messageListener({ action: 'get_deck_options' });

  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    decks: ['Baralho Alvo', 'Baralho Escolhido'],
    selectedDeck: 'Baralho Alvo'
  });
  assert.deepEqual(ankiRequests.map(request => request.action), ['deckNames']);
});

test('dynamic mappings, picture and batch sync are applied to addNote', async () => {
  const { ankiRequests, messageListener, storageData } = createBackgroundContext();
  const response = await messageListener({
    action: 'add_to_anki',
    payload: {
      word: '猫',
      sentence: '猫です。',
      imageBase64: 'aW1hZ2U=',
      deckName: 'Baralho Escolhido'
    }
  });

  assert.equal(response.success, true);
  assert.equal(response.synced, true);
  assert.equal(response.deckName, 'Baralho Escolhido');
  assert.deepEqual(ankiRequests.map(request => request.action), ['findNotes', 'findNotes', 'addNote', 'sync']);
  assert.match(ankiRequests[0].params.query, /deck:"Baralho Escolhido"/);

  const note = ankiRequests[2].params.note;
  assert.equal(note.deckName, 'Baralho Escolhido');
  assert.equal(note.modelName, 'Modelo Dinâmico');
  assert.deepEqual(JSON.parse(JSON.stringify(note.options)), {
    allowDuplicate: false,
    duplicateScope: 'deck',
    duplicateScopeOptions: {
      deckName: 'Baralho Escolhido',
      checkChildren: false,
      checkAllModels: false
    }
  });
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
  assert.equal(response.deckName, 'Baralho Alvo');
  assert.deepEqual(ankiRequests.map(request => request.action), ['findNotes', 'findNotes']);
  assert.match(ankiRequests[0].params.query, /deck:"Baralho Alvo"/);
  assert.match(ankiRequests[1].params.query, /Expressão:猫/);
});

test('confirmed duplicates are allowed only after confirmation and keep deck scope', async () => {
  const { ankiRequests, messageListener } = createBackgroundContext({ duplicate: true });
  const response = await messageListener({
    action: 'add_to_anki',
    payload: {
      word: '猫',
      sentence: '猫です。',
      deckName: 'Baralho Escolhido',
      forceDuplicate: true
    }
  });

  assert.equal(response.success, true);
  assert.deepEqual(ankiRequests.map(request => request.action), ['findNotes', 'addNote', 'sync']);
  assert.equal(ankiRequests[1].params.note.deckName, 'Baralho Escolhido');
  assert.equal(ankiRequests[1].params.note.options.allowDuplicate, true);
  assert.equal(
    ankiRequests[1].params.note.options.duplicateScopeOptions.deckName,
    'Baralho Escolhido'
  );
});

test('the selected deck uses its most recently used Anki model by default', async () => {
  const { ankiRequests, messageListener } = createBackgroundContext({
    deckModelName: 'Modelo Japonês do Deck',
    deckModelFields: ['Termo', 'Leitura', 'Nível', 'Sentido', 'Contexto', 'Som', 'Foto']
  });
  const response = await messageListener({
    action: 'add_to_anki',
    payload: {
      word: '猫',
      sentence: '猫です。',
      deckName: 'Baralho Escolhido'
    }
  });

  assert.equal(response.success, true);
  assert.deepEqual(ankiRequests.map(request => request.action), [
    'findNotes',
    'notesInfo',
    'modelFieldNames',
    'findNotes',
    'addNote',
    'sync'
  ]);
  assert.deepEqual(ankiRequests[1].params.notes, [300]);

  const note = ankiRequests[4].params.note;
  assert.equal(note.deckName, 'Baralho Escolhido');
  assert.equal(note.modelName, 'Modelo Japonês do Deck');
  assert.equal(note.fields.Termo, '猫');
  assert.equal(note.fields.Leitura, 'ねこ');
  assert.equal(note.fields['Nível'], 'N5');
  assert.match(note.fields.Sentido, /cat/);
  assert.match(note.fields.Contexto, /猫です。/);
});

test('kanji models keep word, reading and meaning in distinct fields regardless of order', async () => {
  const { ankiRequests, messageListener } = createBackgroundContext({
    deckModelName: 'Modelo de Kanji',
    deckModelFields: ['Significado em Inglês', 'Kanji', 'Leitura (Hiragana)']
  });
  const response = await messageListener({
    action: 'add_to_anki',
    payload: {
      word: '猫',
      sentence: '猫です。',
      deckName: 'Kanji'
    }
  });

  assert.equal(response.success, true);
  const addNoteRequest = ankiRequests.find(request => request.action === 'addNote');
  const note = addNoteRequest.params.note;
  assert.equal(note.modelName, 'Modelo de Kanji');
  assert.equal(note.fields.Kanji, '猫');
  assert.equal(note.fields['Leitura (Hiragana)'], 'ねこ');
  assert.match(note.fields['Significado em Inglês'], /cat/);
  assert.notEqual(note.fields.Kanji, note.fields['Significado em Inglês']);
});
