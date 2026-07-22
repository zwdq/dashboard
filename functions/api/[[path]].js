// Dashboard API — 所有 token 从环境变量读取，前端不含任何密钥

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "*" },
  });
}

function checkAuth(request, env) {
  const token = (request.headers.get("Authorization") || "").replace("Bearer ", "");
  return token === (env.ACCESS_PASSWORD || "shaduanduan123");
}

// ── Cloudflare Pages 项目 + 状态 ──
async function getCFPages(env) {
  const token = env.CF_API_TOKEN;
  const account = env.CF_ACCOUNT_ID;
  if (!token || !account) return [];

  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects`, {
    headers: { "Authorization": `Bearer ${token}` },
  });
  const d = await r.json();
  if (!d.success) return [];

  return (d.result || []).map(p => {
    // subdomain 已经包含 .pages.dev，domains 里也可能有自定义域名
    const subdomain = p.subdomain ? `${p.subdomain}` : null;
    // 去掉可能的重复 .pages.dev
    const cleanSub = subdomain ? subdomain.replace(/\.pages\.dev\.pages\.dev$/, '.pages.dev') : null;
    return {
      name: p.name,
      subdomain: cleanSub,
      domains: p.domains || [],
      created: p.created_on,
      modified: p.modified_on,
      source: p.build_config?.root_dir || null,
      deployments: p.deployments?.length || 0,
    };
  });
}

// ── Cloudflare D1 + Workers 额度 ──
async function getCFUsage(env) {
  const token = env.CF_API_TOKEN;
  const account = env.CF_ACCOUNT_ID;
  if (!token || !account) return {};

  // D1 数据库列表
  let d1 = [];
  try {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database`, {
      headers: { "Authorization": `Bearer ${token}` },
    });
    const d = await r.json();
    d1 = (d.result || []).map(db => ({ name: db.name, uuid: db.uuid, created: db.created_at }));
  } catch {}

  // Workers
  let workers = [];
  try {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts`, {
      headers: { "Authorization": `Bearer ${token}` },
    });
    const d = await r.json();
    workers = (d.result || []).map(w => ({ id: w.id, modified: w.modified_on }));
  } catch {}

  return { d1, workers, d1Count: d1.length, workersCount: workers.length };
}

// ── 腾讯云轻量服务器 ──
async function getTencentLighthouse(env) {
  const sid = env.TENCENT_SECRET_ID;
  const skey = env.TENCENT_SECRET_KEY;
  if (!sid || !skey) return null;

  // 腾讯云 API 需要签名，这里用简化方式 — 通过前端直连不可行
  // 返回配置标记，前端会知道这是腾讯云
  return { configured: true, region: "ap-beijing" };
}

// ── 智谱 GLM 额度 ──
async function getGLMBalance(env) {
  const key = env.GLM_API_KEY;
  if (!key) return null;

  try {
    const r = await fetch("https://open.bigmodel.cn/api/paas/v4/models", {
      headers: { "Authorization": `Bearer ${key}` },
    });
    if (!r.ok) return { configured: true, status: "error", code: r.status };
    const d = await r.json();
    return { configured: true, status: "ok", models: (d.data || []).map(m => m.id).slice(0, 10), balance: null, balanceNote: "智谱暂不支持API查额度，请登录控制台查看" };
  } catch (e) {
    return { configured: true, status: "error", error: e.message };
  }
}

// ── Kimi 额度 ──
async function getKimiBalance(env) {
  const key = env.KIMI_API_KEY;
  if (!key) return null;

  try {
    // 查余额
    const [modelsRes, balanceRes] = await Promise.all([
      fetch("https://api.moonshot.cn/v1/models", { headers: { "Authorization": `Bearer ${key}` } }),
      fetch("https://api.moonshot.cn/v1/users/me/balance", { headers: { "Authorization": `Bearer ${key}` } }),
    ]);

    const modelsData = modelsRes.ok ? await modelsRes.json() : { data: [] };
    let balance = null;
    if (balanceRes.ok) {
      const bd = await balanceRes.json();
      balance = {
        available: bd.data?.available_balance ?? 0,
        cash: bd.data?.cash_balance ?? 0,
        voucher: bd.data?.voucher_balance ?? 0,
      };
    }

    return {
      configured: true,
      status: modelsRes.ok ? "ok" : "error",
      models: (modelsData.data || []).map(m => m.id),
      balance,
    };
  } catch (e) {
    return { configured: true, status: "error", error: e.message };
  }
}

// ── 健康检查 ──
async function checkHealth(url) {
  try {
    const start = Date.now();
    const r = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000) });
    const ms = Date.now() - start;
    return { url, status: r.status, ok: r.ok, ms };
  } catch (e) {
    return { url, status: 0, ok: false, ms: 0, error: e.message };
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace("/api", "") || "/";

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "*" } });
  }

  if (!checkAuth(request, env)) return json({ success: false, error: "未授权" }, 401);

  try {
    // GET /api/status — 全量状态
    if (path === "/status" && request.method === "GET") {
      const [pages, usage, tencent, glm, kimi] = await Promise.all([
        getCFPages(env),
        getCFUsage(env),
        getTencentLighthouse(env),
        getGLMBalance(env),
        getKimiBalance(env),
      ]);

      // 健康检查每个 Pages 项目
      const healthResults = [];
      for (const p of pages) {
        if (p.subdomain) {
          const h = await checkHealth(`https://${p.subdomain}`);
          healthResults.push({ name: p.name, ...h });
        }
      }

      return json({
        success: true,
        data: {
          pages,
          health: healthResults,
          cfUsage: usage,
          tencent,
          glm,
          kimi,
          timestamp: new Date().toISOString(),
        },
      });
    }

    return json({ success: false, error: "未找到路由: " + path }, 404);
  } catch (e) {
    return json({ success: false, error: e.message }, 500);
  }
}
