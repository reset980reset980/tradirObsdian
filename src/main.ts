import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  requestUrl,
  Setting,
  TFile,
  TFolder,
  normalizePath,
} from "obsidian";

type AiProvider = "none" | "openai" | "anthropic" | "gemini";
type Sentiment = "positive" | "neutral" | "negative";

interface TradirSettings {
  outputFolder: string;
  sourceText: string;
  defaultLimit: number;
  aiProvider: AiProvider;
  aiModel: string;
  apiKey: string;
  maxOutputTokens: number;
  language: string;
}

interface FeedSource {
  name: string;
  url: string;
}

interface FeedItem {
  id: string;
  source: string;
  title: string;
  url: string;
  description: string;
  publishedAt: string;
}

interface AnalyzedArticle extends FeedItem {
  summary: string;
  category: string;
  importance: number;
  sentiment: Sentiment;
  tags: string[];
}

interface AiArticleResult {
  url?: string;
  title?: string;
  summary?: string;
  category?: string;
  importance?: number;
  sentiment?: Sentiment;
  tags?: string[];
}

const DEFAULT_SOURCES = [
  "CoinDesk|https://www.coindesk.com/arc/outboundfeeds/rss",
  "Cointelegraph|https://cointelegraph.com/rss",
  "MarketWatch|https://feeds.marketwatch.com/marketwatch/topstories/",
  "Investing.com Economy|https://www.investing.com/rss/news_25.rss",
].join("\n");

const DEFAULT_SETTINGS: TradirSettings = {
  outputFolder: "Trading News Radar",
  sourceText: DEFAULT_SOURCES,
  defaultLimit: 10,
  aiProvider: "none",
  aiModel: "",
  apiKey: "",
  maxOutputTokens: 1800,
  language: "Korean",
};

const PROVIDER_DEFAULT_MODELS: Record<AiProvider, string> = {
  none: "",
  openai: "gpt-5",
  anthropic: "claude-sonnet-4-20250514",
  gemini: "gemini-2.5-flash",
};

export default class TradirObsdianPlugin extends Plugin {
  settings: TradirSettings;
  private statusEl: HTMLElement | null = null;

  async onload() {
    await this.loadSettings();
    this.statusEl = this.addStatusBarItem();
    this.setStatus("Ready");

    this.addRibbonIcon("newspaper", "Collect trading news", () => {
      void this.collectLatestNews();
    });

    this.addCommand({
      id: "collect-latest-news",
      name: "Collect latest trading news",
      callback: () => void this.collectLatestNews(),
    });

    this.addCommand({
      id: "create-daily-briefing",
      name: "Create daily trading news briefing",
      callback: () => void this.createDailyBriefing(),
    });

    this.addCommand({
      id: "test-rss-sources",
      name: "Test RSS sources",
      callback: () => void this.testSources(),
    });

    this.addSettingTab(new TradirSettingTab(this.app, this));
  }

  onunload() {
    this.statusEl = null;
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (this.settings.sourceText.includes("https://finance.yahoo.com/news/rssindex")) {
      this.settings.sourceText = this.settings.sourceText.replace(
        /Yahoo Finance\|https:\/\/finance\.yahoo\.com\/news\/rssindex/g,
        "MarketWatch|https://feeds.marketwatch.com/marketwatch/topstories/",
      );
      await this.saveSettings();
    }
    if (!this.settings.aiModel) {
      this.settings.aiModel = PROVIDER_DEFAULT_MODELS[this.settings.aiProvider] || "";
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async testSources() {
    try {
      this.setStatus("Testing RSS");
      const sources = parseSources(this.settings.sourceText);
      if (!sources.length) {
        throw new Error("Add at least one RSS source in settings.");
      }

      const first = sources[0];
      const items = await this.fetchSource(first);
      new Notice(`${first.name}: ${items.length} item${items.length === 1 ? "" : "s"} found.`);
      this.setStatus("RSS OK");
    } catch (error) {
      this.handleError("RSS test failed", error);
    }
  }

  async collectLatestNews() {
    try {
      this.setStatus("Collecting");
      const items = await this.collectFeedItems();
      if (!items.length) {
        new Notice("No RSS items found.");
        this.setStatus("No news");
        return;
      }

      const analyzed = await this.analyzeItems(items);
      await this.ensureFolder(`${this.settings.outputFolder}/Articles`);

      let count = 0;
      for (const article of analyzed) {
        await this.writeArticleNote(article);
        count += 1;
      }

      await this.refreshIndex();
      new Notice(`Imported ${count} trading news note${count === 1 ? "" : "s"}.`);
      this.setStatus(`Imported ${count}`);
    } catch (error) {
      this.handleError("Could not collect trading news", error);
    }
  }

  async createDailyBriefing() {
    try {
      this.setStatus("Briefing");
      const items = await this.collectFeedItems();
      if (!items.length) {
        new Notice("No RSS items found for briefing.");
        this.setStatus("No news");
        return;
      }

      const analyzed = await this.analyzeItems(items);
      await this.ensureFolder(`${this.settings.outputFolder}/Briefings`);
      await this.writeBriefingNote(analyzed);
      await this.refreshIndex();
      new Notice("Created trading news briefing.");
      this.setStatus("Briefing done");
    } catch (error) {
      this.handleError("Could not create briefing", error);
    }
  }

  private async collectFeedItems(): Promise<FeedItem[]> {
    const sources = parseSources(this.settings.sourceText);
    if (!sources.length) {
      throw new Error("Add at least one RSS source in settings.");
    }

    const collected: FeedItem[] = [];
    for (const source of sources) {
      try {
        const items = await this.fetchSource(source);
        collected.push(...items);
      } catch (error) {
        console.warn(`[Tradir Obsdian] Failed RSS source ${source.name}`, error);
      }
    }

    return dedupeByUrl(collected)
      .sort((a, b) => timestamp(b.publishedAt) - timestamp(a.publishedAt))
      .slice(0, Math.max(1, this.settings.defaultLimit));
  }

  private async fetchSource(source: FeedSource): Promise<FeedItem[]> {
    const response = await requestUrl({
      url: source.url,
      method: "GET",
      headers: {
        Accept: "application/rss+xml, application/xml, text/xml, */*",
      },
      throw: false,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`HTTP ${response.status} from ${source.url}`);
    }

    return parseFeed(response.text, source);
  }

  private async analyzeItems(items: FeedItem[]): Promise<AnalyzedArticle[]> {
    const baseline = items.map((item) => fallbackAnalysis(item));
    if (this.settings.aiProvider === "none") {
      return baseline;
    }

    if (!this.settings.apiKey.trim()) {
      new Notice("AI key is empty. Creating an RSS-only briefing without using tokens.");
      return baseline;
    }

    let parsed: AiArticleResult[] = [];
    try {
      const prompt = buildAnalysisPrompt(items, this.settings.language);
      const rawText = await this.callAi(prompt);
      parsed = parseAiResults(rawText);
      if (!parsed.length) {
        throw new Error("AI response did not contain a JSON array.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`AI analysis failed. Creating RSS-only briefing: ${message}`);
      console.warn("[Tradir Obsdian] AI analysis failed, falling back to RSS-only", error);
      return baseline;
    }

    const byUrl = new Map(parsed.map((item) => [item.url || "", item]));
    return baseline.map((article) => {
      const ai = byUrl.get(article.url) || parsed.find((candidate) => candidate.title === article.title);
      if (!ai) return article;

      return {
        ...article,
        title: cleanText(ai.title || article.title),
        summary: cleanText(ai.summary || article.summary),
        category: cleanText(ai.category || article.category),
        importance: clampImportance(ai.importance),
        sentiment: normalizeSentiment(ai.sentiment),
        tags: Array.isArray(ai.tags) ? ai.tags.map(cleanText).filter(Boolean).slice(0, 8) : article.tags,
      };
    });
  }

  private async callAi(prompt: string): Promise<string> {
    const provider = this.settings.aiProvider;
    const model = this.settings.aiModel || PROVIDER_DEFAULT_MODELS[provider];

    if (provider === "openai") {
      return this.callOpenAI(model, prompt);
    }
    if (provider === "anthropic") {
      return this.callAnthropic(model, prompt);
    }
    if (provider === "gemini") {
      return this.callGemini(model, prompt);
    }
    throw new Error(`Unsupported AI provider: ${provider}`);
  }

  private async callOpenAI(model: string, prompt: string): Promise<string> {
    const response = await requestUrl({
      url: "https://api.openai.com/v1/responses",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.settings.apiKey.trim()}`,
      },
      body: JSON.stringify({
        model,
        input: prompt,
        max_output_tokens: this.settings.maxOutputTokens,
      }),
      throw: false,
    });

    assertOk(response.status, "OpenAI");
    const json = response.json as Record<string, unknown>;
    return extractOpenAIText(json);
  }

  private async callAnthropic(model: string, prompt: string): Promise<string> {
    const response = await requestUrl({
      url: "https://api.anthropic.com/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.settings.apiKey.trim(),
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: this.settings.maxOutputTokens,
        messages: [{ role: "user", content: prompt }],
      }),
      throw: false,
    });

    assertOk(response.status, "Anthropic");
    const json = response.json as Record<string, unknown>;
    return extractAnthropicText(json);
  }

  private async callGemini(model: string, prompt: string): Promise<string> {
    const safeModel = model.startsWith("models/") ? model : `models/${model}`;
    const response = await requestUrl({
      url: `https://generativelanguage.googleapis.com/v1beta/${safeModel}:generateContent?key=${encodeURIComponent(this.settings.apiKey.trim())}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          maxOutputTokens: this.settings.maxOutputTokens,
        },
      }),
      throw: false,
    });

    assertOk(response.status, "Gemini");
    const json = response.json as Record<string, unknown>;
    return extractGeminiText(json);
  }

  private async writeArticleNote(article: AnalyzedArticle) {
    const date = getDatePart(article.publishedAt) || today();
    const fileName = `${date} ${sanitizeFileName(article.title).slice(0, 90)}.md`;
    const path = normalizePath(`${this.settings.outputFolder}/Articles/${fileName}`);
    const body = [
      "---",
      `title: "${yamlEscape(article.title)}"`,
      `type: "trading-news-article"`,
      `project: "Tradir Obsdian"`,
      `source: "${yamlEscape(article.source)}"`,
      `category: "${yamlEscape(article.category)}"`,
      `importance: ${article.importance}`,
      `sentiment: "${article.sentiment}"`,
      `published_at: "${yamlEscape(article.publishedAt)}"`,
      `url: "${yamlEscape(article.url)}"`,
      `tags: ${formatTags(["trading-news", article.category, ...article.tags])}`,
      `cssclasses: ["tradir-report"]`,
      "---",
      "",
      `# ${sentimentIcon(article.sentiment)} ${article.title}`,
      "",
      "> [!abstract] 핵심 요약",
      `> ${article.summary || "요약이 없습니다."}`,
      "",
      "## 기사 상태",
      "",
      "| 항목 | 값 |",
      "|---|---:|",
      `| 출처 | ${tableCell(article.source)} |`,
      `| 분류 | ${tableCell(categoryLabel(article.category))} |`,
      `| 중요도 | ${tableCell(importanceStars(article.importance))} |`,
      `| 감성 | ${tableCell(sentimentLabel(article.sentiment))} |`,
      `| 발행 | ${tableCell(article.publishedAt || "Unknown")} |`,
      "",
      "## 원문",
      "",
      article.url ? `[${article.url}](${article.url})` : "_원문 링크가 없습니다._",
      "",
      "## RSS 발췌",
      "",
      article.description || "_RSS 발췌가 없습니다._",
      "",
      article.tags.length ? `태그: ${article.tags.map((tag) => `#${tag.replace(/\s+/g, "-")}`).join(" ")}` : "",
      "",
    ].join("\n");

    await this.writeOrReplace(path, body);
  }

  private async writeBriefingNote(articles: AnalyzedArticle[]) {
    const date = today();
    const path = normalizePath(`${this.settings.outputFolder}/Briefings/${date} Trading News Briefing.md`);
    const sorted = [...articles].sort((a, b) => b.importance - a.importance);
    const highImpact = sorted.filter((article) => article.importance >= 4);
    const sourceCount = new Set(sorted.map((article) => article.source)).size;
    const negativeCount = sorted.filter((article) => article.sentiment === "negative").length;
    const positiveCount = sorted.filter((article) => article.sentiment === "positive").length;
    const lines = [
      "---",
      `title: "Trading News Briefing - ${date}"`,
      `type: "trading-news-briefing"`,
      `project: "Tradir Obsdian"`,
      `date: "${date}"`,
      `ai_provider: "${this.settings.aiProvider}"`,
      `ai_model: "${yamlEscape(this.settings.aiModel || PROVIDER_DEFAULT_MODELS[this.settings.aiProvider])}"`,
      `tags: ${formatTags(["trading-news", "briefing"])}`,
      `cssclasses: ["tradir-report"]`,
      "---",
      "",
      `# 📡 Trading News Briefing`,
      "",
      `## ${date} 시장 뉴스 레이더`,
      "",
      "> [!summary] 오늘의 흐름",
      `> ${briefingLead(sorted)}`,
      ">",
      `> 수집 기사 ${articles.length}개, 출처 ${sourceCount}개, 고중요도 ${highImpact.length}개를 기준으로 정리했습니다.`,
      "",
      "## 📊 브리핑 지표",
      "",
      "| 지표 | 값 |",
      "|---|---:|",
      `| 수집 기사 | ${articles.length} |`,
      `| 뉴스 출처 | ${sourceCount} |`,
      `| 고중요도 | ${highImpact.length} |`,
      `| 긍정 | ${positiveCount} |`,
      `| 부정 | ${negativeCount} |`,
      `| AI 분석 | ${this.settings.aiProvider === "none" ? "꺼짐 (토큰 0)" : `${this.settings.aiProvider} / ${this.settings.aiModel || PROVIDER_DEFAULT_MODELS[this.settings.aiProvider]}`} |`,
      "",
      "## 🧭 카테고리 분포",
      "",
      "| 카테고리 | 기사 | 평균 중요도 |",
      "|---|---:|---:|",
      ...categoryRows(sorted),
      "",
      "## ⚠️ 우선 확인 뉴스",
      "",
    ];

    sorted.slice(0, 5).forEach((article, index) => {
      lines.push(
        `### ${index + 1}. ${sentimentIcon(article.sentiment)} ${article.title}`,
        "",
        `> [!${calloutType(article)}] ${categoryLabel(article.category)} · ${importanceStars(article.importance)} · ${sentimentLabel(article.sentiment)}`,
        `> ${article.summary || article.description || "요약이 없습니다."}`,
        ">",
        `> 출처: ${article.source}  `,
        `> 원문: ${article.url ? `[열기](${article.url})` : "없음"}`,
        "",
      );
    });

    if (sorted.length > 5) {
      lines.push("## 🗞️ 전체 뉴스 목록", "");
      lines.push("| 중요도 | 감성 | 카테고리 | 제목 | 출처 |");
      lines.push("|---:|---|---|---|---|");
      sorted.forEach((article) => {
        lines.push(
          `| ${article.importance} | ${sentimentIcon(article.sentiment)} | ${tableCell(categoryLabel(article.category))} | ${article.url ? `[${tableCell(article.title)}](${article.url})` : tableCell(article.title)} | ${tableCell(article.source)} |`,
        );
      });
      lines.push("");
    }

    lines.push(
      "## 설정",
      "",
      "| 항목 | 값 |",
      "|---|---|",
      `| RSS 처리 한도 | ${this.settings.defaultLimit} |`,
      `| AI Provider | ${this.settings.aiProvider} |`,
      `| Model | ${this.settings.aiModel || PROVIDER_DEFAULT_MODELS[this.settings.aiProvider] || "N/A"} |`,
      `| Output tokens | ${this.settings.maxOutputTokens} |`,
      "",
    );

    await this.writeOrReplace(path, lines.join("\n"));
  }

  private async refreshIndex() {
    await this.ensureFolder(this.settings.outputFolder);
    const folder = this.app.vault.getAbstractFileByPath(normalizePath(this.settings.outputFolder));
    if (!(folder instanceof TFolder)) return;

    const files = this.app.vault
      .getMarkdownFiles()
      .filter((file) => file.path.startsWith(`${normalizePath(this.settings.outputFolder)}/`))
      .filter((file) => file.basename !== "INDEX")
      .sort((a, b) => b.path.localeCompare(a.path));

    const lines = [
      "# Tradir Obsdian",
      "",
      `- Updated: ${new Date().toISOString()}`,
      `- Notes: ${files.length}`,
      `- AI provider: ${this.settings.aiProvider}`,
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

  private setStatus(text: string) {
    if (!this.statusEl) return;
    this.statusEl.setText(`Tradir: ${text}`);
    this.statusEl.addClass("tradir-obsdian-status");
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
    intro.createEl("h3", { text: "Obsidian-native trading news radar" });
    intro.createEl("p", {
      text: "Collect RSS feeds, optionally analyze them with your own AI key, and write Markdown notes into your vault.",
    });

    new Setting(containerEl)
      .setName("Output folder")
      .setDesc("Vault folder where article notes, briefings, and INDEX.md are written.")
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
      .setName("RSS sources")
      .setDesc("One source per line. Use Name|URL or a plain RSS URL.")
      .addTextArea((text) => {
        text.inputEl.rows = 8;
        text.inputEl.addClass("tradir-obsdian-sources");
        text
          .setPlaceholder(DEFAULT_SOURCES)
          .setValue(this.plugin.settings.sourceText)
          .onChange(async (value) => {
            this.plugin.settings.sourceText = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Default article limit")
      .setDesc("Maximum RSS items processed per command run.")
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
      .setName("AI provider")
      .setDesc("None uses zero AI tokens. Other providers use the API key stored in this vault's plugin data.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("none", "None - RSS only")
          .addOption("openai", "OpenAI")
          .addOption("anthropic", "Anthropic Claude")
          .addOption("gemini", "Google Gemini")
          .setValue(this.plugin.settings.aiProvider)
          .onChange(async (value: AiProvider) => {
            this.plugin.settings.aiProvider = value;
            this.plugin.settings.aiModel = PROVIDER_DEFAULT_MODELS[value];
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName("AI model")
      .setDesc("Provider model ID. You can replace the preset with any model your account supports.")
      .addText((text) =>
        text
          .setPlaceholder(PROVIDER_DEFAULT_MODELS[this.plugin.settings.aiProvider])
          .setValue(this.plugin.settings.aiModel)
          .onChange(async (value) => {
            this.plugin.settings.aiModel = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("API key")
      .setDesc("Your own key. Leave blank when AI provider is None.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Stored in this vault's plugin data")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Briefing language")
      .setDesc("Language used when AI analysis is enabled.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.language)
          .setValue(this.plugin.settings.language)
          .onChange(async (value) => {
            this.plugin.settings.language = value.trim() || DEFAULT_SETTINGS.language;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Max output tokens")
      .setDesc("Upper bound for one AI batch analysis response.")
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.maxOutputTokens))
          .setValue(String(this.plugin.settings.maxOutputTokens))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            this.plugin.settings.maxOutputTokens = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SETTINGS.maxOutputTokens;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("RSS check")
      .setDesc("Fetch the first source without using AI.")
      .addButton((button) =>
        button
          .setButtonText("Test RSS")
          .onClick(() => void this.plugin.testSources()),
      );

    new Setting(containerEl)
      .setName("Import")
      .setDesc("Collect RSS items and write article notes.")
      .addButton((button) =>
        button
          .setButtonText("Collect latest")
          .setCta()
          .onClick(() => void this.plugin.collectLatestNews()),
      );

    new Setting(containerEl)
      .setName("Briefing")
      .setDesc("Collect RSS items and write a daily briefing note.")
      .addButton((button) =>
        button
          .setButtonText("Create briefing")
          .onClick(() => void this.plugin.createDailyBriefing()),
      );
  }
}

function parseSources(text: string): FeedSource[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [name, ...urlParts] = line.split("|");
      const url = urlParts.length ? urlParts.join("|").trim() : name.trim();
      return {
        name: urlParts.length ? name.trim() || url : inferSourceName(url),
        url,
      };
    })
    .filter((source) => /^https?:\/\//i.test(source.url));
}

function parseFeed(xml: string, source: FeedSource): FeedItem[] {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const rssItems = Array.from(doc.querySelectorAll("item"));
  const atomEntries = Array.from(doc.querySelectorAll("entry"));
  const nodes = rssItems.length ? rssItems : atomEntries;

  return nodes
    .map((node) => {
      const title = cleanText(textOf(node, "title"));
      const link = cleanText(textOf(node, "link")) || cleanText(attrOf(node, "link", "href"));
      const description = cleanText(
        textOf(node, "description") ||
        textOf(node, "summary") ||
        textOf(node, "content") ||
        textOf(node, "content\\:encoded"),
      );
      const publishedAt = cleanText(
        textOf(node, "pubDate") ||
        textOf(node, "published") ||
        textOf(node, "updated") ||
        new Date().toISOString(),
      );

      return {
        id: hashString(`${source.name}:${link || title}`),
        source: source.name,
        title: title || "Untitled",
        url: link,
        description,
        publishedAt,
      };
    })
    .filter((item) => item.url || item.title !== "Untitled");
}

function textOf(node: Element, selector: string): string {
  return node.querySelector(selector)?.textContent || "";
}

function attrOf(node: Element, selector: string, attr: string): string {
  return node.querySelector(selector)?.getAttribute(attr) || "";
}

function fallbackAnalysis(item: FeedItem): AnalyzedArticle {
  return {
    ...item,
    summary: item.description || "RSS item collected without AI analysis.",
    category: inferCategory(`${item.title} ${item.description}`),
    importance: 3,
    sentiment: "neutral",
    tags: buildTags(`${item.title} ${item.description}`),
  };
}

function buildAnalysisPrompt(items: FeedItem[], language: string): string {
  const compact = items.map((item) => ({
    url: item.url,
    source: item.source,
    title: item.title,
    published_at: item.publishedAt,
    excerpt: item.description.slice(0, 800),
  }));

  return [
    `Analyze these trading and financial news RSS items. Respond in ${language}.`,
    "Return only valid JSON. The top-level value must be an array.",
    "Each array item must include: url, title, summary, category, importance, sentiment, tags.",
    "category should be one of: crypto, us_stock, kr_stock, macro, rates, fx, commodity, regulation, trading_other.",
    "importance must be an integer from 1 to 5. sentiment must be positive, neutral, or negative.",
    "",
    JSON.stringify(compact),
  ].join("\n");
}

function parseAiResults(rawText: string): AiArticleResult[] {
  const trimmed = rawText.trim();
  const direct = tryParseJson(trimmed);
  if (Array.isArray(direct)) return direct as AiArticleResult[];
  if (isObject(direct) && Array.isArray(direct.articles)) return direct.articles as AiArticleResult[];

  const match = trimmed.match(/\[[\s\S]*\]/);
  if (!match) return [];
  const parsed = tryParseJson(match[0]);
  return Array.isArray(parsed) ? parsed as AiArticleResult[] : [];
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractOpenAIText(json: Record<string, unknown>): string {
  if (typeof json.output_text === "string") return json.output_text;
  const output = Array.isArray(json.output) ? json.output : [];
  const parts: string[] = [];
  for (const item of output) {
    if (!isObject(item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (isObject(content) && typeof content.text === "string") parts.push(content.text);
    }
  }
  return parts.join("\n");
}

function extractAnthropicText(json: Record<string, unknown>): string {
  const content = Array.isArray(json.content) ? json.content : [];
  return content
    .map((item) => isObject(item) && typeof item.text === "string" ? item.text : "")
    .filter(Boolean)
    .join("\n");
}

function extractGeminiText(json: Record<string, unknown>): string {
  const candidates = Array.isArray(json.candidates) ? json.candidates : [];
  const first = candidates[0];
  if (!isObject(first) || !isObject(first.content) || !Array.isArray(first.content.parts)) return "";
  return first.content.parts
    .map((part) => isObject(part) && typeof part.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n");
}

function briefingLead(articles: AnalyzedArticle[]): string {
  if (!articles.length) return "수집된 뉴스가 없습니다.";
  const top = articles[0];
  const negative = articles.filter((article) => article.sentiment === "negative").length;
  const positive = articles.filter((article) => article.sentiment === "positive").length;
  const tone = negative > positive ? "리스크 점검이 우선입니다" : positive > negative ? "긍정 재료가 상대적으로 우세합니다" : "방향성은 중립에 가깝습니다";
  return `${categoryLabel(top.category)}에서 가장 높은 중요도 뉴스가 포착됐고, 전체 감성 기준으로는 ${tone}.`;
}

function categoryRows(articles: AnalyzedArticle[]): string[] {
  const groups = new Map<string, AnalyzedArticle[]>();
  for (const article of articles) {
    const key = article.category || "trading_other";
    groups.set(key, [...(groups.get(key) || []), article]);
  }

  return Array.from(groups.entries())
    .sort((a, b) => b[1].length - a[1].length)
    .map(([category, group]) => {
      const avg = group.reduce((sum, article) => sum + article.importance, 0) / group.length;
      return `| ${tableCell(categoryLabel(category))} | ${group.length} | ${avg.toFixed(1)} |`;
    });
}

function categoryLabel(category: string): string {
  const labels: Record<string, string> = {
    crypto: "암호화폐/코인",
    us_stock: "미국 주식",
    kr_stock: "한국 주식",
    macro: "매크로 경제",
    rates: "금리/채권",
    fx: "환율/외환",
    commodity: "원자재",
    regulation: "규제/정책",
    trading_other: "기타",
  };
  return labels[category] || category || "기타";
}

function sentimentIcon(sentiment: Sentiment): string {
  if (sentiment === "positive") return "🟢";
  if (sentiment === "negative") return "🔴";
  return "🟡";
}

function sentimentLabel(sentiment: Sentiment): string {
  if (sentiment === "positive") return "🟢 긍정";
  if (sentiment === "negative") return "🔴 부정";
  return "🟡 중립";
}

function importanceStars(importance: number): string {
  const count = Math.min(5, Math.max(1, Math.round(importance)));
  return "★".repeat(count) + "☆".repeat(5 - count);
}

function calloutType(article: AnalyzedArticle): string {
  if (article.importance >= 5 || article.sentiment === "negative") return "warning";
  if (article.sentiment === "positive") return "success";
  return "info";
}

function tableCell(value: string): string {
  return cleanText(value).replace(/\|/g, "\\|") || "-";
}

function assertOk(status: number, provider: string) {
  if (status < 200 || status >= 300) {
    throw new Error(`${provider} API returned HTTP ${status}`);
  }
}

function dedupeByUrl(items: FeedItem[]): FeedItem[] {
  const seen = new Set<string>();
  const out: FeedItem[] = [];
  for (const item of items) {
    const key = item.url || item.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function inferSourceName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "RSS Source";
  }
}

function cleanText(input: unknown): string {
  if (typeof input !== "string") return "";
  const div = document.createElement("div");
  div.innerHTML = input;
  return (div.textContent || div.innerText || "")
    .replace(/\s+/g, " ")
    .trim();
}

function inferCategory(text: string): string {
  const lower = text.toLowerCase();
  if (/(bitcoin|crypto|coin|ethereum|btc|eth|defi|blockchain)/.test(lower)) return "crypto";
  if (/(fed|inflation|gdp|jobs|recession|macro|economy)/.test(lower)) return "macro";
  if (/(rate|yield|bond|treasury|fomc)/.test(lower)) return "rates";
  if (/(oil|gold|commodity|wti|brent|copper)/.test(lower)) return "commodity";
  if (/(dollar|yen|euro|fx|currency|forex)/.test(lower)) return "fx";
  if (/(sec|regulation|policy|law|ban|approval)/.test(lower)) return "regulation";
  return "trading_other";
}

function buildTags(text: string): string[] {
  return Array.from(
    new Set(
      cleanText(text)
        .split(/[^\p{L}\p{N}.$-]+/u)
        .filter((word) => word.length >= 4)
        .slice(0, 12)
        .map((word) => word.replace(/^#+/, "")),
    ),
  ).slice(0, 6);
}

function normalizeSentiment(value: unknown): Sentiment {
  return value === "positive" || value === "negative" || value === "neutral" ? value : "neutral";
}

function clampImportance(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return 3;
  return Math.min(5, Math.max(1, Math.round(parsed)));
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sanitizeFileName(input: string): string {
  return cleanText(input)
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
  const direct = value.match(/^\d{4}-\d{2}-\d{2}/);
  if (direct) return direct[0];
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;
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
  return `item_${Math.abs(hash).toString(16)}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
