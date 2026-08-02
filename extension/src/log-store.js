(function defineQidianCrawlerLogStore(root) {
  "use strict";


  const events = root.QidianCrawlerEvents;
  if (!events) {
    throw new Error("QidianCrawlerEvents 必须先于 log-store.js 加载。");
  }

  const LOG_STORAGE_KEY = "qidianCrawler.logs.v1";
  const LOG_SETTINGS_KEY = "qidianCrawler.logSettings.v1";
  const LOG_SCHEMA_VERSION = 1;
  const DEFAULT_MAX_ENTRIES = 500;
  const DEFAULT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
  const DEFAULT_MAX_BYTES = 1024 * 1024;
  const MAX_STRING_LENGTH = 500;
  const MAX_REPORT_STRING_LENGTH = 2000;
  const SAFE_IDENTIFIER_PATTERN = /[^A-Za-z0-9._-]+/g;
  const URL_PATTERN = /\b(?:https?|file|ftp|ws|wss|blob|filesystem|view-source|chrome|edge|chrome-extension|moz-extension|about|data|mailto|javascript):(?:\/\/)?[^\s"'<>)}\]]+/gi;
  const PROTOCOL_RELATIVE_URL_PATTERN = /(^|[\s("'=])\/\/[A-Za-z0-9.-]+(?:\/[^\s"'<>)}\]]*)?/g;
  const WINDOWS_PATH_PATTERN = /\b[A-Za-z]:\\[^\r\n"'<>|]*/g;
  const UNC_PATH_PATTERN = /\\\\[^\s\\/]+\\[^\r\n"'<>|]*/g;
  const SENSITIVE_KEYS = new Set([
    "authorization",
    "body",
    "bookid",
    "booktitle",
    "chapterid",
    "chaptertitle",
    "content",
    "cookie",
    "html",
    "paragraphs",
    "password",
    "secret",
    "token",
    "url",
  ]);

  function isSensitiveKey(key) {
    const normalized = String(key || "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
    return (
      SENSITIVE_KEYS.has(normalized) ||
      /^(?:accesstoken|authtoken|refreshtoken|sessiontoken|sourceurl|nexturl|pageurl|requesturl|responseurl|href)$/.test(
        normalized
      )
    );
  }

  function redactString(value, maximumLength = MAX_STRING_LENGTH) {
    return String(value || "")
      .replace(URL_PATTERN, "[URL_REDACTED]")
      .replace(PROTOCOL_RELATIVE_URL_PATTERN, "$1[URL_REDACTED]")
      .replace(UNC_PATH_PATTERN, "[PATH_REDACTED]")
      .replace(WINDOWS_PATH_PATTERN, "[PATH_REDACTED]")
      .slice(0, maximumLength);
  }

  function sanitizeIdentifier(value, fallback = "system", maximumLength = 120) {
    const source = String(value || "");
    if (redactString(source, Math.max(source.length, maximumLength)) !== source) {
      return fallback;
    }
    const cleaned = source
      .replace(SAFE_IDENTIFIER_PATTERN, "_")
      .replace(/_+/g, "_")
      .replace(/^[_-]+|[_-]+$/g, "")
      .slice(0, maximumLength);
    return cleaned || fallback;
  }

  function clone(value) {
    if (value === undefined) {
      return undefined;
    }
    return JSON.parse(JSON.stringify(value));
  }

  function createMemoryStorageAdapter(initial = {}) {
    const values = clone(initial) || {};
    return {
      async get(key) {
        return clone(values[key]);
      },
      async set(key, value) {
        values[key] = clone(value);
      },
      async remove(key) {
        delete values[key];
      },
      snapshot() {
        return clone(values);
      },
    };
  }

  function createChromeStorageAdapter(area) {
    if (!area) {
      throw new Error("Chrome storage area 不可用。");
    }
    return {
      get(key) {
        return new Promise((resolve, reject) => {
          area.get(key, (result) => {
            const runtimeError = root.chrome?.runtime?.lastError;
            if (runtimeError) {
              reject(new Error(runtimeError.message));
              return;
            }
            resolve(result?.[key]);
          });
        });
      },
      set(key, value) {
        return new Promise((resolve, reject) => {
          area.set({ [key]: value }, () => {
            const runtimeError = root.chrome?.runtime?.lastError;
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
          area.remove(key, () => {
            const runtimeError = root.chrome?.runtime?.lastError;
            if (runtimeError) {
              reject(new Error(runtimeError.message));
              return;
            }
            resolve();
          });
        });
      },
    };
  }

  function sanitizeValue(value, key = "", depth = 0, seen = new WeakSet()) {
    if (isSensitiveKey(key)) {
      return "[REDACTED]";
    }
    if (value === null || value === undefined) {
      return value ?? null;
    }
    if (value instanceof Error) {
      return {
        name: String(value.name || "Error").slice(0, 80),
        message: sanitizeValue(value.message, "errorMessage", depth + 1, seen),
      };
    }
    if (typeof value === "string") {
      return redactString(value);
    }
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : null;
    }
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value !== "object" || depth >= 4) {
      return String(value).slice(0, MAX_STRING_LENGTH);
    }
    if (seen.has(value)) {
      return "[CIRCULAR]";
    }
    seen.add(value);
    if (Array.isArray(value)) {
      return value
        .slice(0, 20)
        .map((item) => sanitizeValue(item, key, depth + 1, seen));
    }
    const sanitized = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 30)) {
      sanitized[childKey] = sanitizeValue(
        childValue,
        childKey,
        depth + 1,
        seen
      );
    }
    return sanitized;
  }

  function sanitizeReportValue(
    value,
    key = "",
    depth = 0,
    seen = new WeakSet()
  ) {
    if (isSensitiveKey(key)) {
      return "[REDACTED]";
    }
    if (value === null || value === undefined) {
      return value ?? null;
    }
    if (value instanceof Error) {
      return {
        name: redactString(value.name || "Error", 80),
        message: redactString(value.message || "", MAX_REPORT_STRING_LENGTH),
      };
    }
    if (typeof value === "string") {
      return redactString(value, MAX_REPORT_STRING_LENGTH);
    }
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : null;
    }
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value !== "object" || depth >= 10) {
      return redactString(value, MAX_REPORT_STRING_LENGTH);
    }
    if (seen.has(value)) {
      return "[CIRCULAR]";
    }
    seen.add(value);
    if (Array.isArray(value)) {
      return value
        .slice(0, 1000)
        .map((item) => sanitizeReportValue(item, key, depth + 1, seen));
    }
    const sanitized = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 200)) {
      sanitized[childKey] = sanitizeReportValue(
        childValue,
        childKey,
        depth + 1,
        seen
      );
    }
    return sanitized;
  }

  function sanitizeDetails(code, details) {
    const definition = events.get(code);
    if (!definition) {
      throw new Error(`未知日志事件码：${code}`);
    }
    const source = details && typeof details === "object" ? details : {};
    const result = {};
    for (const key of definition.allowedDetails) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        result[key] = sanitizeValue(source[key], key);
      }
    }
    const serialized = JSON.stringify(result);
    if (new TextEncoder().encode(serialized).byteLength > 2048) {
      return { truncated: true };
    }
    return result;
  }

  function validState(value) {
    if (
      !value ||
      typeof value !== "object" ||
      value.version !== LOG_SCHEMA_VERSION ||
      !Number.isInteger(value.nextSequence) ||
      value.nextSequence < 1 ||
      !Array.isArray(value.entries)
    ) {
      return false;
    }
    const sequences = new Set();
    const eventKeys = new Set();
    let previousSequence = 0;
    for (const entry of value.entries) {
      if (
        !entry ||
        typeof entry !== "object" ||
        !Number.isInteger(entry.sequence) ||
        entry.sequence < 1 ||
        entry.sequence <= previousSequence ||
        sequences.has(entry.sequence) ||
        !Number.isFinite(Date.parse(entry.time)) ||
        !events.get(entry.code) ||
        typeof entry.operationId !== "string" ||
        (entry.eventKey !== undefined &&
          entry.eventKey !== null &&
          typeof entry.eventKey !== "string")
      ) {
        return false;
      }
      if (entry.eventKey) {
        if (eventKeys.has(entry.eventKey)) {
          return false;
        }
        eventKeys.add(entry.eventKey);
      }
      sequences.add(entry.sequence);
      previousSequence = entry.sequence;
    }
    const largestSequence = value.entries.reduce(
      (largest, entry) => Math.max(largest, entry.sequence),
      0
    );
    return value.nextSequence > largestSequence;
  }

  function createLogStore(options) {
    const storage = options?.storage;
    if (!storage) {
      throw new Error("日志存储适配器不可用。");
    }
    const extensionVersion = String(options.extensionVersion || "unknown");
    const maxEntries = Number(options.maxEntries || DEFAULT_MAX_ENTRIES);
    const maxAgeMs = Number(options.maxAgeMs || DEFAULT_MAX_AGE_MS);
    const maxBytes = Number(options.maxBytes || DEFAULT_MAX_BYTES);
    const now = options.now || (() => new Date());
    const idFactory =
      options.idFactory ||
      (() => root.crypto?.randomUUID?.() || `log-${Date.now()}-${Math.random()}`);
    let queue = Promise.resolve();

    function enqueue(task) {
      const result = queue.then(task);
      queue = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    }

    function emptyState() {
      return { version: LOG_SCHEMA_VERSION, nextSequence: 1, entries: [] };
    }

    function normalizeStoredEntry(entry, sequence = entry.sequence) {
        const definition = events.get(entry.code);
        if (!definition || !Number.isFinite(Date.parse(entry.time))) {
          return null;
        }
        const eventKey =
          entry.eventKey === undefined || entry.eventKey === null
            ? null
            : sanitizeIdentifier(entry.eventKey, "", 160) || null;
        return {
          schemaVersion: LOG_SCHEMA_VERSION,
          sequence,
          id: sanitizeIdentifier(entry.id, `stored-${sequence}`),
          time: new Date(entry.time).toISOString(),
          level: definition.level,
          code: entry.code,
          message: definition.message,
          component: ["background", "popup", "diagnostics"].includes(
            entry.component
          )
            ? entry.component
            : "background",
          operationId: sanitizeIdentifier(entry.operationId, "system"),
          eventKey,
          extensionVersion: sanitizeIdentifier(
            entry.extensionVersion,
            extensionVersion,
            40
          ),
          details: sanitizeDetails(entry.code, entry.details),
        };
    }

    function normalizeStoredState(stored) {
      const state = clone(stored);
      const seenEventKeys = new Set();
      state.entries = state.entries
        .map((entry) => normalizeStoredEntry(entry))
        .filter((entry) => {
          if (!entry) {
            return false;
          }
          if (entry.eventKey && seenEventKeys.has(entry.eventKey)) {
            return false;
          }
          if (entry.eventKey) {
            seenEventKeys.add(entry.eventKey);
          }
          return true;
        });
      const largestSequence = state.entries.reduce(
        (largest, entry) => Math.max(largest, entry.sequence),
        0
      );
      state.nextSequence = Math.max(Number(state.nextSequence) || 1, largestSequence + 1);
      prune(state);
      return state;
    }

    function rebuildStoredState(stored) {
      const state = emptyState();
      const entries = Array.isArray(stored?.entries) ? stored.entries : [];
      const seenEventKeys = new Set();
      for (const candidate of entries) {
        if (!candidate || typeof candidate !== "object") {
          continue;
        }
        const normalized = normalizeStoredEntry(candidate, state.nextSequence);
        if (!normalized) {
          continue;
        }
        if (normalized.eventKey && seenEventKeys.has(normalized.eventKey)) {
          continue;
        }
        if (normalized.eventKey) {
          seenEventKeys.add(normalized.eventKey);
        }
        state.entries.push(normalized);
        state.nextSequence += 1;
      }
      prune(state);
      return state;
    }

    async function loadState() {
      const stored = await storage.get(LOG_STORAGE_KEY);
      if (stored === undefined || stored === null) {
        return { state: emptyState(), recovered: false };
      }
      if (!validState(stored)) {
        return { state: rebuildStoredState(stored), recovered: true };
      }
      const normalized = normalizeStoredState(stored);
      if (JSON.stringify(normalized) !== JSON.stringify(stored)) {
        await saveWithRetry(normalized);
      }
      return { state: normalized, recovered: false };
    }

    async function getSettingsUnlocked() {
      const stored = await storage.get(LOG_SETTINGS_KEY);
      return {
        debugEnabled: Boolean(stored?.debugEnabled),
      };
    }

    function createEntry(
      state,
      code,
      component,
      operationId,
      details,
      eventKey = null
    ) {
      const definition = events.get(code);
      if (!definition) {
        throw new Error(`未知日志事件码：${code}`);
      }
      const entry = {
        schemaVersion: LOG_SCHEMA_VERSION,
        sequence: state.nextSequence,
        id: sanitizeIdentifier(idFactory(), `log-${state.nextSequence}`),
        time: now().toISOString(),
        level: definition.level,
        code,
        message: definition.message,
        component: ["background", "popup", "diagnostics"].includes(component)
          ? component
          : "background",
        operationId: sanitizeIdentifier(operationId, "system"),
        eventKey:
          eventKey === undefined || eventKey === null
            ? null
            : sanitizeIdentifier(eventKey, "", 160) || null,
        extensionVersion: sanitizeIdentifier(extensionVersion, "unknown", 40),
        details: sanitizeDetails(code, details),
      };
      state.nextSequence += 1;
      return entry;
    }

    function prune(state) {
      const cutoff = now().getTime() - maxAgeMs;
      state.entries = state.entries.filter((entry) => {
        const timestamp = Date.parse(entry?.time);
        return Number.isFinite(timestamp) && timestamp >= cutoff;
      });
      if (state.entries.length > maxEntries) {
        state.entries = state.entries.slice(-maxEntries);
      }
      while (
        state.entries.length > 1 &&
        new TextEncoder().encode(JSON.stringify(state)).byteLength > maxBytes
      ) {
        state.entries.shift();
      }
      return state;
    }

    function isQuotaError(error) {
      const text = `${error?.name || ""} ${error?.message || error || ""}`.toLowerCase();
      return /quota|max_write|maxwrite|storage.*limit|exceed/.test(text);
    }

    function emergencyPrune(state) {
      const before = state.entries.length;
      if (before <= 1) {
        return 0;
      }
      const keepCount = Math.max(1, Math.min(250, Math.floor(before / 2)));
      state.entries = state.entries.slice(-keepCount);
      const removedEntries = before - state.entries.length;
      state.entries.push(
        createEntry(
          state,
          "LOG_STORE_EMERGENCY_PRUNED",
          "background",
          "log-store",
          { reason: "quota-exceeded", removedEntries },
          `log-store-emergency-pruned-${state.nextSequence}`
        )
      );
      prune(state);
      return removedEntries;
    }

    async function saveWithRetry(state) {
      try {
        await storage.set(LOG_STORAGE_KEY, state);
      } catch (firstError) {
        if (isQuotaError(firstError)) {
          emergencyPrune(state);
        }
        try {
          await storage.set(LOG_STORAGE_KEY, state);
        } catch (secondError) {
          throw secondError;
        }
      }
    }

    async function recoverIfNeeded(loaded) {
      if (!loaded.recovered) {
        return loaded.state;
      }
      const state = loaded.state;
      state.entries.push(
        createEntry(
          state,
          "LOG_STORE_RECOVERED",
          "background",
          "system",
          { reason: "invalid-storage-shape" }
        )
      );
      prune(state);
      await saveWithRetry(state);
      return state;
    }

    function append(code, component, operationId, details = {}, eventKey = null) {
      return enqueue(async () => {
        const definition = events.get(code);
        if (!definition) {
          throw new Error(`未知日志事件码：${code}`);
        }
        const settings = await getSettingsUnlocked();
        if (definition.level === "DEBUG" && !settings.debugEnabled) {
          return { persisted: false, entry: null };
        }
        const loaded = await loadState();
        const state = await recoverIfNeeded(loaded);
        const normalizedEventKey =
          eventKey === undefined || eventKey === null
            ? null
            : sanitizeIdentifier(eventKey, "", 160) || null;
        if (normalizedEventKey) {
          const existing = state.entries.find(
            (entry) => entry.eventKey === normalizedEventKey
          );
          if (existing) {
            return {
              persisted: true,
              duplicate: true,
              entry: clone(existing),
            };
          }
        }
        const entry = createEntry(
          state,
          code,
          component,
          operationId,
          details,
          normalizedEventKey
        );
        state.entries.push(entry);
        prune(state);
        await saveWithRetry(state);
        return { persisted: true, duplicate: false, entry: clone(entry) };
      });
    }

    function read() {
      return enqueue(async () => {
        const state = await recoverIfNeeded(await loadState());
        return clone(state.entries);
      });
    }

    function clear() {
      return enqueue(async () => {
        await storage.set(LOG_STORAGE_KEY, emptyState());
      });
    }

    function getSettings() {
      return enqueue(() => getSettingsUnlocked());
    }

    function setDebugEnabled(enabled) {
      return enqueue(async () => {
        const settings = { debugEnabled: Boolean(enabled) };
        await storage.set(LOG_SETTINGS_KEY, settings);
        return clone(settings);
      });
    }

    return Object.freeze({
      append,
      read,
      clear,
      getSettings,
      setDebugEnabled,
    });
  }

  root.QidianCrawlerLogStore = Object.freeze({
    LOG_STORAGE_KEY,
    LOG_SETTINGS_KEY,
    LOG_SCHEMA_VERSION,
    createMemoryStorageAdapter,
    createChromeStorageAdapter,
    sanitizeIdentifier,
    sanitizeValue,
    sanitizeReportValue,
    sanitizeDetails,
    validState,
    createLogStore,
  });
})(globalThis);
