# Tradir Obsdian

Tradir Obsdian imports trading news, briefings, and project intelligence into an Obsidian vault.

The first adapter targets Trading News Radar. The plugin expects a read-only HTTP API such as:

```text
GET /api/status
GET /api/articles?limit=20
GET /api/briefing/today
```

## Install with BRAT

1. Install the Obsidian42 BRAT plugin.
2. Open BRAT settings.
3. Choose **Add Beta plugin**.
4. Enter:

```text
reset980reset980/tradirObsdian
```

## Development

```bash
npm install
npm run build
```

The build outputs `main.js` in the repository root for BRAT/release packaging.

## Settings

- **Trading News Radar endpoint**: Base URL for the API server, for example `https://tnews.xsw.kr`.
- **API token**: Optional bearer token.
- **Output folder**: Vault folder for imported notes.
- **Default limit**: Number of articles imported by the default sync command.

## Commands

- **Sync latest trading news**
- **Import today's briefing**
- **Test Trading News Radar connection**

## Notes

This plugin does not ship private keys or hard-coded local paths. Users configure their own endpoint in Obsidian.
