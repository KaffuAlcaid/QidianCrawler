(function defineQidianCrawlerAutomationController(root) {
  "use strict";


  const DEFAULT_NAVIGATION_DELAY_MS = 2_000;

  function createError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function createAutomationController(options) {
    const stateApi = options?.stateApi || root.QidianCrawlerAutomationState;
    const core = options?.core || root.QidianCrawlerCore;
    const batchStore = options?.batchStore;
    const storageArea = options?.storageArea;
    const extractPage = options?.extractPage;
    const navigateTab = options?.navigateTab;
    const getTab = options?.getTab;
    const inspectDownload =
      typeof options?.inspectDownload === "function"
        ? options.inspectDownload
        : async () => null;
    const getPendingTrackedDownloadCount =
      typeof options?.getPendingTrackedDownloadCount === "function"
        ? options.getPendingTrackedDownloadCount
        : async () => 0;
    const downloadExport = options?.downloadExport;
    const record = options?.record;
    const setBadge = options?.setBadge;
    const delay =
      typeof options?.delay === "function"
        ? options.delay
        : (milliseconds) =>
            new Promise((resolve) => setTimeout(resolve, milliseconds));
    const navigationDelayMs = Number.isFinite(
      Number(options?.navigationDelayMs)
    )
      ? Math.max(0, Math.min(10_000, Number(options.navigationDelayMs)))
      : DEFAULT_NAVIGATION_DELAY_MS;
    const now =
      typeof options?.now === "function"
        ? options.now
        : () => new Date().toISOString();

    if (!stateApi || !core || !batchStore || !storageArea) {
      throw new Error("自动模式缺少状态、批次或存储依赖。");
    }
    if (
      typeof extractPage !== "function" ||
      typeof navigateTab !== "function" ||
      typeof getTab !== "function" ||
      typeof downloadExport !== "function"
    ) {
      throw new Error("自动模式缺少标签页或下载依赖。");
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

    async function safeRecord(code, state, details = {}, eventKey = null) {
      if (typeof record !== "function") {
        return;
      }
      await Promise.resolve(
        record(code, state?.operationId || "automation", details, eventKey)
      ).catch(() => undefined);
    }

    async function safeSetBadge(state) {
      if (typeof setBadge !== "function") {
        return;
      }
      await Promise.resolve(setBadge(state)).catch(() => undefined);
    }

    function publicView(state) {
      return state ? stateApi.toPublicView(state) : null;
    }

    function isActive(state) {
      return Boolean(
        state &&
          [stateApi.STATUS.RUNNING, stateApi.STATUS.PAUSED].includes(
            state.status
          )
      );
    }

    function pendingDownloadCount(state) {
      if (!state) {
        return 0;
      }
      return Math.max(
        0,
        state.downloadIds.length -
          state.completedDownloadIds.length -
          state.failedDownloadIds.length
      );
    }

    function locksBatch(state) {
      return isActive(state) || pendingDownloadCount(state) > 0;
    }

    async function pendingTrackedDownloadCount() {
      const count = Number(await getPendingTrackedDownloadCount());
      return Number.isSafeInteger(count) && count > 0 ? count : 0;
    }

    function trackedDownloadLockView(pendingFileCount) {
      return {
        status: "idle",
        phase: "idle",
        active: false,
        recoveryLock: true,
        capturedCount: 0,
        targetCount: 0,
        acceptedFileCount: pendingFileCount,
        downloadedFileCount: 0,
        failedFileCount: 0,
        pendingFileCount,
        batchLocked: true,
        lastError: null,
      };
    }

    function stableReason(error, fallback) {
      const code = String(error?.code || fallback || "automation-failed")
        .replace(/[^A-Za-z0-9_-]/g, "-")
        .slice(0, 120);
      return code || "automation-failed";
    }

    function terminalDownloadResult(value) {
      if (!value || typeof value !== "object") {
        return null;
      }
      if (value.terminal && typeof value.terminal.completed === "boolean") {
        return {
          completed: value.terminal.completed,
          reason: value.terminal.reason || null,
        };
      }
      if (value.state === "complete") {
        return { completed: true, reason: null };
      }
      if (value.state === "interrupted" || value.error) {
        return {
          completed: false,
          reason: value.error || value.reason || "interrupted",
        };
      }
      return null;
    }

    function normalizeDownloadResult(value) {
      const downloadId = Number.isInteger(value) ? value : value?.downloadId;
      if (!Number.isInteger(downloadId) || downloadId < 0) {
        throw createError(
          "AUTOMATION_DOWNLOAD_ID_INVALID",
          "浏览器没有返回有效的下载编号。"
        );
      }
      return {
        downloadId,
        terminal: terminalDownloadResult(value),
      };
    }

    async function persist(state) {
      return stateApi.save(storageArea, state);
    }

    async function failUnlocked(state, code, message, reason = code) {
      if (!isActive(state)) {
        return state;
      }
      const failed = stateApi.fail(
        state,
        { code, message },
        now()
      );
      await persist(failed);
      await safeSetBadge(failed);
      await safeRecord("AUTOMATION_FAILED", failed, {
        capturedCount: failed.capturedCount,
        targetCount: failed.targetCount,
        reason: String(reason || code).slice(0, 160),
      });
      return failed;
    }

    async function pauseUnlocked(state, indicator) {
      if (!isActive(state) || state.status !== stateApi.STATUS.RUNNING) {
        return state;
      }
      const paused = stateApi.pauseForChallenge(
        state,
        {
          code: "CHALLENGE_DETECTED",
          message:
            "检测到当前页面正在显示验证。请手动完成后，再重新打开扩展继续。",
        },
        now()
      );
      await persist(paused);
      await safeSetBadge(paused);
      await safeRecord("AUTOMATION_CHALLENGE_PAUSED", paused, {
        capturedCount: paused.capturedCount,
        targetCount: paused.targetCount,
        indicator: String(indicator || "page-access-interrupted").slice(0, 120),
      });
      return paused;
    }

    function batchChapters(batch) {
      return Array.isArray(batch?.chapters) ? batch.chapters : [];
    }

    async function synchronizeProgressUnlocked(state, batch) {
      const chapters = batchChapters(batch);
      if (chapters.length < state.capturedCount) {
        throw createError(
          "AUTOMATION_BATCH_MISMATCH",
          "当前批次少于自动模式已记录的进度。"
        );
      }
      if (chapters.length > state.targetCount) {
        throw createError(
          "AUTOMATION_BATCH_MISMATCH",
          "当前批次章数超过自动模式目标。"
        );
      }
      const keys = chapters.map((chapter) => core.chapterKey(chapter));
      if (keys.some((key) => !stateApi.normalizeChapterKey(key))) {
        throw createError(
          "AUTOMATION_BATCH_MISMATCH",
          "当前批次包含无法识别的章节。"
        );
      }
      for (let index = 0; index < state.capturedCount; index += 1) {
        if (keys[index] !== state.visitedChapterKeys[index]) {
          throw createError(
            "AUTOMATION_BATCH_MISMATCH",
            "当前批次与自动模式章节记录不一致。"
          );
        }
      }
      if (chapters.length === state.capturedCount) {
        return state;
      }
      if (
        state.status !== stateApi.STATUS.RUNNING ||
        state.phase !== stateApi.PHASE.CAPTURING
      ) {
        throw createError(
          "AUTOMATION_BATCH_MISMATCH",
          "自动模式当前阶段无法恢复批次进度。"
        );
      }

      let recovered = state;
      for (let index = state.capturedCount; index < chapters.length; index += 1) {
        recovered = stateApi.updateProgress(
          recovered,
          {
            chapterKey: keys[index],
            capturedCount: index + 1,
            nextNavigationUrl: chapters[index].nextUrl,
          },
          now()
        );
      }
      await persist(recovered);
      await safeSetBadge(recovered);
      return recovered;
    }

    async function finalizeDownloadsUnlocked(state) {
      if (
        !isActive(state) ||
        state.status !== stateApi.STATUS.RUNNING ||
        state.phase !== stateApi.PHASE.EXPORTING
      ) {
        return state;
      }
      if (state.failedDownloadIds.length > 0) {
        await safeRecord(
          "EXPORT_FAILED",
          state,
          {
            format: state.format,
            chapterCount: state.targetCount,
            fileCount: state.targetCount,
            acceptedCount: state.downloadIds.length,
            failedCount: state.failedDownloadIds.length,
            reason: "download-terminal-failed",
          },
          `automation:${state.operationId}:terminal-download-failure`
        );
        return failUnlocked(
          state,
          "AUTOMATION_DOWNLOAD_FAILED",
          `${state.failedDownloadIds.length} 个章节文件下载失败；当前批次仍保留，可在处理下载问题后重试。`,
          "download-terminal-failed"
        );
      }
      if (state.downloadIds.length !== state.targetCount) {
        return state;
      }
      const settledCount =
        state.completedDownloadIds.length + state.failedDownloadIds.length;
      if (settledCount !== state.downloadIds.length) {
        return state;
      }

      try {
        const completed = stateApi.complete(state, now());
        try {
          await persist(completed);
        } catch {
          await persist(completed);
        }
        await safeSetBadge(completed);
        await safeRecord("AUTOMATION_COMPLETED", completed, {
          capturedCount: completed.capturedCount,
          targetCount: completed.targetCount,
          format: completed.format,
          downloadCount: completed.completedDownloadIds.length,
        });
        return completed;
      } catch (error) {
        await safeRecord("WORKER_UNHANDLED_ERROR", state, {
          reason: stableReason(error, "automation-completion-save-failed"),
        });
        throw error;
      }
    }

    async function synchronizeDownloadResultsUnlocked(state) {
      if (!state || pendingDownloadCount(state) === 0) {
        return state;
      }
      const settledIds = new Set([
        ...state.completedDownloadIds,
        ...state.failedDownloadIds,
      ]);
      const pendingIds = state.downloadIds.filter(
        (downloadId) => !settledIds.has(downloadId)
      );
      if (pendingIds.length === 0) {
        return state;
      }
      const observations = await Promise.all(
        pendingIds.map((downloadId) =>
          Promise.resolve(inspectDownload(downloadId)).catch(() => null)
        )
      );
      let synchronized = state;
      for (let index = 0; index < pendingIds.length; index += 1) {
        const terminal = terminalDownloadResult(observations[index]);
        if (!terminal) {
          continue;
        }
        synchronized = stateApi.settleDownload(
          synchronized,
          pendingIds[index],
          terminal.completed,
          now()
        );
      }
      if (synchronized !== state) {
        await persist(synchronized);
        await safeSetBadge(synchronized);
      }
      return synchronized;
    }

    async function refreshDownloadStateUnlocked(state) {
      const synchronized = await synchronizeDownloadResultsUnlocked(state);
      return finalizeDownloadsUnlocked(synchronized);
    }

    async function exportUnlocked(state, batch) {
      if (
        state.phase === stateApi.PHASE.EXPORTING &&
        state.downloadIds.length === state.targetCount
      ) {
        return refreshDownloadStateUnlocked(state);
      }
      const chapters = batchChapters(batch);
      if (chapters.length !== state.targetCount) {
        return failUnlocked(
          state,
          "AUTOMATION_EXPORT_COUNT_MISMATCH",
          "批次章数与自动模式目标不一致，未开始下载。",
          "export-count-mismatch"
        );
      }

      if (state.phase === stateApi.PHASE.CAPTURING) {
        state = stateApi.beginExport(state, now());
        await persist(state);
        await safeSetBadge(state);
      } else if (state.phase !== stateApi.PHASE.EXPORTING) {
        return failUnlocked(
          state,
          "AUTOMATION_EXPORT_STATE_INVALID",
          "自动模式当前阶段无法开始导出。",
          "export-state-invalid"
        );
      }

      await safeRecord("EXPORT_STARTED", state, {
        format: state.format,
        chapterCount: chapters.length,
      }, `automation:${state.operationId}:export-started`);
      let exports;
      try {
        exports = core.createChapterExports(batch, state.format, now());
        const totalBytes = exports.reduce(
          (sum, exported) => sum + exported.byteLength,
          0
        );
        await safeRecord("EXPORT_SERIALIZED", state, {
          format: state.format,
          chapterCount: chapters.length,
          fileCount: exports.length,
          bytes: totalBytes,
        });
      } catch (error) {
        const reason = stableReason(error, "export-serialization-failed");
        await safeRecord("EXPORT_FAILED", state, {
          format: state.format,
          chapterCount: chapters.length,
          fileCount: chapters.length,
          acceptedCount: state.downloadIds.length,
          failedCount: chapters.length - state.downloadIds.length,
          reason,
        });
        return failUnlocked(
          state,
          "AUTOMATION_EXPORT_FAILED",
          "章节已保留，但导出文件生成失败。请手动导出当前批次。",
          reason
        );
      }

      if (state.downloadIds.length > 0) {
        const finalized = await refreshDownloadStateUnlocked(state);
        if (!isActive(finalized)) {
          return finalized;
        }
        state = finalized;
      }

      for (
        let index = state.downloadIds.length;
        index < exports.length;
        index += 1
      ) {
        const exported = exports[index];
        try {
          const downloadResult = normalizeDownloadResult(
            await downloadExport(exported, state.operationId, {
              startedAt: state.timestamps.startedAt,
              fileIndex: exported.fileIndex,
              fileCount: exported.fileCount,
            })
          );
          state = stateApi.acceptDownload(
            state,
            downloadResult.downloadId,
            now()
          );
          if (downloadResult.terminal) {
            state = stateApi.settleDownload(
              state,
              downloadResult.downloadId,
              downloadResult.terminal.completed,
              now()
            );
          }
          await persist(state);
          await safeSetBadge(state);
          if (state.failedDownloadIds.length > 0) {
            return finalizeDownloadsUnlocked(state);
          }
        } catch (error) {
          const reason = stableReason(error, "automatic-download-rejected");
          await safeRecord("DOWNLOAD_REJECTED", state, {
            format: state.format,
            chapterCount: chapters.length,
            fileIndex: index + 1,
            fileCount: exports.length,
            acceptedCount: state.downloadIds.length,
            reason,
          });
          return failUnlocked(
            state,
            "AUTOMATION_EXPORT_FAILED",
            `已提交 ${state.downloadIds.length}/${exports.length} 个章节文件；批次仍保留，可重新开始以继续下载。`,
            reason
          );
        }
      }
      return finalizeDownloadsUnlocked(state);
    }

    async function continueAfterCaptureUnlocked(state, extraction, batch) {
      if (state.capturedCount >= state.targetCount) {
        return exportUnlocked(state, batch);
      }
      const nextUrl = stateApi.normalizeNextNavigationUrl(
        extraction?.nextNavigationUrl || extraction?.nextUrl
      );
      if (!nextUrl) {
        await safeRecord("NEXT_CHAPTER_MISSING", state, {
          reason: "next-chapter-missing",
          adapterId: extraction?.adapterId || "qidian",
        });
        return failUnlocked(
          state,
          "AUTOMATION_NEXT_CHAPTER_MISSING",
          "未找到有效的下一章链接，自动模式已停止。",
          "next-chapter-missing"
        );
      }

      const waiting = stateApi.waitForNavigation(state, nextUrl, now());
      await persist(waiting);
      await safeSetBadge(waiting);
      await safeRecord("AUTOMATION_NAVIGATING", waiting, {
        capturedCount: waiting.capturedCount,
        targetCount: waiting.targetCount,
        adapterId: extraction?.adapterId || "qidian",
        delayMs: navigationDelayMs,
      });
      try {
        await delay(navigationDelayMs);
        await navigateTab(waiting.tabId, nextUrl);
        return waiting;
      } catch (error) {
        return failUnlocked(
          waiting,
          "AUTOMATION_NAVIGATION_FAILED",
          "无法打开下一章，自动模式已停止。",
          stableReason(error, "navigation-failed")
        );
      }
    }

    async function captureUnlocked(initialState) {
      let state = initialState;
      let batch;
      try {
        batch = await batchStore.getBatch();
        state = await synchronizeProgressUnlocked(state, batch);
      } catch (error) {
        return failUnlocked(
          state,
          "AUTOMATION_BATCH_MISMATCH",
          "当前批次与自动模式进度不一致，已停止以保护数据。",
          stableReason(error, "batch-mismatch")
        );
      }

      if (state.capturedCount >= state.targetCount) {
        return exportUnlocked(state, batch);
      }

      await safeRecord("PAGE_INSPECTION_STARTED", state, {
        adapterId: "qidian",
      });
      let extraction;
      try {
        extraction = await extractPage(state.tabId, {
          requireNext: state.capturedCount + 1 < state.targetCount,
        });
      } catch (error) {
        const reason = stableReason(error, "script-injection-failed");
        await safeRecord("CHAPTER_EXTRACTION_FAILED", state, {
          reason,
          adapterId: "qidian",
        });
        return failUnlocked(
          state,
          "AUTOMATION_PAGE_INSPECTION_FAILED",
          "无法读取当前章节页面，自动模式已停止；请刷新页面后重试。",
          reason
        );
      }

      if (!extraction?.ok) {
        if (extraction?.reason === "challenge-page") {
          await safeRecord("CHALLENGE_PAGE_DETECTED", state, {
            indicator: extraction.challengeIndicator || "challenge-page",
            adapterId: extraction.adapterId || "qidian",
          });
          return pauseUnlocked(
            state,
            extraction.challengeIndicator || "challenge-page"
          );
        }
        const code =
          extraction?.reason === "unsupported-page"
            ? "PAGE_UNSUPPORTED"
            : "CHAPTER_EXTRACTION_FAILED";
        await safeRecord(code, state, {
          reason: String(extraction?.reason || "extraction-failed").slice(0, 120),
          adapterId: extraction?.adapterId || "qidian",
        });
        const message =
          extraction?.reason === "content-missing"
            ? "等待章节正文加载超时，自动模式已停止；已采集章节仍保留。"
            : "当前页面无法识别为可采集章节，自动模式已停止。";
        return failUnlocked(
          state,
          "AUTOMATION_EXTRACTION_FAILED",
          message,
          extraction?.reason || "extraction-failed"
        );
      }

      const chapterKey = core.chapterKey(extraction);
      if (!stateApi.normalizeChapterKey(chapterKey)) {
        return failUnlocked(
          state,
          "AUTOMATION_CHAPTER_KEY_INVALID",
          "当前章节缺少有效标识，自动模式已停止。",
          "invalid-chapter-key"
        );
      }

      let addition;
      try {
        addition = await batchStore.addChapter(extraction, now());
      } catch (error) {
        const eventCode =
          error?.code === "BATCH_SIZE_LIMIT_REACHED"
            ? "BATCH_SIZE_LIMIT_REACHED"
            : error?.code === "STORAGE_READ_FAILED"
              ? "STORAGE_READ_FAILED"
              : "STORAGE_WRITE_FAILED";
        await safeRecord(eventCode, state, {
          ...(error?.details || {}),
          reason: stableReason(error, "batch-storage-failed"),
        });
        return failUnlocked(
          state,
          error?.code || "AUTOMATION_BATCH_WRITE_FAILED",
          "章节批次无法安全写入，自动模式已停止。",
          stableReason(error, "batch-storage-failed")
        );
      }

      if (addition.status === "different-book") {
        await safeRecord("DIFFERENT_BOOK_REJECTED", state, {
          chapterCount: batchChapters(addition.batch).length,
          adapterId: extraction.adapterId || "qidian",
        });
        return failUnlocked(
          state,
          "AUTOMATION_DIFFERENT_BOOK",
          "下一页属于其他书籍，自动模式已停止。",
          "different-book"
        );
      }

      if (addition.status === "added") {
        state = stateApi.updateProgress(
          state,
          {
            chapterKey,
            capturedCount: addition.batch.chapters.length,
            nextNavigationUrl:
              extraction.nextNavigationUrl || extraction.nextUrl,
          },
          now()
        );
        await persist(state);
        await safeSetBadge(state);
        await safeRecord("CHAPTER_ADDED", state, {
          chapterCount: state.capturedCount,
          paragraphCount: extraction.paragraphs.length,
          adapterId: extraction.adapterId || "qidian",
        });
        await safeRecord(
          "AUTOMATION_PROGRESS",
          state,
          {
            capturedCount: state.capturedCount,
            targetCount: state.targetCount,
            chapterCount: state.capturedCount,
            paragraphCount: extraction.paragraphs.length,
            adapterId: extraction.adapterId || "qidian",
          },
          `automation:${state.operationId}:chapter:${state.capturedCount}`
        );
      } else if (addition.status === "duplicate") {
        state = await synchronizeProgressUnlocked(state, addition.batch);
        await safeRecord("CHAPTER_DUPLICATE_SKIPPED", state, {
          chapterCount: state.capturedCount,
          adapterId: extraction.adapterId || "qidian",
        });
      } else {
        return failUnlocked(
          state,
          "AUTOMATION_BATCH_WRITE_FAILED",
          "章节批次返回了未知状态，自动模式已停止。",
          "unknown-batch-status"
        );
      }

      return continueAfterCaptureUnlocked(state, extraction, addition.batch);
    }

    function getState() {
      return enqueue(async () => {
        let current = await stateApi.load(storageArea);
        current = await refreshDownloadStateUnlocked(current);
        if (!current) {
          const trackedCount = await pendingTrackedDownloadCount();
          return trackedCount > 0
            ? trackedDownloadLockView(trackedCount)
            : null;
        }
        if (
          current?.status === stateApi.STATUS.RUNNING &&
          current.phase === stateApi.PHASE.EXPORTING
        ) {
          if (current.downloadIds.length === current.targetCount) {
            return publicView(current);
          }
          const batch = await batchStore.getBatch();
          return publicView(await exportUnlocked(current, batch));
        }
        return publicView(current);
      });
    }

    function start(options = {}) {
      return enqueue(async () => {
        let existing = await stateApi.load(storageArea);
        existing = await refreshDownloadStateUnlocked(existing);
        if (isActive(existing)) {
          throw createError(
            "AUTOMATION_ALREADY_ACTIVE",
            "已有自动模式任务正在运行或等待验证。"
          );
        }
        if (pendingDownloadCount(existing) > 0) {
          throw createError(
            "AUTOMATION_DOWNLOADS_PENDING",
            "上一自动任务仍有浏览器下载未结束，请等待下载完成或失败后再重试。"
          );
        }
        if ((await pendingTrackedDownloadCount()) > 0) {
          throw createError(
            "AUTOMATION_DOWNLOADS_PENDING",
            "浏览器仍有自动导出的文件未结束，请等待下载完成或失败后再重试。"
          );
        }
        const batch = await batchStore.getBatch();
        const initialChapterKeys = batchChapters(batch).map((chapter) =>
          core.chapterKey(chapter)
        );
        const state = stateApi.start(
          {
            tabId: options.tabId,
            targetCount: options.targetCount,
            format: options.format,
            operationId: options.operationId,
            batchChapterCount: initialChapterKeys.length,
            initialChapterKeys,
          },
          now()
        );
        await persist(state);
        await safeSetBadge(state);
        await safeRecord("AUTOMATION_STARTED", state, {
          targetCount: state.targetCount,
          capturedCount: state.capturedCount,
          format: state.format,
        });
        return publicView(await captureUnlocked(state));
      });
    }

    function resume(options = {}) {
      return enqueue(async () => {
        const current = await stateApi.load(storageArea);
        if (!current) {
          throw createError(
            "AUTOMATION_NOT_FOUND",
            "没有可继续的自动模式任务。"
          );
        }
        if (
          options.operationId &&
          String(options.operationId) !== current.operationId
        ) {
          throw createError(
            "AUTOMATION_OPERATION_MISMATCH",
            "自动模式任务编号已变化，请刷新弹窗后重试。"
          );
        }
        if (
          !Number.isInteger(options.tabId) ||
          options.tabId !== current.tabId
        ) {
          throw createError(
            "AUTOMATION_TAB_MISMATCH",
            "请切回原目标标签页，再打开扩展并继续自动模式。"
          );
        }
        const resumed = stateApi.resume(current, now());
        await persist(resumed);
        await safeSetBadge(resumed);
        await safeRecord("AUTOMATION_RESUMED", resumed, {
          capturedCount: resumed.capturedCount,
          targetCount: resumed.targetCount,
        });
        return publicView(await captureUnlocked(resumed));
      });
    }

    function stop(options = {}) {
      return enqueue(async () => {
        const current = await stateApi.load(storageArea);
        if (!current) {
          return null;
        }
        if (
          options.operationId &&
          String(options.operationId) !== current.operationId
        ) {
          throw createError(
            "AUTOMATION_OPERATION_MISMATCH",
            "自动模式任务编号已变化，请刷新弹窗后重试。"
          );
        }
        if (!isActive(current)) {
          return publicView(current);
        }
        const stopped = stateApi.stop(
          current,
          { code: "AUTOMATION_STOPPED", message: "用户已停止自动模式。" },
          now()
        );
        await persist(stopped);
        await safeSetBadge(stopped);
        await safeRecord("AUTOMATION_STOPPED", stopped, {
          capturedCount: stopped.capturedCount,
          targetCount: stopped.targetCount,
          reason: "user-requested",
        });
        return publicView(stopped);
      });
    }

    function handleDownloadSettled(downloadId, completed) {
      return enqueue(async () => {
        const current = await stateApi.load(storageArea);
        if (
          !current ||
          !current.downloadIds.includes(downloadId)
        ) {
          return current ? publicView(current) : null;
        }
        const settled = stateApi.settleDownload(
          current,
          downloadId,
          Boolean(completed),
          now()
        );
        if (settled !== current) {
          await persist(settled);
          await safeSetBadge(settled);
        }
        return publicView(await finalizeDownloadsUnlocked(settled));
      });
    }

    function clearBatch() {
      return enqueue(async () => {
        let current = await stateApi.load(storageArea);
        current = await refreshDownloadStateUnlocked(current);
        if (locksBatch(current) || (await pendingTrackedDownloadCount()) > 0) {
          throw createError(
            "AUTOMATION_BATCH_LOCKED",
            "自动任务或浏览器下载尚未结束，当前批次不能清空。"
          );
        }
        return batchStore.clearBatch();
      });
    }

    function addChapter(chapter) {
      return enqueue(async () => {
        let current = await stateApi.load(storageArea);
        current = await refreshDownloadStateUnlocked(current);
        if (locksBatch(current) || (await pendingTrackedDownloadCount()) > 0) {
          throw createError(
            "AUTOMATION_BATCH_LOCKED",
            "自动任务或浏览器下载尚未结束，当前批次不能修改。"
          );
        }
        return batchStore.addChapter(chapter);
      });
    }

    function handleTabUpdated(tabId, changeInfo = {}, tab = null) {
      return enqueue(async () => {
        if (changeInfo.status !== "complete") {
          return null;
        }
        const current = await stateApi.load(storageArea);
        if (
          !current ||
          current.tabId !== tabId ||
          current.status !== stateApi.STATUS.RUNNING ||
          current.phase !== stateApi.PHASE.WAITING_NAVIGATION
        ) {
          return current ? publicView(current) : null;
        }
        const observedUrl = stateApi.normalizeNextNavigationUrl(
          changeInfo.url || tab?.url
        );
        if (observedUrl && observedUrl !== current.nextNavigationUrl) {
          return publicView(current);
        }
        const capturing = stateApi.beginCapture(current, now());
        await persist(capturing);
        return publicView(await captureUnlocked(capturing));
      });
    }

    function handleTabRemoved(tabId) {
      return enqueue(async () => {
        const current = await stateApi.load(storageArea);
        if (!current || current.tabId !== tabId || !isActive(current)) {
          return current ? publicView(current) : null;
        }
        if (current.phase === stateApi.PHASE.EXPORTING) {
          const refreshed = await refreshDownloadStateUnlocked(current);
          if (
            !isActive(refreshed) ||
            refreshed.downloadIds.length === refreshed.targetCount
          ) {
            return publicView(refreshed);
          }
          const batch = await batchStore.getBatch();
          return publicView(await exportUnlocked(refreshed, batch));
        }
        const failed = await failUnlocked(
          current,
          "AUTOMATION_TAB_CLOSED",
          "目标标签页已关闭，自动模式已停止。",
          "target-tab-closed"
        );
        return publicView(failed);
      });
    }

    function reconcile() {
      return enqueue(async () => {
        let current = await stateApi.load(storageArea);
        if (!current) {
          await safeSetBadge(null);
          return null;
        }
        current = await refreshDownloadStateUnlocked(current);
        if (!isActive(current)) {
          await safeSetBadge(current);
          return publicView(current);
        }
        await safeSetBadge(current);
        if (current.status === stateApi.STATUS.PAUSED) {
          return publicView(current);
        }

        if (current.phase === stateApi.PHASE.EXPORTING) {
          if (current.downloadIds.length === current.targetCount) {
            return publicView(current);
          }
          let batch;
          try {
            batch = await batchStore.getBatch();
          } catch (error) {
            const failed = await failUnlocked(
              current,
              "AUTOMATION_EXPORT_RECOVERY_FAILED",
              "无法读取已采集批次，自动下载恢复失败。",
              stableReason(error, "export-recovery-batch-read")
            );
            return publicView(failed);
          }
          return publicView(await exportUnlocked(current, batch));
        }

        let tab;
        try {
          tab = await getTab(current.tabId);
        } catch {
          tab = null;
        }
        if (!tab) {
          const failed = await failUnlocked(
            current,
            "AUTOMATION_TAB_MISSING",
            "找不到目标标签页，自动模式已停止。",
            "target-tab-missing"
          );
          return publicView(failed);
        }
        if (current.phase === stateApi.PHASE.CAPTURING) {
          if (tab.status && tab.status !== "complete") {
            return publicView(current);
          }
          return publicView(await captureUnlocked(current));
        }
        if (current.phase === stateApi.PHASE.WAITING_NAVIGATION) {
          try {
            await delay(navigationDelayMs);
            await navigateTab(current.tabId, current.nextNavigationUrl);
            return publicView(current);
          } catch (error) {
            const failed = await failUnlocked(
              current,
              "AUTOMATION_NAVIGATION_FAILED",
              "无法恢复下一章导航，自动模式已停止。",
              stableReason(error, "navigation-reconcile-failed")
            );
            return publicView(failed);
          }
        }
        return publicView(current);
      });
    }

    return Object.freeze({
      getState,
      start,
      resume,
      stop,
      addChapter,
      clearBatch,
      handleDownloadSettled,
      handleTabUpdated,
      handleTabRemoved,
      reconcile,
    });
  }

  root.QidianCrawlerAutomationController = Object.freeze({
    DEFAULT_NAVIGATION_DELAY_MS,
    createAutomationController,
  });
})(globalThis);
