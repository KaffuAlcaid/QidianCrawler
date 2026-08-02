(function prepareOffscreenDownloads() {
  "use strict";


  const MAX_EXPORT_BYTES = 8 * 1024 * 1024;
  const URL_LIFETIME_MS = 15 * 60 * 1000;
  const activeUrls = new Map();

  function normalizeOperationId(value) {
    const operationId = String(value || "")
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .slice(0, 120);
    if (!operationId) {
      throw new Error("下载任务编号无效。");
    }
    return operationId;
  }

  function normalizeMimeType(value) {
    const mimeType = String(value || "").toLowerCase();
    if (mimeType.startsWith("text/plain")) {
      return "text/plain;charset=utf-8";
    }
    if (mimeType.startsWith("application/json")) {
      return "application/json;charset=utf-8";
    }
    throw new Error("自动下载文件类型无效。");
  }

  function release(operationId) {
    const current = activeUrls.get(operationId);
    if (!current) {
      return false;
    }
    clearTimeout(current.timeoutId);
    URL.revokeObjectURL(current.url);
    activeUrls.delete(operationId);
    return true;
  }

  function createDownloadUrl(message) {
    const operationId = normalizeOperationId(message.operationId);
    const mimeType = normalizeMimeType(message.mimeType);
    const content = String(message.content ?? "");
    const blob = new Blob([content], { type: mimeType });
    if (blob.size <= 0 || blob.size > MAX_EXPORT_BYTES) {
      throw new Error("自动下载内容大小无效或超过安全上限。");
    }
    release(operationId);
    const url = URL.createObjectURL(blob);
    const timeoutId = setTimeout(() => release(operationId), URL_LIFETIME_MS);
    activeUrls.set(operationId, { url, timeoutId });
    return { url, byteLength: blob.size };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.target !== "qidian-crawler-offscreen") {
      return false;
    }
    try {
      if (message.type === "create-download-url") {
        sendResponse({ ok: true, ...createDownloadUrl(message) });
        return false;
      }
      if (message.type === "release-download-url") {
        const operationId = normalizeOperationId(message.operationId);
        sendResponse({
          ok: true,
          released: release(operationId),
          remaining: activeUrls.size,
        });
        return false;
      }
      sendResponse({ ok: false, error: "未知的下载准备请求。" });
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return false;
  });
})();
