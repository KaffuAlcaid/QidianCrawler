(function defineQidianCrawlerCore(root) {
  "use strict";


  const PROJECT_NAME = "QidianCrawler";
  const BATCH_STORAGE_KEY = "qidianCrawler.batch.v1";
  const SETTINGS_STORAGE_KEY = "qidianCrawler.settings.v1";
  const DIAGNOSTICS_CONTEXT_KEY = "qidianCrawler.diagnosticsContext.v1";
  const BATCH_KIND = "qidian-manual-chapter-batch";
  const BATCH_SCHEMA_VERSION = 1;
  const MAX_BATCH_BYTES = 6 * 1024 * 1024;
  const MAX_EXPORT_BASENAME_LENGTH = 72;

  function compact(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeUrl(value) {
    try {
      const url = new URL(String(value || ""));
      url.hash = "";
      url.search = "";
      return url.href.replace(/\/$/, "");
    } catch {
      return "";
    }
  }

  function isSupportedChapterUrl(value) {
    try {
      const url = new URL(String(value || ""));
      const hostname = url.hostname.toLowerCase();
      const isQidian =
        hostname === "qidian.com" || hostname.endsWith(".qidian.com");
      return (
        url.protocol === "https:" &&
        isQidian &&
        /^\/chapter\/\d+\/\d+\/?$/.test(url.pathname)
      );
    } catch {
      return false;
    }
  }

  function safePathSegment(value, fallback = "untitled", maximumLength = 120) {
    let cleaned = String(value || "")
      .normalize("NFC")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/\s+/g, " ")
      .replace(/[. ]+$/g, "")
      .trim();
    cleaned = Array.from(cleaned)
      .slice(0, maximumLength)
      .join("")
      .replace(/[. ]+$/g, "");
    cleaned = cleaned || fallback;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)) {
      cleaned = `_${cleaned}`;
    }
    return cleaned;
  }

  function chapterKey(chapter) {
    const bookId = compact(chapter?.bookId);
    const chapterId = compact(chapter?.chapterId);
    if (bookId && chapterId) {
      return `${bookId}:${chapterId}`;
    }
    return normalizeUrl(chapter?.sourceUrl);
  }

  function normalizeChapter(chapter, capturedAt) {
    const bookId = compact(chapter?.bookId);
    const bookTitle = compact(chapter?.bookTitle) || `book_${bookId || "unknown"}`;
    const chapterId = compact(chapter?.chapterId);
    const title = compact(chapter?.title) || `chapter_${chapterId || "unknown"}`;
    const paragraphs = Array.isArray(chapter?.paragraphs)
      ? chapter.paragraphs
          .map((item) =>
            String(item || "").replace(
              /^[\u0009-\u000d\u0020]+|[\u0009-\u000d\u0020]+$/g,
              ""
            )
          )
          .filter((item) => compact(item).length > 0)
      : [];
    const sourceUrl = normalizeUrl(chapter?.sourceUrl);
    const nextUrl = normalizeUrl(chapter?.nextUrl) || null;
    if (!bookId || !chapterId || !sourceUrl || paragraphs.length === 0) {
      const error = new Error("章节数据不完整，无法加入批次。");
      error.code = "INVALID_CHAPTER";
      throw error;
    }
    return {
      bookId,
      bookTitle,
      chapterId,
      title,
      paragraphs,
      sourceUrl,
      nextUrl,
      capturedAt,
    };
  }

  function createBatch(chapter, now = new Date().toISOString()) {
    const normalized = normalizeChapter(chapter, now);
    return {
      schemaVersion: BATCH_SCHEMA_VERSION,
      kind: BATCH_KIND,
      bookId: normalized.bookId,
      bookTitle: normalized.bookTitle,
      createdAt: now,
      updatedAt: now,
      chapters: [],
    };
  }

  function validateBatch(batch) {
    if (!batch || typeof batch !== "object") {
      return { ok: false, error: "批次不存在。" };
    }
    if (
      batch.schemaVersion !== BATCH_SCHEMA_VERSION ||
      batch.kind !== BATCH_KIND ||
      !compact(batch.bookId) ||
      !compact(batch.bookTitle) ||
      !Array.isArray(batch.chapters)
    ) {
      return { ok: false, error: "批次结构或版本无效。" };
    }
    const keys = new Set();
    for (const chapter of batch.chapters) {
      try {
        const normalized = normalizeChapter(
          chapter,
          chapter.capturedAt || batch.updatedAt || batch.createdAt
        );
        if (normalized.bookId !== String(batch.bookId)) {
          return { ok: false, error: "批次中包含其他书籍的章节。" };
        }
        const key = chapterKey(normalized);
        if (!key || keys.has(key)) {
          return { ok: false, error: "批次中包含重复或无法识别的章节。" };
        }
        keys.add(key);
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return { ok: true, error: null };
  }

  function addChapter(existingBatch, chapter, now = new Date().toISOString()) {
    const normalized = normalizeChapter(chapter, now);
    const batch = existingBatch || createBatch(normalized, now);
    const validation = validateBatch(batch);
    if (!validation.ok) {
      const error = new Error(validation.error);
      error.code = "INVALID_BATCH";
      throw error;
    }
    if (String(batch.bookId) !== normalized.bookId) {
      return { status: "different-book", batch };
    }
    const key = chapterKey(normalized);
    if (batch.chapters.some((item) => chapterKey(item) === key)) {
      return { status: "duplicate", batch };
    }
    const fallbackBookTitle = `book_${normalized.bookId}`;
    const currentBookTitle = compact(batch.bookTitle);
    const updatedBookTitle =
      currentBookTitle === fallbackBookTitle &&
      normalized.bookTitle !== fallbackBookTitle
        ? normalized.bookTitle
        : currentBookTitle || normalized.bookTitle;
    const updatedBatch = {
      ...batch,
      bookTitle: updatedBookTitle,
      updatedAt: now,
      chapters: [...batch.chapters, normalized],
    };
    return { status: "added", batch: updatedBatch };
  }

  function estimateUtf8Bytes(value) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return new TextEncoder().encode(text).byteLength;
  }

  function formatChapterText(batch, chapter) {
    return `《${batch.bookTitle}》\n\n\n${[
      chapter.title,
      ...chapter.paragraphs,
    ].join("\n\n")}\n`;
  }

  function formatChapterJson(
    batch,
    chapter,
    sequence,
    exportedAt = new Date().toISOString()
  ) {
    const payload = {
      schemaVersion: BATCH_SCHEMA_VERSION,
      kind: BATCH_KIND,
      source: "qidian",
      book: {
        id: String(batch.bookId),
        title: batch.bookTitle,
      },
      chapterCount: 1,
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt,
      exportedAt,
      chapters: [
        {
          sequence,
          id: chapter.chapterId,
          title: chapter.title,
          paragraphs: chapter.paragraphs,
          sourceUrl: chapter.sourceUrl,
          nextUrl: chapter.nextUrl,
          capturedAt: chapter.capturedAt,
        },
      ],
    };
    return `${JSON.stringify(payload, null, 2)}\n`;
  }

  function uniqueChapterBasename(chapter, usedBasenames) {
    const fallback = `chapter_${chapter.chapterId}`;
    const initial = safePathSegment(
      chapter.title,
      fallback,
      MAX_EXPORT_BASENAME_LENGTH
    );
    let candidate = initial;
    let suffixNumber = 2;
    while (usedBasenames.has(candidate.toLocaleLowerCase())) {
      const suffix = `-${suffixNumber}`;
      const shortened = safePathSegment(
        initial,
        fallback,
        MAX_EXPORT_BASENAME_LENGTH - Array.from(suffix).length
      );
      candidate = `${shortened}${suffix}`;
      suffixNumber += 1;
    }
    usedBasenames.add(candidate.toLocaleLowerCase());
    return candidate;
  }

  function createChapterExports(
    batch,
    format,
    exportedAt = new Date().toISOString()
  ) {
    const normalizedFormat = String(format || "").toLowerCase();
    if (!new Set(["txt", "json"]).has(normalizedFormat)) {
      throw new Error("导出格式必须是 TXT 或 JSON。");
    }
    const validation = validateBatch(batch);
    if (!validation.ok || batch.chapters.length === 0) {
      throw new Error(validation.error || "批次中没有可导出的章节。");
    }
    const count = batch.chapters.length;
    const baseName = safePathSegment(
      `${batch.bookTitle}-${count}章`,
      `book_${batch.bookId}-${count}章`,
      MAX_EXPORT_BASENAME_LENGTH
    );
    const usedBasenames = new Set();
    return batch.chapters.map((chapter, index) => {
      const fileBaseName = uniqueChapterBasename(chapter, usedBasenames);
      const filename = `${fileBaseName}.${normalizedFormat}`;
      const content =
        normalizedFormat === "json"
          ? formatChapterJson(batch, chapter, index + 1, exportedAt)
          : formatChapterText(batch, chapter);
      return {
        format: normalizedFormat,
        content,
        mimeType:
          normalizedFormat === "json"
            ? "application/json;charset=utf-8"
            : "text/plain;charset=utf-8",
        folderName: baseName,
        filename,
        relativePath: `${PROJECT_NAME}/${baseName}/${filename}`,
        byteLength: estimateUtf8Bytes(content),
        chapterCount: 1,
        fileIndex: index + 1,
        fileCount: count,
      };
    });
  }

  root.QidianCrawlerCore = Object.freeze({
    PROJECT_NAME,
    BATCH_STORAGE_KEY,
    SETTINGS_STORAGE_KEY,
    DIAGNOSTICS_CONTEXT_KEY,
    BATCH_KIND,
    BATCH_SCHEMA_VERSION,
    MAX_BATCH_BYTES,
    MAX_EXPORT_BASENAME_LENGTH,
    compact,
    normalizeUrl,
    isSupportedChapterUrl,
    safePathSegment,
    chapterKey,
    createBatch,
    validateBatch,
    addChapter,
    estimateUtf8Bytes,
    formatChapterText,
    formatChapterJson,
    createChapterExports,
  });
})(globalThis);
