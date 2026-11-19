'use strict';
// Private plugin process <-> trusted agent extension. No TCP, HTTP, model headers or persisted samples.
// Only a random IPC bootstrap is written to a per-install, user-private temp directory. It is NOT a model/API key.
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const MAX = 4096, DEADLINE = 650;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function directory() {
  let root = fs.realpathSync(__dirname); if (process.platform === 'win32') root = root.toLowerCase();
  return path.join(os.tmpdir(), 'pi-acp-meter-' + hash(root + '\0' + os.homedir()).slice(0,24));
}
function address(dir, key) {
  const name='pam-'+hash('socket\0'+key).slice(0,32);
  return process.platform==='win32' ? '\\\\.\\pipe\\'+name : path.join(dir,name+'.sock');
}
async function checkDir(dir, make) {
  if (make) await fsp.mkdir(dir,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});
  const st=await fsp.lstat(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || (typeof process.getuid==='function' && (st.uid!==process.getuid() || (st.mode & 0o077)!==0))) throw Error('private meter directory unavailable');
}
async function readKey(dir) {
  await checkDir(dir,false);
  const p=path.join(dir,'channel'), st=await fsp.lstat(p);
  if(st.isSymbolicLink()||!st.isFile()||st.size!==64||(typeof process.getuid==='function'&&(st.uid!==process.getuid()||(st.mode&0o077)!==0)))throw Error('invalid meter bootstrap');
  const key=await fsp.readFile(p,'utf8'); if(!/^[0-9a-f]{64}$/.test(key))throw Error('invalid meter key'); return key;
}
function seal(key,data) {
  const text=Buffer.from(JSON.stringify(data)); if(text.length>MAX-28)throw Error('large sample');
  const iv=crypto.randomBytes(12), c=crypto.createCipheriv('aes-256-gcm',Buffer.from(key,'hex'),iv);
  const bytes=Buffer.concat([c.update(text),c.final()]);return Buffer.concat([iv,c.getAuthTag(),bytes]);
}
function open(key,data) {
  if(data.length<=28||data.length>MAX)return;
  try{const c=crypto.createDecipheriv('aes-256-gcm',Buffer.from(key,'hex'),data.subarray(0,12));c.setAuthTag(data.subarray(12,28));return JSON.parse(Buffer.concat([c.update(data.subarray(28)),c.final()]).toString('utf8'));}catch{}
}
// Failure never affects the gateway. An old service cannot overwrite a newer one's numeric state.
function listen(receive, dir=directory()) {
  const key=crypto.randomBytes(32).toString('hex'), peers=new Set();
  let closed=false, server;
  const ready=(async()=>{
    await checkDir(dir,true); if(closed)return false;
    server=net.createServer(socket=>{
      if(closed||peers.size>=16){socket.destroy();return;} peers.add(socket);socket.unref();
      const timer=setTimeout(()=>socket.destroy(),DEADLINE);timer.unref?.();let n=0;const parts=[];
      socket.on('error',()=>{});socket.once('close',()=>{clearTimeout(timer);peers.delete(socket);});
      socket.on('data',b=>{n+=b.length;if(n>MAX){socket.destroy();return;}parts.push(b);});
      socket.once('end',()=>{if(closed||n>MAX)return;const v=open(key,Buffer.concat(parts));if(v)try{receive(v);}catch{}});
    });server.maxConnections=16;server.unref();
    await new Promise((res,rej)=>{server.once('error',rej);server.listen(address(dir,key),()=>{server.removeListener('error',rej);server.on('error',()=>{});res();});});
    if(closed){server.close();return false;}
    const tmp=path.join(dir,'new-'+crypto.randomBytes(12).toString('hex'));
    try{await fsp.writeFile(tmp,key,{mode:0o600,flag:'wx'});if(closed)return false;await fsp.rename(tmp,path.join(dir,'channel'));}finally{await fsp.unlink(tmp).catch(()=>{});}
    return !closed;
  })().catch(()=>{try{server?.close();}catch{}return false;});
  function close() {
    if(closed)return;closed=true;for(const s of peers)s.destroy();try{server?.close();}catch{}
    // Synchronous compare/unlink within this service turn: a replaced bootstrap belongs to its new owner.
    void ready.then(()=>{try{const p=path.join(dir,'channel');if(fs.readFileSync(p,'utf8')===key)fs.unlinkSync(p);}catch{}});
  }
  return {ready,close};
}
// At most one asynchronous write per receipt in flight; coalesce bursts to the newest revision.
// Each call contains immutable scalar values; no event context, socket or tool payload survives its handler.
function publisher(dir) {
  const lanes=new Map();
  async function send(value){
    try{
      const d=dir||directory(), k=await readKey(d), b=seal(k,value);await new Promise((res,rej)=>{
        const s=net.createConnection(address(d,k));s.unref();const t=setTimeout(()=>s.destroy(Error('meter deadline')),DEADLINE);t.unref?.();
        s.once('connect',()=>s.end(b));s.on('data',()=>{});s.on('error',rej);s.once('close',bad=>{clearTimeout(t);if(!bad)res();});
      });
    }catch{/* Optional observation only. Never retry a model request for a meter sample. */}
  }
  return value=>{const k=value.receipt;let lane=lanes.get(k);if(lane){lane.next=value;return;}if(lanes.size>=64)return;
    lane={next:value};lanes.set(k,lane);void(async()=>{try{while(lane.next){const v=lane.next;lane.next=null;await send(v);}}finally{lanes.delete(k);}})();};
}
module.exports={listen,publisher};
