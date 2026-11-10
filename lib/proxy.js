'use strict';

/**
 * 代理解析：auto / manual / direct。
 *
 * 背景：PI-Desktop 自己的代理设置没有对插件开放的 API（宿主内部用
 * chromium session.setProxy，未暴露 getter），所以 auto 只能退到系统代理：
 * Windows 的 HKCU Internet Settings（ProxyEnable / ProxyServer）。
 * 系统只配了 PAC（AutoConfigURL）时无法套用到子进程，会退回直连并给出说明。
 */

const { execFileSync } = require('node:child_process');

const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

/** 把 ProxyServer 的各种写法归一成 http://host:port。 */
function parseProxyServer(raw) {
  if (typeof raw !== 'string') return '';
  const text = raw.trim();
  if (!text) return '';
  const parts = text.split(';').map((s) => s.trim()).filter(Boolean);
  const map = {};
  for (const part of parts) {
    const index = part.indexOf('=');
    if (index > 0) map[part.slice(0, index).toLowerCase()] = part.slice(index + 1).trim();
  }
  const candidate = map.https || map.http || map.socks || (Object.keys(map).length > 0 ? Object.values(map)[0] : text);
  if (!candidate) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) ? candidate : `http://${candidate}`;
  try {
    const url = new URL(withScheme);
    if (!url.hostname || !url.port) return '';
    return `${url.protocol}//${url.hostname}:${url.port}`;
  } catch {
    return '';
  }
}

function readWindowsProxy() {
  if (process.platform !== 'win32') return { enabled: false, server: '', pac: '' };
  const read = (name) => {
    try {
      const out = execFileSync('reg', ['query', REG_KEY, '/v', name], { windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      const match = out.match(new RegExp(`${name}\\s+REG_\\w+\\s+(.+)`));
      return match ? match[1].trim() : '';
    } catch { return ''; }
  };
  const enable = read('ProxyEnable');
  return { enabled: /^0x0*1$/i.test(enable), server: read('ProxyServer'), pac: read('AutoConfigURL') };
}

/**
 * @param {{ proxyMode?: string, proxy?: string }} cfg
 * @param {{ enabled: boolean, server: string, pac: string }} [system]
 * @returns {{ url: string, source: 'manual'|'system'|'direct'|'none', note: string }}
 */
function resolveProxy(cfg = {}, system) {
  const mode = String(cfg.proxyMode || 'auto').toLowerCase();
  if (mode === 'direct') return { url: '', source: 'direct', note: '已设为直连' };
  if (mode === 'manual') {
    const url = parseProxyServer(cfg.proxy || '') || String(cfg.proxy || '').trim();
    if (!url) return { url: '', source: 'none', note: '手动模式但没填代理地址，按直连处理' };
    return { url, source: 'manual', note: '使用面板里手填的代理' };
  }
  const sys = system || readWindowsProxy();
  if (sys.enabled) {
    const url = parseProxyServer(sys.server);
    if (url) return { url, source: 'system', note: '跟随系统代理' };
    if (sys.pac) return { url: '', source: 'none', note: '系统只配置了 PAC，子进程无法使用，按直连处理' };
    return { url: '', source: 'none', note: '系统代理已启用但没有可解析的地址' };
  }
  return {
    url: '',
    source: 'none',
    note: sys.pac ? '系统代理未启用（存在 PAC，子进程无法使用）' : '系统代理未启用',
  };
}

module.exports = { parseProxyServer, readWindowsProxy, resolveProxy, REG_KEY };
