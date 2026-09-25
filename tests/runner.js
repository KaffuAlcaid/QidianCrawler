(function runBrowserTests() {
  "use strict";


  const core = QidianCrawlerCore;
  const batchStoreApi = QidianCrawlerBatchStore;
  const extractor = QidianCrawlerExtractor;
  const logStoreApi = QidianCrawlerLogStore;
  const downloadTrackerApi = QidianCrawlerDownloadTracker;
  const automationStateApi = QidianCrawlerAutomationState;
  const automationControllerApi = QidianCrawlerAutomationController;
  const pageReadinessApi = QidianCrawlerPageReadiness;
  const tests = [];

  function test(name, callback) {
    tests.push({ name, callback });
  }

  function assert(condition, message = "断言失败") {
    if (!condition) {
      throw new Error(message);
    }
  }

  function equal(actual, expected, message = "值不相等") {
    if (actual !== expected) {
      throw new Error(`${message}：实际 ${JSON.stringify(actual)}，预期 ${JSON.stringify(expected)}`);
    }
  }

  function throwsCode(callback, expectedCode) {
    let caught = null;
    try {
      callback();
    } catch (error) {
      caught = error;
    }
    assert(caught, `预期抛出 ${expectedCode}`);
    equal(caught.code, expectedCode, "异常码不匹配");
  }

  async function rejectsCode(callback, expectedCode) {
    let caught = null;
    try {
      await callback();
    } catch (error) {
      caught = error;
    }
    assert(caught, `预期异步抛出 ${expectedCode}`);
    equal(caught.code, expectedCode, "异步异常码不匹配");
  }

  function sampleChapter(chapterId, bookId = "1024424884") {
    return {
      bookId,
      bookTitle: bookId === "1024424884" ? "铁血残明" : "另一部书",
      chapterId,
      title: `第${chapterId}章`,
      paragraphs: ["合成段落一。", "合成段落二。"],
      sourceUrl: `https://www.qidian.com/chapter/${bookId}/${chapterId}/?tracking=removed`,
      nextUrl: null,
    };
  }

  function createAsyncBatchStorage(initial = {}, delayMs = 1) {
    const clone = (value) =>
      value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    const values = clone(initial) || {};
    let writeCount = 0;
    const pause = () => new Promise((resolve) => setTimeout(resolve, delayMs));
    return {
      async get(key) {
        await pause();
        return clone(values[key]);
      },
      async set(key, value) {
        await pause();
        writeCount += 1;
        values[key] = clone(value);
      },
      async remove(key) {
        await pause();
        delete values[key];
      },
      async getBytesInUse(key = null) {
        await pause();
        const keys = key === null
          ? Object.keys(values)
          : Array.isArray(key)
            ? key
            : [key];
        return keys.reduce((total, itemKey) => {
          if (!Object.prototype.hasOwnProperty.call(values, itemKey)) {
            return total;
          }
          return total + core.estimateUtf8Bytes(itemKey) +
            core.estimateUtf8Bytes(values[itemKey]);
        }, 0);
      },
      snapshot() {
        return clone(values);
      },
      get writeCount() {
        return writeCount;
      },
    };
  }

  function createFaultyLogStorage(initial = {}) {
    const memory = logStoreApi.createMemoryStorageAdapter(initial);
    let nextWriteError = null;
    return {
      get: (key) => memory.get(key),
      async set(key, value) {
        if (nextWriteError) {
          const error = nextWriteError;
          nextWriteError = null;
          throw error;
        }
        await memory.set(key, value);
      },
      remove: (key) => memory.remove(key),
      snapshot: () => memory.snapshot(),
      failNextWrite(message) {
        nextWriteError = new Error(message);
      },
    };
  }

  function createSessionStorage(initial = {}) {
    const clone = (value) =>
      value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    const values = clone(initial) || {};
    return {
      async get(key) {
        return { [key]: clone(values[key]) };
      },
      async set(items) {
        Object.assign(values, clone(items));
      },
      async remove(key) {
        delete values[key];
      },
      snapshot() {
        return clone(values);
      },
    };
  }

  function automaticChapter(chapterId, nextChapterId = null) {
    const chapter = sampleChapter(chapterId);
    const nextUrl = nextChapterId
      ? `https://www.qidian.com/chapter/${chapter.bookId}/${nextChapterId}`
      : null;
    return {
      ...chapter,
      ok: true,
      adapterId: "qidian",
      nextUrl,
      nextNavigationUrl: nextUrl ? `${nextUrl}/?from=automatic-test` : null,
    };
  }

  function batchFrom(chapters) {
    let batch = null;
    for (const chapter of chapters) {
      batch = core.addChapter(
        batch,
        chapter,
        "2026-01-01T00:00:00.000Z"
      ).batch;
    }
    return batch;
  }

  function createAutomationHarness(options = {}) {
    const extractionQueue = [...(options.extractions || [])];
    const batchStorage = createAsyncBatchStorage(
      options.batch
        ? { [core.BATCH_STORAGE_KEY]: options.batch }
        : {}
    );
    const batchStore = batchStoreApi.createBatchStore({
      storage: batchStorage,
      quotaBytes: 10 * 1024 * 1024,
      reserveBytes: 1024,
    });
    const sessionStorage = createSessionStorage(
      options.state
        ? { [automationStateApi.AUTOMATION_STORAGE_KEY]: options.state }
        : {}
    );
    const navigations = [];
    const downloads = [];
    const records = [];
    const badges = [];
    const delays = [];
    let extractionCalls = 0;
    const controller = automationControllerApi.createAutomationController({
      stateApi: automationStateApi,
      core,
      batchStore,
      storageArea: sessionStorage,
      async extractPage(tabId) {
        extractionCalls += 1;
        const next = extractionQueue.shift();
        if (next instanceof Error) {
          throw next;
        }
        if (typeof next === "function") {
          return next(tabId);
        }
        if (next === undefined) {
          throw new Error("测试没有提供下一次页面提取结果");
        }
        return next;
      },
      async navigateTab(tabId, url) {
        navigations.push({ tabId, url });
        if (options.navigationError) {
          throw options.navigationError;
        }
        return { id: tabId, status: "loading", url };
      },
      async getTab(tabId) {
        if (options.getTabError) {
          throw options.getTabError;
        }
        if (options.tab === null) {
          return null;
        }
        return options.tab || {
          id: tabId,
          status: "complete",
          url: "https://www.qidian.com/chapter/1024424884/1/",
        };
      },
      async inspectDownload(downloadId) {
        if (typeof options.inspectDownload === "function") {
          return options.inspectDownload(downloadId);
        }
        if (
          options.downloadStates &&
          Object.prototype.hasOwnProperty.call(
            options.downloadStates,
            String(downloadId)
          )
        ) {
          return options.downloadStates[String(downloadId)];
        }
        return { state: "in_progress" };
      },
      async getPendingTrackedDownloadCount() {
        if (typeof options.getPendingTrackedDownloadCount === "function") {
          return options.getPendingTrackedDownloadCount();
        }
        return Number(options.pendingTrackedDownloadCount || 0);
      },
      async downloadExport(exported, operationId, metadata) {
        downloads.push({ exported, operationId, metadata });
        const callIndex = downloads.length - 1;
        if (
          options.downloadError &&
          (options.downloadErrorAt === undefined ||
            options.downloadErrorAt === callIndex)
        ) {
          throw options.downloadError;
        }
        const downloadId =
          options.downloadIds?.[callIndex] ??
          (options.downloadId ?? 101) + callIndex;
        const hasTerminalOverride =
          Array.isArray(options.downloadTerminals) &&
          Object.prototype.hasOwnProperty.call(
            options.downloadTerminals,
            callIndex
          );
        const terminal = hasTerminalOverride
          ? options.downloadTerminals[callIndex]
          : null;
        return terminal ? { downloadId, terminal } : { downloadId };
      },
      async record(code, operationId, details, eventKey) {
        records.push({ code, operationId, details, eventKey });
      },
      async setBadge(state) {
        badges.push(state ? automationStateApi.toPublicView(state) : null);
      },
      async delay(milliseconds) {
        delays.push(milliseconds);
      },
      now: () => "2026-01-01T00:00:00.000Z",
    });
    return {
      controller,
      batchStore,
      batchStorage,
      sessionStorage,
      extractionQueue,
      navigations,
      downloads,
      records,
      badges,
      delays,
      get extractionCalls() {
        return extractionCalls;
      },
    };
  }

  test("自动状态校验目标和格式并可接管已有批次", () => {
    const base = {
      tabId: 7,
      targetCount: 1,
      format: "txt",
      operationId: "auto-boundary",
      batchChapterCount: 0,
    };
    throwsCode(
      () => automationStateApi.start({ ...base, targetCount: 0 }),
      automationStateApi.ERROR_CODES.INVALID_TARGET_COUNT
    );
    throwsCode(
      () => automationStateApi.start({ ...base, targetCount: 501 }),
      automationStateApi.ERROR_CODES.INVALID_TARGET_COUNT
    );
    throwsCode(
      () => automationStateApi.start({ ...base, format: "csv" }),
      automationStateApi.ERROR_CODES.INVALID_FORMAT
    );
    const continued = automationStateApi.start(
      {
        ...base,
        targetCount: 3,
        batchChapterCount: 1,
        initialChapterKeys: ["1024424884:1"],
      },
      "2026-01-01T00:00:00.000Z"
    );
    equal(continued.capturedCount, 1);
    equal(continued.visitedChapterKeys.length, 1);
    equal(continued.visitedChapterKeys[0], "1024424884:1");
    throwsCode(
      () =>
        automationStateApi.start({
          ...base,
          targetCount: 1,
          batchChapterCount: 2,
          initialChapterKeys: ["1024424884:1", "1024424884:2"],
        }),
      automationStateApi.ERROR_CODES.BATCH_TARGET_TOO_SMALL
    );
    throwsCode(
      () =>
        automationStateApi.start({
          ...base,
          targetCount: 2,
          batchChapterCount: 1,
          initialChapterKeys: [],
        }),
      automationStateApi.ERROR_CODES.BATCH_KEYS_INVALID
    );
    throwsCode(
      () =>
        automationStateApi.start({
          ...base,
          targetCount: 2,
          batchChapterCount: 2,
          initialChapterKeys: ["1024424884:1", "1024424884:1"],
        }),
      automationStateApi.ERROR_CODES.BATCH_KEYS_INVALID
    );

    const state = automationStateApi.start(base, "2026-01-01T00:00:00.000Z");
    const invalid = automationStateApi.validate({
      ...state,
      phase: automationStateApi.PHASE.WAITING_NAVIGATION,
    });
    equal(invalid.ok, false);
    equal(invalid.code, automationStateApi.ERROR_CODES.INVALID_NEXT_URL);
  });

  test("自动状态按采集、翻页、验证、导出和完成顺序转换", () => {
    const timestamp = "2026-01-01T00:00:00.000Z";
    let state = automationStateApi.start(
      {
        tabId: 7,
        targetCount: 2,
        format: "json",
        operationId: "auto-transitions",
        batchChapterCount: 0,
      },
      timestamp
    );
    state = automationStateApi.updateProgress(
      state,
      {
        chapterKey: "1024424884:1",
        capturedCount: 1,
        nextNavigationUrl:
          "https://www.qidian.com/chapter/1024424884/2/?private=removed",
      },
      timestamp
    );
    state = automationStateApi.waitForNavigation(state, null, timestamp);
    equal(state.phase, automationStateApi.PHASE.WAITING_NAVIGATION);
    state = automationStateApi.pauseForChallenge(
      state,
      { code: "CHALLENGE_DETECTED", message: "等待人工验证。" },
      timestamp
    );
    equal(state.status, automationStateApi.STATUS.PAUSED);
    state = automationStateApi.resume(state, timestamp);
    equal(state.phase, automationStateApi.PHASE.CAPTURING);
    state = automationStateApi.updateProgress(
      state,
      { chapterKey: "1024424884:2", capturedCount: 2 },
      timestamp
    );
    state = automationStateApi.beginExport(state, timestamp);
    equal(state.phase, automationStateApi.PHASE.EXPORTING);
    state = automationStateApi.acceptDownload(state, 91, timestamp);
    state = automationStateApi.acceptDownload(state, 92, timestamp);
    state = automationStateApi.settleDownload(state, 91, true, timestamp);
    state = automationStateApi.settleDownload(state, 92, true, timestamp);
    state = automationStateApi.complete(state, timestamp);
    equal(state.status, automationStateApi.STATUS.COMPLETED);
    equal(state.downloadIds.length, 2);
    equal(state.downloadIds[0], 91);
    equal(state.downloadIds[1], 92);
    throwsCode(
      () => automationStateApi.resume(state, timestamp),
      automationStateApi.ERROR_CODES.INVALID_TRANSITION
    );
  });

  test("自动公开状态不包含翻页地址和章节标识", () => {
    const timestamp = "2026-01-01T00:00:00.000Z";
    let state = automationStateApi.start(
      {
        tabId: 7,
        targetCount: 2,
        format: "txt",
        operationId: "auto-private-view",
        batchChapterCount: 0,
      },
      timestamp
    );
    state = automationStateApi.updateProgress(
      state,
      {
        chapterKey: "1024424884:1",
        nextNavigationUrl:
          "https://www.qidian.com/chapter/1024424884/2/?private=removed",
      },
      timestamp
    );
    const view = automationStateApi.toPublicView(state);
    assert(!Object.prototype.hasOwnProperty.call(view, "nextNavigationUrl"));
    assert(!Object.prototype.hasOwnProperty.call(view, "visitedChapterKeys"));
    assert(!Object.prototype.hasOwnProperty.call(view, "downloadIds"));
    assert(!Object.prototype.hasOwnProperty.call(view, "completedDownloadIds"));
    assert(!Object.prototype.hasOwnProperty.call(view, "failedDownloadIds"));
    equal(view.acceptedFileCount, 0);
    equal(view.downloadedFileCount, 0);
    equal(view.failedFileCount, 0);
    equal(view.pendingFileCount, 0);
    equal(view.batchLocked, true);
    const serialized = JSON.stringify(view);
    assert(!serialized.includes("private=removed"));
    assert(!serialized.includes("1024424884:1"));
  });

  test("控制器目标一章时采集并自动导出一次", async () => {
    const harness = createAutomationHarness({
      extractions: [automaticChapter("1")],
      downloadId: 31,
    });
    const exporting = await harness.controller.start({
      tabId: 7,
      targetCount: 1,
      format: "txt",
      operationId: "auto-one",
    });
    equal(exporting.status, automationStateApi.STATUS.RUNNING);
    equal(exporting.phase, automationStateApi.PHASE.EXPORTING);
    equal(exporting.capturedCount, 1);
    equal(exporting.acceptedFileCount, 1);
    equal(exporting.downloadedFileCount, 0);
    equal(exporting.pendingFileCount, 1);
    equal(
      (await automationStateApi.load(harness.sessionStorage)).downloadIds[0],
      31
    );
    equal(harness.downloads.length, 1);
    equal(
      harness.downloads[0].exported.relativePath,
      "QidianCrawler/铁血残明-1章/第1章.txt"
    );
    const completed = await harness.controller.handleDownloadSettled(31, true);
    equal(completed.status, automationStateApi.STATUS.COMPLETED);
    equal(completed.downloadedFileCount, 1);
    equal(completed.pendingFileCount, 0);
    await harness.controller.reconcile();
    await harness.controller.getState();
    equal(harness.downloads.length, 1, "完成后对账触发了重复下载");
  });

  test("自动导出会等待全部浏览器下载终态后才完成", async () => {
    const harness = createAutomationHarness({
      batch: batchFrom([automaticChapter("1", "2"), automaticChapter("2")]),
      downloadIds: [201, 202],
    });
    const exporting = await harness.controller.start({
      tabId: 7,
      targetCount: 2,
      format: "txt",
      operationId: "auto-wait-downloads",
    });
    equal(exporting.status, automationStateApi.STATUS.RUNNING);
    equal(exporting.phase, automationStateApi.PHASE.EXPORTING);
    equal(exporting.acceptedFileCount, 2);
    equal(exporting.downloadedFileCount, 0);
    equal(exporting.pendingFileCount, 2);
    equal(exporting.batchLocked, true);

    const unrelated = await harness.controller.handleDownloadSettled(999, true);
    equal(unrelated.pendingFileCount, 2, "无关下载改变了自动任务状态");
    const oneCompleted = await harness.controller.handleDownloadSettled(
      202,
      true
    );
    equal(oneCompleted.status, automationStateApi.STATUS.RUNNING);
    equal(oneCompleted.downloadedFileCount, 1);
    equal(oneCompleted.pendingFileCount, 1);

    const duplicate = await harness.controller.handleDownloadSettled(
      202,
      false
    );
    equal(duplicate.downloadedFileCount, 1);
    equal(duplicate.failedFileCount, 0, "重复的相反终态覆盖了首次终态");
    const completed = await harness.controller.handleDownloadSettled(201, true);
    equal(completed.status, automationStateApi.STATUS.COMPLETED);
    equal(completed.downloadedFileCount, 2);
    equal(completed.pendingFileCount, 0);
    equal(completed.batchLocked, false);
  });

  test("下载失败后会保留待定下载锁并继续收敛终态", async () => {
    const harness = createAutomationHarness({
      batch: batchFrom([automaticChapter("1", "2"), automaticChapter("2")]),
      downloadIds: [211, 212],
    });
    const exporting = await harness.controller.start({
      tabId: 7,
      targetCount: 2,
      format: "json",
      operationId: "auto-terminal-failure",
    });
    equal(exporting.status, automationStateApi.STATUS.RUNNING);
    equal(exporting.phase, automationStateApi.PHASE.EXPORTING);
    equal(exporting.acceptedFileCount, 2);
    equal(exporting.downloadedFileCount, 0);
    equal(exporting.pendingFileCount, 2);

    const failed = await harness.controller.handleDownloadSettled(211, false);
    equal(failed.status, automationStateApi.STATUS.FAILED);
    equal(failed.failedFileCount, 1);
    equal(failed.pendingFileCount, 1);
    equal(failed.batchLocked, true);
    await rejectsCode(
      () => harness.controller.clearBatch(),
      "AUTOMATION_BATCH_LOCKED"
    );
    equal((await harness.batchStore.getBatch()).chapters.length, 2);

    const settled = await harness.controller.handleDownloadSettled(212, true);
    equal(settled.status, automationStateApi.STATUS.FAILED);
    equal(settled.downloadedFileCount, 1);
    equal(settled.pendingFileCount, 0);
    equal(settled.batchLocked, false);
    const cleared = await harness.controller.clearBatch();
    equal(cleared.clearedCount, 2);
    equal(await harness.batchStore.getBatch(), null);
  });

  test("部分文件提交失败时未结束的已受理下载仍锁定批次", async () => {
    const harness = createAutomationHarness({
      batch: batchFrom([automaticChapter("1", "2"), automaticChapter("2")]),
      downloadIds: [221, 222],
      downloadError: new Error("合成的下载 API 拒绝"),
      downloadErrorAt: 1,
    });
    const failed = await harness.controller.start({
      tabId: 7,
      targetCount: 2,
      format: "txt",
      operationId: "auto-partial-rejection",
    });
    equal(failed.status, automationStateApi.STATUS.FAILED);
    equal(failed.acceptedFileCount, 1);
    equal(failed.pendingFileCount, 1);
    equal(failed.batchLocked, true);
    await rejectsCode(
      () =>
        harness.controller.start({
          tabId: 7,
          targetCount: 2,
          format: "txt",
          operationId: "auto-restart-too-early",
        }),
      "AUTOMATION_DOWNLOADS_PENDING"
    );

    const settled = await harness.controller.handleDownloadSettled(221, true);
    equal(settled.status, automationStateApi.STATUS.FAILED);
    equal(settled.pendingFileCount, 0);
    equal(settled.batchLocked, false);
  });

  test("旧版仅记录受理 ID 的完成状态会重新查询真实下载终态", async () => {
    const timestamp = "2026-01-01T00:00:00.000Z";
    let legacy = automationStateApi.start(
      {
        tabId: 7,
        targetCount: 1,
        format: "txt",
        operationId: "auto-legacy-completed",
        batchChapterCount: 1,
        initialChapterKeys: ["1024424884:1"],
      },
      timestamp
    );
    legacy = automationStateApi.beginExport(legacy, timestamp);
    legacy = automationStateApi.acceptDownload(legacy, 231, timestamp);
    legacy = automationStateApi.settleDownload(legacy, 231, true, timestamp);
    legacy = automationStateApi.complete(legacy, timestamp);
    delete legacy.completedDownloadIds;
    delete legacy.failedDownloadIds;

    let observed = { state: "in_progress" };
    const harness = createAutomationHarness({
      state: legacy,
      batch: batchFrom([automaticChapter("1")]),
      inspectDownload: async () => observed,
    });
    const exporting = await harness.controller.getState();
    equal(exporting.status, automationStateApi.STATUS.RUNNING);
    equal(exporting.phase, automationStateApi.PHASE.EXPORTING);
    equal(exporting.downloadedFileCount, 0);
    equal(exporting.pendingFileCount, 1);
    equal(exporting.batchLocked, true);

    observed = { state: "complete" };
    const completed = await harness.controller.reconcile();
    equal(completed.status, automationStateApi.STATUS.COMPLETED);
    equal(completed.downloadedFileCount, 1);
    equal(completed.batchLocked, false);
    equal(harness.downloads.length, 0, "旧会话恢复时重复提交了下载");
  });

  test("自动状态丢失后本地下载跟踪仍会锁定批次", async () => {
    let pending = true;
    const harness = createAutomationHarness({
      batch: batchFrom([automaticChapter("1")]),
      getPendingTrackedDownloadCount: async () => (pending ? 1 : 0),
    });
    const recoveryView = await harness.controller.getState();
    equal(recoveryView.recoveryLock, true);
    equal(recoveryView.pendingFileCount, 1);
    equal(recoveryView.batchLocked, true);
    await rejectsCode(
      () => harness.controller.addChapter(automaticChapter("2")),
      "AUTOMATION_BATCH_LOCKED"
    );
    await rejectsCode(
      () => harness.controller.clearBatch(),
      "AUTOMATION_BATCH_LOCKED"
    );
    await rejectsCode(
      () =>
        harness.controller.start({
          tabId: 7,
          targetCount: 1,
          format: "txt",
          operationId: "auto-tracker-lock",
        }),
      "AUTOMATION_DOWNLOADS_PENDING"
    );
    equal((await harness.batchStore.getBatch()).chapters.length, 1);

    pending = false;
    const cleared = await harness.controller.clearBatch();
    equal(cleared.clearedCount, 1);
  });

  test("全部文件已受理后等待终态不再依赖章节批次", async () => {
    const timestamp = "2026-01-01T00:00:00.000Z";
    let state = automationStateApi.start(
      {
        tabId: 7,
        targetCount: 1,
        format: "json",
        operationId: "auto-wait-without-batch",
        batchChapterCount: 1,
        initialChapterKeys: ["1024424884:1"],
      },
      timestamp
    );
    state = automationStateApi.beginExport(state, timestamp);
    state = automationStateApi.acceptDownload(state, 241, timestamp);
    const harness = createAutomationHarness({
      state,
      inspectDownload: async () => ({ state: "in_progress" }),
    });

    const fromPopup = await harness.controller.getState();
    equal(fromPopup.status, automationStateApi.STATUS.RUNNING);
    equal(fromPopup.phase, automationStateApi.PHASE.EXPORTING);
    equal(fromPopup.pendingFileCount, 1);
    const reconciled = await harness.controller.reconcile();
    equal(reconciled.status, automationStateApi.STATUS.RUNNING);
    equal(reconciled.pendingFileCount, 1);
    equal(harness.downloads.length, 0);

    const completed = await harness.controller.handleDownloadSettled(241, true);
    equal(completed.status, automationStateApi.STATUS.COMPLETED);
    equal(completed.downloadedFileCount, 1);
  });

  test("控制器目标两章时等待页面完成后继续且忽略重复完成事件", async () => {
    const harness = createAutomationHarness({
      extractions: [automaticChapter("1", "2"), automaticChapter("2")],
      downloadIds: [251, 252],
    });
    const first = await harness.controller.start({
      tabId: 7,
      targetCount: 2,
      format: "json",
      operationId: "auto-two",
    });
    equal(first.phase, automationStateApi.PHASE.WAITING_NAVIGATION);
    equal(first.capturedCount, 1);
    equal(harness.navigations.length, 1);
    equal(harness.delays.length, 1, "翻页前没有执行固定等待");
    equal(
      harness.delays[0],
      automationControllerApi.DEFAULT_NAVIGATION_DELAY_MS,
      "翻页等待时长不是控制器默认值"
    );
    equal(
      harness.navigations[0].url,
      "https://www.qidian.com/chapter/1024424884/2/"
    );

    await harness.controller.handleTabUpdated(7, { status: "loading" });
    await harness.controller.handleTabUpdated(8, { status: "complete" });
    equal(harness.extractionCalls, 1);
    const exporting = await harness.controller.handleTabUpdated(7, {
      status: "complete",
    });
    equal(exporting.status, automationStateApi.STATUS.RUNNING);
    equal(exporting.phase, automationStateApi.PHASE.EXPORTING);
    equal(exporting.capturedCount, 2);
    equal(exporting.acceptedFileCount, 2);
    equal(exporting.downloadedFileCount, 0);
    equal(exporting.pendingFileCount, 2);
    const partlyCompleted = await harness.controller.handleDownloadSettled(
      251,
      true
    );
    equal(partlyCompleted.status, automationStateApi.STATUS.RUNNING);
    equal(partlyCompleted.downloadedFileCount, 1);
    equal(partlyCompleted.pendingFileCount, 1);
    const completed = await harness.controller.handleDownloadSettled(
      252,
      true
    );
    equal(completed.status, automationStateApi.STATUS.COMPLETED);
    equal(completed.downloadedFileCount, 2);
    equal(completed.pendingFileCount, 0);
    await harness.controller.handleTabUpdated(7, { status: "complete" });
    equal(harness.extractionCalls, 2);
    equal(harness.downloads.length, 2, "每章没有各生成一个下载");
    equal(
      harness.downloads[1].exported.relativePath,
      "QidianCrawler/铁血残明-2章/第2章.json"
    );
  });

  test("控制器沿用已有一章并从当前页继续下一章", async () => {
    const firstChapter = automaticChapter("1", "2");
    const harness = createAutomationHarness({
      batch: batchFrom([firstChapter]),
      extractions: [firstChapter, automaticChapter("2")],
      downloadIds: [261, 262],
    });
    const waiting = await harness.controller.start({
      tabId: 7,
      targetCount: 2,
      format: "txt",
      operationId: "auto-existing-one",
    });
    equal(waiting.phase, automationStateApi.PHASE.WAITING_NAVIGATION);
    equal(waiting.capturedCount, 1);
    equal(harness.navigations.length, 1);
    equal(harness.delays.length, 1);

    const exporting = await harness.controller.handleTabUpdated(7, {
      status: "complete",
    });
    equal(exporting.status, automationStateApi.STATUS.RUNNING);
    equal(exporting.phase, automationStateApi.PHASE.EXPORTING);
    equal(exporting.capturedCount, 2);
    equal(exporting.acceptedFileCount, 2);
    equal(exporting.downloadedFileCount, 0);
    equal(exporting.pendingFileCount, 2);
    equal((await harness.batchStore.getBatch()).chapters.length, 2);
    equal(harness.downloads.length, 2);
    const partlyCompleted = await harness.controller.handleDownloadSettled(
      261,
      true
    );
    equal(partlyCompleted.status, automationStateApi.STATUS.RUNNING);
    equal(partlyCompleted.pendingFileCount, 1);
    const completed = await harness.controller.handleDownloadSettled(
      262,
      true
    );
    equal(completed.status, automationStateApi.STATUS.COMPLETED);
    equal(completed.downloadedFileCount, 2);
    equal(completed.pendingFileCount, 0);
  });

  test("控制器在已有批次等于目标时直接导出", async () => {
    const harness = createAutomationHarness({
      batch: batchFrom([automaticChapter("1")]),
      downloadId: 271,
    });
    const exporting = await harness.controller.start({
      tabId: 7,
      targetCount: 1,
      format: "json",
      operationId: "auto-existing-complete",
    });
    equal(exporting.status, automationStateApi.STATUS.RUNNING);
    equal(exporting.phase, automationStateApi.PHASE.EXPORTING);
    equal(exporting.capturedCount, 1);
    equal(exporting.acceptedFileCount, 1);
    equal(exporting.downloadedFileCount, 0);
    equal(exporting.pendingFileCount, 1);
    equal(harness.extractionCalls, 0, "已达到目标时不应再提取页面");
    equal(harness.navigations.length, 0);
    equal(harness.delays.length, 0);
    equal(harness.downloads.length, 1);
    const completed = await harness.controller.handleDownloadSettled(
      271,
      true
    );
    equal(completed.status, automationStateApi.STATUS.COMPLETED);
    equal(completed.downloadedFileCount, 1);
    equal(completed.pendingFileCount, 0);
  });

  test("验证页会暂停，错误标签页不能继续，回到原标签页后可恢复", async () => {
    const harness = createAutomationHarness({
      extractions: [
        {
          ok: false,
          reason: "challenge-page",
          challengeIndicator: "geetest",
          adapterId: "qidian",
        },
      ],
      downloadId: 281,
    });
    const paused = await harness.controller.start({
      tabId: 7,
      targetCount: 1,
      format: "txt",
      operationId: "auto-challenge",
    });
    equal(paused.status, automationStateApi.STATUS.PAUSED);
    equal(paused.phase, automationStateApi.PHASE.CHALLENGE);
    equal(paused.lastError.code, "CHALLENGE_DETECTED");
    equal(harness.downloads.length, 0);
    assert(
      harness.records.some(
        (entry) => entry.code === "AUTOMATION_CHALLENGE_PAUSED"
      )
    );

    await rejectsCode(
      () =>
        harness.controller.resume({
          tabId: 8,
          operationId: "auto-challenge",
        }),
      "AUTOMATION_TAB_MISMATCH"
    );
    equal(
      (await harness.controller.getState()).status,
      automationStateApi.STATUS.PAUSED
    );
    harness.extractionQueue.push(automaticChapter("1"));
    const exporting = await harness.controller.resume({
      tabId: 7,
      operationId: "auto-challenge",
    });
    equal(exporting.status, automationStateApi.STATUS.RUNNING);
    equal(exporting.phase, automationStateApi.PHASE.EXPORTING);
    equal(exporting.acceptedFileCount, 1);
    equal(exporting.downloadedFileCount, 0);
    equal(exporting.pendingFileCount, 1);
    equal(harness.downloads.length, 1);
    const completed = await harness.controller.handleDownloadSettled(
      281,
      true
    );
    equal(completed.status, automationStateApi.STATUS.COMPLETED);
    equal(completed.downloadedFileCount, 1);
    equal(completed.pendingFileCount, 0);
  });

  test("页面提取抛错时自动模式失败而不是等待验证", async () => {
    const extractionError = new Error("合成的脚本注入失败");
    extractionError.code = "SCRIPT_INJECTION_FAILED";
    const harness = createAutomationHarness({
      extractions: [extractionError],
    });
    const failed = await harness.controller.start({
      tabId: 7,
      targetCount: 1,
      format: "txt",
      operationId: "auto-extraction-error",
    });

    equal(failed.status, automationStateApi.STATUS.FAILED);
    equal(failed.phase, automationStateApi.PHASE.FAILED);
    equal(failed.lastError.code, "AUTOMATION_PAGE_INSPECTION_FAILED");
    assert(
      harness.records.some((entry) => entry.code === "AUTOMATION_FAILED"),
      "页面提取抛错后没有记录自动模式失败"
    );
    assert(
      !harness.records.some(
        (entry) => entry.code === "AUTOMATION_CHALLENGE_PAUSED"
      ),
      "页面提取抛错被误记为等待验证"
    );
  });

  test("后台恢复时找不到目标标签页会留下失败终态", async () => {
    const state = automationStateApi.start(
      {
        tabId: 7,
        targetCount: 1,
        format: "txt",
        operationId: "auto-missing-tab",
        batchChapterCount: 0,
      },
      "2026-01-01T00:00:00.000Z"
    );
    const harness = createAutomationHarness({ state, tab: null });
    const result = await harness.controller.reconcile();
    equal(result.status, automationStateApi.STATUS.FAILED);
    equal(result.lastError.code, "AUTOMATION_TAB_MISSING");
    equal(harness.downloads.length, 0);
  });

  test("停止自动模式会保留已采集批次并忽略后续页面事件", async () => {
    const harness = createAutomationHarness({
      extractions: [automaticChapter("1", "2")],
    });
    await harness.controller.start({
      tabId: 7,
      targetCount: 2,
      format: "txt",
      operationId: "auto-stop",
    });
    const stopped = await harness.controller.stop({
      operationId: "auto-stop",
    });
    equal(stopped.status, automationStateApi.STATUS.STOPPED);
    equal((await harness.batchStore.getBatch()).chapters.length, 1);
    await harness.controller.handleTabUpdated(7, { status: "complete" });
    equal(harness.extractionCalls, 1);
    equal(harness.downloads.length, 0);
  });

  test("关闭目标标签页会终止自动模式", async () => {
    const harness = createAutomationHarness({
      extractions: [automaticChapter("1", "2")],
    });
    await harness.controller.start({
      tabId: 7,
      targetCount: 2,
      format: "txt",
      operationId: "auto-close-tab",
    });
    const failed = await harness.controller.handleTabRemoved(7);
    equal(failed.status, automationStateApi.STATUS.FAILED);
    equal(failed.lastError.code, "AUTOMATION_TAB_CLOSED");
    await harness.controller.handleTabRemoved(8);
    equal(harness.downloads.length, 0);
  });

  test("后台中断后会从批次恢复未落盘进度并完成剩余章节", async () => {
    const state = automationStateApi.start(
      {
        tabId: 7,
        targetCount: 2,
        format: "txt",
        operationId: "auto-batch-recovery",
        batchChapterCount: 0,
      },
      "2026-01-01T00:00:00.000Z"
    );
    const harness = createAutomationHarness({
      state,
      batch: batchFrom([automaticChapter("1", "2")]),
      extractions: [automaticChapter("2")],
      downloadIds: [291, 292],
    });
    const exporting = await harness.controller.reconcile();
    equal(exporting.status, automationStateApi.STATUS.RUNNING);
    equal(exporting.phase, automationStateApi.PHASE.EXPORTING);
    equal(exporting.capturedCount, 2);
    equal(exporting.acceptedFileCount, 2);
    equal(exporting.downloadedFileCount, 0);
    equal(exporting.pendingFileCount, 2);
    equal((await harness.batchStore.getBatch()).chapters.length, 2);
    equal(harness.extractionCalls, 1);
    equal(harness.downloads.length, 2);
    const partlyCompleted = await harness.controller.handleDownloadSettled(
      291,
      true
    );
    equal(partlyCompleted.status, automationStateApi.STATUS.RUNNING);
    equal(partlyCompleted.pendingFileCount, 1);
    const completed = await harness.controller.handleDownloadSettled(
      292,
      true
    );
    equal(completed.status, automationStateApi.STATUS.COMPLETED);
    equal(completed.downloadedFileCount, 2);
    equal(completed.pendingFileCount, 0);
  });

  test("导出阶段已有部分下载时恢复只提交剩余章节文件", async () => {
    const timestamp = "2026-01-01T00:00:00.000Z";
    let state = automationStateApi.start(
      {
        tabId: 7,
        targetCount: 2,
        format: "json",
        operationId: "auto-download-recovery",
        batchChapterCount: 0,
      },
      timestamp
    );
    state = automationStateApi.updateProgress(
      state,
      {
        chapterKey: "1024424884:1",
        capturedCount: 1,
        nextNavigationUrl: "https://www.qidian.com/chapter/1024424884/2/",
      },
      timestamp
    );
    state = automationStateApi.updateProgress(
      state,
      { chapterKey: "1024424884:2", capturedCount: 2 },
      timestamp
    );
    state = automationStateApi.beginExport(state, timestamp);
    state = automationStateApi.acceptDownload(state, 88, timestamp);
    const harness = createAutomationHarness({
      state,
      batch: batchFrom([automaticChapter("1", "2"), automaticChapter("2")]),
      downloadId: 89,
    });
    const exporting = await harness.controller.reconcile();
    equal(exporting.status, automationStateApi.STATUS.RUNNING);
    equal(exporting.phase, automationStateApi.PHASE.EXPORTING);
    equal(exporting.acceptedFileCount, 2);
    equal(exporting.downloadedFileCount, 0);
    equal(exporting.pendingFileCount, 2);
    const internalExporting = await automationStateApi.load(
      harness.sessionStorage
    );
    equal(internalExporting.downloadIds.length, 2);
    equal(internalExporting.downloadIds[0], 88);
    equal(internalExporting.downloadIds[1], 89);
    equal(harness.downloads.length, 1, "没有只补交剩余章节文件");
    equal(harness.downloads[0].metadata.fileIndex, 2);
    const partlyCompleted = await harness.controller.handleDownloadSettled(
      88,
      true
    );
    equal(partlyCompleted.status, automationStateApi.STATUS.RUNNING);
    equal(partlyCompleted.downloadedFileCount, 1);
    equal(partlyCompleted.pendingFileCount, 1);
    const completed = await harness.controller.handleDownloadSettled(89, true);
    equal(completed.status, automationStateApi.STATUS.COMPLETED);
    equal(completed.downloadedFileCount, 2);
    equal(completed.pendingFileCount, 0);
    await harness.controller.reconcile();
    equal(harness.downloads.length, 1);
  });

  test("提取书名、章节标题、正文和下一章", () => {
    const html = `
      <!doctype html>
      <html>
        <head><title>第1章 引子_《铁血残明》</title></head>
        <body>
          <a href="//www.qidian.com/book/1024424884/">返回作品页</a>
          <a href="//www.qidian.com/book/1024424884/" class="text-s-gray-900"> 铁血残明 </a>
          <article class="print">
            <h1 class="title">第1章 引子 <span class="review-count">12</span></h1>
            <main id="c-592692588">
              <span class="content-text">　　合成正文第一段。</span>
              <span class="content-text">　　合成正文第二段。</span>
            </main>
          </article>
          <a class="nav-btn" href="/chapter/1024424884/592692608/?from=chapter-nav">下一章</a>
        </body>
      </html>`;
    const documentNode = new DOMParser().parseFromString(html, "text/html");
    const result = extractor.extract(
      documentNode,
      "https://www.qidian.com/chapter/1024424884/592692588/?from=test#hash"
    );
    assert(result.ok, result.error);
    equal(result.bookTitle, "铁血残明", "书名提取错误");
    equal(result.title, "第1章 引子", "章节标题提取错误");
    equal(result.paragraphs.length, 2, "正文段落数量错误");
    equal(
      result.sourceUrl,
      "https://www.qidian.com/chapter/1024424884/592692588",
      "来源 URL 未规范化"
    );
    equal(
      result.nextUrl,
      "https://www.qidian.com/chapter/1024424884/592692608",
      "下一章 URL 错误"
    );
    equal(
      result.nextNavigationUrl,
      "https://www.qidian.com/chapter/1024424884/592692608/?from=chapter-nav",
      "下一章导航 URL 不应删除页面提供的查询参数"
    );
    equal(
      result.selectorDiagnostics.book,
      "a.text-s-gray-900[href*='/book/']",
      "没有优先使用指定书名元素"
    );
  });

  test("下一章会在导航按钮未命中时回退搜索普通链接", () => {
    const html = `
      <!doctype html>
      <html>
        <head><title>第1章_《铁血残明》</title></head>
        <body>
          <a class="text-s-gray-900" href="/book/1024424884/">铁血残明</a>
          <main id="c-592692588">
            <h1 class="title">第1章</h1>
            <span class="content-text">合成正文。</span>
          </main>
          <a class="nav-btn" href="/book/1024424884/">目录</a>
          <a href="/chapter/1024424884/592692608/?fallback=1">下一章</a>
        </body>
      </html>`;
    const documentNode = new DOMParser().parseFromString(html, "text/html");
    const result = extractor.extract(
      documentNode,
      "https://www.qidian.com/chapter/1024424884/592692588/"
    );
    assert(result.ok, result.error);
    equal(
      result.nextNavigationUrl,
      "https://www.qidian.com/chapter/1024424884/592692608/?fallback=1"
    );
    equal(result.selectorDiagnostics.next, "a[text*=下一章]");
  });

  test("页面等待器会在正文延迟挂载后重新提取", async () => {
    const pageUrl =
      "https://www.qidian.com/chapter/1024424884/592692588/";
    const documentNode = new DOMParser().parseFromString(
      `<!doctype html>
       <html>
         <head><title>第1章 引子_《铁血残明》</title></head>
         <body>
           <a class="text-s-gray-900" href="/book/1024424884/">铁血残明</a>
           <h1 class="title">第1章 引子</h1>
         </body>
       </html>`,
      "text/html"
    );
    const pending = pageReadinessApi.wait(documentNode, pageUrl, {
      stabilityMs: 40,
      timeoutMs: 1000,
    });
    setTimeout(() => {
      const main = documentNode.createElement("main");
      main.id = "c-592692588";
      const paragraph = documentNode.createElement("span");
      paragraph.className = "content-text";
      paragraph.textContent = "延迟挂载的正文。";
      main.append(paragraph);
      documentNode.body.append(main);
    }, 0);

    const result = await pending;
    assert(result.ok, result.error);
    equal(result.paragraphs.length, 1);
    equal(result.paragraphs[0], "延迟挂载的正文。");
  });

  test("页面等待器会等待渐进挂载的正文稳定", async () => {
    const pageUrl =
      "https://www.qidian.com/chapter/1024424884/592692588/";
    const documentNode = new DOMParser().parseFromString(
      `<!doctype html>
       <html>
         <head><title>第1章 引子_《铁血残明》</title></head>
         <body>
           <a class="text-s-gray-900" href="/book/1024424884/">铁血残明</a>
           <main id="c-592692588">
             <h1 class="title">第1章 引子</h1>
             <span class="content-text">先挂载的正文。</span>
           </main>
         </body>
       </html>`,
      "text/html"
    );
    let settled = false;
    const pending = pageReadinessApi
      .wait(documentNode, pageUrl, {
        stabilityMs: 40,
        timeoutMs: 1000,
      })
      .then((result) => {
        settled = true;
        return result;
      });

    await Promise.resolve();
    assert(!settled, "首段出现后不应立即判定正文就绪");
    const secondParagraph = documentNode.createElement("span");
    secondParagraph.className = "content-text";
    secondParagraph.textContent = "随后挂载的正文。";
    documentNode.querySelector("main").append(secondParagraph);

    const result = await pending;
    assert(result.ok, result.error);
    equal(result.paragraphs.length, 2);
    equal(result.paragraphs[1], "随后挂载的正文。");
  });

  test("页面等待器按需等待下一章链接延迟挂载", async () => {
    const pageUrl =
      "https://www.qidian.com/chapter/1024424884/592692588/";
    const documentNode = new DOMParser().parseFromString(
      `<!doctype html>
       <html>
         <head><title>第1章 引子_《铁血残明》</title></head>
         <body>
           <a class="text-s-gray-900" href="/book/1024424884/">铁血残明</a>
           <main id="c-592692588">
             <h1 class="title">第1章 引子</h1>
             <span class="content-text">已经出现的正文。</span>
           </main>
         </body>
       </html>`,
      "text/html"
    );
    const pending = pageReadinessApi.wait(documentNode, pageUrl, {
      requireNext: true,
      stabilityMs: 40,
      timeoutMs: 1000,
    });
    setTimeout(() => {
      const next = documentNode.createElement("a");
      next.className = "nav-btn";
      next.href = "/chapter/1024424884/592692608/?from=delayed";
      next.textContent = "下一章";
      documentNode.body.append(next);
    }, 0);

    const result = await pending;
    assert(result.ok, result.error);
    equal(
      result.nextNavigationUrl,
      "https://www.qidian.com/chapter/1024424884/592692608/?from=delayed"
    );
  });

  test("没有下一章链接时不会把当前页面当作下一章", () => {
    const html = `
      <!doctype html>
      <html>
        <head><title>第1章_《铁血残明》</title></head>
        <body>
          <a class="text-s-gray-900" href="/book/1024424884/">铁血残明</a>
          <main id="c-592692588">
            <h1 class="title">第1章</h1>
            <span class="content-text">合成正文。</span>
          </main>
        </body>
      </html>`;
    const documentNode = new DOMParser().parseFromString(html, "text/html");
    const result = extractor.extract(
      documentNode,
      "https://www.qidian.com/chapter/1024424884/592692588/"
    );
    assert(result.ok, result.error);
    equal(result.nextUrl, null);
    equal(result.nextNavigationUrl, null);
  });

  test("隐藏或零尺寸验证 iframe 不会误判正常章节", () => {
    const fixture = document.createElement("section");
    fixture.innerHTML = `
      <a class="text-s-gray-900" href="/book/1024424884/">铁血残明</a>
      <main id="c-592692588">
        <h1 class="title">第1章 引子</h1>
        <span class="content-text">正常显示的章节正文。</span>
      </main>
      <a class="nav-btn" href="/chapter/1024424884/592692608/">下一章</a>
      <div data-test="hidden-challenge-ancestor" style="display: none">
        <iframe src="about:blank?captcha=hidden"></iframe>
      </div>
      <iframe
        data-test="zero-sized-challenge"
        src="about:blank?verify=zero-sized"
        style="display: block; width: 0; height: 0; border: 0"
      ></iframe>
      <iframe
        data-test="covered-challenge"
        src="about:blank?verify=covered"
        style="position: fixed; top: 160px; left: 10px; width: 240px; height: 100px; border: 0; z-index: 1"
      ></iframe>
      <div
        data-test="challenge-cover"
        style="position: fixed; top: 160px; left: 10px; width: 240px; height: 100px; background: white; z-index: 2"
      >正常页面内容</div>`;
    document.body.append(fixture);

    try {
      const hiddenAncestor = fixture.querySelector(
        "[data-test='hidden-challenge-ancestor']"
      );
      const zeroSized = fixture.querySelector(
        "[data-test='zero-sized-challenge']"
      );
      equal(getComputedStyle(hiddenAncestor).display, "none");
      equal(zeroSized.getBoundingClientRect().width, 0);
      equal(zeroSized.getBoundingClientRect().height, 0);
      equal(
        document.elementFromPoint(130, 210)?.getAttribute("data-test"),
        "challenge-cover",
        "测试遮罩没有覆盖预加载验证 iframe"
      );

      const result = extractor.extract(
        document,
        "https://www.qidian.com/chapter/1024424884/592692588/"
      );
      assert(result.ok, result.error);
      equal(result.paragraphs[0], "正常显示的章节正文。");
      equal(
        result.nextUrl,
        "https://www.qidian.com/chapter/1024424884/592692608"
      );
    } finally {
      fixture.remove();
    }
  });

  test("可见验证组件仍返回 challenge-page", () => {
    const fixture = document.createElement("section");
    fixture.innerHTML = `
      <a class="text-s-gray-900" href="/book/1024424884/">铁血残明</a>
      <main id="c-592692588">
        <h1 class="title">第1章 引子</h1>
        <span class="content-text">不应在验证期间提取的正文。</span>
      </main>
      <iframe
        data-test="visible-challenge"
        src="about:blank?verify=visible"
        style="position: fixed; top: 10px; left: 10px; display: block; width: 320px; height: 120px; border: 1px solid"
      ></iframe>`;
    document.body.append(fixture);

    try {
      const visibleChallenge = fixture.querySelector(
        "[data-test='visible-challenge']"
      );
      const rectangle = visibleChallenge.getBoundingClientRect();
      assert(rectangle.width >= 2 && rectangle.height >= 2, "验证组件没有可见尺寸");

      const result = extractor.extract(
        document,
        "https://www.qidian.com/chapter/1024424884/592692588/"
      );
      equal(result.ok, false);
      equal(result.reason, "challenge-page");
      equal(result.challengeIndicator, "iframe[src*=\"verify\"]");
    } finally {
      fixture.remove();
    }
  });

  test("验证页面返回稳定错误码且不提取内容", () => {
    const documentNode = new DOMParser().parseFromString(
      "<!doctype html><title>安全验证</title><div class='geetest_panel'>验证</div>",
      "text/html"
    );
    const result = extractor.extract(
      documentNode,
      "https://www.qidian.com/chapter/1024424884/592692588/"
    );
    equal(result.ok, false);
    equal(result.reason, "challenge-page");
    assert(!Object.prototype.hasOwnProperty.call(result, "paragraphs"));
  });

  test("页面等待器识别验证页后立即返回", async () => {
    const documentNode = new DOMParser().parseFromString(
      "<!doctype html><title>安全验证</title><div class='geetest_panel'>验证</div>",
      "text/html"
    );
    let settled = false;
    const pending = pageReadinessApi
      .wait(
        documentNode,
        "https://www.qidian.com/chapter/1024424884/592692588/",
        { timeoutMs: 1000 }
      )
      .then((result) => {
        settled = true;
        return result;
      });
    await Promise.resolve();
    assert(settled, "验证页不应等待超时或 DOM 变化");
    const result = await pending;
    equal(result.ok, false);
    equal(result.reason, "challenge-page");
  });

  test("非章节页面被拒绝", () => {
    const documentNode = new DOMParser().parseFromString(
      "<!doctype html><title>书籍详情</title>",
      "text/html"
    );
    const result = extractor.extract(
      documentNode,
      "https://www.qidian.com/book/1024424884/"
    );
    equal(result.ok, false);
    equal(result.reason, "unsupported-page");
  });

  test("批次按书籍和章节 ID 去重", () => {
    const first = core.addChapter(null, sampleChapter("1"));
    equal(first.status, "added");
    const duplicate = core.addChapter(first.batch, sampleChapter("1"));
    equal(duplicate.status, "duplicate");
    equal(duplicate.batch.chapters.length, 1);
    const second = core.addChapter(first.batch, sampleChapter("2"));
    equal(second.status, "added");
    equal(second.batch.chapters.length, 2);
    const differentBook = core.addChapter(second.batch, sampleChapter("1", "999"));
    equal(differentBook.status, "different-book");
    equal(differentBook.batch.chapters.length, 2);
  });

  test("后续识别到真实书名时会升级批次 fallback 书名", () => {
    const firstChapter = sampleChapter("1");
    firstChapter.bookTitle = "book_1024424884";
    let result = core.addChapter(null, firstChapter);
    result = core.addChapter(result.batch, sampleChapter("2"));
    equal(result.status, "added");
    equal(result.batch.bookTitle, "铁血残明");
  });

  test("后台批次存储会串行处理并发采集与清空", async () => {
    const storage = createAsyncBatchStorage();
    const store = batchStoreApi.createBatchStore({
      storage,
      quotaBytes: 10 * 1024 * 1024,
      reserveBytes: 1024,
    });
    await Promise.all([
      store.addChapter(sampleChapter("1")),
      store.addChapter(sampleChapter("2")),
    ]);
    let batch = await store.getBatch();
    equal(batch.chapters.length, 2, "并发采集丢失章节");

    const clearing = store.clearBatch();
    const addingAfterClear = store.addChapter(sampleChapter("3"));
    await Promise.all([clearing, addingAfterClear]);
    batch = await store.getBatch();
    equal(batch.chapters.length, 1, "清空后的串行采集结果错误");
    equal(batch.chapters[0].chapterId, "3");
  });

  test("旧版批次可按书籍切换、去重和清空，重建存储实例后仍保留", async () => {
    const legacy = batchFrom([sampleChapter("1"), sampleChapter("2")]);
    const storage = createAsyncBatchStorage({ [core.BATCH_STORAGE_KEY]: legacy });
    const store = batchStoreApi.createBatchStore({ storage });
    equal(JSON.stringify(await store.getBatch()), JSON.stringify(legacy));
    equal(storage.writeCount, 0, "读取旧版数据不应触发写入");
    await store.addChapter(sampleChapter("1", "999"), undefined, { selectBook: true });
    equal((await store.getSnapshot()).batches.length, 2);
    equal((await store.getBatch()).bookId, "999");
    equal(JSON.stringify(await store.getBatch(legacy.bookId)), JSON.stringify(legacy));
    const duplicate = await store.addChapter(sampleChapter("1"), undefined, { selectBook: true });
    equal(duplicate.status, "duplicate");
    equal((await store.getBatch()).bookId, legacy.bookId);
    equal((await store.getBatch()).chapters.length, 2);
    const reopened = batchStoreApi.createBatchStore({ storage });
    equal((await reopened.getBatch()).bookId, legacy.bookId);
    await reopened.selectBatch("999");
    const exported = core.createChapterExports(await reopened.getBatch(), "json");
    equal(JSON.parse(exported[0].content).book.id, "999");
    const cleared = await reopened.clearBatch();
    equal(cleared.clearedCount, 1);
    equal(await reopened.getBatch(), null);
    equal((await reopened.getSnapshot()).batches.length, 1);
    await reopened.selectBatch(legacy.bookId);
    equal(JSON.stringify(await reopened.getBatch()), JSON.stringify(legacy));
  });

  test("多书共享存储配额，超限不会覆盖旧书或切换所选批次", async () => {
    const first = batchFrom([sampleChapter("1")]);
    const secondChapter = sampleChapter("1", "999");
    secondChapter.paragraphs = ["第二本书的正文".repeat(100)];
    const second = batchFrom([secondChapter]);
    const limit = core.estimateUtf8Bytes(core.BATCH_STORAGE_KEY) +
      core.estimateUtf8Bytes({ schemaVersion: 2, activeBookId: "999", batches: [first, second] }) - 1;
    const storage = createAsyncBatchStorage({ [core.BATCH_STORAGE_KEY]: first });
    const store = batchStoreApi.createBatchStore({ storage, quotaBytes: limit, reserveBytes: 0 });
    await rejectsCode(
      () => store.addChapter(secondChapter, "2026-01-01T00:00:00.000Z", { selectBook: true }),
      "BATCH_SIZE_LIMIT_REACHED"
    );
    equal(storage.writeCount, 0);
    equal(JSON.stringify(await store.getBatch()), JSON.stringify(first));
    equal((await store.getSnapshot()).batches.length, 1);
  });

  test("切换书籍写入失败时旧版批次仍可读取", async () => {
    const legacy = batchFrom([sampleChapter("1")]);
    const storage = createAsyncBatchStorage({ [core.BATCH_STORAGE_KEY]: legacy });
    storage.set = async () => { throw new Error("合成写入失败"); };
    const store = batchStoreApi.createBatchStore({ storage });
    await rejectsCode(() => store.selectBatch("999"), "STORAGE_WRITE_FAILED");
    equal(JSON.stringify(await store.getBatch()), JSON.stringify(legacy));
  });

  test("自动换书使用对应目标与导出，下载期间禁止切换", async () => {
    const otherChapter = { ...sampleChapter("1", "999"), ok: true, adapterId: "qidian" };
    const harness = createAutomationHarness({
      batch: batchFrom([sampleChapter("1"), sampleChapter("2")]),
      tab: { id: 7, status: "complete", url: otherChapter.sourceUrl },
      extractions: [otherChapter],
      downloadIds: [301, 302],
    });
    const exporting = await harness.controller.start({ tabId: 7, targetCount: 1, format: "json" });
    equal(exporting.capturedCount, 1, "旧书章数不应计入新书任务");
    equal(harness.downloads.length, 1);
    equal(JSON.parse(harness.downloads[0].exported.content).book.id, "999");
    equal((await harness.batchStore.getBatch("1024424884")).chapters.length, 2);
    await rejectsCode(() => harness.controller.selectBatch("1024424884"), "AUTOMATION_BATCH_LOCKED");
    await harness.controller.handleDownloadSettled(301, true);
    await harness.controller.selectBatch("1024424884");
    equal(await harness.controller.getState(), null, "切换后不应显示上一书籍的自动任务状态");
    await harness.controller.start({ tabId: 7, targetCount: 1, format: "json" });
    equal(harness.extractionCalls, 1, "当前页面书籍达到目标时应导出其已有批次");
    equal(JSON.parse(harness.downloads[1].exported.content).book.id, "999");
    await harness.controller.handleDownloadSettled(302, true);
    await harness.controller.clearBatch();
    equal((await harness.batchStore.getSnapshot()).batches.length, 1);
    equal((await harness.batchStore.getBatch("1024424884")).chapters.length, 2);
  });

  test("新书首次提取遇到验证时保留旧书并锁定书籍选择", async () => {
    const otherChapter = { ...sampleChapter("1", "999"), ok: true, adapterId: "qidian" };
    const harness = createAutomationHarness({
      batch: batchFrom([sampleChapter("1")]),
      tab: { id: 7, status: "complete", url: otherChapter.sourceUrl },
      extractions: [{ ok: false, reason: "challenge-page" }, otherChapter],
    });
    const paused = await harness.controller.start({ tabId: 7, targetCount: 1, format: "txt" });
    equal(paused.status, automationStateApi.STATUS.PAUSED);
    equal(paused.capturedCount, 0);
    equal(harness.downloads.length, 0, "验证期间不应导出旧书");
    await rejectsCode(() => harness.controller.selectBatch("1024424884"), "AUTOMATION_BATCH_LOCKED");
    const resumed = await harness.controller.resume({ tabId: 7 });
    equal(resumed.capturedCount, 1);
    equal((await harness.batchStore.getSnapshot()).batches.length, 2);
    equal((await harness.batchStore.getBatch()).bookId, "999");
  });

  test("自动采集首章仍拒绝与启动页面不同的书籍", async () => {
    const harness = createAutomationHarness({
      batch: batchFrom([sampleChapter("1")]),
      tab: { id: 7, status: "complete", url: "https://www.qidian.com/chapter/999/1/" },
      extractions: [automaticChapter("2")],
    });
    const failed = await harness.controller.start({ tabId: 7, targetCount: 1, format: "txt" });
    equal(failed.status, automationStateApi.STATUS.FAILED);
    equal(failed.lastError.code, "AUTOMATION_DIFFERENT_BOOK");
    equal(harness.downloads.length, 0);
    equal((await harness.batchStore.getBatch("1024424884")).chapters.length, 1);
    equal(await harness.batchStore.getBatch("999"), null);
  });

  test("批次会在写入前按实际 storage quota 拒绝超限章节", async () => {
    const storage = createAsyncBatchStorage();
    const store = batchStoreApi.createBatchStore({
      storage,
      quotaBytes: 3 * 1024,
      reserveBytes: 512,
    });
    await store.addChapter(sampleChapter("1"));
    const writesBeforeFailure = storage.writeCount;
    const oversized = sampleChapter("2");
    oversized.paragraphs = ["容量测试".repeat(1000)];
    let caught = null;
    try {
      await store.addChapter(oversized);
    } catch (error) {
      caught = error;
    }
    assert(caught, "超限章节没有被拒绝");
    equal(caught.code, "BATCH_SIZE_LIMIT_REACHED");
    equal(storage.writeCount, writesBeforeFailure, "容量检查发生在写入之后");
    const batch = await store.getBatch();
    equal(batch.chapters.length, 1, "超限失败破坏了原批次");
  });

  test("导出目录使用实际章数且每章生成独立文件", () => {
    let result = core.addChapter(null, sampleChapter("1"));
    result = core.addChapter(result.batch, sampleChapter("2"));
    const txt = core.createChapterExports(result.batch, "txt");
    const json = core.createChapterExports(
      result.batch,
      "json",
      "2026-01-01T00:00:00.000Z"
    );
    equal(txt.length, 2);
    equal(json.length, 2);
    equal(
      txt[0].relativePath,
      "QidianCrawler/铁血残明-2章/第1章.txt"
    );
    equal(
      json[1].relativePath,
      "QidianCrawler/铁血残明-2章/第2章.json"
    );
    equal(JSON.parse(json[1].content).chapterCount, 1);
    equal(JSON.parse(json[1].content).chapters[0].sequence, 2);
    assert(txt[0].content.includes("第1章"));
    assert(!txt[0].content.includes("第2章"));
    assert(txt[1].content.includes("第2章"));
    assert(!txt[1].content.includes("第1章"));
  });

  test("重名章节文件会稳定追加序号且不互相覆盖", () => {
    const first = sampleChapter("1");
    const second = sampleChapter("2");
    const third = sampleChapter("3");
    first.title = "同名章节";
    second.title = "同名章节";
    third.title = "同名章节-2";
    const batch = batchFrom([first, second, third]);
    const exported = core.createChapterExports(batch, "txt");
    equal(exported[0].filename, "同名章节.txt");
    equal(exported[1].filename, "同名章节-2.txt");
    equal(exported[2].filename, "同名章节-2-2.txt");
  });

  test("文件名过滤 Windows 非法字符和保留名称", () => {
    equal(core.safePathSegment('A:B?C*D|E<F>G"'), "A_B_C_D_E_F_G_");
    equal(core.safePathSegment("CON"), "_CON");
    equal(core.safePathSegment("标题...   "), "标题");
    equal(core.safePathSegment("", "fallback"), "fallback");
    equal(core.safePathSegment("😀😀😀", "fallback", 2), "😀😀");
  });

  test("超长书名的导出路径保持在安全长度预算内", () => {
    const chapter = sampleChapter("1");
    chapter.bookTitle = "很长的书名".repeat(40);
    chapter.title = "很长的章节标题".repeat(40);
    const result = core.addChapter(null, chapter);
    const exported = core.createChapterExports(result.batch, "txt")[0];
    assert(
      exported.folderName.length <= core.MAX_EXPORT_BASENAME_LENGTH,
      "目录名超过安全长度"
    );
    assert(
      exported.filename.replace(/\.txt$/, "").length <=
        core.MAX_EXPORT_BASENAME_LENGTH,
      "文件名超过安全长度"
    );
    assert(exported.relativePath.length < 190, "相对下载路径仍然过长");
  });

  test("日志只接受事件白名单字段并脱敏", () => {
    const details = logStoreApi.sanitizeDetails("CHAPTER_ADDED", {
      chapterCount: 2,
      paragraphCount: 20,
      adapterId: "qidian",
      bookTitle: "不得进入日志",
      paragraphs: ["不得进入日志"],
    });
    equal(details.chapterCount, 2);
    assert(!Object.prototype.hasOwnProperty.call(details, "bookTitle"));
    assert(!Object.prototype.hasOwnProperty.call(details, "paragraphs"));
    const sanitized = logStoreApi.sanitizeValue({
      cookie: "secret",
      token: "secret",
      reason: "failed at https://example.com/path?token=secret",
    });
    equal(sanitized.cookie, "[REDACTED]");
    equal(sanitized.token, "[REDACTED]");
    assert(!sanitized.reason.includes("example.com"));
  });

  test("诊断报告脱敏 URL、Windows 路径、UNC 路径和敏感字段", () => {
    const sanitized = logStoreApi.sanitizeReportValue({
      reason:
        "file:///C:/Users/Alice/private.txt chrome://extensions blob:https://example.com/id https://example.com/a?q=1 C:\\Users\\Alice\\secret.txt \\\\server\\private\\book.txt",
      bookTitle: "不得进入报告",
      nested: { sourceUrl: "//www.qidian.com/chapter/1/2", pageContentIncluded: false },
    });
    const serialized = JSON.stringify(sanitized);
    assert(!serialized.includes("Alice"));
    assert(!serialized.includes("example.com"));
    assert(!serialized.includes("qidian.com"));
    assert(!serialized.includes("不得进入报告"));
    equal(sanitized.nested.pageContentIncluded, false);
  });

  test("日志轮转、DEBUG 开关和并发顺序正常", async () => {
    const adapter = logStoreApi.createMemoryStorageAdapter();
    let currentTime = Date.parse("2026-01-01T00:00:00.000Z");
    let nextId = 1;
    const store = logStoreApi.createLogStore({
      storage: adapter,
      extensionVersion: "test",
      maxEntries: 5,
      now: () => new Date(currentTime++),
      idFactory: () => `id-${nextId++}`,
    });
    const skipped = await store.append("POPUP_OPENED", "popup", "debug", {});
    equal(skipped.persisted, false);
    await store.setDebugEnabled(true);
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        store.append("CHAPTER_ADDED", "popup", `op-${index}`, {
          chapterCount: index + 1,
          paragraphCount: 2,
          adapterId: "qidian",
        })
      )
    );
    const entries = await store.read();
    equal(entries.length, 5);
    const sequences = entries.map((entry) => entry.sequence);
    equal(new Set(sequences).size, sequences.length, "日志序号重复");
    assert(sequences.every((value, index) => index === 0 || value > sequences[index - 1]));
  });

  test("eventKey 幂等去重且标识符会被安全化", async () => {
    const adapter = logStoreApi.createMemoryStorageAdapter();
    const store = logStoreApi.createLogStore({
      storage: adapter,
      extensionVersion: "test",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      idFactory: () => "id-1",
    });
    const first = await store.append(
      "DOWNLOAD_COMPLETED",
      "background",
      "https://example.com/private",
      { format: "txt", chapterCount: 2, downloadId: 7, durationMs: 10 },
      "download:7:completed"
    );
    const duplicate = await store.append(
      "DOWNLOAD_COMPLETED",
      "background",
      "ignored",
      { format: "txt", chapterCount: 2, downloadId: 7, durationMs: 20 },
      "download:7:completed"
    );
    const entries = await store.read();
    equal(first.persisted, true);
    equal(duplicate.persisted, true);
    equal(duplicate.duplicate, true);
    equal(entries.length, 1);
    equal(entries[0].eventKey, "download_7_completed");
    assert(!entries[0].operationId.includes("example.com"));
  });

  test("非配额写入失败重试时不会误删旧日志", async () => {
    const adapter = createFaultyLogStorage();
    const store = logStoreApi.createLogStore({ storage: adapter, extensionVersion: "test" });
    for (let index = 0; index < 8; index += 1) {
      await store.append("CHAPTER_ADDED", "popup", `op-${index}`, {
        chapterCount: index + 1,
        paragraphCount: 2,
        adapterId: "qidian",
      });
    }
    adapter.failNextWrite("temporary storage failure");
    await store.append("BATCH_CLEARED", "popup", "clear", { chapterCount: 8 });
    const entries = await store.read();
    equal(entries.length, 9);
    assert(!entries.some((entry) => entry.code === "LOG_STORE_EMERGENCY_PRUNED"));
  });

  test("配额错误触发紧急轮转并留下结构化事件", async () => {
    const adapter = createFaultyLogStorage();
    const store = logStoreApi.createLogStore({ storage: adapter, extensionVersion: "test" });
    for (let index = 0; index < 8; index += 1) {
      await store.append("CHAPTER_ADDED", "popup", `op-${index}`, {
        chapterCount: index + 1,
        paragraphCount: 2,
        adapterId: "qidian",
      });
    }
    adapter.failNextWrite("QUOTA_BYTES quota exceeded");
    await store.append("BATCH_CLEARED", "popup", "clear", { chapterCount: 8 });
    const entries = await store.read();
    assert(entries.some((entry) => entry.code === "LOG_STORE_EMERGENCY_PRUNED"));
    assert(entries.length < 9);
  });

  test("损坏的日志存储会自愈并留下事件", async () => {
    const adapter = logStoreApi.createMemoryStorageAdapter({
      [logStoreApi.LOG_STORAGE_KEY]: "broken",
    });
    const store = logStoreApi.createLogStore({
      storage: adapter,
      extensionVersion: "test",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      idFactory: () => "recovered-id",
    });
    const entries = await store.read();
    equal(entries.length, 1);
    equal(entries[0].code, "LOG_STORE_RECOVERED");
  });

  test("读取旧日志时会再次执行字段白名单和脱敏", async () => {
    const adapter = logStoreApi.createMemoryStorageAdapter({
      [logStoreApi.LOG_STORAGE_KEY]: {
        version: 1,
        nextSequence: 2,
        entries: [
          {
            schemaVersion: 1,
            sequence: 1,
            id: "old",
            time: "2026-01-01T00:00:00.000Z",
            level: "INFO",
            code: "CHAPTER_ADDED",
            message: "被篡改的消息",
            component: "popup",
            operationId: "file:///C:/Users/Alice/private",
            eventKey: "download:7:completed",
            extensionVersion: "old",
            details: {
              chapterCount: 1,
              paragraphCount: 2,
              adapterId: "qidian",
              bookTitle: "不得进入报告",
              paragraphs: ["不得进入报告"],
            },
          },
        ],
      },
    });
    const store = logStoreApi.createLogStore({
      storage: adapter,
      extensionVersion: "test",
      now: () => new Date("2026-01-02T00:00:00.000Z"),
      idFactory: () => "unused",
    });
    const entries = await store.read();
    equal(entries.length, 1);
    equal(entries[0].message, "章节已加入当前批次");
    equal(entries[0].eventKey, "download_7_completed");
    assert(!entries[0].operationId.includes("Alice"));
    assert(!Object.prototype.hasOwnProperty.call(entries[0].details, "bookTitle"));
    assert(!Object.prototype.hasOwnProperty.call(entries[0].details, "paragraphs"));
  });

  test("结构异常的旧日志会尽量重建而不是全部丢弃", async () => {
    const adapter = logStoreApi.createMemoryStorageAdapter({
      [logStoreApi.LOG_STORAGE_KEY]: {
        version: 1,
        nextSequence: 1,
        entries: [
          {
            sequence: 99,
            time: "2026-01-01T00:00:00.000Z",
            code: "CHAPTER_ADDED",
            operationId: "capture-old",
            details: {
              chapterCount: 1,
              paragraphCount: 2,
              adapterId: "qidian",
              content: "不得保留",
            },
          },
        ],
      },
    });
    const store = logStoreApi.createLogStore({
      storage: adapter,
      extensionVersion: "test",
      now: () => new Date("2026-01-02T00:00:00.000Z"),
      idFactory: () => "recovery",
    });
    const entries = await store.read();
    equal(entries[0].code, "CHAPTER_ADDED");
    equal(entries[1].code, "LOG_STORE_RECOVERED");
    equal(entries[0].sequence, 1);
    assert(!Object.prototype.hasOwnProperty.call(entries[0].details, "content"));
  });

  test("下载完成会先持久化终态再清理待处理记录", async () => {
    const storage = createAsyncBatchStorage();
    const events = [];
    const tracker = downloadTrackerApi.createDownloadTracker({
      storage,
      search: async () => ({ state: "complete" }),
      record: async (code, operationId, details, eventKey) => {
        events.push({ code, operationId, details, eventKey });
        return { persisted: true, duplicate: false };
      },
      now: () => 1_000,
    });
    await tracker.track(17, {
      format: "txt",
      chapterCount: 3,
      operationId: "export-17",
      downloadToken: "export-17.file-2",
      fileIndex: 2,
      fileCount: 3,
    });
    equal(events.length, 2);
    equal(events[0].code, "DOWNLOAD_ACCEPTED");
    equal(events[1].code, "DOWNLOAD_COMPLETED");
    equal(events[1].eventKey, "download:17:completed");
    equal(events[0].details.fileIndex, 2);
    equal(events[1].details.fileCount, 3);
    equal(Object.keys(await tracker.readPending()).length, 0);
  });

  test("后台中断后会从已保存终态幂等补记下载日志", async () => {
    const storage = createAsyncBatchStorage();
    const persistedEventKeys = new Set();
    let failTerminalOnce = true;
    const attempts = [];
    const tracker = downloadTrackerApi.createDownloadTracker({
      storage,
      search: async () => ({ state: "in_progress" }),
      record: async (code, _operationId, _details, eventKey) => {
        attempts.push({ code, eventKey });
        if (code === "DOWNLOAD_COMPLETED" && failTerminalOnce) {
          failTerminalOnce = false;
          throw new Error("synthetic-worker-stop");
        }
        const duplicate = persistedEventKeys.has(eventKey);
        persistedEventKeys.add(eventKey);
        return { persisted: true, duplicate };
      },
      now: () => 2_000,
    });
    await tracker.track(18, {
      format: "json",
      chapterCount: 4,
      operationId: "export-18",
    });
    let failed = false;
    try {
      await tracker.settle(18, true, null);
    } catch {
      failed = true;
    }
    assert(failed, "合成的首次终态日志写入应失败");
    const pendingAfterFailure = await tracker.readPending();
    assert(pendingAfterFailure["18"]?.terminal?.completed);

    await tracker.reconcile();
    equal(Object.keys(await tracker.readPending()).length, 0);
    equal(
      attempts.filter((item) => item.code === "DOWNLOAD_COMPLETED").length,
      2
    );
    assert(persistedEventKeys.has("download:18:completed"));
  });

  async function run() {
    const resultsNode = document.querySelector("#results");
    let failed = 0;
    for (const item of tests) {
      const node = document.createElement("li");
      try {
        await item.callback();
        node.className = "pass";
        node.textContent = `通过：${item.name}`;
      } catch (error) {
        failed += 1;
        node.className = "fail";
        node.textContent = `失败：${item.name} — ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
      resultsNode.append(node);
    }
    const summary = document.querySelector("#summary");
    summary.textContent = `${tests.length - failed} 通过，${failed} 失败`;
    document.body.dataset.status = failed === 0 ? "passed" : "failed";
    document.title = failed === 0 ? "PASS - QidianCrawler" : "FAIL - QidianCrawler";
  }

  window.addEventListener("error", (event) => {
    document.body.dataset.status = "failed";
    document.querySelector("#summary").textContent = `运行时错误：${event.message}`;
  });
  window.addEventListener("unhandledrejection", (event) => {
    document.body.dataset.status = "failed";
    document.querySelector("#summary").textContent = `未处理异常：${String(event.reason)}`;
  });

  void run();
})();
