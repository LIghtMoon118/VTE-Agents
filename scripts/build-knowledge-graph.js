const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const knowledge = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "knowledge.json"), "utf8"));
const clinicalSeed = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "knowledge-graph.json"), "utf8"));

const topicPatterns = [
  { id: "topic_ai_model", label: "AI/机器学习/预测模型", terms: ["AI/机器学习/预测模型", "machine learning", "artificial intelligence", "prediction model", "预测模型", "机器学习"] },
  { id: "topic_imaging", label: "影像/CTPA/超声诊断", terms: ["影像/CTPA/超声诊断", "CTPA", "ultrasound", "超声", "彩色多普勒", "imaging"] },
  { id: "topic_cohort", label: "真实世界/队列/流行病学", terms: ["真实世界/队列/流行病学", "cohort", "registry", "real-world", "流行病学"] },
  { id: "topic_intervention", label: "介入/血栓清除/滤器", terms: ["介入/血栓清除/滤器", "catheter", "thrombectomy", "filter", "PERT", "介入", "滤器", "血栓清除"] },
  { id: "topic_anticoagulation", label: "抗凝/药物治疗", terms: ["抗凝/药物治疗", "anticoagulation", "anticoagulant", "LMWH", "heparin", "抗凝", "低分子肝素"] },
  { id: "topic_guideline_review", label: "指南/综述/Meta", terms: ["指南/综述/Meta", "guideline", "consensus", "review", "meta-analysis", "指南", "共识", "综述"] },
  { id: "topic_bleeding_safety", label: "出血/安全性", terms: ["出血/安全性", "bleeding", "safety", "出血", "安全性"] },
  { id: "topic_prevention_care", label: "预防/护理/康复", terms: ["预防/护理/康复", "prevention", "prophylaxis", "nursing", "rehabilitation", "预防", "护理", "康复"] },
];

const subtypeNodes = [
  { id: "subtype_dvt", label: "DVT", match: "DVT" },
  { id: "subtype_pe", label: "PE", match: "PE" },
  { id: "subtype_other", label: "其他静脉血栓", match: "其他静脉血栓" },
];

const typeNodeId = (value) => `study_${slug(value)}`;
const evidenceNodeId = (item) => `evidence_${slug(item.id)}`;

function slug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function addNode(map, node) {
  if (!node || !node.id) return;
  if (!map.has(node.id)) map.set(node.id, { ...node });
}

function addEdge(list, seen, edge) {
  if (!edge || !edge.source || !edge.target) return;
  const id = `${edge.source}->${edge.target}:${edge.relation || ""}`;
  if (seen.has(id)) return;
  seen.add(id);
  list.push(edge);
}

function hasAnyText(item, terms) {
  const text = `${item.title || ""} ${item.content || ""} ${(item.keywords || []).join(" ")} ${item.type || ""} ${(item.evidence && item.evidence.studyType) || ""}`.toLowerCase();
  return terms.some((term) => text.includes(String(term).toLowerCase()));
}

function evidenceTier(item) {
  const ev = item.evidence || {};
  if (ev.sourceTier === "core_guideline") return { id: "tier_core_guideline", label: "核心指南/共识" };
  if (/指南|共识|guideline|consensus/i.test(`${item.type || ""} ${item.title || ""} ${ev.studyType || ""}`)) return { id: "tier_guideline", label: "指南/共识" };
  if (/systematic|meta|综述|review/i.test(`${item.title || ""} ${ev.studyType || ""}`)) return { id: "tier_review_meta", label: "综述/Meta" };
  if (/cohort|registry|real-world|队列|真实世界/i.test(`${item.title || ""} ${ev.studyType || ""}`)) return { id: "tier_cohort", label: "真实世界/队列" };
  return { id: "tier_general_literature", label: "普通文献" };
}

function buildGraph() {
  const nodes = new Map();
  const edges = [];
  const edgeSeen = new Set();

  for (const node of clinicalSeed.nodes || []) addNode(nodes, { ...node, source: "clinical_seed" });
  for (const edge of clinicalSeed.edges || []) addEdge(edges, edgeSeen, { ...edge, sourceType: "clinical_seed" });

  addNode(nodes, { id: "literature_matrix", label: "VTE 文献矩阵", type: "corpus", group: "evidence", source: "knowledge_json" });
  addNode(nodes, { id: "evidence_layer", label: "证据层", type: "layer", group: "evidence", source: "knowledge_json" });
  addEdge(edges, edgeSeen, { source: "literature_matrix", target: "evidence_layer", relation: "构建" });

  for (const node of subtypeNodes) {
    addNode(nodes, { id: node.id, label: node.label, type: "vte_subtype", group: "evidence", source: "knowledge_json" });
    addEdge(edges, edgeSeen, { source: "evidence_layer", target: node.id, relation: "覆盖亚型" });
  }
  for (const topic of topicPatterns) {
    addNode(nodes, { id: topic.id, label: topic.label, type: "topic", group: "evidence", source: "knowledge_json" });
    addEdge(edges, edgeSeen, { source: "evidence_layer", target: topic.id, relation: "主题聚类" });
  }

  const ranked = [...knowledge].sort((a, b) => {
    const ap = Number((a.evidence && a.evidence.priorityScore) || 0) + (a.evidence && a.evidence.sourceTier === "core_guideline" ? 100 : 0);
    const bp = Number((b.evidence && b.evidence.priorityScore) || 0) + (b.evidence && b.evidence.sourceTier === "core_guideline" ? 100 : 0);
    return bp - ap || Number(b.year || 0) - Number(a.year || 0);
  });
  const topEvidence = ranked.slice(0, 80);

  for (const item of knowledge) {
    const ev = item.evidence || {};
    const subtype = subtypeNodes.find((node) => ev.vteSubtype === node.match || (item.scenario || []).includes(node.match));
    const typeId = typeNodeId(item.type || ev.studyType || "未分类");
    addNode(nodes, { id: typeId, label: item.type || ev.studyType || "未分类", type: "study_type", group: "evidence", source: "knowledge_json" });
    addEdge(edges, edgeSeen, { source: "evidence_layer", target: typeId, relation: "研究类型" });
    if (subtype) addEdge(edges, edgeSeen, { source: subtype.id, target: typeId, relation: "包含文献类型" });

    const tier = evidenceTier(item);
    addNode(nodes, { id: tier.id, label: tier.label, type: "evidence_tier", group: "evidence", source: "knowledge_json" });
    addEdge(edges, edgeSeen, { source: typeId, target: tier.id, relation: "证据等级" });

    for (const topic of topicPatterns) {
      if (hasAnyText(item, topic.terms)) {
        if (subtype) addEdge(edges, edgeSeen, { source: subtype.id, target: topic.id, relation: "相关主题" });
        addEdge(edges, edgeSeen, { source: topic.id, target: tier.id, relation: "证据支持" });
      }
    }
  }

  for (const item of topEvidence) {
    const ev = item.evidence || {};
    const nodeId = evidenceNodeId(item);
    const title = item.title.length > 56 ? `${item.title.slice(0, 56)}...` : item.title;
    addNode(nodes, {
      id: nodeId,
      label: title,
      type: "evidence_item",
      group: "evidence",
      year: item.year,
      sourceId: item.id,
      sourceTitle: item.title,
      priorityScore: ev.priorityScore || 0,
      fulltextStatus: ev.fulltextStatus || "",
      source: "knowledge_json",
    });
    addEdge(edges, edgeSeen, { source: "literature_matrix", target: nodeId, relation: "优先证据" });
    const subtype = subtypeNodes.find((node) => ev.vteSubtype === node.match || (item.scenario || []).includes(node.match));
    if (subtype) addEdge(edges, edgeSeen, { source: nodeId, target: subtype.id, relation: "研究亚型" });
    addEdge(edges, edgeSeen, { source: nodeId, target: typeNodeId(item.type || ev.studyType || "未分类"), relation: "研究类型" });
    addEdge(edges, edgeSeen, { source: nodeId, target: evidenceTier(item).id, relation: "证据等级" });
    for (const topic of topicPatterns) {
      if (hasAnyText(item, topic.terms)) addEdge(edges, edgeSeen, { source: nodeId, target: topic.id, relation: "主题" });
    }
  }

  const bridgeEdges = [
    ["topic_prevention_care", "perioperative_plan", "证据支持"],
    ["topic_prevention_care", "mechanical_prophylaxis", "证据支持"],
    ["topic_anticoagulation", "therapeutic_anticoagulation", "证据支持"],
    ["topic_anticoagulation", "pharmacologic_prophylaxis", "证据支持"],
    ["topic_bleeding_safety", "bleeding_assessment", "证据支持"],
    ["topic_imaging", "duplex_ultrasound", "证据支持"],
    ["topic_imaging", "pe_imaging", "证据支持"],
    ["topic_intervention", "thrombus_removal", "证据支持"],
    ["topic_ai_model", "vte_risk", "预测支持"],
    ["subtype_dvt", "symptomatic_dvt", "疾病亚型"],
    ["subtype_pe", "suspected_pe", "疾病亚型"],
  ];
  for (const [source, target, relation] of bridgeEdges) addEdge(edges, edgeSeen, { source, target, relation, sourceType: "literature_bridge" });

  return {
    version: "0.2.0",
    updatedAt: new Date().toISOString().slice(0, 10),
    scope: "VTE literature-matrix grounded clinical knowledge graph MVP",
    boundary: "基础图谱由 VTE 文献矩阵 knowledge.json 自动生成，并叠加少量临床路径种子节点；病例仅用于激活相关子图，不作为临时造图依据。",
    source: {
      corpus: "data/knowledge.json",
      literatureCount: knowledge.length,
      evidenceItemNodeLimit: topEvidence.length,
      clinicalSeed: "data/knowledge-graph.json",
    },
    nodes: [...nodes.values()],
    edges,
    caseRules: clinicalSeed.caseRules || [],
  };
}

const graph = buildGraph();
const outputPath = path.join(DATA_DIR, "knowledge-graph.generated.json");
fs.writeFileSync(outputPath, `${JSON.stringify(graph, null, 2)}\n`);
console.log(`Generated ${outputPath}`);
console.log(`Nodes: ${graph.nodes.length}; edges: ${graph.edges.length}; source literature: ${graph.source.literatureCount}`);
