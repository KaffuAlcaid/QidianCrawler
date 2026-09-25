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

    async function readCollectionUnlocked() {
      try {
        return core.readBatchCollection(await storage.get(core.BATCH_STORAGE_KEY));
      } catch (error) {
        throw createBatchError(
          "STORAGE_READ_FAILED",
          error instanceof Error ? error.message : String(error),
          { reason: "batch-storage-read" }
        );
      }
    }

    function selectedBatch(collection, bookId = collection.activeBookId) {
      return collection.batches.find((batch) => String(batch.bookId) === bookId) || null;
    }

    function snapshot(collection) {
      return {
        batch: selectedBatch(collection),
        batches: collection.batches.map((batch) => ({
          bookId: String(batch.bookId),
          bookTitle: batch.bookTitle,
          chapterCount: batch.chapters.length,
        })),
      };
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

    async function writeCollectionUnlocked(collection, reservedBytes = reserveBytes) {
      const [totalBytes, existingItemBytes] = await Promise.all([
        getBytesInUse(null),
        getBytesInUse(core.BATCH_STORAGE_KEY),
      ]);
      const keyBytes = core.estimateUtf8Bytes(core.BATCH_STORAGE_KEY);
      const nextItemBytes = core.estimateUtf8Bytes(collection) + keyBytes;
      const predictedBytes = Math.max(0, totalBytes - existingItemBytes) + nextItemBytes;
      const usableQuotaBytes = Math.max(0, quotaBytes - reservedBytes);
      if (predictedBytes > usableQuotaBytes) {
        throw createBatchError(
          "BATCH_SIZE_LIMIT_REACHED",
          "浏览器本地存储空间不足，请先导出并清空不再需要的书籍批次。",
          {
            bytes: predictedBytes,
            limitBytes: usableQuotaBytes,
            chapterCount: selectedBatch(collection)?.chapters.length || 0,
          }
        );
      }
      try {
        await storage.set(core.BATCH_STORAGE_KEY, collection);
      } catch (error) {
        throw createBatchError(
          "STORAGE_WRITE_FAILED",
          error instanceof Error ? error.message : String(error),
          { reason: "batch-storage-write" }
        );
      }
      return { predictedBytes, quotaBytes };
    }

    function getBatch(bookId) {
      return enqueue(async () => selectedBatch(await readCollectionUnlocked(), bookId));
    }

    function getSnapshot() {
      return enqueue(async () => snapshot(await readCollectionUnlocked()));
    }

    function selectBatch(bookId) {
      return enqueue(async () => {
        const collection = await readCollectionUnlocked();
        const activeBookId = core.compact(bookId);
        if (!activeBookId) {
          throw createBatchError("INVALID_BATCH", "请选择书籍批次。");
        }
        if (collection.activeBookId !== activeBookId) {
          collection.activeBookId = activeBookId;
          await writeCollectionUnlocked(collection, 0);
        }
        return snapshot(collection);
      });
    }

    function addChapter(
      chapter,
      now = new Date().toISOString(),
      { selectBook = false } = {}
    ) {
      return enqueue(async () => {
        const collection = await readCollectionUnlocked();
        const bookId = core.compact(chapter?.bookId);
        const existingBatch = selectedBatch(
          collection,
          selectBook || !collection.activeBookId ? bookId : collection.activeBookId
        );
        // 自动翻页只能向启动时选定的书籍写入，包括尚无章节的新书。
        if (!selectBook && collection.activeBookId && collection.activeBookId !== bookId) {
          return { status: "different-book", batch: existingBatch };
        }
        const result = core.addChapter(existingBatch, chapter, now);
        if (
          result.status !== "added" &&
          !(result.status === "duplicate" && collection.activeBookId !== bookId)
        ) {
          return {
            ...result,
            storageBytes: await getBytesInUseOr(null, 0),
            quotaBytes,
          };
        }

        const batchBytes = core.estimateUtf8Bytes(result.batch);
        if (batchBytes > maxBatchBytes) {
          throw createBatchError(
            "BATCH_SIZE_LIMIT_REACHED",
            "加入本章后批次会超过安全容量上限，请先导出并清空。",
            {
              bytes: batchBytes,
              limitBytes: maxBatchBytes,
              chapterCount: result.batch.chapters.length,
            }
          );
        }
        collection.activeBookId = bookId;
        const index = collection.batches.findIndex((batch) => String(batch.bookId) === bookId);
        if (index < 0) {
          collection.batches.push(result.batch);
        } else {
          collection.batches[index] = result.batch;
        }
        const capacity = await writeCollectionUnlocked(collection);
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
        const collection = await readCollectionUnlocked();
        const batch = selectedBatch(collection);
        const clearedCount = batch?.chapters?.length || 0;
        if (batch) {
          try {
            collection.batches = collection.batches.filter((item) => item !== batch);
            collection.activeBookId = null;
            if (collection.batches.length > 0) {
              await storage.set(core.BATCH_STORAGE_KEY, collection);
            } else {
              await storage.remove(core.BATCH_STORAGE_KEY);
            }
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
      getSnapshot,
      selectBatch,
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
