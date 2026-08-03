(function defineQidianCrawlerEvents(root) {
  "use strict";


  const definitions = {
    EXTENSION_INSTALLED: {
      level: "INFO",
      message: "扩展已安装",
      suggestion: "无需处理。",
      allowedDetails: ["reason"],
    },
    EXTENSION_UPDATED: {
      level: "INFO",
      message: "扩展已更新",
      suggestion: "如页面已打开，请刷新章节页面后再使用扩展。",
      allowedDetails: ["previousVersion"],
    },
    LEGACY_STATE_REMOVED: {
      level: "INFO",
      message: "旧版自动化状态已清理",
      suggestion: "无需处理。",
      allowedDetails: ["removedKeyCount"],
    },
    WORKER_UNHANDLED_ERROR: {
      level: "ERROR",
      message: "扩展后台发生未处理错误",
      suggestion: "打开日志与诊断页面并导出诊断报告。",
      allowedDetails: ["reason"],
    },
    POPUP_OPENED: {
      level: "DEBUG",
      message: "扩展弹窗已打开",
      suggestion: "无需处理。",
      allowedDetails: [],
    },
    PAGE_INSPECTION_STARTED: {
      level: "DEBUG",
      message: "开始检查当前章节页面",
      suggestion: "无需处理。",
      allowedDetails: ["adapterId"],
    },
    PAGE_UNSUPPORTED: {
      level: "WARN",
      message: "当前页面不是受支持的章节页",
      suggestion: "打开能够正常显示正文的起点章节页面后重试。",
      allowedDetails: ["reason", "adapterId"],
    },
    CHALLENGE_PAGE_DETECTED: {
      level: "WARN",
      message: "检测到安全验证页面",
      suggestion: "请在当前标签页手动完成验证，正文恢复后再采集。",
      allowedDetails: ["indicator", "adapterId"],
    },
    CHAPTER_EXTRACTION_FAILED: {
      level: "ERROR",
      message: "章节解析失败",
      suggestion: "确认正文已经显示；若仍失败，请导出诊断报告。",
      allowedDetails: ["reason", "adapterId"],
    },
    CHAPTER_ADDED: {
      level: "INFO",
      message: "章节已加入当前批次",
      suggestion: "可以手动打开下一章并继续采集。",
      allowedDetails: ["chapterCount", "paragraphCount", "adapterId"],
    },
    CHAPTER_DUPLICATE_SKIPPED: {
      level: "WARN",
      message: "重复章节未再次加入",
      suggestion: "可以打开下一章继续采集。",
      allowedDetails: ["chapterCount", "adapterId"],
    },
    DIFFERENT_BOOK_REJECTED: {
      level: "WARN",
      message: "已阻止把不同书籍加入同一批次",
      suggestion: "先导出或清空当前批次，再采集另一部书。",
      allowedDetails: ["chapterCount", "adapterId"],
    },
    BATCH_SIZE_LIMIT_REACHED: {
      level: "ERROR",
      message: "当前批次已达到扩展的安全容量上限",
      suggestion: "先导出并清空当前批次，再继续采集。",
      allowedDetails: ["bytes", "limitBytes", "chapterCount"],
    },
    BATCH_CLEARED: {
      level: "INFO",
      message: "当前批次已清空",
      suggestion: "可以开始采集新的批次。",
      allowedDetails: ["chapterCount"],
    },
    NEXT_CHAPTER_OPENED: {
      level: "INFO",
      message: "已按页面链接打开下一章",
      suggestion: "正文显示后，再次点击采集当前章。",
      allowedDetails: ["adapterId"],
    },
    NEXT_CHAPTER_MISSING: {
      level: "WARN",
      message: "当前页面没有可用的下一章链接",
      suggestion: "确认是否已到最新章节，或手动打开目标章节。",
      allowedDetails: ["reason", "adapterId"],
    },
    AUTOMATION_STARTED: {
      level: "INFO",
      message: "自动采集已开始",
      suggestion: "保持目标标签页打开；需要时可从扩展弹窗停止。",
      allowedDetails: ["targetCount", "capturedCount", "format"],
    },
    AUTOMATION_PROGRESS: {
      level: "INFO",
      message: "自动采集已加入一章",
      suggestion: "无需处理。",
      allowedDetails: [
        "capturedCount",
        "targetCount",
        "chapterCount",
        "paragraphCount",
        "adapterId",
      ],
    },
    AUTOMATION_NAVIGATING: {
      level: "DEBUG",
      message: "自动采集正在打开下一章",
      suggestion: "无需处理。",
      allowedDetails: ["capturedCount", "targetCount", "adapterId", "delayMs"],
    },
    AUTOMATION_CHALLENGE_PAUSED: {
      level: "WARN",
      message: "自动采集因安全验证暂停",
      suggestion: "在目标标签页手动完成验证，再从扩展弹窗继续。",
      allowedDetails: ["capturedCount", "targetCount", "indicator"],
    },
    AUTOMATION_RESUMED: {
      level: "INFO",
      message: "自动采集已继续",
      suggestion: "保持目标标签页打开。",
      allowedDetails: ["capturedCount", "targetCount"],
    },
    AUTOMATION_STOPPED: {
      level: "INFO",
      message: "自动采集已停止",
      suggestion: "已采集章节仍保留在当前批次中，可手动导出。",
      allowedDetails: ["capturedCount", "targetCount", "reason"],
    },
    AUTOMATION_BATCH_LOCKED: {
      level: "WARN",
      message: "自动任务仍在使用当前批次",
      suggestion: "等待浏览器下载完成或失败后，再修改、导出或清空批次。",
      allowedDetails: ["reason"],
    },
    AUTOMATION_COMPLETED: {
      level: "INFO",
      message: "自动采集和导出已完成",
      suggestion: "可在浏览器下载记录中查看导出文件。",
      allowedDetails: [
        "capturedCount",
        "targetCount",
        "format",
        "downloadCount",
      ],
    },
    AUTOMATION_FAILED: {
      level: "ERROR",
      message: "自动采集未能继续",
      suggestion: "打开扩展查看状态；可保留已采章节并手动导出。",
      allowedDetails: ["capturedCount", "targetCount", "reason"],
    },
    EXPORT_STARTED: {
      level: "INFO",
      message: "开始生成章节导出文件",
      suggestion: "请保持扩展弹窗打开，直到浏览器接收下载。",
      allowedDetails: ["format", "chapterCount"],
    },
    EXPORT_SERIALIZED: {
      level: "DEBUG",
      message: "章节文件已完成序列化",
      suggestion: "无需处理。",
      allowedDetails: ["format", "chapterCount", "fileCount", "bytes"],
    },
    EXPORT_FAILED: {
      level: "ERROR",
      message: "批次导出失败",
      suggestion: "检查批次状态和诊断日志后重试。",
      allowedDetails: [
        "format",
        "chapterCount",
        "fileCount",
        "acceptedCount",
        "failedCount",
        "reason",
      ],
    },
    DOWNLOAD_REJECTED: {
      level: "ERROR",
      message: "浏览器拒绝开始章节文件下载",
      suggestion: "检查扩展下载权限和浏览器下载设置后重试。",
      allowedDetails: [
        "format",
        "chapterCount",
        "fileIndex",
        "fileCount",
        "acceptedCount",
        "reason",
      ],
    },
    DOWNLOAD_ACCEPTED: {
      level: "INFO",
      message: "浏览器已接收章节文件下载任务",
      suggestion: "等待浏览器完成下载。",
      allowedDetails: [
        "format",
        "chapterCount",
        "downloadId",
        "fileIndex",
        "fileCount",
      ],
    },
    DOWNLOAD_COMPLETED: {
      level: "INFO",
      message: "文件下载完成",
      suggestion: "无需处理。",
      allowedDetails: [
        "format",
        "chapterCount",
        "downloadId",
        "durationMs",
        "fileIndex",
        "fileCount",
      ],
    },
    DOWNLOAD_FAILED: {
      level: "ERROR",
      message: "文件下载失败或被取消",
      suggestion: "查看浏览器下载记录，确认原因后重新导出。",
      allowedDetails: [
        "format",
        "chapterCount",
        "downloadId",
        "reason",
        "fileIndex",
        "fileCount",
      ],
    },
    STORAGE_READ_FAILED: {
      level: "ERROR",
      message: "读取扩展本地数据失败",
      suggestion: "打开诊断页运行自检；必要时清空损坏的批次。",
      allowedDetails: ["reason"],
    },
    STORAGE_WRITE_FAILED: {
      level: "ERROR",
      message: "保存扩展本地数据失败",
      suggestion: "先导出已有批次，再检查浏览器存储空间。",
      allowedDetails: ["reason"],
    },
    STORAGE_LIMIT_APPROACHING: {
      level: "WARN",
      message: "扩展本地存储空间即将达到上限",
      suggestion: "建议尽快导出并清空当前批次。",
      allowedDetails: ["bytes", "limitBytes", "chapterCount"],
    },
    LOG_STORE_RECOVERED: {
      level: "WARN",
      message: "日志存储损坏，已自动重建",
      suggestion: "运行诊断自检；若反复出现，请重新加载扩展。",
      allowedDetails: ["reason"],
    },
    LOG_STORE_EMERGENCY_PRUNED: {
      level: "WARN",
      message: "日志存储空间不足，已执行紧急轮转",
      suggestion: "建议导出诊断报告后清理不再需要的扩展数据。",
      allowedDetails: ["reason", "removedEntries"],
    },
    STORAGE_ACCESS_LEVEL_WARNING: {
      level: "WARN",
      message: "日志存储访问隔离未能确认",
      suggestion: "更新 Chrome 或 Edge 后重新加载扩展，并再次运行自检。",
      allowedDetails: ["reason"],
    },
    DIAGNOSTICS_STARTED: {
      level: "DEBUG",
      message: "开始运行扩展自检",
      suggestion: "无需处理。",
      allowedDetails: [],
    },
    DIAGNOSTICS_COMPLETED: {
      level: "INFO",
      message: "扩展自检完成",
      suggestion: "如有失败项，请按诊断页面提示处理。",
      allowedDetails: ["checkPassed", "checkWarnings", "checkFailed"],
    },
    DIAGNOSTICS_FAILED: {
      level: "ERROR",
      message: "扩展自检未能完整运行",
      suggestion: "重新加载扩展后重试；若仍失败，请复制当前日志。",
      allowedDetails: ["reason"],
    },
    DIAGNOSTIC_REPORT_EXPORTED: {
      level: "INFO",
      message: "诊断报告已提交下载",
      suggestion: "需要排查问题时，可提供该脱敏报告。",
      allowedDetails: ["downloadId"],
    },
    DEBUG_SETTING_CHANGED: {
      level: "INFO",
      message: "调试日志设置已更新",
      suggestion: "排查结束后建议关闭调试日志。",
      allowedDetails: ["enabled"],
    },
  };

  Object.values(definitions).forEach((definition) => {
    Object.freeze(definition.allowedDetails);
    Object.freeze(definition);
  });

  function get(code) {
    return definitions[String(code || "")] || null;
  }

  root.QidianCrawlerEvents = Object.freeze({
    definitions: Object.freeze(definitions),
    get,
  });
})(globalThis);
