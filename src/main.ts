import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  requestUrl,
  Setting,
  TFolder,
  TFile,
  normalizePath,
} from "obsidian";

interface TradirSettings {
  endpoint: string;
  apiToken: string;
  outputFolder: string;
  defaultLimit: number;
}

interface TradingArticle {
  id?: string;
  title?: string;
  title_ko?: string;
  url?: string;
  source_id?: string;
  source?: string;
  category?: string;
  importance?: number;
  sentiment?: string;
  published_at?: string;
  crawled_at?: string;
  summary_text?: string;
  summary_ko?: string;
  tags?: string[];
}

interface BriefingItem {
  headline?: string;
  title?: string;
  why_important?: string;
  summary?: string;
  article_id?: string;
  url?: string;
}

interface TradingBriefing {
  id?: string;
  date?: string;
  summary?: string;
  top_articles?: BriefingItem[];
  created_at?: string;
}

const DEFAULT_SETTINGS: TradirSettings = {
  endpoint: "https://tnews.xsw.kr",
  apiToken: "",
  outputFolder: "Trading News Radar",
  defaultLimit: 10,
};

export default class TradirObsdianPlugin extends Plugin {
  settings: TradirSettings;
  private statusEl: HTMLElement | null = null;

  async onload() {
    await this.loadSettings();

    this.statusEl = this.addStatusBarItem();
    this.setStatus("Ready");

    this.addRibbonIcon("newspaper", "Sync latest trading news", () => {
      void this.syncLatestArticles();
    });

    this.addCommand({
      id: "sync-latest-trading-news",
      name: "Sync latest trading news",
      callback: () => void this.syncLatestArticles(),
    });

    this.addCommand({
      id: "import-today-briefing",
      name: "Import today's briefing",
      callback: () => void this.importTodayBriefing(),
    });

    this.addCommand({
      id: "test-trading-news-connection",
      name: "Test Trading News Radar connection",
      callback: () => void this.testConnection(),
    });

    this.addSettingTab(new TradirSettingTab(this.app, this));
  }

  onunload() {
    this.statusEl = null;
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private setStatus(text: string) {
    if (!this.statusEl) return;
    this.statusEl.setText(`Tradir: ${text}`);
    this.statusEl.addClass("tradir-obsdian-status");
  }

  async testConnection() {
    try {
      this.setStatus("Testing");
      const status = await this.fetchJson<Record<string, unknown>>("/api/status");
      new Notice(`Trading News Radar connected: ${JSON.stringify(status).slice(0, 120)}`);
      this.setStatus("Connected");
    } catch (error) {
      this.handleError("Could not connect to Trading News Radar", error);
    }
  }

  async syncLatestArticles() {
    try {
      this.setStatus("Syncing");
      const articles = await this.fetchArticles(this.settings.defaultLimit);
      if (!articles.length) {
        new Notice("No trading news articles returned.");
        this.setStatus("No articles");
        return;
      }

      await this.ensureFolder(this.settings.outputFolder);
      let count = 0;
      for (const article of articles) {
        await this.writeArticleNote(article);
        count += 1;
      }

      await this.refreshIndex();
      new Notice(`Imported ${count} trading news article${count === 1 ? "" : "s"}.`);
      this.setStatus(`Imported ${count}`);
    } catch (error) {
      this.handleError("Could not sync trading news", error);
    }
  }

  async importTodayBriefing() {
    try {
      this.setStatus("Briefing");
      const briefing = await this.fetchJson<TradingBriefing>("/api/briefing/today");
      await this.ensureFolder(this.settings.outputFolder);
      await this.writeBriefingNote(briefing);
      await this.refreshIndex();
      new Notice("Imported today's trading briefing.");
      this.setStatus("Briefing imported");
    } catch (error) {
      this.handleError("Could not import today's briefing", error);
    }
  }

  private async fetchArticles(limit: number): Promise<TradingArticle[]> {
    const response = await this.fetchJson<unknown>(`/api/articles?limit=${encodeURIComponent(String(limit))}`);
    if (Array.isArray(response)) return response as TradingArticle[];
    if (isObject(response) && Array.isArray(response.articles)) return response.articles as TradingArticle[];
    if (isObject(response) && Array.isArray(response.items)) return response.items as TradingArticle[];
    return [];
  }

  private async fetchJson<T>(path: string): Promise<T> {
    const endpoint = this.settings.endpoint.replace(/\/+$/, "");
    const url = `${endpoint}${path.startsWith("/") ? path : `/${path}`}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
    };

    if (this.settings.apiToken.trim()) {
      headers.Authorization = `Bearer ${this.settings.apiToken.trim()}`;
    }

    const response = await requestUrl({
      url,
      method: "GET",
      headers,
      throw: false,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`HTTP ${response.status} from ${url}`);
    }

    const contentType = response.headers["content-type"] || response.headers["Content-Type"] || "";
    if (!contentType.includes("application/json") && typeof response.json === "undefined") {
      throw new Error(`Expected JSON from ${url}`);
    }

    return response.json as T;
  }

  private async writeArticleNote(article: TradingArticle) {
    const title = article.title_ko || article.title || "Untitled trading news";
    const date = getDatePart(article.published_at || article.crawled_at) || today();
    const id = article.id || hashString(`${title}:${article.url || ""}`);
    const fileName = `${date} ${sanitizeFileName(title).slice(0, 90)}.md`;
    const path = normalizePath(`${this.settings.outputFolder}/Articles/${fileName}`);
    const summary = article.summary_ko || article.summary_text || "";

    await this.ensureFolder(`${this.settings.outputFolder}/Articles`);

    const body = [
      "---",
      `type: "trading-news-article"`,
      `project: "Trading News Radar"`,
      `article_id: "${yamlEscape(id)}"`,
      `category: "${yamlEscape(article.category || "")}"`,
      `importance: ${Number.isFinite(article.importance) ? article.importance : 0}`,
      `sentiment: "${yamlEscape(article.sentiment || "")}"`,
      `published_at: "${yamlEscape(article.published_at || "")}"`,
      `source_id: "${yamlEscape(article.source_id || "")}"`,
      `url: "${yamlEscape(article.url || "")}"`,
      `tags: ${formatTags(["trading-news", article.category, ...(article.tags || [])])}`,
      "---",
      "",
      `# ${title}`,
      "",
      "## Summary",
      "",
      summary || "_No summary provided._",
      "",
      "## Metadata",
      "",
      `- Source: ${article.source || article.source_id || "Unknown"}`,
      `- Category: ${article.category || "Unknown"}`,
      `- Importance: ${article.importance ?? "Unknown"}`,
      `- Sentiment: ${article.sentiment || "Unknown"}`,
      `- Published: ${article.published_at || "Unknown"}`,
      article.url ? `- Original: ${article.url}` : "- Original: Unknown",
      "",
    ].join("\n");

    await this.writeOrReplace(path, body);
  }

  private async writeBriefingNote(briefing: TradingBriefing) {
    const date = briefing.date || getDatePart(briefing.created_at) || today();
    const path = normalizePath(`${this.settings.outputFolder}/Briefings/${date} Trading News Briefing.md`);
    await this.ensureFolder(`${this.settings.outputFolder}/Briefings`);

    const topArticles = Array.isArray(briefing.top_articles) ? briefing.top_articles : [];
    const lines = [
      "---",
      `type: "trading-news-briefing"`,
      `project: "Trading News Radar"`,
      `briefing_id: "${yamlEscape(briefing.id || "")}"`,
      `date: "${yamlEscape(date)}"`,
      `created_at: "${yamlEscape(briefing.created_at || "")}"`,
      `tags: ${formatTags(["trading-news", "briefing"])}`,
      "---",
      "",
      `# Trading News Briefing - ${date}`,
      "",
    ];

    if (briefing.summary) {
      lines.push("> " + briefing.summary, "");
    }

    lines.push("## Top Articles", "");
    if (!topArticles.length) {
      lines.push("_No top articles provided._", "");
    } else {
      topArticles.forEach((item, index) => {
        const headline = item.headline || item.title || "Untitled";
        const detail = item.why_important || item.summary || "";
        lines.push(`### ${index + 1}. ${headline}`, "");
        if (detail) lines.push(detail, "");
        if (item.url) lines.push(`- Original: ${item.url}`);
        if (item.article_id) lines.push(`- Article ID: ${item.article_id}`);
        lines.push("");
      });
    }

    await this.writeOrReplace(path, lines.join("\n"));
  }

  private async refreshIndex() {
    await this.ensureFolder(this.settings.outputFolder);
    const folder = this.app.vault.getAbstractFileByPath(normalizePath(this.settings.outputFolder));
    if (!(folder instanceof TFolder)) return;

    const files = this.app.vault
      .getMarkdownFiles()
      .filter((file) => file.path.startsWith(`${normalizePath(this.settings.outputFolder)}/`))
      .sort((a, b) => b.path.localeCompare(a.path));

    const lines = [
      "# Trading News Radar",
      "",
      `- Updated: ${new Date().toISOString()}`,
      `- Notes: ${files.length}`,
      "",
      "## Latest Notes",
      "",
      ...files.slice(0, 50).map((file) => `- [[${file.basename}]]`),
      "",
    ];

    await this.writeOrReplace(normalizePath(`${this.settings.outputFolder}/INDEX.md`), lines.join("\n"));
  }

  private async ensureFolder(path: string) {
    const normalized = normalizePath(path);
    const parts = normalized.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (!existing) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  private async writeOrReplace(path: string, body: string) {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing) {
      if (existing instanceof TFile && existing.extension === "md") {
        await this.app.vault.modify(existing, body);
        return;
      }
      throw new Error(`Cannot overwrite non-markdown path: ${path}`);
    }
    await this.app.vault.create(path, body);
  }

  private handleError(prefix: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    new Notice(`${prefix}: ${message}`);
    this.setStatus("Error");
    console.error(`[Tradir Obsdian] ${prefix}`, error);
  }
}

class TradirSettingTab extends PluginSettingTab {
  plugin: TradirObsdianPlugin;

  constructor(app: App, plugin: TradirObsdianPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Tradir Obsdian" });
    const intro = containerEl.createDiv({ cls: "tradir-obsdian-card" });
    intro.createEl("h3", { text: "Trading News Radar" });
    intro.createEl("p", {
      text: "Configure a read-only API endpoint, then import articles and briefings into Markdown notes.",
    });

    new Setting(containerEl)
      .setName("Trading News Radar endpoint")
      .setDesc("Base URL for the Trading News Radar API.")
      .addText((text) =>
        text
          .setPlaceholder("https://tnews.xsw.kr")
          .setValue(this.plugin.settings.endpoint)
          .onChange(async (value) => {
            this.plugin.settings.endpoint = value.trim() || DEFAULT_SETTINGS.endpoint;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("API token")
      .setDesc("Optional bearer token. Leave blank for public read-only APIs.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("optional")
          .setValue(this.plugin.settings.apiToken)
          .onChange(async (value) => {
            this.plugin.settings.apiToken = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Output folder")
      .setDesc("Vault folder where imported notes are written.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.outputFolder)
          .setValue(this.plugin.settings.outputFolder)
          .onChange(async (value) => {
            this.plugin.settings.outputFolder = value.trim() || DEFAULT_SETTINGS.outputFolder;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Default article limit")
      .setDesc("Number of articles imported by the default sync command.")
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.defaultLimit))
          .setValue(String(this.plugin.settings.defaultLimit))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            this.plugin.settings.defaultLimit = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SETTINGS.defaultLimit;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Connection")
      .setDesc("Check whether the configured endpoint exposes /api/status.")
      .addButton((button) =>
        button
          .setButtonText("Test")
          .onClick(() => void this.plugin.testConnection()),
      );

    new Setting(containerEl)
      .setName("Import")
      .setDesc("Run the default article import now.")
      .addButton((button) =>
        button
          .setButtonText("Sync latest")
          .setCta()
          .onClick(() => void this.plugin.syncLatestArticles()),
      );
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sanitizeFileName(input: string): string {
  return input
    .replace(/[<>:"/\\|?*\n\r\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "Untitled";
}

function yamlEscape(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function formatTags(tags: Array<string | undefined>): string {
  const clean = Array.from(
    new Set(
      tags
        .filter((tag): tag is string => Boolean(tag && tag.trim()))
        .map((tag) => tag.trim().replace(/\s+/g, "-")),
    ),
  );
  return `[${clean.map((tag) => `"${yamlEscape(tag)}"`).join(", ")}]`;
}

function getDatePart(value?: string): string | null {
  if (!value) return null;
  const match = value.match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function hashString(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return `art_${Math.abs(hash).toString(16)}`;
}
