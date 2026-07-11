# BTM Library Manager

Публичная GitHub Pages оболочка и защищённый менеджер двух библиотек Brand Tables Manager:

1. публичный read-only каталог логотипов;
2. приватный каталог конечных affiliate URL — одна активная ссылка на бренд для всех сайтов и GEO.

После входа менеджер выбирает модуль на hub-экране. Оба модуля подготавливают изменения только через GitHub Pull Request; прямой записи в `main` нет.

- Manifest: `https://raw.githubusercontent.com/AleksandrDruk/btm-library/main/catalog.json`
- GitHub Pages после включения: `https://aleksandrdruk.github.io/btm-library/`
- Текущий catalog schema: `1`
- В `catalog_version: 2` загружены 13 изображений из наборов `AT LOGO` и `FI IMG`.

Affiliate URL никогда не добавляются в этот публичный репозиторий, `catalog.json`, Pages HTML/JS или plugin ZIP. Worker читает и изменяет их в отдельном private repository через отдельную GitHub App.

WordPress получает каталог только в wp-admin. Выбранный файл скачивается сервером сайта, проходит повторную проверку, попадает в локальную Media Library и хранится в BTM как обычный attachment ID. Публичный frontend сайта не обращается к GitHub или Worker.

Affiliate-каталог также доступен только в wp-admin. WordPress получает его server-to-server по подписанному read-only запросу, а менеджер явно копирует выбранный URL в существующее поле `affiliate_link`. Изменение или удаление центральной записи не переписывает уже сохранённые таблицы на сайтах.

Интерфейс показывает миниатюры всех опубликованных вариантов. Preview URL строится только из проверенного `path` и фиксированного base URL этого репозитория; произвольный внешний URL manifest передать не может.

## Как устроена запись

GitHub Pages не хранит пароль и не может менять репозиторий самостоятельно:

1. Менеджер вводит общий пароль и проходит Cloudflare Turnstile.
2. Cloudflare Worker проверяет пароль и выдаёт подписанную сессию на 30 минут.
3. Сессия хранится только в памяти вкладки; после refresh нужен новый вход.
4. Worker повторно валидирует файлы и актуальный `catalog.json`.
5. GitHub App создаёт отдельную ветку, один атомарный commit и Pull Request.
6. `main` не меняется автоматически. PR объединяет владелец после `validate-catalog` и review.

GitHub App устанавливается только на `AleksandrDruk/btm-library`. Ей нужны только repository permissions `Contents: Read and write` и `Pull requests: Read and write`. Webhooks, OAuth authorization, Administration, Actions и Workflows не нужны.

Для affiliate-каталога используется отдельная GitHub App, установленная только на private repository `btm-affiliate-library`, с теми же двумя repository permissions. Разделение не расширяет доступ logo App к приватным URL.

Affiliate flow:

1. Authenticated Pages UI получает текущий private catalog через Worker и read-only installation token.
2. Add/update/delete повторно валидируются Worker.
3. Worker запрашивает write-scoped installation token, создаёт отдельную `affiliate-links/*` branch, атомарный commit только с `catalog.json` и Pull Request.
4. WordPress-сайты используют отдельный endpoint `/affiliate-catalog/read`; browser session и общий пароль в plugin не передаются.
5. Каждый сайт получает собственные `site_id` и производный HMAC secret. Worker проверяет timestamp, подпись и rate limit, а Durable Object атомарно принимает nonce только один раз; endpoint остаётся read-only.

Минимальная private catalog schema:

```json
{
  "schema_version": 1,
  "catalog_version": 1,
  "items": [
    {
      "id": "vegas-hero",
      "brand": "Vegas Hero",
      "destination_url": "https://tracking.example/click?campaign=example",
      "version": 1,
      "tags": ["vegas hero"]
    }
  ]
}
```

`destination_url` сохраняется без перестройки и сортировки query-параметров. Разрешены только полные HTTP(S) URL без userinfo и неэкранированных пробелов. `id` стабилен, `version` увеличивается при редактировании, а нормализованное имя бренда уникально.

Pretty-printed private `catalog.json` ограничен 900 КиБ: Worker отклонит предложение раньше, чем файл пересечёт 1 МиБ и перестанет читаться через обычный GitHub Contents API response.

## Бренды, варианты и дубли

У одного бренда может быть несколько логотипов. Уникальна нормализованная пара `brand + variant`:

```json
{
  "id": "bet-republic-dark",
  "brand": "Bet Republic",
  "variant": "Dark",
  "path": "logos/bet-republic/bet-republic-dark-v1.webp",
  "suggested_filename": "bet-republic-dark.webp",
  "version": 1,
  "tags": ["bet republic", "dark"]
}
```

- `Primary` и `Dark` для одного бренда — две допустимые позиции.
- Второй `Primary` для того же бренда — дубль и отклоняется до создания PR.
- `id` стабилен при обновлении изображения.
- Новая версия увеличивает `version`, получает новый versioned path, а старый файл остаётся неизменным.
- Никаких хэшей, случайных идентификаторов или доменных префиксов в каталоге нет.
- `suggested_filename` — только предложение. Перед импортом в WordPress менеджер может изменить имя; WordPress штатно добавит `-1`, если локальное имя уже занято.

## Удаление

Интерфейс поддерживает два режима:

1. **Удалить из каталога** — позиция исчезает из `catalog.json`, но versioned-файл остаётся. Это безопасный режим по умолчанию для 12-часового cache и last-known-good копии BTM.
2. **Также удалить текущий файл** — позиция и текущий файл удаляются одним PR после дополнительного подтверждения. Старые Git commits всё равно сохраняют историю.

Удаление из центрального каталога не удаляет attachments, уже импортированные на WordPress-сайты. Оно также не меняет существующие таблицы BTM.

## Ограничения файлов

- JPEG, PNG и WebP.
- До 10 МиБ на файл.
- Сторона до 6000 px.
- До 16 миллионов пикселей.
- До 20 операций и 32 МиБ в одном запросе.
- Запрещены SVG, GIF, AVIF, Git LFS pointers, symlinks, traversal и произвольные URL.
- Браузер декодирует изображение до постановки в очередь; Worker и CI повторно проверяют MIME, размеры и целостность контейнера.
- Опубликованный versioned-файл нельзя перезаписать другими байтами.

## Локальная проверка

Требуется Node.js 20+; npm-зависимостей у проекта нет.

```bash
npm test
npm run check
npm run inspect-images -- /path/to/images
npm run dev
npm run site-credential -- secrets.production.json
```

Локальный UI: `http://127.0.0.1:4173/`.

Тестовый пароль dev-server: `test-only-password-1234567890`. Он работает только в локальном mock-server и не используется Worker.

`site-credential` читает master secret из игнорируемого Git-файла, генерирует непрозрачный случайный `site_id`, выводит только credentials одного сайта и не изменяет Worker или WordPress. Соответствие `site_id` конкретному домену храните в отдельном приватном operational inventory, а не в Git.

## Первичная настройка production

### 1. GitHub Apps

Для логотипов в GitHub откройте `Settings -> Developer settings -> GitHub Apps -> New GitHub App`:

- имя: например `BTM Logo Uploader`;
- homepage URL: `https://aleksandrdruk.github.io/btm-library/`;
- Webhook: выключен;
- Repository permissions:
  - `Contents: Read and write`;
  - `Pull requests: Read and write`;
  - всё остальное: `No access`;
- установка: `Only on this account`.

После создания:

1. Запишите `App ID`.
2. Сгенерируйте private key `.pem`.
3. Установите App через `Install App -> Only select repositories -> btm-library`.
4. Не добавляйте App в bypass list правил ветки `main`.

Создайте вторую App, например `BTM Affiliate Catalog`, с теми же permissions, но установите её **только** на private repository `btm-affiliate-library`. Её `App ID` и `.pem` используются в отдельных `AFFILIATE_GITHUB_*` secrets.

### 2. Cloudflare Turnstile

Создайте Managed widget `BTM Logo Uploader` и разрешите точный hostname:

```text
aleksandrdruk.github.io
```

Сохраните public site key и secret key. Secret никогда не добавляется в Git.

### 3. Секреты Worker

Общий пароль должен быть уникальной случайной строкой минимум из 20 символов. Хэш, session secret и независимый affiliate read master secret генерируются локально:

```bash
npm run password-hash
npm run session-secret
npm run session-secret
```

Первый случайный secret используйте как `SESSION_SECRET`, второй — как `AFFILIATE_READ_MASTER_SECRET`; они не должны совпадать. Генератор пароля использует PBKDF2-SHA-256 с 100 000 итераций — это максимальное значение, которое принимает production runtime Cloudflare Workers. Вход и каталоги дополнительно защищены четырьмя независимыми rate limiter bindings; replay signed read requests блокирует отдельный Durable Object `AFFILIATE_NONCE_STORE`.

Создайте локальный `secrets.production.json`; он игнорируется Git и после деплоя должен быть удалён:

```json
{
  "PASSWORD_HASH": "<redacted>",
  "SESSION_SECRET": "<redacted>",
  "TURNSTILE_SECRET": "<redacted>",
  "GITHUB_APP_ID": "<redacted>",
  "GITHUB_APP_PRIVATE_KEY": "<redacted>",
  "AFFILIATE_GITHUB_APP_ID": "<redacted>",
  "AFFILIATE_GITHUB_APP_PRIVATE_KEY": "<redacted>",
  "AFFILIATE_READ_MASTER_SECRET": "<redacted>"
}
```

Не используйте production-пароль в shell argument, commit, issue или PR.

### 4. Deploy Worker

В проекте проверена закреплённая версия Wrangler `4.106.0`:

```bash
npx --yes wrangler@4.106.0 login
npx --yes wrangler@4.106.0 deploy --secrets-file secrets.production.json
```

`wrangler.jsonc` требует все восемь secrets и не позволит production deploy с неполной конфигурацией. После успеха:

1. Удалите локальный `secrets.production.json`.
2. Откройте `<worker-url>/health`; ожидается `{"ok":true,"ready":true,"logo_ready":true,"affiliate_ready":true,...}`.
3. Укажите Worker URL и Turnstile site key в `config.json`.
4. Проверьте, что CSP `index.html` содержит только точный origin production Worker и не расширен до `https://*.workers.dev`.
5. Повторно выполните `npm test` и `npm run check`, затем push.

### 5. GitHub Pages

После push откройте репозиторий:

`Settings -> Pages -> Build and deployment`

- Source: `Deploy from a branch`;
- Branch: `main`;
- Folder: `/(root)`;
- `Save`.

После публикации откройте `https://aleksandrdruk.github.io/btm-library/`, выполните вход, создайте тестовый PR и убедитесь, что `validate-catalog` завершился успешно.

### 6. Защита main

Создайте GitHub Ruleset или Branch protection для `main`:

- Require a pull request before merging;
- Require status checks to pass;
- required checks: `validate-catalog` и `code-checks`;
- запретить force push и deletion;
- не разрешать GitHub App обходить правило.

Check появится в списке после первого тестового PR.

### 7. Подключение WordPress

После настройки Worker сгенерируйте отдельные read credentials для каждого сайта:

```bash
npm run site-credential -- secrets.production.json
```

Сохраните результат вне Git и добавьте в `wp-config.php` конкретного сайта:

```php
define('BTM_AFFILIATE_CATALOG_SITE_ID', '<opaque site id>');
define('BTM_AFFILIATE_CATALOG_SITE_SECRET', '<derived site secret>');
```

Plugin ZIP не содержит credentials. Master secret остаётся только в Worker; один site secret не позволяет вычислить credentials другого сайта. Если Worker будет перенесён на другой URL, дополнительно задайте `BTM_AFFILIATE_CATALOG_API_URL` с точным HTTPS endpoint `/affiliate-catalog/read`.

BTM кеширует проверенный каталог на 12 часов и хранит last-known-good копию 7 дней для сетевых сбоев. Кнопка refresh обходит свежий кеш; ответ Worker `401/403` не использует stale fallback.

По умолчанию кнопка приватного affiliate-каталога доступна только пользователям с capability `manage_options`, которые одновременно могут редактировать конкретную Brand Table. Для отдельной доверенной manager-роли capability можно явно заменить site-specific кодом через фильтр `btm_affiliate_catalog_required_capability`; plugin роли и права сам не меняет.

## Cloudflare и Keitaro на WordPress-сайтах

- Cloudflare перед WordPress не проксирует исходящий HTTPS-запрос сервера к `raw.githubusercontent.com`.
- BTM использует только authenticated `wp-admin/admin-ajax.php` POST и no-cache headers. Общего доступа к Cloudflare всех сайтов не требуется.
- Если включён `WP_HTTP_BLOCK_EXTERNAL`, добавьте `raw.githubusercontent.com` в `WP_ACCESSIBLE_HOSTS`.
- Для affiliate selector также разрешите hostname Worker из `BTM_AFFILIATE_CATALOG_API_URL`.
- Если Keitaro делит hostname с WordPress, маршруты `/wp-admin/`, `/wp-admin/admin-ajax.php` и `/wp-content/uploads/` должны продолжать попадать в WordPress.
- Блокировка preview браузерным CSP не блокирует server-side импорт в Media Library.

## Rollback

- UI/Worker: вернуть предыдущий Git commit и повторить deploy.
- Компрометация общего пароля: сгенерировать новый `PASSWORD_HASH` и увеличить `SESSION_VERSION`, чтобы погасить существующие сессии.
- Компрометация любого GitHub App key: удалить только соответствующий key в GitHub, создать новый и заменить его Worker secret.
- Компрометация одного site secret: сохранить старый opaque `site_id` в Worker secret `AFFILIATE_SITE_DENYLIST` (не в tracked `wrangler.jsonc`), выдать сайту новый id/secret и проверить deny. Значение denylist не должно публиковать клиентские домены или incident metadata.
- Компрометация `AFFILIATE_READ_MASTER_SECRET`: заменить master, заново выдать credentials всем сайтам и удалить старый secret.
- Ошибочный PR: не merge. После merge — revert commit; уже импортированные WordPress attachments откатываются отдельно.
- Удаление Worker или GitHub Pages не ломает уже сохранённые таблицы, изображения и affiliate URL на WordPress-сайтах; перестают работать только новые выборы из каталогов.
