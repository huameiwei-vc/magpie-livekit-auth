# magpie-livekit-auth 实施计划

目标：把 **LiveKit Inference** 变成一个 magpie 供应商，让 Claude Code / Codex / OpenCode 等 agent
用一把 LiveKit API Key 就能选到 DeepSeek、GPT、Gemini、Kimi、Grok。

截至 2026-11-21 的调研结论（LiveKit 网关实测，非文档推测）：

- `https://agent-gateway.livekit.cloud/v1` 兼容 OpenAI Chat Completions
- **支持 tools**：流式 delta.tool_calls、`finish_reason: "tool_calls"`、`role:"tool"` 回传全部通过
- `openai/gpt-6-luna` **只认** `max_completion_tokens`，传 `max_tokens` 返回 400
- `reasoning_effort` 六个模型全接受（minimal/low/medium/high 均 200）
- `moonshotai/kimi-k2.6` 预算过小会把 token 全烧在思考上、正文为空 → 需兜底 8000
- `deepseek-ai/deepseek-v4-pro` 关掉思考会答错 → 默认档位不设 none
- `X-LiveKit-Inference-Provider` 可固定上游，但只对部分组合有效且无回退 → **不使用**
- 网关不校验 `max_completion_tokens` 上界 → 数字必须写死

## 文件

```
/Users/songchao/Desktop/PI/逆向/magpie-livekit-auth/
├── plan.md              本文件
├── package.json         包清单 + magpie 字段
├── index.mjs            唯一入口，零依赖
├── test/plugin.test.mjs bun test
├── README.md            装法 / 两个值从哪来 / 额度警告
├── LICENSE              MIT
└── .gitignore
```

## 任务

- [x] 0 骨架：目录、6 个文件建好，`bun test` 可跑
- [x] 1 签票：`signToken()` HS256，payload 与真实令牌一致
- [x] 2 真连：签出的票打 `/chat/completions` 断言 200
- [x] 3 模型表：6 条，key/id 分离，context/output 按查证值
- [x] 4 登录：两个 prompt（text + password），authorize 校验
- [x] 5 loader：每请求重签 + 覆盖 Authorization + 改 body
- [x] 6 错误映射：401 打标，402/429/403/404 透传
- [x] 7 实测消息体：确认 magpie 把 variant 编成什么字段
- [x] 8 README
- [x] 9 上 GitHub + v0.1.0
- [x] 11 自动发现：provider.models 先问 /v1/models，空则用本地表
- [x] 12 额度面板：auth.usage 探针读 Credits/RPM/TPM 头 + 回退/告警提醒
- [x] 13 回退检测：读取 X-Livekit-Inference-Llm-Model-Fallback 并告警
- [x] 14 移除 deepseek-v4-pro（实测回退到 Gemma 4 31B）
- [ ] 10 服务器验收（用户执行）

## 模型表（2026-11-21）

| key | API id | context | output |
|---|---|---|---|
| deepseek-v4.1-flash | deepseek-ai/deepseek-v4.1-flash | 1048576 | 384000 |
| gpt-6-luna | openai/gpt-6-luna | 1050000 | 128000 |
| gemini-3.8-flash | google/gemini-3.8-flash | 1048576 | 65536 |
| kimi-k2.6 | moonshotai/kimi-k2.6 | 262144 | 262144 |
| grok-4.7 | xai/grok-4.7 | 524288 | 131072 |

## 验收

```
magpie plugin add huameiwei-vc/magpie-livekit-auth#v0.1.0
magpie plugin login livekit
magpie provider test livekit
```
再在 agent 里选 `livekit/deepseek-v4.1-flash`，让它改一个文件。

## 风险

| 风险 | 应对 |
|---|---|
| $2.50 试用额度很快烧完 | README 大字说明，不推荐当主力 |
| 并发 5，agent 并行会 429 | maxConcurrency 5，透传 429 让 magpie 切号 |
| 模型每月下架 | 模型表标注日期，下架改一行 |
| 供应商固定头 2027-03 废弃 | 不使用 |
| Kimi 空回答 | 8000 兜底 |
