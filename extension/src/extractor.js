(function defineQidianCrawlerExtractor(root) {
  "use strict";


  const core = root.QidianCrawlerCore;
  if (!core) {
    throw new Error("QidianCrawlerCore 必须先于 extractor.js 加载。");
  }

  const ADAPTER_ID = "qidian";
  const ADAPTER_VERSION = "qidian-dom-v1";

  function stripAsciiEdges(value) {
    return String(value || "").replace(
      /^[\u0009-\u000d\u0020]+|[\u0009-\u000d\u0020]+$/g,
      ""
    );
  }

  function compact(value) {
    return core.compact(value);
  }

  function resolveHref(node, pageUrl) {
    if (!node) {
      return null;
    }
    const value = node?.getAttribute?.("href") || "";
    if (!value) {
      return null;
    }
    try {
      return new URL(value, pageUrl).href;
    } catch {
      return null;
    }
  }

  function isVisible(node, documentNode) {
    if (!node) {
      return false;
    }
    try {
      const view = documentNode.defaultView;
      let current = node;
      while (current && current.nodeType === 1) {
        if (
          current.hidden ||
          current.getAttribute?.("aria-hidden") === "true"
        ) {
          return false;
        }
        const inlineStyle = String(
          current.getAttribute?.("style") || ""
        )
          .toLowerCase()
          .replace(/\s+/g, "");
        if (
          inlineStyle.includes("display:none") ||
          inlineStyle.includes("visibility:hidden") ||
          inlineStyle.includes("visibility:collapse")
        ) {
          return false;
        }
        const style = view?.getComputedStyle?.(current);
        if (
          style &&
          (style.display === "none" ||
            style.visibility === "hidden" ||
            style.visibility === "collapse" ||
            Number.parseFloat(style.opacity || "1") === 0)
        ) {
          return false;
        }
        current = current.parentElement;
      }

      if (view && typeof node.getBoundingClientRect === "function") {
        const rectangle = node.getBoundingClientRect();
        if (!rectangle || rectangle.width < 2 || rectangle.height < 2) {
          return false;
        }
        const viewportWidth =
          Number(view.innerWidth) ||
          documentNode.documentElement?.clientWidth ||
          0;
        const viewportHeight =
          Number(view.innerHeight) ||
          documentNode.documentElement?.clientHeight ||
          0;
        if (
          viewportWidth > 0 &&
          viewportHeight > 0 &&
          (rectangle.bottom <= 0 ||
            rectangle.right <= 0 ||
            rectangle.top >= viewportHeight ||
            rectangle.left >= viewportWidth)
        ) {
          return false;
        }
      }
      return true;
    } catch {
      return true;
    }
  }

  function isPresentedOnTop(node, documentNode) {
    const view = documentNode.defaultView;
    if (
      !view ||
      typeof documentNode.elementFromPoint !== "function" ||
      typeof node?.getBoundingClientRect !== "function"
    ) {
      return true;
    }
    try {
      const rectangle = node.getBoundingClientRect();
      const points = [
        [rectangle.left + rectangle.width / 2, rectangle.top + rectangle.height / 2],
        [rectangle.left + rectangle.width / 4, rectangle.top + rectangle.height / 4],
        [rectangle.right - rectangle.width / 4, rectangle.bottom - rectangle.height / 4],
      ];
      return points.some(([x, y]) => {
        const topmost = documentNode.elementFromPoint(x, y);
        return Boolean(
          topmost &&
            (topmost === node ||
              node.contains?.(topmost))
        );
      });
    } catch {
      return false;
    }
  }

  function detectChallenge(documentNode) {
    if (/安全验证|人机验证|访问验证|验证码/.test(documentNode.title || "")) {
      return { detected: true, indicator: "document-title" };
    }
    const selectors = [
      'iframe[src*="captcha"]',
      'iframe[src*="verify"]',
      '[class*="geetest"]',
      '[class*="yidun"]',
      '[class*="captcha"]',
      '[id*="captcha"]',
      '[id*="verify"]',
    ];
    for (const selector of selectors) {
      const node = [...documentNode.querySelectorAll(selector)].find((item) =>
        isVisible(item, documentNode) && isPresentedOnTop(item, documentNode)
      );
      if (node) {
        return { detected: true, indicator: selector };
      }
    }
    const headingText = [...documentNode.querySelectorAll("h1, h2, [role='heading']")]
      .filter(
        (node) =>
          isVisible(node, documentNode) && isPresentedOnTop(node, documentNode)
      )
      .slice(0, 10)
      .map((node) => compact(node.textContent))
      .join(" ");
    if (/请完成验证|安全验证|拖动.*滑块/.test(headingText)) {
      return { detected: true, indicator: "visible-heading" };
    }
    return { detected: false, indicator: null };
  }

  function failure(reason, error, extra = {}) {
    return {
      ok: false,
      reason,
      error,
      adapterId: ADAPTER_ID,
      adapterVersion: ADAPTER_VERSION,
      ...extra,
    };
  }

  function extract(documentNode, pageUrl) {
    if (!documentNode || typeof documentNode.querySelector !== "function") {
      return failure("invalid-document", "页面文档不可用。");
    }
    const challenge = detectChallenge(documentNode);
    if (challenge.detected) {
      return failure(
        "challenge-page",
        "检测到安全验证页面，请手动完成验证后重试。",
        { challengeIndicator: challenge.indicator }
      );
    }

    if (!core.isSupportedChapterUrl(pageUrl)) {
      return failure(
        "unsupported-page",
        "当前页面不是受支持的起点章节地址。"
      );
    }

    const normalizedPageUrl = core.normalizeUrl(pageUrl);
    const pathMatch = new URL(normalizedPageUrl).pathname.match(
      /\/chapter\/(\d+)\/(\d+)\/?$/
    );
    const bookId = pathMatch[1];
    const chapterId = pathMatch[2];
    const expectedBookPath = `/book/${bookId}/`;

    const matchesExpectedBook = (node) => {
      try {
        return new URL(resolveHref(node, pageUrl)).pathname === expectedBookPath;
      } catch {
        return false;
      }
    };
    const preferredBookLinks = [
      ...documentNode.querySelectorAll('a.text-s-gray-900[href*="/book/"]'),
    ];
    const bookLink =
      preferredBookLinks.find(matchesExpectedBook) ||
      [...documentNode.querySelectorAll('a[href*="/book/"]')].find(
        matchesExpectedBook
      );
    let bookTitle = compact(bookLink?.textContent);
    let bookSelector = bookLink?.matches?.("a.text-s-gray-900")
      ? "a.text-s-gray-900[href*='/book/']"
      : bookLink
        ? "a[href*='/book/']"
        : null;
    if (!bookTitle) {
      const bookMeta = documentNode.querySelector(
        'meta[property="og:novel:book_name"], meta[name="og:novel:book_name"]'
      );
      bookTitle = compact(bookMeta?.content);
      bookSelector = bookTitle ? "meta[og:novel:book_name]" : null;
    }
    if (!bookTitle) {
      const titleMatch = String(documentNode.title || "").match(/《([^》]+)》/);
      bookTitle = compact(titleMatch?.[1]);
      bookSelector = bookTitle ? "document.title" : null;
    }
    if (!bookTitle) {
      bookTitle = `book_${bookId}`;
      bookSelector = "fallback-book-id";
    }

    const contentMain =
      documentNode.getElementById(`c-${chapterId}`) ||
      documentNode.querySelector('main[id^="c-"], main.content');
    const chapterRoot = contentMain?.closest?.(".print") || documentNode;
    const titleNode =
      chapterRoot.querySelector?.("h1.title") ||
      documentNode.querySelector("h1.title");
    let title = "";
    let titleSelector = null;
    if (titleNode) {
      const titleClone = titleNode.cloneNode(true);
      titleClone
        .querySelectorAll(".review, .review-count, .review-icon")
        .forEach((node) => node.remove());
      title = compact(titleClone.textContent);
      titleSelector = "h1.title";
    }
    if (!title) {
      title = compact(String(documentNode.title || "").split("_《", 1)[0]);
      titleSelector = title ? "document.title" : null;
    }
    if (!title) {
      title = `chapter_${chapterId}`;
      titleSelector = "fallback-chapter-id";
    }

    let contentSelector = contentMain
      ? "main#c-{chapterId} span.content-text"
      : "main span.content-text";
    let contentNodes = contentMain
      ? [...contentMain.querySelectorAll("span.content-text")]
      : [...documentNode.querySelectorAll("main span.content-text")];
    if (contentNodes.length === 0) {
      contentSelector = "span.content-text";
      contentNodes = [...documentNode.querySelectorAll("span.content-text")].filter(
        (node) => !node.closest("h1, h2, header, nav")
      );
    }
    const paragraphs = contentNodes
      .map((node) => stripAsciiEdges(node.textContent))
      .filter(Boolean);
    if (paragraphs.length > 0 && compact(paragraphs[0]) === compact(title)) {
      paragraphs.shift();
    }
    if (paragraphs.length === 0) {
      return failure(
        "content-missing",
        "没有识别到章节正文。请确认正文已经正常显示，而不是验证或错误页面。",
        {
          selectorDiagnostics: {
            book: bookSelector,
            title: titleSelector,
            content: contentSelector,
          },
        }
      );
    }

    const isNextChapterLink = (node) =>
      compact(node.textContent).replace(/\s+/g, "").includes("下一章");
    const preferredLinks = [...documentNode.querySelectorAll("a.nav-btn")];
    const preferredNextLink = preferredLinks.find(isNextChapterLink);
    const nextLink =
      preferredNextLink ||
      [...documentNode.querySelectorAll("a")].find(isNextChapterLink);
    const nextNavigationUrl = resolveHref(nextLink, pageUrl);
    const nextUrl = core.normalizeUrl(nextNavigationUrl) || null;

    return {
      ok: true,
      reason: null,
      adapterId: ADAPTER_ID,
      adapterVersion: ADAPTER_VERSION,
      bookId,
      bookTitle,
      chapterId,
      title,
      paragraphs,
      sourceUrl: normalizedPageUrl,
      nextUrl,
      nextNavigationUrl,
      selectorDiagnostics: {
        book: bookSelector,
        title: titleSelector,
        content: contentSelector,
        next: nextLink
          ? preferredNextLink
            ? "a.nav-btn"
            : "a[text*=下一章]"
          : null,
      },
    };
  }

  root.QidianCrawlerExtractor = Object.freeze({
    ADAPTER_ID,
    ADAPTER_VERSION,
    detectChallenge,
    extract,
  });
})(globalThis);
