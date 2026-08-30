const SETTINGS_KEY = "ankiMinerSettings";
const FIELD_DEFINITIONS = [
  { key: "word", label: "Palavra", aliases: ["palavra", "word", "expression", "termo"] },
  { key: "reading", label: "Leitura", aliases: ["leitura", "reading", "kana", "furigana"] },
  { key: "jlpt", label: "JLPT", aliases: ["jlpt", "nivel", "level"] },
  { key: "meaning", label: "Significado", aliases: ["significado", "meaning", "definition", "definicao"] },
  { key: "sentence", label: "Frase", aliases: ["frase", "sentence", "contexto", "example"] },
  { key: "audio", label: "Áudio", aliases: ["audio", "som", "sound"] },
  { key: "image", label: "Imagem / screenshot", aliases: ["imagem", "image", "picture", "screenshot"] }
];

const elements = {
  connectionStatus: document.querySelector("#connection-status"),
  connectionHelp: document.querySelector("#connection-help"),
  retryConnection: document.querySelector("#retry-connection"),
  ankiSettings: document.querySelector("#anki-settings"),
  fieldSettings: document.querySelector("#field-settings"),
  syncSettings: document.querySelector("#sync-settings"),
  deckName: document.querySelector("#deck-name"),
  modelName: document.querySelector("#model-name"),
  fieldMappings: document.querySelector("#field-mappings"),
  autoSync: document.querySelector("#auto-sync"),
  syncBatchSize: document.querySelector("#sync-batch-size"),
  syncNow: document.querySelector("#sync-now"),
  saveStatus: document.querySelector("#save-status")
};

let settings = null;
let availableFields = [];
let saveStatusTimer = null;

function normalize(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function fillSelect(select, values, selectedValue, emptyLabel = "") {
  select.replaceChildren();
  if (emptyLabel) select.add(new Option(emptyLabel, ""));
  for (const value of values) select.add(new Option(value, value));
  if (values.includes(selectedValue)) select.value = selectedValue;
}

function setConnectedState(connected) {
  elements.connectionStatus.className = `status status--${connected ? "connected" : "disconnected"}`;
  elements.connectionStatus.textContent = connected ? "🟢 Conectado" : "🔴 Desconectado";
  elements.connectionHelp.hidden = connected;
  elements.ankiSettings.disabled = !connected;
  elements.fieldSettings.disabled = !connected;
  elements.syncSettings.disabled = !connected;
}

function showStatus(message, isError = false) {
  clearTimeout(saveStatusTimer);
  elements.saveStatus.textContent = message;
  elements.saveStatus.style.color = isError ? "#fca5a5" : "#93c5fd";
  saveStatusTimer = setTimeout(() => { elements.saveStatus.textContent = ""; }, 2600);
}

function chooseField(definition, storedValue) {
  if (availableFields.includes(storedValue)) return storedValue;
  const match = availableFields.find(field => definition.aliases.includes(normalize(field)));
  if (match) return match;
  return definition.key === "word" ? (availableFields[0] || "") : "";
}

function renderFieldMappings() {
  elements.fieldMappings.replaceChildren();
  const nextMappings = {};

  for (const definition of FIELD_DEFINITIONS) {
    const label = document.createElement("label");
    label.htmlFor = `mapping-${definition.key}`;
    label.textContent = definition.label;

    const select = document.createElement("select");
    select.id = `mapping-${definition.key}`;
    select.dataset.mappingKey = definition.key;
    const selected = chooseField(definition, settings.fieldMappings?.[definition.key]);
    fillSelect(select, availableFields, selected, definition.key === "word" ? "" : "Não incluir");
    nextMappings[definition.key] = select.value;

    select.addEventListener("change", () => {
      settings.fieldMappings[definition.key] = select.value;
      persistSettings();
    });
    elements.fieldMappings.append(label, select);
  }

  settings.fieldMappings = nextMappings;
}

async function persistSettings() {
  await browser.storage.local.set({ [SETTINGS_KEY]: settings });
  showStatus("Configuração salva");
}

async function loadModelFields({ persist = false } = {}) {
  if (!elements.modelName.value) {
    availableFields = [];
    renderFieldMappings();
    return;
  }

  availableFields = await browser.runtime.sendMessage({
    action: "anki_model_fields",
    modelName: elements.modelName.value
  });
  renderFieldMappings();
  if (persist) await persistSettings();
}

async function connectAndLoad() {
  elements.connectionStatus.className = "status status--checking";
  elements.connectionStatus.textContent = "Verificando…";

  const health = await browser.runtime.sendMessage({ action: "anki_healthcheck" });
  setConnectedState(health.connected);
  if (!health.connected) return;

  try {
    const [loadedSettings, decks, models] = await Promise.all([
      browser.runtime.sendMessage({ action: "get_settings" }),
      browser.runtime.sendMessage({ action: "anki_deck_names" }),
      browser.runtime.sendMessage({ action: "anki_model_names" })
    ]);
    settings = loadedSettings;

    fillSelect(elements.deckName, decks, settings.deckName);
    fillSelect(elements.modelName, models, settings.modelName);
    if (!elements.deckName.value && decks.length) elements.deckName.value = decks[0];
    if (!elements.modelName.value && models.length) elements.modelName.value = models[0];

    settings.deckName = elements.deckName.value;
    settings.modelName = elements.modelName.value;
    elements.autoSync.checked = Boolean(settings.autoSync);
    elements.syncBatchSize.value = Math.max(1, Number(settings.syncBatchSize) || 10);
    elements.syncBatchSize.disabled = !elements.autoSync.checked;

    await loadModelFields();
    await persistSettings();
  } catch (error) {
    setConnectedState(false);
    showStatus(error.message || String(error), true);
  }
}

elements.deckName.addEventListener("change", () => {
  settings.deckName = elements.deckName.value;
  persistSettings();
});

elements.modelName.addEventListener("change", async () => {
  settings.modelName = elements.modelName.value;
  settings.fieldMappings = {};
  try {
    await loadModelFields({ persist: true });
  } catch (error) {
    showStatus(error.message || String(error), true);
  }
});

elements.autoSync.addEventListener("change", () => {
  settings.autoSync = elements.autoSync.checked;
  elements.syncBatchSize.disabled = !settings.autoSync;
  persistSettings();
});

elements.syncBatchSize.addEventListener("change", () => {
  const value = Math.min(1000, Math.max(1, Number.parseInt(elements.syncBatchSize.value, 10) || 10));
  elements.syncBatchSize.value = value;
  settings.syncBatchSize = value;
  persistSettings();
});

elements.syncNow.addEventListener("click", async () => {
  elements.syncNow.disabled = true;
  elements.syncNow.textContent = "Sincronizando…";
  try {
    await browser.runtime.sendMessage({ action: "anki_sync" });
    showStatus("Sincronização concluída");
  } catch (error) {
    showStatus(`Falha ao sincronizar: ${error.message || error}`, true);
  } finally {
    elements.syncNow.disabled = false;
    elements.syncNow.textContent = "Sincronizar com AnkiWeb";
  }
});

elements.retryConnection.addEventListener("click", connectAndLoad);
connectAndLoad().catch(error => {
  setConnectedState(false);
  showStatus(error.message || String(error), true);
});
