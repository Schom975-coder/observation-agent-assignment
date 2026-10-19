# Vendored fonts

The dashboard and the report use two typefaces, vendored here so every page loads with the network off. Both come from Fontsource, pinned by package version, and both are licensed under the SIL Open Font License 1.1; each licence file is kept as published.

| File | Package | Source URL | Bytes | sha256 |
|---|---|---|---:|---|
| `archivo-latin-wght-normal.woff2` | `@fontsource-variable/archivo@5.3.0` | https://cdn.jsdelivr.net/npm/@fontsource-variable/archivo@5.3.0/files/archivo-latin-wght-normal.woff2 | 34,928 | `8f704806dbedeaaeca334b11ec348bc3ac3a439d6431544b3afb54f534ee4967` |
| `LICENSE-Archivo.txt` | `@fontsource-variable/archivo@5.3.0` | https://cdn.jsdelivr.net/npm/@fontsource-variable/archivo@5.3.0/LICENSE | 4,503 | `c3c8402eec0e31dc9a76851235b1c02a0bb821488b2db8e35bcc2ab60ca8fc2b` |
| `ibm-plex-mono-latin-400-normal.woff2` | `@fontsource/ibm-plex-mono@5.3.0` | https://cdn.jsdelivr.net/npm/@fontsource/ibm-plex-mono@5.3.0/files/ibm-plex-mono-latin-400-normal.woff2 | 14,708 | `08949f728dc52d528e69b1667d15c89a5686a4ee9a296ff90983985f99c380f7` |
| `ibm-plex-mono-latin-500-normal.woff2` | `@fontsource/ibm-plex-mono@5.3.0` | https://cdn.jsdelivr.net/npm/@fontsource/ibm-plex-mono@5.3.0/files/ibm-plex-mono-latin-500-normal.woff2 | 14,888 | `01d285447409c8a588692162439a038b8cbd7871309ee20267b0d2d91c6e8e22` |
| `LICENSE-IBMPlexMono.txt` | `@fontsource/ibm-plex-mono@5.3.0` | https://cdn.jsdelivr.net/npm/@fontsource/ibm-plex-mono@5.3.0/LICENSE | 5,299 | `23b0a9d0c6d3f140a0b77e483c5cfa6bba574325ef5cb189ed9f2fec4884533f` |

The same bytes are in the npm tarballs `https://registry.npmjs.org/@fontsource-variable/archivo/-/archivo-5.3.0.tgz` and `https://registry.npmjs.org/@fontsource/ibm-plex-mono/-/ibm-plex-mono-5.3.0.tgz`.

- Archivo is the variable weight axis (300 to 800), latin subset. The design also used the width axis, which the CSS does not use, so that file is not vendored.
- IBM Plex Mono is the 400 and 500 weights, latin subset. No italics are vendored: the design uses none.
- `report.html` inlines Archivo and IBM Plex Mono 400 as data URIs, so it opens by double-click with these faces.

To check a file: `sha256sum dashboard/fonts/<file>` (macOS: `shasum -a 256`) and compare with the table.
