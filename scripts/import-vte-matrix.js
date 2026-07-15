const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const MATRIX_ROOT = "/Users/zgj/Library/Mobile Documents/com~apple~CloudDocs/Research/科研/VTE文献矩阵";

const SOURCES = [
  {
    path: path.join(MATRIX_ROOT, "03_筛选矩阵", "优先阅读清单_模型指南介入.csv"),
    tier: "priority",
  },
  {
    path: path.join(MATRIX_ROOT, "03_筛选矩阵", "VTE文献矩阵_精简工作版.csv"),
    tier: "working",
  },
];

const CATEGORY_TERMS = [
  ["AI/机器学习/预测模型", ["AI", "机器学习", "预测模型", "人工智能", "模型"]],
  ["影像/CTPA/超声诊断", ["影像", "CTPA", "超声", "诊断", "computed tomography", "ultrasound"]],
  ["指南/综述/Meta", ["指南", "综述", "Meta", "review", "systematic review", "meta-analysis"]],
  ["介入/血栓清除/滤器", ["介入", "血栓清除", "滤器", "thrombectomy", "catheter", "filter", "PERT"]],
  ["抗凝/药物治疗", ["抗凝", "药物", "anticoagulation", "warfarin", "rivaroxaban", "heparin"]],
  ["真实世界/队列/流行病学", ["真实世界", "队列", "流行病学", "cohort", "registry", "real-world"]],
  ["预防/护理/康复", ["预防", "护理", "康复", "prevention", "prophylaxis", "rehabilitation"]],
  ["出血/安全性", ["出血", "安全", "bleeding", "safety"]],
];

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  const normalized = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    const next = normalized[i + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length === 0) return [];

  const headers = rows[0].map((item) => item.trim());
  return rows
    .slice(1)
    .filter((items) => items.some((item) => item.trim()))
    .map((items) => {
      const record = {};
      headers.forEach((header, index) => {
        record[header] = (items[index] || "").trim();
      });
      return record;
    });
}

function splitTerms(value) {
  return String(value || "")
    .split(/[;；,，|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function inferCategories(record) {
  const direct = splitTerms(record["优先主题标签"]);
  const combined = [
    record["title"],
    record["abstract"],
    record["keywords"],
    record["主题分类"],
    record["研究类型"],
    record["模型/干预"],
    record["人群/场景"],
  ]
    .join(" ")
    .toLowerCase();
  const inferred = CATEGORY_TERMS.filter(([, terms]) => terms.some((term) => combined.includes(term.toLowerCase()))).map(([label]) => label);
  return Array.from(new Set([...direct, ...inferred]));
}

function inferType(record, categories) {
  const titleAndStudyType = [record["title"], record["研究类型"]].join(" ").toLowerCase();
  const text = [record["title"], record["abstract"], record["研究类型"], categories.join(";")].join(" ").toLowerCase();
  if (titleAndStudyType.includes("guideline") || titleAndStudyType.includes("指南") || titleAndStudyType.includes("consensus") || titleAndStudyType.includes("共识")) return "指南共识";
  if (text.includes("systematic review") || text.includes("meta-analysis") || text.includes("review") || text.includes("综述") || text.includes("meta")) return "综述/Meta";
  if (text.includes("machine learning") || text.includes("artificial intelligence") || text.includes("预测模型") || text.includes("机器学习")) return "AI/预测模型";
  if (text.includes("cohort") || text.includes("registry") || text.includes("real-world") || text.includes("队列")) return "真实世界/队列";
  if (text.includes("catheter") || text.includes("thrombectomy") || text.includes("intervention") || text.includes("介入")) return "介入治疗";
  if (text.includes("anticoag") || text.includes("warfarin") || text.includes("rivaroxaban") || text.includes("抗凝")) return "抗凝/治疗";
  return record["vte_subtype"] || "VTE 文献";
}

function buildKeywords(record, categories) {
  const terms = [
    record["vte_subtype"],
    record["database"],
    record["journal"],
    record["year"],
    ...splitTerms(record["keywords"]),
    ...splitTerms(record["主题分类"]),
    ...splitTerms(record["研究类型"]),
    ...splitTerms(record["人群/场景"]),
    ...splitTerms(record["模型/干预"]),
    ...splitTerms(record["结局指标"]),
    ...categories,
  ];
  return Array.from(new Set(terms.map((item) => item.trim()).filter(Boolean))).slice(0, 80);
}

function buildContent(record, categories) {
  const parts = [
    record["title"],
    record["abstract"],
    record["keywords"] && `关键词：${record["keywords"]}`,
    categories.length && `主题标签：${categories.join("；")}`,
    record["人群/场景"] && `人群/场景：${record["人群/场景"]}`,
    record["模型/干预"] && `模型/干预：${record["模型/干预"]}`,
    record["结局指标"] && `结局指标：${record["结局指标"]}`,
  ].filter(Boolean);
  return parts.join("\n");
}

function sourceText(record) {
  const ids = [
    record["pmid"] && `PMID:${record["pmid"]}`,
    record["pmcid"] && `PMCID:${record["pmcid"]}`,
    record["doi"] && `DOI:${record["doi"]}`,
  ].filter(Boolean);
  return [record["journal"], record["year"], ids.join(" | "), record["url"]].filter(Boolean).join(" | ");
}

function stableId(record) {
  if (record["matrix_id"]) return record["matrix_id"];
  if (record["pmid"]) return `PMID-${record["pmid"]}`;
  if (record["doi"]) return `DOI-${record["doi"].toLowerCase()}`;
  return `TITLE-${Buffer.from(record["title"] || Math.random().toString()).toString("hex").slice(0, 16)}`;
}

function toKnowledge(record, sourceTier) {
  const categories = inferCategories(record);
  const content = buildContent(record, categories);
  const localPath = record["local_fulltext_path"] ? path.join(MATRIX_ROOT, record["local_fulltext_path"]) : "";
  return {
    id: stableId(record),
    type: inferType(record, categories),
    title: record["title"] || "(无题名)",
    source: sourceText(record) || "VTE 文献矩阵",
    year: record["year"] || "",
    scenario: splitTerms(record["人群/场景"]).concat(record["vte_subtype"] || []).filter(Boolean),
    content,
    keywords: buildKeywords(record, categories),
    evidence: {
      database: record["database"] || "",
      vteSubtype: record["vte_subtype"] || "",
      authors: record["authors"] || "",
      journal: record["journal"] || "",
      publicationDate: record["publication_date"] || "",
      doi: record["doi"] || "",
      pmid: record["pmid"] || "",
      pmcid: record["pmcid"] || "",
      url: record["url"] || "",
      fulltextStatus: record["fulltext_status"] || "",
      localFulltextPath: localPath,
      screeningConclusion: record["初筛结论"] || "",
      topicCategory: record["主题分类"] || "",
      studyType: record["研究类型"] || "",
      populationScenario: record["人群/场景"] || "",
      modelOrIntervention: record["模型/干预"] || "",
      outcomes: record["结局指标"] || "",
      priorityTags: record["优先主题标签"] || "",
      priorityScore: Number(record["优先分"] || 0),
      sourceTier,
    },
  };
}

function main() {
  const byId = new Map();
  const stats = { sources: [], totalRows: 0, imported: 0, withAbstract: 0, withPdf: 0 };

  SOURCES.forEach((source) => {
    const records = parseCsv(fs.readFileSync(source.path, "utf8"));
    stats.sources.push({ file: source.path, tier: source.tier, rows: records.length });
    stats.totalRows += records.length;
    records.forEach((record) => {
      if (!record["title"]) return;
      const item = toKnowledge(record, source.tier);
      const key = item.evidence.pmid || item.evidence.doi || item.title.toLowerCase();
      const existing = byId.get(key);
      if (!existing || (item.evidence.priorityScore || 0) > (existing.evidence.priorityScore || 0) || item.evidence.sourceTier === "priority") {
        byId.set(key, item);
      }
    });
  });

  const items = Array.from(byId.values()).sort((a, b) => {
    const scoreDiff = (b.evidence.priorityScore || 0) - (a.evidence.priorityScore || 0);
    if (scoreDiff !== 0) return scoreDiff;
    return Number(b.year || 0) - Number(a.year || 0);
  });

  stats.imported = items.length;
  stats.withAbstract = items.filter((item) => item.content && item.content.length > item.title.length + 20).length;
  stats.withPdf = items.filter((item) => item.evidence.localFulltextPath).length;

  fs.copyFileSync(path.join(DATA_DIR, "knowledge.json"), path.join(DATA_DIR, "knowledge.demo-backup.json"));
  fs.writeFileSync(path.join(DATA_DIR, "knowledge.json"), `${JSON.stringify(items, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(DATA_DIR, "knowledge.import-stats.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), ...stats }, null, 2)}\n`, "utf8");

  console.log(JSON.stringify(stats, null, 2));
}

main();
