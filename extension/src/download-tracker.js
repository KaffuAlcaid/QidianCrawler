(function defineQidianCrawlerDownloadTracker(root) {
  "use strict";

  const DEFAULT_KEY = "qidianCrawler.pendingDownloads.v1";
  const DEFAULT_STALE_MS = 7 * 24 * 60 * 60 * 1000;
  const ALLOWED_FORMATS = new Set(["txt", "json", "diagnostic"]);

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function normalizeOperationId(value) {
    const normalized = String(value || "download")
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .slice(0, 120);
    return normalized || "download";
  }

  function normalizeItem(value) {
    if (!value || typeof value !== "object") {
      return null;
    }
    const requestedAt = Number(value.requestedAt);
    if (!Number.isFinite(requestedAt) || requestedAt <= 0) {
      return null;
    }
    const terminal = value.terminal;
    const normalizedTerminal =
      terminal && typeof terminal === "object"
        ? {
            completed: Boolean(terminal.completed),
            reason: String(terminal.reason || "interrupted").slice(0, 160),
            observedAt: Number.isFinite(Number(terminal.observedAt))
              ? Number(terminal.observedAt)
              : requestedAt,
          }
        : null;
    return {
      format: ALLOWED_FORMATS.has(value.format) ? value.format : "unknown",
      chapterCount:
        Number.isInteger(value.chapterCount) && value.chapterCount >= 0
          ? value.chapterCount
          : 0,
      operationId: normalizeOperationId(value.operationId),
      downloadToken: value.downloadToken
        ? normalizeOperationId(value.downloadToken)
        : null,
      fileIndex:
        Number.isInteger(value.fileIndex) && value.fileIndex > 0
          ? value.fileIndex
          : 0,
      fileCount:
        Number.isInteger(value.fileCount) && value.fileCount > 0
          ? value.fileCount
          : 0,
      requestedAt,
      terminal: normalizedTerminal,
    };
  }

  function createDownloadTracker(options) {
    const storage = options?.storage;
    const search = options?.search;
    const record = options?.record;
    const key = String(options?.key || DEFAULT_KEY);
    const staleMs = Number(options?.staleMs || DEFAULT_STALE_MS);
    const now = typeof options?.now === "function" ? options.now : () => Date.now();
    if (!storage || typeof storage.get !== "function" || typeof storage.set !== "function") {
      throw new Error("下载跟踪器需要可用的 storage 适配器。");
    }
    if (typeof search !== "function" || typeof record !== "function") {
      throw new Error("下载跟踪器需要 search 和 record 函数。");
    }

    let queue = Promise.resolve();

    function enqueue(task) {
      const result = queue.then(task);
      queue = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    }

    async function readPending() {
      const stored = await storage.get(key);
      if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
        return {};
      }
      const pending = {};
      for (const [downloadId, rawItem] of Object.entries(stored)) {
        if (!/^\d+$/.test(downloadId)) {
          continue;
        }
        const item = normalizeItem(rawItem);
        if (item) {
          pending[downloadId] = item;
        }
      }
      return pending;
    }

    async function persistPending(pending) {
      await storage.set(key, clone(pending));
    }

    function eventKey(downloadId, state) {
      return `download:${downloadId}:${state}`;
    }

    async function appendTerminal(downloadId, item) {
      const terminal = item.terminal;
      if (!terminal) {
        return false;
      }
      const durationMs = Math.max(0, terminal.observedAt - item.requestedAt);
      const code = terminal.completed ? "DOWNLOAD_COMPLETED" : "DOWNLOAD_FAILED";
      const fileDetails =
        item.fileIndex > 0 && item.fileCount > 0
          ? { fileIndex: item.fileIndex, fileCount: item.fileCount }
          : {};
      const details = terminal.completed
        ? {
            format: item.format,
            chapterCount: item.chapterCount,
            downloadId,
            durationMs,
            ...fileDetails,
          }
        : {
            format: item.format,
            chapterCount: item.chapterCount,
            downloadId,
            reason: terminal.reason,
            ...fileDetails,
          };
      const result = await record(
        code,
        item.operationId,
        details,
        eventKey(downloadId, terminal.completed ? "completed" : "failed")
      );
      return result?.persisted === true || result?.duplicate === true;
    }

    function settle(downloadId, completed, reason = null) {
      if (!Number.isInteger(downloadId) || downloadId < 0) {
        return Promise.reject(new Error("下载 ID 无效。"));
      }
      return enqueue(async () => {
        const pending = await readPending();
        const id = String(downloadId);
        const item = pending[id];
        if (!item) {
          return { found: false, persisted: false };
        }
        if (!item.terminal) {
          item.terminal = {
            completed: Boolean(completed),
            reason: String(reason || "interrupted").slice(0, 160),
            observedAt: now(),
          };
          pending[id] = item;
          // 先保存终态。即使 Service Worker 随后休眠，启动对账仍能补记日志。
          await persistPending(pending);
        }
        const persisted = await appendTerminal(downloadId, item);
        if (persisted) {
          delete pending[id];
          await persistPending(pending);
        }
        return { found: true, persisted };
      });
    }

    async function track(downloadId, metadata = {}) {
      if (!Number.isInteger(downloadId) || downloadId < 0) {
        throw new Error("下载 ID 无效。");
      }
      const item = normalizeItem({
        format: metadata.format,
        chapterCount: metadata.chapterCount,
        operationId: metadata.operationId,
        downloadToken: metadata.downloadToken,
        fileIndex: metadata.fileIndex,
        fileCount: metadata.fileCount,
        requestedAt: now(),
        terminal: null,
      });
      await enqueue(async () => {
        const pending = await readPending();
        const id = String(downloadId);
        pending[id] = pending[id] || item;
        await persistPending(pending);
        await record(
          "DOWNLOAD_ACCEPTED",
          item.operationId,
          {
            format: item.format,
            chapterCount: item.chapterCount,
            downloadId,
            ...(item.fileIndex > 0 && item.fileCount > 0
              ? { fileIndex: item.fileIndex, fileCount: item.fileCount }
              : {}),
          },
          eventKey(downloadId, "accepted")
        );
      });

      const current = await search(downloadId).catch(() => null);
      if (current?.state === "complete") {
        await settle(downloadId, true, null);
      } else if (current?.state === "interrupted" || current?.error) {
        await settle(downloadId, false, current.error || "interrupted");
      }
    }

    async function reconcile() {
      const snapshot = await readPending();
      for (const [id, item] of Object.entries(snapshot)) {
        const downloadId = Number(id);
        if (item.terminal) {
          await settle(
            downloadId,
            item.terminal.completed,
            item.terminal.reason
          );
          continue;
        }
        const current = await search(downloadId).catch(() => null);
        if (current?.state === "complete") {
          await settle(downloadId, true, null);
        } else if (current?.state === "interrupted" || current?.error) {
          await settle(downloadId, false, current.error || "interrupted");
        } else if (now() - item.requestedAt >= staleMs) {
          await settle(
            downloadId,
            false,
            current ? "download-stale" : "download-not-found"
          );
        }
      }
    }

    return Object.freeze({
      track,
      settle,
      reconcile,
      readPending,
    });
  }

  root.QidianCrawlerDownloadTracker = Object.freeze({
    DEFAULT_KEY,
    DEFAULT_STALE_MS,
    createDownloadTracker,
  });
})(globalThis);
