// 书信簿 · AI 接口
// 插件里所有要调用 AI 的地方（关键词、回信、翻译、识别历史信件、推算剧情日期）都走这里。
// 三种方式：
//   main    跟随酒馆当前使用的 API
//   profile 用酒馆“连接配置”里存好的某一套（不会切换你正在聊天用的那套）
//   custom  自定义 OpenAI 兼容接口：地址、密钥、模型。请求经由酒馆服务端转发，不会有浏览器跨域问题

export const API_MODES = {
    main: '跟随酒馆当前的 API',
    profile: '使用酒馆的连接配置',
    custom: '自定义接口（OpenAI 兼容）',
};

export const DEFAULT_API = {
    mode: 'main',
    profileId: '',
    url: '',
    key: '',
    model: '',
    maxTokens: 2000,
    temperature: 0.8,
};

const ctx = () => SillyTavern.getContext();

export function listProfiles() {
    try {
        const svc = ctx().ConnectionManagerRequestService;
        if (svc?.getSupportedProfiles) return svc.getSupportedProfiles().map(p => ({ id: p.id, name: p.name }));
        return (ctx().extensionSettings.connectionManager?.profiles || []).map(p => ({ id: p.id, name: p.name }));
    } catch {
        return [];
    }
}

function customHeaders(key) {
    return key ? `Authorization: Bearer ${String(key).trim()}` : '';
}

function extractText(json) {
    if (typeof json === 'string') return json;
    if (!json) return '';
    if (typeof json.content === 'string') return json.content;
    const c = json.choices?.[0];
    if (c?.message?.content != null) {
        const m = c.message.content;
        return Array.isArray(m) ? m.map(p => p.text || '').join('') : String(m);
    }
    if (c?.text != null) return String(c.text);
    if (json.message?.content) return String(json.message.content);
    return '';
}

// 去掉推理模型的思考过程
function stripThinking(text) {
    return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '').trim();
}

async function callMain(system, prompt) {
    const fn = ctx().generateRaw;
    if (typeof fn !== 'function') throw new Error('当前酒馆版本不支持 generateRaw');
    if (fn.length >= 2) return fn(prompt, null, false, false, system);
    return fn({ prompt, systemPrompt: system });
}

async function callProfile(cfg, system, prompt) {
    const svc = ctx().ConnectionManagerRequestService;
    if (!svc) throw new Error('当前酒馆版本没有连接配置功能，请升级酒馆或换一种方式');
    if (!cfg.profileId) throw new Error('还没有选择连接配置');
    const messages = [{ role: 'system', content: system }, { role: 'user', content: prompt }];
    const res = await svc.sendRequest(cfg.profileId, messages, cfg.maxTokens || 2000, { includePreset: false, includeInstruct: false });
    return extractText(res);
}

async function callCustom(cfg, system, prompt) {
    if (!cfg.url) throw new Error('还没有填写接口地址');
    if (!cfg.model) throw new Error('还没有填写模型名');
    const body = {
        chat_completion_source: 'custom',
        custom_url: cfg.url.trim().replace(/\/+$/, ''),
        custom_include_headers: customHeaders(cfg.key),
        model: cfg.model.trim(),
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
        max_tokens: cfg.maxTokens || 2000,
        temperature: cfg.temperature ?? 0.8,
        stream: false,
    };
    const res = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    if (!res.ok || json?.error) {
        const msg = json?.error?.message || json?.message || text.slice(0, 200) || `HTTP ${res.status}`;
        throw new Error(`接口返回错误：${msg}`);
    }
    return extractText(json);
}

/**
 * 调用 AI
 * @param {object} cfg 接口设置
 * @param {string} system 系统提示
 * @param {string} prompt 用户提示
 * @param {object} [meta] 用途说明 { kind: 'raw' | 'reply' | 'translate' | 'import' | 'date', ... }（演示页的假 AI 用来决定回什么）
 */
export async function callAI(cfg, system, prompt, meta = {}) {
    const mock = globalThis.epistolary?.mockGenerate;
    if (mock) return mock({ prompt, systemPrompt: system, kind: 'raw', ...meta });
    const c = { ...DEFAULT_API, ...(cfg || {}) };
    let out;
    if (c.mode === 'profile') out = await callProfile(c, system, prompt);
    else if (c.mode === 'custom') out = await callCustom(c, system, prompt);
    else out = await callMain(system, prompt);
    return stripThinking(out);
}

// 自定义接口：拉取模型列表
export async function fetchModels(cfg) {
    const res = await fetch('/api/backends/chat-completions/status', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({
            chat_completion_source: 'custom',
            custom_url: String(cfg.url || '').trim().replace(/\/+$/, ''),
            custom_include_headers: customHeaders(cfg.key),
        }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) throw new Error(json?.error?.message || json?.message || `HTTP ${res.status}`);
    const list = Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : [];
    return list.map(m => m.id || m.name).filter(Boolean).sort();
}

export async function testConnection(cfg) {
    const out = await callAI(cfg, '你是一个测试助手。', '请只回复两个字：收到');
    if (!String(out).trim()) throw new Error('接口没有返回内容');
    return String(out).trim().slice(0, 60);
}
