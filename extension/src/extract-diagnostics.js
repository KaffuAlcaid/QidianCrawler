(() => {
  "use strict";


  const extractor = globalThis.QidianCrawlerExtractor;
  if (!extractor) {
    return {
      ok: false,
      reason: "diagnostic-extractor-unavailable",
      error: "章节诊断模块未能加载。",
      adapterId: "qidian",
    };
  }

  const result = extractor.extract(document, location.href);
  if (!result?.ok) {
    return {
      ok: false,
      reason: String(result?.reason || "diagnostic-extraction-failed"),
      error: String(result?.error || "页面没有返回诊断结果。"),
      adapterId: String(result?.adapterId || extractor.ADAPTER_ID || "qidian"),
      adapterVersion: String(
        result?.adapterVersion || extractor.ADAPTER_VERSION || "unknown"
      ),
      challengeIndicator: result?.challengeIndicator || null,
      selectorDiagnostics: result?.selectorDiagnostics || null,
    };
  }

  return {
    ok: true,
    reason: null,
    adapterId: String(result.adapterId || extractor.ADAPTER_ID || "qidian"),
    adapterVersion: String(
      result.adapterVersion || extractor.ADAPTER_VERSION || "unknown"
    ),
    paragraphCount: Array.isArray(result.paragraphs)
      ? result.paragraphs.length
      : 0,
    bookTitleFound: Boolean(result.bookTitle),
    chapterTitleFound: Boolean(result.title),
    nextChapterFound: Boolean(result.nextUrl),
    selectorDiagnostics: result.selectorDiagnostics || null,
  };
})();
