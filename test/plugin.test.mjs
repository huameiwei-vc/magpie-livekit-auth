import { describe, expect, test } from "bun:test";
import plugin, { _internal } from "../index.mjs";

const { signToken, normalizeBody, b64url, MODELS } = _internal;

function decode(part) {
  const padded = part.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

describe("signToken", () => {
  test("header 是 HS256", async () => {
    const token = await signToken("APIabc12345", "s".repeat(40));
    const [h] = token.split(".");
    expect(decode(h)).toEqual({ alg: "HS256", typ: "JWT" });
  });

  test("payload 带 inference.perform，且 iss 是 api key", async () => {
    const token = await signToken("APIabc12345", "s".repeat(40));
    const [, p] = token.split(".");
    const payload = decode(p);
    expect(payload.inference).toEqual({ perform: true });
    expect(payload.sub).toBe("agent");
    expect(payload.iss).toBe("APIabc12345");
  });

  test("有效期默认 10 分钟", async () => {
    const now = 1_800_000_000_000;
    const token = await signToken("k".repeat(10), "s".repeat(40), 600, now);
    const payload = decode(token.split(".")[1]);
    expect(payload.exp - payload.nbf).toBe(605); // 含 5 秒时钟容忍
  });

  test("签名是 32 字节（HMAC-SHA256）", async () => {
    const token = await signToken("k".repeat(10), "s".repeat(40));
    const sig = token.split(".")[2];
    expect(Buffer.from(sig, "base64url").length).toBe(32);
  });

  test("同输入同时间，签名可复现", async () => {
    const now = 1_800_000_000_000;
    const a = await signToken("k".repeat(10), "s".repeat(40), 600, now);
    const b = await signToken("k".repeat(10), "s".repeat(40), 600, now);
    expect(a).toBe(b);
  });
});

describe("normalizeBody", () => {
  test("max_tokens 改成 max_completion_tokens", () => {
    const out = JSON.parse(normalizeBody(JSON.stringify({ model: "openai/gpt-6-luna", max_tokens: 100 })));
    expect(out.max_tokens).toBeUndefined();
    expect(out.max_completion_tokens).toBe(100);
  });

  test("两个都给时，保留 max_completion_tokens", () => {
    const out = JSON.parse(
      normalizeBody(JSON.stringify({ model: "x", max_tokens: 100, max_completion_tokens: 200 })),
    );
    expect(out.max_completion_tokens).toBe(200);
  });

  test("kimi 预算太小时抬到 8000", () => {
    const out = JSON.parse(normalizeBody(JSON.stringify({ model: "moonshotai/kimi-k2.6", max_completion_tokens: 400 })));
    expect(out.max_completion_tokens).toBe(8000);
  });

  test("kimi 没给预算时补 8000", () => {
    const out = JSON.parse(normalizeBody(JSON.stringify({ model: "moonshotai/kimi-k2.6" })));
    expect(out.max_completion_tokens).toBe(8000);
  });

  test("kimi 预算够大时不动", () => {
    const out = JSON.parse(normalizeBody(JSON.stringify({ model: "moonshotai/kimi-k2.6", max_completion_tokens: 16000 })));
    expect(out.max_completion_tokens).toBe(16000);
  });

  test("别的模型不被加预算", () => {
    const out = JSON.parse(normalizeBody(JSON.stringify({ model: "deepseek-ai/deepseek-v4.1-flash" })));
    expect(out.max_completion_tokens).toBeUndefined();
  });

  test("非 JSON 原样返回", () => {
    expect(normalizeBody("not json")).toBe("not json");
  });

  test("undefined / 流式 body 不炸", () => {
    expect(normalizeBody(undefined)).toBeUndefined();
    const stream = {};
    expect(normalizeBody(stream)).toBe(stream);
  });
});

describe("模型表", () => {
  test("六条，且 key 与 API id 分离", () => {
    expect(Object.keys(MODELS)).toHaveLength(6);
    expect(MODELS["deepseek-v4.1-flash"].id).toBe("deepseek-ai/deepseek-v4.1-flash");
    expect(MODELS["kimi-k2.6"].id).toBe("moonshotai/kimi-k2.6");
  });

  test("每条都有上下文、输出上限和工具调用", () => {
    for (const [key, m] of Object.entries(MODELS)) {
      expect(m.limit.context).toBeGreaterThan(0);
      expect(m.limit.output).toBeGreaterThan(0);
      expect(m.tool_call).toBe(true);
      expect(m.reasoning).toBe(true);
      expect(typeof m.name).toBe("string");
      expect(m.name.length).toBeLessThanOrEqual(80);
      if (!key) throw new Error("unreachable");
    }
  });

  test("deepseek-v4-pro 不提供关思考的档位", () => {
    expect(Object.keys(MODELS["deepseek-v4-pro"].variants)).not.toContain("minimal");
  });
});

describe("插件钩子", () => {
  test("导出 default { id, server }", async () => {
    expect(plugin.id).toBe("livekit");
    const hooks = await plugin.server();
    expect(typeof hooks.config).toBe("function");
    expect(hooks.auth.provider).toBe("livekit");
  });

  test("config 声明供应商和模型", async () => {
    const hooks = await plugin.server();
    const cfg = {};
    await hooks.config(cfg);
    expect(cfg.provider.livekit.name).toBe("LiveKit");
    expect(cfg.provider.livekit.api).toContain("agent-gateway.livekit.cloud");
    expect(Object.keys(cfg.provider.livekit.models)).toHaveLength(6);
  });

  test("config 不覆盖用户已配置的供应商", async () => {
    const hooks = await plugin.server();
    const cfg = { provider: { livekit: { name: "Mine" } } };
    await hooks.config(cfg);
    expect(cfg.provider.livekit.name).toBe("Mine");
  });

  test("authorize 拒绝不完整输入", async () => {
    const hooks = await plugin.server();
    const method = hooks.auth.methods[0];
    expect((await method.authorize({ apiKey: "", secret: "" })).type).toBe("failed");
    expect((await method.authorize({ apiKey: "API12345678", secret: "short" })).type).toBe("failed");
  });

  test("authorize 通过并保存 secret 到 metadata", async () => {
    const hooks = await plugin.server();
    const method = hooks.auth.methods[0];
    const res = await method.authorize({ apiKey: "API12345678", secret: "s".repeat(40) });
    expect(res.type).toBe("success");
    expect(res.key).toBe("API12345678");
    expect(res.metadata.secret).toBe("s".repeat(40));
  });

  test("loader 覆盖 Authorization 且改写 body", async () => {
    const hooks = await plugin.server();
    const loader = await hooks.auth.loader(async () => ({
      type: "api",
      key: "API12345678",
      metadata: { secret: "s".repeat(40) },
    }));
    expect(loader.baseURL).toContain("agent-gateway");

    let seen = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      seen = { input, headers: new Headers(init.headers), body: init.body };
      return new Response("{}", { status: 200 });
    };
    try {
      await loader.fetch("https://agent-gateway.livekit.cloud/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer stale-token", "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-6-luna", max_tokens: 50 }),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(seen.headers.get("authorization")).toMatch(/^Bearer eyJ/);
    expect(seen.headers.get("authorization")).not.toContain("stale-token");
    const body = JSON.parse(seen.body);
    expect(body.max_tokens).toBeUndefined();
    expect(body.max_completion_tokens).toBe(50);
  });

  test("loader 没有 secret 时抛出 signIn expired", async () => {
    const hooks = await plugin.server();
    await expect(
      hooks.auth.loader(async () => ({ type: "api", key: "API12345678" })),
    ).rejects.toMatchObject({ signIn: "expired" });
  });

  test("b64url 不含 + / =", () => {
    expect(b64url("\u00ff\u00fe" + "abc")).not.toMatch(/[+/=]/);
  });
});

describe("modelOf", () => {
  test("取出请求体里的模型名", () => {
    expect(_internal.modelOf('{"model":"openai/gpt-6-luna","stream":true}')).toBe("openai/gpt-6-luna");
  });

  test("没有 model 时返回 null", () => {
    expect(_internal.modelOf('{"messages":[]}')).toBeNull();
    expect(_internal.modelOf(undefined)).toBeNull();
  });
});

describe("mergeListedModels", () => {
  const { mergeListedModels, MODELS } = _internal;

  test("目录为空时保持原表（今天的真实情况）", () => {
    expect(mergeListedModels(MODELS, [])).toBe(MODELS);
    expect(mergeListedModels(MODELS, null)).toBe(MODELS);
  });

  test("目录里有的保留，已下架的丢掉", () => {
    const out = mergeListedModels(MODELS, ["deepseek-ai/deepseek-v4.1-flash"]);
    expect(Object.keys(out)).toEqual(["deepseek-v4.1-flash"]);
  });

  test("目录里的新模型被补进来，带保守上限", () => {
    const out = mergeListedModels(MODELS, ["deepseek-ai/deepseek-v4.1-flash", "acme/next-model"]);
    expect(out["next-model"]).toBeDefined();
    expect(out["next-model"].id).toBe("acme/next-model");
    expect(out["next-model"].limit.context).toBe(128000);
  });

  test("目录和已知表完全不交集时，仍保留原表", () => {
    const out = mergeListedModels(MODELS, ["nothing/at-all"]);
    expect(out["at-all"]).toBeDefined();
    expect(Object.keys(out).length).toBe(1);
  });
});

describe("provider.models", () => {
  test("上游目录为空时用本地表", async () => {
    const hooks = await plugin.server();
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response("{}", { status: 200 });
    try {
      const out = await hooks.provider.models(
        { models: _internal.MODELS },
        { auth: { type: "api", key: "API12345678", metadata: { secret: "s".repeat(40) } } },
      );
      expect(Object.keys(out)).toHaveLength(6);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("未登录时直接返回本地表，不发请求", async () => {
    const hooks = await plugin.server();
    const out = await hooks.provider.models({ models: _internal.MODELS }, {});
    expect(Object.keys(out)).toHaveLength(6);
  });
});

describe("auth.usage", () => {
  test("读响应头里的额度与限速", async () => {
    const hooks = await plugin.server();
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response("{}", {
        status: 200,
        headers: {
          "x-livekit-inference-credits-limit": "2.5",
          "x-livekit-inference-credits-used": "0.75",
          "x-livekit-inference-rpm-limit": "100",
          "x-livekit-inference-tpm-limit": "600000",
        },
      });
    try {
      const out = await hooks.auth.usage(async () => ({
        type: "api",
        key: "API12345678",
        metadata: { secret: "s".repeat(40) },
      }));
      const credit = out.windows.find((w) => w.name === "推理额度");
      expect(credit.used).toBe(30);
      expect(credit.display).toBe("0.75 / 2.5");
      expect(out.windows.find((w) => w.name === "限速").display).toContain("100 次/分");
    } finally {
      globalThis.fetch = original;
    }
  });

  test("没有额度头时，明说不公开余额", async () => {
    const hooks = await plugin.server();
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response("{}", { status: 200 });
    try {
      const out = await hooks.auth.usage(async () => ({
        type: "api",
        key: "API12345678",
        metadata: { secret: "s".repeat(40) },
      }));
      expect(out.windows[0].display).toContain("不公开余额");
    } finally {
      globalThis.fetch = original;
    }
  });

  test("401 时提示重新登录", async () => {
    const hooks = await plugin.server();
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response("{}", { status: 401 });
    try {
      const out = await hooks.auth.usage(async () => ({
        type: "api",
        key: "API12345678",
        metadata: { secret: "s".repeat(40) },
      }));
      expect(out.error).toContain("登录失效");
      expect(out.windows).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("模型回退告警", () => {
  test("响应头说回退了，额度面板里能看到", async () => {
    const hooks = await plugin.server();
    const account = { type: "api", key: "API12345678", metadata: { secret: "s".repeat(40) } };
    const loader = await hooks.auth.loader(async () => account);

    const original = globalThis.fetch;
    // 第一次：正常请求，但上游回退到了 Gemma
    globalThis.fetch = async () =>
      new Response("{}", {
        status: 200,
        headers: { "x-livekit-inference-llm-model-fallback": "google/gemma-4-31b-it" },
      });
    try {
      await loader.fetch("https://agent-gateway.livekit.cloud/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "deepseek-ai/deepseek-v4-pro" }),
      });
    } finally {
      globalThis.fetch = original;
    }

    // 第二次：额度探针
    globalThis.fetch = async () => new Response("{}", { status: 200 });
    try {
      const out = await hooks.auth.usage(async () => account);
      const notice = out.windows.find((w) => w.name === "回退提醒");
      expect(notice).toBeDefined();
      expect(notice.display).toContain("deepseek-ai/deepseek-v4-pro");
      expect(notice.display).toContain("gemma-4-31b-it");
      expect(notice.aside).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("429 的额度告警也会留在面板里", async () => {
    const hooks = await plugin.server();
    const account = { type: "api", key: "{{SECRET_nzdzmgob}}", metadata: { secret: "s".repeat(40) } };
    const loader = await hooks.auth.loader(async () => account);

    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response("{}", {
        status: 429,
        headers: { "x-livekit-inference-quota-message": "inference credits exhausted" },
      });
    try {
      await loader.fetch("https://agent-gateway.livekit.cloud/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "deepseek-ai/deepseek-v4.1-flash" }),
      });
    } finally {
      globalThis.fetch = original;
    }

    globalThis.fetch = async () => new Response("{}", { status: 200 });
    try {
      const out = await hooks.auth.usage(async () => account);
      const warning = out.windows.find((w) => w.name === "上次告警");
      expect(warning).toBeDefined();
      expect(warning.display).toContain("credits exhausted");
    } finally {
      globalThis.fetch = original;
    }
  });
});
