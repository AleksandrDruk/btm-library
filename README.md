# BTM Logo Library

Публичный read-only каталог логотипов для Brand Tables Manager и отдельный защищённый интерфейс для подготовки изменений через GitHub Pull Request.

- Manifest: `https://raw.githubusercontent.com/AleksandrDruk/btm-library/main/catalog.json`
- GitHub Pages после включения: `https://aleksandrdruk.github.io/btm-library/`
- Текущий catalog schema: `1`
- В `catalog_version: 2` загружены 13 изображений из наборов `AT LOGO` и `FI IMG`.

WordPress получает каталог только в wp-admin. Выбранный файл скачивается сервером сайта, проходит повторную проверку, попадает в локальную Media Library и хранится в BTM как обычный attachment ID. Публичный frontend сайта не обращается к GitHub или Worker.

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
```

Локальный UI: `http://127.0.0.1:4173/`.

Тестовый пароль dev-server: `test-only-password-1234567890`. Он работает только в локальном mock-server и не используется Worker.

## Первичная настройка production

### 1. GitHub App

В GitHub откройте `Settings -> Developer settings -> GitHub Apps -> New GitHub App`:

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

### 2. Cloudflare Turnstile

Создайте Managed widget `BTM Logo Uploader` и разрешите точный hostname:

```text
aleksandrdruk.github.io
```

Сохраните public site key и secret key. Secret никогда не добавляется в Git.

### 3. Секреты Worker

Общий пароль должен быть минимум 20 символов. Хэш и session secret генерируются локально:

```bash
npm run password-hash
npm run session-secret
```

Создайте локальный `secrets.production.json`; он игнорируется Git и после деплоя должен быть удалён:

```json
{
  "PASSWORD_HASH": "pbkdf2-sha256$...",
  "SESSION_SECRET": "...",
  "TURNSTILE_SECRET": "...",
  "GITHUB_APP_ID": "...",
  "GITHUB_APP_PRIVATE_KEY": "<paste the complete downloaded PEM value here>"
}
```

Не используйте production-пароль в shell argument, commit, issue или PR.

### 4. Deploy Worker

В проекте проверена закреплённая версия Wrangler `4.106.0`:

```bash
npx --yes wrangler@4.106.0 login
npx --yes wrangler@4.106.0 deploy --secrets-file secrets.production.json
```

`wrangler.jsonc` требует все пять secrets и не позволит production deploy с неполной конфигурацией. После успеха:

1. Удалите локальный `secrets.production.json`.
2. Откройте `<worker-url>/health`; ожидается `{"ok":true,"ready":true,...}`.
3. Укажите Worker URL и Turnstile site key в `config.json`.
4. В CSP `index.html` замените wildcard `https://*.workers.dev` на точный origin Worker.
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
- required check: `validate-catalog`;
- запретить force push и deletion;
- не разрешать GitHub App обходить правило.

Check появится в списке после первого тестового PR.

## Cloudflare и Keitaro на WordPress-сайтах

- Cloudflare перед WordPress не проксирует исходящий HTTPS-запрос сервера к `raw.githubusercontent.com`.
- BTM использует только authenticated `wp-admin/admin-ajax.php` POST и no-cache headers. Общего доступа к Cloudflare всех сайтов не требуется.
- Если включён `WP_HTTP_BLOCK_EXTERNAL`, добавьте `raw.githubusercontent.com` в `WP_ACCESSIBLE_HOSTS`.
- Если Keitaro делит hostname с WordPress, маршруты `/wp-admin/`, `/wp-admin/admin-ajax.php` и `/wp-content/uploads/` должны продолжать попадать в WordPress.
- Блокировка preview браузерным CSP не блокирует server-side импорт в Media Library.

## Rollback

- UI/Worker: вернуть предыдущий Git commit и повторить deploy.
- Компрометация общего пароля: сгенерировать новый `PASSWORD_HASH` и увеличить `SESSION_VERSION`, чтобы погасить существующие сессии.
- Компрометация GitHub App key: удалить key в GitHub, создать новый и заменить Worker secret.
- Ошибочный PR: не merge. После merge — revert commit; уже импортированные WordPress attachments откатываются отдельно.
- Удаление Worker или GitHub Pages не ломает уже сохранённые таблицы и изображения на WordPress-сайтах.
