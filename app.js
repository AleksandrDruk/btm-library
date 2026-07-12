import { buildCatalogUpdate, CatalogError, slugify, validateCatalog } from './lib/catalog.js';
import { sha256Hex } from './lib/crypto.js';
import {
  AffiliateCatalogError,
  affiliateBrandKey,
  buildAffiliateCatalogUpdate,
  validateAffiliateCatalog,
} from './lib/affiliate-catalog.js';
import { ImageValidationError, inspectImage } from './lib/image.js';

if (globalThis.top !== globalThis.self) {
  document.body.textContent = 'Встроенный режим отключён. Откройте библиотеку отдельной вкладкой.';
  throw new Error('Embedded uploader execution blocked.');
}

const MAX_OPERATIONS = 20;
const RAW_CATALOG_URL = 'https://raw.githubusercontent.com/AleksandrDruk/btm-library/main/catalog.json';
const RAW_ASSET_BASE = 'https://raw.githubusercontent.com/AleksandrDruk/btm-library/main/';
const GITHUB_PR_PREFIX = 'https://github.com/AleksandrDruk/btm-library/pull/';
const AFFILIATE_GITHUB_PR_PREFIX = 'https://github.com/AleksandrDruk/btm-affiliate-library/pull/';
const AFFILIATE_REQUIRED_CHECKS = ['validate-catalog', 'code-checks'];
const AFFILIATE_PAGE_SIZE = 25;

const elements = {
  catalogSummaryLabel: document.getElementById('catalog-summary-label'),
  catalogSummary: document.getElementById('catalog-summary'),
  setupPanel: document.getElementById('setup-panel'),
  setupMessage: document.getElementById('setup-message'),
  loginPanel: document.getElementById('login-panel'),
  loginForm: document.getElementById('login-form'),
  password: document.getElementById('password'),
  loginButton: document.getElementById('login-button'),
  loginStatus: document.getElementById('login-status'),
  turnstileContainer: document.getElementById('turnstile-container'),
  hubPanel: document.getElementById('hub-panel'),
  hubLogoutButton: document.getElementById('hub-logout-button'),
  openLogoLibrary: document.getElementById('open-logo-library'),
  openAffiliateLibrary: document.getElementById('open-affiliate-library'),
  uploaderPanel: document.getElementById('uploader-panel'),
  logoBackButton: document.getElementById('logo-back-button'),
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
  affiliatePanel: document.getElementById('affiliate-panel'),
  affiliateBackButton: document.getElementById('affiliate-back-button'),
  affiliateLogoutButton: document.getElementById('affiliate-logout-button'),
  affiliateLayout: document.getElementById('affiliate-layout'),
  affiliateForm: document.getElementById('affiliate-form'),
  affiliateFormTitle: document.getElementById('affiliate-form-title'),
  affiliateBrand: document.getElementById('affiliate-brand'),
  affiliateExistingBrand: document.getElementById('affiliate-existing-brand'),
  affiliateExistingBrandMessage: document.getElementById('affiliate-existing-brand-message'),
  affiliateOpenExistingBrand: document.getElementById('affiliate-open-existing-brand'),
  affiliateLogo: document.getElementById('affiliate-logo'),
  affiliateLinksEditor: document.getElementById('affiliate-links-editor'),
  affiliateAddLink: document.getElementById('affiliate-add-link'),
  affiliateLinkEditorTemplate: document.getElementById('affiliate-link-editor-template'),
  affiliateTags: document.getElementById('affiliate-tags'),
  affiliateSubmitButton: document.getElementById('affiliate-submit-button'),
  affiliateCancelButton: document.getElementById('affiliate-cancel-button'),
  affiliateDeleteButton: document.getElementById('affiliate-delete-button'),
  affiliateDangerZone: document.getElementById('affiliate-danger-zone'),
  affiliateFormStatus: document.getElementById('affiliate-form-status'),
  affiliateSummary: document.getElementById('affiliate-summary'),
  affiliateFilter: document.getElementById('affiliate-filter'),
  affiliateFilterReset: document.getElementById('affiliate-filter-reset'),
  affiliateRefreshButton: document.getElementById('affiliate-refresh-button'),
  affiliateCreateButton: document.getElementById('affiliate-create-button'),
  affiliateCatalogStatus: document.getElementById('affiliate-catalog-status'),
  affiliateLoading: document.getElementById('affiliate-loading'),
  affiliateItems: document.getElementById('affiliate-items'),
  affiliateItemsEmpty: document.getElementById('affiliate-items-empty'),
  affiliateEmptyTitle: document.getElementById('affiliate-empty-title'),
  affiliateEmptyCopy: document.getElementById('affiliate-empty-copy'),
  affiliateEmptyAction: document.getElementById('affiliate-empty-action'),
  affiliatePagination: document.getElementById('affiliate-pagination'),
  affiliatePageSummary: document.getElementById('affiliate-page-summary'),
  affiliatePagePrevious: document.getElementById('affiliate-page-previous'),
  affiliatePageNext: document.getElementById('affiliate-page-next'),
  affiliateItemTemplate: document.getElementById('affiliate-item-template'),
  affiliateSuccessPanel: document.getElementById('affiliate-success-panel'),
  affiliatePullRequestLink: document.getElementById('affiliate-pull-request-link'),
  affiliateProposalsRefresh: document.getElementById('affiliate-proposals-refresh'),
  affiliateProposalsCount: document.getElementById('affiliate-proposals-count'),
  affiliateProposalsStatus: document.getElementById('affiliate-proposals-status'),
  affiliateProposalItems: document.getElementById('affiliate-proposal-items'),
  affiliateProposalsEmpty: document.getElementById('affiliate-proposals-empty'),
  affiliateProposalTemplate: document.getElementById('affiliate-proposal-template'),
};

const state = {
  config: null,
  catalog: { schema_version: 1, catalog_version: 1, items: [] },
  catalogLoadState: 'loading',
  sessionToken: null,
  sessionExpiresAt: 0,
  sessionTimerId: null,
  turnstileToken: '',
  turnstileWidgetId: null,
  uploads: [],
  deletions: new Map(),
  submitting: false,
  activeModule: 'login',
  affiliateCatalog: { schema_version: 2, catalog_version: 1, items: [] },
  affiliateLoaded: false,
  affiliateLoading: false,
  affiliateSubmitting: false,
  affiliateEditingId: '',
  affiliateDuplicateBrandId: '',
  affiliatePage: 1,
  affiliateExpandedIds: new Set(),
  affiliateFormReturnFocusId: 'affiliate-create-button',
  affiliateFormInitialValue: '',
  affiliateLinkRowSequence: 0,
  affiliateProposals: [],
  affiliateProposalsLoading: false,
  affiliatePublishingNumber: 0,
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

function formatBrandCount(count) {
  const value = Math.max(0, Number(count) || 0);
  const mod100 = value % 100;
  const mod10 = value % 10;
  const noun = mod100 >= 11 && mod100 <= 14
    ? 'брендов'
    : mod10 === 1
      ? 'бренд'
      : mod10 >= 2 && mod10 <= 4
        ? 'бренда'
        : 'брендов';
  return `${value} ${noun}`;
}

function formatLinkCount(count) {
  const value = Math.max(0, Number(count) || 0);
  const mod100 = value % 100;
  const mod10 = value % 10;
  const noun = mod100 >= 11 && mod100 <= 14
    ? 'ссылок'
    : mod10 === 1
      ? 'ссылка'
      : mod10 >= 2 && mod10 <= 4
        ? 'ссылки'
        : 'ссылок';
  return `${value} ${noun}`;
}

function formatAdditionalLinkCount(count) {
  const value = Math.max(0, Number(count) || 0);
  const mod100 = value % 100;
  const mod10 = value % 10;
  const noun = mod100 >= 11 && mod100 <= 14
    ? 'ссылок'
    : mod10 === 1
      ? 'ссылку'
      : mod10 >= 2 && mod10 <= 4
        ? 'ссылки'
        : 'ссылок';
  return `${value} ${noun}`;
}

function affiliateCatalogSummary(catalog) {
  const links = catalog.items.reduce((total, item) => total + item.links.length, 0);
  return `${formatBrandCount(catalog.items.length)} · ${formatLinkCount(links)} · версия ${catalog.catalog_version}`;
}

function logoCatalogSummary() {
  if (state.catalogLoadState === 'loading') return 'Загрузка…';
  if (state.catalogLoadState === 'error') return 'Недоступен';
  return `v${state.catalog.catalog_version} · ${state.catalog.items.length} позиций`;
}

function updateHeaderSummary() {
  const affiliateActive = state.activeModule === 'affiliate';
  elements.catalogSummaryLabel.textContent = affiliateActive ? 'Affiliate Links' : 'Логотипы';
  elements.catalogSummary.textContent = affiliateActive
    ? state.affiliateLoaded ? affiliateCatalogSummary(state.affiliateCatalog) : 'Приватный каталог'
    : logoCatalogSummary();
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
    state.catalogLoadState = 'ready';
    updateHeaderSummary();
    populateAffiliateLogoOptions(elements.affiliateLogo.value);
  } catch (error) {
    state.catalogLoadState = 'error';
    updateHeaderSummary();
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

function sessionIsActive() {
  return Boolean(state.sessionToken) && Date.now() < state.sessionExpiresAt;
}

function sessionRequestHeaders(includeJson = false) {
  return {
    ['Author' + 'ization']: `Bearer ${state.sessionToken}`,
    ...(includeJson ? { 'Content-Type': 'application/json' } : {}),
  };
}

function scheduleSessionExpiry() {
  if (state.sessionTimerId !== null) {
    globalThis.clearTimeout(state.sessionTimerId);
  }
  const remaining = Math.max(0, state.sessionExpiresAt - Date.now());
  state.sessionTimerId = globalThis.setTimeout(() => {
    if (state.sessionToken && !sessionIsActive()) {
      logout('Сессия истекла. Войдите снова.');
    }
  }, remaining + 25);
}

function showModule(moduleName) {
  state.activeModule = moduleName;
  elements.loginPanel.hidden = moduleName !== 'login';
  elements.hubPanel.hidden = moduleName !== 'hub';
  elements.uploaderPanel.hidden = moduleName !== 'logos';
  elements.affiliatePanel.hidden = moduleName !== 'affiliate';
  updateHeaderSummary();
}

function showHub() {
  if (!sessionIsActive()) {
    logout('Сессия истекла. Войдите снова.');
    return;
  }
  showModule('hub');
  window.setTimeout(() => elements.openLogoLibrary.focus(), 0);
}

function openLogoLibrary() {
  if (!sessionIsActive()) {
    logout('Сессия истекла. Войдите снова.');
    return;
  }
  showModule('logos');
  window.setTimeout(() => elements.fileInput.focus(), 0);
}

function openAffiliateLibrary() {
  if (!sessionIsActive()) {
    logout('Сессия истекла. Войдите снова.');
    return;
  }
  showModule('affiliate');
  loadAffiliateCatalog(!state.affiliateLoaded);
  loadAffiliateProposals();
  window.setTimeout(() => elements.affiliateFilter.focus(), 0);
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
    const expiresIn = Number(payload.expires_in);
    const sessionTtlSeconds = Number.isFinite(expiresIn) && expiresIn > 0
      ? Math.min(Math.floor(expiresIn), 3600)
      : 1800;
    state.sessionExpiresAt = Date.now() + sessionTtlSeconds * 1000;
    scheduleSessionExpiry();
    elements.password.value = '';
    showModule('hub');
    setStatus(elements.loginStatus, '');
    elements.openLogoLibrary.focus();
  } catch (error) {
    setStatus(elements.loginStatus, error.message);
    resetTurnstile();
  } finally {
    state.submitting = false;
    updateLoginButton();
  }
}

function logout(message = '') {
  if (state.sessionTimerId !== null) {
    globalThis.clearTimeout(state.sessionTimerId);
    state.sessionTimerId = null;
  }
  state.sessionToken = null;
  state.sessionExpiresAt = 0;
  state.affiliateCatalog = { schema_version: 2, catalog_version: 1, items: [] };
  state.affiliateLoaded = false;
  state.affiliateLoading = false;
  state.affiliateSubmitting = false;
  state.affiliateProposals = [];
  state.affiliateProposalsLoading = false;
  state.affiliatePublishingNumber = 0;
  state.affiliatePage = 1;
  state.affiliateExpandedIds.clear();
  state.affiliateFormReturnFocusId = 'affiliate-create-button';
  state.affiliateFormInitialValue = '';
  resetAffiliateForm();
  setAffiliateFormOpen(false);
  elements.affiliateFilter.value = '';
  elements.affiliateFilterReset.hidden = true;
  elements.affiliateItems.replaceChildren();
  elements.affiliatePagination.hidden = true;
  elements.affiliateSuccessPanel.hidden = true;
  elements.affiliatePullRequestLink.removeAttribute('href');
  elements.affiliateSummary.textContent = 'Каталог ещё не загружен.';
  elements.affiliateProposalItems.replaceChildren();
  elements.affiliateProposalsEmpty.hidden = false;
  setStatus(elements.affiliateProposalsStatus, '');
  setStatus(elements.affiliateCatalogStatus, '');
  elements.affiliateLoading.textContent = 'Загрузите приватный каталог.';
  elements.affiliateLoading.hidden = false;
  showModule('login');
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
      const image = {
        ...inspectImage(bytes),
        sha256: await sha256Hex(bytes),
      };
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

function affiliateLogoAsset(logoId) {
  return state.catalog.items.find((item) => item.id === logoId) || null;
}

function affiliateLogoUrl(logoId) {
  const item = affiliateLogoAsset(logoId);
  if (!item || typeof item.path !== 'string') return '';
  const encodedPath = item.path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  const assetBase = new URL('.', state.config?.catalogUrl || RAW_CATALOG_URL).href;
  const url = new URL(encodedPath, assetBase);
  return url.href.startsWith(assetBase) ? url.href : '';
}

function affiliateBrandInitials(brand) {
  const words = String(brand || '').trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? `${words[0][0]}${words[1][0]}` : words[0]?.slice(0, 2) || '?').toUpperCase();
}

function populateAffiliateLogoOptions(selectedId = '') {
  const selected = String(selectedId || '');
  const options = [new Option('Без логотипа', '')];
  const logoItems = [...state.catalog.items].sort((left, right) => {
    const leftLabel = `${left.brand} ${left.variant || ''}`;
    const rightLabel = `${right.brand} ${right.variant || ''}`;
    return leftLabel.localeCompare(rightLabel, 'ru');
  });
  logoItems.forEach((item) => {
    options.push(new Option(`${item.brand} — ${item.variant || 'Primary'}`, item.id));
  });
  if (selected && !logoItems.some((item) => item.id === selected)) {
    options.push(new Option(`${selected} — недоступен в logo-library`, selected));
  }
  elements.affiliateLogo.replaceChildren(...options);
  elements.affiliateLogo.value = selected;
}

function updateAffiliateLinkRemoveButtons() {
  const rows = [...elements.affiliateLinksEditor.querySelectorAll('.affiliate-link-editor-row')];
  rows.forEach((row) => {
    row.querySelector('.affiliate-remove-link').disabled = state.affiliateSubmitting || rows.length <= 1;
  });
}

function addAffiliateLinkRow(link = {}) {
  const fragment = elements.affiliateLinkEditorTemplate.content.cloneNode(true);
  const row = fragment.querySelector('.affiliate-link-editor-row');
  const rowNumber = ++state.affiliateLinkRowSequence;
  const id = row.querySelector('.affiliate-link-id');
  const geo = row.querySelector('.affiliate-link-geo');
  const label = row.querySelector('.affiliate-link-label');
  const destination = row.querySelector('.affiliate-link-url');
  const remove = row.querySelector('.affiliate-remove-link');

  geo.id = `affiliate-link-geo-${rowNumber}`;
  label.id = `affiliate-link-label-${rowNumber}`;
  destination.id = `affiliate-link-url-${rowNumber}`;
  row.querySelector('.affiliate-link-geo-label').htmlFor = geo.id;
  row.querySelector('.affiliate-link-variant-label').htmlFor = label.id;
  row.querySelector('.affiliate-link-url-label').htmlFor = destination.id;

  id.value = String(link.id || '');
  geo.value = String(link.geo || 'GLOBAL').toUpperCase();
  label.value = String(link.label || '');
  destination.value = String(link.destination_url || '');
  geo.addEventListener('input', () => {
    geo.value = geo.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6);
  });
  remove.addEventListener('click', () => {
    if (elements.affiliateLinksEditor.children.length <= 1) return;
    const rows = [...elements.affiliateLinksEditor.children];
    const currentIndex = rows.indexOf(row);
    row.remove();
    updateAffiliateLinkRemoveButtons();
    const remainingRows = [...elements.affiliateLinksEditor.children];
    const nextRow = remainingRows[Math.min(currentIndex, remainingRows.length - 1)];
    (nextRow?.querySelector('.affiliate-link-url') || elements.affiliateAddLink).focus();
  });

  elements.affiliateLinksEditor.append(fragment);
  updateAffiliateLinkRemoveButtons();
  return row;
}

function affiliateLinksFromForm() {
  return [...elements.affiliateLinksEditor.querySelectorAll('.affiliate-link-editor-row')].map((row) => ({
    id: row.querySelector('.affiliate-link-id').value,
    geo: row.querySelector('.affiliate-link-geo').value,
    label: row.querySelector('.affiliate-link-label').value,
    destination_url: row.querySelector('.affiliate-link-url').value,
  }));
}

function affiliateLinkDisplay(link) {
  try {
    const url = new URL(link.destination_url);
    const path = url.pathname === '/' ? '' : url.pathname;
    const route = path.length > 54 ? `${path.slice(0, 51)}…` : path;
    return {
      destination: `${url.hostname}${route}`,
      hasParameters: Boolean(url.search || url.hash),
      label: link.label,
    };
  } catch {
    return {
      destination: 'Некорректный URL',
      hasParameters: false,
      label: link.label,
    };
  }
}

function affiliateFormValue() {
  return JSON.stringify({
    brand: elements.affiliateBrand.value,
    logo_id: elements.affiliateLogo.value,
    links: affiliateLinksFromForm(),
    tags: elements.affiliateTags.value,
  });
}

function affiliateFormIsDirty() {
  return !elements.affiliateForm.hidden
    && Boolean(state.affiliateFormInitialValue)
    && affiliateFormValue() !== state.affiliateFormInitialValue;
}

function confirmAffiliateFormReplacement() {
  return !affiliateFormIsDirty()
    || globalThis.confirm('Закрыть форму и потерять несохранённые изменения?');
}

function findExistingAffiliateBrand() {
  const normalizedBrand = affiliateBrandKey(elements.affiliateBrand.value);
  if (!normalizedBrand) return null;

  return state.affiliateCatalog.items.find((item) => (
    item.id !== state.affiliateEditingId
    && affiliateBrandKey(item.brand) === normalizedBrand
  )) || null;
}

function updateAffiliateSubmitButton() {
  elements.affiliateSubmitButton.disabled = state.affiliateSubmitting
    || !state.affiliateLoaded
    || Boolean(state.affiliateDuplicateBrandId);
}

function updateExistingAffiliateBrandGuidance() {
  const existingItem = findExistingAffiliateBrand();
  state.affiliateDuplicateBrandId = existingItem?.id || '';
  elements.affiliateExistingBrand.hidden = !existingItem;
  elements.affiliateBrand.setCustomValidity(existingItem
    ? `Бренд «${existingItem.brand}» уже существует. Откройте его запись и добавьте ссылку туда.`
    : '');

  if (existingItem) {
    elements.affiliateExistingBrandMessage.textContent = 'Новую ссылку нужно добавить в существующую запись.';
    elements.affiliateOpenExistingBrand.textContent = `Открыть «${existingItem.brand}»`;
  } else {
    elements.affiliateExistingBrandMessage.textContent = '';
    elements.affiliateOpenExistingBrand.textContent = '';
  }

  updateAffiliateSubmitButton();
}

function resetAffiliateForm(clearStatus = true) {
  state.affiliateEditingId = '';
  state.affiliateDuplicateBrandId = '';
  if (elements.affiliateForm) {
    elements.affiliateForm.reset();
  }
  elements.affiliateBrand.setCustomValidity('');
  elements.affiliateExistingBrand.hidden = true;
  elements.affiliateExistingBrandMessage.textContent = '';
  elements.affiliateOpenExistingBrand.textContent = '';
  populateAffiliateLogoOptions('');
  elements.affiliateLinksEditor.replaceChildren();
  addAffiliateLinkRow();
  elements.affiliateFormTitle.textContent = 'Новый бренд';
  elements.affiliateSubmitButton.textContent = 'Создать PR';
  elements.affiliateCancelButton.textContent = 'Закрыть';
  elements.affiliateDangerZone.hidden = true;
  elements.affiliateDeleteButton.disabled = false;
  if (clearStatus) {
    setStatus(elements.affiliateFormStatus, '');
  }
  updateAffiliateSubmitButton();
}

function setAffiliateFormOpen(open) {
  elements.affiliateForm.hidden = !open;
  elements.affiliateLayout.classList.toggle('is-form-open', open);
  elements.affiliateCreateButton.hidden = open;
}

function openAffiliateCreateForm() {
  if (!confirmAffiliateFormReplacement()) return;
  resetAffiliateForm();
  state.affiliateFormReturnFocusId = elements.affiliateCreateButton.id;
  setAffiliateFormOpen(true);
  elements.affiliateSuccessPanel.hidden = true;
  state.affiliateFormInitialValue = affiliateFormValue();
  renderAffiliateItems();
  elements.affiliateBrand.focus();
}

function closeAffiliateForm() {
  if (!confirmAffiliateFormReplacement()) return;
  const returnFocusId = state.affiliateFormReturnFocusId;
  resetAffiliateForm();
  setAffiliateFormOpen(false);
  state.affiliateFormInitialValue = '';
  renderAffiliateItems();
  globalThis.setTimeout(() => {
    (document.getElementById(returnFocusId) || elements.affiliateCreateButton).focus();
  }, 0);
}

function discardAffiliateFormForCatalogReplacement() {
  if (elements.affiliateForm.hidden) return true;
  if (!confirmAffiliateFormReplacement()) return false;
  resetAffiliateForm();
  setAffiliateFormOpen(false);
  state.affiliateFormInitialValue = '';
  renderAffiliateItems();
  return true;
}

function safePullRequestUrl(value) {
  try {
    const url = new URL(value);
    if (
      url.origin !== 'https://github.com'
      || !url.href.startsWith(AFFILIATE_GITHUB_PR_PREFIX)
      || !/^\/AleksandrDruk\/btm-affiliate-library\/pull\/[1-9][0-9]*\/?$/.test(url.pathname)
      || url.search
      || url.hash
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function normalizeAffiliateProposal(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('API вернул некорректный статус PR.');
  }
  const number = Number(value.number);
  const url = safePullRequestUrl(value.url);
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  const headSha = typeof value.head_sha === 'string' ? value.head_sha.toLowerCase() : '';
  const checks = value.checks;
  const checkKeys = checks && typeof checks === 'object' && !Array.isArray(checks)
    ? Object.keys(checks).sort()
    : [];
  const expectedCheckKeys = [...AFFILIATE_REQUIRED_CHECKS].sort();
  if (
    !Number.isInteger(number)
    || number < 1
    || !url
    || !title
    || title.length > 180
    || !/^[0-9a-f]{40}$/.test(headSha)
    || JSON.stringify(checkKeys) !== JSON.stringify(expectedCheckKeys)
    || AFFILIATE_REQUIRED_CHECKS.some((name) => !['pending', 'success', 'failed'].includes(checks[name]))
    || typeof value.approved !== 'boolean'
    || typeof value.publishable !== 'boolean'
    || typeof value.code !== 'string'
    || !/^[a-z][a-z0-9_]{0,79}$/.test(value.code)
    || typeof value.message !== 'string'
    || value.message.length < 1
    || value.message.length > 300
  ) {
    throw new Error('API вернул некорректный статус PR.');
  }
  if (
    value.publishable
    && (!value.approved || AFFILIATE_REQUIRED_CHECKS.some((name) => checks[name] !== 'success'))
  ) {
    throw new Error('API вернул противоречивый approval status.');
  }
  const pathNumber = Number(url.pathname.split('/').filter(Boolean).at(-1));
  if (pathNumber !== number) {
    throw new Error('API вернул несовпадающий номер PR.');
  }

  return {
    number,
    title,
    url: url.href,
    head_sha: headSha,
    checks: Object.fromEntries(AFFILIATE_REQUIRED_CHECKS.map((name) => [name, checks[name]])),
    approved: value.approved,
    publishable: value.publishable,
    code: value.code,
    message: value.message,
  };
}

function proposalCheckLabel(name, stateValue) {
  const label = name === 'validate-catalog' ? 'Каталог' : 'Код';
  if (stateValue === 'success') return `${label} ✓`;
  if (stateValue === 'failed') return `${label}: ошибка`;
  return `${label}: ожидается`;
}

function proposalStatusChip(label, stateValue) {
  const chip = document.createElement('span');
  chip.className = `proposal-status-chip is-${stateValue}`;
  chip.textContent = label;
  return chip;
}

function renderAffiliateProposals() {
  elements.affiliateProposalItems.replaceChildren();
  elements.affiliateProposalsEmpty.hidden = state.affiliateProposals.length > 0 || state.affiliateProposalsLoading;
  elements.affiliateProposalsCount.hidden = state.affiliateProposals.length === 0;
  elements.affiliateProposalsCount.textContent = state.affiliateProposals.length === 1
    ? '1 ожидает'
    : `${state.affiliateProposals.length} ожидают`;

  state.affiliateProposals.forEach((proposal) => {
    const fragment = elements.affiliateProposalTemplate.content.cloneNode(true);
    const row = fragment.querySelector('.affiliate-proposal');
    const link = fragment.querySelector('.affiliate-proposal-link');
    const publishButton = fragment.querySelector('.publish-affiliate-proposal');
    const statuses = fragment.querySelector('.affiliate-proposal-statuses');
    row.classList.toggle('is-ready', proposal.publishable);
    fragment.querySelector('.affiliate-proposal-title').textContent = `#${proposal.number} · ${proposal.title}`;
    AFFILIATE_REQUIRED_CHECKS.forEach((name) => {
      statuses.append(proposalStatusChip(
        proposalCheckLabel(name, proposal.checks[name]),
        proposal.checks[name],
      ));
    });
    statuses.append(proposalStatusChip(
      proposal.approved ? 'Approve ✓' : 'Approve: ожидается',
      proposal.approved ? 'success' : 'pending',
    ));
    fragment.querySelector('.affiliate-proposal-message').textContent = proposal.message;
    link.href = proposal.url;
    publishButton.disabled = !proposal.publishable || state.affiliateSubmitting;
    publishButton.textContent = state.affiliatePublishingNumber === proposal.number
      ? 'Публикуем…'
      : 'Опубликовать';
    publishButton.addEventListener('click', () => publishAffiliateProposal(proposal));
    elements.affiliateProposalItems.append(fragment);
  });
}

async function loadAffiliateProposals() {
  if (!state.config || state.affiliateProposalsLoading || !sessionIsActive()) return;
  state.affiliateProposalsLoading = true;
  const sessionAtStart = state.sessionToken;
  elements.affiliateProposalsRefresh.disabled = true;
  setStatus(elements.affiliateProposalsStatus, 'Проверяем Actions и review в GitHub…', 'info');
  renderAffiliateProposals();

  try {
    const response = await fetch(`${state.config.apiBase}/affiliate-catalog/proposals`, {
      method: 'GET',
      headers: sessionRequestHeaders(),
      cache: 'no-store',
    });
    if (sessionAtStart !== state.sessionToken || !sessionIsActive()) return;
    if (response.status === 401) {
      logout('Сессия истекла. Войдите снова.');
      return;
    }
    if (!response.ok) {
      throw new Error(await apiError(response));
    }
    const payload = await response.json();
    if (payload?.ok !== true || !Array.isArray(payload.proposals) || payload.proposals.length > 10) {
      throw new Error('API вернул некорректный список PR.');
    }
    state.affiliateProposals = payload.proposals.map(normalizeAffiliateProposal);
    setStatus(elements.affiliateProposalsStatus, '');
  } catch (error) {
    setStatus(elements.affiliateProposalsStatus, `Не удалось обновить PR: ${error.message}`);
  } finally {
    state.affiliateProposalsLoading = false;
    elements.affiliateProposalsRefresh.disabled = state.affiliateSubmitting;
    renderAffiliateProposals();
  }
}

async function publishAffiliateProposal(proposal) {
  if (!proposal.publishable || state.affiliateSubmitting || !sessionIsActive()) return;
  if (!globalThis.confirm(`Опубликовать проверенный PR #${proposal.number}? Worker зафиксирует точный commit и только затем обновит каталог для WordPress.`)) {
    return;
  }
  if (!discardAffiliateFormForCatalogReplacement()) return;

  setAffiliateBusy(true);
  state.affiliatePublishingNumber = proposal.number;
  renderAffiliateProposals();
  const sessionAtStart = state.sessionToken;
  setStatus(elements.affiliateProposalsStatus, `Публикуем PR #${proposal.number}…`, 'info');
  try {
    const response = await fetch(
      `${state.config.apiBase}/affiliate-catalog/proposals/${proposal.number}/publish`,
      {
        method: 'POST',
        headers: sessionRequestHeaders(true),
        body: JSON.stringify({ head_sha: proposal.head_sha }),
      },
    );
    if (sessionAtStart !== state.sessionToken || !sessionIsActive()) return;
    if (response.status === 401) {
      logout('Сессия истекла. Войдите снова.');
      return;
    }
    if (!response.ok) {
      throw new Error(await apiError(response));
    }
    const payload = await response.json();
    if (payload?.ok !== true || payload.published !== true || !payload.catalog) {
      throw new Error('API не подтвердил публикацию каталога.');
    }
    state.affiliateCatalog = validateAffiliateCatalog(payload.catalog);
    state.affiliateLoaded = true;
    elements.affiliateSummary.textContent = affiliateCatalogSummary(state.affiliateCatalog);
    updateHeaderSummary();
    setStatus(elements.affiliateCatalogStatus, `PR #${proposal.number} опубликован. Каталог обновлён.`, 'success');
    renderAffiliateItems();
    state.affiliateProposals = state.affiliateProposals.filter((item) => item.number !== proposal.number);
    setStatus(elements.affiliateProposalsStatus, `PR #${proposal.number} опубликован и зафиксирован как текущий approved catalog.`, 'success');
  } catch (error) {
    setStatus(elements.affiliateProposalsStatus, error.message);
  } finally {
    state.affiliatePublishingNumber = 0;
    setAffiliateBusy(false);
    await loadAffiliateProposals();
  }
}

function editAffiliateItem(item, triggerId) {
  if (!elements.affiliateForm.hidden && state.affiliateEditingId === item.id) {
    elements.affiliateBrand.focus();
    return;
  }
  if (!confirmAffiliateFormReplacement()) return;
  resetAffiliateForm();
  setAffiliateFormOpen(true);
  state.affiliateEditingId = item.id;
  state.affiliateFormReturnFocusId = triggerId;
  elements.affiliateBrand.value = item.brand;
  populateAffiliateLogoOptions(item.logo_id);
  elements.affiliateLinksEditor.replaceChildren();
  item.links.forEach((link) => addAffiliateLinkRow(link));
  elements.affiliateTags.value = item.tags.join(', ');
  elements.affiliateFormTitle.textContent = `Изменение: ${item.brand}`;
  elements.affiliateSubmitButton.textContent = 'Создать PR с изменением';
  elements.affiliateCancelButton.textContent = 'Закрыть';
  elements.affiliateDangerZone.hidden = false;
  elements.affiliateSuccessPanel.hidden = true;
  setStatus(elements.affiliateFormStatus, 'Существующее значение изменится только после review и merge PR.', 'info');
  updateExistingAffiliateBrandGuidance();
  state.affiliateFormInitialValue = affiliateFormValue();
  renderAffiliateItems();
  elements.affiliateBrand.focus();
}

function renderAffiliateItems() {
  const filter = elements.affiliateFilter.value.trim().toLowerCase();
  const allItems = [...state.affiliateCatalog.items]
    .sort((left, right) => left.brand.localeCompare(right.brand, 'ru'))
    .filter((item) => {
      const linkData = item.links.flatMap((link) => [
        link.id,
        link.geo,
        link.label,
        link.destination_url,
      ]);
      const haystack = [item.brand, item.id, item.logo_id, ...item.tags, ...linkData].join(' ').toLowerCase();
      return !filter || haystack.includes(filter);
    });
  const pageCount = Math.max(1, Math.ceil(allItems.length / AFFILIATE_PAGE_SIZE));
  state.affiliatePage = Math.min(Math.max(1, state.affiliatePage), pageCount);
  const pageStart = (state.affiliatePage - 1) * AFFILIATE_PAGE_SIZE;
  const items = allItems.slice(pageStart, pageStart + AFFILIATE_PAGE_SIZE);

  elements.affiliateItems.replaceChildren();
  elements.affiliateFilterReset.hidden = filter === '';
  elements.affiliateLoading.hidden = state.affiliateLoaded || state.affiliateLoading === false;
  if (state.affiliateLoading) {
    elements.affiliateLoading.hidden = false;
    elements.affiliateLoading.textContent = 'Загружаем приватный каталог…';
  }

  const showEmpty = state.affiliateLoaded && !state.affiliateLoading && allItems.length === 0;
  elements.affiliateItemsEmpty.hidden = !showEmpty;
  if (showEmpty) {
    const catalogEmpty = state.affiliateCatalog.items.length === 0;
    elements.affiliateEmptyTitle.textContent = catalogEmpty ? 'Каталог пока пуст' : 'Ничего не найдено';
    elements.affiliateEmptyCopy.textContent = catalogEmpty
      ? 'Добавьте первый бренд и его affiliate-ссылку.'
      : 'Измените запрос или сбросьте поиск.';
    elements.affiliateEmptyAction.textContent = catalogEmpty ? 'Добавить первый бренд' : 'Сбросить поиск';
  }

  elements.affiliatePagination.hidden = !state.affiliateLoaded || allItems.length === 0;
  if (allItems.length > 0) {
    const firstVisible = pageStart + 1;
    const lastVisible = Math.min(pageStart + items.length, allItems.length);
    elements.affiliatePageSummary.textContent = filter
      ? `Найдено ${allItems.length} из ${state.affiliateCatalog.items.length}${allItems.length > AFFILIATE_PAGE_SIZE ? ` · ${firstVisible}–${lastVisible}` : ''}`
      : `${firstVisible}–${lastVisible} из ${allItems.length}`;
    elements.affiliatePagePrevious.disabled = state.affiliateSubmitting || state.affiliatePage <= 1;
    elements.affiliatePageNext.disabled = state.affiliateSubmitting || state.affiliatePage >= pageCount;
  }

  items.forEach((item) => {
    const fragment = elements.affiliateItemTemplate.content.cloneNode(true);
    const row = fragment.querySelector('.affiliate-item');
    const preview = fragment.querySelector('.affiliate-item-preview');
    const previewFallback = fragment.querySelector('.affiliate-item-preview-fallback');
    const editButton = fragment.querySelector('.edit-affiliate');
    const editButtonId = `btm-affiliate-edit-${item.id}`;
    fragment.querySelector('.affiliate-item-name').textContent = item.brand;
    const geos = [...new Set(item.links.map((link) => link.geo))];
    fragment.querySelector('.affiliate-item-meta').textContent = `${formatLinkCount(item.links.length)} · ${geos.join(' / ')}`;
    const previewUrl = affiliateLogoUrl(item.logo_id);
    previewFallback.textContent = affiliateBrandInitials(item.brand);
    if (previewUrl) {
      preview.src = previewUrl;
      preview.alt = `Логотип ${item.brand}`;
      previewFallback.hidden = true;
      preview.addEventListener('error', () => {
        preview.hidden = true;
        previewFallback.hidden = false;
      }, { once: true });
    } else {
      preview.hidden = true;
      previewFallback.hidden = false;
    }
    const linksContainer = fragment.querySelector('.affiliate-item-link-list');
    const linksToggle = fragment.querySelector('.affiliate-links-toggle');
    const expanded = state.affiliateExpandedIds.has(item.id);
    linksContainer.id = `btm-affiliate-links-${item.id}`;
    item.links.forEach((link, index) => {
      const summary = document.createElement('div');
      summary.className = 'affiliate-link-summary';
      summary.hidden = index > 0 && !expanded;
      const badge = document.createElement('span');
      badge.className = `affiliate-link-badge${link.geo === 'GLOBAL' ? ' is-global' : ''}`;
      badge.textContent = link.geo;
      const display = affiliateLinkDisplay(link);
      const copy = document.createElement('span');
      copy.className = 'affiliate-link-copy';
      if (display.label) {
        const variant = document.createElement('span');
        variant.className = 'affiliate-link-variant';
        variant.textContent = display.label;
        copy.append(variant);
      }
      const destination = document.createElement('span');
      destination.className = 'affiliate-link-destination';
      destination.textContent = display.destination;
      copy.append(destination);
      if (display.hasParameters) {
        const parameters = document.createElement('span');
        parameters.className = 'affiliate-link-parameters';
        parameters.textContent = 'параметры';
        copy.append(parameters);
      }
      summary.append(badge, copy);
      linksContainer.append(summary);
    });
    if (item.links.length > 1) {
      linksToggle.hidden = false;
      linksToggle.type = 'button';
      linksToggle.setAttribute('aria-controls', linksContainer.id);
      linksToggle.setAttribute('aria-expanded', String(expanded));
      const toggleLabel = document.createElement('span');
      toggleLabel.textContent = expanded
        ? 'Свернуть дополнительные ссылки'
        : `Показать ещё ${formatAdditionalLinkCount(item.links.length - 1)}`;
      const toggleIcon = document.createElement('span');
      toggleIcon.className = 'affiliate-links-toggle-icon';
      toggleIcon.setAttribute('aria-hidden', 'true');
      toggleIcon.textContent = expanded ? '↑' : '↓';
      linksToggle.replaceChildren(toggleLabel, toggleIcon);
      linksToggle.addEventListener('click', () => {
        if (state.affiliateExpandedIds.has(item.id)) {
          state.affiliateExpandedIds.delete(item.id);
        } else {
          state.affiliateExpandedIds.add(item.id);
        }
        renderAffiliateItems();
        globalThis.setTimeout(() => {
          elements.affiliateItems.querySelector(`[aria-controls="${linksContainer.id}"]`)?.focus();
        }, 0);
      });
    }
    row.classList.toggle('is-editing', state.affiliateEditingId === item.id);
    editButton.id = editButtonId;
    editButton.disabled = state.affiliateSubmitting;
    editButton.addEventListener('click', () => editAffiliateItem(item, editButtonId));
    elements.affiliateItems.append(fragment);
  });
}

function setAffiliateBusy(busy) {
  state.affiliateSubmitting = busy;
  updateAffiliateSubmitButton();
  elements.affiliateCancelButton.disabled = busy;
  elements.affiliateDeleteButton.disabled = busy;
  elements.affiliateBrand.disabled = busy;
  elements.affiliateLogo.disabled = busy;
  elements.affiliateTags.disabled = busy;
  elements.affiliateRefreshButton.disabled = busy || state.affiliateLoading;
  elements.affiliateCreateButton.disabled = busy || !state.affiliateLoaded;
  elements.affiliateFilterReset.disabled = busy;
  elements.affiliateProposalsRefresh.disabled = busy || state.affiliateProposalsLoading;
  elements.affiliateAddLink.disabled = busy;
  elements.affiliateLinksEditor.querySelectorAll('input, button').forEach((control) => {
    control.disabled = busy;
  });
  updateAffiliateLinkRemoveButtons();
  elements.affiliateItems.querySelectorAll('button').forEach((button) => {
    button.disabled = busy;
  });
  renderAffiliateItems();
  renderAffiliateProposals();
}

async function loadAffiliateCatalog(forceRefresh = false) {
  if (!state.config || state.affiliateLoading) return;
  if (!sessionIsActive()) {
    logout('Сессия истекла. Войдите снова.');
    return;
  }
  if (forceRefresh && !discardAffiliateFormForCatalogReplacement()) return;
  if (state.affiliateLoaded && !forceRefresh) {
    renderAffiliateItems();
    return;
  }

  state.affiliateLoading = true;
  const requestSessionToken = state.sessionToken;
  elements.affiliateRefreshButton.disabled = true;
  elements.affiliateCreateButton.disabled = true;
  elements.affiliateItemsEmpty.hidden = true;
  elements.affiliateSummary.textContent = 'Загрузка…';
  setStatus(elements.affiliateCatalogStatus, 'Загружаем приватный каталог…', 'info');
  renderAffiliateItems();

  try {
    const response = await fetch(`${state.config.apiBase}/affiliate-catalog`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${state.sessionToken}` },
      cache: 'no-store',
    });
    if (requestSessionToken !== state.sessionToken || !sessionIsActive()) {
      return;
    }
    if (response.status === 401) {
      logout('Сессия истекла. Войдите снова.');
      return;
    }
    if (!response.ok) {
      throw new Error(await apiError(response));
    }
    const payload = await response.json();
    if (payload?.ok !== true || !payload.catalog) {
      throw new Error('API вернул некорректный affiliate-каталог.');
    }
    state.affiliateCatalog = validateAffiliateCatalog(payload.catalog);
    state.affiliateLoaded = true;
    if (
      state.affiliateEditingId
      && !state.affiliateCatalog.items.some((item) => item.id === state.affiliateEditingId)
    ) {
      resetAffiliateForm();
      setAffiliateFormOpen(false);
    }
    elements.affiliateSummary.textContent = affiliateCatalogSummary(state.affiliateCatalog);
    updateHeaderSummary();
    setStatus(elements.affiliateCatalogStatus, 'Каталог актуален. Изменения создают PR и не применяются напрямую.', 'success');
  } catch (error) {
    const prefix = state.affiliateLoaded ? 'Не удалось обновить каталог' : 'Не удалось загрузить каталог';
    elements.affiliateSummary.textContent = state.affiliateLoaded
      ? `${affiliateCatalogSummary(state.affiliateCatalog)} · сохранена текущая копия`
      : 'Недоступен';
    setStatus(elements.affiliateCatalogStatus, `${prefix}: ${error.message}`);
  } finally {
    state.affiliateLoading = false;
    elements.affiliateLoading.hidden = true;
    elements.affiliateRefreshButton.disabled = state.affiliateSubmitting;
    updateExistingAffiliateBrandGuidance();
    elements.affiliateCreateButton.disabled = state.affiliateSubmitting || !state.affiliateLoaded;
    renderAffiliateItems();
  }
}

function affiliateOperationFromForm() {
  return {
    mode: state.affiliateEditingId ? 'update' : 'new',
    asset_id: state.affiliateEditingId,
    brand: elements.affiliateBrand.value,
    logo_id: elements.affiliateLogo.value,
    links: affiliateLinksFromForm(),
    tags: elements.affiliateTags.value,
  };
}

async function submitAffiliateOperations(operations, restoreFocusId = '') {
  if (!state.config || !state.affiliateLoaded || state.affiliateSubmitting) return;
  if (!sessionIsActive()) {
    logout('Сессия истекла. Войдите снова.');
    return;
  }

  try {
    buildAffiliateCatalogUpdate(state.affiliateCatalog, operations);
  } catch (error) {
    if (error instanceof AffiliateCatalogError) {
      setStatus(elements.affiliateFormStatus, error.message);
      return;
    }
    throw error;
  }

  setAffiliateBusy(true);
  const returnFocusId = restoreFocusId || state.affiliateFormReturnFocusId;
  const requestSessionToken = state.sessionToken;
  elements.affiliateSuccessPanel.hidden = true;
  setStatus(elements.affiliateFormStatus, 'Проверяем актуальную версию и создаём GitHub PR…', 'info');
  try {
    const response = await fetch(`${state.config.apiBase}/affiliate-catalog/propose`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${state.sessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        catalog_version: state.affiliateCatalog.catalog_version,
        operations,
      }),
    });
    if (requestSessionToken !== state.sessionToken || !sessionIsActive()) {
      return;
    }
    if (response.status === 401) {
      logout('Сессия истекла. Войдите снова.');
      return;
    }
    if (!response.ok) {
      throw new Error(await apiError(response));
    }
    const payload = await response.json();
    const pullUrl = safePullRequestUrl(payload?.pull_request?.url || '');
    if (payload?.ok !== true || !pullUrl) {
      throw new Error('API вернул неожиданный адрес PR.');
    }

    elements.affiliatePullRequestLink.href = pullUrl.href;
    elements.affiliateSuccessPanel.hidden = false;
    resetAffiliateForm(false);
    setAffiliateFormOpen(false);
    state.affiliateFormInitialValue = '';
    setStatus(elements.affiliateFormStatus, '');
    setStatus(elements.affiliateCatalogStatus, 'PR создан. Каталог изменится только после checks, Approve и публикации.', 'success');
    await loadAffiliateProposals();
    globalThis.setTimeout(() => elements.affiliatePullRequestLink.focus(), 0);
  } catch (error) {
    setStatus(elements.affiliateFormStatus, error.message);
  } finally {
    setAffiliateBusy(false);
    renderAffiliateItems();
    if (restoreFocusId && !elements.affiliateSuccessPanel.hidden) {
      globalThis.setTimeout(() => document.getElementById(returnFocusId)?.focus(), 0);
    }
  }
}

function submitAffiliateForm(event) {
  event.preventDefault();
  if (!elements.affiliateForm.checkValidity()) {
    elements.affiliateForm.reportValidity();
    return;
  }
  submitAffiliateOperations([affiliateOperationFromForm()]);
}

function openExistingAffiliateBrand() {
  const item = state.affiliateCatalog.items.find((entry) => (
    entry.id === state.affiliateDuplicateBrandId
  ));
  if (!item) {
    updateExistingAffiliateBrandGuidance();
    return;
  }

  editAffiliateItem(item, `btm-affiliate-edit-${item.id}`);
}

function deleteEditingAffiliateItem() {
  const item = state.affiliateCatalog.items.find((entry) => entry.id === state.affiliateEditingId);
  if (!item || state.affiliateSubmitting) return;
  if (!globalThis.confirm(`Удалить ${item.brand} из центрального каталога? Уже скопированные ссылки на сайтах не изменятся.`)) {
    return;
  }
  submitAffiliateOperations(
    [{ mode: 'delete', asset_id: item.id }],
    state.affiliateFormReturnFocusId,
  );
}

function resetAffiliateFilter() {
  elements.affiliateFilter.value = '';
  state.affiliatePage = 1;
  renderAffiliateItems();
  elements.affiliateFilter.focus();
}

function changeAffiliatePage(direction) {
  state.affiliatePage += direction;
  renderAffiliateItems();
  elements.affiliateItems.closest('.affiliate-catalog')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function bindEvents() {
  elements.loginForm.addEventListener('submit', login);
  elements.hubLogoutButton.addEventListener('click', () => logout());
  elements.openLogoLibrary.addEventListener('click', openLogoLibrary);
  elements.openAffiliateLibrary.addEventListener('click', openAffiliateLibrary);
  elements.logoBackButton.addEventListener('click', showHub);
  elements.logoutButton.addEventListener('click', () => logout());
  elements.affiliateBackButton.addEventListener('click', () => {
    if (!confirmAffiliateFormReplacement()) return;
    resetAffiliateForm();
    setAffiliateFormOpen(false);
    state.affiliateFormInitialValue = '';
    showHub();
  });
  elements.affiliateLogoutButton.addEventListener('click', () => logout());
  elements.affiliateForm.addEventListener('submit', submitAffiliateForm);
  elements.affiliateBrand.addEventListener('input', updateExistingAffiliateBrandGuidance);
  elements.affiliateOpenExistingBrand.addEventListener('click', openExistingAffiliateBrand);
  elements.affiliateCreateButton.addEventListener('click', openAffiliateCreateForm);
  elements.affiliateCancelButton.addEventListener('click', closeAffiliateForm);
  elements.affiliateDeleteButton.addEventListener('click', deleteEditingAffiliateItem);
  elements.affiliateAddLink.addEventListener('click', () => {
    const row = addAffiliateLinkRow();
    row.querySelector('.affiliate-link-url').focus();
  });
  elements.affiliateFilter.addEventListener('input', () => {
    state.affiliatePage = 1;
    renderAffiliateItems();
  });
  elements.affiliateFilterReset.addEventListener('click', resetAffiliateFilter);
  elements.affiliateEmptyAction.addEventListener('click', () => {
    if (state.affiliateCatalog.items.length === 0) {
      openAffiliateCreateForm();
    } else {
      resetAffiliateFilter();
    }
  });
  elements.affiliatePagePrevious.addEventListener('click', () => changeAffiliatePage(-1));
  elements.affiliatePageNext.addEventListener('click', () => changeAffiliatePage(1));
  elements.affiliateRefreshButton.addEventListener('click', () => loadAffiliateCatalog(true));
  elements.affiliateProposalsRefresh.addEventListener('click', () => loadAffiliateProposals());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.sessionToken && !sessionIsActive()) {
      logout('Сессия истекла. Войдите снова.');
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.activeModule === 'affiliate' && !elements.affiliateForm.hidden) {
      closeAffiliateForm();
    }
  });
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
  showModule('login');
  resetAffiliateForm();
  setAffiliateFormOpen(false);
  updateAffiliateSubmitButton();
  elements.affiliateCreateButton.disabled = true;
  renderQueue();
  renderAffiliateItems();
  renderAffiliateProposals();
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
