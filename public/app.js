const state = {
  cases: [],
  report: null,
  emrReview: null,
  schema: null,
  modelStatus: null,
  modelPresets: [],
  knowledgeGraph: null,
  dashboard: null,
  informatization: null,
};

const roleNames = {
  doctor: "医生端",
  nurse: "护士端",
  patient: "患者端",
  manager: "管理端",
  researcher: "科研端",
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || response.statusText);
  }
  return response.json();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function list(items, mapper) {
  if (!items || items.length === 0) return '<div class="empty">暂无输出。</div>';
  return `<ul class="list">${items.map(mapper).join("")}</ul>`;
}

function titleIconMeta(label) {
  const text = String(label || "");
  const rules = [
    [/高危|急症|风险提示|警|底线|缺口|禁忌|异常|质控/, "icon-alert", "coral"],
    [/风险|预测|分层|评分|Caprini|Padua/, "icon-risk", "coral"],
    [/时间|轨迹|窗口|流程|节点|路径|触发|进度/, "icon-timeline", "blue"],
    [/模型|调用|适配|算法|API|接口|对接|结构化/, "icon-cpu", "purple"],
    [/知识|证据|RAG|文献|教学|宣教|指南/, "icon-book", "gold"],
    [/病历|病例|导入|审查|核查|完整性|记录|HIS|电子病历/, "icon-record", "blue"],
    [/建议|任务|医生|护士|患者|管理|科研|执行|动作/, "icon-checklist", "green"],
    [/安全|防控|预防|审核|保护|出血/, "icon-shield", "green"],
    [/驾驶舱|队列|指标|统计|概览|建设|分级|能力/, "icon-peak", "teal"],
    [/来源|驱动|验证|发现|状态|运行/, "icon-spark", "teal"],
  ];
  const matched = rules.find(([pattern]) => pattern.test(text));
  return matched ? { icon: matched[1], tone: matched[2] } : { icon: "icon-vessel", tone: "teal" };
}

function titleIconHtml(label, size = "micro") {
  const meta = titleIconMeta(label);
  const iconClass = size === "panel" ? "panel-heading-icon" : "micro-card-icon";
  return '<span class="' + iconClass + " " + meta.tone + '" aria-hidden="true"><svg><use href="#' + meta.icon + '"></use></svg></span>';
}

function frameTitleHtml(label, size = "micro") {
  const lockupClass = size === "panel" ? "panel-heading-lockup" : "micro-card-heading";
  return '<div class="' + lockupClass + '">' + titleIconHtml(label, size) + "<strong>" + escapeHtml(label) + "</strong></div>";
}

function makeTitleIconElement(label, size = "panel") {
  const meta = titleIconMeta(label);
  const span = document.createElement("span");
  span.className = (size === "panel" ? "panel-heading-icon" : "micro-card-icon") + " " + meta.tone;
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = '<svg><use href="#' + meta.icon + '"></use></svg>';
  return span;
}

function enhanceFrameTitleIcons(root = document) {
  root.querySelectorAll(".panel-title > h2, .status-panel > h2").forEach((heading) => {
    if (heading.closest(".panel-heading-lockup")) return;
    const label = heading.textContent.trim();
    if (!label) return;
    const lockup = document.createElement("div");
    lockup.className = "panel-heading-lockup";
    lockup.appendChild(makeTitleIconElement(label, "panel"));
    heading.replaceWith(lockup);
    lockup.appendChild(heading);
  });

  root.querySelectorAll(".review-card > strong").forEach((heading) => {
    if (heading.closest(".micro-card-heading")) return;
    const label = heading.textContent.trim();
    if (!label) return;
    const lockup = document.createElement("div");
    lockup.className = "micro-card-heading";
    lockup.appendChild(makeTitleIconElement(label, "micro"));
    heading.replaceWith(lockup);
    lockup.appendChild(heading);
  });
}

function installFrameTitleIconObserver() {
  enhanceFrameTitleIcons();
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) enhanceFrameTitleIcons(node);
      });
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

async function initialize() {
  installFrameTitleIconObserver();
  bindTabs();
  bindActions();
  await checkHealth();
  await loadKnowledgeStats();
  await loadModelStatus();
  await loadModelPresets();
  await loadCases();
  await loadSchema();
  await loadKnowledgeGraph();
  await loadDashboardSummary();
  await loadInformatizationLevels();
  await runAnalysis();
  await runEmrReview();
  await askRag();
}

function bindTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      activateTab(tab.dataset.tab);
    });
  });
}

function activateTab(name) {
  document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item.dataset.tab === name));
  document.querySelectorAll(".tab-view").forEach((item) => item.classList.remove("active"));
  const view = document.querySelector(`#tab-${name}`);
  if (view) view.classList.add("active");
}

function bindActions() {
  document.querySelector("#runAnalysis").addEventListener("click", runAnalysis);
  document.querySelector("#askRag").addEventListener("click", askRag);
  document.querySelector("#clearCase").addEventListener("click", () => {
    document.querySelector("#caseInput").value = "";
    renderCaseSignals("");
    markAnalysisStale();
  });
  document.querySelector("#copyApi").addEventListener("click", copyApiExample);
  const runModelTest = document.querySelector("#runModelTest");
  if (runModelTest) runModelTest.addEventListener("click", testModelCall);
  const exportMarkdownReport = document.querySelector("#exportMarkdownReport");
  if (exportMarkdownReport) exportMarkdownReport.addEventListener("click", exportCurrentMarkdownReport);
  const modelPresetSelect = document.querySelector("#modelPresetSelect");
  if (modelPresetSelect) modelPresetSelect.addEventListener("change", renderSelectedModelPreset);
  const previewDocument = document.querySelector("#previewDocument");
  if (previewDocument) previewDocument.addEventListener("click", previewDocumentIngestion);
  const runCohortQuery = document.querySelector("#runCohortQuery");
  if (runCohortQuery) runCohortQuery.addEventListener("click", runCohortQuerySimulation);
  const loadHisSample = document.querySelector("#loadHisSample");
  if (loadHisSample) loadHisSample.addEventListener("click", loadHisSampleInput);
  const runHisEmrAnalysis = document.querySelector("#runHisEmrAnalysis");
  if (runHisEmrAnalysis) runHisEmrAnalysis.addEventListener("click", runHisEmrAnalysisSimulation);
  const simulateTriggerScenario = document.querySelector("#simulateTriggerScenario");
  if (simulateTriggerScenario) simulateTriggerScenario.addEventListener("click", renderTriggerSimulation);
  const selectBaselineCapabilities = document.querySelector("#selectBaselineCapabilities");
  if (selectBaselineCapabilities) selectBaselineCapabilities.addEventListener("click", selectBaselineCapabilitiesForAssessment);
  const runCapabilityAssessment = document.querySelector("#runCapabilityAssessment");
  if (runCapabilityAssessment) runCapabilityAssessment.addEventListener("click", renderCapabilityAssessment);
  document.querySelector("#ragQuestion").addEventListener("keydown", (event) => {
    if (event.key === "Enter") askRag();
  });
  document.querySelector("#caseInput").addEventListener("input", (event) => {
    renderCaseSignals(event.target.value);
    markAnalysisStale();
  });
}

async function checkHealth() {
  const el = document.querySelector("#healthStatus");
  try {
    const health = await api("/api/health");
    el.textContent = health.status === "ok" ? "已连接" : "异常";
  } catch (error) {
    el.textContent = "未连接";
  }
}

async function loadKnowledgeStats() {
  const el = document.querySelector("#knowledgeStatus");
  try {
    const stats = await api("/api/knowledge/stats");
    el.textContent = `${stats.total} 条`;
    el.title = `摘要 ${stats.withAbstract} 条，本地 PDF ${stats.withPdf} 条`;
  } catch (error) {
    el.textContent = "未加载";
  }
}

async function loadModelStatus() {
  const statusEl = document.querySelector("#modelStatus");
  const badgeEl = document.querySelector("#modelBadge");
  const infoEl = document.querySelector("#modelInfo");
  try {
    const status = await api("/api/model/status");
    state.modelStatus = status;
    statusEl.textContent = status.enabled ? `${status.provider}` : "关闭";
    if (badgeEl) {
      badgeEl.textContent = status.enabled ? (status.callable ? "可调用" : "待配置") : "关闭";
      badgeEl.className = `badge ${status.enabled && status.callable ? "low" : "muted"}`;
    }
    if (infoEl) {
      infoEl.innerHTML = `
        <article class="review-card ${status.enabled && status.callable ? "ok" : "warn"}">
          <strong>${escapeHtml(status.enabled ? "模型调用层已预留" : "模型调用层当前关闭")}</strong>
          <span>${escapeHtml(status.mode || status.provider)} → ${escapeHtml(status.provider)}${status.adapter ? `｜${escapeHtml(status.adapter)}` : ""}${status.model ? `｜${escapeHtml(status.model)}` : ""}</span>
          <p>${escapeHtml(status.note)}</p>
        </article>
        <article class="review-card warn">
          <strong>数据边界</strong>
          <p>${escapeHtml((status.dataPolicy && status.dataPolicy.note) || "外部模型不得输入真实患者隐私数据。")}</p>
        </article>
      `;
    }
    renderModelDiscovery(status);
  } catch (error) {
    statusEl.textContent = "未加载";
  }
}

function renderModelDiscovery(status) {
  const box = document.querySelector("#modelDiscovery");
  if (!box) return;
  const adapters = status.adapters || [];
  if (adapters.length === 0) {
    box.innerHTML = '<div class="empty">暂无本地模型探测结果。</div>';
    return;
  }
  box.innerHTML = adapters
    .map((adapter) => {
      const cls = adapter.callable ? "ok" : adapter.detected ? "warn" : "";
      const stateText = adapter.callable ? "可调用" : adapter.detected ? "已发现服务" : "未发现";
      const models = adapter.models && adapter.models.length ? adapter.models.slice(0, 4).join("、") : adapter.error || "无模型列表";
      return `
        <article class="review-card ${cls}">
          <strong>${escapeHtml(adapter.name)}</strong>
          <span>${escapeHtml(stateText)}｜${escapeHtml(adapter.baseUrl)}</span>
          <p>${escapeHtml(models)}</p>
        </article>
      `;
    })
    .join("");
}

async function loadModelPresets() {
  const select = document.querySelector("#modelPresetSelect");
  if (!select) return;
  try {
    const result = await api("/api/model/presets");
    state.modelPresets = result.presets || [];
    select.innerHTML = state.modelPresets
      .map((preset) => `<option value="${escapeHtml(preset.id)}">${escapeHtml(preset.label)}</option>`)
      .join("");
    select.value = "rules_rag";
    renderSelectedModelPreset();
  } catch (error) {
    state.modelPresets = [];
    renderSelectedModelPreset();
  }
}

function selectedModelPreset() {
  const id = document.querySelector("#modelPresetSelect") ? document.querySelector("#modelPresetSelect").value : "rules_rag";
  return state.modelPresets.find((preset) => preset.id === id) || { id: "rules_rag", label: "仅规则/RAG", provider: "off", description: "当前不调用大模型。" };
}

function renderSelectedModelPreset() {
  const preset = selectedModelPreset();
  const badge = document.querySelector("#selectedModelBadge");
  const hint = document.querySelector("#modelPresetHint");
  const apiKey = document.querySelector("#modelApiKey");
  if (badge) {
    badge.textContent = preset.label;
    badge.className = `badge ${preset.provider === "off" ? "muted" : preset.provider === "openai_compatible" ? "medium" : "low"}`;
  }
  if (hint) {
    const keyHint = preset.requiresApiKey ? "需要 API key；密钥仅随本次请求发送到本机后端，不写入文件。" : "不需要外部 API key。";
    hint.textContent = `${preset.description || ""} ${keyHint}`;
  }
  if (apiKey) {
    apiKey.disabled = !preset.requiresApiKey;
    apiKey.placeholder = preset.requiresApiKey ? "OpenAI API key（不保存）" : "当前模式不需要";
  }
}

async function loadCases() {
  const data = await api("/api/demo-cases");
  state.cases = data.cases;
  const box = document.querySelector("#caseButtons");
  box.innerHTML = state.cases
    .map(
      (item) => `
        <button class="case-chip" type="button" data-case="${escapeHtml(item.id)}">
          <strong>${escapeHtml(item.title)}</strong>
          <span>${escapeHtml(item.summary)}</span>
        </button>
      `,
    )
    .join("");
  box.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      const demo = state.cases.find((item) => item.id === button.dataset.case);
      document.querySelector("#caseInput").value = demo.text;
      renderCaseSignals(demo.text);
      runAnalysis();
    });
  });
  if (state.cases[0]) document.querySelector("#caseInput").value = state.cases[0].text;
  renderCaseSignals(document.querySelector("#caseInput").value);
}

function inferCaseSignals(text) {
  const normalized = text || "";
  const signals = [];
  const add = (label, tone, matched) => {
    if (matched) signals.push({ label, tone });
  };
  const ageMatch = normalized.match(/(?:年龄|age)[:：\s]*(\d{1,3})|(\d{1,3})\s*岁/i);
  const age = ageMatch ? Number(ageMatch[1] || ageMatch[2]) : null;
  const bmiMatch = normalized.match(/(?:BMI|体重指数)\s*[:：]?\s*(\d{1,2}(?:\.\d+)?)/i);
  const bmi = bmiMatch ? Number(bmiMatch[1]) : null;
  add("高龄相关风险", "medium", (age && age >= 60) || /高龄|年龄大/.test(normalized));
  add("妊娠相关风险", "medium", /怀孕|妊娠|孕周|产后|产褥/.test(normalized));
  add("疑似 PE 急症", "danger", /呼吸困难|胸痛|咯血|低氧|氧饱和度下降|肺栓塞|肺动脉栓塞|\bPE\b/i.test(normalized));
  add("症状性下肢 DVT", "danger", /下肢肿痛|下肢胀痛|左下肢|右下肢|小腿肿痛|肢体肿胀/.test(normalized));
  add("肢体灌注受威胁", "danger", /足背动脉消失|动脉搏动消失|皮温降低|张力明显升高|肢体发凉|股青肿/.test(normalized));
  add("截瘫/长期制动", "medium", /截瘫|偏瘫|瘫痪|脊髓损伤|长期卧床|长期制动|卧床\s*\d+\s*(?:月|年)|制动\s*\d+\s*(?:月|年)/.test(normalized));
  add("围术期/手术场景", "medium", /术前|拟行|手术|术后|围术期|麻醉/.test(normalized));
  add("卧床/活动减少", "medium", /卧床|活动减少|活动受限|制动/.test(normalized));
  add("肥胖/BMI 风险", "medium", (bmi && bmi >= 25) || /肥胖/.test(normalized));
  add("D-二聚体升高", "medium", /D-二聚体升高|D二聚体升高/.test(normalized));
  add("出血风险/禁忌", "danger", /(?<!无)活动性出血|消化道出血|血小板降低|血小板 48|肌酐升高|肾功能异常/.test(normalized));
  if (!signals.length && normalized.trim()) signals.push({ label: "待结构化识别", tone: "muted" });
  return signals;
}

function renderCaseSignals(text) {
  const box = document.querySelector("#caseSignals");
  if (!box) return;
  const signals = inferCaseSignals(text);
  box.innerHTML = signals.length
    ? signals.map((signal) => `<span class="signal ${escapeHtml(signal.tone)}">${escapeHtml(signal.label)}</span>`).join("")
    : '<span class="signal muted">暂无病例文本</span>';
}

function markAnalysisStale() {
  if (!state.report) return;
  const badge = document.querySelector("#analysisModeBadge");
  const conclusionBox = document.querySelector("#clinicalConclusionBox");
  if (badge) {
    badge.textContent = "病例已修改，需重新分析";
    badge.className = "badge medium";
  }
  if (conclusionBox && !conclusionBox.querySelector(".stale-note")) {
    conclusionBox.insertAdjacentHTML("afterbegin", '<p class="stale-note">病例文本已修改，请点击“运行 VTE 智能体分析”刷新结论和知识图谱。</p>');
  }
}

async function loadSchema() {
  state.schema = await api("/api/connector-schema");
  document.querySelector("#schemaBox").textContent = JSON.stringify(state.schema, null, 2);
}

async function runAnalysis() {
  const options = typeof arguments[0] === "object" && arguments[0] ? arguments[0] : {};
  const text = document.querySelector("#caseInput").value.trim();
  if (!text) {
    alert("请输入模拟病例或脱敏病例摘要。");
    return;
  }
  renderCaseSignals(text);
  activateTab("analysis");
  document.querySelector("#analysisModeBadge").textContent = "分析中";
  const conclusionBox = document.querySelector("#clinicalConclusionBox");
  conclusionBox.className = "empty compact";
  conclusionBox.innerHTML = "正在生成综合结论...";
  const report = await api("/api/analyze", {
    method: "POST",
    body: JSON.stringify({
      text,
      useModel: options.forceLocalOnly ? false : selectedModelPreset().provider !== "off",
      modelPreset: selectedModelPreset().id,
      apiKey: document.querySelector("#modelApiKey") ? document.querySelector("#modelApiKey").value.trim() : "",
      containsRealPatientData: false,
    }),
  });
  state.report = report;
  renderReport(report);
  await runEmrReview();
  const graph = await updateCaseKnowledgeGraph(text);
  updateCaseAwareRagQuery(text, report, graph);
  await askRag();
  document.querySelector("#tab-analysis").scrollIntoView({ block: "start" });
}

async function runEmrReview() {
  const text = document.querySelector("#caseInput").value.trim();
  if (!text) return;
  const review = await api("/api/emr/review", {
    method: "POST",
    body: JSON.stringify({ text }),
  });
  state.emrReview = review;
  renderEmrReview(review);
  renderCaseEvidenceChain(review);
  return review;
}

function downloadTextFile(fileName, content, mimeType) {
  const blob = new Blob([content], { type: mimeType || "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function exportCurrentMarkdownReport() {
  const text = document.querySelector("#caseInput").value.trim();
  if (!text) {
    alert("请先输入病例。");
    return;
  }
  const button = document.querySelector("#exportMarkdownReport");
  const originalText = button ? button.textContent : "";
  if (button) {
    button.disabled = true;
    button.textContent = "正在导出";
  }
  try {
    const preset = selectedModelPreset();
    const apiKey = document.querySelector("#modelApiKey") ? document.querySelector("#modelApiKey").value.trim() : "";
    const result = await api("/api/report/markdown", {
      method: "POST",
      body: JSON.stringify({
        text,
        modelPreset: preset.id,
        useModel: preset.provider !== "off",
        apiKey,
        containsRealPatientData: false,
      }),
    });
    downloadTextFile(result.fileName || "VTE智能体单病例分析报告.md", result.markdown || "", result.mimeType || "text/markdown;charset=utf-8");
  } catch (error) {
    alert(`报告导出失败：${error.message}`);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText || "导出 Markdown";
    }
  }
}

function renderReport(report) {
  const prediction = report.decisionSupport && report.decisionSupport.riskPrediction;
  document.querySelector("#riskLevel").textContent = report.riskLevel;
  document.querySelector("#riskPeak").textContent = prediction ? `${prediction.peakProbability}%` : "-";
  document.querySelector("#riskWindow").textContent = prediction ? prediction.peakWindow : "-";
  document.querySelector("#riskCount").textContent = `${report.riskFactors.length} 项`;
  document.querySelector("#urgentCount").textContent = `${(report.urgentFlags || []).length} 项`;
  document.querySelector("#bleedingCount").textContent = `${report.bleedingFlags.length} 项`;
  document.querySelector("#reviewCount").textContent = `${report.reviewItems.length} 项`;
  renderClinicalConclusion(report);
  renderDecisionSupport(report.decisionSupport);

  const badge = document.querySelector("#riskBadge");
  badge.textContent = report.riskLevel;
  badge.className = `badge ${report.riskLevel === "低危" ? "low" : report.riskLevel === "中危" ? "medium" : ""}`;

  document.querySelector("#riskBox").innerHTML = list(report.riskFactors, (item) => {
    return `<li><strong>${escapeHtml(item.label)}</strong><span class="note">权重 ${item.weight}；匹配：${escapeHtml(item.matchedTerms.join("、") || "规则推断")}</span></li>`;
  });

  document.querySelector("#recommendationBox").innerHTML = list(report.recommendations, (item) => {
    return `<li><strong>${escapeHtml(item.title)}</strong><span class="note">${escapeHtml(item.detail)}｜确认：${escapeHtml(item.confirmation)}</span></li>`;
  });

  renderRoles(report.roleTasks);
  renderEvidence(report.evidence);
  renderAudit(report.audit);
}

function renderDecisionSupport(decisionSupport) {
  if (!decisionSupport) return;
  renderRiskPrediction(decisionSupport.riskPrediction);
  const scaleBox = document.querySelector("#scaleBox");
  const reminderBox = document.querySelector("#reminderBox");
  const qualityBox = document.querySelector("#qualityIndicatorBox");
  const educationBox = document.querySelector("#patientEducationBox");

  if (scaleBox) {
    scaleBox.innerHTML = (decisionSupport.scaleScores || [])
      .map(
        (scale) => `
          <article class="score-card">
            <header>
              <strong>${escapeHtml(scale.name)}</strong>
              <span class="badge ${scale.band && scale.band.includes("高") ? "" : scale.band && scale.band.includes("需") ? "medium" : "low"}">${escapeHtml(scale.band)}</span>
            </header>
            <div class="score-value">${escapeHtml(scale.score)}</div>
            ${list(scale.items || [], (item) => `<li>${escapeHtml(item.label)}<span class="note"> ${escapeHtml(item.points)}分</span></li>`)}
            <p class="note">${escapeHtml(scale.note)}</p>
          </article>
        `,
      )
      .join("");
  }

  if (reminderBox) {
    renderReviewItems("#reminderBox", decisionSupport.workflowReminders || [], (item) => `
      <article class="review-card ${item.priority === "急症" ? "danger" : item.priority === "重点" ? "warn" : "ok"}">
        <strong>${escapeHtml(item.node)}</strong>
        <span>${escapeHtml(item.status)}｜${escapeHtml(item.priority)}</span>
        <p>${escapeHtml(item.detail)}</p>
      </article>
    `);
  }

  if (qualityBox) {
    renderReviewItems("#qualityIndicatorBox", decisionSupport.qualityIndicators || [], (item) => `
      <article class="review-card ${item.level === "重点" ? "warn" : "ok"}">
        <strong>${escapeHtml(item.name)}</strong>
        <span>${escapeHtml(item.status)}｜${escapeHtml(item.level)}</span>
        <p>${escapeHtml(item.detail)}</p>
      </article>
    `);
  }

  if (educationBox) {
    renderReviewItems("#patientEducationBox", decisionSupport.patientEducation || [], (item) => `
      <article class="review-card ok">
        <strong>${escapeHtml(item.title)}</strong>
        <p>${escapeHtml(item.detail)}</p>
      </article>
    `);
  }
}

function predictionTone(probability) {
  if (probability >= 65) return "danger";
  if (probability >= 40) return "warn";
  if (probability >= 20) return "medium";
  return "ok";
}

function predictionBadgeClass(probability) {
  const tone = predictionTone(probability);
  if (tone === "danger") return "";
  if (tone === "ok") return "low";
  return "medium";
}

function renderRiskPrediction(prediction) {
  const box = document.querySelector("#predictionBox");
  const badge = document.querySelector("#predictionBadge");
  if (!box) return;
  if (!prediction) {
    box.innerHTML = '<div class="empty compact">暂无风险预测轨迹。</div>';
    return;
  }
  const points = prediction.trajectory || [];
  const width = 760;
  const height = 220;
  const padding = { left: 42, right: 22, top: 18, bottom: 38 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const maxProbability = Math.max(80, ...points.map((point) => point.probability || 0));
  const coordinates = points.map((point, index) => {
    const x = padding.left + (points.length <= 1 ? 0 : (index / (points.length - 1)) * innerWidth);
    const y = padding.top + innerHeight - ((point.probability || 0) / maxProbability) * innerHeight;
    return { ...point, x, y };
  });
  const polyline = coordinates.map((point) => `${point.x},${point.y}`).join(" ");
  const area = coordinates.length
    ? `${padding.left},${padding.top + innerHeight} ${polyline} ${padding.left + innerWidth},${padding.top + innerHeight}`
    : "";
  const gridLines = [0, 25, 50, 75, 100].filter((value) => value <= maxProbability).map((value) => {
    const y = padding.top + innerHeight - (value / maxProbability) * innerHeight;
    return `<g class="prediction-gridline"><line x1="${padding.left}" y1="${y}" x2="${padding.left + innerWidth}" y2="${y}"></line><text x="8" y="${y + 4}">${value}%</text></g>`;
  });

  if (badge) {
    badge.textContent = `峰值 ${prediction.peakProbability}%｜${prediction.peakWindow}`;
    badge.className = `badge ${predictionBadgeClass(prediction.peakProbability)}`;
  }

  box.innerHTML = `
    <div class="prediction-chart-card">
      <svg class="prediction-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="VTE 风险预测轨迹">
        ${gridLines.join("")}
        <polygon class="prediction-area" points="${area}"></polygon>
        <polyline class="prediction-line" points="${polyline}"></polyline>
        ${coordinates
          .map(
            (point) => `
              <g class="prediction-point ${predictionTone(point.probability)}" transform="translate(${point.x},${point.y})">
                <title>${escapeHtml(point.label)}：${escapeHtml(point.probability)}%，${escapeHtml(point.phase || "")}</title>
                <circle r="6"></circle>
                <text y="-12">${escapeHtml(point.probability)}%</text>
                <text y="30">${escapeHtml(point.label)}</text>
              </g>
            `,
          )
          .join("")}
      </svg>
    </div>
    <div class="prediction-summary">
      <article>
        <span>当前风险</span>
        <strong>${escapeHtml(prediction.currentProbability)}%</strong>
      </article>
      <article>
        <span>峰值窗口</span>
        <strong>${escapeHtml(prediction.peakWindow)}</strong>
      </article>
      <article>
        <span>峰值概率</span>
        <strong>${escapeHtml(prediction.peakProbability)}%</strong>
      </article>
    </div>
    <div class="prediction-side">
      <article class="review-card warn">
        <div class="micro-card-heading">
          <span class="micro-card-icon teal"><svg><use href="#icon-cpu"></use></svg></span>
          <strong>模型来源</strong>
        </div>
        <p>${escapeHtml(prediction.modelSource)}</p>
      </article>
      <article class="review-card ok">
        <div class="micro-card-heading">
          <span class="micro-card-icon coral"><svg><use href="#icon-spark"></use></svg></span>
          <strong>主要驱动因素</strong>
        </div>
        ${list(prediction.topContributors || [], (item) => `<li>${escapeHtml(item)}</li>`)}
      </article>
      <article class="review-card warn">
        <div class="micro-card-heading">
          <span class="micro-card-icon blue"><svg><use href="#icon-timeline"></use></svg></span>
          <strong>病例时间锚点</strong>
        </div>
        ${list(prediction.clinicalAnchors || [], (item) => `<li>${escapeHtml(item)}</li>`)}
      </article>
      <article class="review-card ok">
        <div class="micro-card-heading">
          <span class="micro-card-icon gold"><svg><use href="#icon-route"></use></svg></span>
          <strong>后续验证路径</strong>
        </div>
        ${list(prediction.validationPlan || [], (item) => `<li>${escapeHtml(item)}</li>`)}
      </article>
    </div>
    <p class="prediction-boundary">${escapeHtml(prediction.suggestedUse)} 当前目标事件：${escapeHtml(prediction.targetEvent)}。</p>
  `;
}

function renderClinicalConclusion(report) {
  const reasoning = report.clinicalReasoning || {};
  const focus = reasoning.practicalFocus || {};
  const management = reasoning.caseManagementAnalysis || {};
  const modeBadge = document.querySelector("#analysisModeBadge");
  modeBadge.textContent = reasoning.analysisMode || (report.meta && report.meta.modelUse) || "本地分析";
  modeBadge.className = "badge medium";
  const conclusionBox = document.querySelector("#clinicalConclusionBox");
  conclusionBox.className = "conclusion-box";
  conclusionBox.innerHTML = `
    <div class="conclusion">
      <h3>${escapeHtml(reasoning.title || `${report.riskLevel} VTE 风险提示`)}</h3>
      <p>${escapeHtml(reasoning.keyConclusion || "已完成病例分析。")}</p>
      <article class="review-card warn">
        ${frameTitleHtml("当前病例核心问题")}
        <p>${escapeHtml(focus.currentProblem || "需结合完整病历确认当前真正问题。")}</p>
      </article>
      <div class="conclusion-grid">
        <section>
          <h4>已知病例事实</h4>
          ${list(focus.knownFacts || [], (item) => `<li>${escapeHtml(item)}</li>`)}
        </section>
        <section>
          <h4>立即优先处理</h4>
          ${list(focus.immediatePriorities || [], (item) => `<li>${escapeHtml(item)}</li>`)}
        </section>
      </div>
      <section>
        <h4>当前最需要补齐的证据</h4>
        ${list(focus.missingEvidence || [], (item) => `<li>${escapeHtml(item)}</li>`)}
      </section>
      <div class="conclusion-grid">
        <section>
          <h4>我存在的不足</h4>
          ${list(management.shortcomings || [], (item) => `<li>${escapeHtml(item)}</li>`)}
        </section>
        <section>
          <h4>我面临的风险</h4>
          ${list(management.risks || [], (item) => `<li>${escapeHtml(item)}</li>`)}
        </section>
      </div>
      <section>
        <h4>我该如何应对</h4>
        ${list(management.responses || [], (item) => `<li>${escapeHtml(item)}</li>`)}
      </section>
      <div class="conclusion-grid">
        <section>
          <h4>主要依据</h4>
          ${list(reasoning.rationale || [], (item) => `<li>${escapeHtml(item)}</li>`)}
        </section>
        <section>
          <h4>下一步建议</h4>
          ${list((reasoning.immediateActions || []).slice(0, 4), (item) => `<li>${escapeHtml(item)}</li>`)}
        </section>
      </div>
      <div class="conclusion-grid">
        <section>
          <h4>需复核事项</h4>
          ${list(reasoning.missingOrReview || report.reviewItems || [], (item) => `<li>${escapeHtml(item)}</li>`)}
        </section>
        <section>
          <h4>安全边界</h4>
          ${list(reasoning.safetyChecks || [], (item) => `<li>${escapeHtml(item)}</li>`)}
        </section>
      </div>
      <p class="note">置信说明：${escapeHtml(reasoning.confidence || "需结合完整病历和医生确认。")}</p>
      <p class="note">模型状态：${escapeHtml((report.meta && report.meta.modelUse) || "未记录")}</p>
      ${
        report.modelEnhancedAnalysis && report.modelEnhancedAnalysis.text
          ? `<article class="model-analysis"><h4>大模型增强分析</h4><p>${escapeHtml(report.modelEnhancedAnalysis.text)}</p><p class="note">${escapeHtml(report.modelEnhancedAnalysis.boundary)}</p></article>`
          : ""
      }
    </div>
  `;
}

function renderRoles(roleTasks) {
  document.querySelector("#roleGrid").innerHTML = Object.entries(roleTasks)
    .map(
      ([key, tasks]) => `
        <article class="role-card">
          <h3>${escapeHtml(roleNames[key] || key)}</h3>
          <ul>${tasks.map((task) => `<li>${escapeHtml(task)}</li>`).join("")}</ul>
        </article>
      `,
    )
    .join("");
}

function renderEvidence(items) {
  document.querySelector("#evidenceBox").innerHTML = items
    .map(
      (item) => `
        <article class="evidence-card">
          <header>
            <h3>${escapeHtml(item.title)}</h3>
            <span class="source">${escapeHtml(item.evidenceTier || item.type)}｜${escapeHtml(item.year || "")}</span>
          </header>
          <p>${escapeHtml(item.content)}</p>
          <p class="note">来源：${escapeHtml(item.source)}｜相关性 ${escapeHtml(item.relevanceScore || 0)}｜权威性 ${escapeHtml(item.authorityScore || 0)}</p>
          <p class="note">全文：${escapeHtml(item.fulltextStatus || "未标注")}${item.localFulltextPath ? `｜本地路径：${escapeHtml(item.localFulltextPath)}` : ""}</p>
        </article>
      `,
    )
    .join("");
}

function renderAudit(audit) {
  document.querySelector("#auditId").textContent = audit.auditId.slice(0, 8);
  document.querySelector("#auditList").innerHTML = audit.events
    .map((event) => `<li><time>${new Date(event.time).toLocaleString("zh-CN")}</time>${escapeHtml(event.message)}</li>`)
    .join("");
}

function renderReviewItems(selector, items, mapper) {
  const box = document.querySelector(selector);
  if (!items || items.length === 0) {
    box.innerHTML = '<div class="empty">暂无需展示内容。</div>';
    return;
  }
  box.innerHTML = items.map(mapper).join("");
}

function statusClass(value) {
  if (value === "pass" || value === "已识别") return "ok";
  if (value === "重点复核" || value === "重点完善") return "danger";
  return "warn";
}

function renderEmrReview(review) {
  renderReviewItems("#processCheckBox", review.processChecks, (item) => `
    <article class="review-card ${statusClass(item.status)}">
      <strong>${escapeHtml(item.item)}</strong>
      <span>${escapeHtml(item.severity)}</span>
      <p>${escapeHtml(item.suggestion)}</p>
      ${item.defensePoint ? `<p class="note">院方说明点：${escapeHtml(item.defensePoint)}</p>` : ""}
      ${item.action ? `<p class="note">补强动作：${escapeHtml(item.action)}</p>` : ""}
    </article>
  `);

  renderReviewItems("#riskHintBox", review.qualityAndLegalRiskHints, (item) => `
    <article class="review-card ${statusClass(item.level)}">
      <strong>${escapeHtml(item.title)}</strong>
      <span>${escapeHtml(item.level)}</span>
      <p>${escapeHtml(item.detail)}</p>
    </article>
  `);

  renderReviewItems("#timelineBox", review.clinicalTimeline, (item) => `
    <article class="review-card ${statusClass(item.status)}">
      <strong>${escapeHtml(item.event)}</strong>
      <span>${escapeHtml(item.status)}</span>
      <p>${escapeHtml(item.focus)}</p>
    </article>
  `);

  renderReviewItems("#gapBox", review.documentationGaps.concat(review.improvementPlan.map((detail) => ({ title: "改进建议", detail, priority: "建议" }))), (item) => `
    <article class="review-card ${statusClass(item.priority)}">
      <strong>${escapeHtml(item.title)}</strong>
      <span>${escapeHtml(item.priority)}</span>
      <p>${escapeHtml(item.detail)}</p>
    </article>
  `);

  const defense = review.hospitalPositionReview || {};
  const defenseItems = [
    ...((defense.strengths || []).map((item) => ({ ...item, group: "可说明事实" }))),
    ...((defense.vulnerabilities || []).map((item) => ({ ...item, group: "薄弱点" }))),
    ...((defense.explanationLines || []).map((detail) => ({ title: "说明口径", level: "边界", detail }))),
  ];
  renderReviewItems("#hospitalDefenseBox", defenseItems, (item) => `
    <article class="review-card ${item.group === "薄弱点" ? "danger" : item.group === "可说明事实" ? "ok" : "warn"}">
      <strong>${escapeHtml(item.title)}</strong>
      <span>${escapeHtml(item.group || item.level || "")}</span>
      <p>${escapeHtml(item.detail)}</p>
    </article>
  `);

  const activePlan = review.activeCaseImprovementPlan || {};
  renderReviewItems("#activeImprovementBox", activePlan.actions || [], (item) => `
    <article class="review-card ${statusClass(item.priority)}">
      <strong>${escapeHtml(item.title)}</strong>
      <span>${escapeHtml(activePlan.status || "当前状态未明")}｜${escapeHtml(item.priority)}</span>
      <p>${escapeHtml(item.detail)}</p>
    </article>
  `);

  renderReviewItems("#teachingBox", review.teachingPoints, (item) => `
    <article class="review-card ok">
      <strong>教学提示</strong>
      <p>${escapeHtml(item)}</p>
    </article>
  `);
}

function renderCaseEvidenceChain(review) {
  if (!review) return;
  const defense = review.hospitalPositionReview || {};
  const activePlan = review.activeCaseImprovementPlan || {};
  const strengths = (defense.strengths || []).slice(0, 3);
  const weakPoints = (defense.vulnerabilities || []).slice(0, 3);
  const actions = (activePlan.actions || []).slice(0, 4);

  renderReviewItems("#analysisDefenseBox", [
    ...strengths.map((item) => ({ ...item, group: "可说明事实" })),
    ...weakPoints.map((item) => ({ ...item, group: "薄弱点" })),
  ], (item) => `
    <article class="review-card ${item.group === "薄弱点" ? "danger" : "ok"}">
      <strong>${escapeHtml(item.title)}</strong>
      <span>${escapeHtml(item.group || item.level || "")}</span>
      <p>${escapeHtml(item.detail)}</p>
    </article>
  `);

  renderReviewItems("#pathwayImprovementBox", actions, (item) => `
    <article class="review-card ${statusClass(item.priority)}">
      <strong>${escapeHtml(item.title)}</strong>
      <span>${escapeHtml(activePlan.status || "当前状态未明")}｜${escapeHtml(item.priority)}</span>
      <p>${escapeHtml(item.detail)}</p>
    </article>
  `);

  renderReviewItems("#ragCaseContextBox", [
    {
      title: "本病例检索上下文",
      level: "病例证据链",
      detail: [
        ...(weakPoints.length ? ["病历薄弱点：" + weakPoints.map((item) => item.title).join("、")] : []),
        ...(actions.length ? ["当前补强重点：" + actions.map((item) => item.title).join("、")] : []),
        ...(defense.explanationLines && defense.explanationLines[0] ? [defense.explanationLines[0]] : []),
      ].join(" "),
    },
  ], (item) => `
    <article class="review-card warn">
      <strong>${escapeHtml(item.title)}</strong>
      <span>${escapeHtml(item.level)}</span>
      <p>${escapeHtml(item.detail || "暂无病例证据链上下文。")}</p>
    </article>
  `);
}

async function askRag() {
  const baseQuery = document.querySelector("#ragQuestion").value.trim();
  const review = state.emrReview || {};
  const weakPoints = (((review.hospitalPositionReview || {}).vulnerabilities) || []).slice(0, 3).map((item) => item.title).join("、");
  const actions = (((review.activeCaseImprovementPlan || {}).actions) || []).slice(0, 3).map((item) => item.title).join("、");
  const query = [baseQuery, weakPoints ? "病历薄弱点：" + weakPoints : "", actions ? "当前补强重点：" + actions : ""].filter(Boolean).join("；");
  const result = await api("/api/rag/query", {
    method: "POST",
    body: JSON.stringify({ query, limit: 5 }),
  });
  document.querySelector("#ragAnswer").innerHTML = `
    <article class="evidence-card">
      <header><h3>生成回答</h3><span class="source">RAG</span></header>
      <p>${escapeHtml(result.answer)}</p>
      <p class="note">${escapeHtml(result.boundary)}</p>
    </article>
    ${result.evidence
      .map(
        (item) => `
          <article class="evidence-card">
            <header><h3>${escapeHtml(item.title)}</h3><span class="source">${escapeHtml(item.evidenceTier || item.type)}｜${escapeHtml(item.year || "")}</span></header>
            <p>${escapeHtml(item.content)}</p>
            <p class="note">来源：${escapeHtml(item.source)}｜相关性 ${escapeHtml(item.relevanceScore || 0)}｜权威性 ${escapeHtml(item.authorityScore || 0)}</p>
            <p class="note">全文：${escapeHtml(item.fulltextStatus || "未标注")}${item.localFulltextPath ? `｜本地路径：${escapeHtml(item.localFulltextPath)}` : ""}</p>
          </article>
        `,
      )
      .join("")}
  `;
}

async function loadKnowledgeGraph() {
  try {
    const graph = await api("/api/knowledge/graph");
    state.knowledgeGraph = graph;
    renderKnowledgeGraph(graph);
  } catch (error) {
    const badge = document.querySelector("#graphBadge");
    if (badge) badge.textContent = "未加载";
  }
}

async function readLightweightFile(file) {
  if (!file) return "";
  const textLike =
    file.type.startsWith("text/") ||
    /\.(txt|md|csv|json)$/i.test(file.name || "");
  if (!textLike || file.size > 600_000) return "";
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "").slice(0, 12000));
    reader.onerror = () => resolve("");
    reader.readAsText(file);
  });
}

async function readFileBase64(file) {
  if (!file || file.size > 28_000_000) return "";
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || "");
      resolve(value.includes(",") ? value.split(",").pop() : value);
    };
    reader.onerror = () => resolve("");
    reader.readAsDataURL(file);
  });
}

function documentTypeFromFile(file) {
  const name = (file && file.name ? file.name : "").toLowerCase();
  if (/\.pdf$/.test(name)) return "pdf";
  if (/\.docx?$/.test(name)) return "word";
  if (/\.(png|jpg|jpeg|webp|tif|tiff)$/.test(name)) return "image";
  if (/\.(txt|md|csv|json)$/.test(name)) return "text";
  return "unknown";
}

async function previewDocumentIngestion() {
  const fileInput = document.querySelector("#documentFile");
  const box = document.querySelector("#documentPreviewBox");
  const file = fileInput && fileInput.files && fileInput.files[0];
  if (!box) return;
  if (!file) {
    box.innerHTML = '<div class="empty compact">请选择一个脱敏 PDF、Word、图片或文本文件。</div>';
    return;
  }
  box.innerHTML = '<div class="empty compact">正在生成导入预检...</div>';
  const extractedText = await readLightweightFile(file);
  const documentType = documentTypeFromFile(file);
  const shouldUploadBinary =
    (documentType === "word" && /\.docx$/i.test(file.name || "")) ||
    documentType === "pdf" ||
    documentType === "image";
  const fileBase64 = shouldUploadBinary ? await readFileBase64(file) : "";
  if (shouldUploadBinary && !fileBase64) {
    box.innerHTML = `<article class="review-card danger">${frameTitleHtml("文件过大，未进入分析")}<p>${escapeHtml("当前演示支持 28MB 以内的 PDF、Word 或图片文件。请压缩/拆分后再导入，或复制脱敏病例摘要到左侧病例输入。")}</p></article>`;
    return;
  }
  const result = await api("/api/document/ingest-preview", {
    method: "POST",
    body: JSON.stringify({
      fileName: file.name,
      mimeType: file.type,
      size: file.size,
      documentType,
      extractedText,
      fileBase64,
    }),
  });
  renderDocumentPreview(result);
  if (result.extractedText) {
    await applyImportedCaseText(result);
  }
}

async function applyImportedCaseText(result) {
  const input = document.querySelector("#caseInput");
  if (!input || !result.extractedText) return;
  input.value = result.extractedText;
  renderCaseSignals(result.extractedText);
  renderDocumentImportStatus("analysis", "已读取病例文本，正在同步到智能体分析、病历审查、RAG 和知识图谱...");
  const modeBadge = document.querySelector("#analysisModeBadge");
  if (modeBadge) {
    modeBadge.textContent = "导入病例分析中";
    modeBadge.className = "badge medium";
  }
  try {
    await runAnalysis({ forceLocalOnly: true });
    renderDocumentImportStatus("ok", "导入病例已完成全链路分析：智能体分析、病历审查、路径质控、RAG 知识库和知识图谱已刷新。");
  } catch (error) {
    renderDocumentImportStatus("danger", `已读取病例文本，但自动分析失败：${error.message}`);
    throw error;
  }
}

function renderDocumentImportStatus(status, message) {
  const box = document.querySelector("#documentImportStatus");
  if (!box) return;
  const cls = status === "ok" ? "ok" : status === "danger" ? "danger" : "warn";
  const label = status === "ok" ? "导入分析完成" : status === "danger" ? "导入分析失败" : "正在导入分析";
  box.className = `review-card ${cls}`;
  box.innerHTML = `${frameTitleHtml(label)}<p>${escapeHtml(message)}</p>`;
}

function renderDocumentPreview(result) {
  const box = document.querySelector("#documentPreviewBox");
  if (!box) return;
  const steps = result.pipeline || [];
  const analysis = result.analysis;
  const canAnalyze = Boolean(result.extractedText);
  box.innerHTML = `
    <article class="review-card ${canAnalyze ? "ok" : "danger"}">
      <strong>${escapeHtml(result.fileName || "待导入病历")}</strong>
      <span>${escapeHtml(result.documentTypeLabel)}｜${escapeHtml(result.sizeLabel)}</span>
      <p>${escapeHtml(result.summary)}</p>
      ${canAnalyze ? `<p class="note">已读取到病例文本，下一步将自动同步并执行全链路分析。</p>` : `<p class="note">未读取到可分析病例文本，因此不会触发智能体分析。请换用文字型 PDF、清晰图片，或复制脱敏病例摘要到左侧病例输入。</p>`}
    </article>
    <article id="documentImportStatus" class="review-card ${canAnalyze ? "warn" : "danger"}">
      ${frameTitleHtml(canAnalyze ? "等待导入分析" : "未进入分析")}
      <p>${escapeHtml(canAnalyze ? "病例文本已就绪，正在准备同步到各模块。" : "原因：本次导入未获得可分析文本，智能体、病历审查、RAG 和知识图谱不会变化。")}</p>
    </article>
    ${steps
      .map(
        (step) => `
          <article class="review-card ${step.status === "ready" ? "ok" : step.status === "manual" ? "warn" : ""}">
            <strong>${escapeHtml(step.name)}</strong>
            <span>${escapeHtml(step.statusLabel)}</span>
            <p>${escapeHtml(step.detail)}</p>
          </article>
        `,
      )
      .join("")}
    ${
      analysis
        ? `<article class="review-card warn">
            <strong>已基于可读文本完成预分析</strong>
            <span>${escapeHtml(analysis.riskLevel)}｜风险因素 ${analysis.riskFactors.length} 项</span>
            <p>${escapeHtml(analysis.clinicalReasoning && analysis.clinicalReasoning.keyConclusion ? analysis.clinicalReasoning.keyConclusion : analysis.inputSummary)}</p>
          </article>`
        : `<article class="review-card danger">
            <strong>未获得可分析文本</strong>
            <span>${escapeHtml(result.extractionStatus || "未识别")}</span>
            <p>${escapeHtml(result.extractionNote || result.nextStep)}</p>
          </article>`
    }
  `;
}

async function runCohortQuerySimulation() {
  const payload = {
    department: document.querySelector("#cohortDepartment").value,
    diagnosis: document.querySelector("#cohortDiagnosis").value,
    range: document.querySelector("#cohortRange").value,
  };
  const box = document.querySelector("#cohortResultBox");
  if (box) box.innerHTML = '<div class="empty compact">正在模拟调取院内队列并批量分析...</div>';
  const result = await api("/api/cohort/query", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  renderCohortResult(result);
  if (result.dashboard) renderDashboard(result.dashboard);
}

function renderCohortResult(result) {
  const box = document.querySelector("#cohortResultBox");
  if (!box) return;
  box.innerHTML = `
    <article class="review-card ok">
      <strong>队列筛选完成</strong>
      <span>${escapeHtml(result.filtersLabel)}｜${result.count} 例</span>
      <p>${escapeHtml(result.boundary)}</p>
    </article>
    ${(result.results || [])
      .slice(0, 5)
      .map(
        (item) => `
          <article class="review-card ${item.riskLevel === "高危" ? "danger" : item.riskLevel === "中危" ? "warn" : "ok"}">
            <strong>${escapeHtml(item.patientLabel)}</strong>
            <span>${escapeHtml(item.department)}｜${escapeHtml(item.riskLevel)}｜急症线索 ${item.urgentCount} 项</span>
            <p>${escapeHtml(item.summary)}</p>
          </article>
        `,
      )
      .join("")}
  `;
}

async function loadDashboardSummary() {
  try {
    const result = await api("/api/dashboard/summary");
    renderDashboard(result);
  } catch (error) {
    const badge = document.querySelector("#dashboardBadge");
    if (badge) badge.textContent = "未加载";
  }
}

function renderBarList(items, total) {
  if (!items || !items.length) return '<div class="empty compact">暂无统计。</div>';
  return items
    .map((item) => {
      const percent = total ? Math.max(3, Math.round((item.value / total) * 100)) : 0;
      return `
        <div class="bar-row">
          <span>${escapeHtml(item.label)}</span>
          <div class="bar-track"><i style="width:${percent}%"></i></div>
          <strong>${escapeHtml(item.value)}</strong>
        </div>
      `;
    })
    .join("");
}

function renderDashboard(dashboard) {
  state.dashboard = dashboard;
  const badge = document.querySelector("#dashboardBadge");
  const metrics = document.querySelector("#dashboardMetrics");
  const departments = document.querySelector("#departmentChart");
  const quality = document.querySelector("#qualityChart");
  const actions = document.querySelector("#dashboardActions");
  if (badge) {
    badge.textContent = dashboard.mode || "演示数据";
    badge.className = "badge medium";
  }
  if (metrics) {
    metrics.innerHTML = (dashboard.metrics || [])
      .map(
        (metric) => `
          <article class="metric dashboard-metric">
            <span>${escapeHtml(metric.label)}</span>
            <strong>${escapeHtml(metric.value)}</strong>
            <small>${escapeHtml(metric.note || "")}</small>
          </article>
        `,
      )
      .join("");
  }
  if (departments) {
    departments.innerHTML = `
      <h3>科室分布</h3>
      ${renderBarList(dashboard.departmentDistribution || [], dashboard.totalPatients || 0)}
    `;
  }
  if (quality) {
    quality.innerHTML = `
      <h3>质量闭环</h3>
      ${renderBarList(dashboard.qualityIndicators || [], 100)}
    `;
  }
  if (actions) {
    actions.innerHTML = (dashboard.managerActions || [])
      .map(
        (item) => `
          <article class="review-card ${item.level === "重点" ? "danger" : item.level === "关注" ? "warn" : "ok"}">
            <strong>${escapeHtml(item.title)}</strong>
            <span>${escapeHtml(item.level)}</span>
            <p>${escapeHtml(item.detail)}</p>
          </article>
        `,
      )
      .join("");
  }
}

async function loadInformatizationLevels() {
  try {
    const result = await api("/api/informatization/levels");
    state.informatization = result;
    renderInformatizationLevels(result);
  } catch (error) {
    const badge = document.querySelector("#informatizationBadge");
    if (badge) badge.textContent = "未加载";
  }
}

function levelStatusClass(status) {
  if (/已覆盖/.test(status)) return "ok";
  if (/预留|演示/.test(status)) return "warn";
  return "";
}

function renderInformatizationLevels(result) {
  const badge = document.querySelector("#informatizationBadge");
  const intro = document.querySelector("#informatizationIntro");
  const levels = document.querySelector("#informatizationLevels");
  if (badge) {
    badge.textContent = `${(result.levels || []).length} 级能力`;
    badge.className = "badge medium";
  }
  if (intro) {
    intro.innerHTML = `
      <article class="review-card ok">
        <strong>${escapeHtml(result.title)}</strong>
        <span>建设标准 / 信息化应用 / 质控闭环</span>
        <p>${escapeHtml(result.sourceNote)}</p>
      </article>
      ${(result.vetoItems || [])
        .map(
          (item) => `
            <article class="review-card warn">
              <strong>底线要求</strong>
              <p>${escapeHtml(item)}</p>
            </article>
          `,
        )
        .join("")}
    `;
  }
  if (levels) {
    levels.innerHTML = (result.levels || [])
      .map(
        (level) => `
          <article class="panel level-card">
            <header>
              <div>
                <span class="level-id">${escapeHtml(level.id)}</span>
                <h3>${escapeHtml(level.name)}</h3>
              </div>
              <span class="badge ${levelStatusClass(level.mvpStatus)}">${escapeHtml(level.mvpStatus)}</span>
            </header>
            <p>${escapeHtml(level.goal)}</p>
            ${list(level.features || [], (item) => `<li>${escapeHtml(item)}</li>`)}
          </article>
        `,
      )
      .join("");
  }
  renderInformatizationTools(result);
  renderRequirementCards("#triggerScenarioList", result.triggerScenarios || [], (item) => `
    <article class="requirement-card">
      <header>
        <strong>${escapeHtml(item.node)}</strong>
        <span class="badge ${levelStatusClass(item.mvpStatus)}">${escapeHtml(item.mvpStatus)}</span>
      </header>
      <p>${escapeHtml(item.trigger)}</p>
      <small>${escapeHtml(item.scale)}</small>
    </article>
  `);
  renderRequirementCards("#departmentScaleMap", result.departmentScaleMap || [], (item) => `
    <article class="requirement-card">
      <header>
        <strong>${escapeHtml(item.department)}</strong>
        <span>${escapeHtml(item.defaultScale)}</span>
      </header>
      <p>${escapeHtml(item.note)}</p>
    </article>
  `);
  renderRequirementCards("#dataDictionaryList", result.dataDictionaries || [], (item) => `
    <article class="requirement-card">
      <header>
        <strong>${escapeHtml(item.name)}</strong>
      </header>
      <p>${escapeHtml(item.use)}</p>
      <small>${escapeHtml((item.examples || []).join(" / "))}</small>
    </article>
  `);
  renderRequirementCards("#qualityMetricList", result.qualityMetrics || [], (item) => `
    <article class="requirement-row">${escapeHtml(item)}</article>
  `);
  renderRequirementCards("#systemPrerequisiteList", result.systemPrerequisites || [], (item) => `
    <article class="requirement-row muted">${escapeHtml(item)}</article>
  `);
  renderRequirementCards("#agentUpgradeList", result.agentUpgradeItems || [], (item) => `
    <article class="requirement-card">
      <header>
        <strong>${escapeHtml(item.name)}</strong>
      </header>
      <p>${escapeHtml(item.detail)}</p>
      <small>${escapeHtml(item.source)}</small>
    </article>
  `);
}

function renderRequirementCards(selector, items, mapper) {
  const container = document.querySelector(selector);
  if (!container) return;
  container.innerHTML = items.length ? items.map(mapper).join("") : '<div class="empty compact">暂无配置。</div>';
}

function renderInformatizationTools(result) {
  const hisInput = document.querySelector("#hisEmrInput");
  if (hisInput && !hisInput.value.trim()) {
    hisInput.value = hisSampleText();
  }
  const triggerSelect = document.querySelector("#triggerScenarioSelect");
  if (triggerSelect) {
    triggerSelect.innerHTML = (result.triggerScenarios || [])
      .map((item, index) => `<option value="${index}">${escapeHtml(item.node)}</option>`)
      .join("");
  }
  const departmentSelect = document.querySelector("#triggerDepartmentSelect");
  if (departmentSelect) {
    departmentSelect.innerHTML = (result.departmentScaleMap || [])
      .map((item, index) => `<option value="${index}">${escapeHtml(item.department)}｜${escapeHtml(item.defaultScale)}</option>`)
      .join("");
  }
  const checklist = document.querySelector("#capabilityChecklist");
  if (checklist) {
    const capabilities = buildCapabilityItems(result);
    checklist.innerHTML = capabilities
      .map(
        (item) => `
          <label class="capability-item">
            <input type="checkbox" value="${escapeHtml(item.key)}" data-level="${escapeHtml(item.level)}" />
            <span>
              <strong>${escapeHtml(item.label)}</strong>
              <small>${escapeHtml(item.detail)}</small>
            </span>
          </label>
        `,
      )
      .join("");
  }
  renderTriggerSimulation();
  selectBaselineCapabilitiesForAssessment();
  renderCapabilityAssessment();
}

function hisSampleText() {
  return [
    "【HIS/EMR模拟输入】患者女，32岁，产后4周，剖宫产后活动减少，左下肢肿胀疼痛3天入院。",
    "诊断：左下肢深静脉血栓形成，既往左下肢DVT史，血栓后综合征可能。",
    "医嘱：拟启用低分子肝素抗凝，弹力袜，踝泵运动，出院随访。",
    "检验：Hb 109 g/L，PLT 286 x10^9/L，PT 12.1 s，APTT 30.2 s，D-二聚体 5.6 mg/L FEU，Cr 55 umol/L。",
    "检查：下肢静脉彩超提示左股浅静脉、腘静脉陈旧血栓后改变，左胫后静脉新发血栓。",
    "流程节点：出院前24小时需评估延长期预防、患者宣教和随访计划。",
  ].join("\\n");
}

function loadHisSampleInput() {
  const input = document.querySelector("#hisEmrInput");
  if (input) input.value = hisSampleText();
}

async function runHisEmrAnalysisSimulation() {
  const input = document.querySelector("#hisEmrInput");
  const resultBox = document.querySelector("#hisEmrAnalysisResult");
  if (!input || !resultBox) return;
  const text = input.value.trim();
  if (!text) {
    resultBox.innerHTML = '<div class="empty compact">请先粘贴 HIS 字段、电子病历摘要或检查检验文本。</div>';
    return;
  }
  resultBox.innerHTML = '<div class="empty compact">正在分析 HIS/电子病历输入...</div>';
  try {
    const [analysis, review] = await Promise.all([
      api("/api/analyze", { method: "POST", body: JSON.stringify({ text }) }),
      api("/api/emr/review", { method: "POST", body: JSON.stringify({ text }) }),
    ]);
    const prediction = analysis.decisionSupport && analysis.decisionSupport.riskPrediction;
    resultBox.innerHTML = `
      <article class="review-card ${analysis.riskLevel === "高危" ? "danger" : "warn"}">
        <strong>${escapeHtml(analysis.riskLevel)}｜评分 ${escapeHtml(analysis.score)}</strong>
        <span>${escapeHtml(prediction ? `峰值 ${prediction.peakProbability}%｜${prediction.peakWindow}` : "已完成分析")}</span>
        <p>${escapeHtml(analysis.clinicalReasoning && analysis.clinicalReasoning.keyConclusion ? analysis.clinicalReasoning.keyConclusion : "已生成 VTE 风险分析。")}</p>
      </article>
      <article class="review-card ok">
        <strong>医生端任务</strong>
        ${list((analysis.roleTasks && analysis.roleTasks.doctor ? analysis.roleTasks.doctor : []).slice(0, 4), (item) => `<li>${escapeHtml(item)}</li>`)}
      </article>
      <article class="review-card ok">
        <strong>护士端任务</strong>
        ${list((analysis.roleTasks && analysis.roleTasks.nurse ? analysis.roleTasks.nurse : []).slice(0, 4), (item) => `<li>${escapeHtml(item)}</li>`)}
      </article>
      <article class="review-card warn">
        <strong>流程核查</strong>
        ${list((review.processChecks || []).slice(0, 4), (item) => `<li>${escapeHtml(item.title || item)}</li>`)}
      </article>
    `;
  } catch (error) {
    resultBox.innerHTML = `<div class="empty compact">分析失败：${escapeHtml(error.message)}</div>`;
  }
}

function renderTriggerSimulation() {
  const result = state.informatization;
  const output = document.querySelector("#triggerSimulationResult");
  if (!result || !output) return;
  const triggerIndex = Number(document.querySelector("#triggerScenarioSelect")?.value || 0);
  const departmentIndex = Number(document.querySelector("#triggerDepartmentSelect")?.value || 0);
  const trigger = (result.triggerScenarios || [])[triggerIndex];
  const department = (result.departmentScaleMap || [])[departmentIndex];
  if (!trigger || !department) return;
  const metric = selectMetricForTrigger(result.qualityMetrics || [], trigger.node);
  output.innerHTML = `
    <article class="review-card ok">
      <strong>${escapeHtml(trigger.node)}</strong>
      <span>${escapeHtml(department.department)}｜${escapeHtml(department.defaultScale)}</span>
      <p>${escapeHtml(trigger.trigger)}</p>
    </article>
    <article class="review-card warn">
      <strong>系统动作</strong>
      ${list([
        "从 HIS/EMR 抽取诊断、手术、转科、医嘱、护理和时间戳。",
        `按 ${department.defaultScale} 生成可审核量表，并同步出血风险核查。`,
        "将医生确认、预防医嘱、护理任务和患者宣教写入质控闭环。",
      ], (item) => `<li>${escapeHtml(item)}</li>`)}
    </article>
    <article class="review-card ok">
      <strong>质控指标</strong>
      <p>${escapeHtml(metric)}</p>
    </article>
  `;
}

function selectMetricForTrigger(metrics, node) {
  if (/入院/.test(node)) return metrics.find((item) => /入院/.test(item)) || metrics[0] || "VTE 风险评估率";
  if (/手术前/.test(node)) return metrics.find((item) => /手术前/.test(item)) || metrics[0] || "术前评估率";
  if (/手术后/.test(node)) return metrics.find((item) => /手术后/.test(item)) || metrics[0] || "术后评估率";
  if (/转入|转出/.test(node)) return metrics.find((item) => /转科/.test(item)) || metrics[0] || "转科评估率";
  if (/出院/.test(node)) return metrics.find((item) => /出院/.test(item)) || metrics[0] || "出院前评估率";
  if (/抗凝/.test(node)) return metrics.find((item) => /安全|血小板|出血/.test(item)) || metrics[0] || "抗凝安全复核率";
  return metrics.find((item) => /预警|响应|复核/.test(item)) || metrics[0] || "预警响应率";
}

function buildCapabilityItems(result) {
  return (result.levels || []).flatMap((level) =>
    (level.features || []).slice(0, 3).map((feature, index) => ({
      key: `${level.id}-${index}`,
      level: level.id,
      label: `${level.id} ${feature}`,
      detail: level.goal,
    })),
  );
}

function selectBaselineCapabilitiesForAssessment() {
  document.querySelectorAll("#capabilityChecklist input[type='checkbox']").forEach((input) => {
    input.checked = ["L0", "L1"].includes(input.dataset.level) || (input.dataset.level === "L2" && input.value.endsWith("-0"));
  });
}

function renderCapabilityAssessment() {
  const result = state.informatization;
  const output = document.querySelector("#capabilityAssessmentResult");
  if (!result || !output) return;
  const checked = [...document.querySelectorAll("#capabilityChecklist input[type='checkbox']:checked")];
  const all = [...document.querySelectorAll("#capabilityChecklist input[type='checkbox']")];
  const levelIds = (result.levels || []).map((level) => level.id);
  const achieved = levelIds.filter((level) => {
    const items = all.filter((input) => input.dataset.level === level);
    return items.length && items.every((input) => input.checked);
  });
  const currentLevel = achieved.length ? achieved[achieved.length - 1] : "未达底线";
  const nextLevel = levelIds.find((level) => !achieved.includes(level));
  const gaps = nextLevel
    ? all.filter((input) => input.dataset.level === nextLevel && !input.checked).map((input) => input.closest("label")?.querySelector("strong")?.textContent || input.value)
    : [];
  output.innerHTML = `
    <article class="review-card ${currentLevel === "未达底线" ? "danger" : "ok"}">
      <strong>当前判定：${escapeHtml(currentLevel)}</strong>
      <span>已勾选 ${checked.length}/${all.length} 项</span>
      <p>${escapeHtml(nextLevel ? `下一目标为 ${nextLevel}，需补齐下列能力。` : "已覆盖当前演示分级中的全部能力项。")}</p>
    </article>
    <article class="review-card warn">
      <strong>下一步缺口</strong>
      ${list(gaps.slice(0, 6), (item) => `<li>${escapeHtml(item)}</li>`)}
    </article>
  `;
}

async function updateCaseKnowledgeGraph(text) {
  try {
    const graph = await api("/api/knowledge/graph/case", {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    state.knowledgeGraph = graph;
    renderKnowledgeGraph(graph);
    return graph;
  } catch (error) {
    const summary = document.querySelector("#graphSummary");
    if (summary) summary.innerHTML = `<div class="empty compact">知识图谱暂未更新：${escapeHtml(error.message)}</div>`;
    return null;
  }
}

function updateCaseAwareRagQuery(text, report, graph) {
  const input = document.querySelector("#ragQuestion");
  if (!input) return;
  const factorKeys = new Set((report.riskFactors || []).map((item) => item.key));
  const urgentKeys = new Set((report.urgentFlags || []).map((item) => item.key));
  const topics = [];
  if (factorKeys.has("pregnancy")) topics.push("妊娠早期 VTE");
  if (urgentKeys.has("limb_ischemia")) topics.push("股青肿/肢体灌注受威胁");
  if (urgentKeys.has("acute_symptomatic_dvt")) topics.push("急性症状性下肢 DVT");
  if (urgentKeys.has("suspected_pe")) topics.push("疑似肺栓塞 PE");
  if (factorKeys.has("surgery")) topics.push("围术期处理");
  if (factorKeys.has("obesity")) topics.push("肥胖/BMI");

  if (factorKeys.has("pregnancy") && urgentKeys.has("limb_ischemia")) {
    input.value = "妊娠10周，疑似急性下肢DVT合并股青肿/肢体灌注受威胁：应优先检索哪些指南证据支持诊断影像路径、抗凝安全、血管外科急症处理和围术期策略？";
    return;
  }
  if (factorKeys.has("pregnancy") && urgentKeys.has("suspected_pe")) {
    input.value = "妊娠相关VTE合并疑似PE：应优先检索哪些指南证据支持影像选择、抗凝安全、产科协同和围术期处理？";
    return;
  }
  input.value = `${topics.slice(0, 4).join("、") || "VTE病例"}：请优先检索指南/共识中与诊断路径、抗凝安全、急症处理和护理复评直接相关的证据。`;
}

function graphNodeClass(node, highlighted, relevance, contextIds) {
  const classes = ["graph-node", `group-${node.group || "default"}`];
  if (highlighted.has(node.id)) {
    classes.push("active", `strength-${(relevance[node.id] && relevance[node.id].level) || "medium"}`);
  } else if (contextIds && contextIds.has(node.id)) {
    classes.push("context");
  }
  return classes.join(" ");
}

function estimateGraphLabelWidth(label) {
  const text = String(label || "");
  const cjkCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const asciiCount = text.length - cjkCount;
  return Math.min(240, Math.max(68, cjkCount * 14 + asciiCount * 7));
}

function graphDisplayLabel(node) {
  const labels = {
    vte_risk: "静脉血栓栓塞风险",
    pregnancy_risk: "妊娠相关血栓风险",
    caprini: "卡普里尼评分",
    high_risk: "静脉血栓栓塞高危",
    symptomatic_dvt: "急性症状性下肢深静脉血栓线索",
    suspected_pe: "疑似肺栓塞急症线索",
    pe_imaging: "肺栓塞影像路径",
    cta_ctv: "血管造影/静脉成像",
    perioperative_plan: "围术期血栓防控方案",
    dvt_guideline_2026: "深静脉血栓诊断与治疗指南第四版",
    source_literature_matrix: "文献矩阵",
    subtype_dvt: "深静脉血栓主题",
    subtype_pe: "肺栓塞主题",
    topic_ai_model: "人工智能预测模型",
    topic_imaging: "影像诊断",
    topic_evidence_guideline: "指南与综述",
  };
  if (labels[node.id]) return labels[node.id];
  return String(node.label || "")
    .replaceAll("VTE", "静脉血栓栓塞")
    .replaceAll("DVT", "深静脉血栓")
    .replaceAll("PE", "肺栓塞")
    .replaceAll("Caprini", "卡普里尼")
    .replaceAll("Padua", "帕多瓦")
    .replaceAll("Wells", "韦尔斯")
    .replaceAll("CTPA", "肺动脉CT成像")
    .replaceAll("CTA", "血管造影")
    .replaceAll("CTV", "静脉成像")
    .replaceAll("AI", "人工智能");
}

function graphRadialLayout(nodes, relevance) {
  const total = nodes.length || 1;
  const scale = total <= 10 ? 0.72 : total <= 14 ? 0.82 : total <= 20 ? 0.92 : total <= 30 ? 1 : 1.08;
  const center = { x: 470, y: total <= 14 ? 330 : 350 };
  const rings = {
    high: { radius: Math.round(88 * scale), nodes: [] },
    medium: { radius: Math.round(174 * scale), nodes: [] },
    low: { radius: Math.round(258 * scale), nodes: [] },
    context: { radius: Math.round(312 * scale), nodes: [] },
  };
  nodes.forEach((node) => {
    const item = relevance[node.id];
    const level = item && item.level ? item.level : inferGraphRing(node);
    const key = rings[level] ? level : "context";
    rings[key].nodes.push(node);
  });
  const positions = {};
  Object.values(rings).forEach((ring) => {
    const count = Math.max(1, ring.nodes.length);
    ring.nodes.forEach((node, index) => {
      const startAngle = ring.radius === 86 ? -Math.PI / 2 : -Math.PI / 2 + Math.PI / count;
      const angle = startAngle + (index / count) * Math.PI * 2;
      positions[node.id] = {
        x: center.x + Math.cos(angle) * ring.radius,
        y: center.y + Math.sin(angle) * ring.radius,
      };
    });
  });
  return { center, positions, rings, maxRadius: Math.max(...Object.values(rings).map((ring) => ring.radius)) };
}

function graphEntityLayout(nodes, relevance) {
  const center = { x: 390, y: 350 };
  const groupOrder = ["risk", "emergency", "diagnosis", "assessment", "safety", "treatment", "prevention", "care", "workflow", "evidence"];
  const ordered = [...nodes].sort((a, b) => {
    const aGroup = groupOrder.indexOf(a.group);
    const bGroup = groupOrder.indexOf(b.group);
    const aScore = (relevance[a.id] && relevance[a.id].score) || 0;
    const bScore = (relevance[b.id] && relevance[b.id].score) || 0;
    return (aGroup === -1 ? 99 : aGroup) - (bGroup === -1 ? 99 : bGroup) || bScore - aScore;
  });
  const total = Math.max(1, ordered.length);
  const rx = total <= 10 ? 264 : total <= 16 ? 282 : 300;
  const ry = total <= 10 ? 236 : total <= 16 ? 252 : 270;
  const positions = {};
  ordered.forEach((node, index) => {
    const angle = -Math.PI / 2 + (index / total) * Math.PI * 2;
    const groupOffset = groupOrder.indexOf(node.group) % 2 === 0 ? -10 : 10;
    positions[node.id] = {
      x: center.x + Math.cos(angle) * (rx + groupOffset),
      y: center.y + Math.sin(angle) * (ry - groupOffset),
      angle,
    };
  });
  return { center, positions, bounds: { x: 0, y: 0, width: 780, height: 700 } };
}

function inferGraphRing(node) {
  if (["emergency", "risk"].includes(node.group)) return "high";
  if (["diagnosis", "safety", "assessment", "treatment"].includes(node.group)) return "medium";
  if (["prevention", "care", "evidence"].includes(node.group)) return "low";
  return "context";
}

function graphNodeRadius(node, highlighted, relevance) {
  const level = relevance[node.id] && relevance[node.id].level;
  if (highlighted.has(node.id) && level === "high") return 54;
  if (highlighted.has(node.id)) return 48;
  if (["risk", "emergency"].includes(node.group)) return 46;
  if (["diagnosis", "assessment", "treatment", "safety"].includes(node.group)) return 42;
  return 38;
}

function graphCaseRiskTone(riskLevel) {
  const normalized = String(riskLevel || "").trim();
  if (/极高|高危|高风险|危重|急症|急危/.test(normalized)) return "high";
  if (/中危|中风险/.test(normalized)) return "medium";
  if (/低危|低风险/.test(normalized)) return "low";
  return "pending";
}

function wrapGraphLabel(label, maxChars = 8) {
  const chars = Array.from(String(label || ""));
  const lines = [];
  let line = "";
  chars.forEach((char) => {
    const width = /[A-Za-z0-9]/.test(char) ? 0.55 : 1;
    const currentWidth = Array.from(line).reduce((sum, item) => sum + (/[A-Za-z0-9]/.test(item) ? 0.55 : 1), 0);
    if (currentWidth + width > maxChars && line) {
      lines.push(line);
      line = char;
    } else {
      line += char;
    }
  });
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

function graphContentBounds(nodes, positions, radial, highlighted, relevance) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  nodes.forEach((node) => {
    const pos = positions[node.id];
    if (!pos) return;
    const active = highlighted.has(node.id);
    const radius = active ? 21 : 17;
    const labelWidth = estimateGraphLabelWidth(graphDisplayLabel(node));
    const labelHalf = labelWidth / 2;
    minX = Math.min(minX, pos.x - Math.max(radius, labelHalf) - 14);
    maxX = Math.max(maxX, pos.x + Math.max(radius, labelHalf) + 14);
    minY = Math.min(minY, pos.y - radius - 28);
    maxY = Math.max(maxY, pos.y + 46);
  });

  if (radial && radial.center) {
    const ringPad = radial.maxRadius + 68;
    minX = Math.min(minX, radial.center.x - ringPad);
    maxX = Math.max(maxX, radial.center.x + ringPad);
    minY = Math.min(minY, radial.center.y - ringPad - 10);
    maxY = Math.max(maxY, radial.center.y + ringPad + 30);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return { x: 0, y: 0, width: 900, height: 620 };
  }

  const padding = 26;
  return {
    x: Math.max(0, Math.floor(minX - padding)),
    y: Math.max(0, Math.floor(minY - padding)),
    width: Math.ceil(maxX - minX + padding * 2),
    height: Math.ceil(maxY - minY + padding * 2),
  };
}

function renderKnowledgeGraph(graph) {
  const canvas = document.querySelector("#graphCanvas");
  const summary = document.querySelector("#graphSummary");
  const badge = document.querySelector("#graphBadge");
  if (!canvas || !summary) return;
  const nodes = graph.nodes || [];
  const edges = graph.edges || [];
  const caseView = graph.caseView || {};
  const highlighted = new Set(caseView.highlightedNodeIds || []);
  const relevance = caseView.highlightedNodeRelevance || {};
  const neighborIds = new Set();
  if (highlighted.size) {
    edges.forEach((edge) => {
      if (highlighted.has(edge.source) && highlighted.has(edge.target)) neighborIds.add(edge.target);
    });
  }
  const highlightedEvidenceIds = nodes
    .filter((node) => highlighted.has(node.id) && node.type === "evidence_item")
    .sort((a, b) => ((relevance[b.id] && relevance[b.id].score) || 0) - ((relevance[a.id] && relevance[a.id].score) || 0))
    .slice(0, 2)
    .map((node) => node.id);
  const highlightedEvidenceSet = new Set(highlightedEvidenceIds);
  const displayNodes = highlighted.size
    ? nodes.filter((node) => highlighted.has(node.id) && (node.type !== "evidence_item" || highlightedEvidenceSet.has(node.id)))
    : nodes.length > 70
      ? nodes.filter((node) => node.type !== "evidence_item" && !["source", "study_type", "evidence_tier"].includes(node.type))
      : nodes;
  const clinicalCandidates = displayNodes.filter((node) => node.type !== "evidence_item" && !["source", "study_type", "evidence_tier"].includes(node.type));
  const clinicalDisplayNodes = highlighted.size
    ? [...clinicalCandidates]
        .sort((a, b) => ((relevance[b.id] && relevance[b.id].score) || 0) - ((relevance[a.id] && relevance[a.id].score) || 0))
        .slice(0, 10)
    : clinicalCandidates.slice(0, 16);
  const displayNodeIds = new Set(clinicalDisplayNodes.map((node) => node.id));
  const highlightedEdges = new Set(caseView.highlightedEdgeIds || []);
  const entityLayout = graphEntityLayout(clinicalDisplayNodes, relevance);
  const positions = entityLayout.positions;
  const nodeById = Object.fromEntries(nodes.map((node) => [node.id, node]));
  const bounds = entityLayout.bounds;
  const caseRiskTone = graphCaseRiskTone(caseView.riskLevel);
  canvas.style.minHeight = "0";
  const caseEdgeSvg = clinicalDisplayNodes
    .filter((node) => highlighted.has(node.id) && positions[node.id])
    .map((node, index) => {
      const pos = positions[node.id];
      const level = (relevance[node.id] && relevance[node.id].level) || "medium";
      const sweep = index % 2;
      const dx = pos.x - entityLayout.center.x;
      const dy = pos.y - entityLayout.center.y;
      const curve = Math.max(120, Math.sqrt(dx * dx + dy * dy) * 0.55);
      return `<path class="case-link strength-${escapeHtml(level)}" marker-end="url(#graphArrow)" d="M ${entityLayout.center.x} ${entityLayout.center.y} Q ${entityLayout.center.x + dx * 0.35 + (sweep ? 24 : -24)} ${entityLayout.center.y + dy * 0.35} ${pos.x} ${pos.y}"></path>`;
    })
    .join("");
  const edgeSvg = edges
    .filter((edge) => displayNodeIds.has(edge.source) && displayNodeIds.has(edge.target) && positions[edge.source] && positions[edge.target])
    .map((edge, index) => {
      const from = positions[edge.source];
      const to = positions[edge.target];
      const active = highlightedEdges.has(`${edge.source}->${edge.target}`);
      const midX = (from.x + to.x) / 2;
      const midY = (from.y + to.y) / 2;
      const offset = index % 2 === 0 ? -18 : 18;
      return `
        <g class="graph-edge ${active ? "active" : ""}">
          <path marker-end="url(#graphArrow)" d="M ${from.x} ${from.y} Q ${midX} ${midY + offset} ${to.x} ${to.y}"></path>
          ${active ? `<text x="${midX}" y="${midY - 4}">${escapeHtml(edge.relation)}</text>` : ""}
        </g>
      `;
    })
    .join("");
  const nodeSvg = clinicalDisplayNodes
    .map((node) => {
      const pos = positions[node.id];
      const active = highlighted.has(node.id);
      const radius = graphNodeRadius(node, highlighted, relevance);
      const lines = wrapGraphLabel(graphDisplayLabel(node), radius >= 48 ? 9 : 8);
      const width = Math.round(radius * 2.65);
      const height = Math.round(radius * 1.45);
      return `
        <g class="${graphNodeClass(node, highlighted, relevance, neighborIds)}" transform="translate(${pos.x},${pos.y})">
          <rect x="${-width / 2}" y="${-height / 2}" width="${width}" height="${height}" rx="18"></rect>
          <circle class="node-accent" cx="${-width / 2 + 15}" cy="${-height / 2 + 15}" r="4.5"></circle>
          <text class="node-label" y="${lines.length > 2 ? -15 : lines.length > 1 ? -7 : 5}">
            ${lines.map((line, index) => `<tspan x="0" dy="${index === 0 ? 0 : 16}">${escapeHtml(line)}</tspan>`).join("")}
          </text>
        </g>
      `;
    })
    .join("");
  canvas.innerHTML = `
    <svg viewBox="${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}" role="img" aria-label="静脉血栓栓塞临床路径知识图谱" preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id="graphCasePendingGradient" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#48a99b"></stop><stop offset="0.52" stop-color="#4c83b4"></stop><stop offset="1" stop-color="#7967ad"></stop></linearGradient>
        <linearGradient id="graphCaseHighGradient" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ef876f"></stop><stop offset="0.55" stop-color="#d6504c"></stop><stop offset="1" stop-color="#9b3c4a"></stop></linearGradient>
        <linearGradient id="graphCaseMediumGradient" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f0c36d"></stop><stop offset="0.55" stop-color="#d99045"></stop><stop offset="1" stop-color="#a96538"></stop></linearGradient>
        <linearGradient id="graphCaseLowGradient" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5fbda8"></stop><stop offset="0.55" stop-color="#3e9187"></stop><stop offset="1" stop-color="#2d6f70"></stop></linearGradient>
        <linearGradient id="graphRiskGradient" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#55b3a5"></stop><stop offset="1" stop-color="#2d7973"></stop></linearGradient>
        <linearGradient id="graphEmergencyGradient" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ec8075"></stop><stop offset="1" stop-color="#b84549"></stop></linearGradient>
        <linearGradient id="graphDiagnosisGradient" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#70b5cf"></stop><stop offset="1" stop-color="#4778aa"></stop></linearGradient>
        <linearGradient id="graphSafetyGradient" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#edc06c"></stop><stop offset="1" stop-color="#c27c39"></stop></linearGradient>
        <linearGradient id="graphTreatmentGradient" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#aa91d0"></stop><stop offset="1" stop-color="#7159a1"></stop></linearGradient>
        <linearGradient id="graphPreventionGradient" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8cb98c"></stop><stop offset="1" stop-color="#557e5e"></stop></linearGradient>
        <linearGradient id="graphEvidenceGradient" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7788bd"></stop><stop offset="1" stop-color="#4a5790"></stop></linearGradient>
        <marker id="graphArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z"></path>
        </marker>
      </defs>
      <g class="graph-atmosphere">
        <ellipse cx="390" cy="350" rx="310" ry="286"></ellipse>
        <ellipse cx="390" cy="350" rx="232" ry="210"></ellipse>
        <path d="M68 562 C180 500 236 570 336 524 S520 455 710 530"></path>
        <path d="M88 596 C215 542 310 618 430 560 S603 516 694 552"></path>
      </g>
      ${caseEdgeSvg}
      ${edgeSvg}
      ${
        `<g class="case-center risk-${caseRiskTone}" transform="translate(${entityLayout.center.x},${entityLayout.center.y})">
              <circle class="case-halo" r="100"></circle>
              <circle class="case-orb" r="72"></circle>
              <path class="case-pulse" d="M-42 0h18l9-19 14 38 11-22h32"></path>
              <text class="case-title" y="-30">${highlighted.size ? "当前病例" : "血栓图谱"}</text>
              <text class="case-risk" y="42">${escapeHtml(caseView.riskLevel || "待分析")}</text>
            </g>`
      }
      ${nodeSvg}
      <g class="graph-legend" transform="translate(28,32)">
        <circle class="legend-risk" cx="0" cy="0" r="8"></circle><text x="14" y="4">风险因素</text>
        <circle class="legend-emergency" cx="96" cy="0" r="8"></circle><text x="110" y="4">急症线索</text>
        <circle class="legend-diagnosis" cx="196" cy="0" r="8"></circle><text x="210" y="4">诊断评估</text>
        <circle class="legend-treatment" cx="310" cy="0" r="8"></circle><text x="324" y="4">治疗/预防</text>
      </g>
    </svg>
  `;
  if (badge) {
    badge.textContent = highlighted.size ? `${clinicalDisplayNodes.length} 个节点高亮` : `${clinicalDisplayNodes.length} 个临床节点`;
    badge.className = `badge ${highlighted.size ? "medium" : "muted"}`;
  }

  const matchedRules = caseView.matchedRules || [];
  const activeNodes = (caseView.highlightedNodeIds || []).map((id) => nodeById[id]).filter(Boolean);
  const relevanceGroups = { high: [], medium: [], low: [] };
  activeNodes.forEach((node) => {
    const item = relevance[node.id] || { level: "medium", score: 0.6, reason: "病例相关" };
    relevanceGroups[item.level || "medium"].push({ node, item });
  });
  const activeEvidence = (caseView.evidence || []).slice(0, 4);
  const review = state.emrReview || {};
  const graphWeakPoints = ((((review.hospitalPositionReview || {}).vulnerabilities) || []).slice(0, 3));
  const graphActions = ((((review.activeCaseImprovementPlan || {}).actions) || []).slice(0, 3));
  summary.innerHTML = `
    <article class="review-card ${caseView.urgentFlags && caseView.urgentFlags.length ? "danger" : "ok"}">
      <strong>${escapeHtml(caseView.summary || graph.boundary || "知识图谱已加载。")}</strong>
      <span>${escapeHtml(caseView.riskLevel || `${graph.version || ""}｜文献 ${graph.source && graph.source.literatureCount ? graph.source.literatureCount : nodes.length} 条`)}</span>
      <p>${escapeHtml(graph.boundary || "")}</p>
    </article>
    ${
      matchedRules.length
        ? matchedRules
            .map(
              (rule) => `
                <article class="review-card warn">
                  <strong>${escapeHtml(rule.label)}</strong>
                  <span>${escapeHtml((rule.matchedTriggers || []).join("、"))}</span>
                  <p>${escapeHtml(rule.summary)}</p>
                </article>
              `,
            )
            .join("")
        : ""
    }
    <article class="review-card ok">
      <strong>当前病例激活节点</strong>
      <p>${escapeHtml(activeNodes.map((node) => graphDisplayLabel(node)).join("、") || "暂无病例高亮。")}</p>
    </article>
    <article class="review-card ok">
      <strong>相关性强弱</strong>
      <p><span class="legend high">强相关</span>${escapeHtml(relevanceGroups.high.map(({ node }) => node.label).join("、") || "无")}</p>
      <p><span class="legend medium">中相关</span>${escapeHtml(relevanceGroups.medium.map(({ node }) => node.label).join("、") || "无")}</p>
      <p><span class="legend low">弱相关</span>${escapeHtml(relevanceGroups.low.map(({ node }) => node.label).join("、") || "无")}</p>
    </article>
    ${
      graphWeakPoints.length || graphActions.length
        ? `<article class="review-card warn">
            <strong>病历证据链同步</strong>
            <p>${escapeHtml(graphWeakPoints.length ? `薄弱点：${graphWeakPoints.map((item) => item.title).join("、")}` : "暂无明显薄弱点。")}</p>
            <p>${escapeHtml(graphActions.length ? `补强节点：${graphActions.map((item) => item.title).join("、")}` : "暂无补强节点。")}</p>
          </article>`
        : ""
    }
    ${
      activeEvidence.length
        ? `<article class="review-card ok">
            <strong>病例关联证据</strong>
            <p>${escapeHtml(activeEvidence.map((item) => item.title).join("；"))}</p>
          </article>`
        : ""
    }
  `;
}

async function copyApiExample() {
  const text = `curl -X POST http://localhost:8787/api/analyze \\
  -H 'Content-Type: application/json' \\
  -d '{
    "containsRealPatientData": false,
    "patientContext": {
      "patientToken": "demo-patient-001",
      "encounterToken": "demo-encounter-001",
      "department": "血管外科",
      "admissionTime": "2026-06-23T08:00:00+08:00",
      "age": 68,
      "sex": "男",
      "diagnoses": ["腹盆腔肿瘤", "术后状态"],
      "procedures": ["腹盆腔肿瘤手术"],
      "labs": [
        {
          "name": "D-二聚体",
          "value": "5.6",
          "unit": "mg/L FEU",
          "time": "2026-06-23T09:20:00+08:00"
        }
      ],
      "orders": ["低分子肝素预防", "间歇充气加压装置", "早期活动"],
      "nursingRecords": ["卧床3天", "当前无活动性出血"],
      "freeText": "需评估围术期VTE风险、出血禁忌、护理复评和出院教育。"
    }
  }'`;
  await navigator.clipboard.writeText(text);
  alert("结构化 API 调用示例已复制。");
}

async function testModelCall() {
  const output = document.querySelector("#modelTestOutput");
  const prompt = document.querySelector("#modelPrompt").value.trim();
  if (!prompt) {
    alert("请输入模拟或脱敏测试文本。");
    return;
  }
  output.textContent = "调用中...";
  try {
    const result = await api("/api/model/complete", {
      method: "POST",
      body: JSON.stringify({
        prompt,
        modelPreset: selectedModelPreset().id,
        apiKey: document.querySelector("#modelApiKey") ? document.querySelector("#modelApiKey").value.trim() : "",
        containsRealPatientData: false,
        temperature: 0.2,
      }),
    });
    output.textContent = JSON.stringify(
      {
        provider: result.provider,
        model: result.model,
        text: result.text,
        boundary: result.boundary,
      },
      null,
      2,
    );
  } catch (error) {
    output.textContent = `暂未调用成功：${error.message}\n\n可启动本地模型服务，或设置 MODEL_PROVIDER、MODEL_BASE_URL、MODEL_NAME 和 API key 后重启。`;
  }
}

initialize().catch((error) => {
  console.error(error);
  alert(`启动失败：${error.message}`);
});
