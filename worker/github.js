import { base64ToBytes, bytesToBase64, bytesToBase64Url } from '../lib/crypto.js';

const API_BASE = 'https://api.github.com';
const API_VERSION = '2026-03-10';
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REQUIRED_AFFILIATE_CHECKS = ['code-checks', 'validate-catalog'];
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
  let response;
  try {
    response = await fetchImpl(`${API_BASE}${path}`, options);
  } catch {
    throw new GitHubApiError(
      'github_unavailable',
      'GitHub API временно недоступен.',
      502,
    );
  }
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
    : access === 'approval'
      ? { checks: 'read', contents: 'write', pull_requests: 'write' }
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
  const access = ['read', 'approval'].includes(options.access) ? options.access : 'write';
  const catalogPath = String(options.catalogPath || 'catalog.json');
  if (!/^[A-Za-z0-9._/-]+$/.test(catalogPath) || catalogPath.includes('..') || catalogPath.startsWith('/')) {
    throw new GitHubApiError('github_catalog_path_invalid', 'GitHub catalog path некорректен.', 503);
  }
  const token = await installationToken(configuration, access, fetchImpl);
  const requestedRef = options.ref === undefined ? '' : String(options.ref).trim().toLowerCase();
  if (requestedRef && !SHA_PATTERN.test(requestedRef)) {
    throw new GitHubApiError('github_ref_invalid', 'GitHub commit SHA имеет некорректный формат.', 503);
  }
  let baseCommitSha = requestedRef;
  if (!baseCommitSha) {
    const ref = await apiRequest(
      coordinates,
      token,
      `/git/ref/heads/${coordinates.branch.split('/').map(encodeURIComponent).join('/')}`,
      {},
      fetchImpl,
    );
    baseCommitSha = ref?.object?.sha;
    if (typeof baseCommitSha !== 'string') {
      throw new GitHubApiError('github_ref_invalid', 'GitHub не вернул SHA основной ветки.', 502);
    }
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
  let catalogText;
  try {
    catalogText = decoder.decode(base64ToBytes(catalogFile.content.replace(/\s+/g, '')));
    catalog = JSON.parse(catalogText);
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
    catalogText,
  };
}

function affiliateApprovalContext(env) {
  const configuration = repoConfiguration(env, 'AFFILIATE_GITHUB');
  return {
    configuration,
    coordinates: {
      owner: configuration.owner,
      repo: configuration.repo,
      branch: configuration.branch,
    },
  };
}

function validPullNumber(value) {
  return Number.isInteger(value) && value >= 1 && value <= 1_000_000_000;
}

function safePullUrl(coordinates, value, number) {
  const expected = `https://github.com/${coordinates.owner}/${coordinates.repo}/pull/${number}`;
  return value === expected || value === `${expected}/` ? expected : '';
}

function latestById(values) {
  return [...values].sort((left, right) => Number(right?.id || 0) - Number(left?.id || 0))[0] || null;
}

function checkState(checkRuns, name, headSha) {
  const run = latestById(checkRuns.filter((candidate) => (
    candidate?.name === name
    && candidate?.head_sha === headSha
    && candidate?.app?.slug === 'github-actions'
  )));
  if (!run || run.status !== 'completed') return 'pending';
  return run.conclusion === 'success' ? 'success' : 'failed';
}

function gateResult(pull, coordinates, approvedSha, details) {
  const number = Number(pull?.number);
  const title = typeof pull?.title === 'string' ? pull.title.slice(0, 180) : `Affiliate catalog PR #${number}`;
  const url = safePullUrl(coordinates, pull?.html_url, number);
  const headSha = String(pull?.head?.sha || '').toLowerCase();
  const checks = Object.fromEntries(
    REQUIRED_AFFILIATE_CHECKS.map((name) => [name, checkState(details.checkRuns, name, headSha)]),
  );
  const latestReview = latestById(details.reviews.filter((review) => (
    review?.user?.login === details.approverLogin
  )));
  const approved = latestReview?.state === 'APPROVED' && latestReview?.commit_id === headSha;

  let code = 'ready';
  let message = 'Проверки пройдены, владелец подтвердил точный commit.';
  if (
    !validPullNumber(number)
    || !url
    || pull?.state !== 'open'
    || pull?.draft === true
    || pull?.base?.ref !== coordinates.branch
    || pull?.base?.repo?.full_name !== `${coordinates.owner}/${coordinates.repo}`
    || pull?.head?.repo?.full_name !== `${coordinates.owner}/${coordinates.repo}`
    || !String(pull?.head?.ref || '').startsWith('affiliate-links/')
    || !SHA_PATTERN.test(headSha)
    || pull?.commits !== 1
  ) {
    code = 'proposal_boundary_invalid';
    message = 'PR не соответствует защищённому affiliate proposal contract.';
  } else if (details.mainSha !== approvedSha) {
    code = 'main_not_approved';
    message = 'main содержит неподтверждённое изменение. Публикация остановлена.';
  } else if (
    details.commit?.parents?.length !== 1
    || details.commit.parents[0]?.sha !== approvedSha
  ) {
    code = 'proposal_stale';
    message = 'PR создан не от текущего опубликованного commit.';
  } else if (
    pull?.changed_files !== 1
    || details.files.length !== 1
    || details.files[0]?.filename !== 'catalog.json'
    || details.files[0]?.status !== 'modified'
  ) {
    code = 'proposal_scope_invalid';
    message = 'PR изменяет что-то кроме catalog.json.';
  } else if (Object.values(checks).some((value) => value === 'failed')) {
    code = 'checks_failed';
    message = 'Одна из обязательных проверок завершилась ошибкой.';
  } else if (Object.values(checks).some((value) => value !== 'success')) {
    code = 'checks_pending';
    message = 'Ожидаются validate-catalog и code-checks.';
  } else if (!approved) {
    code = 'review_required';
    message = `Нужен APPROVED review от ${details.approverLogin} для текущего commit.`;
  }

  return {
    number,
    title,
    url,
    head_sha: headSha,
    checks,
    approved,
    publishable: code === 'ready',
    code,
    message,
    created_at: typeof pull?.created_at === 'string' ? pull.created_at : '',
  };
}

async function affiliateGateDetails(context, token, pull, approvedSha, approverLogin, fetchImpl) {
  const coordinates = context.coordinates;
  const number = Number(pull?.number);
  if (!validPullNumber(number)) {
    throw new GitHubApiError('github_pull_invalid', 'GitHub PR имеет некорректный номер.', 502);
  }
  const headSha = String(pull?.head?.sha || '').toLowerCase();
  if (!SHA_PATTERN.test(headSha)) {
    return gateResult(pull, coordinates, approvedSha, {
      approverLogin,
      checkRuns: [],
      commit: null,
      files: [],
      mainSha: '',
      reviews: [],
    });
  }

  const [files, reviews, checkRunsResult, commit, mainRef] = await Promise.all([
    apiRequest(coordinates, token, `/pulls/${number}/files?per_page=100`, {}, fetchImpl),
    apiRequest(coordinates, token, `/pulls/${number}/reviews?per_page=100`, {}, fetchImpl),
    apiRequest(coordinates, token, `/commits/${headSha}/check-runs?per_page=100`, {}, fetchImpl),
    apiRequest(coordinates, token, `/git/commits/${headSha}`, {}, fetchImpl),
    apiRequest(
      coordinates,
      token,
      `/git/ref/heads/${coordinates.branch.split('/').map(encodeURIComponent).join('/')}`,
      {},
      fetchImpl,
    ),
  ]);

  return gateResult(pull, coordinates, approvedSha, {
    approverLogin,
    checkRuns: Array.isArray(checkRunsResult?.check_runs) ? checkRunsResult.check_runs : [],
    commit,
    files: Array.isArray(files) ? files : [],
    mainSha: String(mainRef?.object?.sha || '').toLowerCase(),
    reviews: Array.isArray(reviews) ? reviews : [],
  });
}

export async function listAffiliateCatalogProposals(env, approvedSha, approverLogin, fetchImpl = fetch) {
  if (!SHA_PATTERN.test(approvedSha) || !/^[A-Za-z0-9-]{1,39}$/.test(approverLogin)) {
    throw new GitHubApiError('github_approval_config_invalid', 'Affiliate approval config некорректен.', 503);
  }
  const context = affiliateApprovalContext(env);
  const token = await installationToken(context.configuration, 'approval', fetchImpl);
  const pulls = await apiRequest(
    context.coordinates,
    token,
    `/pulls?state=open&base=${encodeURIComponent(context.coordinates.branch)}&sort=created&direction=desc&per_page=10`,
    {},
    fetchImpl,
  );
  const candidates = (Array.isArray(pulls) ? pulls : [])
    .filter((pull) => String(pull?.head?.ref || '').startsWith('affiliate-links/'));
  return Promise.all(
    candidates.map(async (summary) => {
      const pull = await apiRequest(context.coordinates, token, `/pulls/${summary.number}`, {}, fetchImpl);
      return affiliateGateDetails(context, token, pull, approvedSha, approverLogin, fetchImpl);
    }),
  );
}

export async function getAffiliateCatalogProposal(env, number, approvedSha, approverLogin, fetchImpl = fetch) {
  if (!validPullNumber(number) || !SHA_PATTERN.test(approvedSha) || !/^[A-Za-z0-9-]{1,39}$/.test(approverLogin)) {
    throw new GitHubApiError('github_approval_config_invalid', 'Affiliate approval request некорректен.', 503);
  }
  const context = affiliateApprovalContext(env);
  const token = await installationToken(context.configuration, 'approval', fetchImpl);
  const pull = await apiRequest(context.coordinates, token, `/pulls/${number}`, {}, fetchImpl);
  const gate = await affiliateGateDetails(context, token, pull, approvedSha, approverLogin, fetchImpl);
  return { approvedSha, context, token, pull, gate };
}

export async function mergeAffiliateCatalogProposal(approval, fetchImpl = fetch) {
  if (!approval?.gate?.publishable || !SHA_PATTERN.test(approval.gate.head_sha)) {
    throw new GitHubApiError('github_approval_not_ready', 'Affiliate PR ещё не готов к публикации.', 409);
  }
  const result = await apiRequest(
    approval.context.coordinates,
    approval.token,
    `/pulls/${approval.gate.number}/merge`,
    {
      method: 'PUT',
      body: JSON.stringify({
        sha: approval.gate.head_sha,
        merge_method: 'squash',
        commit_title: `Publish affiliate catalog PR #${approval.gate.number}`,
        commit_message: 'Validated by BTM approval gate.',
      }),
    },
    fetchImpl,
  );
  const mergedSha = String(result?.sha || '').toLowerCase();
  if (result?.merged !== true || !SHA_PATTERN.test(mergedSha)) {
    throw new GitHubApiError('github_merge_failed', 'GitHub не подтвердил публикацию affiliate PR.', 409);
  }
  const [candidateCommit, mergedCommit] = await Promise.all([
    apiRequest(
      approval.context.coordinates,
      approval.token,
      `/git/commits/${approval.gate.head_sha}`,
      {},
      fetchImpl,
    ),
    apiRequest(
      approval.context.coordinates,
      approval.token,
      `/git/commits/${mergedSha}`,
      {},
      fetchImpl,
    ),
  ]);
  if (
    mergedCommit?.parents?.length !== 1
    || mergedCommit.parents[0]?.sha !== approval.approvedSha
    || typeof mergedCommit?.tree?.sha !== 'string'
    || mergedCommit.tree.sha !== candidateCommit?.tree?.sha
  ) {
    throw new GitHubApiError(
      'github_merge_verification_failed',
      'main изменился во время публикации. Новый commit не одобрен и не будет показан сайтам.',
      409,
    );
  }
  return { sha: mergedSha };
}

export async function deleteAffiliateCatalogProposalBranch(approval, fetchImpl = fetch) {
  const branch = String(approval?.pull?.head?.ref || '');
  if (!branch.startsWith('affiliate-links/')) return false;
  await apiRequest(
    approval.context.coordinates,
    approval.token,
    `/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`,
    { method: 'DELETE' },
    fetchImpl,
  );
  return true;
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
