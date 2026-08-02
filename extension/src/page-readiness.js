(function defineQidianCrawlerPageReadiness(root) {
  "use strict";


  const extractor = root.QidianCrawlerExtractor;
  if (!extractor || typeof extractor.extract !== "function") {
    throw new Error("QidianCrawlerExtractor 必须先于 page-readiness.js 加载。");
  }

  const DEFAULT_TIMEOUT_MS = 8000;
  const MUTATION_THROTTLE_MS = 80;

  function normalizeTimeout(value) {
    if (value === undefined || value === null) {
      return DEFAULT_TIMEOUT_MS;
    }
    const timeout = Number(value);
    if (!Number.isFinite(timeout) || timeout < 0) {
      return DEFAULT_TIMEOUT_MS;
    }
    return Math.floor(timeout);
  }

  function needsMorePageData(result, requireNext) {
    if (!result?.ok) {
      return result?.reason === "content-missing";
    }
    if (!requireNext) {
      return false;
    }
    return !result.nextNavigationUrl && !result.nextUrl;
  }

  function wait(documentNode, pageUrl, options = {}) {
    const requireNext = options.requireNext === true;
    const timeoutMs = normalizeTimeout(options.timeoutMs);
    let lastResult = extractor.extract(documentNode, pageUrl);

    if (!needsMorePageData(lastResult, requireNext)) {
      return Promise.resolve(lastResult);
    }

    const MutationObserverConstructor =
      documentNode?.defaultView?.MutationObserver || root.MutationObserver;
    const observationRoot = documentNode?.documentElement || documentNode;
    if (
      typeof MutationObserverConstructor !== "function" ||
      !observationRoot
    ) {
      return Promise.resolve(lastResult);
    }

    return new Promise((resolve) => {
      let settled = false;
      let timeoutTimer = null;
      let throttleTimer = null;
      let observer = null;

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
      };

      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(lastResult);
      };

      const extractLatest = () => {
        if (settled) {
          return;
        }
        lastResult = extractor.extract(documentNode, pageUrl);
        if (!needsMorePageData(lastResult, requireNext)) {
          finish();
        }
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

      observer = new MutationObserverConstructor(scheduleExtraction);
      observer.observe(observationRoot, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      });

      timeoutTimer = root.setTimeout(() => {
        if (settled) {
          return;
        }
        if (throttleTimer !== null) {
          root.clearTimeout(throttleTimer);
          throttleTimer = null;
        }
        lastResult = extractor.extract(documentNode, pageUrl);
        finish();
      }, timeoutMs);
    });
  }

  root.QidianCrawlerPageReadiness = Object.freeze({
    DEFAULT_TIMEOUT_MS,
    MUTATION_THROTTLE_MS,
    wait,
  });
})(globalThis);
