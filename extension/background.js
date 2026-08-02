importScripts(
  "src/events.js",
  "src/core.js",
  "src/automation-state.js",
  "src/batch-store.js",
  "src/log-store.js",
  "src/download-tracker.js",
  "src/automation-controller.js"
);


const manifest = chrome.runtime.getManifest();
const storageAdapter =
  QidianCrawlerLogStore.createChromeStorageAdapter(chrome.storage.local);
const logStore = QidianCrawlerLogStore.createLogStore({
  storage: storageAdapter,
  extensionVersion: manifest.version,
});
const batchStorageAdapter = {
  get: (key) => storageAdapter.get(key),
  set: (key, value) => storageAdapter.set(key, value),
  remove: (key) => storageAdapter.remove(key),
  getBytesInUse(key = null) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.getBytesInUse(key, (bytes) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }
        resolve(Number(bytes));
      });
    });
  },
};
const batchStore = QidianCrawlerBatchStore.createBatchStore({
  storage: batchStorageAdapter,
  quotaBytes: Number(
    chrome.storage.local.QUOTA_BYTES ||
      QidianCrawlerBatchStore.DEFAULT_QUOTA_BYTES
  ),
});
const STORAGE_ACCESS_STATUS_KEY = "qidianCrawler.storageAccess.v1";
const LEGACY_KEYS = [
  "qidianAutomationState",
  "qidianAutomationFolderRegistry",
];

function record(code, component, operationId, details = {}, eventKey = null) {
  const definition = QidianCrawlerEvents.get(code);
  const method =
    definition?.level === "ERROR"
      ? "error"
      : definition?.level === "WARN"
        ? "warn"
        : definition?.level === "DEBUG"
          ? "debug"
          : "info";
  console[method](`[${code}] ${definition?.message || "未知事件"}`);
  return logStore.append(code, component, operationId, details, eventKey);
}

function downloadsSearchQuery(query) {
  return new Promise((resolve, reject) => {
    chrome.downloads.search(query, (items) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      resolve(Array.isArray(items) ? items : []);
    });
  });
}

async function downloadsSearch(downloadId) {
  const items = await downloadsSearchQuery({ id: downloadId });
  return items[0] || null;
}

const downloadTracker = QidianCrawlerDownloadTracker.createDownloadTracker({
  storage: storageAdapter,
  search: downloadsSearch,
  record: (code, operationId, details, eventKey) =>
    record(code, "background", operationId, details, eventKey),
});

function trackDownload(downloadId, metadata) {
  return downloadTracker.track(downloadId, metadata);
}

function settleDownload(downloadId, completed, reason) {
  return downloadTracker.settle(downloadId, completed, reason);
}

const automationStorageArea = {
  get(key) {
    return new Promise((resolve, reject) => {
      chrome.storage.session.get(key, (result) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }
        resolve(result || {});
      });
    });
  },
  set(items) {
    return new Promise((resolve, reject) => {
      chrome.storage.session.set(items, () => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }
        resolve();
      });
    });
  },
  remove(key) {
    return new Promise((resolve, reject) => {
      chrome.storage.session.remove(key, () => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }
        resolve();
      });
    });
  },
};

function getTab(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      resolve(tab || null);
    });
  });
}

function navigateTab(tabId, url) {
  return new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, { url }, (tab) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      resolve(tab || null);
    });
  });
}

function extractPage(tabId, options = {}) {
  return new Promise((resolve, reject) => {
    const injection = options.requireNext
      ? {
          target: { tabId },
          files: [
            "src/core.js",
            "src/extractor.js",
            "src/page-readiness.js",
            "src/extract-page-next-ready.js",
          ],
        }
      : {
          target: { tabId },
          files: [
            "src/core.js",
            "src/extractor.js",
            "src/page-readiness.js",
            "src/extract-page-ready.js",
          ],
        };
    chrome.scripting.executeScript(
      injection,
      (results) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }
        resolve(results?.[0]?.result || null);
      }
    );
  });
}

function setActionBadgeText(details) {
  return new Promise((resolve, reject) => {
    chrome.action.setBadgeText(details, () => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      resolve();
    });
  });
}

function setActionBadgeColor(details) {
  return new Promise((resolve, reject) => {
    chrome.action.setBadgeBackgroundColor(details, () => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      resolve();
    });
  });
}

async function setAutomationBadge(state) {
  if (!state) {
    await setActionBadgeText({ text: "" });
    return;
  }
  const tabId = state.tabId;
  if (
    ![QidianCrawlerAutomationState.STATUS.RUNNING,
      QidianCrawlerAutomationState.STATUS.PAUSED].includes(state.status)
  ) {
    await setActionBadgeText({ tabId, text: "" });
    return;
  }
  const paused = state.status === QidianCrawlerAutomationState.STATUS.PAUSED;
  await Promise.all([
    setActionBadgeText({
      tabId,
      text: paused ? "验证" : String(state.capturedCount),
    }),
    setActionBadgeColor({
      tabId,
      color: paused ? "#b45309" : "#1d4ed8",
    }),
  ]);
}

const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
let creatingOffscreenDocument = null;

async function hasOffscreenDocument() {
  const documentUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  if (typeof chrome.runtime.getContexts === "function") {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [documentUrl],
    });
    return contexts.length > 0;
  }
  const matchedClients = await clients.matchAll();
  return matchedClients.some((client) => client.url === documentUrl);
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen?.createDocument) {
    throw new Error("当前浏览器不支持扩展自动下载所需的离屏页面。");
  }
  if (await hasOffscreenDocument()) {
    return;
  }
  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: ["BLOBS"],
        justification: "为自动导出的 UTF-8 TXT 或 JSON 创建临时 Blob 下载地址。",
      })
      .finally(() => {
        creatingOffscreenDocument = null;
      });
  }
  await creatingOffscreenDocument;
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function createOffscreenDownloadUrl(exported, operationId) {
  await ensureOffscreenDocument();
  const response = await sendRuntimeMessage({
    target: "qidian-crawler-offscreen",
    type: "create-download-url",
    operationId,
    content: exported.content,
    mimeType: exported.mimeType,
  });
  if (!response?.ok || typeof response.url !== "string") {
    throw new Error(response?.error || "离屏页面未能创建下载地址。");
  }
  if (Number(response.byteLength) !== exported.byteLength) {
    throw new Error("离屏页面生成的 UTF-8 文件大小校验失败。");
  }
  return response.url;
}

async function releaseOffscreenDownloadUrl(operationId) {
  if (!operationId || !(await hasOffscreenDocument().catch(() => false))) {
    return;
  }
  const response = await sendRuntimeMessage({
    target: "qidian-crawler-offscreen",
    type: "release-download-url",
    operationId,
  }).catch(() => null);
  if (response?.ok && response.remaining === 0) {
    await chrome.offscreen.closeDocument().catch(() => undefined);
  }
}

function startBrowserDownload(options) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(options, (downloadId) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      if (!Number.isInteger(downloadId)) {
        reject(new Error("浏览器没有返回有效的下载编号。"));
        return;
      }
      resolve(downloadId);
    });
  });
}

function normalizeDownloadPath(value) {
  return String(value || "").replace(/\\/g, "/").toLowerCase();
}

function automationDownloadToken(operationId, fileIndex) {
  const suffix = `.file-${fileIndex}`;
  return `${String(operationId).slice(0, 120 - suffix.length)}${suffix}`;
}

function matchesExpectedDownloadPath(actualPath, expectedPath) {
  const actual = normalizeDownloadPath(actualPath);
  const expected = normalizeDownloadPath(expectedPath);
  if (actual.endsWith(expected)) {
    return true;
  }
  const extensionIndex = expected.lastIndexOf(".");
  if (extensionIndex < 0) {
    return false;
  }
  const stem = expected.slice(0, extensionIndex);
  const extension = expected.slice(extensionIndex);
  const escapedStem = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedExtension = extension.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escapedStem} \\(\\d+\\)${escapedExtension}$`).test(actual);
}

async function findAcceptedAutomationDownload(
  exported,
  operationId,
  startedAt,
  fileIndex,
  downloadToken
) {
  const pending = await downloadTracker.readPending().catch(() => ({}));
  const tracked = Object.entries(pending).find(
    ([, item]) =>
      item.operationId === operationId && item.fileIndex === fileIndex
  );
  if (tracked) {
    return Number(tracked[0]);
  }

  const items = await downloadsSearchQuery({
    startedAfter: startedAt,
    limit: 100,
  }).catch(() => []);
  const expectedPath = normalizeDownloadPath(exported.relativePath);
  const match = items
    .filter((item) => {
      return matchesExpectedDownloadPath(item.filename, expectedPath);
    })
    .sort((left, right) =>
      String(right.startTime || "").localeCompare(String(left.startTime || ""))
    )[0];
  if (!Number.isInteger(match?.id)) {
    return null;
  }
  await trackDownload(match.id, {
    format: exported.format,
    chapterCount: exported.fileCount,
    operationId,
    downloadToken,
    fileIndex,
    fileCount: exported.fileCount,
  }).catch(() => undefined);
  if (match.state === "complete" || match.state === "interrupted") {
    await releaseOffscreenDownloadUrl(downloadToken);
  }
  return match.id;
}

async function downloadAutomationExport(exported, operationId, metadata = {}) {
  const fileIndex = Number(metadata.fileIndex || exported.fileIndex);
  const fileCount = Number(metadata.fileCount || exported.fileCount);
  const downloadToken = automationDownloadToken(operationId, fileIndex);
  const recoveredId = await findAcceptedAutomationDownload(
    exported,
    operationId,
    metadata.startedAt,
    fileIndex,
    downloadToken
  );
  if (Number.isInteger(recoveredId)) {
    return recoveredId;
  }

  const url = await createOffscreenDownloadUrl(exported, downloadToken);
  let downloadId;
  try {
    downloadId = await startBrowserDownload({
      url,
      filename: exported.relativePath,
      conflictAction: "uniquify",
      saveAs: false,
    });
  } catch (error) {
    await releaseOffscreenDownloadUrl(downloadToken);
    throw error;
  }
  await trackDownload(downloadId, {
    format: exported.format,
    chapterCount: fileCount,
    operationId,
    downloadToken,
    fileIndex,
    fileCount,
  }).catch(() => undefined);
  const current = await downloadsSearch(downloadId).catch(() => null);
  if (current?.state === "complete" || current?.state === "interrupted") {
    await releaseOffscreenDownloadUrl(downloadToken);
  }
  return downloadId;
}

const automationController =
  QidianCrawlerAutomationController.createAutomationController({
    stateApi: QidianCrawlerAutomationState,
    core: QidianCrawlerCore,
    batchStore,
    storageArea: automationStorageArea,
    extractPage,
    navigateTab,
    getTab,
    downloadExport: downloadAutomationExport,
    record: (code, operationId, details, eventKey) =>
      record(code, "automation", operationId, details, eventKey),
    setBadge: setAutomationBadge,
  });

function respond(sendResponse, promise) {
  promise
    .then((value) => sendResponse({ ok: true, ...value }))
    .catch((error) => {
      console.error("[BACKGROUND_REQUEST_FAILED] 后台请求失败。");
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  return true;
}

function respondBatch(sendResponse, promise) {
  promise
    .then((value) => sendResponse({ ok: true, ...value }))
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        code: error?.code || "STORAGE_WRITE_FAILED",
        details: error?.details || { reason: "batch-operation-failed" },
      });
    });
  return true;
}

function respondAutomation(sendResponse, promise) {
  promise
    .then((state) => sendResponse({ ok: true, state }))
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        code: error?.code || "AUTOMATION_REQUEST_FAILED",
        details: { reason: "automation-request-failed" },
      });
    });
  return true;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return false;
  }
  if (message.type === "automation-get") {
    return respondAutomation(sendResponse, automationController.getState());
  }
  if (message.type === "automation-start") {
    return respondAutomation(
      sendResponse,
      automationController.start({
        tabId: message.tabId,
        targetCount: message.targetCount,
        format: message.format,
        operationId: message.operationId,
      })
    );
  }
  if (message.type === "automation-resume") {
    return respondAutomation(
      sendResponse,
      automationController.resume({
        tabId: message.tabId,
        operationId: message.operationId,
      })
    );
  }
  if (message.type === "automation-stop") {
    return respondAutomation(
      sendResponse,
      automationController.stop({ operationId: message.operationId })
    );
  }
  if (message.type === "log-event") {
    return respond(
      sendResponse,
      record(
        message.code,
        message.component,
        message.operationId,
        message.details,
        message.eventKey
      ).then((result) => ({
        persisted: result.persisted,
        duplicate: Boolean(result.duplicate),
      }))
    );
  }
  if (message.type === "batch-get") {
    return respondBatch(
      sendResponse,
      batchStore.getBatch().then((batch) => ({ batch }))
    );
  }
  if (message.type === "batch-add") {
    return respondBatch(sendResponse, batchStore.addChapter(message.chapter));
  }
  if (message.type === "batch-clear") {
    return respondBatch(sendResponse, batchStore.clearBatch());
  }
  if (message.type === "get-logs") {
    return respond(sendResponse, logStore.read().then((logs) => ({ logs })));
  }
  if (message.type === "clear-logs") {
    return respond(sendResponse, logStore.clear().then(() => ({})));
  }
  if (message.type === "get-log-settings") {
    return respond(
      sendResponse,
      logStore.getSettings().then((settings) => ({ settings }))
    );
  }
  if (message.type === "get-storage-access-status") {
    return respond(
      sendResponse,
      storageAccessPromise.then((status) => ({ status }))
    );
  }
  if (message.type === "set-debug") {
    return respond(
      sendResponse,
      logStore
        .setDebugEnabled(Boolean(message.enabled))
        .then(async (settings) => {
          await record("DEBUG_SETTING_CHANGED", "diagnostics", "settings", {
            enabled: settings.debugEnabled,
          });
          return { settings };
        })
    );
  }
  if (message.type === "track-download") {
    return respond(
      sendResponse,
      trackDownload(message.downloadId, message.metadata).then(() => ({}))
    );
  }
  return false;
});

async function findDownloadToken(downloadId) {
  const pending = await downloadTracker.readPending().catch(() => ({}));
  const tracked = pending[String(downloadId)];
  if (tracked?.downloadToken) {
    return tracked.downloadToken;
  }
  const automation = await QidianCrawlerAutomationState.load(
    automationStorageArea
  ).catch(() => null);
  const index = automation?.downloadIds?.indexOf(downloadId) ?? -1;
  return index >= 0
    ? automationDownloadToken(automation.operationId, index + 1)
    : null;
}

async function settleAndReleaseDownload(downloadId, completed, reason) {
  const downloadToken = await findDownloadToken(downloadId);
  try {
    await settleDownload(downloadId, completed, reason);
  } finally {
    if (downloadToken) {
      await releaseOffscreenDownloadUrl(downloadToken);
    }
  }
}

chrome.downloads.onChanged.addListener((change) => {
  if (change.error?.current || change.state?.current === "interrupted") {
    void settleAndReleaseDownload(
      change.id,
      false,
      change.error?.current || "interrupted"
    ).catch(() => console.error("[DOWNLOAD_FAILED] 下载失败日志写入失败。"));
  } else if (change.state?.current === "complete") {
    void settleAndReleaseDownload(change.id, true, null).catch(() =>
      console.error("[DOWNLOAD_COMPLETED] 下载完成日志写入失败。")
    );
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  void automationController.handleTabUpdated(tabId, changeInfo, tab).catch(() =>
    console.error("[AUTOMATION_FAILED] 自动模式页面更新处理失败。")
  );
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void automationController.handleTabRemoved(tabId).catch(() =>
    console.error("[AUTOMATION_FAILED] 自动模式标签页关闭处理失败。")
  );
});

chrome.runtime.onInstalled.addListener((details) => {
  void (async () => {
    const legacyValues = await new Promise((resolve, reject) => {
      chrome.storage.local.get(LEGACY_KEYS, (result) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }
        resolve(result || {});
      });
    });
    const removedKeyCount = LEGACY_KEYS.filter(
      (key) => legacyValues[key] !== undefined
    ).length;
    if (removedKeyCount > 0) {
      await storageAdapter.remove(LEGACY_KEYS);
      await record("LEGACY_STATE_REMOVED", "background", "install", {
        removedKeyCount,
      });
    }
    if (details.reason === "install") {
      await record("EXTENSION_INSTALLED", "background", "install", {
        reason: "install",
      });
    } else if (details.reason === "update") {
      await record("EXTENSION_UPDATED", "background", "update", {
        previousVersion: details.previousVersion || "unknown",
      });
    }
  })().catch(() => console.error("[EXTENSION_INSTALL_LOG_FAILED] 初始化日志失败。"));
});

function setTrustedStorageAccess() {
  return new Promise((resolve) => {
    if (typeof chrome.storage.local.setAccessLevel !== "function") {
      resolve({ supported: false, ok: false, reason: "api-unavailable" });
      return;
    }
    let settled = false;
    const finish = (status) => {
      if (!settled) {
        settled = true;
        resolve(status);
      }
    };
    try {
      const maybePromise = chrome.storage.local.setAccessLevel(
        { accessLevel: "TRUSTED_CONTEXTS" },
        () => {
          const runtimeError = chrome.runtime.lastError;
          finish({
            supported: true,
            ok: !runtimeError,
            reason: runtimeError ? "set-access-level-failed" : null,
          });
        }
      );
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then(
          () => finish({ supported: true, ok: true, reason: null }),
          () =>
            finish({
              supported: true,
              ok: false,
              reason: "set-access-level-failed",
            })
        );
      }
    } catch {
      finish({
        supported: true,
        ok: false,
        reason: "set-access-level-failed",
      });
    }
  });
}

async function configureStorageAccess() {
  const status = {
    ...(await setTrustedStorageAccess()),
    checkedAt: new Date().toISOString(),
  };
  await storageAdapter
    .set(STORAGE_ACCESS_STATUS_KEY, status)
    .catch(() => undefined);
  if (!status.ok) {
    await record(
      "STORAGE_ACCESS_LEVEL_WARNING",
      "background",
      "storage-access",
      { reason: status.reason || "status-unconfirmed" },
      `storage-access-${status.reason || "unconfirmed"}`
    ).catch(() =>
      console.warn("[STORAGE_ACCESS_LEVEL_WARNING] 访问隔离状态日志写入失败。")
    );
  }
  return status;
}

async function reconcileDownloads() {
  try {
    await downloadTracker.reconcile();
  } catch {
    await record(
      "WORKER_UNHANDLED_ERROR",
      "background",
      "download-reconcile",
      { reason: "download-reconciliation-failed" },
      "download-reconciliation-failed"
    ).catch(() =>
      console.error("[WORKER_UNHANDLED_ERROR] 下载状态对账失败。")
    );
  }
}

async function reconcileAutomation() {
  try {
    await automationController.reconcile();
  } catch {
    await record(
      "WORKER_UNHANDLED_ERROR",
      "background",
      "automation-reconcile",
      { reason: "automation-reconciliation-failed" },
      "automation-reconciliation-failed"
    ).catch(() =>
      console.error("[WORKER_UNHANDLED_ERROR] 自动模式状态对账失败。")
    );
  }
}

async function reconcileRuntimeState() {
  await reconcileDownloads();
  await reconcileAutomation();
}

const storageAccessPromise = configureStorageAccess();
void reconcileRuntimeState();
chrome.runtime.onStartup.addListener(() => void reconcileRuntimeState());

self.addEventListener("unhandledrejection", () => {
  void record(
    "WORKER_UNHANDLED_ERROR",
    "background",
    "worker",
    { reason: "unhandled-rejection" }
  ).catch(() => console.error("[WORKER_UNHANDLED_ERROR] 日志写入失败。"));
});

self.addEventListener("error", () => {
  void record("WORKER_UNHANDLED_ERROR", "background", "worker", {
    reason: "worker-error",
  }).catch(() => console.error("[WORKER_UNHANDLED_ERROR] 日志写入失败。"));
});
