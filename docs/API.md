# VTE 智能体 MVP API

## 一、健康检查

```http
GET /api/health
```

返回服务状态、版本和运行模式。

## 二、获取模拟病例

```http
GET /api/demo-cases
```

用于前端展示模拟病例，也可作为企业测试样例。

## 三、知识库统计

```http
GET /api/knowledge/stats
```

返回当前接入知识库条目数、摘要数、本地 PDF 路径数和来源文件。当前已接入 VTE 文献矩阵结构化条目，全文 PDF 尚未批量向量化。

## 四、单病例分析

```http
POST /api/analyze
Content-Type: application/json
```

### 方式 1：文本输入

```json
{
  "text": "模拟病例：72岁，腹盆腔肿瘤手术后卧床，D-二聚体升高，无活动性出血。"
}
```

### 方式 2：第三方系统结构化输入

```json
{
  "patientContext": {
    "patientToken": "demo-patient-001",
    "encounterToken": "demo-encounter-001",
    "department": "血管外科",
    "age": 72,
    "sex": "男",
    "diagnoses": ["腹盆腔肿瘤", "术后状态"],
    "procedures": ["腹盆腔肿瘤手术"],
    "labs": [
      {
        "name": "D-二聚体",
        "value": "升高",
        "unit": "",
        "time": "2026-06-14T08:00:00+08:00"
      }
    ],
    "nursingRecords": ["卧床3天", "当前无活动性出血"],
    "freeText": "需评估 VTE 风险、围术期预防策略、护理复评和出院教育。"
  }
}
```

### 返回核心字段

```json
{
  "riskLevel": "高危",
  "riskFactors": [],
  "bleedingFlags": [],
  "recommendations": [],
  "roleTasks": {
    "doctor": [],
    "nurse": [],
    "patient": [],
    "manager": [],
    "researcher": []
  },
  "reviewItems": [],
  "decisionSupport": {
    "scaleScores": [],
    "riskPrediction": {
      "peakWindow": "72小时",
      "peakProbability": 58,
      "trajectory": []
    },
    "workflowReminders": [],
    "qualityIndicators": [],
    "patientEducation": []
  },
  "evidence": [],
  "audit": {
    "auditId": "...",
    "events": []
  }
}
```

`decisionSupport` 为路径质控输出：

- `scaleScores`：Caprini、Padua、Wells DVT/PE 的演示性量表解释、分值、风险带和触发项。
- `riskPrediction`：VTE 风险预测轨迹，包含当前、24小时、72小时、7天、14天、30天、90天等基础窗口；妊娠病例可动态增加足月/分娩期、产后6周等时间点；高龄、肿瘤、截瘫/长期制动病例可增加长期随访窗口。字段同时返回峰值窗口、主要驱动因素、病例时间锚点和真实世界模型验证路径。
- `workflowReminders`：入院 24 小时内、术前/术后 24 小时、急症线索、抗凝安全、出院前教育等提醒节点。
- `qualityIndicators`：风险评估、出血评估、预防措施、动态复评、急症处理、出院教育等质控状态。
- `patientEducation`：按病例场景生成的患者宣教要点。

边界：当前量表、质控和风险曲线为 MVP 演示规则，正式部署需接入院内量表字段、时间戳、VTE 结局、质控口径和专家审核规则；真实概率模型需经训练、校准和验证后启用。

### 单病例 Markdown 报告导出

```http
POST /api/report/markdown
Content-Type: application/json
```

输入同 `/api/analyze`，返回当前病例的 Markdown 报告文本、建议文件名、审计编号和风险分层。

```json
{
  "text": "女，20岁，怀孕10周。BMI 29 kg/m2，入院后卧床 3 天，左下肢肿痛1天，肌张力明显升高，皮温降低。D-二聚体升高，当前无活动性出血。"
}
```

返回：

```json
{
  "fileName": "20260616-021029_VTE智能体单病例分析报告_高危.md",
  "mimeType": "text/markdown; charset=utf-8",
  "markdown": "# VTE 智能体单病例分析报告\n...",
  "auditId": "...",
  "riskLevel": "高危"
}
```

前端“智能体分析”页已提供“导出 Markdown”按钮。当前导出为本机浏览器下载文件；正式部署时应接入院内权限、审计日志和报告留痕。

## 五、电子病历深度审查

```http
POST /api/emr/review
Content-Type: application/json
```

输入同 `/api/analyze`，可使用脱敏病历文本或第三方系统结构化字段。

返回：

- 临床时间轴。
- VTE 风险与出血风险摘要。
- 入院评估、复评、预防措施、护理记录、出院随访等流程核查。
- 病历完善建议。
- 医疗质量与风险提示。
- 教学要点。

边界：该接口只提示 VTE 防控流程、病历完整性和医疗质量安全层面的需复核事项，不作法律责任或医疗事故判断。

## 六、批量分析

```http
POST /api/batch-analyze
Content-Type: application/json
```

```json
{
  "cases": [
    { "text": "病例 1 ..." },
    { "text": "病例 2 ..." }
  ]
}
```

MVP 限制 50 条。真实病历全量分析应在内网服务器通过任务队列、断点续跑和审计日志实现。

## 七、多模态病历导入预检

```http
POST /api/document/ingest-preview
Content-Type: application/json
```

```json
{
  "fileName": "脱敏病历.pdf",
  "documentType": "pdf",
  "mimeType": "application/pdf",
  "size": 123456,
  "extractedText": ""
}
```

当前接口用于演示 PDF、Word、图片和文本病历的导入流程预检。正式部署时应在院内服务器完成 PDF 解析、Word 解析、OCR、实体识别、时间轴抽取和人工复核，不应将真实病历上传到外部环境。

## 八、VTE 防控信息化分级

```http
GET /api/informatization/levels
```

返回按底线达标、基础信息化、数据集成、质控闭环、智能体增强、区域协同拆分的建设分级清单，便于对照不同层级的 VTE 防控信息化目标。

核心字段：

- `vetoItems`：住院患者电子化评估、预防记录、质控统计和审计留痕等底线要求。
- `levels`：L0-L5 分级建设目标、功能清单和 MVP 覆盖状态。
- `triggerScenarios`：入院、转科、术前、术后、病情变化、抗凝用药前、出院前等触发节点。
- `departmentScaleMap`：内科、外科/骨科、产科、综合病区、肺栓塞场景对应的推荐量表。
- `dataDictionaries`：抗凝药物、机械预防、基础护理、VTE 诊断与死亡线索字典。
- `qualityMetrics`：风险评估率、出血评估率、预防实施率、预警响应率和随访指标。
- `systemPrerequisites`：HIS/EMR/LIS/PACS/CDSS/CDR、统一字典、权限审计和脱敏导出要求。
- `agentUpgradeItems`：一键评估助手、证据详情与 RAG 问答、动态时间轨迹和医生站闭环。

## 九、院内队列筛选与驾驶舱

```http
POST /api/cohort/query
Content-Type: application/json
```

```json
{
  "department": "vascular",
  "diagnosis": "dvt",
  "range": "30d"
}
```

返回模拟队列、批量分析摘要和管理者驾驶舱数据。真实部署时可对接 HIS、EMR、LIS、PACS、护理系统或既有 VTE 管理系统，支持按时间段、科室、诊断、手术、风险状态筛选患者。

```http
GET /api/dashboard/summary
```

返回管理者驾驶舱摘要，包括纳入患者、VTE 高危、急症线索、出血/禁忌、科室分布和质量闭环指标。

## 十、RAG 问答

```http
POST /api/rag/query
Content-Type: application/json
```

```json
{
  "query": "高危患者存在出血风险时如何生成 VTE 防控建议？",
  "limit": 5
}
```

当前返回 VTE 文献矩阵结构化知识库检索结果。病例驱动问答会优先围绕妊娠、DVT/PE、股青肿、影像路径、抗凝安全和急症处理等关键主题生成聚焦问题。正式版本应进一步接入真实向量库、全文切片、证据等级和审核状态。

## 十一、接口规范

```http
GET /api/connector-schema
```

返回第三方 VTE 管理系统/EMR/护理系统接入字段草案。当前 schema 已补充：

- 推荐接入模式：`text_only`、`patient_context`、`hybrid_context`。
- 最低必要字段与推荐字段。
- 入院、术前、术后、病情变化、出院前等触发节点。
- 医生端、护士端、管理端、科研端的推荐回写字段。
- 接口错误处理、审计要求和分阶段接入建议。

推荐优先使用结构化 `patientContext` 接入，而不是只传一段自由文本。这样便于后续完成字段回写、质控口径对齐和审计留痕。

结构化对接示例：

```json
{
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
}
```

## 十二、模型调用层

```http
GET /api/model/status
```

返回当前模型提供方、模型名、是否启用、是否可调用、本地模型探测结果和数据边界。

```http
POST /api/model/complete
Content-Type: application/json
```

示例：

```json
{
  "prompt": "请基于以下脱敏模拟病例生成 VTE 防控建议草案。",
  "containsRealPatientData": false
}
```

默认 `MODEL_PROVIDER=auto`，自动探测本机常见模型服务，但不会主动调用外部网络模型。可选：

- `MODEL_PROVIDER=auto`
- `MODEL_PROVIDER=off`
- `MODEL_PROVIDER=openai_compatible`
- `MODEL_PROVIDER=ollama`

当前自动探测的本地适配器：

- Ollama: `http://localhost:11434`
- LM Studio: `http://localhost:1234/v1`
- vLLM: `http://localhost:8000/v1`
- Xinference: `http://localhost:9997/v1`
- LocalAI: `http://localhost:8080/v1`

常用环境变量：

```bash
MODEL_PROVIDER=off
MODEL_PROVIDER=auto
MODEL_PROVIDER=openai_compatible
MODEL_PROVIDER=ollama
MODEL_NAME=外部模型名或本地模型名
MODEL_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=...
```

真实患者数据默认禁止进入模型调用测试接口。院内服务器阶段应改用本地或私有化模型，并纳入医院安全审批、访问控制和日志审计。

## 十三、安全边界

- 外部演示不得输入真实患者身份信息。
- 真实病历只应在院内合规环境处理。
- 正式部署应增加鉴权、访问控制、日志审计、数据脱敏和输出分级。
- 智能体输出为辅助建议草案，关键决策必须由医生确认。
