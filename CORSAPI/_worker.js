// =====================================================
// LunaTV API 代理服务 - Cloudflare Workers/Pages 版本
// 支持直接上传本地配置文件部署
// =====================================================

export default {
  async fetch(request, env, ctx) {
    // Pages Functions 中 KV 需要从 env 中获取
    if (env && env.KV && typeof globalThis.KV === 'undefined') {
      globalThis.KV = env.KV
    }

    return handleRequest(request, env)
  }
}

// 常量配置
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
}

const EXCLUDE_HEADERS = new Set([
  'content-encoding', 'content-length', 'transfer-encoding',
  'connection', 'keep-alive', 'set-cookie', 'set-cookie2'
])

// =====================================================
// 配置源地址设置
// =====================================================
// 
// 【重要说明】
// - 主配置源：GitHub（原项目每日自动检测API可用性并更新）
// - 备用配置源：本地文件（你自定义的源，当GitHub不可用时使用）
// 
// 如果你想使用自己的GitHub仓库，修改下面的 YOUR_GITHUB_USERNAME 和 YOUR_REPO_NAME
// =====================================================

// 主配置源：你的 GitHub 仓库（自动检测更新）
const JSON_SOURCES = {
  'jin18': 'https://raw.githubusercontent.com/xixianloux/LunaTV-config/refs/heads/main/jin18.json',
  'jingjian': 'https://raw.githubusercontent.com/xixianloux/LunaTV-config/refs/heads/main/jingjian.json',
  'full': 'https://raw.githubusercontent.com/xixianloux/LunaTV-config/refs/heads/main/LunaTV-config.json'
}

// 备用配置源：本地文件（你自定义的源）
const FALLBACK_SOURCES = {
  'jin18': '/jin18.json',
  'jingjian': '/jingjian.json',
  'full': '/LunaTV-config.json'
}

const FORMAT_CONFIG = {
  '0': { proxy: false, base58: false },
  'raw': { proxy: false, base58: false },
  '1': { proxy: true, base58: false },
  'proxy': { proxy: true, base58: false },
  '2': { proxy: false, base58: true },
  'base58': { proxy: false, base58: true },
  '3': { proxy: true, base58: true },
  'proxy-base58': { proxy: true, base58: true }
}

// Base58 编码函数
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function base58Encode(obj) {
  const str = JSON.stringify(obj)
  const bytes = new TextEncoder().encode(str)

  let intVal = 0n
  for (let b of bytes) {
    intVal = (intVal << 8n) + BigInt(b)
  }

  let result = ''
  while (intVal > 0n) {
    const mod = intVal % 58n
    result = BASE58_ALPHABET[Number(mod)] + result
    intVal = intVal / 58n
  }

  for (let b of bytes) {
    if (b === 0) result = BASE58_ALPHABET[0] + result
    else break
  }

  return result
}

// JSON api 字段前缀替换
function addOrReplacePrefix(obj, newPrefix) {
  if (typeof obj !== 'object' || obj === null) return obj
  if (Array.isArray(obj)) return obj.map(item => addOrReplacePrefix(item, newPrefix))
  const newObj = {}
  for (const key in obj) {
    if (key === 'api' && typeof obj[key] === 'string') {
      let apiUrl = obj[key]
      const urlIndex = apiUrl.indexOf('?url=')
      if (urlIndex !== -1) apiUrl = apiUrl.slice(urlIndex + 5)
      if (!apiUrl.startsWith(newPrefix)) apiUrl = newPrefix + apiUrl
      newObj[key] = apiUrl
    } else {
      newObj[key] = addOrReplacePrefix(obj[key], newPrefix)
    }
  }
  return newObj
}

// 获取 JSON 配置 (支持本地文件和远程 URL)
async function getJSON(sourceUrl, request) {
  try {
    // 检查是否是相对路径（本地文件）
    if (sourceUrl.startsWith('/')) {
      const reqUrl = new URL(request.url)
      const localUrl = reqUrl.origin + sourceUrl
      const res = await fetch(localUrl)
      if (res.ok) {
        return await res.json()
      }
    }

    // 远程 URL
    const res = await fetch(sourceUrl)
    if (res.ok) {
      return await res.json()
    }
  } catch (e) {
    console.error('Fetch error:', e)
  }
  return null
}

// 获取配置（带降级处理）
async function getCachedJSON(sourceKey, request) {
  const primaryUrl = JSON_SOURCES[sourceKey] || JSON_SOURCES['full']
  const fallbackUrl = FALLBACK_SOURCES[sourceKey] || FALLBACK_SOURCES['full']

  // 先尝试主配置源
  let data = await getJSON(primaryUrl, request)

  // 如果失败，尝试备用源
  if (!data) {
    console.log('Primary source failed, trying fallback...')
    data = await getJSON(fallbackUrl, request)
  }

  if (!data) {
    throw new Error('Failed to fetch configuration from all sources')
  }

  return data
}

// 主逻辑
async function handleRequest(request, env) {
  // 快速处理 OPTIONS 请求
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  const reqUrl = new URL(request.url)
  const pathname = reqUrl.pathname
  const targetUrlParam = reqUrl.searchParams.get('url')
  const formatParam = reqUrl.searchParams.get('format')
  const prefixParam = reqUrl.searchParams.get('prefix')
  const sourceParam = reqUrl.searchParams.get('source')

  const currentOrigin = reqUrl.origin
  const defaultPrefix = currentOrigin + '/?url='

  // 健康检查
  if (pathname === '/health') {
    return new Response('OK', { status: 200, headers: CORS_HEADERS })
  }

  // 静态文件处理 (Pages 会自动处理)
  if (pathname.endsWith('.json')) {
    // 由 Pages 处理静态文件
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 })
  }

  // 通用代理请求处理
  if (targetUrlParam) {
    return handleProxyRequest(request, targetUrlParam, currentOrigin)
  }

  // JSON 格式输出处理
  if (formatParam !== null) {
    return handleFormatRequest(formatParam, sourceParam, prefixParam, defaultPrefix, request)
  }

  // 返回首页文档
  return handleHomePage(currentOrigin, defaultPrefix)
}

// 代理请求处理
async function handleProxyRequest(request, targetUrlParam, currentOrigin) {
  // 防止递归调用
  if (targetUrlParam.startsWith(currentOrigin)) {
    return errorResponse('Loop detected: self-fetch blocked', { url: targetUrlParam }, 400)
  }

  // 验证 URL
  if (!/^https?:\/\//i.test(targetUrlParam)) {
    return errorResponse('Invalid target URL', { url: targetUrlParam }, 400)
  }

  let fullTargetUrl = targetUrlParam
  const urlMatch = request.url.match(/[?&]url=([^&]+(?:&.*)?)/)
  if (urlMatch) fullTargetUrl = decodeURIComponent(urlMatch[1])

  let targetURL
  try {
    targetURL = new URL(fullTargetUrl)
  } catch {
    return errorResponse('Invalid URL', { url: fullTargetUrl }, 400)
  }

  try {
    const proxyRequest = new Request(targetURL.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.method !== 'GET' && request.method !== 'HEAD'
        ? await request.arrayBuffer()
        : undefined,
    })

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 9000)
    const response = await fetch(proxyRequest, { signal: controller.signal })
    clearTimeout(timeoutId)

    const responseHeaders = new Headers(CORS_HEADERS)
    for (const [key, value] of response.headers) {
      if (!EXCLUDE_HEADERS.has(key.toLowerCase())) {
        responseHeaders.set(key, value)
      }
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    })
  } catch (err) {
    return errorResponse('Proxy Error', {
      message: err.message || '代理请求失败',
      target: fullTargetUrl,
      timestamp: new Date().toISOString()
    }, 502)
  }
}

// JSON 格式输出处理
async function handleFormatRequest(formatParam, sourceParam, prefixParam, defaultPrefix, request) {
  try {
    const config = FORMAT_CONFIG[formatParam]
    if (!config) {
      return errorResponse('Invalid format parameter', { format: formatParam }, 400)
    }

    const data = await getCachedJSON(sourceParam || 'full', request)

    const newData = config.proxy
      ? addOrReplacePrefix(data, prefixParam || defaultPrefix)
      : data

    if (config.base58) {
      const encoded = base58Encode(newData)
      return new Response(encoded, {
        headers: { 'Content-Type': 'text/plain;charset=UTF-8', ...CORS_HEADERS },
      })
    } else {
      return new Response(JSON.stringify(newData), {
        headers: { 'Content-Type': 'application/json;charset=UTF-8', ...CORS_HEADERS },
      })
    }
  } catch (err) {
    return errorResponse(err.message, {}, 500)
  }
}

// 首页文档
async function handleHomePage(currentOrigin, defaultPrefix) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LunaTV API 中转代理服务</title>
  <style>
    * { box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; 
      max-width: 900px; 
      margin: 0 auto; 
      padding: 20px; 
      line-height: 1.7;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
    }
    .container {
      background: rgba(255,255,255,0.95);
      border-radius: 16px;
      padding: 40px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    }
    h1 { 
      color: #333; 
      text-align: center;
      background: linear-gradient(135deg, #667eea, #764ba2);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      font-size: 2.5em;
      margin-bottom: 10px;
    }
    .subtitle {
      text-align: center;
      color: #666;
      margin-bottom: 30px;
    }
    h2 { color: #555; margin-top: 35px; border-bottom: 2px solid #667eea; padding-bottom: 10px; }
    code { background: #f0f0f0; padding: 3px 8px; border-radius: 4px; font-size: 14px; color: #e83e8c; }
    pre { background: #2d2d2d; color: #f8f8f2; padding: 15px; border-radius: 8px; overflow-x: auto; }
    .section { 
      background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%); 
      padding: 20px; 
      border-radius: 12px; 
      margin: 20px 0;
    }
    table { width: 100%; border-collapse: collapse; margin: 15px 0; }
    table td { padding: 12px; border: 1px solid #ddd; }
    table td:first-child { background: #f8f9fa; font-weight: bold; width: 25%; }
    .copy-btn { 
      background: linear-gradient(135deg, #667eea, #764ba2); 
      color: white; 
      border: none; 
      padding: 5px 12px; 
      border-radius: 5px; 
      cursor: pointer; 
      margin-left: 10px;
      font-size: 12px;
    }
    .copy-btn:hover { opacity: 0.9; }
    .feature-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; }
    .feature-item { background: #e8f5e9; padding: 10px; border-radius: 8px; border-left: 4px solid #4caf50; }
    .stats { 
      display: flex; 
      justify-content: space-around; 
      text-align: center; 
      background: linear-gradient(135deg, #667eea, #764ba2);
      padding: 20px;
      border-radius: 12px;
      color: white;
      margin: 20px 0;
    }
    .stats div { }
    .stats .num { font-size: 2em; font-weight: bold; }
    .stats .label { font-size: 0.9em; opacity: 0.9; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎬 LunaTV API 代理服务</h1>
    <p class="subtitle">通用 API 中转代理，用于访问被墻或限制的视频接口</p>
    
    <div class="stats">
      <div><div class="num">140+</div><div class="label">视频源</div></div>
      <div><div class="num">15+</div><div class="label">短剧源</div></div>
      <div><div class="num">24/7</div><div class="label">全天候服务</div></div>
    </div>
    
    <h2>🚀 快速开始</h2>
    <p>中转任意 API：在请求 URL 后添加 <code>?url=目标地址</code> 参数</p>
    <pre>${defaultPrefix}&lt;目标API地址&gt;</pre>
    
    <h2>📦 订阅配置</h2>
    <div class="section">
      <table>
        <tr>
          <td>format</td>
          <td>
            <code>0</code> 或 <code>raw</code> = 原始 JSON<br>
            <code>1</code> 或 <code>proxy</code> = 添加代理前缀<br>
            <code>2</code> 或 <code>base58</code> = 原始 Base58 编码<br>
            <code>3</code> 或 <code>proxy-base58</code> = 代理 Base58 编码
          </td>
        </tr>
        <tr>
          <td>source</td>
          <td>
            <code>jin18</code> = 精简版（仅普通影视）<br>
            <code>jingjian</code> = 精简版+成人<br>
            <code>full</code> = 完整版（默认，含短剧源）
          </td>
        </tr>
      </table>
    </div>
    
    <h2>🔗 订阅链接</h2>
    
    <div class="section">
      <h3>📺 完整版（推荐）</h3>
      <p>原始 JSON：<br><code class="copyable">${currentOrigin}?format=0&source=full</code> <button class="copy-btn">复制</button></p>
      <p>Base58 编码（LunaTV/MoonTV 订阅用）：<br><code class="copyable">${currentOrigin}?format=2&source=full</code> <button class="copy-btn">复制</button></p>
      <p>带代理 Base58：<br><code class="copyable">${currentOrigin}?format=3&source=full</code> <button class="copy-btn">复制</button></p>
    </div>
    
    <div class="section">
      <h3>🎬 精简版（仅普通影视）</h3>
      <p>Base58 编码：<br><code class="copyable">${currentOrigin}?format=2&source=jin18</code> <button class="copy-btn">复制</button></p>
    </div>
    
    <h2>✨ 功能特性</h2>
    <div class="feature-list">
      <div class="feature-item">✅ 支持所有 HTTP 方法</div>
      <div class="feature-item">✅ 自动转发请求头</div>
      <div class="feature-item">✅ 完整 CORS 支持</div>
      <div class="feature-item">✅ 9秒超时保护</div>
      <div class="feature-item">✅ 多配置源切换</div>
      <div class="feature-item">✅ Base58 编码输出</div>
    </div>
    
    <p style="text-align:center; margin-top:40px; color:#888; font-size:0.9em;">
      Powered by Cloudflare Workers | LunaTV Config
    </p>
  </div>
  
  <script>
    document.querySelectorAll('.copy-btn').forEach((btn, idx) => {
      btn.addEventListener('click', () => {
        const text = document.querySelectorAll('.copyable')[idx].innerText;
        navigator.clipboard.writeText(text).then(() => {
          btn.innerText = '已复制！';
          setTimeout(() => (btn.innerText = '复制'), 1500);
        });
      });
    });
  </script>
</body>
</html>`

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS }
  })
}

// 统一错误响应
function errorResponse(error, data = {}, status = 400) {
  return new Response(JSON.stringify({ error, ...data }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS }
  })
}
