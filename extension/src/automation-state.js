(function defineQidianCrawlerAutomationState(root) {
  "use strict";


  const AUTOMATION_STORAGE_KEY = "qidianCrawler.automation.v1";
  const AUTOMATION_KIND = "qidian-extension-automation";
  const AUTOMATION_SCHEMA_VERSION = 1;
  const MIN_TARGET_COUNT = 1;
  const MAX_TARGET_COUNT = 500;
  const MAX_VISITED_CHAPTER_KEYS = 500;
  const MAX_OPERATION_ID_LENGTH = 120;
  const MAX_ERROR_MESSAGE_LENGTH = 240;

  const STATUS = Object.freeze({
    RUNNING: "running",
    PAUSED: "paused",
    STOPPED: "stopped",
    COMPLETED: "completed",
    FAILED: "failed",
  });

  const PHASE = Object.freeze({
    CAPTURING: "capturing",
    WAITING_NAVIGATION: "waiting-navigation",
    CHALLENGE: "challenge",
    EXPORTING: "exporting",
    STOPPED: "stopped",
    COMPLETED: "completed",
    FAILED: "failed",
  });

  const ERROR_CODES = Object.freeze({
    INVALID_STATE: "AUTOMATION_STATE_INVALID",
    INVALID_TAB_ID: "AUTOMATION_TAB_ID_INVALID",
    INVALID_TARGET_COUNT: "AUTOMATION_TARGET_COUNT_INVALID",
    INVALID_FORMAT: "AUTOMATION_FORMAT_INVALID",
    BATCH_TARGET_TOO_SMALL: "AUTOMATION_BATCH_TARGET_TOO_SMALL",
    BATCH_KEYS_INVALID: "AUTOMATION_BATCH_KEYS_INVALID",
    INVALID_OPERATION_ID: "AUTOMATION_OPERATION_ID_INVALID",
    INVALID_CHAPTER_KEY: "AUTOMATION_CHAPTER_KEY_INVALID",
    DUPLICATE_CHAPTER: "AUTOMATION_CHAPTER_DUPLICATE",
    INVALID_NEXT_URL: "AUTOMATION_NEXT_URL_INVALID",
    INVALID_TRANSITION: "AUTOMATION_TRANSITION_INVALID",
    TARGET_REACHED: "AUTOMATION_TARGET_REACHED",
    TARGET_NOT_REACHED: "AUTOMATION_TARGET_NOT_REACHED",
    STORAGE_UNAVAILABLE: "AUTOMATION_STORAGE_UNAVAILABLE",
    STORAGE_FAILED: "AUTOMATION_STORAGE_FAILED",
    FAILED: "AUTOMATION_FAILED",
  });

  const STATUS_VALUES = new Set(Object.values(STATUS));
  const PHASE_VALUES = new Set(Object.values(PHASE));
  const TERMINAL_STATUSES = new Set([
    STATUS.STOPPED,
    STATUS.COMPLETED,
    STATUS.FAILED,
  ]);
  const STATUS_PHASES = Object.freeze({
    [STATUS.RUNNING]: new Set([
      PHASE.CAPTURING,
      PHASE.WAITING_NAVIGATION,
      PHASE.EXPORTING,
    ]),
    [STATUS.PAUSED]: new Set([PHASE.CHALLENGE]),
    [STATUS.STOPPED]: new Set([PHASE.STOPPED]),
    [STATUS.COMPLETED]: new Set([PHASE.COMPLETED]),
    [STATUS.FAILED]: new Set([PHASE.FAILED]),
  });

  function automationError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function compact(value) {
    return String(value ?? "")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function boundedText(value, maximumLength) {
    return Array.from(compact(value)).slice(0, maximumLength).join("");
  }

  function integer(value) {
    if (typeof value === "string" && !/^[0-9]+$/.test(value.trim())) {
      return null;
    }
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }

  function normalizeTimestamp(value, required = false) {
    if (value === null || value === undefined || value === "") {
      return required ? "" : null;
    }
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }

  function currentTimestamp(now) {
    const timestamp = normalizeTimestamp(
      now === undefined ? new Date() : now,
      true
    );
    if (!timestamp) {
      throw automationError(
        ERROR_CODES.INVALID_STATE,
        "自动模式时间参数无效。"
      );
    }
    return timestamp;
  }

  function normalizeFormat(value) {
    const format = compact(value).toLowerCase();
    return format === "txt" || format === "json" ? format : "";
  }

  function normalizeOperationId(value) {
    const text = boundedText(value, MAX_OPERATION_ID_LENGTH);
    if (!text || !/^[A-Za-z0-9._-]+$/.test(text)) {
      return "";
    }
    return text;
  }

  function createOperationId(now) {
    const milliseconds = new Date(currentTimestamp(now)).getTime();
    let randomPart = "";
    try {
      randomPart = root.crypto?.randomUUID?.().replace(/-/g, "") || "";
    } catch {
      randomPart = "";
    }
    if (!randomPart) {
      randomPart = `${Math.random().toString(36).slice(2)}${Math.random()
        .toString(36)
        .slice(2)}`;
    }
    return `auto-${milliseconds.toString(36)}-${randomPart.slice(0, 32)}`;
  }

  function normalizeChapterKey(value) {
    const key = boundedText(value, 160);
    return key && /^[A-Za-z0-9._:-]+$/.test(key) ? key : "";
  }

  function normalizeVisitedChapterKeys(value) {
    if (!Array.isArray(value)) {
      return [];
    }
    const seen = new Set();
    const result = [];
    for (const item of value) {
      const key = normalizeChapterKey(item);
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push(key);
      if (result.length >= MAX_VISITED_CHAPTER_KEYS) {
        break;
      }
    }
    return result;
  }

  function normalizeDownloadIds(value, legacyValue) {
    const source = Array.isArray(value)
      ? value
      : legacyValue === null || legacyValue === undefined
        ? []
        : [legacyValue];
    const seen = new Set();
    const result = [];
    for (const item of source) {
      const downloadId = integer(item);
      if (downloadId === null || downloadId < 0 || seen.has(downloadId)) {
        continue;
      }
      seen.add(downloadId);
      result.push(downloadId);
    }
    return result;
  }

  function normalizeNextNavigationUrl(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }
    try {
      const url = new URL(String(value));
      const hostname = url.hostname.toLowerCase();
      const isQidian =
        hostname === "qidian.com" || hostname.endsWith(".qidian.com");
      if (
        url.protocol !== "https:" ||
        !isQidian ||
        !/^\/chapter\/\d+\/\d+\/?$/.test(url.pathname)
      ) {
        return null;
      }
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.href;
    } catch {
      return null;
    }
  }

  function normalizeLastError(value) {
    if (!value) {
      return null;
    }
    const code = boundedText(value.code, 80).replace(/[^A-Z0-9_-]/g, "_");
    const message = boundedText(value.message, MAX_ERROR_MESSAGE_LENGTH);
    const at = normalizeTimestamp(value.at, true);
    if (!code || !message || !at) {
      return null;
    }
    return { code, message, at };
  }

  function createLastError(error, fallbackCode, now) {
    const code = boundedText(error?.code || fallbackCode, 80)
      .toUpperCase()
      .replace(/[^A-Z0-9_-]/g, "_");
    const message = boundedText(
      error?.message || error || "自动模式执行失败。",
      MAX_ERROR_MESSAGE_LENGTH
    );
    return {
      code: code || fallbackCode,
      message: message || "自动模式执行失败。",
      at: currentTimestamp(now),
    };
  }

  function normalize(state) {
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      throw automationError(
        ERROR_CODES.INVALID_STATE,
        "自动模式状态不存在或结构无效。"
      );
    }
    const sourceTimestamps =
      state.timestamps && typeof state.timestamps === "object"
        ? state.timestamps
        : {};
    const normalized = {
      schemaVersion: integer(state.schemaVersion),
      kind: compact(state.kind),
      tabId: integer(state.tabId),
      targetCount: integer(state.targetCount),
      format: normalizeFormat(state.format),
      status: compact(state.status),
      phase: compact(state.phase),
      capturedCount: integer(state.capturedCount),
      operationId: normalizeOperationId(state.operationId),
      downloadIds: normalizeDownloadIds(state.downloadIds, state.downloadId),
      nextNavigationUrl: normalizeNextNavigationUrl(
        state.nextNavigationUrl
      ),
      visitedChapterKeys: normalizeVisitedChapterKeys(
        state.visitedChapterKeys
      ),
      timestamps: {
        startedAt: normalizeTimestamp(sourceTimestamps.startedAt, true),
        updatedAt: normalizeTimestamp(sourceTimestamps.updatedAt, true),
        lastProgressAt: normalizeTimestamp(sourceTimestamps.lastProgressAt),
        pausedAt: normalizeTimestamp(sourceTimestamps.pausedAt),
        finishedAt: normalizeTimestamp(sourceTimestamps.finishedAt),
      },
      lastError: normalizeLastError(state.lastError),
    };
    return normalized;
  }

  function validationFailure(code, error) {
    return { ok: false, code, error, state: null };
  }

  function validate(state) {
    let normalized;
    try {
      normalized = normalize(state);
    } catch (error) {
      return validationFailure(
        error?.code || ERROR_CODES.INVALID_STATE,
        error?.message || "自动模式状态无效。"
      );
    }

    if (
      normalized.schemaVersion !== AUTOMATION_SCHEMA_VERSION ||
      normalized.kind !== AUTOMATION_KIND
    ) {
      return validationFailure(
        ERROR_CODES.INVALID_STATE,
        "自动模式状态版本或类型无效。"
      );
    }
    if (normalized.tabId === null || normalized.tabId < 0) {
      return validationFailure(
        ERROR_CODES.INVALID_TAB_ID,
        "自动模式标签页编号无效。"
      );
    }
    if (
      normalized.targetCount === null ||
      normalized.targetCount < MIN_TARGET_COUNT ||
      normalized.targetCount > MAX_TARGET_COUNT
    ) {
      return validationFailure(
        ERROR_CODES.INVALID_TARGET_COUNT,
        `爬取章数必须是 ${MIN_TARGET_COUNT} 到 ${MAX_TARGET_COUNT} 的整数。`
      );
    }
    if (!normalized.format) {
      return validationFailure(
        ERROR_CODES.INVALID_FORMAT,
        "自动模式导出格式必须是 TXT 或 JSON。"
      );
    }
    if (!STATUS_VALUES.has(normalized.status)) {
      return validationFailure(
        ERROR_CODES.INVALID_STATE,
        "自动模式运行状态无效。"
      );
    }
    if (
      !PHASE_VALUES.has(normalized.phase) ||
      !STATUS_PHASES[normalized.status]?.has(normalized.phase)
    ) {
      return validationFailure(
        ERROR_CODES.INVALID_STATE,
        "自动模式运行阶段与状态不一致。"
      );
    }
    if (!normalized.operationId) {
      return validationFailure(
        ERROR_CODES.INVALID_OPERATION_ID,
        "自动模式任务编号无效。"
      );
    }
    if (normalized.downloadIds.length > normalized.targetCount) {
      return validationFailure(
        ERROR_CODES.INVALID_STATE,
        "自动模式下载文件数超过目标章数。"
      );
    }
    if (
      normalized.capturedCount === null ||
      normalized.capturedCount < 0 ||
      normalized.capturedCount > normalized.targetCount ||
      normalized.capturedCount !== normalized.visitedChapterKeys.length
    ) {
      return validationFailure(
        ERROR_CODES.INVALID_STATE,
        "自动模式已采集章数或章节记录无效。"
      );
    }
    if (
      !normalized.timestamps.startedAt ||
      !normalized.timestamps.updatedAt
    ) {
      return validationFailure(
        ERROR_CODES.INVALID_STATE,
        "自动模式时间记录无效。"
      );
    }
    if (
      normalized.phase === PHASE.WAITING_NAVIGATION &&
      !normalized.nextNavigationUrl
    ) {
      return validationFailure(
        ERROR_CODES.INVALID_NEXT_URL,
        "等待翻页时缺少有效的下一章地址。"
      );
    }
    if (
      normalized.phase === PHASE.CHALLENGE &&
      !normalized.timestamps.pausedAt
    ) {
      return validationFailure(
        ERROR_CODES.INVALID_STATE,
        "等待人工验证时缺少暂停时间。"
      );
    }
    if (
      normalized.phase === PHASE.EXPORTING &&
      normalized.capturedCount !== normalized.targetCount
    ) {
      return validationFailure(
        ERROR_CODES.TARGET_NOT_REACHED,
        "采集章数尚未达到目标，不能开始导出。"
      );
    }
    if (
      TERMINAL_STATUSES.has(normalized.status) !==
      Boolean(normalized.timestamps.finishedAt)
    ) {
      return validationFailure(
        ERROR_CODES.INVALID_STATE,
        "自动模式结束状态与结束时间不一致。"
      );
    }
    if (
      TERMINAL_STATUSES.has(normalized.status) &&
      normalized.nextNavigationUrl
    ) {
      return validationFailure(
        ERROR_CODES.INVALID_STATE,
        "已经结束的自动模式仍包含翻页地址。"
      );
    }
    if (
      normalized.status === STATUS.COMPLETED &&
      (normalized.capturedCount !== normalized.targetCount ||
        normalized.downloadIds.length !== normalized.targetCount)
    ) {
      return validationFailure(
        ERROR_CODES.TARGET_NOT_REACHED,
        "采集章数或下载接收状态不足，不能标记为完成。"
      );
    }
    if (
      normalized.downloadIds.length > 0 &&
      ![
        PHASE.EXPORTING,
        PHASE.COMPLETED,
        PHASE.STOPPED,
        PHASE.FAILED,
      ].includes(normalized.phase)
    ) {
      return validationFailure(
        ERROR_CODES.INVALID_STATE,
        "当前自动模式阶段不应包含下载编号。"
      );
    }
    if (
      normalized.status === STATUS.FAILED &&
      !normalized.lastError
    ) {
      return validationFailure(
        ERROR_CODES.INVALID_STATE,
        "失败状态缺少错误记录。"
      );
    }
    return { ok: true, code: null, error: null, state: normalized };
  }

  function assertValid(state) {
    const result = validate(state);
    if (!result.ok) {
      throw automationError(result.code, result.error);
    }
    return result.state;
  }

  function assertActive(state, allowedPhases) {
    const normalized = assertValid(state);
    if (
      ![STATUS.RUNNING, STATUS.PAUSED].includes(normalized.status) ||
      (allowedPhases && !allowedPhases.includes(normalized.phase))
    ) {
      throw automationError(
        ERROR_CODES.INVALID_TRANSITION,
        "当前自动模式状态不允许执行此操作。"
      );
    }
    return normalized;
  }

  function start(options, now) {
    const tabId = integer(options?.tabId);
    if (tabId === null || tabId < 0) {
      throw automationError(
        ERROR_CODES.INVALID_TAB_ID,
        "请选择有效的起点标签页。"
      );
    }
    const targetCount = integer(options?.targetCount);
    if (
      targetCount === null ||
      targetCount < MIN_TARGET_COUNT ||
      targetCount > MAX_TARGET_COUNT
    ) {
      throw automationError(
        ERROR_CODES.INVALID_TARGET_COUNT,
        `爬取章数必须是 ${MIN_TARGET_COUNT} 到 ${MAX_TARGET_COUNT} 的整数。`
      );
    }
    const format = normalizeFormat(options?.format);
    if (!format) {
      throw automationError(
        ERROR_CODES.INVALID_FORMAT,
        "自动模式导出格式必须是 TXT 或 JSON。"
      );
    }
    const batchChapterCount = integer(options?.batchChapterCount ?? 0);
    if (batchChapterCount === null || batchChapterCount < 0) {
      throw automationError(
        ERROR_CODES.BATCH_KEYS_INVALID,
        "当前批次章数无效，无法开始自动模式。"
      );
    }
    if (batchChapterCount > targetCount) {
      throw automationError(
        ERROR_CODES.BATCH_TARGET_TOO_SMALL,
        `目标章数不能小于当前批次的 ${batchChapterCount} 章。`
      );
    }
    const sourceInitialChapterKeys = options?.initialChapterKeys ?? [];
    const initialChapterKeys = normalizeVisitedChapterKeys(
      sourceInitialChapterKeys
    );
    if (
      !Array.isArray(sourceInitialChapterKeys) ||
      sourceInitialChapterKeys.length !== batchChapterCount ||
      initialChapterKeys.length !== batchChapterCount
    ) {
      throw automationError(
        ERROR_CODES.BATCH_KEYS_INVALID,
        "当前批次章节记录无效，无法安全接管自动模式。"
      );
    }
    const timestamp = currentTimestamp(now);
    const suppliedOperationId = options?.operationId;
    const operationId =
      suppliedOperationId === undefined || suppliedOperationId === null
        ? createOperationId(timestamp)
        : normalizeOperationId(suppliedOperationId);
    if (!operationId) {
      throw automationError(
        ERROR_CODES.INVALID_OPERATION_ID,
        "自动模式任务编号无效。"
      );
    }
    return assertValid({
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      kind: AUTOMATION_KIND,
      tabId,
      targetCount,
      format,
      status: STATUS.RUNNING,
      phase: PHASE.CAPTURING,
      capturedCount: batchChapterCount,
      operationId,
      downloadIds: [],
      nextNavigationUrl: null,
      visitedChapterKeys: initialChapterKeys,
      timestamps: {
        startedAt: timestamp,
        updatedAt: timestamp,
        lastProgressAt: batchChapterCount > 0 ? timestamp : null,
        pausedAt: null,
        finishedAt: null,
      },
      lastError: null,
    });
  }

  function updateProgress(state, progress, now) {
    const current = assertActive(state, [PHASE.CAPTURING]);
    if (current.status !== STATUS.RUNNING) {
      throw automationError(
        ERROR_CODES.INVALID_TRANSITION,
        "暂停期间不能记录采集进度。"
      );
    }
    if (current.capturedCount >= current.targetCount) {
      throw automationError(
        ERROR_CODES.TARGET_REACHED,
        "采集章数已经达到目标。"
      );
    }
    const chapterKey = normalizeChapterKey(progress?.chapterKey);
    if (!chapterKey) {
      throw automationError(
        ERROR_CODES.INVALID_CHAPTER_KEY,
        "当前章节标识无效，无法记录进度。"
      );
    }
    if (current.visitedChapterKeys.includes(chapterKey)) {
      throw automationError(
        ERROR_CODES.DUPLICATE_CHAPTER,
        "当前章节已经采集过，自动模式已停止重复计数。"
      );
    }
    const visitedChapterKeys = [...current.visitedChapterKeys, chapterKey].slice(
      -MAX_VISITED_CHAPTER_KEYS
    );
    const capturedCount = visitedChapterKeys.length;
    const suppliedCount =
      progress?.capturedCount === undefined
        ? capturedCount
        : integer(progress.capturedCount);
    if (suppliedCount !== capturedCount) {
      throw automationError(
        ERROR_CODES.INVALID_STATE,
        "自动模式进度与章节记录不一致。"
      );
    }
    let nextNavigationUrl = null;
    if (
      progress?.nextNavigationUrl !== null &&
      progress?.nextNavigationUrl !== undefined &&
      progress?.nextNavigationUrl !== ""
    ) {
      nextNavigationUrl = normalizeNextNavigationUrl(
        progress.nextNavigationUrl
      );
      if (!nextNavigationUrl) {
        throw automationError(
          ERROR_CODES.INVALID_NEXT_URL,
          "页面提供的下一章地址无效。"
        );
      }
    }
    const timestamp = currentTimestamp(now);
    return assertValid({
      ...current,
      capturedCount,
      nextNavigationUrl,
      visitedChapterKeys,
      timestamps: {
        ...current.timestamps,
        updatedAt: timestamp,
        lastProgressAt: timestamp,
      },
      lastError: null,
    });
  }

  function waitForNavigation(state, nextUrl, now) {
    const current = assertActive(state, [PHASE.CAPTURING]);
    if (current.status !== STATUS.RUNNING) {
      throw automationError(
        ERROR_CODES.INVALID_TRANSITION,
        "暂停期间不能打开下一章。"
      );
    }
    if (current.capturedCount >= current.targetCount) {
      throw automationError(
        ERROR_CODES.TARGET_REACHED,
        "采集章数已经达到目标，无需继续翻页。"
      );
    }
    const navigationUrl = normalizeNextNavigationUrl(
      nextUrl ?? current.nextNavigationUrl
    );
    if (!navigationUrl) {
      throw automationError(
        ERROR_CODES.INVALID_NEXT_URL,
        "没有找到有效的下一章地址。"
      );
    }
    const timestamp = currentTimestamp(now);
    return assertValid({
      ...current,
      phase: PHASE.WAITING_NAVIGATION,
      nextNavigationUrl: navigationUrl,
      timestamps: { ...current.timestamps, updatedAt: timestamp },
    });
  }

  function beginCapture(state, now) {
    const current = assertActive(state, [PHASE.WAITING_NAVIGATION]);
    if (current.status !== STATUS.RUNNING) {
      throw automationError(
        ERROR_CODES.INVALID_TRANSITION,
        "暂停期间不能开始采集。"
      );
    }
    const timestamp = currentTimestamp(now);
    return assertValid({
      ...current,
      phase: PHASE.CAPTURING,
      nextNavigationUrl: null,
      timestamps: { ...current.timestamps, updatedAt: timestamp },
    });
  }

  function beginExport(state, now) {
    const current = assertActive(state, [PHASE.CAPTURING]);
    if (
      current.status !== STATUS.RUNNING ||
      current.capturedCount !== current.targetCount
    ) {
      throw automationError(
        ERROR_CODES.TARGET_NOT_REACHED,
        "采集章数尚未达到目标，不能开始导出。"
      );
    }
    const timestamp = currentTimestamp(now);
    return assertValid({
      ...current,
      phase: PHASE.EXPORTING,
      nextNavigationUrl: null,
      timestamps: { ...current.timestamps, updatedAt: timestamp },
    });
  }

  function acceptDownload(state, downloadId, now) {
    const current = assertActive(state, [PHASE.EXPORTING]);
    const normalizedDownloadId = integer(downloadId);
    if (normalizedDownloadId === null || normalizedDownloadId < 0) {
      throw automationError(
        ERROR_CODES.INVALID_STATE,
        "浏览器返回的下载编号无效。"
      );
    }
    if (current.downloadIds.includes(normalizedDownloadId)) {
      throw automationError(
        ERROR_CODES.INVALID_STATE,
        "浏览器返回了重复的下载编号。"
      );
    }
    if (current.downloadIds.length >= current.targetCount) {
      throw automationError(
        ERROR_CODES.INVALID_STATE,
        "浏览器接收的下载文件数已经达到目标。"
      );
    }
    const timestamp = currentTimestamp(now);
    return assertValid({
      ...current,
      downloadIds: [...current.downloadIds, normalizedDownloadId],
      timestamps: { ...current.timestamps, updatedAt: timestamp },
    });
  }

  function pauseForChallenge(state, error, now) {
    const current = assertActive(state, [
      PHASE.CAPTURING,
      PHASE.WAITING_NAVIGATION,
    ]);
    if (current.status !== STATUS.RUNNING) {
      throw automationError(
        ERROR_CODES.INVALID_TRANSITION,
        "自动模式已经暂停。"
      );
    }
    const timestamp = currentTimestamp(now);
    return assertValid({
      ...current,
      status: STATUS.PAUSED,
      phase: PHASE.CHALLENGE,
      timestamps: {
        ...current.timestamps,
        updatedAt: timestamp,
        pausedAt: timestamp,
      },
      lastError: createLastError(
        error || {
          code: "CHALLENGE_DETECTED",
          message: "检测到验证，请在当前标签页手动完成。",
        },
        "CHALLENGE_DETECTED",
        timestamp
      ),
    });
  }

  function resume(state, now) {
    const current = assertActive(state, [PHASE.CHALLENGE]);
    if (current.status !== STATUS.PAUSED) {
      throw automationError(
        ERROR_CODES.INVALID_TRANSITION,
        "当前自动模式没有等待人工验证。"
      );
    }
    const timestamp = currentTimestamp(now);
    return assertValid({
      ...current,
      status: STATUS.RUNNING,
      phase: PHASE.CAPTURING,
      timestamps: { ...current.timestamps, updatedAt: timestamp },
      lastError: null,
    });
  }

  function stop(state, reason, now) {
    const current = assertActive(state);
    const timestamp = currentTimestamp(now);
    const lastError = reason
      ? createLastError(
          typeof reason === "object"
            ? reason
            : { code: "AUTOMATION_STOPPED", message: reason },
          "AUTOMATION_STOPPED",
          timestamp
        )
      : current.lastError;
    return assertValid({
      ...current,
      status: STATUS.STOPPED,
      phase: PHASE.STOPPED,
      nextNavigationUrl: null,
      timestamps: {
        ...current.timestamps,
        updatedAt: timestamp,
        finishedAt: timestamp,
      },
      lastError,
    });
  }

  function complete(state, now) {
    const current = assertActive(state, [PHASE.EXPORTING]);
    if (
      current.capturedCount !== current.targetCount ||
      current.downloadIds.length !== current.targetCount
    ) {
      throw automationError(
        ERROR_CODES.TARGET_NOT_REACHED,
        "采集章数尚未达到目标，不能完成自动模式。"
      );
    }
    const timestamp = currentTimestamp(now);
    return assertValid({
      ...current,
      status: STATUS.COMPLETED,
      phase: PHASE.COMPLETED,
      nextNavigationUrl: null,
      timestamps: {
        ...current.timestamps,
        updatedAt: timestamp,
        finishedAt: timestamp,
      },
      lastError: null,
    });
  }

  function fail(state, error, now) {
    const current = assertActive(state);
    const timestamp = currentTimestamp(now);
    return assertValid({
      ...current,
      status: STATUS.FAILED,
      phase: PHASE.FAILED,
      nextNavigationUrl: null,
      timestamps: {
        ...current.timestamps,
        updatedAt: timestamp,
        finishedAt: timestamp,
      },
      lastError: createLastError(error, ERROR_CODES.FAILED, timestamp),
    });
  }

  function toPublicView(state, actualCapturedCount) {
    const current = assertValid(state);
    let capturedCount = current.capturedCount;
    if (actualCapturedCount !== undefined) {
      capturedCount = integer(actualCapturedCount);
      if (
        capturedCount === null ||
        capturedCount < 0 ||
        capturedCount > current.targetCount
      ) {
        throw automationError(
          ERROR_CODES.INVALID_STATE,
          "用于显示的实际批次章数无效。"
        );
      }
    }
    const {
      nextNavigationUrl: _privateNavigationUrl,
      visitedChapterKeys: _privateVisitedChapterKeys,
      downloadIds: _privateDownloadIds,
      ...publicState
    } = current;
    return {
      ...publicState,
      capturedCount,
      downloadedFileCount: current.downloadIds.length,
      timestamps: { ...publicState.timestamps },
      lastError: publicState.lastError ? { ...publicState.lastError } : null,
    };
  }

  function assertStorageArea(storageArea) {
    if (
      !storageArea ||
      typeof storageArea.get !== "function" ||
      typeof storageArea.set !== "function" ||
      typeof storageArea.remove !== "function"
    ) {
      throw automationError(
        ERROR_CODES.STORAGE_UNAVAILABLE,
        "浏览器会话存储不可用，无法保存自动模式状态。"
      );
    }
  }

  async function load(storageArea) {
    assertStorageArea(storageArea);
    try {
      const stored = await storageArea.get(AUTOMATION_STORAGE_KEY);
      const raw = stored?.[AUTOMATION_STORAGE_KEY];
      if (raw === undefined || raw === null) {
        return null;
      }
      const result = validate(raw);
      if (!result.ok) {
        await storageArea.remove(AUTOMATION_STORAGE_KEY);
        throw automationError(
          ERROR_CODES.INVALID_STATE,
          `已清理损坏的自动模式状态：${result.error}`
        );
      }
      return result.state;
    } catch (error) {
      if (error?.code) {
        throw error;
      }
      throw automationError(
        ERROR_CODES.STORAGE_FAILED,
        "读取自动模式状态失败。"
      );
    }
  }

  async function save(storageArea, state) {
    assertStorageArea(storageArea);
    const normalized = assertValid(state);
    try {
      await storageArea.set({ [AUTOMATION_STORAGE_KEY]: normalized });
      return normalized;
    } catch {
      throw automationError(
        ERROR_CODES.STORAGE_FAILED,
        "保存自动模式状态失败。"
      );
    }
  }

  async function clear(storageArea) {
    assertStorageArea(storageArea);
    try {
      await storageArea.remove(AUTOMATION_STORAGE_KEY);
    } catch {
      throw automationError(
        ERROR_CODES.STORAGE_FAILED,
        "清理自动模式状态失败。"
      );
    }
  }

  root.QidianCrawlerAutomationState = Object.freeze({
    AUTOMATION_STORAGE_KEY,
    AUTOMATION_KIND,
    AUTOMATION_SCHEMA_VERSION,
    MIN_TARGET_COUNT,
    MAX_TARGET_COUNT,
    MAX_VISITED_CHAPTER_KEYS,
    STATUS,
    PHASE,
    ERROR_CODES,
    createOperationId,
    normalizeChapterKey,
    normalizeNextNavigationUrl,
    normalize,
    validate,
    start,
    updateProgress,
    waitForNavigation,
    beginCapture,
    beginExport,
    acceptDownload,
    pauseForChallenge,
    resume,
    stop,
    complete,
    fail,
    toPublicView,
    load,
    save,
    clear,
  });
})(globalThis);
