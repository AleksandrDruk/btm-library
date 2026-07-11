import { base64ToBytes, bytesToBase64, bytesToBase64Url } from '../lib/crypto.js';

const API_BASE = 'https://api.github.com';
const API_VERSION = '2026-03-10';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const cachedTokens = new Map();

export class GitHubApiError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'GitHubApiError';
    this.code = code;
    this.status = status;
  }
}

function concatBytes(...parts) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function derLength(length) {
  if (length < 128) {
    return Uint8Array.of(length);
  }
  const bytes = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>>= 8;
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function der(tag, body) {
  return concatBytes(Uint8Array.of(tag), derLength(body.length), body);
}

function wrapPkcs1AsPkcs8(pkcs1) {
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const rsaAlgorithm = Uint8Array.of(
    0x30, 0x0d,
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
    0x05, 0x00,
  );
  return der(0x30, concatBytes(version, rsaAlgorithm, der(0x04, pkcs1)));
}

function privateKeyBytes(pemValue) {
  const pem = String(pemValue || '').replace(/\\n/g, '\n').trim();
  const pkcs8Match = pem.match(/-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/);
  if (pkcs8Match) {
    return base64ToBytes(pkcs8Match[1].replace(/\s+/g, ''));
  }
  const pkcs1Match = pem.match(/-----BEGIN RSA PRIVATE KEY-----([\s\S]+?)-----END RSA PRIVATE KEY-----/);
  if (pkcs1Match) {
    return wrapPkcs1AsPkcs8(base64ToBytes(pkcs1Match[1].replace(/\s+/g, '')));
  }
  throw new GitHubApiError('github_key_invalid', 'GitHub App private key имеет неизвестный формат.', 503);
}

async function createAppJwt(configuration) {
  const appId = configuration.appId;
  if (!/^\d+$/.test(appId) || !configuration.privateKey) {
    throw new GitHubApiError('github_not_configured', 'GitHub App не настроена.', 503);
  }

  const key = await crypto.subtle.importKey(
    'pkcs8',
    privateKeyBytes(configuration.privateKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const now = Math.floor(Date.now() / 1000);
  const header = bytesToBase64Url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = bytesToBase64Url(encoder.encode(JSON.stringify({ iat: now - 30, exp: now + 540, iss: appId })));
  const unsigned = `${header}.${payload}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(unsigned));
  return `${unsigned}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

function repoConfiguration(env, prefix = 'GITHUB') {
  if (!/^[A-Z][A-Z0-9_]{0,40}$/.test(prefix)) {
    throw new GitHubApiError('github_config_invalid', 'GitHub repository prefix некорректен.', 503);
  }

  const owner = String(env[`${prefix}_OWNER`] || '').trim();
  const repo = String(env[`${prefix}_REPO`] || '').trim();
  const branch = String(env[`${prefix}_BASE_BRANCH`] || 'main').trim();
  const appId = String(env[`${prefix}_APP_ID`] || '').trim();
  const privateKey = String(env[`${prefix}_APP_PRIVATE_KEY`] || '');
  if (!/^[A-Za-z0-9-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo) || !/^[A-Za-z0-9._/-]+$/.test(branch)) {
    throw new GitHubApiError('github_config_invalid', 'GitHub repository config некорректен.', 503);
  }
  if (!/^\d+$/.test(appId) || !privateKey) {
    throw new GitHubApiError('github_not_configured', 'GitHub App не настроена.', 503);
  }
  return { owner, repo, branch, appId, privateKey, prefix };
}

async function readErrorMessage(response) {
  try {
    const data = await response.json();
    if (typeof data.message === 'string') {
      return data.message.replace(/[\r\n]+/g, ' ').slice(0, 180);
    }
  } catch {
    // Upstream body is intentionally ignored.
  }
  return 'GitHub API request failed.';
}

async function githubFetch(path, options, fetchImpl) {
  const response = await fetchImpl(`${API_BASE}${path}`, options);
  if (!response.ok) {
    const upstreamMessage = await readErrorMessage(response);
    throw new GitHubApiError(
      'github_api_error',
      `GitHub API отклонил запрос (${response.status}): ${upstreamMessage}`,
      response.status === 409 || response.status === 422 ? 409 : 502,
    );
  }
  if (response.status === 204) {
    return null;
  }
  return response.json();
}

function appHeaders(jwt) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${jwt}`,
    'Content-Type': 'application/json',
    'User-Agent': 'btm-logo-uploader',
    'X-GitHub-Api-Version': API_VERSION,
  };
}

function installationHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'btm-logo-uploader',
    'X-GitHub-Api-Version': API_VERSION,
  };
}

async function installationToken(configuration, access, fetchImpl) {
  const permissions = access === 'read'
    ? { contents: 'read' }
    : { contents: 'write', pull_requests: 'write' };
  const cacheKey = `${configuration.appId}:${configuration.owner}/${configuration.repo}:${access}`;
  const now = Date.now();
  const cachedToken = cachedTokens.get(cacheKey);
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.token;
  }

  const jwt = await createAppJwt(configuration);
  const installation = await githubFetch(
    `/repos/${encodeURIComponent(configuration.owner)}/${encodeURIComponent(configuration.repo)}/installation`,
    { headers: appHeaders(jwt) },
    fetchImpl,
  );
  const tokenResult = await githubFetch(
    `/app/installations/${installation.id}/access_tokens`,
    {
      method: 'POST',
      headers: appHeaders(jwt),
      body: JSON.stringify({
        repositories: [configuration.repo],
        permissions,
      }),
    },
    fetchImpl,
  );
  const expiresAt = Date.parse(tokenResult.expires_at);
  if (typeof tokenResult.token !== 'string' || !Number.isFinite(expiresAt)) {
    throw new GitHubApiError('github_token_invalid', 'GitHub вернул некорректный installation token.', 502);
  }
  cachedTokens.set(cacheKey, { token: tokenResult.token, expiresAt });
  return tokenResult.token;
}

async function apiRequest(coordinates, token, path, options, fetchImpl) {
  return githubFetch(
    `/repos/${encodeURIComponent(coordinates.owner)}/${encodeURIComponent(coordinates.repo)}${path}`,
    {
      ...options,
      headers: {
        ...installationHeaders(token),
        ...(options?.headers || {}),
      },
    },
    fetchImpl,
  );
}

export async function getRepositorySnapshot(env, fetchImpl = fetch, options = {}) {
  const configuration = repoConfiguration(env, options.prefix || 'GITHUB');
  const coordinates = {
    owner: configuration.owner,
    repo: configuration.repo,
    branch: configuration.branch,
  };
  const access = options.access === 'read' ? 'read' : 'write';
  const catalogPath = String(options.catalogPath || 'catalog.json');
  if (!/^[A-Za-z0-9._/-]+$/.test(catalogPath) || catalogPath.includes('..') || catalogPath.startsWith('/')) {
    throw new GitHubApiError('github_catalog_path_invalid', 'GitHub catalog path некорректен.', 503);
  }
  const token = await installationToken(configuration, access, fetchImpl);
  const ref = await apiRequest(
    coordinates,
    token,
    `/git/ref/heads/${coordinates.branch.split('/').map(encodeURIComponent).join('/')}`,
    {},
    fetchImpl,
  );
  const baseCommitSha = ref?.object?.sha;
  if (typeof baseCommitSha !== 'string') {
    throw new GitHubApiError('github_ref_invalid', 'GitHub не вернул SHA основной ветки.', 502);
  }

  const encodedCatalogPath = catalogPath.split('/').map(encodeURIComponent).join('/');
  const [commit, catalogFile] = await Promise.all([
    apiRequest(coordinates, token, `/git/commits/${baseCommitSha}`, {}, fetchImpl),
    apiRequest(coordinates, token, `/contents/${encodedCatalogPath}?ref=${encodeURIComponent(baseCommitSha)}`, {}, fetchImpl),
  ]);
  if (typeof commit?.tree?.sha !== 'string' || typeof catalogFile?.content !== 'string') {
    throw new GitHubApiError('github_snapshot_invalid', 'Не удалось получить актуальный catalog.json.', 502);
  }

  let catalog;
  try {
    const content = decoder.decode(base64ToBytes(catalogFile.content.replace(/\s+/g, '')));
    catalog = JSON.parse(content);
  } catch {
    throw new GitHubApiError('github_catalog_invalid', 'Актуальный catalog.json содержит некорректный JSON.', 502);
  }

  return {
    coordinates,
    token,
    baseCommitSha,
    baseTreeSha: commit.tree.sha,
    catalogPath,
    catalog,
  };
}

function branchName(prefix = 'uploads') {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(prefix)) {
    throw new GitHubApiError('github_branch_prefix_invalid', 'GitHub branch prefix некорректен.', 500);
  }
  const date = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const suffix = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(6))).toLowerCase();
  return `${prefix}/${date}-${suffix}`;
}

async function createBlob(snapshot, content, encoding, fetchImpl) {
  const result = await apiRequest(
    snapshot.coordinates,
    snapshot.token,
    '/git/blobs',
    {
      method: 'POST',
      body: JSON.stringify({ content, encoding }),
    },
    fetchImpl,
  );
  if (typeof result?.sha !== 'string') {
    throw new GitHubApiError('github_blob_invalid', 'GitHub не вернул SHA файла.', 502);
  }
  return result.sha;
}

export async function createUploadPullRequest(snapshot, catalogText, changes, filesByIndex, fetchImpl = fetch) {
  const treeEntries = [];

  for (const change of changes) {
    if (change.mode === 'delete') {
      if (change.purge_file) {
        treeEntries.push({ path: change.path, mode: '100644', type: 'blob', sha: null });
      }
      continue;
    }
    const file = filesByIndex.get(change.file_index);
    if (!file) {
      throw new GitHubApiError('missing_upload_file', `Не найден файл для ${change.id}.`, 500);
    }
    const imageSha = await createBlob(snapshot, bytesToBase64(file.bytes), 'base64', fetchImpl);
    treeEntries.push({ path: change.path, mode: '100644', type: 'blob', sha: imageSha });
  }

  const catalogSha = await createBlob(snapshot, catalogText, 'utf-8', fetchImpl);
  treeEntries.push({ path: 'catalog.json', mode: '100644', type: 'blob', sha: catalogSha });

  const tree = await apiRequest(
    snapshot.coordinates,
    snapshot.token,
    '/git/trees',
    {
      method: 'POST',
      body: JSON.stringify({ base_tree: snapshot.baseTreeSha, tree: treeEntries }),
    },
    fetchImpl,
  );
  if (typeof tree?.sha !== 'string') {
    throw new GitHubApiError('github_tree_invalid', 'GitHub не вернул SHA дерева.', 502);
  }

  const addCount = changes.filter((change) => change.mode !== 'delete').length;
  const deleteCount = changes.length - addCount;
  const summary = [
    addCount ? `${addCount} logo upload${addCount === 1 ? '' : 's'}` : '',
    deleteCount ? `${deleteCount} removal${deleteCount === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' and ');
  const commit = await apiRequest(
    snapshot.coordinates,
    snapshot.token,
    '/git/commits',
    {
      method: 'POST',
      body: JSON.stringify({
        message: `Prepare ${summary}`,
        tree: tree.sha,
        parents: [snapshot.baseCommitSha],
      }),
    },
    fetchImpl,
  );
  if (typeof commit?.sha !== 'string') {
    throw new GitHubApiError('github_commit_invalid', 'GitHub не вернул SHA commit.', 502);
  }

  const branch = branchName();
  await apiRequest(
    snapshot.coordinates,
    snapshot.token,
    '/git/refs',
    {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
    },
    fetchImpl,
  );

  try {
    const firstBrand = changes[0]?.brand || 'catalog';
    const pullRequest = await apiRequest(
      snapshot.coordinates,
      snapshot.token,
      '/pulls',
      {
        method: 'POST',
        body: JSON.stringify({
          title: `Logo catalog: ${firstBrand}${changes.length > 1 ? ` +${changes.length - 1}` : ''}`,
          head: branch,
          base: snapshot.coordinates.branch,
          body: [
            'Automated BTM logo catalog proposal.',
            '',
            `- Uploads or updates: ${addCount}`,
            `- Catalog removals: ${deleteCount}`,
            '- Direct changes to main: none',
            '',
            'Merge only after the validate-catalog check succeeds and the diff has been reviewed.',
          ].join('\n'),
          draft: false,
        }),
      },
      fetchImpl,
    );
    return {
      number: pullRequest.number,
      url: pullRequest.html_url,
      branch,
      commit: commit.sha,
    };
  } catch (error) {
    try {
      await apiRequest(
        snapshot.coordinates,
        snapshot.token,
        `/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`,
        { method: 'DELETE' },
        fetchImpl,
      );
    } catch {
      // The just-created branch may need manual cleanup if GitHub is partially unavailable.
    }
    throw error;
  }
}

export async function createAffiliateCatalogPullRequest(snapshot, catalogText, changes, fetchImpl = fetch) {
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > 20) {
    throw new GitHubApiError('affiliate_changes_invalid', 'Affiliate catalog change set некорректен.', 500);
  }

  const catalogSha = await createBlob(snapshot, catalogText, 'utf-8', fetchImpl);
  const tree = await apiRequest(
    snapshot.coordinates,
    snapshot.token,
    '/git/trees',
    {
      method: 'POST',
      body: JSON.stringify({
        base_tree: snapshot.baseTreeSha,
        tree: [{
          path: snapshot.catalogPath || 'catalog.json',
          mode: '100644',
          type: 'blob',
          sha: catalogSha,
        }],
      }),
    },
    fetchImpl,
  );
  if (typeof tree?.sha !== 'string') {
    throw new GitHubApiError('github_tree_invalid', 'GitHub не вернул SHA дерева.', 502);
  }

  const counts = changes.reduce((result, change) => {
    if (change.mode === 'new') result.added += 1;
    if (change.mode === 'update') result.updated += 1;
    if (change.mode === 'delete') result.deleted += 1;
    return result;
  }, { added: 0, updated: 0, deleted: 0 });
  const commit = await apiRequest(
    snapshot.coordinates,
    snapshot.token,
    '/git/commits',
    {
      method: 'POST',
      body: JSON.stringify({
        message: `Prepare affiliate catalog update (${changes.length})`,
        tree: tree.sha,
        parents: [snapshot.baseCommitSha],
      }),
    },
    fetchImpl,
  );
  if (typeof commit?.sha !== 'string') {
    throw new GitHubApiError('github_commit_invalid', 'GitHub не вернул SHA commit.', 502);
  }

  const branch = branchName('affiliate-links');
  await apiRequest(
    snapshot.coordinates,
    snapshot.token,
    '/git/refs',
    {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
    },
    fetchImpl,
  );

  try {
    const firstBrand = String(changes[0]?.brand || 'catalog').slice(0, 100);
    const pullRequest = await apiRequest(
      snapshot.coordinates,
      snapshot.token,
      '/pulls',
      {
        method: 'POST',
        body: JSON.stringify({
          title: `Affiliate catalog: ${firstBrand}${changes.length > 1 ? ` +${changes.length - 1}` : ''}`,
          head: branch,
          base: snapshot.coordinates.branch,
          body: [
            'Automated BTM affiliate catalog proposal.',
            '',
            `- Added: ${counts.added}`,
            `- Updated: ${counts.updated}`,
            `- Removed: ${counts.deleted}`,
            '- Direct changes to main: none',
            '',
            'Merge only after catalog validation and manual diff review.',
          ].join('\n'),
          draft: false,
        }),
      },
      fetchImpl,
    );
    return {
      number: pullRequest.number,
      url: pullRequest.html_url,
      branch,
      commit: commit.sha,
    };
  } catch (error) {
    try {
      await apiRequest(
        snapshot.coordinates,
        snapshot.token,
        `/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`,
        { method: 'DELETE' },
        fetchImpl,
      );
    } catch {
      // The just-created branch may need manual cleanup if GitHub is partially unavailable.
    }
    throw error;
  }
}
