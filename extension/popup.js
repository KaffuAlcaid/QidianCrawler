(function initializePopup() {
  "use strict";


  const core = QidianCrawlerCore;
  const logs = QidianCrawlerLogClient;
  const captureButton = document.querySelector("#capture-current");
  const nextButton = document.querySelector("#open-next");
  const exportButton = document.querySelector("#export-batch");
  const clearButton = document.querySelector("#clear-batch");
  const diagnosticsButton = document.querySelector("#open-diagnostics");
  const formatSelect = document.querySelector("#export-format");
  const automationTargetInput = document.querySelector("#automation-target");
  const automationStartButton = document.querySelector("#automation-start");
  const automationStopButton = document.querySelector("#automation-stop");
  const automationStateNode = document.querySelector("#automation-state");
  const automationProgressNode = document.querySelector("#automation-progress");
  const automationProgressTextNode = document.querySelector(
    "#automation-progress-text"
  );
  const automationBookNode = document.querySelector("#automation-book");
  const automationDetailNode = document.querySelector("#automation-detail");
  const batchBookNode = document.querySelector("#batch-book");
  const batchCountNode = document.querySelector("#batch-count");
  const batchSizeNode = document.querySelector("#batch-size");
  const batchSelect = document.querySelector("#batch-select");
  const statusNode = document.querySelector("#status");
  const statusMessageNode = document.querySelector("#status-message");
  const statusMetaNode = document.querySelector("#status-meta");
  const automationStorageKey =
    core.AUTOMATION_STORAGE_KEY || "qidianCrawler.automation.v1";
  let actionBusy = false;
  let automationBusy = false;
  let automationState = null;
  let lastAnnouncedAutomationPhase = "idle";
  let currentBatch = null;

  function createUiError(code, message, details = {}) {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    return error;
  }

  function setStatus(message, type = "normal", code = null, operationId = null) {
    statusMessageNode.textContent = message;
    statusNode.className = `status ${type === "normal" ? "" : type}`.trim();
    if (code || operationId) {
      const shortOperation = operationId ? operationId.split("-").slice(-1)[0] : null;
      statusMetaNode.textContent = [code, shortOperation ? `操作 ${shortOperation}` : null]
        .filter(Boolean)
        .join(" · ");
      statusMetaNode.hidden = false;
    } else {
      statusMetaNode.textContent = "";
      statusMetaNode.hidden = true;
    }
  }

  function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (value < 1024) {
      return `${value} B`;
    }
    if (value < 1024 * 1024) {
      return `${(value / 1024).toFixed(1)} KiB`;
    }
    return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  }

  function getAutomationPhase(state) {
    const statePhase = String(state?.phase || "").toLowerCase();
    if (statePhase === "exporting") {
      return "exporting";
    }
    const rawPhase = String(state?.status || statePhase || "idle").toLowerCase();
    if (state?.paused || rawPhase.includes("challenge") || rawPhase === "paused") {
      return "paused";
    }
    if (["starting", "running", "navigating", "waiting"].includes(rawPhase)) {
      return "running";
    }
    if (rawPhase === "stopping") {
      return "stopping";
    }
    if (["completed", "complete"].includes(rawPhase)) {
      return "completed";
    }
    if (["stopped", "cancelled", "canceled"].includes(rawPhase)) {
      return "stopped";
    }
    if (["failed", "error"].includes(rawPhase)) {
      return "failed";
    }
    return state?.active ? "running" : "idle";
  }

  function getCapturedCount(state) {
    return Math.max(
      0,
      Number(
        state?.capturedCount ?? state?.completedCount ?? state?.collectedCount ?? 0
      ) || 0
    );
  }

  function getTargetCount(state) {
    return Math.max(0, Number(state?.targetCount || 0) || 0);
  }

  function getDownloadedFileCount(state) {
    return Math.max(
      0,
      Number(
        state?.downloadedFileCount ?? state?.completedDownloadIds?.length ?? 0
      ) || 0
    );
  }

  function getAcceptedFileCount(state) {
    return Math.max(
      0,
      Number(state?.acceptedFileCount ?? state?.downloadIds?.length ?? 0) || 0
    );
  }

  function getFailedFileCount(state) {
    return Math.max(
      0,
      Number(state?.failedFileCount ?? state?.failedDownloadIds?.length ?? 0) ||
        0
    );
  }

  function getPendingFileCount(state) {
    const derived = Math.max(
      0,
      getAcceptedFileCount(state) -
        getDownloadedFileCount(state) -
        getFailedFileCount(state)
    );
    return Math.max(0, Number(state?.pendingFileCount ?? derived) || 0);
  }

  function automationLocksBatch() {
    if (typeof automationState?.batchLocked === "boolean") {
      return automationState.batchLocked;
    }
    return (
      ["running", "paused", "exporting", "stopping"].includes(
        getAutomationPhase(automationState)
      ) || getPendingFileCount(automationState) > 0
    );
  }

  function announceAutomationState(phase, state) {
    if (phase === lastAnnouncedAutomationPhase) {
      return;
    }
    lastAnnouncedAutomationPhase = phase;
    const operationId = state?.operationId || null;
    const capturedCount = getCapturedCount(state);
    if (phase === "paused") {
      setStatus(
        "自动采集已暂停：请在当前标签页手动完成验证后继续。",
        "warning",
        "AUTOMATION_CHALLENGE_PAUSED",
        operationId
      );
    } else if (phase === "completed") {
      setStatus(
        `自动采集已完成，共采集 ${capturedCount} 章。`,
        "success",
        "AUTOMATION_COMPLETED",
        operationId
      );
    } else if (phase === "stopped") {
      setStatus(
        `自动采集已停止，已采集 ${capturedCount} 章。`,
        "warning",
        "AUTOMATION_STOPPED",
        operationId
      );
    } else if (phase === "failed") {
      const failureMessage =
        state?.lastError?.message ||
        "自动采集已中断，已采集章节仍保留在当前批次中。";
      setStatus(
        failureMessage,
        "error",
        state?.lastError?.code || "AUTOMATION_FAILED",
        operationId
      );
    }
  }

  function renderAutomation(state, announce = false) {
    automationState = state && typeof state === "object" ? state : null;
    const recoveryLock = automationState?.recoveryLock === true;
    const phase = getAutomationPhase(automationState);
    const capturedCount = getCapturedCount(automationState);
    const acceptedFileCount = getAcceptedFileCount(automationState);
    const downloadedFileCount = getDownloadedFileCount(automationState);
    const failedFileCount = getFailedFileCount(automationState);
    const pendingFileCount = getPendingFileCount(automationState);
    const stateTargetCount = getTargetCount(automationState);
    if (stateTargetCount >= 1 && stateTargetCount <= 500) {
      automationTargetInput.value = String(stateTargetCount);
    }
    const displayedTarget = recoveryLock
      ? pendingFileCount
      : stateTargetCount || Number(automationTargetInput.value) || 0;
    automationProgressNode.max = Math.max(1, displayedTarget);
    const displayedProgress =
      phase === "exporting" ? downloadedFileCount : capturedCount;
    automationProgressNode.value = Math.min(
      displayedProgress,
      displayedTarget || 1
    );
    automationProgressTextNode.textContent =
      recoveryLock
        ? `等待 ${pendingFileCount} 个文件`
        : phase === "exporting"
          ? `已完成 ${downloadedFileCount} / ${displayedTarget} 个文件`
          : `${capturedCount} / ${displayedTarget} 章`;

    const downloadSummary = `浏览器已接收 ${acceptedFileCount} 个，已完成 ${downloadedFileCount} 个${
      failedFileCount > 0 ? `，失败 ${failedFileCount} 个` : ""
    }${pendingFileCount > 0 ? `，等待 ${pendingFileCount} 个` : ""}。`;

    const presentation = {
      idle: recoveryLock
        ? [
            "等待下载",
            "running",
            `正在等待 ${pendingFileCount} 个自动导出文件的下载结果。`,
          ]
        : ["未运行", "", "自动采集、打开下一章，并在达到目标后按所选格式导出。"],
      running: ["运行中", "running", `正在自动采集，已完成 ${capturedCount} 章。`],
      exporting: [
        "正在下载",
        "running",
        downloadSummary,
      ],
      paused: [
        "等待验证",
        "paused",
        "请在当前标签页手动完成验证后，再点击“继续自动化”。",
      ],
      stopping: ["停止中", "paused", "正在安全停止自动采集……"],
      completed: [
        "已完成",
        "completed",
        `本次已采集 ${capturedCount} 章，并完成 ${downloadedFileCount} 个文件下载。`,
      ],
      stopped: [
        "已停止",
        "",
        pendingFileCount > 0
          ? `本次已保留 ${capturedCount} 章。${downloadSummary}`
          : `本次已保留 ${capturedCount} 章。`,
      ],
      failed: [
        "运行失败",
        "failed",
        `${
          automationState?.lastError?.message ||
          "已采集章节仍保留，可直接设置目标章数重新开始。"
        }${pendingFileCount > 0 ? ` ${downloadSummary}` : ""}`,
      ],
    }[phase];
    automationStateNode.textContent = presentation[0];
    automationStateNode.className = `state-badge ${presentation[1]}`.trim();
    automationDetailNode.textContent = presentation[2];
    automationStartButton.textContent =
      phase === "paused" ? "继续自动化" : "开始自动化";

    if (announce) {
      announceAutomationState(phase, automationState);
    } else {
      lastAnnouncedAutomationPhase = phase;
    }
  }

  function renderBatch(batch) {
    currentBatch = batch;
    const count = batch?.chapters?.length || 0;
    batchBookNode.textContent = batch?.bookTitle || "等待采集";
    automationBookNode.textContent = batch?.bookTitle
      ? `书名：${batch.bookTitle}`
      : "书名：等待采集首章";
    batchCountNode.textContent = String(count);
    batchSizeNode.textContent = batch ? formatBytes(core.estimateUtf8Bytes(batch)) : "0 B";
    batchSelect.value = batch ? String(batch.bookId) : "";
    const locked = automationLocksBatch();
    batchSelect.disabled = actionBusy || automationBusy || locked || batchSelect.options.length <= 1;
    exportButton.disabled = actionBusy || automationBusy || locked || count === 0;
    clearButton.disabled = actionBusy || automationBusy || locked || count === 0;
  }

  function refreshControls() {
    const phase = getAutomationPhase(automationState);
    const locked = automationLocksBatch();
    const busy = actionBusy || automationBusy;
    captureButton.disabled = busy || locked;
    nextButton.disabled = busy || locked;
    formatSelect.disabled = busy || locked;
    automationTargetInput.disabled = busy || locked;
    automationStartButton.disabled =
      busy ||
      ["running", "exporting", "stopping"].includes(phase) ||
      (locked && phase !== "paused");
    automationStopButton.disabled =
      busy || !["running", "paused"].includes(phase);
    diagnosticsButton.disabled = actionBusy;
    renderBatch(currentBatch);
  }

  function storageGet(key) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(key, (result) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(createUiError("STORAGE_READ_FAILED", runtimeError.message, {
            reason: "chrome-storage-read",
          }));
          return;
        }
        resolve(result?.[key]);
      });
    });
  }

  function storageSet(key, value) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [key]: value }, () => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(createUiError("STORAGE_WRITE_FAILED", runtimeError.message, {
            reason: "chrome-storage-write",
          }));
          return;
        }
        resolve();
      });
    });
  }

  function sendBatchMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          const code = message?.type === "batch-get"
            ? "STORAGE_READ_FAILED"
            : "STORAGE_WRITE_FAILED";
          reject(
            createUiError(code, runtimeError.message, {
              reason: "batch-background-unavailable",
            })
          );
          return;
        }
        if (!response?.ok) {
          reject(
            createUiError(
              response?.code || "STORAGE_WRITE_FAILED",
              response?.error || "扩展后台返回的批次结果无效。",
              response?.details || { reason: "batch-background-failed" }
            )
          );
          return;
        }
        resolve(response);
      });
    });
  }

  function sendAutomationMessage(type, payload = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, ...payload }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(
            createUiError(
              type === "automation-get" ? "STORAGE_READ_FAILED" : "AUTOMATION_FAILED",
              runtimeError.message,
              { reason: "automation-background-unavailable" }
            )
          );
          return;
        }
        if (!response?.ok) {
          reject(
            createUiError(
              response?.code || "AUTOMATION_FAILED",
              response?.error || "扩展后台返回的自动化结果无效。",
              response?.details || { reason: "automation-background-failed" }
            )
          );
          return;
        }
        resolve(response);
      });
    });
  }

  function getAutomationStateFromResponse(response) {
    return (
      response?.automation ||
      response?.state ||
      response?.automationState ||
      null
    );
  }

  function queryActiveTab() {
    return new Promise((resolve, reject) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(createUiError("PAGE_UNSUPPORTED", runtimeError.message, {
            reason: "active-tab-unavailable",
          }));
          return;
        }
        const tab = tabs?.[0];
        if (!tab?.id) {
          reject(
            createUiError("PAGE_UNSUPPORTED", "无法读取当前标签页。", {
              reason: "active-tab-missing",
            })
          );
          return;
        }
        resolve(tab);
      });
    });
  }

  function executeExtractor(tabId) {
    return new Promise((resolve, reject) => {
      chrome.scripting.executeScript(
        {
          target: { tabId },
          files: ["src/core.js", "src/extractor.js", "src/extract-page.js"],
        },
        (results) => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            reject(
              createUiError(
                "CHAPTER_EXTRACTION_FAILED",
                "页面读取失败。安装或更新扩展后，请刷新章节页再试。",
                { reason: "script-injection-failed" }
              )
            );
            return;
          }
          const result = results?.[0]?.result;
          if (!result) {
            reject(
              createUiError(
                "CHAPTER_EXTRACTION_FAILED",
                "章节解析结果为空。",
                { reason: "empty-extraction-result" }
              )
            );
            return;
          }
          resolve(result);
        }
      );
    });
  }

  async function readCurrentChapter(operationId) {
    await logs.event(
      "PAGE_INSPECTION_STARTED",
      { adapterId: "qidian" },
      operationId
    );
    try {
      const tab = await queryActiveTab();
      const result = await executeExtractor(tab.id);
      if (!result.ok) {
        const code =
          result.reason === "challenge-page"
            ? "CHALLENGE_PAGE_DETECTED"
            : result.reason === "unsupported-page"
              ? "PAGE_UNSUPPORTED"
              : "CHAPTER_EXTRACTION_FAILED";
        throw createUiError(code, result.error, {
          reason: result.reason,
          indicator: result.challengeIndicator,
          adapterId: result.adapterId || "qidian",
        });
      }
      return { ...result, tabId: tab.id };
    } catch (error) {
      const code = error?.code || "CHAPTER_EXTRACTION_FAILED";
      await logs.event(
        code,
        error?.details || { reason: "page-inspection-failed", adapterId: "qidian" },
        operationId
      );
      if (error && typeof error === "object") {
        error.logged = true;
      }
      throw error;
    }
  }

  async function loadBatch() {
    const response = await sendBatchMessage({ type: "batch-get" });
    const batch = response.batch || null;
    if (batch) {
      const validation = core.validateBatch(batch);
      if (!validation.ok) {
        throw createUiError(
          "STORAGE_READ_FAILED",
          `当前批次数据损坏：${validation.error}`,
          { reason: "invalid-batch" }
        );
      }
    }
    const options = (response.batches || []).map((item) => {
      const option = document.createElement("option");
      option.value = item.bookId;
      option.textContent = `${item.bookTitle}（${item.chapterCount} 章）`;
      return option;
    });
    if (!batch) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = options.length ? "请选择书籍批次" : "等待采集";
      option.disabled = true;
      options.unshift(option);
    }
    batchSelect.replaceChildren(...options);
    renderBatch(batch);
    return batch;
  }

  async function selectBatch() {
    const bookId = batchSelect.value;
    actionBusy = true;
    refreshControls();
    try {
      await sendBatchMessage({ type: "batch-select", bookId });
      await loadBatch();
      await loadAutomationState();
      setStatus("已切换书籍批次。", "success");
    } catch (error) {
      setStatus(error.message, "error", error.code || "STORAGE_WRITE_FAILED");
    } finally {
      actionBusy = false;
      refreshControls();
    }
  }

  async function captureCurrentChapter() {
    const operationId = logs.createOperationId("capture");
    actionBusy = true;
    refreshControls();
    setStatus("正在读取当前页面……", "normal", null, operationId);
    try {
      const chapter = await readCurrentChapter(operationId);
      const result = await sendBatchMessage({
        type: "batch-add",
        chapter,
      });
      if (result.status === "different-book") {
        await logs.event(
          "DIFFERENT_BOOK_REJECTED",
          {
            chapterCount: result.batch?.chapters?.length || 0,
            adapterId: chapter.adapterId,
          },
          operationId
        );
        const error = createUiError(
          "DIFFERENT_BOOK_REJECTED",
          "章节与所选书籍批次不一致，请重新打开弹窗后重试。"
        );
        error.logged = true;
        throw error;
      }
      if (result.status === "duplicate") {
        renderBatch(result.batch);
        await logs.event(
          "CHAPTER_DUPLICATE_SKIPPED",
          {
            chapterCount: result.batch.chapters.length,
            adapterId: chapter.adapterId,
          },
          operationId
        );
        setStatus(
          `“${chapter.title}”已在当前批次中，本次跳过。`,
          "warning",
          "CHAPTER_DUPLICATE_SKIPPED",
          operationId
        );
        return;
      }
      renderBatch(result.batch);
      await logs.event(
        "CHAPTER_ADDED",
        {
          chapterCount: result.batch.chapters.length,
          paragraphCount: chapter.paragraphs.length,
          adapterId: chapter.adapterId,
        },
        operationId
      );
      setStatus(
        `已加入“${chapter.title}”，当前共 ${result.batch.chapters.length} 章。`,
        "success",
        "CHAPTER_ADDED",
        operationId
      );

      const storageBytes = Number(result.storageBytes || 0);
      const quota = Number(result.quotaBytes || 0);
      if (quota > 0 && storageBytes >= quota * 0.8) {
        await logs.event(
          "STORAGE_LIMIT_APPROACHING",
          {
            bytes: storageBytes,
            limitBytes: quota,
            chapterCount: result.batch.chapters.length,
          },
          operationId
        );
        setStatus(
          `已采集 ${result.batch.chapters.length} 章；本地存储空间即将达到上限，建议尽快导出。`,
          "warning",
          "STORAGE_LIMIT_APPROACHING",
          operationId
        );
      }
    } catch (error) {
      const rawCode = error?.code || "CHAPTER_EXTRACTION_FAILED";
      const code = logs.describe(rawCode) ? rawCode : "CHAPTER_EXTRACTION_FAILED";
      if (!error?.logged) {
        await logs.event(
          code,
          error?.details || { reason: "capture-failed", adapterId: "qidian" },
          operationId
        );
      }
      const definition = logs.describe(code);
      setStatus(
        error instanceof Error ? error.message : String(error),
        ["AUTOMATION_BATCH_LOCKED", "CHAPTER_DUPLICATE_SKIPPED"].includes(code)
          ? "warning"
          : "error",
        code,
        operationId
      );
      if (definition?.suggestion) {
        console.info(`[${code}] ${definition.suggestion}`);
      }
    } finally {
      actionBusy = false;
      refreshControls();
    }
  }

  function updateTab(tabId, url) {
    return new Promise((resolve, reject) => {
      chrome.tabs.update(tabId, { url }, (tab) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError || !tab) {
          reject(
            createUiError(
              "NEXT_CHAPTER_MISSING",
              runtimeError?.message || "无法打开下一章。",
              { reason: "tab-update-failed" }
            )
          );
          return;
        }
        resolve(tab);
      });
    });
  }

  async function openNextChapter() {
    const operationId = logs.createOperationId("next");
    actionBusy = true;
    refreshControls();
    setStatus("正在读取页面提供的下一章链接……", "normal", null, operationId);
    try {
      const chapter = await readCurrentChapter(operationId);
      const navigationUrl = chapter.nextNavigationUrl || chapter.nextUrl;
      if (!navigationUrl || !core.isSupportedChapterUrl(navigationUrl)) {
        throw createUiError(
          "NEXT_CHAPTER_MISSING",
          "当前页面缺少可用的“下一章”链接。",
          {
            reason: navigationUrl ? "invalid-next-url" : "next-link-missing",
            adapterId: chapter.adapterId,
          }
        );
      }
      await updateTab(chapter.tabId, navigationUrl);
      await logs.event(
        "NEXT_CHAPTER_OPENED",
        { adapterId: chapter.adapterId },
        operationId
      );
      setStatus(
        "已打开下一章，正文显示后再点击采集。",
        "success",
        "NEXT_CHAPTER_OPENED",
        operationId
      );
      window.setTimeout(() => window.close(), 250);
    } catch (error) {
      const code = error?.code || "NEXT_CHAPTER_MISSING";
      if (!error?.logged) {
        await logs.event(
          code,
          error?.details || { reason: "next-navigation-failed", adapterId: "qidian" },
          operationId
        );
      }
      setStatus(
        error instanceof Error ? error.message : String(error),
        "error",
        code,
        operationId
      );
    } finally {
      actionBusy = false;
      refreshControls();
    }
  }

  async function saveChapter(directory, exported) {
    const extension = `.${exported.format}`;
    const basename = exported.filename.slice(0, -extension.length);
    let filename = exported.filename;
    for (let suffix = 2; ; suffix += 1) {
      try {
        await directory.getFileHandle(filename);
      } catch (error) {
        if (error?.name === "NotFoundError") {
          break;
        }
        if (error?.name !== "TypeMismatchError") {
          throw error;
        }
      }
      filename = `${basename} (${suffix})${extension}`;
    }
    const file = await directory.getFileHandle(filename, { create: true });
    const writer = await file.createWritable();
    try {
      await writer.write(exported.content);
      await writer.close();
    } catch (error) {
      await writer.abort().catch(() => undefined);
      throw error;
    }
  }

  async function exportBatch() {
    const operationId = logs.createOperationId("export");
    actionBusy = true;
    refreshControls();
    setStatus("请选择批次的保存文件夹……", "normal", null, operationId);
    const format = formatSelect.value;
    let chapterCount = currentBatch?.chapters?.length || 0;
    let fileCount = chapterCount;
    let savedCount = 0;
    try {
      if (typeof window.showDirectoryPicker !== "function") {
        throw createUiError(
          "EXPORT_FAILED",
          "当前浏览器不支持选择文件夹，请使用新版 Chrome 或 Edge。",
          { reason: "directory-picker-unavailable" }
        );
      }
      let destination;
      try {
        destination = await window.showDirectoryPicker({ mode: "readwrite" });
      } catch (error) {
        if (error?.name === "AbortError") {
          setStatus("已取消导出。", "normal");
          return;
        }
        throw error;
      }
      const batch = await loadBatch();
      if (!batch || batch.chapters.length === 0) {
        throw createUiError("EXPORT_FAILED", "请先采集章节，再导出当前批次。", {
          reason: "empty-batch",
        });
      }
      chapterCount = batch.chapters.length;
      fileCount = chapterCount;
      await logs.event("EXPORT_STARTED", { format, chapterCount }, operationId);
      const exports = core.createChapterExports(batch, format);
      fileCount = exports.length;
      const totalBytes = exports.reduce(
        (sum, exported) => sum + exported.byteLength,
        0
      );
      await logs.event(
        "EXPORT_SERIALIZED",
        {
          format,
          chapterCount,
          fileCount,
          bytes: totalBytes,
        },
        operationId
      );
      const projectDirectory = await destination.getDirectoryHandle(core.PROJECT_NAME, {
        create: true,
      });
      const bookDirectory = await projectDirectory.getDirectoryHandle(
        exports[0].folderName,
        { create: true }
      );
      for (const exported of exports) {
        setStatus(
          `正在保存章节 ${exported.fileIndex} / ${fileCount}……`,
          "normal",
          null,
          operationId
        );
        await saveChapter(bookDirectory, exported);
        savedCount += 1;
      }
      await logs.event(
        "EXPORT_SAVED",
        { format, chapterCount, fileCount },
        operationId
      );
      setStatus(`已保存 ${savedCount} 个章节文件。`, "success", "EXPORT_SAVED", operationId);
    } catch (error) {
      const rawCode = error?.code || "EXPORT_FAILED";
      const code = logs.describe(rawCode) ? rawCode : "EXPORT_FAILED";
      if (code !== "STORAGE_READ_FAILED") {
        await logs.event(
          "EXPORT_FAILED",
          {
            format,
            chapterCount,
            fileCount,
            failedCount: Math.max(0, fileCount - savedCount),
            reason: error?.details?.reason || "file-save-failed",
          },
          operationId
        );
      } else {
        await logs.event(
          "STORAGE_READ_FAILED",
          error?.details || { reason: "export-batch-read" },
          operationId
        );
      }
      setStatus(
        `${savedCount > 0 ? `已保存 ${savedCount}/${fileCount} 章。` : ""}${
          error instanceof Error ? error.message : String(error)
        }`,
        "error",
        code,
        operationId
      );
    } finally {
      actionBusy = false;
      refreshControls();
    }
  }

  async function clearBatch() {
    const count = currentBatch?.chapters?.length || 0;
    if (count === 0) {
      return;
    }
    if (!window.confirm(`确定清空当前批次的 ${count} 章吗？此操作无法撤销。`)) {
      return;
    }
    const operationId = logs.createOperationId("clear");
    actionBusy = true;
    refreshControls();
    try {
      const result = await sendBatchMessage({ type: "batch-clear" });
      renderBatch(result.batch || null);
      await logs.event(
        "BATCH_CLEARED",
        { chapterCount: result.clearedCount },
        operationId
      );
      setStatus("当前批次已清空。", "success", "BATCH_CLEARED", operationId);
    } catch (error) {
      const rawCode = error?.code || "STORAGE_WRITE_FAILED";
      const code = logs.describe(rawCode) ? rawCode : "STORAGE_WRITE_FAILED";
      await logs.event(
        code,
        error?.details || { reason: "clear-batch-failed" },
        operationId
      );
      setStatus(
        error instanceof Error ? error.message : String(error),
        "error",
        code,
        operationId
      );
    } finally {
      actionBusy = false;
      refreshControls();
    }
  }

  function readTargetCount() {
    const targetCount = Number(automationTargetInput.value);
    if (
      !Number.isInteger(targetCount) ||
      targetCount < 1 ||
      targetCount > 500
    ) {
      throw createUiError(
        "AUTOMATION_FAILED",
        "目标章数必须是 1 到 500 之间的整数。",
        { reason: "invalid-target-count" }
      );
    }
    return targetCount;
  }

  async function recordAutomationFailure(error, operationId, fallbackReason) {
    const capturedCount = getCapturedCount(automationState);
    const targetCount = getTargetCount(automationState) ||
      Math.max(0, Number(automationTargetInput.value) || 0);
    await logs
      .event(
        "AUTOMATION_FAILED",
        {
          capturedCount,
          targetCount,
          reason: error?.details?.reason || fallbackReason,
        },
        operationId
      )
      .catch(() => null);
  }

  async function startOrResumeAutomation() {
    const phase = getAutomationPhase(automationState);
    const isResume = phase === "paused";
    const operationId =
      isResume && automationState?.operationId
        ? automationState.operationId
        : logs.createOperationId("automation");
    automationBusy = true;
    refreshControls();
    setStatus(
      isResume ? "正在继续自动采集……" : "正在启动自动采集……",
      "normal",
      null,
      operationId
    );
    try {
      let response;
      if (isResume) {
        const tab = await queryActiveTab();
        response = await sendAutomationMessage("automation-resume", {
          tabId: tab.id,
          operationId,
        });
        const returnedState = getAutomationStateFromResponse(response);
        const nextState = returnedState || {
          ...automationState,
          status: "running",
          paused: false,
        };
        lastAnnouncedAutomationPhase = "requesting";
        renderAutomation(nextState, true);
        if (getAutomationPhase(nextState) === "running") {
          setStatus(
            "自动采集已继续，可以关闭弹窗；遇到验证时会自动暂停。",
            "success",
            "AUTOMATION_RESUMED",
            operationId
          );
        }
      } else {
        const targetCount = readTargetCount();
        const tab = await queryActiveTab();
        response = await sendAutomationMessage("automation-start", {
          tabId: tab.id,
          targetCount,
          format: formatSelect.value,
          operationId,
        });
        const returnedState = getAutomationStateFromResponse(response);
        const nextState = returnedState || {
          status: "running",
          capturedCount: 0,
          targetCount,
          format: formatSelect.value,
          operationId,
        };
        lastAnnouncedAutomationPhase = "requesting";
        renderAutomation(nextState, true);
        if (getAutomationPhase(nextState) === "running") {
          setStatus(
            "自动采集已开始，可以关闭弹窗；进度会由后台保存。",
            "success",
            "AUTOMATION_STARTED",
            operationId
          );
        }
      }
    } catch (error) {
      await recordAutomationFailure(
        error,
        operationId,
        isResume ? "resume-request-failed" : "start-request-failed"
      );
      setStatus(
        error instanceof Error ? error.message : String(error),
        "error",
        error?.code || "AUTOMATION_FAILED",
        operationId
      );
    } finally {
      automationBusy = false;
      refreshControls();
    }
  }

  async function stopAutomation() {
    const operationId =
      automationState?.operationId || logs.createOperationId("automation-stop");
    automationBusy = true;
    refreshControls();
    setStatus("正在停止自动采集……", "normal", null, operationId);
    try {
      const response = await sendAutomationMessage("automation-stop", {
        operationId,
      });
      const returnedState = getAutomationStateFromResponse(response);
      renderAutomation(
        returnedState || {
          ...(automationState || {}),
          status: "stopped",
          active: false,
        }
      );
      setStatus(
        `自动采集已停止，已采集的 ${getCapturedCount(automationState)} 章仍保留。`,
        "warning",
        "AUTOMATION_STOPPED",
        operationId
      );
    } catch (error) {
      await recordAutomationFailure(error, operationId, "stop-request-failed");
      setStatus(
        error instanceof Error ? error.message : String(error),
        "error",
        error?.code || "AUTOMATION_FAILED",
        operationId
      );
    } finally {
      automationBusy = false;
      refreshControls();
    }
  }

  async function loadAutomationState() {
    const response = await sendAutomationMessage("automation-get");
    renderAutomation(getAutomationStateFromResponse(response), true);
    refreshControls();
  }

  async function persistFormat() {
    try {
      const existing = (await storageGet(core.SETTINGS_STORAGE_KEY)) || {};
      await storageSet(core.SETTINGS_STORAGE_KEY, {
        ...existing,
        exportFormat: formatSelect.value,
      });
    } catch {
      console.warn("[SETTINGS_WRITE_FAILED] 导出格式偏好未保存。");
    }
  }

  async function persistAutomationTarget() {
    const targetCount = Number(automationTargetInput.value);
    if (!Number.isInteger(targetCount) || targetCount < 1 || targetCount > 500) {
      return;
    }
    try {
      const existing = (await storageGet(core.SETTINGS_STORAGE_KEY)) || {};
      await storageSet(core.SETTINGS_STORAGE_KEY, {
        ...existing,
        automationTargetCount: targetCount,
      });
    } catch {
      console.warn("[SETTINGS_WRITE_FAILED] 自动采集章数偏好未保存。");
    }
  }

  async function openDiagnostics() {
    try {
      const tab = await queryActiveTab();
      await new Promise((resolve) => {
        chrome.storage.session.set(
          {
            [core.DIAGNOSTICS_CONTEXT_KEY]: {
              tabId: tab.id,
              capturedAt: new Date().toISOString(),
            },
          },
          () => {
            void chrome.runtime.lastError;
            resolve();
          }
        );
      });
    } catch {
      // 诊断页仍可运行其他检查，因此来源标签页记录失败不阻止打开。
    }
    chrome.runtime.openOptionsPage();
  }

  async function initialize() {
    actionBusy = true;
    refreshControls();
    await logs.event("POPUP_OPENED", {}, "popup").catch(() => null);
    try {
      const settings = (await storageGet(core.SETTINGS_STORAGE_KEY)) || {};
      if (["txt", "json"].includes(settings.exportFormat)) {
        formatSelect.value = settings.exportFormat;
      }
      const preferredTarget = Number(settings.automationTargetCount);
      if (
        Number.isInteger(preferredTarget) &&
        preferredTarget >= 1 &&
        preferredTarget <= 500
      ) {
        automationTargetInput.value = String(preferredTarget);
      }
      await loadBatch();
    } catch (error) {
      const code = error?.code || "STORAGE_READ_FAILED";
      await logs.event(code, error?.details || { reason: "popup-initialize" }, "popup");
      setStatus(
        error instanceof Error ? error.message : String(error),
        "error",
        code,
        "popup"
      );
    }
    try {
      await loadAutomationState();
    } catch (error) {
      const code = error?.code || "STORAGE_READ_FAILED";
      await logs.event(
        logs.describe(code) ? code : "STORAGE_READ_FAILED",
        error?.details || { reason: "automation-state-read" },
        "popup"
      );
      setStatus(
        error instanceof Error ? error.message : String(error),
        "error",
        code,
        "popup"
      );
    }
    actionBusy = false;
    refreshControls();
  }

  captureButton.addEventListener("click", captureCurrentChapter);
  nextButton.addEventListener("click", openNextChapter);
  automationStartButton.addEventListener("click", startOrResumeAutomation);
  automationStopButton.addEventListener("click", stopAutomation);
  exportButton.addEventListener("click", exportBatch);
  clearButton.addEventListener("click", clearBatch);
  batchSelect.addEventListener("change", selectBatch);
  diagnosticsButton.addEventListener("click", () => void openDiagnostics());
  formatSelect.addEventListener("change", persistFormat);
  automationTargetInput.addEventListener("change", () => {
    if (getAutomationPhase(automationState) === "idle") {
      renderAutomation(null);
    }
    void persistAutomationTarget();
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes[core.BATCH_STORAGE_KEY]) {
      void loadBatch().catch((error) => {
        setStatus(error.message, "error", "STORAGE_READ_FAILED");
      });
    }
    if (areaName === "session" && changes[automationStorageKey]) {
      renderAutomation(changes[automationStorageKey].newValue || null, true);
      refreshControls();
    }
  });

  renderBatch(null);
  renderAutomation(null);
  refreshControls();
  void initialize();
})();
