import { buildCatalogUpdate, CatalogError, slugify, validateCatalog } from './lib/catalog.js';
import { ImageValidationError, inspectImage } from './lib/image.js';

if (globalThis.top !== globalThis.self) {
  document.body.textContent = 'Встроенный режим отключён. Откройте библиотеку отдельной вкладкой.';
  throw new Error('Embedded uploader execution blocked.');
}

const MAX_OPERATIONS = 20;
const RAW_CATALOG_URL = 'https://raw.githubusercontent.com/AleksandrDruk/btm-library/main/catalog.json';
const RAW_ASSET_BASE = 'https://raw.githubusercontent.com/AleksandrDruk/btm-library/main/';
const GITHUB_PR_PREFIX = 'https://github.com/AleksandrDruk/btm-library/pull/';

const elements = {
  catalogSummary: document.getElementById('catalog-summary'),
  setupPanel: document.getElementById('setup-panel'),
  setupMessage: document.getElementById('setup-message'),
  loginPanel: document.getElementById('login-panel'),
  loginForm: document.getElementById('login-form'),
  password: document.getElementById('password'),
  loginButton: document.getElementById('login-button'),
  loginStatus: document.getElementById('login-status'),
  turnstileContainer: document.getElementById('turnstile-container'),
  uploaderPanel: document.getElementById('uploader-panel'),
  logoutButton: document.getElementById('logout-button'),
  dropZone: document.getElementById('drop-zone'),
  fileInput: document.getElementById('file-input'),
  queue: document.getElementById('queue'),
  queueEmpty: document.getElementById('queue-empty'),
  queueCount: document.getElementById('queue-count'),
  queueTemplate: document.getElementById('queue-item-template'),
  uploadButton: document.getElementById('upload-button'),
  uploadStatus: document.getElementById('upload-status'),
  successPanel: document.getElementById('success-panel'),
  pullRequestLink: document.getElementById('pull-request-link'),
  catalogFilter: document.getElementById('catalog-filter'),
  catalogItems: document.getElementById('catalog-items'),
  catalogItemsEmpty: document.getElementById('catalog-items-empty'),
  catalogItemTemplate: document.getElementById('catalog-item-template'),
};

const state = {
  config: null,
  catalog: { schema_version: 1, catalog_version: 1, items: [] },
  sessionToken: null,
  sessionExpiresAt: 0,
  turnstileToken: '',
  turnstileWidgetId: null,
  uploads: [],
  deletions: new Map(),
  submitting: false,
};

function setStatus(element, message, kind = 'error') {
  element.textContent = message || '';
  element.dataset.kind = kind;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

function safeConfig(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('config.json должен содержать объект.');
  }

  const apiBase = String(value.api_base || '').replace(/\/+$/, '');
  const catalogUrl = String(value.catalog_url || '');
  const siteKey = String(value.turnstile_site_key || '');
  if (!apiBase || !siteKey) {
    return null;
  }

  const apiUrl = new URL(apiBase);
  const local = ['127.0.0.1', 'localhost'].includes(apiUrl.hostname) && apiUrl.protocol === 'http:';
  const worker = apiUrl.protocol === 'https:' && apiUrl.hostname.endsWith('.workers.dev');
  if (!local && !worker) {
    throw new Error('API должен использовать HTTPS workers.dev или локальный адрес разработки.');
  }
  const catalog = new URL(catalogUrl, globalThis.location.href);
  const localCatalog = local
    && catalog.origin === globalThis.location.origin
    && catalog.pathname === '/catalog.json'
    && !catalog.search
    && !catalog.hash;
  if (catalog.href !== RAW_CATALOG_URL && !localCatalog) {
    throw new Error('catalog_url не совпадает с разрешённым репозиторием.');
  }
  if (!/^[A-Za-z0-9_-]{10,100}$/.test(siteKey)) {
    throw new Error('Turnstile site key имеет некорректный формат.');
  }

  return { apiBase: apiUrl.toString().replace(/\/$/, ''), catalogUrl: catalog.href, siteKey };
}

async function loadConfig() {
  const response = await fetch('./config.json', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error('Не удалось загрузить config.json.');
  }
  const config = safeConfig(await response.json());
  if (!config) {
    elements.setupPanel.hidden = false;
    elements.loginButton.disabled = true;
    return null;
  }
  elements.setupPanel.hidden = true;
  return config;
}

async function loadCatalog(catalogUrl = RAW_CATALOG_URL) {
  try {
    const response = await fetch(catalogUrl, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    state.catalog = validateCatalog(await response.json());
    elements.catalogSummary.textContent = `v${state.catalog.catalog_version} · ${state.catalog.items.length} позиций`;
  } catch (error) {
    elements.catalogSummary.textContent = 'Недоступен';
    setStatus(elements.loginStatus, `Каталог не загрузился: ${error.message}`);
  }
  renderCatalogItems();
}

function waitForTurnstile(timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (globalThis.turnstile && typeof globalThis.turnstile.render === 'function') {
        resolve(globalThis.turnstile);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error('Turnstile не загрузился. Обновите страницу.'));
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });
}

async function mountTurnstile() {
  if (!state.config) return;
  const turnstile = await waitForTurnstile();
  state.turnstileWidgetId = turnstile.render(elements.turnstileContainer, {
    sitekey: state.config.siteKey,
    action: 'btm_login',
    theme: 'light',
    size: 'flexible',
    'refresh-expired': 'auto',
    callback(token) {
      state.turnstileToken = token;
      updateLoginButton();
    },
    'expired-callback'() {
      state.turnstileToken = '';
      updateLoginButton();
    },
    'error-callback'() {
      state.turnstileToken = '';
      updateLoginButton();
      setStatus(elements.loginStatus, 'Проверка безопасности не загрузилась. Повторите попытку.');
    },
  });
}

function resetTurnstile() {
  state.turnstileToken = '';
  if (state.turnstileWidgetId !== null && globalThis.turnstile) {
    globalThis.turnstile.reset(state.turnstileWidgetId);
  }
  updateLoginButton();
}

function updateLoginButton() {
  elements.loginButton.disabled = !state.config || !state.turnstileToken || state.submitting;
}

async function apiError(response) {
  try {
    const payload = await response.json();
    if (typeof payload.message === 'string' && payload.message.length <= 300) {
      return payload.message;
    }
  } catch {
    // Use a generic message for malformed upstream responses.
  }
  return `Запрос завершился ошибкой HTTP ${response.status}.`;
}

async function login(event) {
  event.preventDefault();
  if (!state.config || state.submitting) return;
  const password = elements.password.value;
  if (password.length < 20 || !state.turnstileToken) {
    setStatus(elements.loginStatus, 'Введите пароль и завершите проверку безопасности.');
    return;
  }

  state.submitting = true;
  updateLoginButton();
  setStatus(elements.loginStatus, 'Проверяем доступ…', 'info');
  try {
    const response = await fetch(`${state.config.apiBase}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, turnstile_token: state.turnstileToken }),
    });
    if (!response.ok) {
      throw new Error(await apiError(response));
    }
    const payload = await response.json();
    if (payload.ok !== true || typeof payload.token !== 'string' || payload.token.length < 20) {
      throw new Error('API вернул некорректную сессию.');
    }
    state.sessionToken = payload.token;
    state.sessionExpiresAt = Date.now() + Math.min(Number(payload.expires_in || 1800), 3600) * 1000;
    elements.password.value = '';
    elements.loginPanel.hidden = true;
    elements.uploaderPanel.hidden = false;
    setStatus(elements.loginStatus, '');
    elements.fileInput.focus();
  } catch (error) {
    setStatus(elements.loginStatus, error.message);
    resetTurnstile();
  } finally {
    state.submitting = false;
    updateLoginButton();
  }
}

function logout(message = '') {
  state.sessionToken = null;
  state.sessionExpiresAt = 0;
  elements.uploaderPanel.hidden = true;
  elements.loginPanel.hidden = false;
  setStatus(elements.loginStatus, message, message ? 'info' : 'error');
  resetTurnstile();
  elements.password.focus();
}

function titleCase(value) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function inferMetadata(fileName, extension) {
  const stem = fileName.replace(/\.[^.]+$/, '');
  const tokens = stem
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\d{2,4}x\d{2,4}\b/gi, ' ')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  const variants = new Map([
    ['dark', 'Dark'],
    ['exactdark', 'Exact Dark'],
    ['light', 'Light'],
    ['white', 'White'],
    ['black', 'Black'],
    ['square', 'Square'],
    ['mobile', 'Mobile'],
    ['horizontal', 'Horizontal'],
    ['vertical', 'Vertical'],
  ]);
  let variant = 'Primary';
  const last = tokens.at(-1)?.toLowerCase();
  if (last && variants.has(last)) {
    variant = variants.get(last);
    tokens.pop();
  }
  const brand = titleCase(tokens.join(' ') || stem);
  const suggestedStem = slugify(stem);
  return {
    brand,
    variant,
    suggested_filename: `${suggestedStem}.${extension}`,
    tags: `${brand.toLowerCase()}, ${variant.toLowerCase()}`,
  };
}

async function decodeImage(file, expected) {
  if (typeof globalThis.createImageBitmap === 'function') {
    let bitmap;
    try {
      bitmap = await globalThis.createImageBitmap(file);
      if (bitmap.width !== expected.width || bitmap.height !== expected.height) {
        throw new Error('Размер после декодирования не совпадает с заголовком файла.');
      }
      return;
    } catch (error) {
      if (error instanceof ImageValidationError) throw error;
      throw new ImageValidationError('decode_failed', `Браузер не смог декодировать изображение: ${error.message}`);
    } finally {
      bitmap?.close();
    }
  }

  const previewUrl = URL.createObjectURL(file);
  try {
    const dimensions = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new Error('декодирование завершилось ошибкой'));
      image.src = previewUrl;
    });
    if (dimensions.width !== expected.width || dimensions.height !== expected.height) {
      throw new ImageValidationError('decode_mismatch', 'Размер после декодирования не совпадает с заголовком файла.');
    }
  } catch (error) {
    if (error instanceof ImageValidationError) throw error;
    throw new ImageValidationError('decode_failed', `Браузер не смог декодировать изображение: ${error.message}`);
  } finally {
    URL.revokeObjectURL(previewUrl);
  }
}

async function addFiles(fileList) {
  const available = MAX_OPERATIONS - state.uploads.length - state.deletions.size;
  const files = Array.from(fileList).slice(0, Math.max(0, available));
  if (files.length === 0) {
    setStatus(elements.uploadStatus, `За один PR разрешено не более ${MAX_OPERATIONS} операций.`);
    return;
  }

  setStatus(elements.uploadStatus, 'Проверяем изображения…', 'info');
  for (const file of files) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const image = inspectImage(bytes);
      if (file.type && file.type !== image.mime) {
        throw new ImageValidationError('mime_mismatch', 'MIME файла не совпадает с его содержимым.');
      }
      await decodeImage(file, image);
      const inferred = inferMetadata(file.name, image.extension);
      state.uploads.push({
        key: crypto.randomUUID(),
        file,
        image,
        previewUrl: URL.createObjectURL(file),
        mode: 'new',
        asset_id: '',
        ...inferred,
        error: '',
      });
    } catch (error) {
      setStatus(elements.uploadStatus, `${file.name}: ${error.message}`);
    }
  }
  elements.fileInput.value = '';
  if (state.uploads.length > 0) {
    setStatus(elements.uploadStatus, '');
  }
  renderQueue();
}

function setFieldIdentity(container, selector, key, labelText) {
  const input = container.querySelector(selector);
  const field = input.closest('.field');
  const label = field.querySelector('label');
  const id = `${selector.replace('.', '')}-${key}`;
  input.id = id;
  label.htmlFor = id;
  if (labelText) label.textContent = labelText;
  return input;
}

function populateAssetSelect(select, selectedId) {
  select.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Выберите позицию';
  select.append(placeholder);
  state.catalog.items.forEach((item) => {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = `${item.brand} — ${item.variant || 'Primary'} (v${item.version})`;
    option.selected = item.id === selectedId;
    select.append(option);
  });
}

function applyExistingItem(upload, assetId) {
  const item = state.catalog.items.find((candidate) => candidate.id === assetId);
  if (!item) return;
  upload.asset_id = item.id;
  upload.brand = item.brand;
  upload.variant = item.variant || 'Primary';
  upload.suggested_filename = item.suggested_filename;
  upload.tags = item.tags.join(', ');
}

function renderQueue() {
  elements.queue.replaceChildren();
  elements.queueEmpty.hidden = state.uploads.length > 0;

  state.uploads.forEach((upload) => {
    const fragment = elements.queueTemplate.content.cloneNode(true);
    const item = fragment.querySelector('.queue-item');
    const preview = fragment.querySelector('.preview');
    preview.src = upload.previewUrl;
    preview.alt = `Предпросмотр ${upload.file.name}`;
    fragment.querySelector('.file-name').textContent = upload.file.name;
    fragment.querySelector('.file-details').textContent = `${upload.image.width}×${upload.image.height}px · ${formatBytes(upload.image.bytes)} · ${upload.image.mime}`;

    const mode = setFieldIdentity(item, '.mode', upload.key);
    const assetSelect = setFieldIdentity(item, '.asset-id', upload.key);
    const brand = setFieldIdentity(item, '.brand', upload.key);
    const variant = setFieldIdentity(item, '.variant', upload.key);
    const filename = setFieldIdentity(item, '.suggested-filename', upload.key);
    const tags = setFieldIdentity(item, '.tags', upload.key);
    const existingField = item.querySelector('.existing-field');
    const error = item.querySelector('.item-error');

    mode.value = upload.mode;
    populateAssetSelect(assetSelect, upload.asset_id);
    existingField.hidden = upload.mode !== 'update';
    brand.value = upload.brand;
    variant.value = upload.variant;
    filename.value = upload.suggested_filename;
    tags.value = upload.tags;
    error.textContent = upload.error;

    mode.addEventListener('change', () => {
      if (mode.value === 'update' && state.catalog.items.length === 0) {
        mode.value = 'new';
        upload.error = 'В каталоге пока нет позиций для обновления.';
      } else {
        upload.mode = mode.value;
        upload.error = '';
        if (upload.mode === 'update' && !upload.asset_id && state.catalog.items[0]) {
          applyExistingItem(upload, state.catalog.items[0].id);
        }
      }
      renderQueue();
    });
    assetSelect.addEventListener('change', () => {
      applyExistingItem(upload, assetSelect.value);
      renderQueue();
    });
    brand.addEventListener('input', () => { upload.brand = brand.value; });
    variant.addEventListener('input', () => { upload.variant = variant.value; });
    filename.addEventListener('input', () => { upload.suggested_filename = filename.value; });
    tags.addEventListener('input', () => { upload.tags = tags.value; });
    item.querySelector('.remove-item').addEventListener('click', () => {
      URL.revokeObjectURL(upload.previewUrl);
      state.uploads = state.uploads.filter((candidate) => candidate.key !== upload.key);
      renderQueue();
    });

    elements.queue.append(fragment);
  });
  updateOperationCount();
}

function renderCatalogItems() {
  const filter = elements.catalogFilter.value.trim().toLowerCase();
  const items = state.catalog.items.filter((item) => {
    const haystack = `${item.brand} ${item.variant} ${item.id}`.toLowerCase();
    return !filter || haystack.includes(filter);
  });
  elements.catalogItems.replaceChildren();
  elements.catalogItemsEmpty.hidden = items.length > 0;

  items.forEach((catalogItem) => {
    const fragment = elements.catalogItemTemplate.content.cloneNode(true);
    const row = fragment.querySelector('.catalog-item');
    const pending = state.deletions.get(catalogItem.id);
    const preview = fragment.querySelector('.catalog-item-preview');
    const previewFallback = fragment.querySelector('.catalog-item-preview-fallback');
    const configuredCatalogUrl = state.config?.catalogUrl || RAW_CATALOG_URL;
    const catalogOrigin = new URL(configuredCatalogUrl).origin;
    const previewBase = catalogOrigin === globalThis.location.origin
      ? new URL('/', globalThis.location.href)
      : new URL(RAW_ASSET_BASE);
    preview.src = new URL(catalogItem.path, previewBase).href;
    preview.alt = `Логотип ${catalogItem.brand} — ${catalogItem.variant || 'Primary'}`;
    preview.addEventListener('error', () => {
      preview.hidden = true;
      previewFallback.hidden = false;
    }, { once: true });
    fragment.querySelector('.catalog-item-name').textContent = `${catalogItem.brand} — ${catalogItem.variant || 'Primary'}`;
    fragment.querySelector('.catalog-item-meta').textContent = `${catalogItem.id} · v${catalogItem.version} · ${catalogItem.path}`;
    const purgeOption = fragment.querySelector('.purge-option');
    const purge = fragment.querySelector('.purge-file');
    const button = fragment.querySelector('.toggle-delete');
    row.classList.toggle('is-pending-delete', Boolean(pending));
    purgeOption.hidden = !pending;
    purge.checked = pending?.purge_file === true;
    button.textContent = pending ? 'Отменить' : 'Удалить';
    purge.addEventListener('change', () => {
      state.deletions.set(catalogItem.id, { asset_id: catalogItem.id, purge_file: purge.checked });
    });
    button.addEventListener('click', () => {
      if (state.deletions.has(catalogItem.id)) {
        state.deletions.delete(catalogItem.id);
      } else if (state.uploads.length + state.deletions.size < MAX_OPERATIONS) {
        state.deletions.set(catalogItem.id, { asset_id: catalogItem.id, purge_file: false });
      } else {
        setStatus(elements.uploadStatus, `За один PR разрешено не более ${MAX_OPERATIONS} операций.`);
      }
      renderCatalogItems();
      updateOperationCount();
    });
    elements.catalogItems.append(fragment);
  });
}

function updateOperationCount() {
  const count = state.uploads.length + state.deletions.size;
  const suffix = count === 1 ? 'операция' : count >= 2 && count <= 4 ? 'операции' : 'операций';
  elements.queueCount.textContent = `${count} ${suffix}`;
  elements.uploadButton.disabled = count === 0 || state.submitting || !state.sessionToken;
}

function metadataForSubmit() {
  const uploads = state.uploads.map((upload) => ({
    mode: upload.mode,
    asset_id: upload.asset_id,
    brand: upload.brand,
    variant: upload.variant,
    suggested_filename: upload.suggested_filename,
    tags: upload.tags,
    image: upload.image,
  }));
  const deletions = Array.from(state.deletions.values()).map((entry) => ({
    mode: 'delete',
    asset_id: entry.asset_id,
    purge_file: entry.purge_file,
  }));
  return [...uploads, ...deletions];
}

function markValidationError(error) {
  state.uploads.forEach((upload) => { upload.error = ''; });
  setStatus(elements.uploadStatus, error.message);
  renderQueue();
}

async function submitBatch() {
  if (!state.config || !state.sessionToken || state.submitting) return;
  if (Date.now() >= state.sessionExpiresAt) {
    logout('Сессия истекла. Войдите снова.');
    return;
  }

  const metadata = metadataForSubmit();
  try {
    buildCatalogUpdate(state.catalog, metadata);
  } catch (error) {
    if (error instanceof CatalogError) {
      markValidationError(error);
      return;
    }
    throw error;
  }

  const permanentDeletes = metadata.filter((entry) => entry.mode === 'delete' && entry.purge_file).length;
  if (permanentDeletes > 0 && !globalThis.confirm(`Будет удалено файлов из репозитория: ${permanentDeletes}. Старый кеш BTM может временно ссылаться на них. Продолжить?`)) {
    return;
  }

  const form = new FormData();
  const serverMetadata = metadata.map((entry) => {
    const copy = { ...entry };
    delete copy.image;
    return copy;
  });
  form.set('metadata', JSON.stringify(serverMetadata));
  state.uploads.forEach((upload, index) => {
    form.set(`file_${index}`, upload.file, upload.file.name);
  });

  state.submitting = true;
  updateOperationCount();
  elements.successPanel.hidden = true;
  setStatus(elements.uploadStatus, 'Проверяем каталог и создаём GitHub PR…', 'info');
  try {
    const response = await fetch(`${state.config.apiBase}/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.sessionToken}` },
      body: form,
    });
    if (response.status === 401) {
      logout('Сессия истекла. Войдите снова.');
      return;
    }
    if (!response.ok) {
      throw new Error(await apiError(response));
    }
    const payload = await response.json();
    const pullUrl = new URL(payload?.pull_request?.url || '');
    if (pullUrl.origin !== 'https://github.com' || !pullUrl.href.startsWith(GITHUB_PR_PREFIX)) {
      throw new Error('API вернул неожиданный адрес PR.');
    }
    elements.pullRequestLink.href = pullUrl.href;
    elements.successPanel.hidden = false;
    setStatus(elements.uploadStatus, 'PR создан. Данные попадут в каталог только после review и merge.', 'success');
    state.uploads.forEach((upload) => URL.revokeObjectURL(upload.previewUrl));
    state.uploads = [];
    state.deletions.clear();
    renderQueue();
    renderCatalogItems();
  } catch (error) {
    setStatus(elements.uploadStatus, error.message);
  } finally {
    state.submitting = false;
    updateOperationCount();
  }
}

function bindEvents() {
  elements.loginForm.addEventListener('submit', login);
  elements.logoutButton.addEventListener('click', () => logout());
  elements.fileInput.addEventListener('change', () => addFiles(elements.fileInput.files));
  elements.uploadButton.addEventListener('click', submitBatch);
  elements.catalogFilter.addEventListener('input', renderCatalogItems);

  ['dragenter', 'dragover'].forEach((eventName) => {
    elements.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.dropZone.classList.add('is-dragging');
    });
  });
  ['dragleave', 'drop'].forEach((eventName) => {
    elements.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.dropZone.classList.remove('is-dragging');
    });
  });
  elements.dropZone.addEventListener('drop', (event) => addFiles(event.dataTransfer.files));
}

async function init() {
  bindEvents();
  renderQueue();
  try {
    state.config = await loadConfig();
  } catch (error) {
    elements.setupPanel.hidden = false;
    elements.setupMessage.textContent = error.message;
    setStatus(elements.loginStatus, error.message);
  }
  await loadCatalog(state.config?.catalogUrl || RAW_CATALOG_URL);
  if (state.config) {
    try {
      await mountTurnstile();
    } catch (error) {
      setStatus(elements.loginStatus, error.message);
    }
  }
}

init();
