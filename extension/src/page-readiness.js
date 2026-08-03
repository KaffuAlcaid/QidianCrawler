(function defineQidianCrawlerPageReadiness(root) {
  "use strict";


  const extractor = root.QidianCrawlerExtractor;
  if (!extractor || typeof extractor.extract !== "function") {
    throw new Error("QidianCrawlerExtractor 必须先于 page-readiness.js 加载。");
  }

  const DEFAULT_TIMEOUT_MS = 8000;
  const DEFAULT_STABILITY_MS = 500;
  const MUTATION_THROTTLE_MS = 80;

  function normalizeDuration(value, fallback) {
    if (value === undefined || value === null) {
      return fallback;
    }
    const duration = Number(value);
    if (!Number.isFinite(duration) || duration < 0) {
      return fallback;
    }
    return Math.floor(duration);
  }

  function hasRequiredNext(result, requireNext) {
    return (
      !requireNext || Boolean(result?.nextNavigationUrl || result?.nextUrl)
    );
  }

  function contentSignature(result) {
    if (!result?.ok) {
      return null;
    }
    // 只比较采集结果，避免无关页面组件反复重置正文稳定窗口。
    return JSON.stringify([
      result.bookId || "",
      result.bookTitle || "",
      result.chapterId || "",
      result.title || "",
      Array.isArray(result.paragraphs) ? result.paragraphs : [],
    ]);
  }

  function unstableContentFailure(result) {
    return {
      ok: false,
      reason: "content-missing",
      error: "章节正文仍在加载，尚未达到稳定状态。",
      adapterId: result?.adapterId || "qidian",
      adapterVersion: result?.adapterVersion || null,
      selectorDiagnostics: result?.selectorDiagnostics || null,
    };
  }

  function wait(documentNode, pageUrl, options = {}) {
    const requireNext = options.requireNext === true;
    const timeoutMs = normalizeDuration(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    const stabilityMs = normalizeDuration(
      options.stabilityMs,
      DEFAULT_STABILITY_MS
    );
    let lastResult = extractor.extract(documentNode, pageUrl);

    if (!lastResult?.ok && lastResult?.reason !== "content-missing") {
      return Promise.resolve(lastResult);
    }

    const MutationObserverConstructor =
      documentNode?.defaultView?.MutationObserver || root.MutationObserver;
    const observationRoot = documentNode?.documentElement || documentNode;
    const canObserve =
      typeof MutationObserverConstructor === "function" &&
      Boolean(observationRoot);
    if (!canObserve && !lastResult?.ok) {
      return Promise.resolve(lastResult);
    }

    return new Promise((resolve) => {
      let settled = false;
      let timeoutTimer = null;
      let throttleTimer = null;
      let stabilityTimer = null;
      let observer = null;
      let candidateSignature = null;
      let stableSignature = null;

      const cleanup = () => {
        observer?.disconnect();
        observer = null;
        if (timeoutTimer !== null) {
          root.clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        if (throttleTimer !== null) {
          root.clearTimeout(throttleTimer);
          throttleTimer = null;
        }
        if (stabilityTimer !== null) {
          root.clearTimeout(stabilityTimer);
          stabilityTimer = null;
        }
      };

      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(lastResult);
      };

      const clearCandidate = () => {
        candidateSignature = null;
        stableSignature = null;
        if (stabilityTimer !== null) {
          root.clearTimeout(stabilityTimer);
          stabilityTimer = null;
        }
      };

      const updateCandidate = () => {
        if (settled) {
          return;
        }
        if (!lastResult?.ok) {
          clearCandidate();
          if (lastResult?.reason !== "content-missing") {
            finish();
          }
          return;
        }

        const signature = contentSignature(lastResult);
        if (signature === stableSignature) {
          if (hasRequiredNext(lastResult, requireNext)) {
            finish();
          }
          return;
        }
        if (signature === candidateSignature && stabilityTimer !== null) {
          return;
        }

        candidateSignature = signature;
        stableSignature = null;
        if (stabilityTimer !== null) {
          root.clearTimeout(stabilityTimer);
        }
        stabilityTimer = root.setTimeout(() => {
          stabilityTimer = null;
          if (settled) {
            return;
          }
          lastResult = extractor.extract(documentNode, pageUrl);
          if (!lastResult?.ok) {
            updateCandidate();
            return;
          }
          const latestSignature = contentSignature(lastResult);
          if (latestSignature !== candidateSignature) {
            updateCandidate();
            return;
          }
          stableSignature = latestSignature;
          if (!canObserve || hasRequiredNext(lastResult, requireNext)) {
            finish();
          }
        }, stabilityMs);
      };

      const extractLatest = () => {
        if (settled) {
          return;
        }
        lastResult = extractor.extract(documentNode, pageUrl);
        updateCandidate();
      };

      const scheduleExtraction = () => {
        if (settled || throttleTimer !== null) {
          return;
        }
        throttleTimer = root.setTimeout(() => {
          throttleTimer = null;
          extractLatest();
        }, MUTATION_THROTTLE_MS);
      };

      if (canObserve) {
        observer = new MutationObserverConstructor(scheduleExtraction);
        observer.observe(observationRoot, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
        });
      }

      timeoutTimer = root.setTimeout(() => {
        if (settled) {
          return;
        }
        if (throttleTimer !== null) {
          root.clearTimeout(throttleTimer);
          throttleTimer = null;
        }
        lastResult = extractor.extract(documentNode, pageUrl);
        if (
          lastResult?.ok &&
          contentSignature(lastResult) !== stableSignature
        ) {
          lastResult = unstableContentFailure(lastResult);
        }
        finish();
      }, timeoutMs);

      updateCandidate();
    });
  }

  root.QidianCrawlerPageReadiness = Object.freeze({
    DEFAULT_TIMEOUT_MS,
    DEFAULT_STABILITY_MS,
    MUTATION_THROTTLE_MS,
    wait,
  });
})(globalThis);
