import {
  App,
  Modal,
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
type PresetTier = "lowest" | "balanced" | "latest";
type RadarMode = "dashboard" | "feed";

interface TradirSettings {
  outputFolder: string;
  sourceText: string;
  defaultLimit: number;
  historyLimit: number;
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
  originalTitle: string;
  originalDescription: string;
  summary: string;
  category: string;
  importance: number;
  sentiment: Sentiment;
  tags: string[];
}

interface AiArticleResult {
  [key: string]: unknown;
  url?: string;
  title?: string;
  summary?: string;
  category?: string;
  importance?: unknown;
  sentiment?: unknown;
  tags?: string[];
}

interface OpenAIChatAttempt {
  label: string;
  payload: Record<string, unknown>;
}

interface ModelPreset {
  provider: Exclude<AiProvider, "none">;
  tier: PresetTier;
  model: string;
  label: string;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  note: string;
  source: string;
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
  defaultLimit: 80,
  historyLimit: 30000,
  aiProvider: "none",
  aiModel: "",
  apiKey: "",
  maxOutputTokens: 1800,
  language: "Korean",
};

const AI_ANALYSIS_BATCH_SIZE = 12;

const PROVIDER_DEFAULT_MODELS: Record<AiProvider, string> = {
  none: "",
  openai: "gpt-5.4-nano",
  anthropic: "claude-haiku-4-5-20251001",
  gemini: "gemini-2.5-flash-lite",
};

const MODEL_PRESETS: ModelPreset[] = [
  {
    provider: "openai",
    tier: "lowest",
    model: "gpt-5.4-nano",
    label: "Lowest cost - GPT-5.4 nano",
    inputUsdPerMTok: 0.20,
    outputUsdPerMTok: 1.25,
    note: "Best default for RSS summarization and classification when cost matters.",
    source: "OpenAI pricing, 2026-06",
  },
  {
    provider: "openai",
    tier: "balanced",
    model: "gpt-5.4-mini",
    label: "Balanced - GPT-5.4 mini",
    inputUsdPerMTok: 0.75,
    outputUsdPerMTok: 4.50,
    note: "Stronger reasoning than nano while still much cheaper than frontier models.",
    source: "OpenAI pricing, 2026-06",
  },
  {
    provider: "openai",
    tier: "latest",
    model: "gpt-5.5",
    label: "Latest frontier - GPT-5.5",
    inputUsdPerMTok: 5.00,
    outputUsdPerMTok: 30.00,
    note: "Use only when briefing quality matters more than token cost.",
    source: "OpenAI pricing, 2026-06",
  },
  {
    provider: "anthropic",
    tier: "lowest",
    model: "claude-haiku-4-5-20251001",
    label: "Lowest cost - Claude Haiku 4.5",
    inputUsdPerMTok: 1.00,
    outputUsdPerMTok: 5.00,
    note: "Fastest Claude option and the practical default for news triage.",
    source: "Anthropic pricing, 2026-06",
  },
  {
    provider: "anthropic",
    tier: "balanced",
    model: "claude-sonnet-4-6",
    label: "Balanced - Claude Sonnet 4.6",
    inputUsdPerMTok: 3.00,
    outputUsdPerMTok: 15.00,
    note: "Best Claude price/performance tier for deeper market interpretation.",
    source: "Anthropic pricing, 2026-06",
  },
  {
    provider: "anthropic",
    tier: "latest",
    model: "claude-opus-4-8",
    label: "Latest frontier - Claude Opus 4.8",
    inputUsdPerMTok: 5.00,
    outputUsdPerMTok: 25.00,
    note: "Most capable Claude option for complex reasoning; expensive for routine RSS.",
    source: "Anthropic pricing, 2026-06",
  },
  {
    provider: "gemini",
    tier: "lowest",
    model: "gemini-2.5-flash-lite",
    label: "Lowest cost - Gemini 2.5 Flash-Lite",
    inputUsdPerMTok: 0.10,
    outputUsdPerMTok: 0.40,
    note: "Cheapest listed option among supported providers for this plugin.",
    source: "Google AI pricing, 2026-06",
  },
  {
    provider: "gemini",
    tier: "balanced",
    model: "gemini-2.5-flash",
    label: "Balanced - Gemini 2.5 Flash",
    inputUsdPerMTok: 0.30,
    outputUsdPerMTok: 2.50,
    note: "Good balance for multilingual briefings with low cost.",
    source: "Google AI pricing, 2026-06",
  },
  {
    provider: "gemini",
    tier: "latest",
    model: "gemini-2.5-pro",
    label: "Performance - Gemini 2.5 Pro",
    inputUsdPerMTok: 1.25,
    outputUsdPerMTok: 10.00,
    note: "Use for complex reasoning; price shown for prompts up to 200k tokens.",
    source: "Google AI pricing, 2026-06",
  },
];

export default class TradirObsdianPlugin extends Plugin {
  settings: TradirSettings;
  private statusEl: HTMLElement | null = null;

  async onload() {
    await this.loadSettings();
    this.statusEl = this.addStatusBarItem();
    this.setStatus("Ready");

    this.addRibbonIcon("newspaper", "Open Tradir panel", () => {
      this.openCommandPanel();
    });

    this.addCommand({
      id: "open-tradir-panel",
      name: "Open Tradir command panel",
      callback: () => this.openCommandPanel(),
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

    this.addCommand({
      id: "test-ai-connection",
      name: "Test AI connection",
      callback: () => void this.testAiConnection(),
    });

    this.addSettingTab(new TradirSettingTab(this.app, this));
  }

  onunload() {
    this.statusEl = null;
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    let changed = false;
    if (this.settings.sourceText.includes("https://finance.yahoo.com/news/rssindex")) {
      this.settings.sourceText = this.settings.sourceText.replace(
        /Yahoo Finance\|https:\/\/finance\.yahoo\.com\/news\/rssindex/g,
        "MarketWatch|https://feeds.marketwatch.com/marketwatch/topstories/",
      );
      changed = true;
    }
    if (this.settings.aiProvider === "openai" && ["gpt-5", "gpt-4.1-mini"].includes(this.settings.aiModel)) {
      this.settings.aiModel = PROVIDER_DEFAULT_MODELS.openai;
      changed = true;
    }
    if (this.settings.aiProvider === "anthropic" && this.settings.aiModel === "claude-sonnet-4-20250514") {
      this.settings.aiModel = PROVIDER_DEFAULT_MODELS.anthropic;
      changed = true;
    }
    if (this.settings.aiProvider === "gemini" && this.settings.aiModel === "gemini-2.5-flash") {
      this.settings.aiModel = PROVIDER_DEFAULT_MODELS.gemini;
      changed = true;
    }
    if (!this.settings.aiModel) {
      this.settings.aiModel = PROVIDER_DEFAULT_MODELS[this.settings.aiProvider] || "";
      changed = true;
    }
    if (changed) {
      await this.saveSettings();
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  openCommandPanel() {
    new TradirCommandModal(this.app, this).open();
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

  async testAiConnection() {
    try {
      this.setStatus("Testing AI");
      if (this.settings.aiProvider === "none") {
        throw new Error("AI provider is None. Choose a provider first.");
      }
      const keyWarning = likelyKeyProviderWarning(this.settings.aiProvider, this.settings.apiKey);
      if (keyWarning) {
        throw new Error(keyWarning);
      }

      await this.testProviderAuth();

      const sample: FeedItem = {
        id: "test",
        source: "Tradir test",
        title: "S&P 500 futures edge higher before inflation data",
        url: "https://example.com/tradir-ai-test",
        description: "A short connection test item for market news classification.",
        publishedAt: new Date().toISOString(),
      };
      const rawText = await this.callAi(buildAnalysisPrompt([sample], this.settings.language), 350);
      const parsed = parseAiResults(rawText);
      if (!parsed.length) {
        throw new Error("AI connected, but the response was not valid briefing JSON.");
      }
      const model = this.settings.aiModel || PROVIDER_DEFAULT_MODELS[this.settings.aiProvider];
      new Notice(`AI connection OK: ${this.settings.aiProvider} / ${model}`);
      this.setStatus("AI OK");
    } catch (error) {
      this.handleError("AI connection failed", error);
    }
  }

  private async testProviderAuth(): Promise<void> {
    if (this.settings.aiProvider !== "openai") return;
    const response = await requestUrl({
      url: "https://api.openai.com/v1/models",
      method: "GET",
      headers: {
        Authorization: `Bearer ${normalizeApiKey(this.settings.apiKey)}`,
      },
      throw: false,
    });
    if (response.status < 200 || response.status >= 300) {
      const detail = summarizeProviderError(response.text);
      throw new Error(`OpenAI auth check failed before model call. HTTP ${response.status}${detail ? `: ${detail}` : ""} ${providerAuthHint("OpenAI")}`);
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

  async translateLatestNews() {
    try {
      this.setStatus("Translating");
      const items = await this.collectFeedItems();
      if (!items.length) {
        new Notice("No RSS items found for translation.");
        this.setStatus("No news");
        return;
      }

      if (this.settings.aiProvider === "none") {
        throw new Error("Translation requires an AI provider. Set OpenAI, Anthropic, or Gemini in plugin settings.");
      }
      const keyWarning = likelyKeyProviderWarning(this.settings.aiProvider, this.settings.apiKey);
      if (keyWarning) {
        throw new Error(keyWarning);
      }
      await this.testProviderAuth();

      const analyzed = await this.analyzeItems(items, false);
      const allArticles = await this.mergeWithStoredArticles(analyzed);
      new TradirBriefingModal(this.app, this, allArticles, "feed").open();
      new Notice(`Opened translated news feed with ${allArticles.length} item${allArticles.length === 1 ? "" : "s"}.`);
      this.setStatus("Translated");
    } catch (error) {
      this.handleError("Could not translate trading news", error);
    }
  }

  async runOneClickWorkflow() {
    try {
      this.setStatus("One click");
      const items = await this.collectFeedItems();
      if (!items.length) {
        new Notice("No RSS items found.");
        this.setStatus("No news");
        return;
      }

      const analyzed = await this.analyzeItems(items);
      await this.ensureFolder(`${this.settings.outputFolder}/Articles`);
      await this.ensureFolder(`${this.settings.outputFolder}/Briefings`);
      for (const article of analyzed) {
        await this.writeArticleNote(article);
      }
      await this.writeBriefingNote(analyzed);
      await this.refreshIndex();
      const allArticles = await this.mergeWithStoredArticles(analyzed);
      new TradirBriefingModal(this.app, this, allArticles, "feed").open();
      new Notice(`Completed one-click workflow for ${allArticles.length} item${allArticles.length === 1 ? "" : "s"}.`);
      this.setStatus("Done");
    } catch (error) {
      this.handleError("Could not run one-click workflow", error);
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
      const allArticles = await this.mergeWithStoredArticles(analyzed);
      new TradirBriefingModal(this.app, this, allArticles, "dashboard").open();
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

  private async mergeWithStoredArticles(current: AnalyzedArticle[]): Promise<AnalyzedArticle[]> {
    const stored = await this.loadStoredArticles();
    return dedupeAnalyzedByUrl([...current, ...stored])
      .sort((a, b) => timestamp(b.publishedAt) - timestamp(a.publishedAt))
      .slice(0, Math.max(1, this.settings.historyLimit));
  }

  private async loadStoredArticles(): Promise<AnalyzedArticle[]> {
    const articleFolder = `${normalizePath(this.settings.outputFolder)}/Articles/`;
    const limit = Math.max(1, this.settings.historyLimit);
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((file) => file.path.startsWith(articleFolder))
      .sort((a, b) => b.path.localeCompare(a.path))
      .slice(0, limit);
    const articles: AnalyzedArticle[] = [];

    for (const file of files) {
      try {
        const text = await this.app.vault.cachedRead(file);
        const article = parseStoredArticle(text, file);
        if (article) articles.push(article);
      } catch (error) {
        console.warn(`[Tradir Obsdian] Could not read stored article ${file.path}`, error);
      }
    }

    return articles;
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

  private async analyzeItems(items: FeedItem[], fallbackOnError = true): Promise<AnalyzedArticle[]> {
    const baseline = items.map((item) => fallbackAnalysis(item));
    if (this.settings.aiProvider === "none") {
      return baseline;
    }

    if (!normalizeApiKey(this.settings.apiKey)) {
      new Notice("AI key is empty. Creating an RSS-only briefing without using tokens.");
      return baseline;
    }

    let parsed: AiArticleResult[] = [];
    try {
      const batches = chunk(items, AI_ANALYSIS_BATCH_SIZE);
      for (const batch of batches) {
        const prompt = buildAnalysisPrompt(batch, this.settings.language);
        const rawText = await this.callAi(prompt, this.settings.maxOutputTokens);
        const batchParsed = parseAiResults(rawText);
        if (!batchParsed.length) {
          throw new Error(`AI response did not contain parsable articles JSON. ${rawText.slice(0, 180)}`);
        }
        parsed.push(...batchParsed);
      }
    } catch (error) {
      if (!fallbackOnError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`AI analysis failed. RSS-only report created. ${message}`);
      console.warn("[Tradir Obsdian] AI analysis failed, falling back to RSS-only", error);
      return baseline;
    }

    const byUrl = new Map(parsed.filter((item) => item.url).map((item) => [item.url || "", item]));
    return baseline.map((article, index) => {
      const ai = byUrl.get(article.url) || parsed.find((candidate) => candidate.title === article.title) || parsed[index];
      if (!ai) return article;

      return {
        ...article,
        title: readAiString(ai, ["title", "translated_title", "translatedTitle", "korean_title", "koreanTitle", "headline"]) || article.title,
        summary: readAiString(ai, ["summary", "translated_summary", "translatedSummary", "korean_summary", "koreanSummary", "description"]) || article.summary,
        category: normalizeCategory(readAiString(ai, ["category", "sector", "topic"]) || article.category),
        importance: clampImportance(readAiValue(ai, ["importance", "importance_score", "importanceScore", "score", "rating"])),
        sentiment: normalizeSentiment(readAiValue(ai, ["sentiment", "sentiment_label", "sentimentLabel", "tone", "market_tone", "marketTone"])),
        tags: readAiTags(ai) || article.tags,
      };
    });
  }

  private async callAi(prompt: string, maxOutputTokens = this.settings.maxOutputTokens): Promise<string> {
    const provider = this.settings.aiProvider;
    const model = this.settings.aiModel || PROVIDER_DEFAULT_MODELS[provider];
    const keyWarning = likelyKeyProviderWarning(provider, this.settings.apiKey);
    if (keyWarning) {
      throw new Error(keyWarning);
    }

    if (provider === "openai") {
      return this.callOpenAI(model, prompt, maxOutputTokens);
    }
    if (provider === "anthropic") {
      return this.callAnthropic(model, prompt, maxOutputTokens);
    }
    if (provider === "gemini") {
      return this.callGemini(model, prompt, maxOutputTokens);
    }
    throw new Error(`Unsupported AI provider: ${provider}`);
  }

  private async callOpenAI(model: string, prompt: string, maxOutputTokens: number): Promise<string> {
    const messages = [
      {
        role: "system",
        content: "You analyze trading news. Return only valid JSON. Do not include markdown fences. JSON output should contain an articles array.",
      },
      {
        role: "user",
        content: prompt,
      },
    ];

    const completionTokenPayload = {
      model,
      messages,
      max_completion_tokens: maxOutputTokens,
    };

    const legacyTokenPayload = {
      model,
      messages,
      max_tokens: maxOutputTokens,
    };
    const attempts: OpenAIChatAttempt[] = [
      {
        label: "json_object + max_completion_tokens",
        payload: {
          ...completionTokenPayload,
          response_format: { type: "json_object" },
        },
      },
      {
        label: "plain + max_completion_tokens",
        payload: completionTokenPayload,
      },
      {
        label: "json_object + max_tokens",
        payload: {
          ...legacyTokenPayload,
          response_format: { type: "json_object" },
        },
      },
      {
        label: "plain + max_tokens",
        payload: legacyTokenPayload,
      },
      {
        label: "plain without token cap",
        payload: {
          model,
          messages,
        },
      },
    ];

    let lastResponse: Awaited<ReturnType<typeof this.postOpenAIChat>> | null = null;
    for (const attempt of attempts) {
      const response = await this.postOpenAIChat(attempt.payload);
      lastResponse = response;
      if (response.status >= 200 && response.status < 300) {
        const json = response.json as Record<string, unknown>;
        return extractOpenAIChatText(json);
      }
      if (response.status !== 400) {
        assertOk(response.status, "OpenAI", response.text);
      }
      console.warn(`[Tradir Obsdian] OpenAI attempt failed (${attempt.label}), trying fallback`, response.text);
    }

    assertOk(lastResponse?.status || 400, "OpenAI", lastResponse?.text);
    return "";
  }

  private async postOpenAIChat(payload: Record<string, unknown>) {
    return requestUrl({
      url: "https://api.openai.com/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${normalizeApiKey(this.settings.apiKey)}`,
      },
      body: JSON.stringify(payload),
      throw: false,
    });
  }

  private async callAnthropic(model: string, prompt: string, maxOutputTokens: number): Promise<string> {
    const response = await requestUrl({
      url: "https://api.anthropic.com/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": normalizeApiKey(this.settings.apiKey),
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxOutputTokens,
        messages: [{ role: "user", content: prompt }],
      }),
      throw: false,
    });

    assertOk(response.status, "Anthropic", response.text);
    const json = response.json as Record<string, unknown>;
    return extractAnthropicText(json);
  }

  private async callGemini(model: string, prompt: string, maxOutputTokens: number): Promise<string> {
    const safeModel = model.startsWith("models/") ? model : `models/${model}`;
    const apiKey = normalizeApiKey(this.settings.apiKey);
    const response = await requestUrl({
      url: `https://generativelanguage.googleapis.com/v1beta/${safeModel}:generateContent?key=${encodeURIComponent(apiKey)}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          maxOutputTokens,
        },
      }),
      throw: false,
    });

    assertOk(response.status, "Gemini", response.text);
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
      `original_title: "${yamlEscape(article.originalTitle)}"`,
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
      "## 원문 제목",
      "",
      article.originalTitle || article.title,
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
    const neutralCount = sorted.filter((article) => article.sentiment === "neutral").length;
    const selectedModel = this.settings.aiModel || PROVIDER_DEFAULT_MODELS[this.settings.aiProvider];
    const selectedPreset = findPreset(this.settings.aiProvider, selectedModel);
    const aiLabel = this.settings.aiProvider === "none"
      ? "RSS only, tokens 0"
      : `${this.settings.aiProvider} / ${selectedModel}`;
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
      `# Trading News Briefing`,
      "",
      `**${date} 시장 뉴스 레이더**`,
      "",
      "> [!summary] 요약",
      `> ${briefingLead(sorted)}`,
      ">",
      `> 수집 기사 **${articles.length}개**, 출처 **${sourceCount}개**, 고중요도 **${highImpact.length}개**. AI 분석: **${aiLabel}**.`,
      "",
      "## 1. 브리핑 지표",
      "",
      "| 항목 | 값 |",
      "|---|---:|",
      `| 수집 기사 | ${articles.length} |`,
      `| 뉴스 출처 | ${sourceCount} |`,
      `| 고중요도 | ${highImpact.length} |`,
      `| 긍정 / 중립 / 부정 | ${positiveCount} / ${neutralCount} / ${negativeCount} |`,
      `| AI 분석 | ${tableCell(aiLabel)} |`,
      "",
      "## 2. 카테고리 분포",
      "",
      "| 카테고리 | 기사 수 | 평균 중요도 |",
      "|---|---:|---:|",
      ...categoryRows(sorted),
      "",
      "## 3. 우선 확인 뉴스",
      "",
      ...priorityStoryBlocks(sorted.slice(0, 7)),
      "",
      "## 4. 전체 뉴스 목록",
      "",
      "| 중요도 | 감성 | 카테고리 | 제목 | 출처 |",
      "|---:|---|---|---|---|",
    ];

    sorted.forEach((article) => {
      lines.push(
        `| ${article.importance} | ${sentimentIcon(article.sentiment)} | ${tableCell(categoryLabel(article.category))} | ${article.url ? `[${tableCell(article.title)}](${article.url})` : tableCell(article.title)} | ${tableCell(article.source)} |`,
      );
    });
    lines.push("");

    lines.push(
      "## 5. 실행 설정",
      "",
      "| 항목 | 값 |",
      "|---|---|",
      `| RSS 처리 한도 | ${this.settings.defaultLimit} |`,
      `| AI Provider | ${this.settings.aiProvider} |`,
      `| Model | ${selectedModel || "N/A"} |`,
      `| Model cost note | ${tableCell(formatPresetDetails(selectedPreset))} |`,
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
      .setDesc("Maximum RSS items processed per command run. Higher values use more AI tokens when AI is enabled.")
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
      .setName("Stored article history limit")
      .setDesc("Maximum saved article notes loaded into the radar popup for search, dashboard counts, and news feed.")
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.historyLimit))
          .setValue(String(this.plugin.settings.historyLimit))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            this.plugin.settings.historyLimit = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SETTINGS.historyLimit;
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
      .setName("Recommended model preset")
      .setDesc(this.plugin.settings.aiProvider === "none"
        ? "Choose an AI provider first. RSS-only mode uses zero tokens."
        : "Current official list-price snapshot from June 2026. Prices are per 1M tokens and may change.")
      .addDropdown((dropdown) => {
        const presets = getProviderPresets(this.plugin.settings.aiProvider);
        const currentModel = this.plugin.settings.aiModel || PROVIDER_DEFAULT_MODELS[this.plugin.settings.aiProvider];
        if (!presets.length) {
          dropdown.addOption("none", "None - RSS only");
        } else {
          if (!presets.some((preset) => preset.model === currentModel)) {
            dropdown.addOption("__custom__", `Custom - ${currentModel || "manual model"}`);
          }
          presets.forEach((preset) => dropdown.addOption(preset.model, formatPresetLabel(preset)));
        }
        dropdown
          .setValue(presets.some((preset) => preset.model === currentModel) ? currentModel : "__custom__")
          .onChange(async (value) => {
            if (value === "__custom__" || value === "none") return;
            this.plugin.settings.aiModel = value;
            await this.plugin.saveSettings();
            this.display();
          });
      });

    new Setting(containerEl)
      .setName("AI model")
      .setDesc(formatPresetDetails(findPreset(
        this.plugin.settings.aiProvider,
        this.plugin.settings.aiModel || PROVIDER_DEFAULT_MODELS[this.plugin.settings.aiProvider],
      )))
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
            this.plugin.settings.apiKey = normalizeApiKey(value);
            await this.plugin.saveSettings();
          });
      })
      .addButton((button) =>
        button
          .setButtonText("Clear key")
          .onClick(async () => {
            this.plugin.settings.apiKey = "";
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName("Key diagnostic")
      .setDesc(formatKeyDiagnostic(this.plugin.settings.apiKey))
      .addButton((button) =>
        button
          .setButtonText("Refresh")
          .onClick(() => this.display()),
      );

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
      .setName("AI check")
      .setDesc("Send one tiny provider request to verify key, provider, and model before creating a briefing.")
      .addButton((button) =>
        button
          .setButtonText("Test AI")
          .onClick(() => void this.plugin.testAiConnection()),
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

  }
}

class TradirCommandModal extends Modal {
  private statusEl: HTMLElement | null = null;

  constructor(app: App, private plugin: TradirObsdianPlugin) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    this.modalEl.addClass("tradir-panel-modal-shell");
    contentEl.empty();
    contentEl.addClass("tradir-command-modal");

    const header = contentEl.createDiv({ cls: "tradir-command-header" });
    header.createDiv({ cls: "tradir-command-mark", text: "TN" });
    const title = header.createDiv();
    title.createEl("h2", { text: "Tradir News Radar" });
    title.createEl("p", { text: "뉴스 수집, AI 분석 미리보기, 원클릭 브리핑 생성을 실행합니다." });

    const grid = contentEl.createDiv({ cls: "tradir-command-grid" });
    this.addAction(grid, {
      icon: "▣",
      title: "수집",
      desc: "RSS를 수집하고 기사 노트를 생성",
      primary: true,
      run: async () => this.plugin.collectLatestNews(),
    });
    this.addAction(grid, {
      icon: "◉",
      title: "AI 처리",
      desc: "분류, 중요도, 감성, 번역 분석",
      primary: true,
      run: async () => this.plugin.translateLatestNews(),
    });
    this.addAction(grid, {
      icon: "⚡",
      title: "원클릭 전체 실행",
      desc: "수집, AI 처리, 브리핑, 피드 열기",
      primary: true,
      run: async () => this.plugin.runOneClickWorkflow(),
    });
    this.addAction(grid, {
      icon: "✓",
      title: "RSS 테스트",
      desc: "첫 RSS 소스 연결 확인",
      run: async () => this.plugin.testSources(),
    });
    this.addAction(grid, {
      icon: "◇",
      title: "AI 테스트",
      desc: "키, 모델, 인증 상태 확인",
      run: async () => this.plugin.testAiConnection(),
    });

    const meta = contentEl.createDiv({ cls: "tradir-command-meta" });
    meta.createEl("span", { text: `Provider: ${this.plugin.settings.aiProvider}` });
    meta.createEl("span", { text: `Model: ${this.plugin.settings.aiModel || PROVIDER_DEFAULT_MODELS[this.plugin.settings.aiProvider] || "N/A"}` });
    meta.createEl("span", { text: `Limit: ${this.plugin.settings.defaultLimit}` });
    this.statusEl = contentEl.createDiv({ cls: "tradir-command-status", text: "대기 중" });

    const footer = contentEl.createDiv({ cls: "tradir-command-footer" });
    const settingsButton = footer.createEl("button", { cls: "tradir-secondary-button", text: "설정 열기" });
    settingsButton.addEventListener("click", () => {
      this.close();
      openPluginSettings(this.app, this.plugin.manifest.id);
    });
    const closeButton = footer.createEl("button", { cls: "tradir-secondary-button", text: "닫기" });
    closeButton.addEventListener("click", () => this.close());
  }

  private addAction(container: HTMLElement, action: {
    icon: string;
    title: string;
    desc: string;
    primary?: boolean;
    run: () => Promise<void>;
  }) {
    const button = container.createEl("button", {
      cls: `tradir-action-tile${action.primary ? " is-primary" : ""}`,
    });
    button.type = "button";
    button.createEl("span", { cls: "tradir-action-icon", text: action.icon });
    const copy = button.createEl("span", { cls: "tradir-action-copy" });
    copy.createEl("strong", { text: action.title });
    copy.createEl("small", { text: action.desc });
    button.addEventListener("click", async () => {
      button.disabled = true;
      button.addClass("is-running");
      this.setPanelStatus(`${action.title} 실행 중...`);
      try {
        await action.run();
        this.setPanelStatus(`${action.title} 완료`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.setPanelStatus(`${action.title} 실패: ${message}`);
        throw error;
      } finally {
        button.disabled = false;
        button.removeClass("is-running");
      }
    });
  }

  private setPanelStatus(text: string) {
    if (!this.statusEl) return;
    this.statusEl.setText(text);
  }
}

class TradirBriefingModal extends Modal {
  private activeCategory = "all";
  private searchQuery = "";
  private page = 0;
  private readonly pageSize = 30;

  constructor(
    app: App,
    private plugin: TradirObsdianPlugin,
    private articles: AnalyzedArticle[],
    private activeMode: RadarMode = "dashboard",
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    this.modalEl.addClass("tradir-report-modal-shell");
    contentEl.empty();
    contentEl.addClass("tradir-briefing-modal");

    const sorted = [...this.articles].sort((a, b) => effectiveImportance(b) - effectiveImportance(a));
    const visible = this.activeCategory === "all"
      ? sorted
      : sorted.filter((article) => (article.category || "trading_other") === this.activeCategory);
    const searched = filterArticles(visible, this.searchQuery);
    const sourceCount = new Set(searched.map((article) => article.source)).size;
    const highImpact = searched.filter((article) => effectiveImportance(article) >= 4).length;
    const positiveCount = searched.filter((article) => effectiveSentiment(article) === "positive").length;
    const positiveRate = searched.length ? Math.round((positiveCount / searched.length) * 100) : 0;
    this.page = Math.min(this.page, Math.max(0, Math.ceil(searched.length / this.pageSize) - 1));
    const modeArticles = this.getModeArticles(searched);

    const shell = contentEl.createDiv({ cls: "tradir-radar-shell is-report-only" });
    const main = shell.createDiv({ cls: "tradir-radar-main" });
    const header = main.createDiv({ cls: "tradir-briefing-hero" });
    const eyebrow = header.createDiv({ cls: "tradir-briefing-eyebrow", text: today() });
    eyebrow.createSpan({ text: " · AI News Radar" });
    header.createEl("h2", { text: this.getModeTitle(searched.length) });
    header.createEl("p", { text: this.getModeDescription(sorted) });

    const metrics = header.createDiv({ cls: "tradir-metric-grid" });
    addMetric(metrics, "기사", String(searched.length));
    addMetric(metrics, "긍정", `${positiveRate}%`);
    addMetric(metrics, "고중요도", String(highImpact));
    addMetric(metrics, "소스", String(sourceCount));

    const tabs = header.createDiv({ cls: "tradir-radar-tabs" });
    this.addModeTab(tabs, "dashboard", "대시보드");
    this.addModeTab(tabs, "feed", "뉴스피드");

    const filters = header.createDiv({ cls: "tradir-filter-row" });
    this.addCategoryFilter(filters, "all", `전체 (${sorted.length})`);
    categoryCounts(sorted).forEach(([category, count]) => {
      this.addCategoryFilter(filters, category, `${categoryLabel(category)} (${count})`);
    });
    this.renderSearchControls(header, searched.length);

    if (this.activeMode === "dashboard") {
      this.renderDashboard(main, searched);
    } else {
      this.renderFeed(main, modeArticles, searched.length);
    }
  }

  private renderDashboard(container: HTMLElement, scopeArticles: AnalyzedArticle[]) {
    const body = container.createDiv({ cls: "tradir-dashboard-view" });
    const focus = body.createDiv({ cls: "tradir-dashboard-focus" });
    focus.createEl("h3", { text: "브리핑" });
    focus.createEl("p", { text: briefingLead(scopeArticles) });

    const cards = body.createDiv({ cls: "tradir-dashboard-cards" });
    const topCategories = categoryCounts(scopeArticles).slice(0, 6);
    topCategories.forEach(([category, count]) => {
      addDashboardCard(cards, category, categoryLabel(category), `${count}건`, () => this.activateCategory(category, "feed"));
    });

    const charts = body.createDiv({ cls: "tradir-chart-row" });
    const positive = scopeArticles.filter((article) => effectiveSentiment(article) === "positive").length;
    const negative = scopeArticles.filter((article) => effectiveSentiment(article) === "negative").length;
    const neutral = scopeArticles.length - positive - negative;
    const positiveRate = scopeArticles.length ? Math.round((positive / scopeArticles.length) * 100) : 0;
    addGauge(charts, "긍정 비율", positiveRate);
    addDonut(charts, positive, neutral, negative);

    const summary = body.createDiv({ cls: "tradir-dashboard-summary" });
    const categoryTable = summary.createEl("table", { cls: "tradir-mini-table" });
    addTableHead(categoryTable, ["관심 분야", "뉴스 수", "평균 중요도"]);
    addCategoryTableRows(categoryTable, scopeArticles);
  }

  private renderFeed(container: HTMLElement, articles: AnalyzedArticle[], total: number) {
    const section = container.createDiv({ cls: "tradir-mode-section" });
    section.createEl("h3", { text: this.getSectionTitle(total) });
    this.renderPager(section, total);
    const list = section.createDiv({ cls: "tradir-story-list" });
    articles.forEach((article, index) => addStory(list, article, this.page * this.pageSize + index));
    this.renderPager(section, total);
  }

  private addCategoryFilter(container: HTMLElement, category: string, label: string) {
    const button = container.createEl("button", {
      cls: `tradir-filter${this.activeCategory === category ? " is-active" : ""}`,
      text: label,
    });
    button.setAttr("style", `--tradir-category-color:${categoryColor(category)}`);
    button.addEventListener("click", () => {
      this.activateCategory(category, this.activeMode === "dashboard" ? "feed" : this.activeMode);
    });
  }

  private activateCategory(category: string, mode: RadarMode = this.activeMode) {
    this.activeCategory = category;
    this.activeMode = mode;
    this.page = 0;
    this.onOpen();
  }

  private addModeTab(container: HTMLElement, mode: RadarMode, label: string) {
    const button = container.createEl("button", {
      cls: `tradir-tab${this.activeMode === mode ? " is-active" : ""}`,
      text: label,
    });
    button.addEventListener("click", () => {
      this.activeMode = mode;
      this.page = 0;
      this.onOpen();
    });
  }

  private getModeArticles(articles: AnalyzedArticle[]): AnalyzedArticle[] {
    const start = this.page * this.pageSize;
    return articles.slice(start, start + this.pageSize);
  }

  private renderSearchControls(container: HTMLElement, total: number) {
    const row = container.createDiv({ cls: "tradir-search-row" });
    const input = row.createEl("input", {
      type: "search",
      placeholder: "제목, 요약, 태그, 출처 검색",
    });
    input.value = this.searchQuery;
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      this.searchQuery = input.value.trim();
      this.page = 0;
      this.onOpen();
    });
    const search = row.createEl("button", { text: "검색" });
    search.addEventListener("click", () => {
      this.searchQuery = input.value.trim();
      this.page = 0;
      this.onOpen();
    });
    const clear = row.createEl("button", { text: "초기화" });
    clear.disabled = !this.searchQuery;
    clear.addEventListener("click", () => {
      this.searchQuery = "";
      this.page = 0;
      this.onOpen();
    });
    row.createEl("span", { text: `${total}개 표시` });
  }

  private renderPager(container: HTMLElement, total: number) {
    if (total <= this.pageSize) return;
    const pageCount = Math.max(1, Math.ceil(total / this.pageSize));
    this.page = Math.min(this.page, pageCount - 1);
    const pager = container.createDiv({ cls: "tradir-pager" });
    const prev = pager.createEl("button", { text: "이전" });
    prev.disabled = this.page <= 0;
    prev.addEventListener("click", () => {
      this.page = Math.max(0, this.page - 1);
      this.onOpen();
    });
    pager.createEl("span", { text: `${this.page + 1} / ${pageCount}` });
    const next = pager.createEl("button", { text: "다음" });
    next.disabled = this.page >= pageCount - 1;
    next.addEventListener("click", () => {
      this.page = Math.min(pageCount - 1, this.page + 1);
      this.onOpen();
    });
  }

  private getModeTitle(count: number): string {
    if (this.activeMode === "feed") return `뉴스피드 (${count}개)`;
    return "대시보드";
  }

  private getSectionTitle(count: number): string {
    const category = this.activeCategory === "all" ? "" : `${categoryLabel(this.activeCategory)} · `;
    if (this.activeMode === "feed") return `${category}전체 뉴스 (${count}개)`;
    return `${category}우선 확인 뉴스 (${count}개)`;
  }

  private getModeDescription(articles: AnalyzedArticle[]): string {
    if (this.activeMode === "feed") return "번역된 제목과 원문 제목을 함께 보는 뉴스 카드 목록입니다.";
    return briefingLead(articles);
  }
}

function openPluginSettings(app: App, pluginId: string) {
  const settingApp = (app as App & { setting?: { open: () => void; openTabById: (id: string) => void } }).setting;
  if (!settingApp) return;
  settingApp.open();
  settingApp.openTabById(pluginId);
}

function addMetric(container: HTMLElement, label: string, value: string) {
  const metric = container.createDiv({ cls: "tradir-metric" });
  metric.createEl("span", { text: label });
  metric.createEl("strong", { text: value });
}

function addDashboardCard(container: HTMLElement, category: string, label: string, value: string, onClick: () => void) {
  const card = container.createEl("button", { cls: "tradir-dashboard-card" });
  card.type = "button";
  card.setAttr("style", `--tradir-category-color:${categoryColor(category)}`);
  card.addEventListener("click", onClick);
  card.createEl("span", { text: label });
  card.createEl("strong", { text: value });
}

function addGauge(container: HTMLElement, label: string, value: number) {
  const card = container.createDiv({ cls: "tradir-chart-card" });
  card.createEl("h3", { text: label });
  const gauge = card.createDiv({ cls: "tradir-gauge" });
  const safeValue = Math.max(0, Math.min(100, value));
  gauge.setAttr("style", `--angle:${safeValue * 1.8}deg`);
  gauge.setAttr("title", `${label}: ${safeValue}%`);
  gauge.createDiv({ cls: "tradir-gauge-value", text: `${value}%` });
  addChartTooltip(card, [
    [label, `${safeValue}%`],
    ["중립/부정 포함", `${100 - safeValue}%`],
  ]);
}

function addDonut(container: HTMLElement, positive: number, neutral: number, negative: number) {
  const total = Math.max(1, positive + neutral + negative);
  const pos = Math.round((positive / total) * 100);
  const neu = Math.round((neutral / total) * 100);
  const neg = Math.max(0, 100 - pos - neu);
  const card = container.createDiv({ cls: "tradir-chart-card" });
  card.createEl("h3", { text: "감성 분포" });
  const donut = card.createDiv({ cls: "tradir-donut" });
  donut.setAttr("style", `--pos-end:${pos}%;--neu-end:${pos + neu}%`);
  donut.setAttr("title", `긍정 ${positive}건 (${pos}%), 중립 ${neutral}건 (${neu}%), 부정 ${negative}건 (${neg}%)`);
  donut.createDiv({ cls: "tradir-donut-hole", text: `${pos}%` });
  const legend = card.createDiv({ cls: "tradir-donut-legend" });
  legend.createEl("span", { text: `긍정 ${pos}%` });
  legend.createEl("span", { text: `중립 ${neu}%` });
  legend.createEl("span", { text: `부정 ${neg}%` });
  addChartTooltip(card, [
    ["긍정", `${positive}건 · ${pos}%`],
    ["중립", `${neutral}건 · ${neu}%`],
    ["부정", `${negative}건 · ${neg}%`],
  ]);
}

function addChartTooltip(container: HTMLElement, rows: Array<[string, string]>) {
  const tooltip = container.createDiv({ cls: "tradir-chart-tooltip" });
  rows.forEach(([label, value]) => {
    const row = tooltip.createDiv();
    row.createEl("span", { text: label });
    row.createEl("strong", { text: value });
  });
}

function categoryCounts(articles: AnalyzedArticle[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  articles.forEach((article) => {
    const key = article.category || "trading_other";
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
}

function addStory(container: HTMLElement, article: AnalyzedArticle, index: number) {
  const sentiment = effectiveSentiment(article);
  const importance = effectiveImportance(article);
  const story = container.createDiv({ cls: `tradir-story is-${sentiment}` });
  story.setAttr("style", `--tradir-category-color:${categoryColor(article.category)}`);
  const rank = story.createDiv({ cls: "tradir-story-rank", text: String(index + 1) });
  const content = story.createDiv({ cls: "tradir-story-content" });
  const meta = content.createDiv({ cls: "tradir-story-meta" });
  meta.createSpan({ text: categoryLabel(article.category) });
  meta.createSpan({ text: importanceStars(importance) });
  meta.createSpan({ text: sentimentLabel(sentiment) });
  const title = content.createEl("h4");
  if (article.url) {
    const link = title.createEl("a", { text: article.title });
    link.setAttr("href", article.url);
    link.setAttr("target", "_blank");
    link.setAttr("rel", "noopener");
  } else {
    title.setText(article.title);
  }
  if (article.originalTitle && article.originalTitle !== article.title) {
    content.createEl("div", { cls: "tradir-original-title", text: article.originalTitle });
  }
  content.createEl("p", { text: article.summary || article.description || "요약이 없습니다." });
  const tags = content.createDiv({ cls: "tradir-story-tags" });
  article.tags.slice(0, 6).forEach((tag) => tags.createEl("span", { text: tag }));
  const side = story.createDiv({ cls: "tradir-story-side" });
  side.createDiv({ cls: "tradir-story-stars", text: importanceStars(importance) });
  side.createDiv({ cls: "tradir-story-date", text: getDatePart(article.publishedAt) || "" });
  side.createEl("button", { cls: "tradir-card-button", text: "☆" });
  const source = side.createDiv({ cls: "tradir-story-source", text: article.source });
  source.setAttr("aria-label", "source");
  rank.setAttr("aria-label", "rank");
}

function addTableHead(table: HTMLTableElement, headers: string[]) {
  const thead = table.createEl("thead");
  const row = thead.createEl("tr");
  headers.forEach((header) => row.createEl("th", { text: header }));
}

function addCategoryTableRows(table: HTMLTableElement, articles: AnalyzedArticle[]) {
  const tbody = table.createEl("tbody");
  const groups = new Map<string, AnalyzedArticle[]>();
  for (const article of articles) {
    const key = article.category || "trading_other";
    groups.set(key, [...(groups.get(key) || []), article]);
  }
  Array.from(groups.entries())
    .sort((a, b) => b[1].length - a[1].length)
    .forEach(([category, group]) => {
      const avg = group.reduce((sum, article) => sum + effectiveImportance(article), 0) / group.length;
      const row = tbody.createEl("tr");
      row.createEl("td", { text: categoryLabel(category) });
      row.createEl("td", { text: String(group.length) });
      row.createEl("td", { text: avg.toFixed(1) });
    });
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

function getProviderPresets(provider: AiProvider): ModelPreset[] {
  if (provider === "none") return [];
  return MODEL_PRESETS.filter((preset) => preset.provider === provider);
}

function findPreset(provider: AiProvider, model: string): ModelPreset | undefined {
  return getProviderPresets(provider).find((preset) => preset.model === model);
}

function formatPresetLabel(preset: ModelPreset): string {
  return `${preset.label} - $${formatUsd(preset.inputUsdPerMTok)}/$${formatUsd(preset.outputUsdPerMTok)} per 1M`;
}

function formatPresetDetails(preset?: ModelPreset): string {
  if (!preset) return "Custom model. Check the provider pricing page for current token cost and availability.";
  return `${preset.note} Price: $${formatUsd(preset.inputUsdPerMTok)} input / $${formatUsd(preset.outputUsdPerMTok)} output per 1M tokens. Source: ${preset.source}.`;
}

function formatUsd(value: number): string {
  return value >= 1 ? value.toFixed(2) : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function formatKeyDiagnostic(key: string): string {
  const normalized = normalizeApiKey(key);
  if (!normalized) return "No API key stored.";
  const prefix = normalized.slice(0, 8);
  const suffix = normalized.slice(-4);
  const masked = normalized.includes("*") ? " masked value detected." : "";
  return `Stored key shape: ${prefix}...${suffix}, length ${normalized.length}.${masked}`;
}

function likelyKeyProviderWarning(provider: AiProvider, key: string): string {
  const trimmed = normalizeApiKey(key);
  if (provider === "none" || !trimmed) return "";
  if (trimmed.includes("*")) {
    return "The API key looks masked. Create a new full secret key in the provider dashboard and paste the full value.";
  }
  if (provider === "openai" && !trimmed.startsWith("sk-")) {
    return "OpenAI selected, but the key does not look like an OpenAI API key. Check provider and key.";
  }
  if (provider === "openai" && trimmed.startsWith("sk-proj-") && trimmed.length < 90) {
    return "The OpenAI project key looks too short. Paste the full secret key value, not the masked dashboard preview.";
  }
  if (provider === "anthropic" && !trimmed.startsWith("sk-ant-")) {
    return "Anthropic selected, but the key does not look like a Claude API key. OpenAI keys will return 401 here.";
  }
  if (provider === "gemini" && trimmed.startsWith("sk-")) {
    return "Gemini selected, but the key looks like an OpenAI or Anthropic key. Use a Google AI Studio API key.";
  }
  return "";
}

function normalizeApiKey(input: string): string {
  return input.replace(/[\s\u200B-\u200D\uFEFF]/g, "");
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
  const text = `${item.title} ${item.description}`;
  return {
    ...item,
    originalTitle: item.title,
    originalDescription: item.description,
    summary: item.description || "RSS item collected without AI analysis.",
    category: inferCategory(text),
    importance: inferImportance(text),
    sentiment: inferSentiment(text),
    tags: buildTags(text),
  };
}

function effectiveSentiment(article: AnalyzedArticle): Sentiment {
  if (article.sentiment !== "neutral") return article.sentiment;
  const inferred = inferSentiment(`${article.title} ${article.originalTitle} ${article.summary} ${article.description}`);
  return inferred !== "neutral" ? inferred : article.sentiment;
}

function effectiveImportance(article: AnalyzedArticle): number {
  const inferred = inferImportance(`${article.title} ${article.originalTitle} ${article.summary} ${article.description}`);
  return article.importance === 3 ? Math.max(article.importance, inferred) : article.importance;
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
    "Return only valid JSON with this exact top-level shape: {\"articles\":[...]}",
    "Each articles item must include: url, title, summary, category, importance, sentiment, tags.",
    `Translate title and summary into ${language}. Preserve the original source meaning and do not leave title in English unless it is a company, ticker, or product name.`,
    "category must be one exact enum string: crypto, us_stock, kr_stock, macro, rates, fx, commodity, regulation, trading_other.",
    "importance must be an integer from 1 to 5. sentiment must be one exact English enum string: positive, neutral, negative.",
    "",
    JSON.stringify(compact),
  ].join("\n");
}

function parseAiResults(rawText: string): AiArticleResult[] {
  const trimmed = rawText.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const direct = tryParseJson(trimmed);
  if (Array.isArray(direct)) return direct as AiArticleResult[];
  if (isObject(direct) && Array.isArray(direct.articles)) return direct.articles as AiArticleResult[];

  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    const objectParsed = tryParseJson(objectMatch[0]);
    if (isObject(objectParsed) && Array.isArray(objectParsed.articles)) return objectParsed.articles as AiArticleResult[];
  }

  const match = trimmed.match(/\[[\s\S]*\]/);
  if (!match) return [];
  const parsed = tryParseJson(match[0]);
  return Array.isArray(parsed) ? parsed as AiArticleResult[] : [];
}

function readAiValue(item: AiArticleResult, keys: string[]): unknown {
  for (const key of keys) {
    const value = item[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function readAiString(item: AiArticleResult, keys: string[]): string {
  const value = readAiValue(item, keys);
  return cleanText(typeof value === "string" ? value : String(value || ""));
}

function readAiTags(item: AiArticleResult): string[] | null {
  const value = readAiValue(item, ["tags", "keywords", "tag"]);
  if (Array.isArray(value)) {
    const tags = value.map(cleanText).filter(Boolean).slice(0, 8);
    return tags.length ? tags : null;
  }
  if (typeof value === "string") {
    const tags = value.split(/[,#/]/).map(cleanText).filter(Boolean).slice(0, 8);
    return tags.length ? tags : null;
  }
  return null;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractOpenAIChatText(json: Record<string, unknown>): string {
  const choices = Array.isArray(json.choices) ? json.choices : [];
  const first = choices[0];
  if (!isObject(first) || !isObject(first.message)) return "";
  return typeof first.message.content === "string" ? first.message.content : "";
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

function priorityStoryBlocks(articles: AnalyzedArticle[]): string[] {
  if (!articles.length) return ["_우선 확인 뉴스가 없습니다._"];

  const lines: string[] = [];
  articles.forEach((article, index) => {
    lines.push(
      `### ${index + 1}. ${sentimentIcon(article.sentiment)} ${article.title}`,
      "",
      `- **분류**: ${categoryLabel(article.category)}`,
      `- **중요도**: ${importanceStars(article.importance)} (${article.importance}/5)`,
      `- **감성**: ${sentimentLabel(article.sentiment)}`,
      `- **출처**: ${article.source}`,
      article.url ? `- **원문**: [열기](${article.url})` : "- **원문**: 없음",
      "",
      article.summary || article.description || "_요약이 없습니다._",
      "",
      "---",
      "",
    );
  });
  return lines;
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

function categoryColor(category: string): string {
  const colors: Record<string, string> = {
    all: "var(--interactive-accent)",
    crypto: "var(--color-yellow, #d6a100)",
    us_stock: "var(--color-blue, #4f8cff)",
    kr_stock: "var(--color-green, #3fb950)",
    macro: "var(--color-purple, #a371f7)",
    rates: "var(--color-cyan, #39c5cf)",
    fx: "var(--color-orange, #f59e0b)",
    commodity: "var(--color-red, #f05252)",
    regulation: "var(--color-pink, #ec4899)",
    trading_other: "var(--text-muted)",
  };
  return colors[category] || colors.trading_other;
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

function tableCell(value: string): string {
  return cleanText(value).replace(/\|/g, "\\|") || "-";
}

function assertOk(status: number, provider: string, body?: string) {
  if (status < 200 || status >= 300) {
    const detail = summarizeProviderError(body);
    const auth = status === 401 ? providerAuthHint(provider) : "";
    throw new Error(`${provider} HTTP ${status}${detail ? `: ${detail}` : ""}${auth ? ` ${auth}` : ""}`);
  }
}

function providerAuthHint(provider: string): string {
  if (provider === "OpenAI") return "Check that the key is active, belongs to an API project with billing enabled, and is entered under OpenAI.";
  if (provider === "Anthropic") return "Check that the key starts with sk-ant-, is active, and is entered under Anthropic Claude.";
  if (provider === "Gemini") return "Check that the Google AI Studio key is active and is entered under Google Gemini.";
  return "Check provider selection and API key.";
}

function summarizeProviderError(body?: string): string {
  if (!body) return "";
  const parsed = tryParseJson(body);
  if (isObject(parsed)) {
    const error = parsed.error;
    if (isObject(error) && typeof error.message === "string") return error.message.slice(0, 180);
    if (typeof parsed.message === "string") return parsed.message.slice(0, 180);
  }
  return cleanText(body).slice(0, 180);
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

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

function dedupeAnalyzedByUrl(items: AnalyzedArticle[]): AnalyzedArticle[] {
  const seen = new Set<string>();
  const out: AnalyzedArticle[] = [];
  for (const item of items) {
    const keys = articleIdentityKeys(item);
    if (keys.some((key) => seen.has(key))) continue;
    keys.forEach((key) => seen.add(key));
    out.push(item);
  }
  return out;
}

function articleIdentityKeys(item: AnalyzedArticle): string[] {
  return Array.from(new Set([
    normalizeUrlKey(item.url),
    titleFingerprint(item.originalTitle),
    titleFingerprint(item.title),
    item.id ? `id:${item.id}` : "",
  ].filter(Boolean)));
}

function normalizeUrlKey(url: string): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "ref", "fbclid", "gclid"].forEach((key) => parsed.searchParams.delete(key));
    parsed.hash = "";
    return `url:${parsed.origin}${parsed.pathname.replace(/\/$/, "")}${parsed.search}`;
  } catch {
    return `url:${url.replace(/[?#].*$/, "").replace(/\/$/, "")}`;
  }
}

function titleFingerprint(title: string): string {
  const normalized = cleanText(title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .slice(0, 120);
  return normalized.length >= 12 ? `title:${normalized}` : "";
}

function parseStoredArticle(text: string, file: TFile): AnalyzedArticle | null {
  const frontmatter = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!frontmatter) return null;
  const yaml = frontmatter[1];
  if (readYamlScalar(yaml, "type") !== "trading-news-article") return null;

  const title = cleanText(readYamlScalar(yaml, "title") || file.basename);
  const source = cleanText(readYamlScalar(yaml, "source") || "Stored note");
  const category = cleanText(readYamlScalar(yaml, "category") || inferCategory(text));
  const url = cleanText(readYamlScalar(yaml, "url"));
  const publishedAt = cleanText(readYamlScalar(yaml, "published_at") || new Date(file.stat.mtime).toISOString());
  const originalTitle = cleanText(readYamlScalar(yaml, "original_title") || extractStoredSection(text, "원문 제목") || title);
  const summary = cleanText(extractStoredSummary(text) || extractStoredSection(text, "RSS 발췌") || title);
  const description = cleanText(extractStoredSection(text, "RSS 발췌") || summary);
  const tags = parseYamlTags(readYamlRaw(yaml, "tags")).filter((tag) => !["trading-news", category].includes(tag)).slice(0, 8);
  const analysisText = `${title} ${originalTitle} ${summary} ${description}`;
  const restoredSentiment = normalizeSentiment(readYamlScalar(yaml, "sentiment"));
  const inferredSentiment = inferSentiment(analysisText);
  const restoredImportance = clampImportance(readYamlScalar(yaml, "importance"));
  const inferredImportance = inferImportance(analysisText);

  return {
    id: hashString(`${source}:${url || title}`),
    source,
    title,
    url,
    description,
    publishedAt,
    originalTitle,
    originalDescription: description,
    summary,
    category,
    importance: restoredImportance === 3 ? Math.max(restoredImportance, inferredImportance) : restoredImportance,
    sentiment: restoredSentiment === "neutral" && inferredSentiment !== "neutral" ? inferredSentiment : restoredSentiment,
    tags: tags.length ? tags : buildTags(`${title} ${summary}`),
  };
}

function filterArticles(articles: AnalyzedArticle[], query: string): AnalyzedArticle[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return articles;
  return articles.filter((article) => {
    const haystack = [
      article.title,
      article.originalTitle,
      article.summary,
      article.description,
      article.source,
      categoryLabel(article.category),
      ...article.tags,
    ].join(" ").toLowerCase();
    return haystack.includes(normalized);
  });
}

function readYamlRaw(yaml: string, key: string): string {
  const match = yaml.match(new RegExp(`^${escapeRegExp(key)}:\\s*(.*)$`, "m"));
  return match ? match[1].trim() : "";
}

function readYamlScalar(yaml: string, key: string): string {
  const raw = readYamlRaw(yaml, key);
  if (!raw) return "";
  if ((raw.startsWith("\"") && raw.endsWith("\"")) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }
  return raw;
}

function parseYamlTags(raw: string): string[] {
  if (!raw) return [];
  const quoted = Array.from(raw.matchAll(/"([^"]+)"/g)).map((match) => match[1]);
  if (quoted.length) return quoted.map(cleanText).filter(Boolean);
  return raw
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .map((tag) => cleanText(tag.replace(/^#/, "")))
    .filter(Boolean);
}

function extractStoredSummary(text: string): string {
  const match = text.match(/>\s*\[!abstract\][^\n]*\n>\s*([^\n]+)/);
  return match ? match[1].replace(/^>\s*/, "").trim() : "";
}

function extractStoredSection(text: string, heading: string): string {
  const match = text.match(new RegExp(`##\\s+${escapeRegExp(heading)}\\s+([\\s\\S]*?)(?:\\n##\\s+|\\n태그:|$)`));
  return match ? match[1].trim() : "";
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function inferImportance(text: string): number {
  const lower = text.toLowerCase();
  let score = 2;
  if (/(breaking|urgent|surge|plunge|crash|rally|record|breakout|all-time|ath|war|attack|tariff|sanction|lawsuit|sec|fed|fomc|inflation|rate cut|rate hike|etf|approval|최고|신고가|돌파|급등|급락|승인|경고)/.test(lower)) score += 2;
  if (/(bitcoin|ethereum|nasdaq|s&p|dow|oil|gold|dollar|treasury|yield|cpi|jobs|earnings)/.test(lower)) score += 1;
  if (/(minor|preview|opinion|explainer|recap)/.test(lower)) score -= 1;
  return Math.min(5, Math.max(1, score));
}

function inferSentiment(text: string): Sentiment {
  const lower = text.toLowerCase();
  const positive = /(surge|rally|gain|gains|rise|rises|rose|jump|jumps|record high|all-time high|ath|approval|approved|beat|beats|bull|bullish|optimis|inflow|growth|recover|recovery|soar|soars|breakout|breaks above|상승|급등|호재|승인|회복|반등|강세|긍정|최고|신고가|돌파|개선|완화|유입|랠리)/.test(lower);
  const negative = /(drop|drops|fall|falls|fell|slump|plunge|crash|loss|losses|miss|risk|warning|lawsuit|ban|hack|war|attack|tariff|recession|bear|bearish|outflow|하락|급락|악재|경고|소송|금지|침체|부정|위험|유출|약세|충돌)/.test(lower);
  if (positive && !negative) return "positive";
  if (negative && !positive) return "negative";
  if (positive && negative) return "neutral";
  return "neutral";
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

function normalizeCategory(value: unknown): string {
  const normalized = cleanText(String(value || "")).toLowerCase().replace(/\s+/g, "_").replace(/[-/]+/g, "_");
  const categories: Record<string, string> = {
    crypto: "crypto",
    cryptocurrency: "crypto",
    coin: "crypto",
    "암호화폐": "crypto",
    "암호화폐_코인": "crypto",
    "코인": "crypto",
    us_stock: "us_stock",
    stocks: "us_stock",
    equities: "us_stock",
    "미국_주식": "us_stock",
    kr_stock: "kr_stock",
    korean_stock: "kr_stock",
    "한국_주식": "kr_stock",
    macro: "macro",
    economy: "macro",
    "매크로": "macro",
    "경제": "macro",
    rates: "rates",
    bonds: "rates",
    "금리": "rates",
    "금리_채권": "rates",
    "채권": "rates",
    fx: "fx",
    forex: "fx",
    currency: "fx",
    "환율": "fx",
    "환율_외환": "fx",
    "외환": "fx",
    commodity: "commodity",
    commodities: "commodity",
    "원자재": "commodity",
    regulation: "regulation",
    policy: "regulation",
    "규제": "regulation",
    "규제_정책": "regulation",
    "정책": "regulation",
    trading_other: "trading_other",
    other: "trading_other",
    "기타": "trading_other",
  };
  return categories[normalized] || inferCategory(normalized);
}

function normalizeSentiment(value: unknown): Sentiment {
  const normalized = cleanText(String(value || "")).toLowerCase();
  if (["positive", "bullish", "긍정", "강세", "호재", "상승"].some((token) => normalized.includes(token))) return "positive";
  if (["negative", "bearish", "부정", "약세", "악재", "하락"].some((token) => normalized.includes(token))) return "negative";
  if (["neutral", "mixed", "중립", "혼조", "보합"].some((token) => normalized.includes(token))) return "neutral";
  return "neutral";
}

function clampImportance(value: unknown): number {
  const normalized = cleanText(String(value || "")).toLowerCase();
  if (/(very high|critical|highest|매우 높|최상|긴급)/.test(normalized)) return 5;
  if (/(high|important|높|중요)/.test(normalized)) return 4;
  if (/(medium|moderate|보통|중간)/.test(normalized)) return 3;
  if (/(low|minor|낮|낮음)/.test(normalized)) return 2;
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
