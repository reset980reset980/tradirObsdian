# Tradir Obsdian

Tradir Obsdian is an Obsidian-native trading news radar.

It collects RSS feeds directly from Obsidian, optionally analyzes articles with the user's own AI API key, and writes Markdown article notes and daily briefings into the vault. It does not depend on the original Trading News Radar server.

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

- **Output folder**: Vault folder for imported notes.
- **RSS sources**: One source per line as `Name|https://example.com/feed.xml`.
- **Default article limit**: Maximum RSS items processed per command run.
- **AI provider**: `None`, `OpenAI`, `Anthropic Claude`, or `Google Gemini`.
- **AI model**: Provider model ID. Defaults are editable.
- **API key**: User-owned key. Leave blank when AI provider is `None`.
- **Briefing language**: Language for AI summaries and classifications.
- **Max output tokens**: Upper bound for one AI batch response.

## Commands

- **Collect latest trading news**
- **Create daily trading news briefing**
- **Test RSS sources**

## Notes

Default mode is RSS-only and uses zero AI tokens.

If AI is enabled but the key is missing or the provider response fails, the plugin falls back to an RSS-only report instead of aborting the briefing.

Briefing notes are formatted as clean Obsidian-native Markdown reports with a summary callout, compact metric tables, category distribution, priority story sections, and a full article table. The plugin adds a scoped `tradir-report` CSS class to generated notes.

When AI is enabled, the plugin calls the selected provider directly from Obsidian using the user's own key. API keys are stored in this vault's plugin data, so users should avoid syncing plugin data to places they do not trust.

This plugin does not ship private keys, hard-coded local paths, or a default public endpoint.
