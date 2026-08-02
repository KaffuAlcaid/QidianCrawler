(function defineQidianCrawlerLogClient(root) {
  "use strict";


  const events = root.QidianCrawlerEvents;
  if (!events) {
    throw new Error("QidianCrawlerEvents 必须先于 log-client.js 加载。");
  }

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }
        if (!response?.ok) {
          const responseError = response?.error;
          const error = new Error(
            typeof responseError === "object"
              ? responseError?.message || "扩展后台没有返回有效结果。"
              : responseError || "扩展后台没有返回有效结果。"
          );
          if (responseError && typeof responseError === "object") {
            error.code = responseError.code || "BACKGROUND_REQUEST_FAILED";
          }
          reject(error);
          return;
        }
        resolve(response);
      });
    });
  }

  function createOperationId(prefix = "op") {
    const randomPart = root.crypto?.randomUUID?.().slice(0, 8) ||
      Math.random().toString(16).slice(2, 10);
    return `${prefix}-${Date.now().toString(36)}-${randomPart}`;
  }

  function consoleEvent(code) {
    const definition = events.get(code);
    const method =
      definition?.level === "ERROR"
        ? "error"
        : definition?.level === "WARN"
          ? "warn"
          : definition?.level === "DEBUG"
            ? "debug"
            : "info";
    console[method](`[${code}] ${definition?.message || "未知事件"}`);
  }

  async function event(
    code,
    details = {},
    operationId = "system",
    component = "popup",
    eventKey = null
  ) {
    if (!events.get(code)) {
      throw new Error(`未知日志事件码：${code}`);
    }
    consoleEvent(code);
    try {
      return await sendMessage({
        type: "log-event",
        code,
        details,
        operationId,
        component,
        eventKey,
      });
    } catch (error) {
      console.error(
        `[LOG_WRITE_FAILED] ${code} 日志未能写入持久存储。`
      );
      return { ok: false, persisted: false };
    }
  }

  function getLogs() {
    return sendMessage({ type: "get-logs" }).then((response) => response.logs);
  }

  function clearLogs() {
    return sendMessage({ type: "clear-logs" });
  }

  function getSettings() {
    return sendMessage({ type: "get-log-settings" }).then(
      (response) => response.settings
    );
  }

  function setDebugEnabled(enabled) {
    return sendMessage({ type: "set-debug", enabled: Boolean(enabled) }).then(
      (response) => response.settings
    );
  }

  function trackDownload(downloadId, metadata) {
    return sendMessage({
      type: "track-download",
      downloadId,
      metadata,
    });
  }

  function getStorageAccessStatus() {
    return sendMessage({ type: "get-storage-access-status" }).then(
      (response) => response.status || null
    );
  }

  function describe(code) {
    return events.get(code);
  }

  root.QidianCrawlerLogClient = Object.freeze({
    sendMessage,
    createOperationId,
    event,
    getLogs,
    clearLogs,
    getSettings,
    setDebugEnabled,
    trackDownload,
    getStorageAccessStatus,
    describe,
  });
})(globalThis);
