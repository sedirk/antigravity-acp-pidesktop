// A receipt grants access to numbers for ONE HTTP attempt. No credentials, histories or redirects.
import http from 'node:http';
import https from 'node:https';
export function endpoint(model) {
  try {
    const u = new URL(model?.baseUrl);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) return;
    if (u.hostname !== 'localhost' && u.hostname !== '[::1]' && !/^127(?:\.\d{1,3}){3}$/.test(u.hostname)) return;
    return u;
  } catch { /* no local diagnostic route */ }
}
export function receiptURL(model, id) {
  const u = endpoint(model);
  if (u && typeof id === 'string' && /^[a-f0-9]{32}$/.test(id)) return new URL(`/v1/antigravity/context/${id}`, u);
}
export function observation(data) {
  if (data?.version !== 1 || !['observed','pending','unavailable'].includes(data.state)) return;
  if (data.state === 'unavailable' || (data.state === 'pending' && !data.observation)) return {state:data.state};
  const o = data.observation;
  if (!Number.isSafeInteger(o?.used) || o.used < 0 || (o.size !== undefined && (!Number.isSafeInteger(o.size) || o.size <= 0))) return;
  return {state:data.state, sample:{used:o.used, ...(o.size === undefined ? {} : {size:o.size})}};
}
export function readReceipt(url, signal) {
  return new Promise(resolve => {
    if (!url || signal.aborted) return resolve();
    // Direct socket, no proxy/env, no redirect/DNS to a non-loopback host.
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.get(url, {agent:false, signal, headers:{Accept:'application/json'},
      ...(url.hostname === 'localhost' ? {hostname:'127.0.0.1', ...(url.protocol === 'https:' ? {servername:'localhost'} : {})} : {})}, res => {
      if (res.statusCode !== 200 || !/^application\/json(?:;|$)/i.test(res.headers['content-type'] || '')) { res.destroy(); resolve(); return; }
      const parts=[]; let bytes=0;
      res.on('data', b => { bytes+=b.length; if (bytes>1024) { res.destroy(); resolve(); } else parts.push(b); });
      res.on('error',()=>resolve()); res.on('aborted',()=>resolve());
      res.on('end',()=>{try{
        const value=observation(JSON.parse(Buffer.concat(parts).toString('utf8')));
        const h=res.headers['x-antigravity-acp-receipt-issued-at'];
        const issuedAt=typeof h==='string'&&/^[0-9]{1,16}$/.test(h)?Number(h):undefined;
        resolve(value&&Number.isSafeInteger(issuedAt)&&issuedAt>0?{...value,issuedAt}:value);
      }catch{resolve();}});
    });
    request.on('error',()=>resolve());
    const timer=setTimeout(()=>request.destroy(new Error('receipt deadline')),800); timer.unref?.();
    request.once('close',()=>clearTimeout(timer));
  });
}
