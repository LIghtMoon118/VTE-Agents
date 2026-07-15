# VTE 智能体模型适配层

建立日期：2026-06-14

## 一、设计原则

VTE 智能体不绑定单一大模型。模型层采用可插拔适配器模式：有本地模型时优先本地调用；无本地模型时可配置外部 OpenAI-compatible 接口；无网络、无账号或未授权时，规则库、RAG 检索、病历流程审查仍可独立运行。

## 二、默认行为

- `MODEL_PROVIDER=auto`：默认模式，自动探测本机模型服务。
- 不自动调用外部网络模型。
- 模型调用测试需要用户主动触发，或由第三方系统显式调用 `/api/model/complete`。
- `containsRealPatientData=true` 时默认拦截，避免真实病历进入未授权模型。

## 三、当前支持的本地探测

| 适配器 | 默认地址 | 接口类型 |
| --- | --- | --- |
| Ollama | `http://localhost:11434` | Ollama `/api/chat` |
| LM Studio | `http://localhost:1234/v1` | OpenAI-compatible |
| vLLM | `http://localhost:8000/v1` | OpenAI-compatible |
| Xinference | `http://localhost:9997/v1` | OpenAI-compatible |
| LocalAI | `http://localhost:8080/v1` | OpenAI-compatible |

## 四、外部模型配置

外部模型统一按 OpenAI-compatible 接口接入：

```bash
MODEL_PROVIDER=openai_compatible
MODEL_BASE_URL=https://api.openai.com/v1
MODEL_NAME=填写模型名
OPENAI_API_KEY=填写密钥
npm start
```

院内或企业私有化模型如果提供 OpenAI-compatible 接口，也可以使用同样方式：

```bash
MODEL_PROVIDER=openai_compatible
MODEL_BASE_URL=http://内网模型服务地址/v1
MODEL_NAME=内网模型名
MODEL_REQUIRES_API_KEY=false
npm start
```

## 五、推荐部署策略

企业演示阶段：使用模拟病例、脱敏病例和公开文献，可选择外部模型增强生成表达。

医院内网阶段：优先对接院内本地模型、私有化模型或医院授权模型；真实病历不出内网。

商业化阶段：将模型层作为标准适配器，允许医院按本院政策选择模型供应商，VTE 智能体保持知识库、流程审查、接口规范和审计能力稳定。
