// Dashboard API — 所有 token 从环境变量读取，前端不含任何密钥

// ── 内存缓存 ──
let _cache = null;
let _cacheTime = 0;
const CACHE_TTL = 180000; // 3 分钟

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
    const subdomain = p.subdomain ? `${p.subdomain}` : null;
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

// ── 外部项目（非 CF Pages）──
function getExternalSites() {
  return [
    {
      name: "qdii-quota",
      subdomain: "https://zwdq.github.io/qdii-quota/fund-quota.html",
      domains: [],
      created: null,
      modified: null,
      source: null,
      deployments: 0,
    },
  ];
}

// ── Cloudflare D1 + Workers 实时用量 ──
async function getCFUsage(env) {
  const token = env.CF_API_TOKEN;
  const account = env.CF_ACCOUNT_ID;
  if (!token || !account) return {};

  // GraphQL Analytics — 当天用量（一次请求拿所有数据）
  const todayStr = new Date().toISOString().slice(0, 10);
  const fromISO = `${todayStr}T00:00:00Z`;

  let analytics = { workersRequests: 0, workersErrors: 0, d1RowsRead: 0, d1RowsWritten: 0, d1Count: 0, workersCount: 0 };

  try {
    const gqlResp = await fetch(`https://api.cloudflare.com/client/v4/graphql`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `{ viewer { accounts(filter: {accountTag: "${account}"}) {
          workersInvocationsAdaptive(limit: 50, filter: {datetime_gt: "${fromISO}"}) {
            sum { requests errors }
          }
          d1QueriesAdaptiveGroups(limit: 50, filter: {datetime_gt: "${fromISO}"}) {
            sum { rowsRead rowsWritten }
            dimensions { databaseId }
          }
        } } }`,
      }),
    });
    const gqlData = await gqlResp.json();
    const acc = gqlData?.data?.viewer?.accounts?.[0];

    if (acc) {
      const wData = acc.workersInvocationsAdaptive || [];
      analytics.workersRequests = wData.reduce((s, i) => s + (i.sum.requests || 0), 0);
      analytics.workersErrors = wData.reduce((s, i) => s + (i.sum.errors || 0), 0);

      const dData = acc.d1QueriesAdaptiveGroups || [];
      analytics.d1RowsRead = dData.reduce((s, i) => s + (i.sum.rowsRead || 0), 0);
      analytics.d1RowsWritten = dData.reduce((s, i) => s + (i.sum.rowsWritten || 0), 0);
      analytics.d1Count = new Set(dData.map(i => i.dimensions.databaseId)).size;
    }
  } catch {}

  // Workers count — 单独查（轻量）
  try {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts`, {
      headers: { "Authorization": `Bearer ${token}` },
    });
    const d = await r.json();
    analytics.workersCount = (d.result || []).length;
  } catch {}

  return analytics;
}

// ── 腾讯云轻量服务器 ──
async function getTencentLighthouse(env) {
  const sid = env.TENCENT_SECRET_ID;
  const skey = env.TENCENT_SECRET_KEY;
  if (!sid || !skey) return null;
  return {
    configured: true,
    provider: "tencent",
    name: "Ubuntu22.04-Docker26",
    instanceId: "lhins-odq5natg",
    region: "ap-beijing",
    regionName: "北京",
    ip: "152.136.152.43",
    privateIp: "10.2.20.9",
    cpu: 2,
    memory: 4,
    os: "Ubuntu 22.04 LTS",
    bandwidth: "6 Mbps",
    expireDate: "2028-06-12",
    created: "2024-06-12",
    disk: "70 GB SSD",
    diskSize: 70,
    cpuUsage: null,
    memUsage: null,
    snapshot: "2/2",
    firewall: "6 条规则",
    note: "需要调腾讯云 API 获取实时监控",
  };
}

// ── 阿里云 ECS ──
function getAliyunECS() {
  return {
    configured: true,
    provider: "aliyun",
    name: "zsqypc",
    instanceId: "i-2ze79b6r8gddzl3h7sy4",
    region: "cn-beijing",
    regionName: "华北2（北京）",
    ip: "123.57.225.162",
    privateIp: "172.22.15.248",
    cpu: 2,
    memory: 2,
    os: "Ubuntu 22.04 64位",
    bandwidth: "3 Mbps",
    expireDate: "2027-01-12",
    created: "2024-01-01",
    disk: "ESSD Entry 40GB",
    diskSize: 40,
    cpuUsage: null,
    memUsage: null,
    snapshot: null,
    firewall: null,
    note: "需要阿里云 AK/SK 获取实时监控",
  };
}

// ── 统一渲染服务器卡片数据 ──
function normalizeServer(s) {
  if (!s || !s.configured) return null;
  const expireDate = new Date(s.expireDate);
  const now = new Date();
  const daysLeft = Math.floor((expireDate - now) / (1000 * 60 * 60 * 24));
  const totalDays = Math.floor((expireDate - new Date(s.created)) / (1000 * 60 * 60 * 24));
  const expirePercent = Math.round((1 - daysLeft / totalDays) * 100);
  return { ...s, daysLeft, expirePercent };
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

// ── 皮皮虾 AI (Psydo) 额度 ──
// token 缓存：用 KV 存 access_token + refresh_token，避免每次登录
let _psydoTokenCache = null; // 内存缓存（同一次请求内复用）

async function getPsydoAccessToken(env) {
  // 1. 内存缓存检查（access_token 有效期 24h，提前 5 分钟刷新）
  if (_psydoTokenCache && _psydoTokenCache.accessExp - Date.now() / 1000 > 300) {
    return _psydoTokenCache.accessToken;
  }

  // 2. KV 缓存检查
  const kvKey = "psydo_token";
  let cached = null;
  try {
    const raw = await env.DASH_KV?.get(kvKey);
    if (raw) cached = JSON.parse(raw);
  } catch {}

  // access_token 还有效？
  if (cached && cached.accessExp - Date.now() / 1000 > 300) {
    _psydoTokenCache = cached;
    return cached.accessToken;
  }

  // 3. access_token 过期，尝试 refresh
  if (cached && cached.refreshToken) {
    try {
      const refreshRes = await fetch("https://api.psydo.top/api/v1/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: cached.refreshToken }),
      });
      if (refreshRes.ok) {
        const rd = await refreshRes.json();
        if (rd.code === 0 && rd.data?.access_token) {
          const newToken = {
            accessToken: rd.data.access_token,
            refreshToken: rd.data.refresh_token,
            accessExp: Math.floor(Date.now() / 1000) + (rd.data.expires_in || 86400),
          };
          _psydoTokenCache = newToken;
          try { await env.DASH_KV?.put(kvKey, JSON.stringify(newToken)); } catch {}
          return newToken.accessToken;
        }
      }
    } catch {}
  }

  // 4. refresh 也失效，回退到密码登录
  const loginRes = await fetch("https://api.psydo.top/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: env.PSYDO_EMAIL, password: env.PSYDO_PASSWORD }),
  });
  if (!loginRes.ok) return null;
  const loginData = await loginRes.json();
  const accessToken = loginData?.data?.access_token;
  if (!accessToken) return null;

  const newToken = {
    accessToken,
    refreshToken: loginData.data.refresh_token,
    accessExp: Math.floor(Date.now() / 1000) + (loginData.data.expires_in || 86400),
  };
  _psydoTokenCache = newToken;
  try { await env.DASH_KV?.put(kvKey, JSON.stringify(newToken)); } catch {}
  return accessToken;
}

async function getPsydoBalance(env) {
  const email = env.PSYDO_EMAIL;
  const password = env.PSYDO_PASSWORD;
  if (!email || !password) return null;

  try {
    // 1. 获取 access_token（缓存 → refresh → 登录）
    const accessToken = await getPsydoAccessToken(env);
    if (!accessToken) return { configured: true, status: "error", error: "auth failed" };

    // 2. 查订阅额度
    const subRes = await fetch("https://api.psydo.top/api/v1/subscriptions", {
      headers: { "Authorization": `Bearer ${accessToken}` },
    });
    const subData = await subRes.json();
    const sub = subData?.data?.[0];
    if (!sub) return { configured: true, status: "error", error: "no subscription" };

    // 3. 查最近 usage 日志，区分文本和画图
    let textUsage = 0;
    let imageUsage = 0;
    try {
      const usageRes = await fetch("https://api.psydo.top/api/v1/usage?page=1&page_size=100", {
        headers: { "Authorization": `Bearer ${accessToken}` },
      });
      const usageData = await usageRes.json();
      const items = usageData?.data?.items || [];
      for (const item of items) {
        if (item.image_count > 0 || item.billing_mode === "image") {
          imageUsage += item.actual_cost || 0;
        } else {
          textUsage += item.actual_cost || 0;
        }
      }
    } catch {}

    const limit = sub.monthly_limit_usd || 0;
    const used = sub.monthly_usage_usd || 0;
    return {
      configured: true,
      status: "ok",
      planName: sub.plan_name || "轻享月卡",
      monthlyLimit: limit,
      monthlyUsed: used,
      monthlyRemain: limit - used,
      dailyUsed: sub.daily_usage_usd || 0,
      weeklyUsed: sub.weekly_usage_usd || 0,
      textUsage: textUsage,
      imageUsage: imageUsage,
      expiresAt: sub.expires_at,
      overagePolicy: sub.overage_policy,
    };
  } catch (e) {
    return { configured: true, status: "error", error: e.message };
  }
}

// ── 天气 ──
const WEATHER_CODES = {
  0: "☀️ 晴", 1: "🌤️ 多云", 2: "⛅ 阴", 3: "☁️ 阴",
  45: "🌫️ 雾", 48: "🌫️ 冻雾",
  51: "🌦️ 小毛毛雨", 53: "🌦️ 毛毛雨", 55: "🌧️ 大毛毛雨",
  56: "🌧️ 冻毛毛雨", 57: "🌧️ 冻雨",
  61: "🌧️ 小雨", 63: "🌧️ 中雨", 65: "🌧️ 大雨",
  66: "🌧️ 冻雨", 67: "🌧️ 大冻雨",
  71: "🌨️ 小雪", 73: "🌨️ 中雪", 75: "❄️ 大雪",
  77: "🌨️ 雪粒",
  80: "🌧️ 阵雨", 81: "🌧️ 中阵雨", 82: "⛈️ 大阵雨",
  85: "🌨️ 阵雪", 86: "❄️ 大阵雪",
  95: "⛈️ 雷暴", 96: "⛈️ 雷暴+冰雹", 99: "⛈️ 大雷暴+冰雹",
};

async function getWeather() {
  try {
    const r = await fetch(
      "https://api.open-meteo.com/v1/forecast?latitude=39.9042&longitude=116.4074&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,precipitation&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,weather_code&timezone=Asia/Shanghai&forecast_days=7",
      { signal: AbortSignal.timeout(4000) }
    );
    const d = await r.json();
    const c = d.current || {};
    const daily = d.daily || {};
    const code = c.weather_code ?? 0;
    const dates = daily.time || [];
    const forecast = dates.map((date, i) => ({
      date,
      tempMax: daily.temperature_2m_max?.[i],
      tempMin: daily.temperature_2m_min?.[i],
      precipitation: daily.precipitation_sum?.[i],
      rainProb: daily.precipitation_probability_max?.[i],
      weatherCode: daily.weather_code?.[i],
      weatherText: WEATHER_CODES[daily.weather_code?.[i]] || "❓",
    }));
    return {
      temp: c.temperature_2m,
      humidity: c.relative_humidity_2m,
      windSpeed: c.wind_speed_10m,
      precipitation: c.precipitation,
      weatherCode: code,
      weatherText: WEATHER_CODES[code] || "❓ 未知",
      tempMax: (daily.temperature_2m_max || [null])[0],
      tempMin: (daily.temperature_2m_min || [null])[0],
      rainProbability: (daily.precipitation_probability_max || [null])[0],
      location: "北京西城区",
      forecast,
    };
  } catch (e) {
    return { error: "天气获取失败", location: "北京西城区" };
  }
}

// ── 健康检查 ──
async function checkHealth(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const start = Date.now();
    const r = await fetch(url, { method: "HEAD", signal: controller.signal });
    clearTimeout(timeout);
    const ms = Date.now() - start;
    return { url, status: r.status, ok: r.ok, ms };
  } catch (e) {
    return { url, status: 0, ok: false, ms: 0 };
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
    // GET /api/status — 全量状态（带缓存）
    if (path === "/status" && request.method === "GET") {
      // 用 Cache API 做边缘缓存
      const cacheUrl = new Request("https://dash-cache.local/status", request);
      const cache = caches.default;
      const cached = await cache.match(cacheUrl);
      if (cached) {
        const data = await cached.json();
        return json({ success: true, data, cached: true });
      }

      const [cfPages, usage, tencent, aliyun, kimi, psydo, weather] = await Promise.all([
        getCFPages(env),
        getCFUsage(env),
        getTencentLighthouse(env),
        getAliyunECS(),
        getKimiBalance(env),
        getPsydoBalance(env),
        getWeather(),
      ]);
      const pages = [...cfPages, ...getExternalSites()];

      // 健康检查每个 Pages 项目（并行）
      const healthUrls = pages.filter(p => p.subdomain).map(p => ({
        name: p.name,
        promise: checkHealth(p.subdomain.startsWith("http") ? p.subdomain : `https://${p.subdomain}`),
      }));
      const healthResults = await Promise.all(
        healthUrls.map(async h => ({ name: h.name, ...(await h.promise) }))
      );

      const result = {
        pages,
        health: healthResults,
        cfUsage: usage,
        tencent,
        aliyun,
        kimi,
        psydo,
        weather,
        timestamp: new Date().toISOString(),
      };

      // 更新 Cache API
      const cacheResp = new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=180" },
      });
      await cache.put(cacheUrl, cacheResp);

      return json({ success: true, data: result, cached: false });
    }

    return json({ success: false, error: "未找到路由: " + path }, 404);
  } catch (e) {
    return json({ success: false, error: e.message }, 500);
  }
}
