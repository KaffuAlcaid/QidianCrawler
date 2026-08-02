(function defineQidianCrawlerBatchStore(root) {
  "use strict";

  const core = root.QidianCrawlerCore;
  if (!core) {
    throw new Error("QidianCrawlerCore 必须先于 batch-store.js 加载。");
  }

  const DEFAULT_QUOTA_BYTES = 10 * 1024 * 1024;
  const DEFAULT_RESERVE_BYTES = 1024 * 1024;

  function createBatchError(code, message, details = {}) {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    return error;
  }

  function createBatchStore(options) {
    const storage = options?.storage;
    if (!storage) {
      throw new Error("批次存储适配器不可用。");
    }
    const quotaBytes = Number.isFinite(Number(options?.quotaBytes))
      ? Number(options.quotaBytes)
      : DEFAULT_QUOTA_BYTES;
    const reserveBytes = Number.isFinite(Number(options?.reserveBytes))
      ? Math.max(0, Number(options.reserveBytes))
      : DEFAULT_RESERVE_BYTES;
    const maxBatchBytes = Number.isFinite(Number(options?.maxBatchBytes))
      ? Number(options.maxBatchBytes)
      : core.MAX_BATCH_BYTES;
    let queue = Promise.resolve();

    function enqueue(task) {
      const result = queue.then(task);
      queue = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    }

    async function readBatchUnlocked() {
      let batch;
      try {
        batch = (await storage.get(core.BATCH_STORAGE_KEY)) || null;
      } catch (error) {
        throw createBatchError(
          "STORAGE_READ_FAILED",
          error instanceof Error ? error.message : String(error),
          { reason: "batch-storage-read" }
        );
      }
      if (batch) {
        const validation = core.validateBatch(batch);
        if (!validation.ok) {
          throw createBatchError(
            "STORAGE_READ_FAILED",
            `当前批次数据损坏：${validation.error}`,
            { reason: "invalid-batch" }
          );
        }
      }
      return batch;
    }

    async function getBytesInUse(key = null) {
      if (typeof storage.getBytesInUse !== "function") {
        throw createBatchError(
          "STORAGE_READ_FAILED",
          "浏览器未提供本地存储容量信息，已停止写入以保护现有批次。",
          { reason: "storage-quota-unavailable" }
        );
      }
      try {
        const bytes = Number(await storage.getBytesInUse(key));
        if (!Number.isFinite(bytes) || bytes < 0) {
          throw new Error("浏览器返回了无效的本地存储容量。");
        }
        return bytes;
      } catch (error) {
        throw createBatchError(
          "STORAGE_READ_FAILED",
          error instanceof Error ? error.message : String(error),
          { reason: "storage-quota-read" }
        );
      }
    }

    async function getBytesInUseOr(key, fallback) {
      try {
        return await getBytesInUse(key);
      } catch {
        return Number(fallback);
      }
    }

    async function assertWriteFits(existingBatch, nextBatch) {
      const batchBytes = core.estimateUtf8Bytes(nextBatch);
      if (batchBytes > maxBatchBytes) {
        throw createBatchError(
          "BATCH_SIZE_LIMIT_REACHED",
          "加入本章后批次会超过安全容量上限，请先导出并清空。",
          {
            bytes: batchBytes,
            limitBytes: maxBatchBytes,
            chapterCount: nextBatch.chapters.length,
          }
        );
      }

      const [totalBytes, existingItemBytes] = await Promise.all([
        getBytesInUse(null),
        existingBatch ? getBytesInUse(core.BATCH_STORAGE_KEY) : Promise.resolve(0),
      ]);
      const keyBytes = core.estimateUtf8Bytes(core.BATCH_STORAGE_KEY);
      const nextItemBytes = batchBytes + keyBytes;
      const predictedBytes = Math.max(0, totalBytes - existingItemBytes) + nextItemBytes;
      const usableQuotaBytes = Math.max(0, quotaBytes - reserveBytes);
      if (predictedBytes > usableQuotaBytes) {
        throw createBatchError(
          "BATCH_SIZE_LIMIT_REACHED",
          "浏览器本地存储空间不足，无法安全加入本章，请先导出并清空。",
          {
            bytes: predictedBytes,
            limitBytes: usableQuotaBytes,
            chapterCount: nextBatch.chapters.length,
          }
        );
      }
      return { predictedBytes, quotaBytes };
    }

    function getBatch() {
      return enqueue(() => readBatchUnlocked());
    }

    function addChapter(chapter, now = new Date().toISOString()) {
      return enqueue(async () => {
        const existingBatch = await readBatchUnlocked();
        const result = core.addChapter(existingBatch, chapter, now);
        if (result.status !== "added") {
          return {
            ...result,
            storageBytes: await getBytesInUseOr(null, 0),
            quotaBytes,
          };
        }

        const capacity = await assertWriteFits(existingBatch, result.batch);
        try {
          await storage.set(core.BATCH_STORAGE_KEY, result.batch);
        } catch (error) {
          throw createBatchError(
            "STORAGE_WRITE_FAILED",
            error instanceof Error ? error.message : String(error),
            { reason: "batch-storage-write" }
          );
        }
        return {
          ...result,
          storageBytes: await getBytesInUseOr(
            null,
            capacity.predictedBytes
          ),
          quotaBytes: capacity.quotaBytes,
        };
      });
    }

    function clearBatch() {
      return enqueue(async () => {
        const batch = await readBatchUnlocked();
        const clearedCount = batch?.chapters?.length || 0;
        if (batch) {
          try {
            await storage.remove(core.BATCH_STORAGE_KEY);
          } catch (error) {
            throw createBatchError(
              "STORAGE_WRITE_FAILED",
              error instanceof Error ? error.message : String(error),
              { reason: "batch-storage-remove" }
            );
          }
        }
        return {
          status: "cleared",
          batch: null,
          clearedCount,
          storageBytes: await getBytesInUseOr(null, 0),
          quotaBytes,
        };
      });
    }

    return Object.freeze({
      getBatch,
      addChapter,
      clearBatch,
    });
  }

  root.QidianCrawlerBatchStore = Object.freeze({
    DEFAULT_QUOTA_BYTES,
    DEFAULT_RESERVE_BYTES,
    createBatchStore,
  });
})(globalThis);
