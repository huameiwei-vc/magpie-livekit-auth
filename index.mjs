/**
 * magpie / OpenCode 供应商插件：LiveKit Inference
 *
 * 用一把 LiveKit API Key + Secret，在 magpie 里换来一组模型：
 * DeepSeek V4.1 Flash / V4 Pro、GPT-6 Luna、Gemini 3.8 Flash、Kimi K2.6、Grok 4.7。
 *
 * 原理：LiveKit 的 key/secret 不能直接当 Bearer 令牌用，每个请求要现签一张
 * 10 分钟的 JWT（HS256，payload 里只有 inference.perform 这一个权限）。
 * 这里不发 npm 依赖，签名用 WebCrypto。
 *
 * 实测结论（2026-11-21，直接打 agent-gateway 验证）：
 *   - 支持 tools：流式 tool_calls / finish_reason / role:"tool" 回传都正常
 *   - openai/* 只认 max_completion_tokens，传 max_tokens 会 400
 *   - kimi 预算太小会把 token 全烧在思考上、正文为空 → 抬到 8000
 */

const PROVIDER = "livekit";
const BASE_URL = "https://agent-gateway.livekit.cloud/v1";
const TOKEN_TTL_SEC = 600; // 10 分钟，够一次请求链
const KIMI_MIN_BUDGET = 8000;

/** 模型表：key 是 magpie 里显示的名字，id 是真正发给网关的名字 */
const MODELS = {
  "deepseek-v4.1-flash": {
    name: "DeepSeek V4.1 Flash",
    id: "deepseek-ai/deepseek-v4.1-flash",
    limit: { context: 1048576, input: 1048576, output: 384000 },
    variants: { low: {}, medium: {}, high: {} },
  },
  "deepseek-v4-pro": {
    name: "DeepSeek V4 Pro",
    id: "deepseek-ai/deepseek-v4-pro",
    limit: { context: 1048576, input: 1048576, output: 393216 },
    // 关掉思考会答错，所以不提供 none/minimal
    variants: { low: {}, high: {}, max: {} },
  },
  "gpt-6-luna": {
    name: "GPT-6 Luna",
    id: "openai/gpt-6-luna",
    limit: { context: 1050000, input: 1050000, output: 128000 },
    variants: { minimal: {}, low: {}, medium: {}, high: {} },
  },
  "gemini-3.8-flash": {
    name: "Gemini 3.8 Flash",
    id: "google/gemini-3.8-flash",
    limit: { context: 1048576, input: 1048576, output: 65536 },
    variants: { low: {}, medium: {}, high: {} },
  },
  "kimi-k2.6": {
    name: "Kimi K2.6",
    id: "moonshotai/kimi-k2.6",
    limit: { context: 262144, input: 262144, output: 262144 },
    variants: { low: {}, medium: {}, high: {} },
  },
  "grok-4.7": {
    name: "Grok 4.7",
    id: "xai/grok-4.7",
    limit: { context: 524288, input: 524288, output: 131072 },
    variants: { low: {}, medium: {}, high: {} },
  },
};

for (const model of Object.values(MODELS)) {
  model.reasoning = true;
  model.tool_call = true;
  model.modalities = { input: ["text"], output: ["text"] };
}

const encoder = new TextEncoder();

/** base64url（JWT 用），Bun 和 Node 都有 Buffer */
function b64url(data) {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 签一张 Inference 令牌。
 * 形状与 LiveKit SDK 的 AccessToken.withInferenceGrants() 完全一致：
 *   header  { alg: "HS256", typ: "JWT" }
 *   payload { inference: { perform: true }, sub: "agent", iss: apiKey, nbf, exp }
 */
async function signToken(apiKey, secret, ttlSec = TOKEN_TTL_SEC, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    inference: { perform: true },
    sub: "agent",
    iss: apiKey,
    nbf: iat - 5, // 容忍几秒时钟偏差
    exp: iat + ttlSec,
  };

  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(signature))}`;
}

/** 只在 LIVEKIT_DEBUG_BODY=1 时打开；只记字段名和档位，不记对话内容 */
function debugBody(url, raw) {
  if (process.env.LIVEKIT_DEBUG_BODY !== "1") return;
  let info = { url: String(url).replace(/^https:\/\/[^/]+/, ""), body: typeof raw };
  try {
    const b = JSON.parse(raw);
    info = {
      path: String(url).replace(/^https:\/\/[^/]+/, ""),
      model: b.model,
      stream: b.stream === true,
      keys: Object.keys(b).sort(),
      reasoning_effort: b.reasoning_effort ?? null,
      reasoning: b.reasoning ?? null,
      thinking: b.thinking ?? null,
      output_effort: b.output_config?.effort ?? null,
      max_completion_tokens: b.max_completion_tokens ?? null,
      tools: Array.isArray(b.tools) ? b.tools.length : 0,
    };
  } catch {
    /* 不是 JSON 就只记路径 */
  }
  console.log(`[livekit] request ${JSON.stringify(info)}`);
}

/**
 * 改写请求体。三件事，每一件都是实测逼出来的：
 *   1. max_tokens → max_completion_tokens（openai/* 不认前者，会 400）
 *   2. kimi 的预算兜底（太小会烧光思考、正文为空）
 *   3. 不是 JSON 就原样放行
 */
function normalizeBody(raw) {
  if (typeof raw !== "string") return raw;

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return raw;
  }

  if (body.max_tokens != null) {
    if (body.max_completion_tokens == null) body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
  }

  if (typeof body.model === "string" && body.model.includes("kimi")) {
    if (!(body.max_completion_tokens >= KIMI_MIN_BUDGET)) {
      body.max_completion_tokens = KIMI_MIN_BUDGET;
    }
  }

  return JSON.stringify(body);
}

/** magpie 的供应商声明：没人登录时也要有模型可选 */
async function config(cfg) {
  cfg.provider ??= {};
  cfg.provider[PROVIDER] ??= {
    name: "LiveKit",
    npm: "@ai-sdk/openai-compatible", // → Chat Completions
    api: BASE_URL,
    models: MODELS,
  };
}

const auth = {
  provider: PROVIDER,
  methods: [
    {
      type: "api",
      label: "LiveKit API key",
      prompts: [
        {
          type: "text",
          key: "apiKey",
          message: "API Key（LiveKit 控制台 → Settings → Keys）",
          placeholder: "API...",
          validate: (v) =>
            (v ?? "").trim().length >= 8 ? undefined : "Key 太短了，检查有没有复制全",
        },
        {
          type: "password",
          key: "secret",
          message: "API Secret（只在创建时显示一次）",
          validate: (v) =>
            (v ?? "").trim().length >= 32 ? undefined : "Secret 看起来不完整（通常 40 位以上）",
        },
      ],
      // 登录时不发请求验真——那会花额度。真验留给 `magpie provider test`
      async authorize(inputs) {
        const apiKey = (inputs?.apiKey ?? "").trim();
        const secret = (inputs?.secret ?? "").trim();
        if (apiKey.length < 8 || secret.length < 32) {
          return { type: "failed", error: "Key 或 Secret 不完整" };
        }
        return { type: "success", key: apiKey, metadata: { secret } };
      },
    },
  ],

  /**
   * 每个账号跑一次。token 缓存放在这个闭包里，
   * 所以多账号之间不会串（文档要求状态按 auth 存，不要放模块级）。
   */
  async loader(getAuth) {
    const account = await getAuth();
    if (account?.type !== "api") return {};

    const apiKey = account.key;
    const secret = account.metadata?.secret;
    if (!secret) {
      throw Object.assign(new Error("LiveKit API Secret 丢失，请重新登录"), {
        signIn: "expired",
      });
    }

    let cachedToken = null;
    let cachedUntil = 0;

    async function getToken() {
      const now = Date.now();
      if (cachedToken && now < cachedUntil) return cachedToken;
      cachedToken = await signToken(apiKey, secret, TOKEN_TTL_SEC, now);
      cachedUntil = now + (TOKEN_TTL_SEC - 60) * 1000; // 提前一分钟换票
      return cachedToken;
    }

    return {
      baseURL: BASE_URL,
      async fetch(input, init = {}) {
        const headers = new Headers(init.headers);
        // 必须覆盖：loader 返回的 apiKey 是写死的，票会过期
        headers.set("authorization", `Bearer ${await getToken()}`);
        if (!headers.has("content-type")) headers.set("content-type", "application/json");

        const body = normalizeBody(init.body);
        debugBody(input, body);

        return fetch(input, { ...init, headers, body });
      },
    };
  },
};

const server = async () => ({ config, auth });

// 只导出 default 对象（OpenCode v1 形式）。
// 注意：不要再导出别的函数，否则 magpie 会把每个导出函数都当成一个插件去加载。
export default { id: "livekit", server };

/** 单元测试用的口子（magpie 只把导出的函数当插件，对象不受影响） */
export const _internal = { signToken, normalizeBody, b64url, MODELS, PROVIDER, BASE_URL };
