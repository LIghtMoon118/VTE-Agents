const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const os = require("os");
const { spawnSync } = require("child_process");

const PORT = Number(process.env.PORT || 8787);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const DOCUMENT_EXTRACTOR = path.join(ROOT, "scripts", "extract-document-text.swift");

const knowledgeBase = readJson("knowledge.json");
const knowledgeStats = readOptionalJson("knowledge.import-stats.json") || {
  imported: knowledgeBase.length,
  withAbstract: 0,
  withPdf: 0,
  sources: [],
};
const rules = readJson("rules.json");
const demoCases = readJson("demo-cases.json");
const connectorSchema = readJson("connector-schema.json");
const knowledgeGraph = readOptionalJson("knowledge-graph.generated.json") || readJson("knowledge-graph.json");
const modelConfig = readOptionalJson("model-config.json") || readJson("model-config.example.json");

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const localModelAdapters = [
  {
    id: "ollama",
    name: "Ollama",
    provider: "ollama",
    baseUrl: "http://localhost:11434",
    modelsPath: "/api/tags",
    modelListType: "ollama",
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    provider: "openai_compatible",
    baseUrl: "http://localhost:1234/v1",
    modelsPath: "/models",
    modelListType: "openai",
  },
  {
    id: "vllm",
    name: "vLLM",
    provider: "openai_compatible",
    baseUrl: "http://localhost:8000/v1",
    modelsPath: "/models",
    modelListType: "openai",
  },
  {
    id: "xinference",
    name: "Xinference",
    provider: "openai_compatible",
    baseUrl: "http://localhost:9997/v1",
    modelsPath: "/models",
    modelListType: "openai",
  },
  {
    id: "localai",
    name: "LocalAI",
    provider: "openai_compatible",
    baseUrl: "http://localhost:8080/v1",
    modelsPath: "/models",
    modelListType: "openai",
  },
];

const modelPresets = [
  {
    id: "rules_rag",
    label: "仅规则/RAG",
    provider: "off",
    model: "",
    baseUrl: "",
    description: "不调用大模型，使用本地规则、VTE 文献矩阵和流程审查。",
  },
  {
    id: "auto_local",
    label: "自动本地模型",
    provider: "auto",
    model: "",
    baseUrl: "",
    description: "自动发现 Ollama、LM Studio、vLLM、Xinference 或 LocalAI。",
  },
  {
    id: "deepseek_8b",
    label: "DeepSeek-R1 8B",
    provider: "ollama",
    model: "deepseek-r1:8b",
    baseUrl: "http://localhost:11434",
    description: "推荐的本地演示模型，适合 24GB 统一内存机器。",
  },
  {
    id: "deepseek_14b",
    label: "DeepSeek-R1 14B",
    provider: "ollama",
    model: "deepseek-r1:14b",
    baseUrl: "http://localhost:11434",
    description: "质量更好但更慢，适合本地深度分析测试。",
  },
  {
    id: "gpt_high",
    label: "GPT 高质量分析",
    provider: "openai_compatible",
    model: "gpt-5.5",
    baseUrl: "https://api.openai.com/v1",
    requiresApiKey: true,
    description: "用于企业演示和复杂病例推理，需要 OpenAI API key。",
  },
  {
    id: "gpt_fast",
    label: "GPT 快速分析",
    provider: "openai_compatible",
    model: "gpt-5.4-mini",
    baseUrl: "https://api.openai.com/v1",
    requiresApiKey: true,
    description: "适合较快的病例摘要、问答和病历审查草案。",
  },
  {
    id: "gpt_nano",
    label: "GPT 低成本快速",
    provider: "openai_compatible",
    model: "gpt-5.4-nano",
    baseUrl: "https://api.openai.com/v1",
    requiresApiKey: true,
    description: "适合轻量问答和演示占位，不建议承担复杂临床推理。",
  },
];

function readJson(fileName) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, fileName), "utf8"));
}

function readOptionalJson(fileName) {
  const filePath = path.join(DATA_DIR, fileName);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function jsonResponse(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function textResponse(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function publicPresetShape({ id, label, provider, model, baseUrl, requiresApiKey, description }) {
  return {
    id,
    label,
    provider,
    model,
    baseUrl,
    requiresApiKey: Boolean(requiresApiKey),
    description,
  };
}

function dynamicOllamaPreset(modelName) {
  return {
    id: `ollama_model__${encodeURIComponent(modelName)}`,
    label: `Ollama｜${modelName}`,
    provider: "ollama",
    model: modelName,
    baseUrl: "http://localhost:11434",
    requiresApiKey: false,
    description: "本机 Ollama 已安装模型，可直接用于脱敏病例和演示分析。",
  };
}

async function publicModelPresets() {
  const config = currentModelConfig();
  const adapters = await discoverLocalModelAdapters(config.probeTimeoutMs);
  const ollama = adapters.find((adapter) => adapter.id === "ollama");
  const installedOllamaPresets =
    ollama && ollama.models
      ? ollama.models
          .filter((modelName) => !modelPresets.some((preset) => preset.provider === "ollama" && preset.model === modelName))
          .map(dynamicOllamaPreset)
      : [];
  const [rulesPreset, autoPreset, ...remainingPresets] = modelPresets;
  return [rulesPreset, autoPreset, ...installedOllamaPresets, ...remainingPresets].map(publicPresetShape);
}

function findModelPreset(id) {
  const preset = modelPresets.find((item) => item.id === id);
  if (preset) return preset;
  const prefix = "ollama_model__";
  if (typeof id === "string" && id.startsWith(prefix)) {
    const modelName = decodeURIComponent(id.slice(prefix.length));
    if (modelName) return dynamicOllamaPreset(modelName);
  }
  return null;
}

function modelOverridesFromPayload(payload = {}) {
  const preset = findModelPreset(payload.modelPreset);
  const manual = payload.modelOptions || {};
  return {
    provider: manual.provider || (preset && preset.provider),
    model: manual.model || (preset && preset.model),
    baseUrl: manual.baseUrl || (preset && preset.baseUrl),
    requiresApiKey: manual.requiresApiKey !== undefined ? manual.requiresApiKey : preset && preset.requiresApiKey,
    apiKey: typeof payload.apiKey === "string" && payload.apiKey.trim() ? payload.apiKey.trim() : "",
  };
}

function currentModelConfig(overrides = {}) {
  const provider = overrides.provider || process.env.MODEL_PROVIDER || modelConfig.provider || "auto";
  const baseUrl = overrides.baseUrl || process.env.MODEL_BASE_URL || (provider === "ollama" ? "http://localhost:11434" : modelConfig.baseUrl || "");
  const requiresApiKeyFromEnv = overrides.requiresApiKey !== undefined ? String(overrides.requiresApiKey) : process.env.MODEL_REQUIRES_API_KEY;
  const requiresApiKey =
    requiresApiKeyFromEnv === undefined ? !isLocalUrl(baseUrl) : String(requiresApiKeyFromEnv) === "true";
  const apiKey = overrides.apiKey || process.env.OPENAI_API_KEY || process.env.MODEL_API_KEY || "";
  return {
    provider,
    model: overrides.model || process.env.MODEL_NAME || modelConfig.model || "",
    baseUrl,
    timeoutMs: Number(process.env.MODEL_TIMEOUT_MS || modelConfig.timeoutMs || 30000),
    probeTimeoutMs: Number(process.env.MODEL_PROBE_TIMEOUT_MS || modelConfig.probeTimeoutMs || 1200),
    allowExternalForDemo: String(process.env.MODEL_ALLOW_EXTERNAL_FOR_DEMO || modelConfig.allowExternalForDemo) === "true",
    hasApiKey: Boolean(apiKey),
    apiKey,
    requiresApiKey,
    dataPolicy: modelConfig.dataPolicy || {},
  };
}

function isLocalUrl(value) {
  if (!value) return true;
  try {
    const url = new URL(value);
    return ["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(url.hostname);
  } catch (error) {
    return false;
  }
}

async function publicModelStatus() {
  const config = currentModelConfig();
  const adapters = await discoverLocalModelAdapters(config.probeTimeoutMs);
  const resolved = resolveModelConfig(config, adapters);
  const enabled = config.provider !== "off" && resolved.provider !== "off";
  const detectedLocal = adapters.some((adapter) => adapter.callable);
  return {
    mode: config.provider,
    provider: resolved.provider,
    adapter: resolved.adapterName || "",
    model: resolved.model,
    enabled,
    callable: Boolean(resolved.callable),
    detectedLocal,
    baseUrl: resolved.provider === "off" ? "" : resolved.baseUrl,
    requiresApiKey: Boolean(resolved.requiresApiKey),
    hasApiKey: config.hasApiKey,
    adapters,
    dataPolicy: config.dataPolicy,
    note:
      config.provider === "off"
        ? "模型调用层已预留但当前关闭。规则、知识库和病历审查可本地运行。"
        : resolved.callable
          ? "已识别可调用模型。真实病历仍需在院内授权环境处理。"
          : detectedLocal
            ? "已发现本地模型服务，但尚未取得可用模型名。"
            : "未发现本地模型服务。可安装并启动 Ollama、LM Studio 等本地模型，或配置外部 OpenAI-compatible 接口。",
  };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function probeJson(url, timeoutMs) {
  try {
    const response = await fetchWithTimeout(url, { method: "GET" }, timeoutMs);
    if (!response.ok) return { ok: false, status: response.status, error: response.statusText };
    return { ok: true, json: await response.json() };
  } catch (error) {
    return { ok: false, error: error.name === "AbortError" ? "timeout" : error.message };
  }
}

function extractModelNames(adapter, json) {
  if (adapter.modelListType === "ollama") {
    return Array.isArray(json.models) ? json.models.map((item) => item.name).filter(Boolean) : [];
  }
  if (adapter.modelListType === "openai") {
    return Array.isArray(json.data) ? json.data.map((item) => item.id).filter(Boolean) : [];
  }
  return [];
}

async function discoverLocalModelAdapters(timeoutMs) {
  const checks = localModelAdapters.map(async (adapter) => {
    const result = await probeJson(`${adapter.baseUrl.replace(/\/$/, "")}${adapter.modelsPath}`, timeoutMs);
    if (!result.ok) {
      return {
        id: adapter.id,
        name: adapter.name,
        provider: adapter.provider,
        baseUrl: adapter.baseUrl,
        detected: false,
        callable: false,
        models: [],
        defaultModel: "",
        error: result.error || String(result.status || ""),
      };
    }
    const models = extractModelNames(adapter, result.json);
    return {
      id: adapter.id,
      name: adapter.name,
      provider: adapter.provider,
      baseUrl: adapter.baseUrl,
      detected: true,
      callable: models.length > 0,
      models,
      defaultModel: models[0] || "",
      error: "",
    };
  });
  return Promise.all(checks);
}

function resolveModelConfig(config, adapters) {
  if (config.provider === "off") {
    return { ...config, provider: "off", callable: false, adapterName: "" };
  }
  if (config.provider === "auto") {
    const local = adapters.find((adapter) => adapter.callable);
    if (local) {
      return {
        ...config,
        provider: local.provider,
        model: config.model || local.defaultModel,
        baseUrl: local.baseUrl,
        callable: true,
        requiresApiKey: false,
        adapterName: local.name,
        adapterId: local.id,
      };
    }
    return { ...config, provider: "auto", callable: false, adapterName: "" };
  }
  if (config.provider === "ollama") {
    const baseUrl = config.baseUrl || "http://localhost:11434";
    const local = adapters.find((adapter) => adapter.provider === "ollama" && adapter.baseUrl === baseUrl);
    return {
      ...config,
      baseUrl,
      model: config.model || (local && local.defaultModel) || "",
      callable: Boolean(config.model || (local && local.callable)),
      requiresApiKey: false,
      adapterName: local ? local.name : "Ollama",
    };
  }
  if (config.provider === "openai_compatible") {
    const localOpenAI = isLocalUrl(config.baseUrl);
    const local = adapters.find((adapter) => adapter.provider === "openai_compatible" && adapter.baseUrl === config.baseUrl);
    return {
      ...config,
      model: config.model || (local && local.defaultModel) || "",
      callable: localOpenAI || !config.requiresApiKey || config.hasApiKey,
      requiresApiKey: !localOpenAI && config.requiresApiKey,
      adapterName: local ? local.name : localOpenAI ? "本地 OpenAI-compatible 服务" : "外部 OpenAI-compatible 服务",
    };
  }
  return { ...config, callable: false, adapterName: "" };
}

async function assertModelAllowed(payload) {
  const config = currentModelConfig(modelOverridesFromPayload(payload));
  const adapters = await discoverLocalModelAdapters(config.probeTimeoutMs);
  const resolved = resolveModelConfig(config, adapters);
  if (payload.containsRealPatientData && !resolved.dataPolicy.allowRealPatientData) {
    const error = new Error("Model call blocked: real patient data is not allowed by current data policy.");
    error.status = 403;
    throw error;
  }
  if (resolved.provider === "openai_compatible" && resolved.requiresApiKey && !resolved.hasApiKey) {
    const error = new Error("Missing API key for GPT/OpenAI-compatible provider. Enter a temporary API key in the model selector or set OPENAI_API_KEY.");
    error.status = 401;
    throw error;
  }
  if (!resolved.callable) {
    const error = new Error("No callable local model is available. Start Ollama/LM Studio or choose a GPT preset with an API key.");
    error.status = 409;
    throw error;
  }
  if (resolved.provider === "openai_compatible" && !isLocalUrl(resolved.baseUrl) && payload.containsRealPatientData) {
    const error = new Error("Model call blocked: external model providers cannot receive real patient data.");
    error.status = 403;
    throw error;
  }
  return resolved;
}

async function callModel(payload) {
  const config = await assertModelAllowed(payload);
  const messages = payload.messages || [
    {
      role: "system",
      content:
        "你是 VTE 专病智能体的模型增强层。必须保持临床辅助决策边界，不自动诊断、不自动开立医嘱。输出需提示医生确认。",
    },
    {
      role: "user",
      content: String(payload.prompt || ""),
    },
  ];

  if (config.provider === "openai_compatible") {
    const headers = { "Content-Type": "application/json" };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    const response = await fetchWithTimeout(
      `${config.baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: config.model,
          messages,
          temperature: typeof payload.temperature === "number" ? payload.temperature : 0.2,
        }),
      },
      config.timeoutMs,
    );
    const json = await response.json();
    if (!response.ok) {
      const error = new Error(json.error && json.error.message ? json.error.message : "Model call failed");
      error.status = response.status;
      throw error;
    }
    return {
      provider: config.provider,
      model: config.model,
      text: json.choices && json.choices[0] && json.choices[0].message ? json.choices[0].message.content : "",
      rawUsage: json.usage || null,
      boundary: "模型输出仅为辅助草案，需结合知识库证据、院内路径和医生确认。",
    };
  }

  if (config.provider === "ollama") {
    const response = await fetchWithTimeout(
      `${config.baseUrl.replace(/\/$/, "") || "http://localhost:11434"}/api/chat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: config.model,
          messages,
          stream: false,
          options: {
            temperature: typeof payload.temperature === "number" ? payload.temperature : 0.2,
            num_ctx: Number(payload.numCtx || 4096),
            num_predict: Number(payload.numPredict || 1200),
          },
        }),
      },
      config.timeoutMs,
    );
    const json = await response.json();
    if (!response.ok) {
      const error = new Error(json.error || "Ollama model call failed");
      error.status = response.status;
      throw error;
    }
    return {
      provider: config.provider,
      model: config.model,
      text: json.message ? json.message.content : "",
      rawUsage: null,
      boundary: "模型输出仅为辅助草案，需结合知识库证据、院内路径和医生确认。",
    };
  }

  const error = new Error(`Unsupported model provider: ${config.provider}`);
  error.status = 400;
  throw error;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 40_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function safeStaticPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const normalized = decoded === "/" ? "/index.html" : decoded;
  const filePath = path.normalize(path.join(PUBLIC_DIR, normalized));
  if (!filePath.startsWith(PUBLIC_DIR)) return null;
  return filePath;
}

function hasNegationNear(text, index) {
  const start = Math.max(0, index - 8);
  const prefix = text.slice(start, index);
  return rules.negations.some((word) => prefix.includes(word));
}

function matchAnyTerm(text, terms) {
  return terms.some((term) => {
    const index = text.indexOf(term);
    return index >= 0 && !hasNegationNear(text, index);
  });
}

const authoritativeEvidenceRules = [
  {
    label: "国外权威指南",
    score: 120,
    terms: [
      "guideline",
      "guidelines",
      "clinical practice guideline",
      "european society of cardiology",
      "esc",
      "american society of hematology",
      "ash",
      "american college of chest physicians",
      "accp",
      "chest guideline",
      "nice",
      "international society on thrombosis and haemostasis",
      "isth",
      "eha",
      "asco",
      "european society for vascular surgery",
      "esvs",
      "society for vascular surgery",
      "svs",
    ],
  },
  {
    label: "国内中华级指南/共识",
    score: 110,
    terms: [
      "中华医学会",
      "中华",
      "中国医师协会",
      "中国专家共识",
      "专家共识",
      "指南",
      "中华医学杂志",
      "中华外科杂志",
      "中华血液学杂志",
      "中华结核和呼吸杂志",
      "中华护理杂志",
      "中国实用外科杂志",
    ],
  },
  {
    label: "系统综述/Meta分析",
    score: 70,
    terms: ["systematic review", "meta-analysis", "meta analysis", "cochrane", "系统综述", "meta分析", "荟萃分析"],
  },
  {
    label: "高质量综述/共识相关",
    score: 45,
    terms: ["review", "narrative review", "consensus", "statement", "综述", "共识"],
  },
  {
    label: "真实世界/队列研究",
    score: 25,
    terms: ["cohort", "registry", "real-world", "observational", "队列", "真实世界", "注册登记"],
  },
];

function evidenceAuthority(item) {
  const title = String(item.title || "").toLowerCase();
  const studyType = String((item.evidence && item.evidence.studyType) || item.type || "").toLowerCase();
  const journal = String((item.evidence && item.evidence.journal) || "").toLowerCase();
  const source = String(item.source || "").toLowerCase();
  const screening = String((item.evidence && item.evidence.screeningConclusion) || "").toLowerCase();
  const strongText = [title, studyType, journal, source, screening]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const priorityScore = Number((item.evidence && item.evidence.priorityScore) || 0);
  const sourceTier = item.evidence && item.evidence.sourceTier;
  const sourceTierScore = sourceTier === "core_guideline" ? 220 : sourceTier === "priority" ? 10 : 0;
  const isLetterOrComment = /\b(letter|comment|editorial|reply)\b/i.test(title) || /述评|评论|来信/.test(item.title || "");
  const hasForeignGuideline =
    /\b(clinical practice guideline|practice guideline|guideline for|guideline on|guidelines for|guidelines on|consensus|statement|recommendations)\b/i.test(`${title} ${studyType}`) ||
    (/\b(ash|esc|accp|nice|chest|asco|esvs|svs|isth|eha)\b/i.test(`${journal} ${source}`) &&
      /\b(clinical practice guideline|practice guideline|guidelines for|guidelines on|consensus|statement|recommendations)\b/i.test(`${title} ${studyType}`));
  const hasDomesticGuideline =
    /指南|共识|推荐意见|解读/.test(`${item.title || ""} ${(item.evidence && item.evidence.studyType) || ""}`) &&
    /中华|中国|医学会|医师协会|专家/.test(`${item.title || ""} ${item.source || ""} ${(item.evidence && item.evidence.journal) || ""}`);
  const hasChineseGuideline = /[\u4e00-\u9fff]/.test(item.title || "") && /指南|共识|推荐意见|解读/.test(`${item.title || ""} ${(item.evidence && item.evidence.studyType) || ""}`);
  const hasSystematicReview = /systematic review|meta-analysis|meta analysis|cochrane|系统综述|meta分析|荟萃分析/i.test(`${title} ${studyType}`);
  const hasReview = /\breview\b|narrative review|综述/i.test(`${title} ${studyType}`);
  const hasCohort = /cohort|registry|real-world|observational|队列|真实世界|注册登记/i.test(`${title} ${studyType}`);

  let label = priorityScore >= 6 ? "优先文献" : "普通文献";
  let baseScore = 0;
  if (sourceTier === "core_guideline") {
    label = hasDomesticGuideline || hasChineseGuideline ? "核心国内指南" : "核心指南";
    baseScore = 180;
  } else if (hasForeignGuideline && !isLetterOrComment) {
    label = "国外权威指南";
    baseScore = 120;
  } else if (hasDomesticGuideline) {
    label = "国内中华级指南/共识";
    baseScore = 110;
  } else if (hasChineseGuideline) {
    label = "国内指南/共识";
    baseScore = 95;
  } else if (hasSystematicReview) {
    label = "系统综述/Meta分析";
    baseScore = 70;
  } else if (hasReview) {
    label = "高质量综述/共识相关";
    baseScore = 45;
  } else if (hasCohort) {
    label = "真实世界/队列研究";
    baseScore = 25;
  }
  return {
    label,
    score: baseScore + priorityScore * 3 + sourceTierScore,
    priorityScore,
  };
}

function subtypeFitScore(query, item) {
  const q = query.toLowerCase();
  const itemSubtype = [
    item.evidence && item.evidence.vteSubtype,
    item.scenario && item.scenario.join(" "),
    item.title,
    item.content,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const asksPE = /\bpe\b|pulmonary embolism|肺栓塞|肺动脉栓塞|肺血栓栓塞/.test(q);
  const asksDVT = /\bdvt\b|deep vein thrombosis|深静脉血栓|下肢静脉血栓|静脉血栓形成/.test(q);
  const asksLowerLimb = /下肢|lower limb|lower extremity|髂股|股静脉|胫|小腿|左下肢|右下肢/.test(q);
  const asksPhlegmasia = /股青肿|phlegmasia|肢体灌注|皮温降低|张力/.test(q);
  const asksPregnancy = /妊娠|怀孕|孕|pregnan/.test(q);
  const itemPE = /\bpe\b|pulmonary embolism|肺栓塞|肺动脉栓塞|肺血栓栓塞/.test(itemSubtype);
  const itemDVT = /\bdvt\b|deep vein thrombosis|深静脉血栓|下肢静脉血栓|静脉血栓形成/.test(itemSubtype);
  const itemLowerLimb = /下肢|lower limb|lower extremity|iliofemoral|femoral|髂股|股静脉|胫|小腿/.test(itemSubtype);
  const itemUpperExtremity = /upper extremity|upper limb|上肢/.test(itemSubtype);
  const itemPhlegmasia = /股青肿|phlegmasia|limb-threatening|limb salvage|静脉性坏疽/.test(itemSubtype);
  const itemPregnancy = /妊娠|怀孕|孕|pregnan|产褥|产后/.test(itemSubtype);
  let score = 0;
  if (asksPE && itemPE) score += 45;
  if (asksDVT && itemDVT) score += 45;
  if (asksLowerLimb && itemLowerLimb) score += 35;
  if (asksLowerLimb && itemUpperExtremity && !itemLowerLimb) score -= 95;
  if (asksPhlegmasia && itemPhlegmasia) score += 90;
  if (asksPregnancy && itemPregnancy) score += 80;
  if (asksPE && itemDVT && !itemPE) return -40;
  if (asksDVT && itemPE && !itemDVT) return -25;
  return score;
}

function yearScore(item) {
  const year = Number(item.year || (item.evidence && String(item.evidence.publicationDate || "").slice(0, 4)) || 0);
  if (!year) return 0;
  const age = Math.max(0, new Date().getFullYear() - year);
  return Math.max(0, 30 - age * 3);
}

function retrieveKnowledge(query, limit = 5) {
  const normalized = query.toLowerCase();
  const uniqueChars = Array.from(new Set(query.replace(/\s/g, ""))).filter(Boolean);

  return knowledgeBase
    .map((item) => {
      const authority = evidenceAuthority(item);
      const keywordScore = item.keywords.reduce((score, keyword) => {
        const key = keyword.toLowerCase();
        return score + (normalized.includes(key) || query.includes(keyword) ? 3 : 0);
      }, 0);
      const scenarioScore = item.scenario.reduce((score, keyword) => {
        return score + (query.includes(keyword) ? 2 : 0);
      }, 0);
      const charScore = uniqueChars.reduce((score, char) => {
        return score + (item.content.includes(char) || item.title.includes(char) ? 0.05 : 0);
      }, 0);
      const relevanceScore = keywordScore + scenarioScore + charScore;
      const recencyScore = yearScore(item);
      const subtypeScore = subtypeFitScore(query, item);
      const totalScore = relevanceScore * 18 + authority.score + recencyScore + subtypeScore;
      return {
        id: item.id,
        type: item.type,
        title: item.title,
        source: item.source,
        year: item.year,
        content: item.content,
        fulltextStatus: item.evidence && item.evidence.fulltextStatus,
        localFulltextPath: item.evidence && item.evidence.localFulltextPath,
        priorityScore: item.evidence && item.evidence.priorityScore,
        evidenceTier: authority.label,
        authorityScore: Number(authority.score.toFixed(2)),
        recencyScore: Number(recencyScore.toFixed(2)),
        subtypeScore: Number(subtypeScore.toFixed(2)),
        relevanceScore: Number(relevanceScore.toFixed(2)),
        score: Number(totalScore.toFixed(2)),
      };
    })
    .filter((item) => item.relevanceScore > 0)
    .sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (scoreDiff !== 0) return scoreDiff;
      const yearDiff = Number(b.year || 0) - Number(a.year || 0);
      if (yearDiff !== 0) return yearDiff;
      return b.authorityScore - a.authorityScore;
    })
    .slice(0, limit);
}

function normalizePatientContext(payload) {
  if (payload.caseText) return String(payload.caseText);
  if (payload.text) return String(payload.text);
  const context = payload.patientContext || payload;
  const parts = [
    context.department && `科室：${context.department}`,
    context.age && `年龄：${context.age}`,
    context.sex && `性别：${context.sex}`,
    Array.isArray(context.diagnoses) && `诊断：${context.diagnoses.join("；")}`,
    Array.isArray(context.procedures) && `手术操作：${context.procedures.join("；")}`,
    Array.isArray(context.labs) &&
      `检验：${context.labs.map((lab) => `${lab.name || ""}${lab.value || ""}${lab.unit || ""}`).join("；")}`,
    Array.isArray(context.orders) && `医嘱：${context.orders.join("；")}`,
    Array.isArray(context.nursingRecords) && `护理记录：${context.nursingRecords.join("；")}`,
    context.freeText && `病历摘要：${context.freeText}`,
  ];
  return parts.filter(Boolean).join("\n");
}

function extractAge(text) {
  const patterns = [
    /(?:年龄|age)[:：\s]*(\d{1,3})/i,
    /(\d{1,3})\s*岁/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const age = Number(match[1]);
      if (age > 0 && age < 120) return age;
    }
  }
  return null;
}

function extractBmi(text) {
  const match = text.match(/(?:BMI|体重指数)\s*[:：]?\s*(\d{1,2}(?:\.\d+)?)/i);
  if (!match) return null;
  const bmi = Number(match[1]);
  return bmi > 10 && bmi < 80 ? bmi : null;
}

function extractPlateletCount(text) {
  const patterns = [
    /(?:PLT|血小板)\s*[:：]?\s*(\d{1,4}(?:\.\d+)?)\s*(?:x|×)?\s*10\^?9/i,
    /(?:PLT|血小板)\s*[:：]?\s*(\d{1,4}(?:\.\d+)?)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const value = Number(match[1]);
      if (value > 0 && value < 1000) return value;
    }
  }
  return null;
}

function addRiskFactorOnce(items, factor) {
  const index = items.findIndex((item) => item.key === factor.key);
  if (index >= 0) {
    items[index] = factor;
    return;
  }
  items.push(factor);
}

function buildRiskFactors(text) {
  const riskFactors = rules.riskFactors
    .filter((rule) => !["age", "obesity"].includes(rule.key))
    .filter((rule) => matchAnyTerm(text, rule.terms))
    .map((rule) => ({
      key: rule.key,
      label: rule.label,
      weight: rule.weight,
      matchedTerms: rule.terms.filter((term) => text.includes(term)),
    }));

  const age = extractAge(text);
  if ((age !== null && age >= 60) || matchAnyTerm(text, ["高龄", "年龄大"])) {
    const rule = rules.riskFactors.find((item) => item.key === "age");
    addRiskFactorOnce(riskFactors, {
      key: "age",
      label: rule ? rule.label : "年龄相关风险",
      weight: rule ? rule.weight : 1,
      matchedTerms: [age !== null ? `${age}岁` : "高龄"].filter(Boolean),
    });
  }

  const bmi = extractBmi(text);
  if ((bmi !== null && bmi >= 25) || matchAnyTerm(text, ["肥胖"])) {
    const rule = rules.riskFactors.find((item) => item.key === "obesity");
    addRiskFactorOnce(riskFactors, {
      key: "obesity",
      label: rule ? rule.label : "肥胖或体重相关风险",
      weight: rule ? rule.weight : 1,
      matchedTerms: [bmi !== null ? `BMI ${bmi}` : "肥胖"].filter(Boolean),
    });
  }

  if (hasChronicImmobility(text)) {
    const rule = rules.riskFactors.find((item) => item.key === "immobility");
    addRiskFactorOnce(riskFactors, {
      key: "immobility",
      label: rule ? rule.label : "活动减少或卧床",
      weight: rule ? rule.weight : 2,
      matchedTerms: ["截瘫/长期制动"],
    });
  }

  return riskFactors;
}

function buildBleedingFlags(text) {
  const bleedingFlags = rules.bleedingFlags
    .filter((rule) => matchAnyTerm(text, rule.terms))
    .map((rule) => ({
      key: rule.key,
      label: rule.label,
      matchedTerms: rule.terms.filter((term) => text.includes(term)),
    }));

  const plateletCount = extractPlateletCount(text);
  if (plateletCount !== null && plateletCount < 50) {
    const rule = rules.bleedingFlags.find((item) => item.key === "thrombocytopenia");
    addRiskFactorOnce(bleedingFlags, {
      key: "thrombocytopenia",
      label: rule ? rule.label : "血小板降低需核查抗凝安全性",
      matchedTerms: [`PLT ${plateletCount}`],
    });
  }

  return bleedingFlags;
}

function factorSet(riskFactors) {
  return new Set(riskFactors.map((item) => item.key));
}

function scoreBand(score, cutoffs) {
  if (score >= cutoffs.high) return "高风险";
  if (score >= cutoffs.medium) return "中风险";
  return "低风险";
}

function buildScaleScores(text, riskFactors, urgentFlags) {
  const risks = factorSet(riskFactors);
  const age = extractAge(text);
  const hasDvtSymptoms = urgentFlags.some((item) => item.key === "acute_symptomatic_dvt" || item.key === "limb_ischemia");
  const hasPeSymptoms = urgentFlags.some((item) => item.key === "suspected_pe");
  const capriniItems = [
    risks.has("age") && { label: age && age >= 75 ? "高龄（≥75岁或文本提示高龄）" : "年龄相关风险", points: age && age >= 75 ? 3 : 1 },
    risks.has("surgery") && { label: "手术或围术期状态", points: 2 },
    risks.has("cancer") && { label: "恶性肿瘤或肿瘤相关治疗", points: 2 },
    risks.has("immobility") && { label: "卧床/活动减少", points: 1 },
    risks.has("obesity") && { label: "BMI升高/肥胖相关风险", points: 1 },
    risks.has("pregnancy") && { label: "妊娠/产褥期相关风险", points: 1 },
    risks.has("prior_vte") && { label: "既往VTE或当前VTE事件", points: 3 },
    risks.has("fracture") && { label: "创伤或骨科高风险场景", points: 2 },
  ].filter(Boolean);
  const capriniScore = capriniItems.reduce((sum, item) => sum + item.points, 0);

  const paduaItems = [
    risks.has("cancer") && { label: "活动性肿瘤/肿瘤相关风险", points: 3 },
    risks.has("immobility") && { label: "活动减少或卧床", points: 3 },
    risks.has("prior_vte") && { label: "既往VTE", points: 3 },
    age && age >= 70 && { label: "年龄≥70岁", points: 1 },
    risks.has("obesity") && { label: "BMI升高/肥胖", points: 1 },
  ].filter(Boolean);
  const paduaScore = paduaItems.reduce((sum, item) => sum + item.points, 0);

  const wellsDvtItems = [
    risks.has("cancer") && { label: "肿瘤相关风险", points: 1 },
    risks.has("immobility") && { label: "卧床/制动或近期活动减少", points: 1 },
    hasDvtSymptoms && { label: "下肢肿痛或疑似DVT体征", points: 1 },
    urgentFlags.some((item) => item.key === "limb_ischemia") && { label: "肢体灌注受威胁/股青肿线索", points: 1 },
  ].filter(Boolean);
  const wellsDvtScore = wellsDvtItems.reduce((sum, item) => sum + item.points, 0);

  const wellsPeItems = hasPeSymptoms
    ? [
        { label: "呼吸困难、胸痛、咯血或疑似PE线索", points: 3 },
        hasDvtSymptoms && { label: "合并DVT症状体征", points: 3 },
        risks.has("cancer") && { label: "肿瘤相关风险", points: 1 },
        risks.has("immobility") && { label: "卧床/制动", points: 1 },
      ].filter(Boolean)
    : [];
  const wellsPeScore = wellsPeItems.reduce((sum, item) => sum + item.points, 0);

  return [
    {
      name: "Caprini",
      score: capriniScore,
      band: scoreBand(capriniScore, { medium: 3, high: 5 }),
      items: capriniItems,
      note: "演示性估算，正式使用需接入完整Caprini结构化变量并由医生确认。",
    },
    {
      name: "Padua",
      score: paduaScore,
      band: paduaScore >= 4 ? "高风险" : "低-中风险",
      items: paduaItems,
      note: "适用于内科住院患者风险评估场景；围术期病例仅作辅助参考。",
    },
    {
      name: "Wells DVT/PE",
      score: wellsDvtScore + wellsPeScore,
      band: hasPeSymptoms ? "需排查PE" : hasDvtSymptoms ? "需排查DVT" : "未触发急症评分",
      items: [...wellsDvtItems, ...wellsPeItems],
      note: "用于提示DVT/PE诊断路径关注点，不替代正式Wells评分和临床判断。",
    },
  ];
}

function buildWorkflowReminders(text, riskLevel, riskFactors, bleedingFlags, urgentFlags) {
  const hasUrgent = urgentFlags.length > 0;
  const hasBleeding = bleedingFlags.length > 0;
  const reminders = [
    {
      node: "入院24小时内评估",
      status: /入院|住院|入科/.test(text) ? "已触发" : "待条件触发",
      priority: riskLevel === "高危" || hasUrgent ? "重点" : "常规",
      detail: "完成VTE风险评估、出血风险核查和基础预防宣教记录。",
    },
    {
      node: "术前/术后24小时复评",
      status: /术前|拟行|手术|术后|围术期/.test(text) ? "已触发" : "待条件触发",
      priority: riskLevel === "高危" ? "重点" : "常规",
      detail: "结合手术方式、卧床、出血风险和预防措施执行状态进行动态复评。",
    },
    {
      node: "急症线索即时处理",
      status: hasUrgent ? "已触发" : "未触发",
      priority: hasUrgent ? "急症" : "常规",
      detail: hasUrgent ? "急症处理优先于普通预防，需医生床旁复核、影像路径和会诊确认。" : "未识别疑似PE、症状性DVT或股青肿等急症线索。",
    },
    {
      node: "抗凝安全核查",
      status: hasBleeding ? "已触发" : "建议核对",
      priority: hasBleeding ? "重点" : "常规",
      detail: hasBleeding ? "当前存在出血/禁忌信号，药物预防或治疗性抗凝需先由医生确认。" : "正式决策前仍需核对血小板、凝血、肝肾功能和手术状态。",
    },
    {
      node: "出院前24小时教育与随访",
      status: /出院|随访|复诊/.test(text) ? "已触发" : "待条件触发",
      priority: riskLevel === "高危" ? "重点" : "常规",
      detail: "生成警示症状、活动、抗凝注意事项、复诊和随访计划。",
    },
  ];
  return reminders;
}

function buildQualityIndicators(text, riskLevel, riskFactors, bleedingFlags, urgentFlags) {
  const hasUrgent = urgentFlags.length > 0;
  const hasBleeding = bleedingFlags.length > 0;
  const status = (ok) => (ok ? "已见记录" : "需完善");
  return [
    {
      name: "风险评估",
      status: riskFactors.length ? "已识别风险因素" : "需补充变量",
      level: riskLevel === "高危" ? "重点" : "常规",
      detail: riskFactors.length ? `已识别${riskFactors.length}项风险因素，需与正式量表记录核对。` : "建议补充年龄、手术、肿瘤、卧床、妊娠、既往VTE等结构化字段。",
    },
    {
      name: "出血评估",
      status: hasBleeding ? "已触发禁忌核查" : status(/血小板|凝血|肝肾功能|活动性出血|出血/.test(text)),
      level: hasBleeding ? "重点" : "常规",
      detail: hasBleeding ? "存在出血/禁忌信号，应记录医生判断和替代预防方案。" : "未触发明显禁忌，但应保留血小板、凝血、肝肾功能核查记录。",
    },
    {
      name: "预防措施",
      status: status(/机械预防|药物预防|低分子肝素|间歇充气|弹力袜|活动指导/.test(text)),
      level: riskLevel === "高危" ? "重点" : "常规",
      detail: "应记录基础预防、机械预防、药物预防或未执行原因。",
    },
    {
      name: "动态复评",
      status: status(/复评|术后24小时|术后 24 小时|转科|病情变化/.test(text)),
      level: hasUrgent ? "重点" : "常规",
      detail: "入院、术后、转科、病情变化和出院前应形成复评闭环。",
    },
    {
      name: "急症处理",
      status: hasUrgent ? "需即时复核" : "未触发",
      level: hasUrgent ? "重点" : "常规",
      detail: hasUrgent ? "需记录医生床旁复核、影像检查、会诊和后续处置。" : "当前未识别急症线索。",
    },
    {
      name: "出院教育",
      status: status(/出院教育|随访|复诊|宣教|警示症状/.test(text)),
      level: riskLevel === "高危" ? "重点" : "常规",
      detail: "应说明DVT/PE警示症状、活动建议、抗凝注意事项和复诊计划。",
    },
  ];
}

function buildPatientEducation(text, riskLevel, riskFactors, bleedingFlags, urgentFlags) {
  const risks = factorSet(riskFactors);
  const items = [];
  if (urgentFlags.length) {
    items.push({
      title: "警示症状",
      detail: "若出现或加重下肢肿痛、皮温改变、胸痛、呼吸困难、咯血、晕厥等情况，应立即告知医护人员或及时就医。",
    });
  }
  if (risks.has("pregnancy")) {
    items.push({
      title: "妊娠相关提醒",
      detail: "妊娠状态下任何抗凝、影像检查和活动建议均需医生结合产科情况确认，不自行停药或用药。",
    });
  }
  if (bleedingFlags.length) {
    items.push({
      title: "出血观察",
      detail: "关注皮肤瘀斑、牙龈出血、黑便、血尿、异常阴道出血等情况，出现异常及时报告。",
    });
  }
  items.push(
    {
      title: "活动与基础预防",
      detail: riskLevel === "高危" ? "在医生允许范围内尽早活动，避免长时间不动；机械预防和活动计划需按医护指导执行。" : "保持适度活动和补液，避免长期制动，病情变化或手术前后需重新评估。",
    },
    {
      title: "出院随访",
      detail: "出院前应明确复诊时间、抗凝注意事项、警示症状和联系方式；若症状变化，不等待下次预约。",
    },
  );
  return items;
}

function clampPercent(value) {
  return Math.max(1, Math.min(88, Math.round(value)));
}

function riskBandFromProbability(value) {
  if (value >= 65) return "极高";
  if (value >= 40) return "高";
  if (value >= 20) return "中";
  return "低";
}

function extractGestationalWeeks(text) {
  const patterns = [
    /(?:怀孕|妊娠|孕)\s*(\d{1,2}(?:\.\d+)?)\s*(?:周|w|W)/,
    /孕周\s*[:：]?\s*(\d{1,2}(?:\.\d+)?)/,
    /停经\s*(\d{1,2}(?:\.\d+)?)\s*(?:周|w|W)/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const weeks = Number(match[1]);
      if (weeks > 0 && weeks <= 43) return weeks;
    }
  }
  return null;
}

function hasChronicImmobility(text) {
  return /截瘫|偏瘫|瘫痪|脊髓损伤|长期卧床|长期制动|卧床\s*\d+\s*(?:月|年)|制动\s*\d+\s*(?:月|年)/.test(text);
}

function projectedPregnancyPhase(gestationalWeeks, hours, hasPostpartum, pointKey) {
  if (hasPostpartum || pointKey === "postpartum6w") return "产褥/产后窗口";
  if (pointKey === "delivery") return "足月/分娩窗口";
  if (!gestationalWeeks) return "妊娠状态";
  const projectedWeeks = gestationalWeeks + hours / 168;
  if (projectedWeeks < 14) return "早孕期";
  if (projectedWeeks < 28) return "中孕期";
  if (projectedWeeks < 37) return "晚孕期";
  if (projectedWeeks <= 42) return "足月/分娩窗口";
  return "产褥/产后窗口";
}

function pregnancyComponent(phase) {
  return {
    早孕期: 5,
    中孕期: 7,
    晚孕期: 10,
    "足月/分娩窗口": 15,
    "产褥/产后窗口": 18,
    妊娠状态: 8,
  }[phase] || 0;
}

function canonicalPredictionKey(point) {
  if (point.key === "delivery" || point.label === "足月/分娩期") return "delivery";
  if (point.key === "postpartum6w" || point.label === "产后6周") return "postpartum6w";
  if (point.hours === 0) return "now";
  if (point.hours === 24) return "24h";
  if (point.hours === 72) return "72h";
  if (point.hours === 168) return "7d";
  if (point.hours === 336) return "14d";
  if (point.hours === 720) return "30d";
  if (point.hours === 2160) return "90d";
  if (point.hours === 4320) return "180d";
  if (point.hours === 6480) return "270d";
  return point.key;
}

function componentValue(point, context) {
  const { hasUrgentDvt, hasSuspectedPe, hasSurgery, hasCancer, hasImmobility, chronicImmobility, hasPregnancy, gestationalWeeks, hasPostpartum, hasBleeding, age, hasObesity, caprini, padua } = context;
  const key = canonicalPredictionKey(point);
  let value = 0;
  const reasons = [];

  const acuteDvtMap = { now: 24, "24h": 25, "72h": 21, "7d": 14, "14d": 10, "30d": 7, "90d": 5, "180d": 4, "270d": 4, delivery: 5, postpartum6w: 5 };
  const acutePeMap = { now: 22, "24h": 24, "72h": 20, "7d": 13, "14d": 9, "30d": 6, "90d": 4, "180d": 3, "270d": 3, delivery: 4, postpartum6w: 4 };
  const surgeryMap = { now: 6, "24h": 10, "72h": 15, "7d": 14, "14d": 10, "30d": 6, "90d": 3, "180d": 2, "270d": 2, delivery: 3, postpartum6w: 3 };
  const shortImmobilityMap = { now: 7, "24h": 9, "72h": 11, "7d": 11, "14d": 9, "30d": 6, "90d": 3, "180d": 2, "270d": 2, delivery: 4, postpartum6w: 4 };
  const chronicImmobilityMap = { now: 14, "24h": 15, "72h": 16, "7d": 17, "14d": 17, "30d": 16, "90d": 15, "180d": 14, "270d": 14, delivery: 15, postpartum6w: 15 };

  if (hasUrgentDvt) {
    value += acuteDvtMap[key] || 4;
    reasons.push("急性症状性DVT/股青肿线索");
  }
  if (hasSuspectedPe) {
    value += acutePeMap[key] || 3;
    reasons.push("疑似PE急症线索");
  }
  if (hasSurgery) {
    value += surgeryMap[key] || 2;
    reasons.push("围术期风险");
  }
  if (hasImmobility) {
    value += chronicImmobility ? chronicImmobilityMap[key] || 14 : shortImmobilityMap[key] || 2;
    reasons.push(chronicImmobility ? "截瘫/长期制动导致持续风险" : "卧床/活动减少");
  }
  if (hasPregnancy) {
    const phase = projectedPregnancyPhase(gestationalWeeks, point.hours, hasPostpartum, key);
    value += pregnancyComponent(phase);
    reasons.push(phase);
  }
  if (age && age >= 60) {
    const ageComponent = age >= 80 ? 10 : age >= 70 ? 7 : 4;
    const longHorizonAdd = point.hours >= 4320 ? 2 : point.hours >= 2160 ? 1 : 0;
    value += ageComponent + longHorizonAdd;
    reasons.push(age >= 80 ? "高龄持续基线风险" : "年龄相关持续风险");
  }
  if (hasCancer) {
    value += point.hours >= 720 ? 9 : 8;
    reasons.push("肿瘤相关持续风险");
  }
  if (hasObesity) {
    value += 3;
    reasons.push("BMI/肥胖相关风险");
  }
  if (caprini && Number(caprini.score) >= 5) value += 2;
  if (padua && Number(padua.score) >= 4) value += 2;
  if (hasBleeding) reasons.push("出血/禁忌影响防治路径");

  return { value, reasons };
}

function buildPredictionTimePoints(context) {
  const points = [
    { key: "now", label: "当前", hours: 0 },
    { key: "24h", label: "24小时", hours: 24 },
    { key: "72h", label: "72小时", hours: 72 },
    { key: "7d", label: "7天", hours: 168 },
    { key: "14d", label: "14天", hours: 336 },
    { key: "30d", label: "30天", hours: 720 },
    { key: "90d", label: "90天", hours: 2160 },
  ];

  if (context.hasPregnancy && context.gestationalWeeks && !context.hasPostpartum) {
    const daysToDelivery = Math.max(0, Math.round((40 - context.gestationalWeeks) * 7));
    if (daysToDelivery > 0 && daysToDelivery <= 280) {
      points.push({ key: "delivery", label: "足月/分娩期", hours: daysToDelivery * 24 });
      points.push({ key: "postpartum6w", label: "产后6周", hours: (daysToDelivery + 42) * 24 });
    }
  }

  if (context.chronicImmobility || context.hasCancer || (context.age && context.age >= 70)) {
    points.push({ key: "180d", label: "180天", hours: 4320 });
  }

  const eventWindows = buildEventWindows(context);
  eventWindows.forEach((item) => {
    points.push({ key: `event:${item.key}`, label: item.label, hours: item.hours });
  });

  return points
    .filter((point, index, array) => array.findIndex((item) => item.label === point.label && item.hours === point.hours) === index)
    .sort((a, b) => a.hours - b.hours);
}

function buildRiskPredictionTrajectory(text, riskLevel, riskFactors, bleedingFlags, urgentFlags, scaleScores) {
  const risks = factorSet(riskFactors);
  const urgentKeys = new Set(urgentFlags.map((item) => item.key));
  const hasUrgentDvt = urgentKeys.has("acute_symptomatic_dvt") || urgentKeys.has("limb_ischemia");
  const hasSuspectedPe = urgentKeys.has("suspected_pe");
  const hasSurgery = risks.has("surgery");
  const hasPregnancy = risks.has("pregnancy");
  const hasCancer = risks.has("cancer");
  const chronicImmobility = hasChronicImmobility(text);
  const hasImmobility = risks.has("immobility") || chronicImmobility;
  const hasBleeding = bleedingFlags.length > 0;
  const age = extractAge(text);
  const hasObesity = risks.has("obesity");
  const gestationalWeeks = extractGestationalWeeks(text);
  const hasPostpartum = /\b产后\b|产褥|分娩后|剖宫产后|顺产后/.test(text);
  const caprini = (scaleScores || []).find((item) => item.name === "Caprini");
  const padua = (scaleScores || []).find((item) => item.name === "Padua");
  const context = {
    hasUrgentDvt,
    hasSuspectedPe,
    hasSurgery,
    hasPregnancy,
    gestationalWeeks,
    hasPostpartum,
    hasCancer,
    hasImmobility,
    chronicImmobility,
    hasBleeding,
    age,
    hasObesity,
    caprini,
    padua,
  };
  const base = riskLevel === "高危" ? 18 : riskLevel === "中危" ? 10 : 4;
  const timePoints = buildPredictionTimePoints(context);
  const shape = timePoints.map((point) => {
    const component = componentValue(point, context);
    const probability = clampPercent(base + component.value);
    return {
      ...point,
      probability,
      band: riskBandFromProbability(probability),
      phase: component.reasons.slice(0, 3).join(" / ") || "常规复评",
    };
  });

  const peak = shape.reduce((max, item) => (item.probability > max.probability ? item : max), shape[0]);
  const contributors = [
    hasUrgentDvt && "症状性下肢DVT/股青肿线索使当前至24小时窗口显著前移",
    hasSuspectedPe && "呼吸困难等疑似PE线索提示需优先急症排查",
    hasSurgery && "手术或围术期状态使术后72小时至7天风险上升",
    hasImmobility && (chronicImmobility ? "截瘫/长期制动提示风险呈持续平台型，而不是短期下降型" : "短期卧床或活动减少增加住院早期风险"),
    hasPregnancy &&
      (gestationalWeeks
        ? `当前孕${gestationalWeeks}周，轨迹按孕周外推；若进入足月分娩或产褥期，风险窗口需重新抬升`
        : "妊娠状态使抗凝安全、影像路径和随访窗口需要单独管理"),
    age && age >= 60 && "年龄相关风险主要表现为持续基线风险升高，需结合虚弱、感染、手术和卧床动态复评",
    hasCancer && "肿瘤相关状态使围术期和出院后风险持续",
    hasBleeding && "出血/禁忌信号不会降低血栓风险，但会改变预防和治疗路径",
  ].filter(Boolean);
  const clinicalAnchors = [
    hasPregnancy &&
      (gestationalWeeks
        ? `孕周锚点：当前约孕${gestationalWeeks}周，预计足月/分娩窗口约在${Math.max(0, Math.round((40 - gestationalWeeks) * 7))}天后，产后6周仍需关注。`
        : "妊娠锚点：需补充孕周、预产期、产科风险和产褥期状态。"),
    chronicImmobility && "制动锚点：截瘫/长期卧床患者应显示持续平台型风险，并纳入皮肤、感染、康复和机械预防依从性。",
    age && age >= 60 && `年龄锚点：${age}岁，年龄本身不造成短期尖峰，但会抬高长期基线，并放大手术、感染、卧床等触发因素。`,
    hasSurgery && "围术期锚点：术前、术后24小时、72小时、7天和出院前应分别复评。",
    hasCancer && "肿瘤锚点：肿瘤相关VTE风险常延续至出院后和治疗周期内，管理端应纳入随访窗口。",
  ].filter(Boolean);

  return {
    modelSource: "MVP 演示性规则轨迹，可替换为华西真实世界数据训练并校准的时间事件模型。",
    targetEvent: "VTE 发生/进展或已存在急性VTE需处理事件的临床预警概率",
    unit: "%",
    peakWindow: peak.label,
    peakProbability: peak.probability,
    currentProbability: shape[0].probability,
    trajectory: shape,
    topContributors: contributors.length ? contributors : ["当前文本风险变量有限，建议补充结构化评分表、检验、手术和护理记录。"],
    clinicalAnchors,
    drivers: contributors.length ? contributors : ["当前文本风险变量有限，建议补充结构化评分表、检验、手术和护理记录。"],
    anchors: clinicalAnchors,
    eventWindows: buildEventWindows({
      hasPregnancy,
      gestationalWeeks,
      hasPostpartum,
      hasSurgery,
      hasCancer,
      hasImmobility,
      chronicImmobility,
      hasUrgentDvt,
      hasSuspectedPe,
      age,
    }),
    suggestedUse:
      hasUrgentDvt || hasSuspectedPe
        ? "当前存在急症线索，风险曲线用于提示处置优先级；不能替代床旁查体、影像确认和医生决策。"
        : "用于单病例动态复评、队列预警排序、管理驾驶舱和后续真实世界模型验证。",
    validationPlan: [
      "接入院内结构化变量、自然语言抽取变量和时间戳。",
      "用近20年脱敏病例建立时间事件数据集，区分院内发生、术后发生、出院后发生和既往已存在事件。",
      "采用训练/验证/时间外验证，并报告校准曲线、决策曲线、敏感度、特异度和报警负担。",
    ],
  };
}

function buildEventWindows(context) {
  const windows = [
    { key: "now", label: "当前", hours: 0, reason: "当前病情状态" },
    { key: "24h", label: "24小时", hours: 24, reason: "入院/急症复核窗口" },
    { key: "72h", label: "72小时", hours: 72, reason: "短期演变窗口" },
    { key: "7d", label: "7天", hours: 168, reason: "住院早期风险窗口" },
    { key: "14d", label: "14天", hours: 336, reason: "短期随访窗口" },
    { key: "30d", label: "30天", hours: 720, reason: "出院后早期风险窗口" },
    { key: "90d", label: "90天", hours: 2160, reason: "中期复评窗口" },
  ];

  if (context.hasPregnancy && context.gestationalWeeks && !context.hasPostpartum) {
    const daysToDelivery = Math.max(0, Math.round((40 - context.gestationalWeeks) * 7));
    if (daysToDelivery > 0 && daysToDelivery <= 280) {
      windows.push(
        { key: "delivery", label: "足月/分娩期", hours: daysToDelivery * 24, reason: "分娩、剖宫产和血容量变化窗口" },
        { key: "postpartum6w", label: "产后6周", hours: (daysToDelivery + 42) * 24, reason: "产褥期持续风险窗口" },
      );
    }
  }

  if (context.hasSurgery) {
    windows.push(
      { key: "op24", label: "术后24小时", hours: 24, reason: "术后早期静脉血栓高发" },
      { key: "op72", label: "术后72小时", hours: 72, reason: "术后高峰风险" },
      { key: "op7d", label: "术后7天", hours: 168, reason: "术后持续观察窗口" },
    );
  }

  if (context.hasCancer) {
    windows.push(
      { key: "treat30d", label: "治疗周期30天", hours: 720, reason: "化疗/围治疗期风险持续" },
      { key: "treat90d", label: "治疗周期90天", hours: 2160, reason: "出院后及治疗周期持续风险" },
    );
  }

  if (context.chronicImmobility) {
    windows.push(
      { key: "recovery30d", label: "康复30天", hours: 720, reason: "长期制动持续平台风险" },
      { key: "recovery90d", label: "康复90天", hours: 2160, reason: "随访与并发症监测窗口" },
    );
  }

  if (context.hasUrgentDvt || context.hasSuspectedPe) {
    windows.push({ key: "urgent0h", label: "急症优先", hours: 0, reason: "需立即床旁复核和影像确认" });
  }

  if (context.age && context.age >= 70) {
    windows.push({ key: "elderly180d", label: "180天", hours: 4320, reason: "高龄长期基线风险" });
  }

  return windows.filter((item, index, array) => array.findIndex((x) => x.key === item.key) === index);
}

function markdownEscape(value) {
  return String(value || "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .trim();
}

function markdownList(items, mapper = (item) => item) {
  if (!items || items.length === 0) return "- 暂无。\n";
  return items.map((item) => `- ${markdownEscape(mapper(item))}`).join("\n") + "\n";
}

function graphReportSummary(graph) {
  if (!graph || !graph.caseView) return null;
  const highlightedIds = new Set(graph.caseView.highlightedNodeIds || []);
  const activeNodes = (graph.nodes || [])
    .filter((node) => highlightedIds.has(node.id))
    .map((node) => ({
      id: node.id,
      label: node.label || node.title || node.id,
      relevance: graph.caseView.highlightedNodeRelevance && graph.caseView.highlightedNodeRelevance[node.id],
    }))
    .sort((a, b) => ((b.relevance && b.relevance.score) || 0) - ((a.relevance && a.relevance.score) || 0))
    .slice(0, 12);
  return {
    summary: graph.caseView.summary || "",
    activeNodes,
    matchedRules: graph.caseView.matchedRules || [],
  };
}

function buildMarkdownReport(report, graph, emrReview = null) {
  const prediction = report.decisionSupport && report.decisionSupport.riskPrediction;
  const reasoning = report.clinicalReasoning || {};
  const graphSummary = graphReportSummary(graph);
  const generatedAt = report.meta && report.meta.generatedAt ? report.meta.generatedAt : new Date().toISOString();
  const lines = [
    "# VTE 智能体单病例分析报告",
    "",
    `生成时间：${generatedAt}`,
    `审计编号：${report.meta && report.meta.auditId ? report.meta.auditId : ""}`,
    `数据边界：${report.meta && report.meta.dataBoundary ? report.meta.dataBoundary : "MVP 演示输出，未接入真实患者数据。"}`,
    "",
    "## 一、病例摘要",
    "",
    markdownEscape(report.inputSummary),
    "",
    "## 二、综合结论",
    "",
    `- 风险分层：${report.riskLevel}`,
    `- 规则评分：${report.score}`,
    `- 分析模式：${reasoning.analysisMode || (report.meta && report.meta.modelUse) || "本地规则 + RAG"}`,
    `- 核心判断：${reasoning.keyConclusion || "已完成 VTE 风险分析。"}`,
    "",
    "## 三、主要依据",
    "",
    markdownList(reasoning.rationale || []),
    "## 四、下一步建议",
    "",
    markdownList(reasoning.immediateActions || report.recommendations || [], (item) => (typeof item === "string" ? item : `${item.title}：${item.detail}`)),
    "## 五、风险因素",
    "",
    markdownList(report.riskFactors || [], (item) => `${item.label}；权重 ${item.weight}；匹配：${(item.matchedTerms || []).join("、") || "规则推断"}`),
    "## 六、急症线索与禁忌核查",
    "",
    "### 急症线索",
    "",
    markdownList(report.urgentFlags || [], (item) => `${item.label}；匹配：${(item.matchedTerms || []).join("、") || "规则推断"}`),
    "### 出血或禁忌核查",
    "",
    markdownList(report.bleedingFlags || [], (item) => `${item.label}；匹配：${(item.matchedTerms || []).join("、") || "规则推断"}`),
    "## 七、风险预测轨迹",
    "",
  ];

  if (prediction) {
    lines.push(
      `- 当前风险：${prediction.currentProbability}%`,
      `- 峰值窗口：${prediction.peakWindow}`,
      `- 峰值概率：${prediction.peakProbability}%`,
      `- 模型来源：${prediction.modelSource}`,
      "",
      "| 时间点 | 概率 | 风险带 | 主要阶段 |",
      "|---|---:|---|---|",
      ...(prediction.trajectory || []).map((point) => `| ${point.label} | ${point.probability}% | ${point.band} | ${markdownEscape(point.phase)} |`),
      "",
      "### 主要驱动因素",
      "",
      markdownList(prediction.topContributors || prediction.drivers || []),
      "### 病例时间锚点",
      "",
      markdownList(prediction.clinicalAnchors || prediction.anchors || []),
      "### 后续验证路径",
      "",
      markdownList(prediction.validationPlan || []),
    );
  } else {
    lines.push("暂无风险预测轨迹。", "");
  }

  lines.push(
    "## 八、病例相关知识图谱",
    "",
    graphSummary ? markdownEscape(graphSummary.summary) : "暂无病例知识图谱摘要。",
    "",
    "### 主要激活节点",
    "",
    markdownList(graphSummary && graphSummary.activeNodes, (item) => `${item.label}${item.relevance ? `｜${item.relevance.level}相关｜${item.relevance.reason}` : ""}`),
    "### 激活路径规则",
    "",
    markdownList(graphSummary && graphSummary.matchedRules, (item) => `${item.label}：${item.summary}`),
    "## 九、病历证据链与当前补强清单",
    "",
    "### 院方可说明事实",
    "",
    markdownList(emrReview && emrReview.hospitalPositionReview && emrReview.hospitalPositionReview.strengths, (item) => item.title + "：" + item.detail),
    "### 主要薄弱点",
    "",
    markdownList(emrReview && emrReview.hospitalPositionReview && emrReview.hospitalPositionReview.vulnerabilities, (item) => item.title + "：" + item.detail),
    "### 当前补强动作",
    "",
    markdownList(emrReview && emrReview.activeCaseImprovementPlan && emrReview.activeCaseImprovementPlan.actions, (item) => item.title + "：" + item.detail),
    "## 十、多角色任务",
    "",
    "### 医生端",
    "",
    markdownList(report.roleTasks && report.roleTasks.doctor),
    "### 护士端",
    "",
    markdownList(report.roleTasks && report.roleTasks.nurse),
    "### 患者端",
    "",
    markdownList(report.roleTasks && report.roleTasks.patient),
    "### 管理端",
    "",
    markdownList(report.roleTasks && report.roleTasks.manager),
    "### 科研端",
    "",
    markdownList(report.roleTasks && report.roleTasks.researcher),
    "## 十一、RAG 证据追溯",
    "",
    markdownList(report.evidence || [], (item) => `${item.title}｜${item.evidenceTier || item.type}｜${item.year || ""}｜相关性 ${item.relevanceScore || 0}`),
    "## 十二、复核事项与安全边界",
    "",
    markdownList(reasoning.missingOrReview || report.reviewItems || []),
    "### 安全边界",
    "",
    markdownList(reasoning.safetyChecks || []),
    "",
    "> 本报告为 VTE 智能体 MVP 演示输出，不作为独立诊疗依据。药物预防、检查和治疗方案必须由医生结合完整病历、查体、影像和院内流程确认。",
    "",
  );

  return lines.join("\n");
}

function htmlEscape(value) {
  return String(value == null ? "" : value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function htmlList(items, mapper = (item) => item) {
  if (!items || items.length === 0) return '<p class="empty">暂无。</p>';
  return `<ul>${items.map((item) => `<li>${htmlEscape(mapper(item))}</li>`).join("")}</ul>`;
}

function buildHtmlReport(report, graph, emrReview = null) {
  const prediction = report.decisionSupport && report.decisionSupport.riskPrediction;
  const reasoning = report.clinicalReasoning || {};
  const graphSummary = graphReportSummary(graph);
  const generatedAt = report.meta && report.meta.generatedAt ? report.meta.generatedAt : new Date().toISOString();
  const roleSections = Object.entries({ doctor: "医生端", nurse: "护士端", patient: "患者端", manager: "管理端", researcher: "科研端" })
    .map(([key, label]) => `<section class="role"><h3>${label}</h3>${htmlList(report.roleTasks && report.roleTasks[key])}</section>`)
    .join("");
  const trajectoryRows = prediction
    ? (prediction.trajectory || [])
        .map((point) => `<tr><td>${htmlEscape(point.label)}</td><td>${htmlEscape(point.probability)}%</td><td>${htmlEscape(point.band)}</td><td>${htmlEscape(point.phase)}</td></tr>`)
        .join("")
    : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>VTE 智能体单病例分析报告</title>
  <style>
    :root{--ink:#202522;--muted:#68716b;--line:#d8ddd9;--accent:#2f5d55;--soft:#eef4f1;--danger:#9a3c38}
    *{box-sizing:border-box} body{margin:0;background:#edf1ee;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;line-height:1.65}
    main{max-width:980px;margin:28px auto;padding:42px 54px;background:#fff;box-shadow:0 12px 36px rgba(32,37,34,.1)}
    header{padding-bottom:22px;border-bottom:3px solid var(--accent)} h1{margin:0 0 8px;font-size:30px} h2{margin:28px 0 12px;padding-left:12px;border-left:4px solid var(--accent);font-size:20px} h3{margin:18px 0 8px;font-size:16px}
    p{margin:8px 0} .meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 24px;color:var(--muted);font-size:13px}.summary{white-space:pre-wrap;padding:14px;background:var(--soft);border-radius:6px}
    .metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.metric{padding:13px;border:1px solid var(--line);border-radius:6px}.metric span{display:block;color:var(--muted);font-size:12px}.metric strong{font-size:20px;color:var(--accent)}
    ul{margin:8px 0;padding-left:22px} li{margin:5px 0} table{width:100%;border-collapse:collapse;margin:12px 0} th,td{padding:9px;border:1px solid var(--line);text-align:left} th{background:var(--soft)}
    .roles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.role{padding:12px;border:1px solid var(--line);border-radius:6px}.empty{color:var(--muted)}
    .boundary{margin-top:30px;padding:14px;border:1px solid #e2c9a7;background:#fff8ed;color:#6d4f27}.actions{position:sticky;top:0;display:flex;justify-content:flex-end;gap:8px;padding:10px;background:#fff;border-bottom:1px solid var(--line)}button{padding:9px 14px;border:1px solid var(--accent);border-radius:6px;background:var(--accent);color:#fff;cursor:pointer}
    @media(max-width:720px){main{margin:0;padding:24px}.meta,.metrics,.roles{grid-template-columns:1fr}}
    @media print{body{background:#fff}.actions{display:none}main{max-width:none;margin:0;padding:0;box-shadow:none}h2{break-after:avoid}table,.role{break-inside:avoid}@page{size:A4;margin:16mm}}
  </style>
</head>
<body>
  <div class="actions"><button type="button" onclick="window.print()">打印 / 保存为 PDF</button></div>
  <main>
    <header><h1>VTE 智能体单病例分析报告</h1><div class="meta"><span>生成时间：${htmlEscape(generatedAt)}</span><span>审计编号：${htmlEscape(report.meta && report.meta.auditId)}</span><span>分析模式：${htmlEscape(reasoning.analysisMode || report.meta.modelUse)}</span><span>数据边界：${htmlEscape(report.meta && report.meta.dataBoundary)}</span></div></header>
    <h2>一、病例摘要</h2><div class="summary">${htmlEscape(report.inputSummary)}</div>
    <h2>二、综合结论</h2><div class="metrics"><div class="metric"><span>风险分层</span><strong>${htmlEscape(report.riskLevel)}</strong></div><div class="metric"><span>规则评分</span><strong>${htmlEscape(report.score)}</strong></div><div class="metric"><span>峰值窗口</span><strong>${htmlEscape(prediction && prediction.peakWindow)}</strong></div></div><p>${htmlEscape(reasoning.keyConclusion || "已完成 VTE 风险分析。")}</p>
    <h2>三、主要依据</h2>${htmlList(reasoning.rationale || [])}
    <h2>四、下一步建议</h2>${htmlList(reasoning.immediateActions || report.recommendations || [], (item) => (typeof item === "string" ? item : `${item.title}：${item.detail}`))}
    <h2>五、风险与安全核查</h2><h3>风险因素</h3>${htmlList(report.riskFactors || [], (item) => `${item.label}；权重 ${item.weight}`)}<h3>急症线索</h3>${htmlList(report.urgentFlags || [], (item) => item.label)}<h3>出血或禁忌</h3>${htmlList(report.bleedingFlags || [], (item) => item.label)}
    <h2>六、风险预测轨迹</h2>${prediction ? `<p>当前 ${htmlEscape(prediction.currentProbability)}%；峰值 ${htmlEscape(prediction.peakProbability)}%；峰值窗口 ${htmlEscape(prediction.peakWindow)}。</p><table><thead><tr><th>时间点</th><th>概率</th><th>风险带</th><th>主要阶段</th></tr></thead><tbody>${trajectoryRows}</tbody></table><h3>主要驱动因素</h3>${htmlList(prediction.topContributors || prediction.drivers || [])}<h3>病例时间锚点</h3>${htmlList(prediction.clinicalAnchors || prediction.anchors || [])}` : '<p class="empty">暂无风险预测轨迹。</p>'}
    <h2>七、病例相关知识图谱</h2><p>${htmlEscape(graphSummary && graphSummary.summary)}</p><h3>主要激活节点</h3>${htmlList(graphSummary && graphSummary.activeNodes, (item) => `${item.label}${item.relevance ? `｜${item.relevance.level}相关｜${item.relevance.reason}` : ""}`)}<h3>激活路径规则</h3>${htmlList(graphSummary && graphSummary.matchedRules, (item) => `${item.label}：${item.summary}`)}
    <h2>八、病历证据链与当前补强清单</h2><h3>院方可说明事实</h3>${htmlList(emrReview && emrReview.hospitalPositionReview && emrReview.hospitalPositionReview.strengths, (item) => `${item.title}：${item.detail}`)}<h3>主要薄弱点</h3>${htmlList(emrReview && emrReview.hospitalPositionReview && emrReview.hospitalPositionReview.vulnerabilities, (item) => `${item.title}：${item.detail}`)}<h3>当前补强动作</h3>${htmlList(emrReview && emrReview.activeCaseImprovementPlan && emrReview.activeCaseImprovementPlan.actions, (item) => `${item.title}：${item.detail}`)}
    <h2>九、多角色任务</h2><div class="roles">${roleSections}</div>
    <h2>十、RAG 证据追溯</h2>${htmlList(report.evidence || [], (item) => `${item.title}｜${item.evidenceTier || item.type}｜${item.year || ""}｜相关性 ${item.relevanceScore || 0}`)}
    <h2>十一、复核事项</h2>${htmlList(reasoning.missingOrReview || report.reviewItems || [])}
    <div class="boundary"><strong>安全边界：</strong>本报告为 VTE 智能体 MVP 演示输出，不作为独立诊疗依据。药物预防、检查和治疗方案必须由医生结合完整病历、查体、影像和院内流程确认。</div>
  </main>
</body>
</html>`;
}

function reportFileName(report, extension = "md") {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const risk = report.riskLevel || "未分层";
  return `${timestamp}_VTE智能体单病例分析报告_${risk}.${extension}`;
}

function buildDecisionSupport(text, riskLevel, riskFactors, bleedingFlags, urgentFlags) {
  const scaleScores = buildScaleScores(text, riskFactors, urgentFlags);
  return {
    scaleScores,
    riskPrediction: buildRiskPredictionTrajectory(text, riskLevel, riskFactors, bleedingFlags, urgentFlags, scaleScores),
    workflowReminders: buildWorkflowReminders(text, riskLevel, riskFactors, bleedingFlags, urgentFlags),
    qualityIndicators: buildQualityIndicators(text, riskLevel, riskFactors, bleedingFlags, urgentFlags),
    patientEducation: buildPatientEducation(text, riskLevel, riskFactors, bleedingFlags, urgentFlags),
    boundary: "当前为演示性量表解释和质控规则，正式部署需接入院内量表字段、质控口径和专家审核规则。",
  };
}

function analyzeCase(payload) {
  const text = normalizePatientContext(payload).trim();
  if (!text) {
    const error = new Error("Missing case text or patientContext");
    error.status = 400;
    throw error;
  }

  const riskFactors = buildRiskFactors(text);

  const bleedingFlags = buildBleedingFlags(text);
  const urgentFlags = (rules.urgentFlags || [])
    .filter((rule) => matchAnyTerm(text, rule.terms))
    .map((rule) => ({
      key: rule.key,
      label: rule.label,
      matchedTerms: rule.terms.filter((term) => text.includes(term)),
    }));

  const score = riskFactors.reduce((sum, item) => sum + item.weight, 0);
  const riskLevel = urgentFlags.length > 0 || score >= 7 || riskFactors.some((item) => item.key === "prior_vte") ? "高危" : score >= 3 ? "中危" : "低危";
  const evidence = retrieveKnowledge(
    `${text} ${riskFactors.map((item) => item.label).join(" ")} ${bleedingFlags.map((item) => item.label).join(" ")} ${urgentFlags.map((item) => item.label).join(" ")}`,
  );
  const reviewItems = buildReviewItems(text, riskLevel, riskFactors, bleedingFlags, urgentFlags);
  const recommendations = buildRecommendations(riskLevel, riskFactors, bleedingFlags, urgentFlags, text);
  const roleTasks = buildRoleTasks(riskLevel, riskFactors, bleedingFlags, urgentFlags, text);
  const quality = buildQuality(riskLevel, riskFactors, bleedingFlags, urgentFlags, reviewItems, evidence);
  const clinicalReasoning = buildClinicalReasoning(text, riskLevel, score, riskFactors, bleedingFlags, urgentFlags, recommendations, reviewItems, evidence);
  const decisionSupport = buildDecisionSupport(text, riskLevel, riskFactors, bleedingFlags, urgentFlags);
  const audit = buildAudit({ riskLevel, riskFactors, bleedingFlags, urgentFlags, evidence, reviewItems });

  return {
    meta: {
      agentName: "VTE 专病智能体 MVP",
      version: "0.1.0",
      mode: "local-rules-rag",
      generatedAt: new Date().toISOString(),
      auditId: audit.auditId,
      dataBoundary: "未接入真实患者数据；正式部署需在院内合规环境运行。",
      modelUse: "本次分析未调用大模型；由本地规则、病例文本解析和 VTE 文献矩阵检索生成。",
    },
    inputSummary: summarizeText(text),
    riskLevel,
    score,
    clinicalReasoning,
    riskFactors,
    bleedingFlags,
    urgentFlags,
    recommendations,
    roleTasks,
    reviewItems,
    quality,
    decisionSupport,
    evidence,
    audit,
  };
}

async function analyzeCaseWithOptionalModel(payload) {
  const report = analyzeCase(payload);
  const preset = findModelPreset(payload.modelPreset);
  const shouldUseModel = Boolean(payload.useModel) && (!preset || preset.provider !== "off");
  if (!shouldUseModel) {
    if (preset && preset.provider === "off") {
      report.meta.modelUse = `已选择：${preset.label}；本次未调用大模型。`;
      report.clinicalReasoning.analysisMode = "本地规则 + RAG 证据检索；未调用大模型";
    }
    return report;
  }

  try {
    const modelResult = await callModel({
      containsRealPatientData: Boolean(payload.containsRealPatientData),
      temperature: 0.2,
      modelPreset: payload.modelPreset,
      modelOptions: payload.modelOptions,
      apiKey: payload.apiKey,
      messages: [
        {
          role: "system",
          content:
            "你是 VTE 专病智能体的临床推理增强层。请基于输入病例、本地规则结果和证据摘要，生成结构化临床辅助分析。重点回答三件事：1 我存在的不足；2 我面临的临床/质控/病历证据链风险；3 我应该如何应对。必须保持边界：不自动诊断、不自动开医嘱、不作法律责任判断，关键决策需医生确认。",
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              caseText: normalizePatientContext(payload),
              localAnalysis: {
                riskLevel: report.riskLevel,
                score: report.score,
                riskFactors: report.riskFactors,
                bleedingFlags: report.bleedingFlags,
                recommendations: report.recommendations,
                reviewItems: report.reviewItems,
                practicalFocus: report.clinicalReasoning.practicalFocus,
                caseManagementAnalysis: report.clinicalReasoning.caseManagementAnalysis,
                evidence: report.evidence.slice(0, 5).map((item) => ({
                  title: item.title,
                  source: item.source,
                  content: item.content,
                })),
              },
              outputRequirements: [
                "先用一句话说明当前病例真正的问题",
                "分条列出：我存在的不足。必须结合病例文本，不要写通用套话",
                "分条列出：我面临的风险，包括临床风险、医疗质量风险、病历证据链风险",
                "分条列出：我该如何应对，包括立即处理、病历补强、沟通/随访、院内质控复盘",
                "指出哪些判断必须由医生结合完整病历确认",
                "说明输出边界：不作法律责任判断，不自动开医嘱",
              ],
            },
            null,
            2,
          ),
        },
      ],
    });
    report.meta.mode = "model-enhanced";
    report.meta.modelUse = `已调用模型增强层：${modelResult.provider} / ${modelResult.model}`;
    report.modelEnhancedAnalysis = {
      provider: modelResult.provider,
      model: modelResult.model,
      text: modelResult.text,
      boundary: modelResult.boundary,
    };
    report.clinicalReasoning.analysisMode = `本地规则 + RAG + 模型增强（${modelResult.provider}）`;
  } catch (error) {
    report.meta.modelUse = `尝试模型增强未完成：${error.message}；当前返回本地规则和 RAG 分析。`;
    report.modelEnhancedAnalysis = null;
  }
  return report;
}

function summarizeText(text) {
  return text.length > 320 ? `${text.slice(0, 320)}...` : text;
}

function urgentProfile(urgentFlags, riskFactors) {
  const keys = new Set(urgentFlags.map((item) => item.key));
  const riskKeys = new Set(riskFactors.map((item) => item.key));
  if (keys.has("suspected_pe")) {
    const isPregnancy = riskKeys.has("pregnancy");
    return {
      kind: "suspected_pe",
      title: isPregnancy ? "疑似妊娠相关 VTE/PE 急症" : "疑似 PE 急症",
      phrase: isPregnancy
        ? "当前文本提示妊娠相关 VTE 风险，并出现呼吸困难等疑似 PE 急症线索，应优先完成生命体征、氧合、DVT/PE 诊断路径和产科安全评估。"
        : "当前文本提示 VTE 风险，并出现呼吸困难等疑似 PE 急症线索，应优先完成生命体征、氧合和 DVT/PE 诊断路径评估。",
      rationale: isPregnancy
        ? "这些线索应置于普通围术期预防之前，优先排查 PE、症状性 DVT，并结合妊娠状态选择影像路径和抗凝安全方案。"
        : "这些线索应置于普通围术期预防之前，优先排查 PE、症状性 DVT，并结合出血风险、肝肾功能、近期手术/创伤和当前医嘱决定影像路径及抗凝安全方案。",
      review: isPregnancy
        ? "存在呼吸困难等疑似 PE 急症线索，应立即复核生命体征和氧合，完善下肢血管超声及必要时 PE 影像评估，并结合妊娠状态启动多学科会诊。"
        : "存在呼吸困难等疑似 PE 急症线索，应立即复核生命体征、氧饱和度、心率血压、胸痛/咯血和下肢症状，完善下肢血管超声及必要时 PE 影像评估。",
      recommendationTitle: isPregnancy ? "急症优先：先处理疑似妊娠相关 VTE/PE" : "急症优先：先处理疑似 PE",
      recommendationDetail: isPregnancy
        ? "呼吸困难合并下肢症状和 VTE 风险因素时，不应停留在普通预防策略。需由医生立即评估生命体征、氧饱和度、心肺症状和下肢血栓线索，选择合适影像路径，并结合出血风险、妊娠状态和手术计划决定后续抗凝或其他处理。"
        : "呼吸困难合并下肢症状和 VTE 风险因素时，不应停留在普通预防策略。需由医生立即评估生命体征、氧饱和度、心肺症状和下肢血栓线索，明确是否需要下肢血管超声、CTPA/肺动脉CTA或其他影像，并结合出血风险、肝肾功能、近期手术/创伤和现有医嘱决定后续抗凝或其他处理。",
      doctorTask: isPregnancy
        ? "优先生命体征和氧合评估，完善下肢血管超声及必要时 PE 影像路径，结合妊娠状态、出血风险和手术计划决定抗凝及会诊策略。"
        : "优先生命体征和氧合评估，完善下肢血管超声及必要时 PE 影像路径，结合出血风险、肝肾功能、近期手术/创伤和现有医嘱决定抗凝及会诊策略。",
      nurseTask: "立即报告医生，严密观察呼吸困难、胸痛、咯血、氧饱和度、心率、血压和下肢症状变化。",
    };
  }
  if (keys.has("limb_ischemia")) {
    const pregnantPhrase = riskKeys.has("pregnancy") ? "该患者为年轻女性，处于妊娠状态，" : "";
    return {
      kind: "limb_ischemia",
      title: "疑似肢体缺血/股青肿急症",
      phrase: `${pregnantPhrase}当前不仅提示 VTE 高危，还存在左下肢急性 DVT 及股青肿/肢体灌注受威胁风险，应优先按急症处理，先明确是否存在 VTE 以及股青肿，再讨论普通围术期预防。`,
      rationale: "这些线索应置于普通围术期预防之前，优先排查急性髂股静脉血栓、股青肿/静脉性坏疽风险及合并动脉供血障碍。",
      review: "存在肢体缺血/股青肿等急症线索，应立即医生床旁复核，优先完善下肢动脉和静脉彩超，必要时完善 CTA/CTV，并启动血管外科急会诊流程。",
      recommendationTitle: "急症优先：先处理疑似肢体缺血/股青肿",
      recommendationDetail:
        "下肢肿痛、张力升高、皮温降低提示不应停留在普通预防策略，应立即床旁查体复核，完善下肢动脉和静脉彩超及必要时 CTA/CTV，评估急性髂股静脉血栓、股青肿、合并动脉供血障碍，并启动血管外科急会诊。",
      doctorTask: "优先完善下肢动脉/静脉血管影像和血管外科会诊，再决定治疗性抗凝、介入/手术处理及手术时机。",
      nurseTask: "立即报告医生，严密观察患肢颜色、温度、肿胀张力、疼痛、感觉运动和足背/胫后动脉搏动。",
    };
  }
  return {
    kind: "urgent_vte",
    title: "疑似急性 VTE 事件",
    phrase: "当前文本提示 VTE 风险，并出现急性症状线索，应优先由医生复核后再制定普通预防方案。",
    rationale: "急性症状线索应置于普通围术期预防之前，先完成诊断路径和安全核查。",
    review: "存在急性 VTE 症状线索，应由医生复核症状体征、影像和抗凝安全性。",
    recommendationTitle: "急症优先：先处理疑似急性 VTE",
    recommendationDetail: "应先完成医生复核、必要影像检查和安全核查，再制定普通防控方案。",
    doctorTask: "优先完成急性 VTE 诊断路径和抗凝安全核查。",
    nurseTask: "立即报告医生并观察症状变化。",
  };
}

function buildClinicalReasoning(text, riskLevel, score, riskFactors, bleedingFlags, urgentFlags, recommendations, reviewItems, evidence) {
  const hasBleeding = bleedingFlags.length > 0;
  const hasUrgent = urgentFlags.length > 0;
  const urgent = hasUrgent ? urgentProfile(urgentFlags, riskFactors) : null;
  const factorLabels = riskFactors.map((item) => item.label);
  const urgentLabels = urgentFlags.map((item) => item.label);
  const evidenceTitles = evidence.slice(0, 3).map((item) => item.title);
  const riskPhrase =
    hasUrgent
      ? urgent.phrase
      : riskLevel === "高危"
      ? "当前文本提示 VTE 风险较高，需要进入医生确认和防控闭环。"
      : riskLevel === "中危"
        ? "当前文本提示存在一定 VTE 风险，需要结合院内路径和病情变化动态复评。"
        : "当前文本未触发明显高危信号，但仍需在病情变化、手术、卧床或转科时复评。";
  const bleedingPhrase = hasBleeding
    ? "同时识别到出血风险或抗凝禁忌信号，因此不能直接给出药物预防结论，应先完成安全核查。"
    : "当前文本未识别到明确活动性出血或抗凝禁忌信号，但正式决策仍需核对血小板、凝血、肝肾功能和手术状态。";
  const missingProcess = reviewItems.filter((item) => item.includes("缺失") || item.includes("复核") || item.includes("确认"));
  const practicalFocus = buildPracticalFocus(text, riskLevel, riskFactors, bleedingFlags, urgentFlags, recommendations, reviewItems);
  const caseManagementAnalysis = buildCaseManagementAnalysis(text, riskLevel, riskFactors, bleedingFlags, urgentFlags, recommendations, reviewItems);

  return {
    title: `${hasUrgent ? "急症优先" : riskLevel}：${riskPhrase}`,
    analysisMode: "本地规则 + RAG 证据检索；未调用大模型",
    confidence: hasUrgent
      ? "较高：文本出现肢体灌注异常相关关键词，但仍需医生查体和影像确认"
      : riskFactors.length >= 4 || hasBleeding
        ? "中等：已识别多个关键线索，但仍依赖输入文本完整性"
        : "有限：建议补充结构化评分表和完整病历字段",
    keyConclusion: `${riskPhrase}${bleedingPhrase}`,
    practicalFocus,
    caseManagementAnalysis,
    rationale: [
      hasUrgent
        ? `急症线索：识别到 ${urgentLabels.join("、")}。${urgent.rationale}`
        : "",
      `风险分层依据：当前规则分值 ${score}，识别风险因素 ${riskFactors.length} 项${factorLabels.length ? `，包括${factorLabels.join("、")}` : ""}。`,
      hasBleeding
        ? `安全性依据：识别到 ${bleedingFlags.map((item) => item.label).join("、")}，应优先核查抗凝禁忌和替代预防方案。`
        : "安全性依据：输入文本中未触发明显出血禁忌规则，但不能替代真实病历中的检验和医嘱复核。",
      evidenceTitles.length
        ? `证据来源：已从 VTE 文献矩阵检索到 ${evidenceTitles.length} 条相关证据，可在下方证据追溯中查看。`
        : "证据来源：当前问题未检索到足够匹配证据，后续应接入全文向量库和院内路径。",
    ].filter(Boolean),
    immediateActions: recommendations.map((item) => `${item.title}：${item.detail}`),
    safetyChecks: [
      "不自动生成医嘱，不替代医生诊疗判断。",
      "药物预防、治疗性抗凝、影像检查和会诊建议均应由医生结合完整病历确认。",
      "若接入真实病历，应在院内服务器和授权模型环境运行。",
    ],
    missingOrReview: missingProcess.length ? missingProcess : ["建议核对 VTE 初评、出血风险核查、动态复评、护理执行和出院随访是否形成闭环。"],
  };
}

function buildReviewItems(text, riskLevel, riskFactors, bleedingFlags, urgentFlags) {
  const items = [];
  if (urgentFlags.length > 0) items.push(urgentProfile(urgentFlags, riskFactors).review);
  if (riskLevel === "高危") items.push("高危分层需由医生确认，并核对药物预防、机械预防和复评计划。");
  if (bleedingFlags.length > 0) items.push("存在出血风险或禁忌信号，药物预防建议需先完成安全核查。");
  if (text.includes("影像报告") && text.includes("出院诊断未同步")) items.push("影像结论与诊断编码不一致，需人工复核 VTE 结局判定。");
  if (text.includes("复评缺失")) items.push("术后复评记录缺失，需反馈至病区并核查护理任务闭环。");
  if (text.includes("依从性一般")) items.push("患者依从性风险较高，需强化随访提醒和患者教育。");
  if (riskFactors.length === 0) items.push("未识别明确风险因素，建议补充结构化变量或原始评估表。");
  return items;
}

function buildPracticalFocus(text, riskLevel, riskFactors, bleedingFlags, urgentFlags, recommendations, reviewItems) {
  const factorLabels = riskFactors.map((item) => item.label);
  const urgentLabels = urgentFlags.map((item) => item.label);
  const hasBleeding = bleedingFlags.length > 0;
  const hasUrgent = urgentFlags.length > 0;
  const immediate = recommendations.slice(0, 2).map((item) => item.title + "：" + item.detail);
  const missing = (reviewItems || []).slice(0, 3);
  const currentProblem = hasUrgent
    ? "这不是普通预防提醒，当前首先要确认是否存在急性 VTE/PE 或威胁肢体的血栓事件，并同步核对抗凝安全性。"
    : riskLevel === "高危"
      ? "当前首先要确认高危分层是否已有正式记录，并核对预防措施、复评、护理执行和出院/随访是否闭环。"
      : "当前主要任务是补齐结构化评估和动态复评，避免病情变化后风险漏评。";
  const knownFacts = [
    factorLabels.length ? "已识别风险因素：" + factorLabels.join("、") : "当前文本未识别到明确 VTE 风险因素，需要补充结构化资料。",
    urgentLabels.length ? "急症线索：" + urgentLabels.join("、") : "未触发明确急症线索。",
    hasBleeding ? "存在出血/禁忌相关线索：" + bleedingFlags.map((item) => item.label).join("、") : "未识别明确活动性出血或抗凝禁忌，但仍需核对原始检验和医嘱。",
  ];
  return {
    currentProblem,
    knownFacts,
    immediatePriorities: immediate.length ? immediate : ["由医生确认风险分层、抗凝安全性、预防措施和复评节点。"],
    missingEvidence: missing.length ? missing : ["建议核对 VTE 初评、出血风险核查、动态复评、护理执行和出院随访是否形成闭环。"],
  };
}

function buildCaseManagementAnalysis(text, riskLevel, riskFactors, bleedingFlags, urgentFlags, recommendations, reviewItems) {
  const shortcomings = [];
  const risks = [];
  const responses = [];
  if (!hasPositiveRecord(text, ["VTE 风险评估", "风险评估", "Caprini", "Padua"])) {
    shortcomings.push("病历中未见明确 VTE 风险评估表或评分记录，难以证明高危识别是否及时、规范。");
  }
  if (!hasPositiveRecord(text, ["复评", "术后24小时", "术后 24 小时", "再次评估", "病情变化"])) {
    shortcomings.push("未见清晰的动态复评节点，尤其是症状变化、手术/卧床后是否重新评估不明确。");
  }
  if (!hasPositiveRecord(text, ["机械预防", "药物预防", "低分子肝素", "抗凝", "活动指导"])) {
    shortcomings.push("预防或处置措施记录不足，尚不能看出风险识别后采取了什么措施及是否执行。");
  }
  if (!hasPositiveRecord(text, ["护理记录", "宣教", "执行", "依从性", "观察"])) {
    shortcomings.push("护理执行、患者宣教和依从性记录不足，难以形成医嘱到执行的闭环证据。");
  }
  if (!hasPositiveRecord(text, ["出血风险", "抗凝禁忌", "血小板", "凝血", "肝肾功能", "活动性出血"])) {
    shortcomings.push("抗凝安全性核查记录不足，后续解释药物预防或治疗性抗凝决策时证据不够完整。");
  }
  if (shortcomings.length === 0) shortcomings.push("当前输入文本已显示部分关键环节，但仍需回到原始病历核对时间、责任人、医嘱和护理执行是否一致。");

  if (urgentFlags.length) {
    risks.push("临床风险：已触发急症线索，需优先排除急性 DVT/PE 或威胁肢体事件，不能只按普通 VTE 预防处理。");
  }
  if (riskLevel === "高危") risks.push("医疗质量风险：高危分层若缺少评估、复评、预防措施和执行记录，容易被认定为防控闭环不完整。");
  if (bleedingFlags.length) risks.push("用药安全风险：存在出血或抗凝禁忌线索，抗凝方案必须有检验和医生判断支撑。");
  if (!includesAny(text, ["告知", "宣教", "出院教育", "随访", "复诊"])) risks.push("沟通与连续管理风险：患者告知、警示症状教育和随访计划不足，会削弱院方对连续管理的说明能力。");
  if (risks.length === 0) risks.push("当前未识别明显急症或安全风险，但输入文本有限，仍需完整病历复核。");

  responses.push(...recommendations.slice(0, 3).map((item) => item.title + "：" + item.detail));
  responses.push("病历补强：按时间轴补齐风险评估、医生判断、检查/会诊、医嘱、护理执行、患者告知和随访计划。");
  responses.push("争议应对：不要只说“常规处理”，应形成事实链——何时发现风险、谁判断、依据是什么、采取了什么措施、患者是否知情和配合。");

  return { shortcomings: shortcomings.slice(0, 6), risks: risks.slice(0, 6), responses: responses.slice(0, 6) };
}

function buildRecommendations(riskLevel, riskFactors, bleedingFlags, urgentFlags, text) {
  const hasBleeding = bleedingFlags.length > 0;
  const hasUrgent = urgentFlags.length > 0;
  const urgent = hasUrgent ? urgentProfile(urgentFlags, riskFactors) : null;
  const items = [
    ...(hasUrgent
      ? [
          {
            title: urgent.recommendationTitle,
            detail: urgent.recommendationDetail,
            confirmation: "医生立即确认",
          },
        ]
      : []),
    {
      title: hasBleeding ? "先进行出血风险和抗凝禁忌核查" : "生成综合防控建议草案",
      detail: hasBleeding
        ? "当前不直接给出药物预防结论，应先由医生结合血小板、出血来源、肝肾功能和手术状态确认。"
        : hasUrgent
          ? "待急症评估和治疗路径明确后，再结合手术计划、抗凝/介入风险和肿瘤手术时机制定围术期 VTE 防控方案。"
          : "可结合风险分层、院内路径、机械预防、活动指导和药物预防适应证生成建议草案。",
      confirmation: "医生确认",
    },
    {
      title: "同步护理端任务",
      detail: "生成复评提醒、机械预防、活动指导、宣教和执行记录任务。",
      confirmation: "护士执行并记录",
    },
    {
      title: text.includes("出院") || text.includes("随访") ? "生成出院随访和患者教育" : "预置出院教育内容",
      detail: "围绕抗凝依从性、活动恢复、复诊提醒和 DVT/PE 警示症状生成患者端内容。",
      confirmation: "医护审核",
    },
  ];
  if (riskLevel === "低危") {
    items.unshift({
      title: "保持动态复评",
      detail: "当前演示规则提示低危，但仍需在病情变化、手术、卧床或转科时重新评估。",
      confirmation: "流程确认",
    });
  }
  return items;
}

function buildRoleTasks(riskLevel, riskFactors, bleedingFlags, urgentFlags, text) {
  const hasBleeding = bleedingFlags.length > 0;
  const hasUrgent = urgentFlags.length > 0;
  const urgent = hasUrgent ? urgentProfile(urgentFlags, riskFactors) : null;
  const hasQuality = text.includes("质控") || text.includes("漏评") || text.includes("编码");
  const hasDischarge = text.includes("出院") || text.includes("随访");
  return {
    doctor: [
      ...(hasUrgent ? [urgent.kind === "limb_ischemia" ? "立即床旁复核患肢皮温、颜色、感觉运动、毛细血管充盈和动脉搏动，评估是否存在威胁肢体的急症。" : "立即复核生命体征、氧饱和度、胸痛/咯血/呼吸困难和下肢症状，评估疑似 PE 或急性 VTE。"] : []),
      `${riskLevel}分层结果需结合病情、检查和院内路径确认。`,
      hasUrgent
        ? urgent.doctorTask
        : hasBleeding
          ? "先核查出血风险和抗凝禁忌，再决定药物预防或治疗方案。"
          : "评估药物预防、机械预防和活动指导的组合策略。",
      "关键建议不自动生成医嘱，需医生确认后进入临床流程。",
    ],
    nurse: [
      ...(hasUrgent ? [urgent.nurseTask] : []),
      "完善 VTE 风险评估记录，并按病情变化设置复评提醒。",
      hasUrgent ? "急症未排除前，机械预防和活动指导需经医生确认后执行。" : "执行机械预防、活动指导和健康宣教，记录执行状态。",
      hasBleeding ? "关注出血相关观察项，异常情况及时反馈医生。" : "跟踪患者活动、依从性和预防措施完成情况。",
    ],
    patient: [
      hasDischarge ? "解释出院后抗凝、活动、复诊和警示症状。" : "用患者能理解的语言解释 VTE 风险和预防措施。",
      "提示下肢肿胀疼痛、胸痛、呼吸困难、咯血等警示症状需及时就医。",
      "患者端内容为教育和提醒，不替代医生诊疗。",
    ],
    manager: [
      hasQuality ? "生成病区漏评漏防、复评缺失和编码不一致清单。" : "汇总高危患者、预防措施执行和预警处理情况。",
      "按科室、病区和时间段追踪评估率、复评率和随访率。",
      "对高风险或冲突病例生成抽样复核任务。",
    ],
    researcher: [
      "形成变量抽取清单、缺失值清单和结局复核项。",
      "记录知识库版本、规则版本和人工复核状态。",
      "正式研究中需锁定队列、结局定义和统计方案。",
    ],
  };
}

function buildQuality(riskLevel, riskFactors, bleedingFlags, urgentFlags, reviewItems, evidence) {
  return {
    metrics: {
      riskTriggered: urgentFlags.length ? "急症优先" : riskLevel === "高危" ? "已触发" : riskLevel === "中危" ? "需关注" : "未触发",
      bleedingCheck: bleedingFlags.length ? "已触发" : "未触发",
      reviewItems: reviewItems.length,
      evidenceCount: evidence.length,
    },
    summary: [
      "本次输出用于演示病例级任务流，不输出真实临床医嘱。",
      `识别风险因素 ${riskFactors.length} 项，出血或禁忌信号 ${bleedingFlags.length} 项，急症线索 ${urgentFlags.length} 项。`,
      "建议将类似输出作为后续内网部署、接口验收和真实世界评价的指标基础。",
    ],
  };
}

function buildAudit({ riskLevel, riskFactors, bleedingFlags, urgentFlags, evidence, reviewItems }) {
  const auditId = crypto.randomUUID();
  const now = Date.now();
  const safeUrgentFlags = urgentFlags || [];
  const events = [
    "接收病例输入，MVP 不保存原始输入到持久化数据库。",
    `完成风险因素识别：${riskFactors.map((item) => item.label).join("、") || "未识别明确风险因素"}。`,
    `完成出血禁忌核查：${bleedingFlags.map((item) => item.label).join("、") || "未触发明显禁忌信号"}。`,
    `完成急症线索核查：${safeUrgentFlags.map((item) => item.label).join("、") || "未触发急症线索"}。`,
    `检索知识库并返回 ${evidence.length} 条证据来源。`,
    `生成风险分层：${riskLevel}，关键建议标记为需医生确认。`,
    `生成 ${reviewItems.length} 项人工复核或质控提醒。`,
  ].map((message, index) => ({
    time: new Date(now + index * 1000).toISOString(),
    message,
  }));
  return { auditId, events };
}

function includesAny(text, terms) {
  return terms.some((term) => text.includes(term));
}

function hasDefectPhrase(text, terms) {
  const defectWords = ["缺失", "未完成", "未记录", "不完整", "不一致", "未同步", "漏评", "漏防", "未见"];
  return terms.some((term) => {
    const index = text.indexOf(term);
    if (index < 0) return false;
    const window = text.slice(Math.max(0, index - 4), Math.min(text.length, index + term.length + 6));
    return defectWords.some((word) => window.includes(word));
  });
}

function hasPositiveRecord(text, terms) {
  return includesAny(text, terms) && !hasDefectPhrase(text, terms);
}

function matchedTerms(text, terms) {
  return terms.filter((term) => text.includes(term));
}

function evidenceSnippet(text, terms) {
  const term = terms.find((item) => text.includes(item));
  if (!term) return "";
  const index = text.indexOf(term);
  const start = Math.max(0, index - 36);
  const end = Math.min(text.length, index + term.length + 52);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

function currentAdmissionStatus(text) {
  if (includesAny(text, ["已出院", "出院记录", "出院诊断", "死亡记录", "病案首页"])) return "已出院或已形成出院材料";
  if (includesAny(text, ["未出院", "仍在院", "住院中", "目前在院", "继续住院", "当前病程"])) return "仍在院";
  return "未明确";
}

function buildClinicalTimeline(text) {
  const markers = [
    { key: "入院", terms: ["入院", "住院", "入科"], event: "入院/住院阶段", focus: "应完成 VTE 风险初评和出血风险评估。" },
    { key: "术前", terms: ["术前", "拟行", "准备手术"], event: "术前阶段", focus: "应结合手术类型、活动状态和基础疾病复核 VTE 风险。" },
    { key: "术后", terms: ["术后", "手术后"], event: "术后阶段", focus: "应关注术后 24 小时、卧床、出血风险和预防措施执行。" },
    { key: "检查", terms: ["D-二聚体", "超声", "CTPA", "影像", "肺动脉CTA", "血小板", "凝血"], event: "检查/检验阶段", focus: "应记录异常结果解释、后续处置和与 VTE 风险的关系。" },
    { key: "医嘱", terms: ["医嘱", "抗凝", "低分子肝素", "华法林", "利伐沙班", "机械预防"], event: "医嘱/干预阶段", focus: "应说明药物或机械预防依据、禁忌核查和执行记录。" },
    { key: "护理", terms: ["护理", "宣教", "活动指导", "机械预防", "复评"], event: "护理执行阶段", focus: "应记录复评、机械预防、活动指导和患者宣教完成情况。" },
    { key: "出院", terms: ["出院", "随访", "复诊"], event: "出院/随访阶段", focus: "应完成出院教育、抗凝注意事项、警示症状和随访计划。" },
  ];
  const found = markers.filter((marker) => includesAny(text, marker.terms));
  if (found.length === 0) {
    return [{ event: "未形成明确时间轴", focus: "建议补充入院、术前/术后、检查、医嘱、护理和出院记录。", status: "需补充" }];
  }
  return found.map((marker) => ({ event: marker.event, focus: marker.focus, status: "已识别" }));
}

function buildProcessChecks(text, analysis) {
  const highRisk = analysis.riskLevel === "高危";
  const checks = [
    {
      item: "入院 VTE 风险评估",
      terms: ["VTE 风险评估", "风险评估", "Caprini", "Padua", "评估完成"],
      expected: "入院后应有明确 VTE 风险评估记录，并能说明评估时间、评分结果、风险等级和责任人。",
      defense: "若已及时完成评估，院方可围绕“入院风险已识别、分层依据明确、后续措施与风险等级相匹配”形成事实说明。",
      action: "补齐或定位入院评估单、首次病程记录、护理入院评估和 VTE 风险分层截图/原始记录。",
    },
    {
      item: "出血风险和抗凝禁忌核查",
      terms: ["出血风险", "抗凝禁忌", "血小板", "凝血", "活动性出血", "肝肾功能", "出血倾向"],
      expected: "药物预防或治疗前应记录血小板、凝血、肝肾功能、活动性出血及手术出血风险，并说明是否影响抗凝。",
      defense: "若因出血风险、手术时机或禁忌未立即抗凝，院方需要用检验、病程和医嘱说明“未抗凝/延迟抗凝”的医学理由。",
      action: "补强血小板、凝血、肝肾功能、出血风险评估、围术期抗凝禁忌讨论及替代机械预防记录。",
    },
    {
      item: "动态复评",
      terms: ["复评", "术后24小时", "术后 24 小时", "病情变化", "转科", "病情加重", "再次评估"],
      expected: "手术、卧床、病情变化、转科、出现下肢症状或出院前应触发 VTE 风险动态复评。",
      defense: "若病情变化后有复评和处置，院方可说明风险并非未被关注，而是已按病情变化重新评估并调整措施。",
      action: "补齐病情变化节点、术后/转科/症状出现后的复评记录，以及复评后医嘱或护理措施变化。",
    },
    {
      item: "预防措施记录",
      terms: ["机械预防", "药物预防", "低分子肝素", "间歇充气", "弹力袜", "活动指导", "抗凝", "利伐沙班", "华法林"],
      expected: "应记录机械预防、药物预防、活动指导及未执行/暂停/延迟执行的原因。",
      defense: "若已采取机械预防、活动指导或药物预防，院方应展示医嘱、护理执行和患者依从性记录，说明防控措施并非缺位。",
      action: "核对医嘱单、护理执行单、机械预防使用记录、活动指导、药物使用时间和停用/禁用理由。",
    },
    {
      item: "护理执行闭环",
      terms: ["护理记录", "护理", "宣教", "执行", "依从性", "健康教育", "巡视", "观察"],
      expected: "护理端应记录复评提醒、机械预防执行、活动指导、症状观察、宣教和患者依从性。",
      defense: "护理记录可用于说明医嘱是否落实、患者是否配合、症状变化是否及时报告，是院方事实链的重要部分。",
      action: "补齐护理执行闭环：执行时间、执行人、观察内容、患者拒绝/不耐受情况、异常上报和医生反馈。",
    },
    {
      item: "出院教育和随访",
      terms: ["出院教育", "随访", "复诊", "警示症状", "抗凝注意事项", "活动建议", "出院指导"],
      expected: "出院前应说明抗凝、活动、警示症状、复诊和随访安排；未出院病例应提前形成出院计划草案。",
      defense: "若争议发生在出院后，院方需证明已完成风险告知、警示症状教育和复诊安排；若未出院，应及时补强连续管理计划。",
      action: "完善出院指导、抗凝/活动/复诊计划、DVT/PE 警示症状告知和患者理解确认记录。",
    },
    {
      item: "诊断/影像/编码一致性",
      terms: ["超声", "CTA", "CTV", "CTPA", "影像", "诊断", "编码", "出院诊断", "病案首页"],
      presentOverride: !text.includes("出院诊断未同步") && !text.includes("编码不一致") && !text.includes("诊断不一致"),
      expected: "影像报告、病程记录、出院诊断和编码应保持一致，冲突时需复核。",
      defense: "若影像、病程和诊断之间一致，可用于说明诊疗判断和病案首页记录有连续证据；若不一致，应尽早病案复核。",
      action: "核对影像报告、病程记录、会诊记录、出院诊断、病案首页编码和结局判定的一致性。",
    },
  ];

  return checks.map((check) => {
    const present = typeof check.presentOverride === "boolean" ? check.presentOverride : hasPositiveRecord(text, check.terms);
    const matched = matchedTerms(text, check.terms || []);
    const snippet = evidenceSnippet(text, check.terms || []);
    const severity = present ? "已见证据" : highRisk ? "重点补强" : "建议补强";
    return {
      ...check,
      present,
      matchedTerms: matched,
      evidenceSnippet: snippet,
      status: present ? "pass" : "review",
      severity,
      suggestion: present
        ? "已见相关线索：" + (matched.join("、") || "文本提示记录存在") + "。仍需核对原始病历中的时间、责任人、医嘱/护理执行和前后记录是否一致。" + (snippet ? " 摘录：" + snippet : "")
        : check.expected + " 当前文本未见足够记录，建议补强：" + check.action,
      defensePoint: check.defense,
      action: check.action,
    };
  });
}

function buildDocumentationGaps(processChecks, analysis) {
  const gaps = processChecks
    .filter((check) => check.status === "review")
    .map((check) => ({
      title: check.item,
      detail: check.suggestion,
      priority: check.severity,
    }));
  analysis.reviewItems.forEach((item) => {
    gaps.push({ title: "智能体复核项", detail: item, priority: "需复核" });
  });
  return gaps;
}

function buildQualityAndLegalRiskHints(text, analysis, processChecks) {
  const hints = [];
  const missingCritical = processChecks.filter((check) => check.status === "review" && ["入院 VTE 风险评估", "出血风险和抗凝禁忌核查", "动态复评", "预防措施记录"].includes(check.item));
  if (analysis.riskLevel === "高危" && missingCritical.length > 0) {
    hints.push({
      level: "重点复核",
      title: "高危患者流程记录不完整风险",
      detail: "从医疗质量安全角度，高危患者若缺少评估、复评、禁忌核查或预防措施记录，可能影响后续质控复盘和病历完整性评价。",
    });
  }
  if (analysis.bleedingFlags.length > 0) {
    hints.push({
      level: "重点复核",
      title: "抗凝安全性记录风险",
      detail: "文本中存在出血或抗凝禁忌信号。建议明确记录医生判断、替代预防措施和动态观察计划。",
    });
  }
  if (text.includes("出院诊断未同步") || text.includes("编码不一致")) {
    hints.push({
      level: "需复核",
      title: "诊断与编码一致性风险",
      detail: "影像、病程、出院诊断和编码不一致时，应进行病案和结局判定复核。",
    });
  }
  if (!includesAny(text, ["宣教", "告知", "出院教育", "随访", "警示症状"])) {
    hints.push({
      level: "建议完善",
      title: "患者告知和连续管理记录不足",
      detail: "建议补充患者教育、警示症状、抗凝注意事项、活动建议和随访安排记录。",
    });
  }
  if (hints.length === 0) {
    hints.push({
      level: "常规提示",
      title: "未发现明显流程风险信号",
      detail: "当前为脱敏文本和规则型审查结果，正式判断仍需结合完整病历、院内制度和人工复核。",
    });
  }
  return hints;
}

function buildHospitalPositionReview(text, analysis, processChecks) {
  const strengths = [];
  const vulnerabilities = [];
  const explanationLines = [];
  const presentChecks = processChecks.filter((check) => check.status === "pass");
  const missingChecks = processChecks.filter((check) => check.status === "review");

  analysis.riskFactors.forEach((factor) => {
    strengths.push({
      title: "风险因素已可识别",
      level: "可说明",
      detail: "文本中识别到“" + factor.label + "”（匹配：" + ((factor.matchedTerms || []).join("、") || "规则推断") + "）。院方应进一步说明该风险是否已进入评估、复评和预防措施。",
    });
  });

  if (analysis.bleedingFlags.length > 0) {
    strengths.push({
      title: "抗凝决策存在安全核查理由",
      level: "可说明",
      detail: "文本提示出血/禁忌相关线索：" + analysis.bleedingFlags.map((item) => item.label).join("、") + "。如果当时未立即药物预防或治疗性抗凝，应把检验、手术风险和医生判断串成证据链。",
    });
  }

  presentChecks.forEach((check) => {
    strengths.push({
      title: check.item,
      level: "可说明",
      detail: check.defensePoint + (check.evidenceSnippet ? " 当前文本摘录：" + check.evidenceSnippet : ""),
    });
  });

  missingChecks.forEach((check) => {
    vulnerabilities.push({
      title: check.item,
      level: check.severity,
      detail: "薄弱点：" + check.expected + "。补强动作：" + check.action,
    });
  });

  if (analysis.urgentFlags.length > 0) {
    vulnerabilities.unshift({
      title: "急症线索处置链需重点核对",
      level: "重点复核",
      detail: "文本出现急症线索：" + analysis.urgentFlags.map((item) => item.label).join("、") + "。需核对症状出现时间、医生查体、影像申请/完成时间、会诊时间、处置决定和患者转归。",
    });
  }

  explanationLines.push("院方不宜只笼统说明“已按常规处理”，应按时间顺序展示：风险识别 → 医生判断 → 检查/会诊 → 预防或治疗措施 → 护理执行 → 告知随访。");
  if (missingChecks.length) explanationLines.push("当前文本中仍有 " + missingChecks.length + " 个关键环节证据不足，建议先补齐原始记录或形成病程补充说明，再进入正式质控/争议讨论。");
  if (!missingChecks.length) explanationLines.push("当前文本未提示明显流程缺口，但正式说明仍需以原始病历、医嘱、护理记录、影像报告和院内制度为依据。");

  return {
    strengths: strengths.slice(0, 8),
    vulnerabilities: vulnerabilities.slice(0, 8),
    explanationLines,
    boundary: "以下为医疗质量和病历证据链视角，不构成法律意见，也不判断医疗过错或因果关系。",
  };
}

function buildActiveCaseImprovementPlan(text, analysis, processChecks) {
  const status = currentAdmissionStatus(text);
  const actions = [];
  processChecks
    .filter((check) => check.status === "review")
    .forEach((check) => {
      actions.push({
        title: check.item,
        priority: check.severity,
        detail: status === "仍在院" || status === "未明确" ? "未出院/当前阶段可补强：" + check.action : "已出院材料需复核：" + check.action,
      });
    });

  if (analysis.riskLevel === "高危") {
    actions.unshift({
      title: "高危病例总控",
      priority: "重点补强",
      detail: "形成一条完整病程说明：为何判定高危、是否存在禁忌、采取了哪些预防/诊断/治疗措施、何时复评、谁负责确认。",
    });
  }
  if (analysis.urgentFlags.length > 0) {
    actions.unshift({
      title: "急症线索即时补强",
      priority: "重点复核",
      detail: "立即核对症状出现时间、生命体征/肢体查体、影像检查申请与完成时间、会诊记录、处置决定和患者沟通记录。",
    });
  }

  return { status, actions: actions.slice(0, 10) };
}

function buildTeachingPoints(analysis, processChecks) {
  const missed = processChecks.filter((check) => check.status === "review").map((check) => check.item);
  return [
    `本病例 VTE 风险分层为${analysis.riskLevel}，教学重点是识别主要风险因素并说明依据。`,
    analysis.bleedingFlags.length > 0 ? "存在出血/禁忌信号，教学重点是抗凝前安全核查和替代预防方案。" : "未触发明显出血禁忌信号，教学重点是预防策略组合和动态复评。",
    missed.length ? `可作为流程质控训练题：请学员补全 ${missed.join("、")}。` : "可作为规范病例训练题：请学员说明各流程节点为何充分。",
  ];
}

function reviewEmr(payload) {
  const text = normalizePatientContext(payload).trim();
  if (!text) {
    const error = new Error("Missing EMR text or patientContext");
    error.status = 400;
    throw error;
  }
  const analysis = analyzeCase({ text });
  const processChecks = buildProcessChecks(text, analysis);
  const documentationGaps = buildDocumentationGaps(processChecks, analysis);
  const qualityAndLegalRiskHints = buildQualityAndLegalRiskHints(text, analysis, processChecks);
  const hospitalPositionReview = buildHospitalPositionReview(text, analysis, processChecks);
  const activeCaseImprovementPlan = buildActiveCaseImprovementPlan(text, analysis, processChecks);
  const teachingPoints = buildTeachingPoints(analysis, processChecks);

  return {
    meta: {
      agentName: "VTE 病历深度审查智能体 MVP",
      version: "0.1.0",
      generatedAt: new Date().toISOString(),
      boundary: "仅从 VTE 防控流程、病历完整性和医疗质量安全角度提示需复核事项；不作法律责任或医疗事故判断。",
    },
    inputSummary: summarizeText(text),
    clinicalTimeline: buildClinicalTimeline(text),
    vteAnalysis: {
      riskLevel: analysis.riskLevel,
      score: analysis.score,
      riskFactors: analysis.riskFactors,
      bleedingFlags: analysis.bleedingFlags,
      evidence: analysis.evidence.slice(0, 3),
    },
    processChecks,
    documentationGaps,
    qualityAndLegalRiskHints,
    hospitalPositionReview,
    activeCaseImprovementPlan,
    improvementPlan: [
      "补齐 VTE 初评、动态复评、出血风险核查和防控措施依据。",
      "将医生判断、护理执行、患者宣教和出院随访串成可追溯闭环。",
      "对影像诊断、出院诊断、编码和结局判定不一致处进行人工复核。",
      "正式部署时应接入院内制度、质控口径和病案首页/护理/医嘱结构化数据。",
    ],
    teachingPoints,
    audit: buildAudit({
      riskLevel: analysis.riskLevel,
      riskFactors: analysis.riskFactors,
      bleedingFlags: analysis.bleedingFlags,
      urgentFlags: analysis.urgentFlags,
      evidence: analysis.evidence,
      reviewItems: documentationGaps.map((gap) => gap.detail),
    }),
  };
}

function formatBytes(size) {
  const bytes = Number(size || 0);
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function documentTypeLabel(type) {
  return {
    pdf: "PDF 病历",
    word: "Word 病历",
    image: "扫描图片/照片",
    text: "结构化文本",
    unknown: "未知格式",
  }[type] || "未知格式";
}

function decodeXmlEntities(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

function extractZipEntry(buffer, entryName) {
  const signature = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  let offset = 0;
  while (offset >= 0 && offset < buffer.length) {
    const headerOffset = buffer.indexOf(signature, offset);
    if (headerOffset < 0 || headerOffset + 30 > buffer.length) return null;
    const compression = buffer.readUInt16LE(headerOffset + 8);
    const compressedSize = buffer.readUInt32LE(headerOffset + 18);
    const fileNameLength = buffer.readUInt16LE(headerOffset + 26);
    const extraLength = buffer.readUInt16LE(headerOffset + 28);
    const fileNameStart = headerOffset + 30;
    const fileNameEnd = fileNameStart + fileNameLength;
    const dataStart = fileNameEnd + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (fileNameEnd > buffer.length || dataEnd > buffer.length) return null;
    const name = buffer.slice(fileNameStart, fileNameEnd).toString("utf8");
    if (name === entryName) {
      const entry = buffer.slice(dataStart, dataEnd);
      if (compression === 0) return entry;
      if (compression === 8) return zlib.inflateRawSync(entry);
      return null;
    }
    offset = dataEnd;
  }
  return null;
}

function extractDocxText(base64) {
  if (!base64) return { text: "", status: "empty" };
  try {
    const buffer = Buffer.from(String(base64), "base64");
    const xmlBuffer = extractZipEntry(buffer, "word/document.xml");
    if (!xmlBuffer) return { text: "", status: "unsupported", note: "未找到 word/document.xml。" };
    let xml = xmlBuffer.toString("utf8");
    xml = xml
      .replace(/<w:tab\b[^>]*\/>/g, "\t")
      .replace(/<w:br\b[^>]*\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<\/w:tr>/g, "\n");
    const parts = [...xml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((match) => decodeXmlEntities(match[1]));
    const text = parts
      .join("")
      .replace(/\r/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
    return { text: text.slice(0, 20000), status: text ? "ready" : "empty" };
  } catch (error) {
    return { text: "", status: "error", note: error.message };
  }
}

function extensionForDocumentType(type, fileName = "") {
  const ext = path.extname(fileName).toLowerCase();
  if ([".pdf", ".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff"].includes(ext)) return ext;
  if (type === "pdf") return ".pdf";
  if (type === "image") return ".png";
  return ".bin";
}

function extractBinaryDocumentText({ documentType, fileName, fileBase64 }) {
  if (!fileBase64 || !["pdf", "image"].includes(documentType)) return { text: "", status: "not_available" };
  const buffer = Buffer.from(String(fileBase64), "base64");
  if (!buffer.length) return { text: "", status: "empty" };
  if (buffer.length > 28_000_000) return { text: "", status: "oversized", note: "文件超过 28MB，演示版未处理；建议导入较小的脱敏病例文件或复制病例摘要。" };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vte-ingest-"));
  const filePath = path.join(tmpDir, "source" + extensionForDocumentType(documentType, fileName));
  try {
    fs.writeFileSync(filePath, buffer);
    const result = spawnSync("swift", [DOCUMENT_EXTRACTOR, documentType, filePath], {
      encoding: "utf8",
      timeout: documentType === "image" ? 20_000 : 12_000,
      maxBuffer: 2_000_000,
    });
    if (result.error) return { text: "", status: "error", note: result.error.message };
    if (result.status !== 0 && !result.stdout) return { text: "", status: "error", note: result.stderr || "extractor exited " + result.status };
    const parsed = JSON.parse(String(result.stdout || "{}"));
    return {
      text: String(parsed.text || "").slice(0, 20000),
      status: parsed.status || "unknown",
      note: parsed.note || "",
    };
  } catch (error) {
    return { text: "", status: "error", note: error.message };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (error) {
      // ignore cleanup errors
    }
  }
}

function ingestDocumentPreview(payload) {
  const documentType = payload.documentType || "unknown";
  let extractedText = String(payload.extractedText || "").trim();
  let extraction = null;
  if (!extractedText && documentType === "word" && payload.fileBase64 && /\.docx$/i.test(payload.fileName || "")) {
    extraction = extractDocxText(payload.fileBase64);
    extractedText = extraction.text || "";
  }
  if (!extractedText && ["pdf", "image"].includes(documentType) && payload.fileBase64) {
    extraction = extractBinaryDocumentText({
      documentType,
      fileName: payload.fileName,
      fileBase64: payload.fileBase64,
    });
    extractedText = extraction.text || "";
  }
  const analysis = extractedText ? analyzeCase({ text: extractedText }) : null;
  const needsOcr = documentType === "image" || documentType === "pdf";
  const extractionAttempted = Boolean(extraction);
  return {
    fileName: payload.fileName || "未命名文件",
    documentType,
    documentTypeLabel: documentTypeLabel(documentType),
    sizeLabel: formatBytes(payload.size),
    extractedText: extractedText ? extractedText.slice(0, 12000) : "",
    extractionStatus: extractedText ? "ready" : extraction ? extraction.status : "not_available",
    extractionNote: extraction && extraction.note ? extraction.note : "",
    summary: extractedText
      ? "已读取到文本内容，可进入病例结构化抽取和 VTE 智能体分析；已同步到当前病例。"
      : extractionAttempted
        ? "已完成本地解析尝试，但未获得可分析文本；请换用可复制文本 PDF、清晰图片，或人工粘贴脱敏病例摘要。"
        : "当前演示仅做文件预检；正式部署时将在内网服务器执行文档解析、OCR 和结构化抽取。",
    pipeline: [
      {
        name: "文件接收与脱敏边界",
        status: "ready",
        statusLabel: "已预检",
        detail: "演示环境不持久化保存上传文件；真实病历需在院内授权服务器处理。",
      },
      {
        name: documentType === "word" ? "Word 解析" : documentType === "pdf" ? "PDF 文本/版面解析" : documentType === "image" ? "OCR 图像识别" : "文本读取",
        status: extractedText ? "ready" : needsOcr ? "manual" : "pending",
        statusLabel: extractedText ? "可分析" : extractionAttempted ? "未识别到可分析文本" : needsOcr ? "需解析/OCR" : "待接入",
        detail: extractedText
          ? "已获得可读文本，下一步可抽取诊断、手术、检验、医嘱、护理和出院记录。"
          : extractionAttempted
            ? (extraction && extraction.note ? extraction.note : "本地解析未获得有效文本，建议使用文字型 PDF、清晰扫描图片或人工粘贴病例摘要。")
            : "正式版本应接入院内文档解析与 OCR 服务，并保留原始文件、抽取文本和结构化字段的审计链。",
      },
      {
        name: "VTE 变量结构化",
        status: "manual",
        statusLabel: "规则+模型抽取",
        detail: "抽取年龄、妊娠/产褥期、手术、卧床、D-二聚体、血小板、肝肾功能、症状体征、影像和医嘱。",
      },
      {
        name: "病例分析与知识图谱激活",
        status: analysis ? "ready" : "pending",
        statusLabel: analysis ? "已生成预分析" : "等待文本",
        detail: "结构化后进入单病例分析、病历审查、RAG 证据追溯和知识图谱病例子图。",
      },
    ],
    analysis: analysis
      ? {
          riskLevel: analysis.riskLevel,
          riskFactors: analysis.riskFactors,
          urgentFlags: analysis.urgentFlags,
          clinicalReasoning: analysis.clinicalReasoning,
          inputSummary: analysis.inputSummary,
        }
      : null,
    nextStep: "接入 PDF/Word 解析、OCR、版面还原、实体识别、时间轴抽取和人工复核队列。",
  };
}

function cohortDemoCases(filters) {
  const base = [
    {
      patientLabel: "患者 A｜血管外科｜妊娠早期下肢急症",
      department: "血管外科",
      text: "女，20岁，怀孕10周。BMI 29 kg/m2，术前活动减少，入院后卧床 3 天，左下肢肿痛1天，肌张力明显升高，皮温降低。D-二聚体升高，血小板正常，肝肾功能可。当前无活动性出血。",
    },
    {
      patientLabel: "患者 B｜骨科｜围术期卧床",
      department: "骨科",
      text: "男，76岁，髋部骨折术后卧床，D-二聚体升高，无活动性出血，需评估 VTE 预防和护理复评。",
    },
    {
      patientLabel: "患者 C｜肿瘤科｜腹盆腔肿瘤手术",
      department: "肿瘤相关科室",
      text: "女，63岁，腹盆腔肿瘤拟行手术，预计 4 小时，术前活动减少，BMI 28，血小板正常，无活动性出血。",
    },
    {
      patientLabel: "患者 D｜产科｜妊娠呼吸困难",
      department: "产科",
      text: "女，29岁，妊娠28周，突发呼吸困难2小时，左下肢胀痛，D-二聚体升高，无活动性出血。",
    },
    {
      patientLabel: "患者 E｜普外科｜中危复评",
      department: "普外科",
      text: "男，48岁，术后活动减少，D-二聚体轻度升高，血小板正常，肝肾功能可，需出院教育。",
    },
  ];
  return base.filter((item) => {
    if (filters.department && filters.department !== "all") {
      const map = {
        vascular: "血管外科",
        orthopedics: "骨科",
        obstetrics: "产科",
        oncology: "肿瘤相关科室",
      };
      if (map[filters.department] && item.department !== map[filters.department]) return false;
    }
    if (filters.diagnosis === "dvt" && !/DVT|下肢|血栓|肿痛|胀痛/.test(item.text)) return false;
    if (filters.diagnosis === "pe" && !/PE|肺栓塞|呼吸困难/.test(item.text)) return false;
    if (filters.diagnosis === "surgery" && !/术|手术|卧床/.test(item.text)) return false;
    if (filters.diagnosis === "pregnancy" && !/妊娠|怀孕/.test(item.text)) return false;
    return true;
  });
}

function buildDashboardFromReports(results, mode = "演示数据") {
  const total = results.length || 1;
  const highRisk = results.filter((item) => item.analysis.riskLevel === "高危").length;
  const urgent = results.filter((item) => item.analysis.urgentFlags.length > 0).length;
  const bleeding = results.filter((item) => item.analysis.bleedingFlags.length > 0).length;
  const departmentMap = new Map();
  results.forEach((item) => departmentMap.set(item.department, (departmentMap.get(item.department) || 0) + 1));
  return {
    mode,
    totalPatients: results.length,
    metrics: [
      { label: "纳入患者", value: `${results.length} 例`, note: "当前为演示队列" },
      { label: "VTE 高危", value: `${highRisk} 例`, note: `${Math.round((highRisk / total) * 100)}%` },
      { label: "急症线索", value: `${urgent} 例`, note: "需优先复核" },
      { label: "出血/禁忌", value: `${bleeding} 例`, note: "当前样例" },
    ],
    departmentDistribution: Array.from(departmentMap.entries()).map(([label, value]) => ({ label, value })),
    qualityIndicators: [
      { label: "入院评估率", value: 86 },
      { label: "动态复评率", value: 72 },
      { label: "护理执行闭环", value: 78 },
      { label: "出院教育记录", value: 69 },
    ],
    managerActions: [
      {
        level: urgent ? "重点" : "关注",
        title: "急症病例优先复核",
        detail: "对出现疑似 PE、股青肿、肢体灌注受威胁等线索的患者生成医生复核和会诊提醒。",
      },
      {
        level: "关注",
        title: "按科室追踪漏评漏防",
        detail: "驾驶舱应支持按科室、病区、诊断、手术、时间段查看评估率、复评率、预防执行率和随访完成率。",
      },
      {
        level: "常规",
        title: "科研与质控双出口",
        detail: "同一批分析结果可形成质控清单、管理报表、病例复盘样本池和真实世界研究变量表。",
      },
    ],
  };
}

function queryCohort(payload) {
  const filters = {
    department: payload.department || "all",
    diagnosis: payload.diagnosis || "all",
    range: payload.range || "7d",
  };
  const cases = cohortDemoCases(filters);
  const results = cases.map((item) => {
    const analysis = analyzeCase({ text: item.text });
    return {
      patientLabel: item.patientLabel,
      department: item.department,
      riskLevel: analysis.riskLevel,
      urgentCount: analysis.urgentFlags.length,
      summary: analysis.clinicalReasoning.keyConclusion,
      analysis,
    };
  });
  const labelMap = {
    all: "全部",
    vascular: "血管外科",
    orthopedics: "骨科",
    obstetrics: "产科",
    oncology: "肿瘤相关科室",
    dvt: "DVT/下肢静脉血栓",
    pe: "PE/肺栓塞",
    surgery: "围术期/手术",
    pregnancy: "妊娠/产褥期",
    "7d": "近7天",
    "30d": "近30天",
    "90d": "近90天",
    custom: "自定义时间段",
  };
  return {
    filters,
    filtersLabel: `${labelMap[filters.department] || filters.department}｜${labelMap[filters.diagnosis] || filters.diagnosis}｜${labelMap[filters.range] || filters.range}`,
    count: results.length,
    results: results.map(({ analysis, ...rest }) => rest),
    dashboard: buildDashboardFromReports(results, "队列模拟"),
    boundary: "当前为模拟队列。真实部署时由院内 HIS/EMR/LIS/PACS 或 VTE 管理系统按权限调取，并在内网批量分析。",
  };
}

function defaultDashboardSummary() {
  const cases = cohortDemoCases({ department: "all", diagnosis: "all", range: "7d" }).map((item) => ({
    ...item,
    analysis: analyzeCase({ text: item.text }),
  }));
  return buildDashboardFromReports(cases, "演示数据");
}

function informatizationLevels() {
  return {
    title: "VTE 防控信息化建设分级",
    sourceNote:
      "依据全国肺栓塞和深静脉血栓形成防治能力建设项目相关中心建设标准、信息化应用与质控管理建议抽象为 MVP 工程路线；正式申报需以最新版评审细则逐条核对。",
    sourceFiles: [
      "全国 VTE 防治能力建设项目信息化应用与质控管理建议",
      "三级医院中心建设标准及评分细则",
      "VTE调研清单2024.xlsx",
      "卫宁Agent_VTE智能体0818.pptx",
      "肺科copilot结合VTE.pptx",
    ],
    vetoItems: [
      "住院患者 VTE 风险评估与预防电子化应作为底线能力，不能只停留在纸质表格或人工台账。",
      "信息系统应能支撑病历数据提取、风险评估、预防措施记录、质控统计和持续改进。",
      "真实部署需纳入院内权限、审计日志、数据安全、接口审批和人工确认闭环。",
    ],
    levels: [
      {
        id: "L0",
        name: "底线达标",
        badge: "必备",
        goal: "住院患者能完成电子化 VTE 风险评估与基本预防记录。",
        features: ["电子化 Caprini/Padua/Wells 等评估入口", "入院24小时内评估提醒", "出血风险/抗凝禁忌核查", "高危患者基础预防措施记录", "评估结果可留痕、可追溯"],
        mvpStatus: "已覆盖演示",
      },
      {
        id: "L1",
        name: "基础信息化",
        badge: "基础",
        goal: "把 VTE 防控从单点评估扩展到住院流程节点。",
        features: ["术前、术后24小时、转科、病情变化、出院前动态复评", "医生/护士/患者多角色任务提醒", "机械预防、药物预防、健康教育记录", "急症线索触发医生复核", "单病例报告导出"],
        mvpStatus: "已覆盖演示",
      },
      {
        id: "L2",
        name: "数据集成",
        badge: "对接",
        goal: "对接 HIS/EMR/LIS/PACS/护理系统或既有 VTE 管理系统，减少人工录入。",
        features: ["病案首页、诊断、手术、医嘱、护理记录、检验自动抽取", "D-二聚体、血小板、凝血、生化等结构化检验接入", "下肢静脉彩超、CTPA/CTV 等影像报告接入", "院内队列筛选与批量分析", "接口字段规范和数据字典"],
        mvpStatus: "接口预留",
      },
      {
        id: "L3",
        name: "质控闭环",
        badge: "质控",
        goal: "支持医院、科室、病区多层级质控和持续改进。",
        features: ["漏评、漏防、未复评、未宣教自动统计", "高危患者处理率、预警响应率、出院随访率", "按科室/病区/病种/时间段驾驶舱", "问题清单下发与整改追踪", "中心建设和评审材料统计出口"],
        mvpStatus: "驾驶舱演示",
      },
      {
        id: "L4",
        name: "智能体增强",
        badge: "升级",
        goal: "在既有信息化基础上增加智能解释、证据追溯和真实世界研究能力。",
        features: ["病例相关 RAG 证据检索", "病例知识图谱与路径推理", "动态时间事件风险轨迹", "EMR 深度审查与病历完善建议", "科研变量抽取、队列构建和模型验证出口"],
        mvpStatus: "已覆盖演示",
      },
      {
        id: "L5",
        name: "区域协同",
        badge: "区域",
        goal: "面向医联体、区域 VTE 防控和远程会诊形成可推广能力。",
        features: ["区域转诊和远程会诊数据接口", "基层医院风险评估与上级医院协同", "跨院随访和患者教育", "区域质控指标汇总", "脱敏数据用于真实世界研究和持续评价"],
        mvpStatus: "规划阶段",
      },
    ],
    triggerScenarios: [
      {
        node: "入院24小时内",
        trigger: "患者完成入院登记或进入医生站/电子病历",
        scale: "按科室匹配 Caprini、Padua、产科量表或综合病区选择",
        mvpStatus: "已覆盖",
      },
      {
        node: "转入/转出24小时内",
        trigger: "转科医嘱、病区变更或护理交接",
        scale: "重新按新科室场景触发 VTE 与出血风险复评",
        mvpStatus: "已覆盖",
      },
      {
        node: "手术前24小时",
        trigger: "手术申请、麻醉评估或术前医嘱",
        scale: "外科 Caprini 为主，同时核查抗凝禁忌和出血风险",
        mvpStatus: "已覆盖",
      },
      {
        node: "手术后24小时",
        trigger: "术后医嘱、手术记录提交或返回病区",
        scale: "术后 VTE 动态复评，结合血红蛋白、血小板、引流和出血情况",
        mvpStatus: "已覆盖",
      },
      {
        node: "病情变化",
        trigger: "新告病危/病重、护理级别升至特级或I级、ICU转入",
        scale: "急症线索优先触发人工复核，不依赖单一量表结论",
        mvpStatus: "已覆盖",
      },
      {
        node: "肺栓塞相关诊断",
        trigger: "PE/PTE 诊断、CTPA报告、低氧/胸痛/晕厥等线索",
        scale: "Wells PE、sPESI/PESI 与影像证据并行展示",
        mvpStatus: "部分覆盖",
      },
      {
        node: "抗凝用药前",
        trigger: "肝素、低分子肝素、华法林、沙班类、达比加群等医嘱",
        scale: "强制核查出血风险、血小板、凝血、肾功能和禁忌证",
        mvpStatus: "已覆盖",
      },
      {
        node: "出院前24小时",
        trigger: "出院医嘱、出院记录或随访计划生成",
        scale: "出院风险、延长期预防、复诊和患者宣教",
        mvpStatus: "已覆盖",
      },
    ],
    departmentScaleMap: [
      { department: "内科", defaultScale: "Padua", note: "肿瘤、感染、心肺疾病、长期卧床等内科风险为主。" },
      { department: "外科/骨科", defaultScale: "Caprini", note: "围术期、创伤、骨折、制动和术后复评为重点。" },
      { department: "产科", defaultScale: "产科 VTE 风险评估量表", note: "妊娠、分娩、剖宫产、产褥期血容量和凝血状态变化需形成时间轨迹。" },
      { department: "综合病区/ICU/急诊", defaultScale: "Caprini + Padua + 人工选择", note: "系统给出推荐量表，医生可按主病种和场景确认。" },
      { department: "肺栓塞场景", defaultScale: "Wells PE + PESI/sPESI", note: "用于疑似或确诊 PE 的诊断概率、严重程度和处置优先级。" },
    ],
    dataDictionaries: [
      {
        name: "抗凝药物字典",
        examples: ["普通肝素", "低分子肝素/达肝素钠", "阿加曲班", "比伐芦定", "华法林", "利伐沙班/阿哌沙班/艾多沙班", "达比加群"],
        use: "触发抗凝前出血风险核查、用药安全提醒和医嘱闭环。",
      },
      {
        name: "机械预防字典",
        examples: ["梯度压力弹力袜", "间歇充气加压", "气压治疗", "足底静脉泵"],
        use: "用于高危且抗凝受限患者的预防措施记录与质控统计。",
      },
      {
        name: "基础预防/护理字典",
        examples: ["早期活动", "踝泵运动", "抬高下肢", "测量腿围", "补液与避免脱水", "VTE健康教育"],
        use: "支持护士端任务、患者宣教和漏防统计。",
      },
      {
        name: "VTE诊断与死亡线索",
        examples: ["DVT", "下肢深静脉血栓", "PE/PTE", "肺栓塞", "血栓", "栓塞"],
        use: "用于病例筛选、结局识别、死亡病例追踪和质控复盘。",
      },
    ],
    qualityMetrics: [
      "入院后24小时内 VTE 风险评估率",
      "手术前24小时内 VTE 风险评估率",
      "手术后24小时内 VTE 风险评估率",
      "转科前/转科后24小时内 VTE 风险评估率",
      "出院前24小时内 VTE 风险评估率",
      "入院、术前、术后、转科节点出血风险评估率",
      "VTE 中高危患者比例与预防措施实施率",
      "抗凝禁忌、血小板低值、活动性出血等安全事件复核率",
      "患者宣教知晓率、出院随访完成率、预警响应率",
      "院内 VTE 发生率、PE 死亡率和复发/血栓后综合征随访指标",
    ],
    systemPrerequisites: [
      "HIS、EMR、CIS、LIS、PACS、手术麻醉、护理系统和既有 VTE 系统接口授权。",
      "CDR 或轻量级专病数据集市，用于统一患者、住院、诊断、手术、医嘱、检验、检查和护理字段。",
      "CDSS 或医生站嵌入能力，支持弹窗提醒、量表审核、医嘱跳转和任务闭环。",
      "统一字典维护：科室类别、药品编码、医嘱项目、诊断编码、检验项目和影像报告关键词。",
      "权限控制、审计日志、人工确认、脱敏导出和模型/知识库版本管理。",
    ],
    agentUpgradeItems: [
      {
        name: "一键评估助手",
        detail: "从病历、诊断、手术、医嘱、检验和影像报告自动抽取依据，生成可审核的量表建议。",
        source: "卫宁 Agent 与肺科 Copilot 均反复出现的核心场景。",
      },
      {
        name: "证据详情与RAG问答",
        detail: "每条风险因子、禁忌证和建议均保留病例依据与知识库依据，避免黑箱式结论。",
        source: "卫宁方案中的知识库、证据检索和专科模型训练方向。",
      },
      {
        name: "动态时间轨迹",
        detail: "围绕入院、转科、手术、分娩、病情变化、出院和随访节点持续刷新风险，而不是只给一次性评分。",
        source: "结合调研表触发节点和用户对孕产妇案例的修正要求。",
      },
      {
        name: "医生站闭环",
        detail: "评估后进入审核、预防医嘱、护理任务、宣教和质控统计，形成临床工作流闭环。",
        source: "肺科 Copilot 演示中的评估后跳转与预防医嘱流程。",
      },
    ],
  };
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    jsonResponse(res, 200, {
      status: "ok",
      service: "VTE Agent MVP",
      version: "0.1.0",
      mode: "demo-local",
      time: new Date().toISOString(),
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/demo-cases") {
    jsonResponse(res, 200, { cases: demoCases });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/knowledge/stats") {
    jsonResponse(res, 200, {
      total: knowledgeBase.length,
      withAbstract: knowledgeStats.withAbstract,
      withPdf: knowledgeStats.withPdf,
      coreGuidelines: knowledgeStats.coreGuidelines || knowledgeBase.filter((item) => item.evidence && item.evidence.sourceTier === "core_guideline").length,
      generatedAt: knowledgeStats.generatedAt || "",
      sources: knowledgeStats.sources || [],
      boundary: "当前为 VTE 文献矩阵结构化条目；全文 PDF 尚未批量向量化。",
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/knowledge/graph") {
    jsonResponse(res, 200, knowledgeGraph);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/knowledge/graph/case") {
    const body = await readRequestBody(req);
    jsonResponse(res, 200, buildCaseKnowledgeGraph(body));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/connector-schema") {
    jsonResponse(res, 200, connectorSchema);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/model/status") {
    jsonResponse(res, 200, await publicModelStatus());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/model/presets") {
    jsonResponse(res, 200, { presets: await publicModelPresets() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/model/complete") {
    const body = await readRequestBody(req);
    jsonResponse(res, 200, await callModel(body));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/rag/query") {
    const body = await readRequestBody(req);
    const query = String(body.query || "");
    jsonResponse(res, 200, {
      query,
      answer: buildRagAnswer(query),
      evidence: retrieveKnowledge(query, Number(body.limit || 5)),
      boundary: "当前检索结果来自 VTE 文献矩阵结构化知识库，不作为诊疗依据；正式版本需增加全文向量化、证据等级和专家审核。",
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/document/ingest-preview") {
    const body = await readRequestBody(req);
    jsonResponse(res, 200, ingestDocumentPreview(body));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/cohort/query") {
    const body = await readRequestBody(req);
    jsonResponse(res, 200, queryCohort(body));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/dashboard/summary") {
    jsonResponse(res, 200, defaultDashboardSummary());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/informatization/levels") {
    jsonResponse(res, 200, informatizationLevels());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/analyze") {
    const body = await readRequestBody(req);
    jsonResponse(res, 200, await analyzeCaseWithOptionalModel(body));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/report/markdown") {
    const body = await readRequestBody(req);
    const report = await analyzeCaseWithOptionalModel(body);
    const graph = buildCaseKnowledgeGraph(body);
    const emrReview = reviewEmr(body);
    jsonResponse(res, 200, {
      fileName: reportFileName(report, "md"),
      mimeType: "text/markdown; charset=utf-8",
      markdown: buildMarkdownReport(report, graph, emrReview),
      auditId: report.meta.auditId,
      riskLevel: report.riskLevel,
      boundary: "当前为 MVP 单病例分析报告导出，不作为独立诊疗依据；正式部署需接入院内审计、权限和报告留痕。",
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/report/html") {
    const body = await readRequestBody(req);
    const report = await analyzeCaseWithOptionalModel(body);
    const graph = buildCaseKnowledgeGraph(body);
    const emrReview = reviewEmr(body);
    jsonResponse(res, 200, {
      fileName: reportFileName(report, "html"),
      mimeType: "text/html; charset=utf-8",
      html: buildHtmlReport(report, graph, emrReview),
      auditId: report.meta.auditId,
      riskLevel: report.riskLevel,
      boundary: "当前为 MVP 单病例分析报告导出，不作为独立诊疗依据；PDF 由浏览器打印功能生成，正式部署需接入院内审计、权限和报告留痕。",
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/emr/review") {
    const body = await readRequestBody(req);
    jsonResponse(res, 200, reviewEmr(body));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/batch-analyze") {
    const body = await readRequestBody(req);
    const cases = Array.isArray(body.cases) ? body.cases.slice(0, 50) : [];
    const results = cases.map((item) => analyzeCase(item));
    jsonResponse(res, 200, {
      count: results.length,
      results,
      boundary: "MVP 批量接口限制 50 条；真实病历批量分析需在内网服务器执行。",
    });
    return;
  }

  jsonResponse(res, 404, { error: "API endpoint not found" });
}

function buildRagAnswer(query) {
  const evidence = retrieveKnowledge(query, 3);
  if (!query.trim()) return "请输入 VTE 相关问题。";
  if (evidence.length === 0) return "当前演示知识库未检索到足够相关条目。正式版本应调用真实 VTE 文献和院内路径知识库。";
  const q = query.toLowerCase();
  const hasPregnancy = /妊娠|怀孕|孕|pregnan/.test(query);
  const hasPhlegmasia = /股青肿|phlegmasia|肢体灌注|皮温降低|张力/.test(query);
  const hasDvt = /\bdvt\b|deep vein thrombosis|深静脉血栓|下肢dvt|下肢血栓|下肢肿痛/i.test(query);
  const hasPe = /\bpe\b|pulmonary embolism|肺栓塞|肺动脉栓塞|呼吸困难/i.test(q);
  const hasAnticoagulation = /抗凝|低分子肝素|肝素|出血|安全/.test(query);
  const topTitles = evidence.slice(0, 3).map((item) => `《${item.title}》`).join("、");

  if (hasPregnancy && hasPhlegmasia && hasDvt) {
    return [
      "本病例的 RAG 焦点应锁定为：妊娠早期疑似急性下肢 DVT，并已出现股青肿/肢体灌注受威胁线索。",
      `当前知识库优先可用证据为 ${topTitles}。这些证据更适合支撑 DVT 诊断、下肢血管超声/CTA-CTV、急症分层和血管外科处理路径。`,
      "需要特别提示：当前本地文献矩阵中妊娠 VTE 与股青肿的高等级指南证据仍偏少，正式知识库应补充妊娠期 VTE 抗凝、影像选择、产科协同和股青肿急症处理的权威指南/共识。",
      "病例层面不应只生成普通围术期预防建议，应先提示医生床旁复核患肢灌注、立即完善血管影像、评估治疗性抗凝及血管外科急会诊，再讨论围术期 VTE 防控。",
    ].join("");
  }
  if (hasPregnancy && hasPe) {
    return [
      "本病例的 RAG 焦点应锁定为：妊娠相关 VTE 合并疑似 PE。",
      `当前优先证据为 ${topTitles}。应围绕生命体征/氧合、DVT 与 PE 诊断路径、妊娠期影像选择、抗凝安全和产科协同进行证据追溯。`,
      "若用于正式部署，应补齐妊娠期 PE/DVT 专门指南和院内产科-血管外科-呼吸/急诊协同流程。",
    ].join("");
  }
  if (hasPhlegmasia && hasDvt) {
    return [
      "本病例的 RAG 焦点应锁定为：急性症状性下肢 DVT 合并股青肿/肢体灌注受威胁。",
      `当前优先证据为 ${topTitles}。普通预防策略应后置，首先追溯急症诊断、血管影像、治疗性抗凝、介入/手术评估和血管外科会诊证据。`,
    ].join("");
  }
  if (hasDvt || hasPe || hasAnticoagulation) {
    return `基于当前知识库，优先证据为 ${topTitles}。本次回答应围绕病例中已出现的 VTE 亚型、急症线索、影像诊断、抗凝安全和护理复评展开，避免泛化到无关风险因素。`;
  }
  return `基于当前知识库，优先证据为 ${topTitles}。建议进一步补充病例场景、VTE 亚型、急症线索、出血风险和复评节点后再生成建议草案。`;
}

function matchGraphCaseRules(text) {
  return (knowledgeGraph.caseRules || [])
    .map((rule) => {
      const matchedTriggers = (rule.triggers || []).filter((term) => text.includes(term));
      return {
        ...rule,
        matchedTriggers,
        matched: matchedTriggers.length >= Number(rule.minMatches || 1),
      };
    })
    .filter((rule) => rule.matched);
}

function graphNodeExists(id) {
  return (knowledgeGraph.nodes || []).some((node) => node.id === id);
}

function graphTopicNodeIds(text) {
  const t = text.toLowerCase();
  const ids = [];
  if (/pe|肺栓塞|肺动脉栓塞|呼吸困难|胸痛|咯血/i.test(text)) ids.push("subtype_pe", "topic_imaging");
  if (/dvt|深静脉血栓|下肢肿痛|下肢胀痛|左下肢|右下肢/i.test(text)) ids.push("subtype_dvt", "topic_imaging");
  if (/抗凝|低分子肝素|肝素|出院|治疗/i.test(text)) ids.push("topic_anticoagulation");
  if (/预防|护理|活动|卧床|康复|围术期/i.test(text)) ids.push("topic_prevention_care");
  if (matchAnyTerm(text, ["活动性出血", "出血风险", "消化道出血", "抗凝禁忌", "血小板降低", "血小板显著降低", "肾功能异常", "肌酐升高"])) {
    ids.push("topic_bleeding_safety");
  }
  if (/介入|滤器|血栓清除|pert/i.test(t)) ids.push("topic_intervention");
  if (/模型|预测|ai|机器学习/i.test(t)) ids.push("topic_ai_model");
  return ids.filter(graphNodeExists);
}

function relevanceLevel(score) {
  if (score >= 0.85) return "high";
  if (score >= 0.6) return "medium";
  return "low";
}

function addNodeRelevance(map, id, score, reason) {
  if (!id || !graphNodeExists(id)) return;
  const existing = map[id];
  if (!existing || score > existing.score) {
    map[id] = {
      score: Number(score.toFixed(2)),
      level: relevanceLevel(score),
      reason,
    };
  }
}

function chronicImmobilityGraphOverlay(text) {
  if (!hasChronicImmobility(text)) return { nodes: [], edges: [], ids: [] };
  const nodes = [
    { id: "chronic_immobility_platform", label: "截瘫/长期制动持续风险", type: "risk_pattern", group: "risk" },
    { id: "rehabilitation_followup", label: "康复与随访管理", type: "care_task", group: "workflow" },
    { id: "mechanical_prevention_adherence", label: "机械预防依从性", type: "care_task", group: "workflow" },
    { id: "skin_infection_monitoring", label: "皮肤/感染风险监测", type: "care_task", group: "workflow" },
  ];
  const edges = [
    { source: "immobility", target: "chronic_immobility_platform", relation: "形成持续风险" },
    { source: "chronic_immobility_platform", target: "rehabilitation_followup", relation: "需要长期管理" },
    { source: "chronic_immobility_platform", target: "mechanical_prevention_adherence", relation: "需要依从性核查" },
    { source: "chronic_immobility_platform", target: "skin_infection_monitoring", relation: "需要并发风险监测" },
    { source: "rehabilitation_followup", target: "topic_prevention_care", relation: "关联护理康复" },
  ].filter((edge) => edge.source === "chronic_immobility_platform" || edge.target === "chronic_immobility_platform" || graphNodeExists(edge.source) || graphNodeExists(edge.target));
  return { nodes, edges, ids: nodes.map((node) => node.id) };
}

function buildCaseKnowledgeGraph(payload) {
  const text = normalizePatientContext(payload).trim();
  const analysis = text ? analyzeCase({ text }) : null;
  const graphOverlay = text ? chronicImmobilityGraphOverlay(text) : { nodes: [], edges: [], ids: [] };
  const graphNodes = [...(knowledgeGraph.nodes || []), ...graphOverlay.nodes];
  const graphEdges = [...(knowledgeGraph.edges || []), ...graphOverlay.edges];
  const matchedRules = text ? matchGraphCaseRules(text) : [];
  const caseEvidence = text ? retrieveKnowledge(text, 6) : [];
  const evidenceNodeIds = caseEvidence
    .map((item) => {
      const found = graphNodes.find((node) => node.type === "evidence_item" && node.sourceId === item.id);
      return found && found.id;
    })
    .filter(Boolean);
  const topicNodeIds = text ? graphTopicNodeIds(text) : [];
  const urgentNodeIds = analysis
    ? analysis.urgentFlags.flatMap((flag) =>
        flag.key === "limb_ischemia"
          ? ["limb_ischemia_signal", "phlegmasia", "urgent_triage"]
          : flag.key === "acute_symptomatic_dvt"
            ? ["symptomatic_dvt", "urgent_triage"]
            : flag.key === "suspected_pe"
              ? ["suspected_pe", "urgent_triage", "pe_imaging"]
            : [],
      )
    : [];
  const riskNodeIds = analysis
    ? analysis.riskFactors.flatMap((factor) => {
        const mapping = {
          age: "advanced_age",
          surgery: "perioperative_surgery",
          cancer: "cancer_related_risk",
          immobility: "immobility",
          obesity: "obesity",
          ddimer: "ddimer_high",
          pregnancy: "pregnancy_risk",
        };
        return mapping[factor.key] ? [mapping[factor.key]] : [];
      })
    : [];
  const compositeRiskNodeIds = /腹盆腔/.test(text) && /肿瘤|癌/.test(text) && /手术|拟行|术前/.test(text) ? ["major_abdominopelvic_cancer_surgery"] : [];
  const nodeRelevance = {};
  riskNodeIds.forEach((id) => addNodeRelevance(nodeRelevance, id, 0.82, "病例直接风险因素命中"));
  compositeRiskNodeIds.forEach((id) => addNodeRelevance(nodeRelevance, id, 0.9, "病例直接命中复合高危场景"));
  graphOverlay.ids.forEach((id) => {
    const score = id === "chronic_immobility_platform" ? 0.9 : 0.78;
    nodeRelevance[id] = {
      score,
      level: relevanceLevel(score),
      reason: "截瘫/长期制动病例路径补充",
    };
  });
  urgentNodeIds.forEach((id) => addNodeRelevance(nodeRelevance, id, 0.95, "病例急症/症状线索直接命中"));
  topicNodeIds.forEach((id) => addNodeRelevance(nodeRelevance, id, 0.58, "病例文本关联文献主题"));
  evidenceNodeIds.forEach((id, index) => addNodeRelevance(nodeRelevance, id, Math.max(0.45, 0.72 - index * 0.05), "RAG 检索关联证据"));
  if (analysis && analysis.riskLevel === "高危") {
    addNodeRelevance(nodeRelevance, "vte_risk", 0.72, "病例风险分层关联");
    addNodeRelevance(nodeRelevance, "caprini", 0.62, "手术/围术期风险评估工具关联");
    addNodeRelevance(nodeRelevance, "high_risk", 0.72, "病例风险分层输出");
  }
  matchedRules.forEach((rule) => {
    (rule.highlightNodes || []).forEach((id) => addNodeRelevance(nodeRelevance, id, 0.68, `路径规则激活：${rule.label}`));
  });
  const highlightedNodeIds = Array.from(
    new Set([
      ...riskNodeIds,
      ...compositeRiskNodeIds,
      ...graphOverlay.ids,
      ...(analysis && analysis.riskLevel === "高危" ? ["vte_risk", "caprini", "high_risk"] : []),
      ...urgentNodeIds,
      ...topicNodeIds,
      ...evidenceNodeIds,
      ...matchedRules.flatMap((rule) => rule.highlightNodes || []),
    ]),
  );
  const highlightedEdgeSet = new Set(
    graphEdges
      .filter((edge) => highlightedNodeIds.includes(edge.source) && highlightedNodeIds.includes(edge.target))
      .map((edge) => `${edge.source}->${edge.target}`),
  );

  return {
    ...knowledgeGraph,
    nodes: graphNodes,
    edges: graphEdges,
    caseView: {
      inputSummary: text ? summarizeText(text) : "",
      riskLevel: analysis ? analysis.riskLevel : "",
      urgentFlags: analysis ? analysis.urgentFlags : [],
      riskFactors: analysis ? analysis.riskFactors : [],
      evidence: caseEvidence,
      matchedRules,
      highlightedNodeIds,
      highlightedNodeRelevance: nodeRelevance,
      highlightedEdgeIds: Array.from(highlightedEdgeSet),
      summary: matchedRules.length
        ? matchedRules.map((rule) => rule.summary).join("；")
        : "当前病例未触发专门路径，高亮主要来自风险因素和风险分层。",
    },
  };
}

function serveStatic(req, res) {
  const filePath = safeStaticPath(req.url);
  if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    textResponse(res, 404, "Not found");
    return;
  }
  const ext = path.extname(filePath);
  const contentType = mimeTypes[ext] || "application/octet-stream";
  fs.createReadStream(filePath)
    .on("error", () => textResponse(res, 500, "Static file error"))
    .on("open", () =>
      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
      }),
    )
    .pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    serveStatic(req, res);
  } catch (error) {
    jsonResponse(res, error.status || 500, {
      error: error.message || "Internal server error",
    });
  }
});

server.listen(PORT, () => {
  console.log(`VTE Agent MVP running at http://localhost:${PORT}`);
});
