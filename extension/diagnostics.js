(function initializeDiagnostics() {
  "use strict";


  const core = QidianCrawlerCore;
  const logs = QidianCrawlerLogClient;
  const logStoreApi = QidianCrawlerLogStore;
  const runButton = document.querySelector("#run-diagnostics");
  const checksNode = document.querySelector("#checks");
  const checksSummaryNode = document.querySelector("#checks-summary");
  const logsNode = document.querySelector("#logs");
  const logsSummaryNode = document.querySelector("#logs-summary");
  const filterSelect = document.querySelector("#level-filter");
  const debugCheckbox = document.querySelector("#debug-enabled");
  const copyButton = document.querySelector("#copy-report");
  const exportButton = document.querySelector("#export-report");
  const clearButton = document.querySelector("#clear-logs");
  const pageStatusNode = document.querySelector("#page-status");
  let latestChecks = [];
  let latestLogs = [];
  let busy = false;
  let storageAccessStatus = null;

  function setPageStatus(message) {
    pageStatusNode.textContent = message;
  }

  function refreshButtons() {
    runButton.disabled = busy;
    copyButton.disabled = busy;
    exportButton.disabled = busy;
    clearButton.disabled = busy;
    debugCheckbox.disabled = busy;
  }

  function storageGet(area, key) {
    return new Promise((resolve, reject) => {
      area.get(key, (result) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }
        resolve(result?.[key]);
      });
    });
  }

  function storageSet(area, key, value) {
    return new Promise((resolve, reject) => {
      area.set({ [key]: value }, () => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }
        resolve();
      });
    });
  }

  function storageRemove(area, key) {
    return new Promise((resolve, reject) => {
      area.remove(key, () => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }
        resolve();
      });
    });
  }

  function getStorageBytes() {
    return new Promise((resolve, reject) => {
      chrome.storage.local.getBytesInUse(null, (bytes) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }
        resolve(Number(bytes));
      });
    });
  }

  function permissionsContain(permissions) {
    return new Promise((resolve) => {
      chrome.permissions.contains({ permissions }, (allowed) => {
        resolve(!chrome.runtime.lastError && Boolean(allowed));
      });
    });
  }

  function setTrustedStorageAccess() {
    return new Promise((resolve) => {
      if (typeof chrome.storage.local.setAccessLevel !== "function") {
        resolve({ supported: false, ok: false, reason: "api-unavailable" });
        return;
      }
      chrome.storage.local.setAccessLevel(
        { accessLevel: "TRUSTED_CONTEXTS" },
        () => {
          const runtimeError = chrome.runtime.lastError;
          resolve({
            supported: true,
            ok: !runtimeError,
            reason: runtimeError ? "set-access-level-failed" : null,
          });
        }
      );
    });
  }

  async function readStorageAccessStatus() {
    try {
      const status = await logs.getStorageAccessStatus();
      if (status && typeof status === "object") {
        return {
          supported: Boolean(status.supported),
          ok: Boolean(status.ok),
          reason: status.reason || null,
          source: "background",
        };
      }
    } catch {
      // 兼容尚未提供状态消息的旧后台，随后在诊断页重新设置并验证。
    }
    return { ...(await setTrustedStorageAccess()), source: "diagnostics" };
  }

  function executeExtractor(tabId) {
    return new Promise((resolve, reject) => {
      chrome.scripting.executeScript(
        {
          target: { tabId },
          files: [
            "src/core.js",
            "src/extractor.js",
            "src/extract-diagnostics.js",
          ],
        },
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

  function createCheck(code, status, title, summary, suggestion = "") {
    const redact = (value) =>
      String(logStoreApi.sanitizeReportValue(String(value || ""))).slice(0, 1000);
    return {
      code: redact(code),
      status,
      title: redact(title),
      summary: redact(summary),
      suggestion: redact(suggestion),
    };
  }

  async function safeCheck(code, title, check) {
    try {
      return await check();
    } catch (error) {
      return createCheck(
        code,
        "fail",
        title,
        error instanceof Error ? error.message : String(error),
        "导出诊断报告并根据错误码排查。"
      );
    }
  }

  function sampleChapter(id, title) {
    return {
      bookId: "1000000000",
      bookTitle: "诊断样本",
      chapterId: id,
      title,
      paragraphs: ["第一段合成文本。", "第二段合成文本。"],
      sourceUrl: `https://www.qidian.com/chapter/1000000000/${id}/`,
      nextUrl: null,
    };
  }

  async function runChecks() {
    const checks = [];
    checks.push(
      await safeCheck("MANIFEST", "Manifest 与权限", async () => {
        const manifest = chrome.runtime.getManifest();
        const expectedPermissions = [
          "activeTab",
          "scripting",
          "downloads",
          "offscreen",
          "storage",
        ];
        const hasPermissions = expectedPermissions.every((item) =>
          manifest.permissions?.includes(item)
        );
        const hasForbidden = ["alarms", "cookies", "history", "webRequest"].some(
          (item) => manifest.permissions?.includes(item)
        );
        if (manifest.manifest_version !== 3 || !hasPermissions || hasForbidden) {
          throw new Error("Manifest 版本或权限集合不符合项目约束。");
        }
        return createCheck(
          "MANIFEST",
          "pass",
          "Manifest 与权限",
          `MV3，版本 ${manifest.version}，权限符合最小白名单。`
        );
      })
    );

    checks.push(
      await safeCheck("PERMISSIONS", "运行时权限", async () => {
        const allowed = await permissionsContain([
          "activeTab",
          "scripting",
          "downloads",
          "offscreen",
          "storage",
        ]);
        return createCheck(
          "PERMISSIONS",
          allowed ? "pass" : "warn",
          "运行时权限",
          allowed ? "必要权限均可用。" : "部分权限尚未由浏览器授予。",
          allowed ? "" : "重新加载扩展，并从工具栏打开一次扩展。"
        );
      })
    );

    checks.push(
      await safeCheck("STORAGE_ACCESS", "日志访问隔离", async () => {
        storageAccessStatus = await readStorageAccessStatus();
        if (!storageAccessStatus.ok) {
          await logs.event(
            "STORAGE_ACCESS_LEVEL_WARNING",
            { reason: storageAccessStatus.reason || "status-unconfirmed" },
            "storage-access",
            "diagnostics",
            `storage-access-${storageAccessStatus.reason || "unconfirmed"}`
          );
        }
        return createCheck(
          "STORAGE_ACCESS",
          storageAccessStatus.ok ? "pass" : "warn",
          "日志访问隔离",
          storageAccessStatus.ok
            ? "日志存储已限制为扩展可信上下文访问。"
            : storageAccessStatus.supported
              ? "浏览器支持访问隔离，但本次未能确认设置成功。"
              : "当前浏览器不提供日志存储访问隔离 API。",
          storageAccessStatus.ok
            ? ""
            : "更新 Chrome 或 Edge、重新加载扩展后再次运行自检。"
        );
      })
    );

    checks.push(
      await safeCheck("STORAGE", "本地存储", async () => {
        const key = `qidianCrawler.diagnostics.${Date.now()}`;
        try {
          await storageSet(chrome.storage.local, key, { value: "ok" });
          const stored = await storageGet(chrome.storage.local, key);
          if (stored?.value !== "ok") {
            throw new Error("写入后未能读取相同的数据。");
          }
        } finally {
          await storageRemove(chrome.storage.local, key).catch(() => undefined);
        }
        const bytes = await getStorageBytes();
        return createCheck(
          "STORAGE",
          "pass",
          "本地存储",
          `读写正常，当前占用 ${(bytes / 1024).toFixed(1)} KiB。`
        );
      })
    );

    checks.push(
      await safeCheck("CORE_EXPORT", "批次与导出核心", async () => {
        let result = core.addChapter(null, sampleChapter("2000000001", "第1章"));
        result = core.addChapter(
          result.batch,
          sampleChapter("2000000002", "第2章")
        );
        const txt = core.createChapterExports(result.batch, "txt");
        const json = core.createChapterExports(
          result.batch,
          "json",
          "2026-01-01T00:00:00.000Z"
        );
        const parsed = JSON.parse(json[1].content);
        if (
          txt.length !== 2 ||
          json.length !== 2 ||
          parsed.chapterCount !== 1 ||
          parsed.chapters[0]?.title !== "第2章" ||
          !txt[0].relativePath.includes("诊断样本-2章") ||
          txt[0].content.includes("第2章")
        ) {
          throw new Error("逐章 TXT/JSON 导出结果不符合预期。");
        }
        return createCheck(
          "CORE_EXPORT",
          "pass",
          "批次与导出核心",
          "去重、逐章 UTF-8 TXT/JSON 和目录命名正常。"
        );
      })
    );

    checks.push(
      await safeCheck("BATCH", "书籍批次", async () => {
        const collection = core.readBatchCollection(
          await storageGet(chrome.storage.local, core.BATCH_STORAGE_KEY)
        );
        if (collection.batches.length === 0) {
          return createCheck(
            "BATCH",
            "skip",
            "书籍批次",
            "书籍批次为空，跳过结构检查。"
          );
        }
        const chapterCount = collection.batches.reduce((sum, batch) => sum + batch.chapters.length, 0);
        return createCheck(
          "BATCH",
          "pass",
          "书籍批次",
          `结构有效，共 ${collection.batches.length} 本书、${chapterCount} 章。`
        );
      })
    );

    checks.push(
      await safeCheck("LOG_STORE", "结构化日志", async () => {
        const entries = await logs.getLogs();
        const sequences = new Set();
        const eventKeys = new Set();
        let previousSequence = 0;
        for (const entry of entries) {
          const definition = QidianCrawlerEvents.get(entry?.code);
          const safeDetails = definition
            ? logStoreApi.sanitizeDetails(entry.code, entry.details)
            : null;
          const operationIdIsSafe =
            typeof entry?.operationId === "string" &&
            logStoreApi.sanitizeIdentifier(entry.operationId, "system") ===
              entry.operationId;
          const eventKeyIsSafe =
            entry?.eventKey === null ||
            entry?.eventKey === undefined ||
            (typeof entry.eventKey === "string" &&
              logStoreApi.sanitizeIdentifier(entry.eventKey, "", 160) ===
                entry.eventKey);
          if (
            !definition ||
            !Number.isFinite(Date.parse(entry?.time)) ||
            !Number.isInteger(entry?.sequence) ||
            entry.sequence <= previousSequence ||
            sequences.has(entry.sequence) ||
            entry.level !== definition.level ||
            entry.message !== definition.message ||
            !operationIdIsSafe ||
            !eventKeyIsSafe ||
            (entry.eventKey && eventKeys.has(entry.eventKey)) ||
            JSON.stringify(entry.details || {}) !== JSON.stringify(safeDetails || {})
          ) {
            throw new Error("发现顺序、事件码或脱敏状态异常的日志条目。");
          }
          sequences.add(entry.sequence);
          if (entry.eventKey) {
            eventKeys.add(entry.eventKey);
          }
          previousSequence = entry.sequence;
        }
        return createCheck(
          "LOG_STORE",
          "pass",
          "结构化日志",
          `日志可读，共 ${entries.length} 条。`
        );
      })
    );

    checks.push(
      await safeCheck("DOWNLOAD_API", "下载能力", async () => {
        if (
          typeof chrome.downloads?.download !== "function" ||
          typeof chrome.offscreen?.createDocument !== "function"
        ) {
          throw new Error("自动导出所需的下载或离屏页面 API 不可用。");
        }
        return createCheck(
          "DOWNLOAD_API",
          "pass",
          "下载能力",
          "下载 API 可用；自检不会自动创建测试文件。"
        );
      })
    );

    checks.push(
      await safeCheck("CURRENT_PAGE", "来源章节页", async () => {
        const context = await storageGet(
          chrome.storage.session,
          core.DIAGNOSTICS_CONTEXT_KEY
        );
        if (!Number.isInteger(context?.tabId)) {
          return createCheck(
            "CURRENT_PAGE",
            "skip",
            "来源章节页",
            "没有可检查的来源标签页。请从扩展弹窗进入本页面。"
          );
        }
        const result = await executeExtractor(context.tabId);
        if (!result) {
          throw new Error("来源页面没有返回解析结果。");
        }
        if (!result.ok) {
          const isChallenge = result.reason === "challenge-page";
          return createCheck(
            "CURRENT_PAGE",
            isChallenge ? "warn" : "fail",
            "来源章节页",
            isChallenge ? "来源页面正在显示安全验证。" : result.error,
            isChallenge
              ? "手动完成验证后重新运行自检。"
              : "确认正文可见；若站点已改版，请提供诊断报告。"
          );
        }
        if (!Number.isInteger(result.paragraphCount) || result.paragraphCount < 1) {
          throw new Error("来源页面没有返回有效的正文段落计数。");
        }
        return createCheck(
          "CURRENT_PAGE",
          "pass",
          "来源章节页",
          `已识别 ${result.paragraphCount} 个正文段落；诊断结果不返回或保存正文。`
        );
      })
    );

    return checks;
  }

  function renderChecks(checks) {
    checksNode.replaceChildren();
    checksNode.className = "checks";
    for (const check of checks) {
      const article = document.createElement("article");
      article.className = `check ${check.status}`;
      const heading = document.createElement("strong");
      const marks = { pass: "✓", warn: "!", fail: "×", skip: "–" };
      heading.textContent = `${marks[check.status] || "·"} ${check.title} · ${check.code}`;
      const summary = document.createElement("p");
      summary.textContent = check.summary;
      article.append(heading, summary);
      if (check.suggestion) {
        const suggestion = document.createElement("p");
        suggestion.className = "suggestion";
        suggestion.textContent = `建议：${check.suggestion}`;
        article.append(suggestion);
      }
      checksNode.append(article);
    }
    const passed = checks.filter((item) => item.status === "pass").length;
    const warnings = checks.filter((item) => ["warn", "skip"].includes(item.status)).length;
    const failed = checks.filter((item) => item.status === "fail").length;
    checksSummaryNode.textContent = `${passed} 通过 · ${warnings} 警告/跳过 · ${failed} 失败`;
  }

  function renderLogs(entries) {
    latestLogs = entries;
    const level = filterSelect.value;
    const filtered = entries
      .filter((entry) => level === "ALL" || entry.level === level)
      .slice()
      .reverse()
      .slice(0, 100);
    logsNode.replaceChildren();
    if (filtered.length === 0) {
      logsNode.className = "log-list empty";
      logsNode.textContent = "当前筛选条件下暂无日志。";
    } else {
      logsNode.className = "log-list";
      for (const entry of filtered) {
        const article = document.createElement("article");
        article.className = `log-entry ${entry.level.toLowerCase()}`;
        const heading = document.createElement("strong");
        heading.textContent = `${entry.level} · ${entry.code}`;
        const meta = document.createElement("span");
        meta.className = "log-meta";
        meta.textContent = `${new Date(entry.time).toLocaleString()} · #${entry.sequence} · ${entry.operationId}`;
        const message = document.createElement("p");
        message.textContent = entry.message;
        article.append(heading, meta, message);
        if (entry.details && Object.keys(entry.details).length > 0) {
          const details = document.createElement("p");
          details.className = "log-details";
          details.textContent = JSON.stringify(entry.details, null, 2);
          article.append(details);
        }
        logsNode.append(article);
      }
    }
    logsSummaryNode.textContent = `共 ${entries.length} 条，当前显示 ${filtered.length} 条`;
  }

  async function refreshLogs() {
    const entries = await logs.getLogs();
    renderLogs(entries);
  }

  function browserSummary() {
    const userAgent = navigator.userAgent || "";
    const match = userAgent.match(/(Edg|Chrome)\/([\d.]+)/);
    return {
      family: match?.[1] === "Edg" ? "Edge" : match?.[1] === "Chrome" ? "Chrome" : "Chromium",
      version: match?.[2] || "unknown",
      platform: navigator.userAgentData?.platform || navigator.platform || "unknown",
    };
  }

  async function buildReport() {
    const [entries, settings, storedBatches] = await Promise.all([
      logs.getLogs(),
      logs.getSettings(),
      storageGet(chrome.storage.local, core.BATCH_STORAGE_KEY),
    ]);
    let collection = null;
    try {
      collection = core.readBatchCollection(storedBatches);
    } catch {
      // 损坏的批次仍允许导出不含正文的诊断报告。
    }
    const report = {
      schemaVersion: 1,
      kind: "qidian-crawler-diagnostic-report",
      generatedAt: new Date().toISOString(),
      extension: {
        name: chrome.runtime.getManifest().name,
        version: chrome.runtime.getManifest().version,
        manifestVersion: chrome.runtime.getManifest().manifest_version,
      },
      environment: browserSummary(),
      privacy: {
        redacted: true,
        pageContentIncluded: false,
        fullUrlIncluded: false,
        accountDataIncluded: false,
      },
      settings,
      storageAccess: storageAccessStatus || {
        supported: false,
        ok: false,
        reason: "not-checked",
      },
      batch: {
        present: Boolean(storedBatches),
        valid: Boolean(collection),
        bookCount: collection?.batches.length || 0,
        chapterCount: collection?.batches.reduce((sum, batch) => sum + batch.chapters.length, 0) || 0,
        estimatedBytes: storedBatches ? core.estimateUtf8Bytes(storedBatches) : 0,
      },
      checks: latestChecks,
      logs: entries,
    };
    const sanitized = logStoreApi.sanitizeReportValue(report);
    sanitized.privacy = {
      redacted: true,
      pageContentIncluded: false,
      fullUrlIncluded: false,
      accountDataIncluded: false,
    };
    return sanitized;
  }

  async function runDiagnostics() {
    const operationId = logs.createOperationId("diagnostics");
    busy = true;
    refreshButtons();
    setPageStatus("正在运行自检……");
    await logs.event("DIAGNOSTICS_STARTED", {}, operationId, "diagnostics");
    try {
      latestChecks = await runChecks();
      renderChecks(latestChecks);
      const counts = {
        checkPassed: latestChecks.filter((item) => item.status === "pass").length,
        checkWarnings: latestChecks.filter((item) =>
          ["warn", "skip"].includes(item.status)
        ).length,
        checkFailed: latestChecks.filter((item) => item.status === "fail").length,
      };
      await logs.event(
        "DIAGNOSTICS_COMPLETED",
        counts,
        operationId,
        "diagnostics"
      );
      await refreshLogs();
      setPageStatus(
        counts.checkFailed === 0 ? "自检完成。" : "自检完成，存在失败项。"
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const failure = createCheck(
        "DIAGNOSTICS_RUNTIME",
        "fail",
        "自检运行状态",
        reason,
        "重新加载扩展后重试；若仍失败，请复制当前日志。"
      );
      latestChecks = [...latestChecks, failure];
      renderChecks(latestChecks);
      await logs.event(
        "DIAGNOSTICS_FAILED",
        { reason: "top-level-diagnostics-failure" },
        operationId,
        "diagnostics",
        `diagnostics-failed-${operationId}`
      );
      await refreshLogs().catch(() => undefined);
      setPageStatus("自检未能完整运行，请查看失败项。" );
    } finally {
      busy = false;
      refreshButtons();
    }
  }

  async function copyReport() {
    busy = true;
    refreshButtons();
    try {
      const report = await buildReport();
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      setPageStatus("诊断报告已复制到剪贴板。" );
    } catch (error) {
      setPageStatus(`复制失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      busy = false;
      refreshButtons();
    }
  }

  function downloadJson(content, filename) {
    return new Promise((resolve, reject) => {
      const blobUrl = URL.createObjectURL(
        new Blob([content], { type: "application/json;charset=utf-8" })
      );
      chrome.downloads.download(
        { url: blobUrl, filename, conflictAction: "uniquify", saveAs: false },
        (downloadId) => {
          const runtimeError = chrome.runtime.lastError;
          window.setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
          if (runtimeError || downloadId === undefined) {
            const error = new Error(
              runtimeError?.message || "浏览器没有开始下载。"
            );
            error.code = "DOWNLOAD_REJECTED";
            reject(error);
            return;
          }
          resolve(downloadId);
        }
      );
    });
  }

  async function exportReport() {
    const operationId = logs.createOperationId("report");
    busy = true;
    refreshButtons();
    try {
      const report = await buildReport();
      const stamp = report.generatedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
      const downloadId = await downloadJson(
        `${JSON.stringify(report, null, 2)}\n`,
        `QidianCrawler/diagnostics/QidianCrawler-diagnostics-${stamp}.json`
      );
      const tracked = await logs
        .trackDownload(downloadId, {
          format: "diagnostic",
          chapterCount: 0,
          operationId,
        })
        .then(
          () => true,
          () => false
        );
      await logs.event(
        "DIAGNOSTIC_REPORT_EXPORTED",
        { downloadId },
        operationId,
        "diagnostics",
        `diagnostic-report-${downloadId}-accepted`
      );
      if (!tracked) {
        await logs.event(
          "STORAGE_WRITE_FAILED",
          { reason: "diagnostic-download-tracking-failed" },
          operationId,
          "diagnostics",
          `diagnostic-report-${downloadId}-tracking-failed`
        );
      }
      await refreshLogs();
      setPageStatus(
        tracked
          ? "浏览器已接收诊断报告下载。"
          : "浏览器已接收报告下载，但完成状态未能写入日志。"
      );
    } catch (error) {
      if (error?.code === "DOWNLOAD_REJECTED") {
        await logs.event(
          "DOWNLOAD_REJECTED",
          {
            format: "diagnostic",
            chapterCount: 0,
            reason: "diagnostic-download-rejected",
          },
          operationId,
          "diagnostics",
          `diagnostic-report-${operationId}-rejected`
        );
      }
      setPageStatus(
        `导出失败：${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      busy = false;
      refreshButtons();
    }
  }

  async function clearLogs() {
    if (!window.confirm("确定清空全部结构化日志吗？此操作无法撤销。")) {
      return;
    }
    busy = true;
    refreshButtons();
    try {
      await logs.clearLogs();
      await refreshLogs();
      setPageStatus("日志已清空。" );
    } catch (error) {
      setPageStatus(`清空失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      busy = false;
      refreshButtons();
    }
  }

  async function toggleDebug() {
    busy = true;
    refreshButtons();
    try {
      const settings = await logs.setDebugEnabled(debugCheckbox.checked);
      debugCheckbox.checked = settings.debugEnabled;
      await refreshLogs();
      setPageStatus(settings.debugEnabled ? "DEBUG 日志已开启。" : "DEBUG 日志已关闭。" );
    } catch (error) {
      debugCheckbox.checked = !debugCheckbox.checked;
      setPageStatus(`设置失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      busy = false;
      refreshButtons();
    }
  }

  async function initialize() {
    try {
      const settings = await logs.getSettings();
      debugCheckbox.checked = Boolean(settings.debugEnabled);
      await refreshLogs();
      setPageStatus("准备就绪。" );
    } catch (error) {
      setPageStatus(`日志读取失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  runButton.addEventListener("click", () => void runDiagnostics());
  filterSelect.addEventListener("change", () => renderLogs(latestLogs));
  debugCheckbox.addEventListener("change", () => void toggleDebug());
  copyButton.addEventListener("click", () => void copyReport());
  exportButton.addEventListener("click", () => void exportReport());
  clearButton.addEventListener("click", () => void clearLogs());

  refreshButtons();
  void initialize();
})();
