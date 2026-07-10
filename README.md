# BTM Logo Library

Public read-only source catalog for Brand Tables Manager logo imports.

The WordPress plugin reads `catalog.json` in wp-admin only. A selected file is downloaded server-side, validated, copied into the local WordPress Media Library and stored in BTM as a normal attachment ID. Public pages never load images from this repository.

## Add a logo

1. Add a versioned JPEG, PNG or WebP file below `logos/<brand>/`.
2. Add one item to `catalog.json`.
3. Increment `catalog_version`.
4. Commit and push both changes together.

Example:

```json
{
  "id": "bet365-primary",
  "brand": "Bet365",
  "variant": "Primary",
  "path": "logos/bet365/bet365-primary-v1.webp",
  "suggested_filename": "bet365-primary.webp",
  "version": 1,
  "tags": ["bet365", "primary", "light"]
}
```

## Contract

- `id`: unique stable lowercase ID using letters, numbers, `_` and `-`; maximum 80 characters.
- `brand`: visible brand name.
- `variant`: optional visible variant name such as `Primary`, `Dark` or `Square`.
- `path`: unique relative file path inside `logos/`.
- `suggested_filename`: basename shown to the manager before import. The manager can edit it.
- `version`: positive integer. Increase it when the image changes.
- `tags`: optional search aliases.

Do not overwrite a published image at an existing versioned path. Add a new file, keep the same `id`, increase `version`, update `path`, and increase `catalog_version`.

The catalog does not add prefixes, hashes or generated identifiers to public filenames. WordPress may append `-1`, `-2`, and so on when a local filename already exists.

## Image rules

- JPEG, PNG and WebP only.
- Maximum file size: 10 MiB.
- Maximum side: 6000 pixels.
- Maximum area: 16 million pixels.
- No SVG, GIF, AVIF, symlinks, absolute paths, query strings or Git LFS pointers.
