const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const source = fs.readFileSync(path.join(__dirname, '../addon.js'), 'utf8');
function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-test-'));
    const axios = Object.assign(async opts => opts, { defaults: {}, get: async () => { throw Error('Unexpected GET'); }, post: async () => { throw Error('Unexpected POST'); } });
    class Builder {
        constructor(manifest) { this.manifest = manifest; this.handlers = {}; }
        defineCatalogHandler(fn) { this.handlers.catalog = fn; }
        defineMetaHandler(fn) { this.handlers.meta = fn; }
        defineStreamHandler(fn) { this.handlers.stream = fn; }
        getInterface() { return { manifest: this.manifest, get: (resource, type, id, extra) => this.handlers[resource]({ type, id, extra }) }; }
    }
    const servers = [];
    const req = id => id === 'axios' ? axios : id === 'stremio-addon-sdk' ? { addonBuilder: Builder } : id === 'apache-md5' ? () => 'hash' : id === 'http' ? { createServer(fn) { const srv = { fn, listen() {}, close(fn) { fn(); }, closeAllConnections() {} }; servers.push(srv); return srv; } } : require(id);
    const context = vm.createContext({ require: req, module: {}, __dirname: dir, __filename: path.join(dir, 'addon.js'), Buffer, URL, URLSearchParams, console: {log(){},error(){}}, process: { argv: ['node','addon.js'], env: {}, exit(){throw Error('Unexpected exit');} }, setTimeout, clearTimeout, setInterval });
    vm.runInContext(source, context);
    const run = code => vm.runInContext(code, context);
    return { dir, axios, servers, context, run, cleanup() { run('if (metadataTimer) clearTimeout(metadataTimer)'); fs.rmSync(dir, {recursive:true, force:true}); } };
}
function check(name, body) { test(name, async () => { const f=fixture(); try { await body(f); } finally { f.cleanup(); } }); }
check('SledujTeTo custom headers preserve the authenticated session', async f => {
    f.run('sessionCookie = "session=test"');
    const result=await f.run('api("https://example.test", {headers:{Accept:"text/html"}})');
    assert.equal(result.headers.Cookie, 'session=test'); assert.equal(result.headers.Accept,'text/html'); assert.ok(result.headers['User-Agent']);
});
check('Premium is active only for an explicit active state', f => {
    assert.equal(f.run('detectPremium("Premium: neaktivní")'),false);
    assert.equal(f.run('detectPremium("<b>Premium:</b> aktivní")'),true);
    assert.equal(f.run('detectPremium("Kupte premium a aktivní účet")'),false);
});
check('Episode matching excludes prefixes and supports specials', async f => {
    for (const title of ['Show S1E20','Show 11x02','Show S01E020']) assert.equal(f.run(`makeEpFilter('S01E02',1,2)(${JSON.stringify(title)})`),false);
    for (const title of ['Show S01E02','Show 1x02','Show S1E2']) assert.equal(f.run(`makeEpFilter('S01E02',1,2)(${JSON.stringify(title)})`),true);
    f.run('tmdbCache.tt123 = {names:["Show"],year:"2020"}');
    const q=await f.run('buildImdbQueries("tt123",0,1)');
    assert.equal(q.epTag,'S00E01'); assert.ok(q.queries.includes('Show 0x01')); assert.ok(q.queries.includes('Show'));
});
check('Film queries include the name without its year; translated names do not imply audio', async f=>{
    f.run('tmdbCache.tt123 = {names:["Movie"],year:"2020",czTitle:"Movie"}');
    const q=await f.run('buildImdbQueries("tt123",null,null)'); assert.ok(q.queries.includes('Movie'));
    assert.equal(f.run('const files=[{name:"Movie EN",audioTracks:""}]; enhanceAudioByTitle(files,"name","tt123"); files[0].audioTracks'), '');
});
check('Search cache reuses successful results but retries empty responses', async f=>{
    f.run('var searchCalls=0; var successfulSearch=async()=>{searchCalls++;return [{id:"one"}]}; var emptySearch=async()=>{searchCalls++;return []}');
    await f.run('cachedSearch("test","Movie",successfulSearch)');
    await f.run('cachedSearch("test","Movie",successfulSearch)');
    assert.equal(f.run('searchCalls'), 1);
    f.run('searchCalls=0');
    await f.run('cachedSearch("empty","Movie",emptySearch)');
    await f.run('cachedSearch("empty","Movie",emptySearch)');
    assert.equal(f.run('searchCalls'), 2);
});
check('Prehraj fallback survives failed downloads and rejects non-video redirects', async f=>{
    const page={data:"videos.push({src: 'https://pf-storage1.premiumcdn.net/test.mp4'})",headers:{}};
    f.axios.get=async url=>{if(url.endsWith('?do=download'))throw Error('timeout'); return page;};
    assert.equal(await f.run('ptGetStreamUrl("test","id")'),'https://pf-storage1.premiumcdn.net/test.mp4');
    f.axios.get=async url=>url.endsWith('?do=download') ? {status:302,headers:{location:'/cenik'}} : page;
    assert.equal(await f.run('ptGetStreamUrl("test","id")'),'https://pf-storage1.premiumcdn.net/test.mp4');
    f.axios.get=async url=>url.endsWith('?do=download') ? {status:302,headers:{location:'https://pf-storage1.premiumcdn.net/original'}} : page;
    assert.equal(await f.run('ptGetStreamUrl("test","id")'),'https://pf-storage1.premiumcdn.net/original');
});
check('Metadata survives restart and remains bounded', f=>{
    f.run('ptFileCache.test = {ptId:"test",ptSlug:"bunny",name:"Bunny"}; flushMetadata()');
    const data=JSON.parse(fs.readFileSync(path.join(f.dir,'metadata-cache.json'),'utf8'));
    assert.equal(data.ptFileCache[0][1].ptSlug,'bunny');
    f.context.restoredForTest=data;
    assert.equal(f.run('restoredMetadata=restoredForTest; lruCache(1,"ptFileCache").test.ptSlug'),'bunny');
    assert.equal(f.run('const c=lruCache(1); c.a=1;c.b=2;Object.keys(c).join(",")'),'b');
});
check('Concurrent authentication is shared and logout invalidates a pending login', async f=>{
    let release; f.context.pending=new Promise(resolve=>release=resolve);
    f.run('var count=0; var one=serializedLogin("st","same",async()=>{count++;await pending;loggedIn=true;return true}); var two=serializedLogin("st","same",async()=>{count++;return true})');
    assert.equal(f.run('count'),1);f.run('invalidateSession("st")'); release();
    assert.equal(await f.run('one'),false);assert.equal(await f.run('two'),false);assert.equal(f.run('loggedIn'),false);
});
check('Admin requires pairing over LAN and rejects cross-origin local requests', f=>{
    const token=f.run('config.adminToken');
    f.context.request={socket:{remoteAddress:'192.168.1.20'},headers:{host:'192.168.1.10:7515'}};
    assert.equal(f.run('hasAdminAccess(request)'),false);
    f.context.request.headers.cookie='streamhub_admin='+token;assert.equal(f.run('hasAdminAccess(request)'),true);
    f.context.request.headers.cookie='streamhub_admin='+'é'.repeat(48);assert.equal(f.run('hasAdminAccess(request)'),false);
    f.context.request.headers.cookie='streamhub_admin='+token;
    f.context.request.headers.origin='https://untrusted.test';assert.equal(f.run('hasAdminAccess(request)'),false);
    f.context.request={socket:{remoteAddress:'127.0.0.1'},headers:{host:'127.0.0.1:7515'}};assert.equal(f.run('hasAdminAccess(request)'),true);
});
check('HTTP catalog routing preserves ampersands and handles malformed encoding',async f=>{
    f.run('startAddonServer(); addonInterfaces.hs.get=async (r,t,id,extra)=>({metas:[],query:extra.search})');
    const call=async url=>{const req={url,method:'GET',headers:{host:'127.0.0.1:7515'},socket:{remoteAddress:'127.0.0.1'}};let body;const res={setHeader(){},writeHead(){},end(v){body=v}};await f.servers[0].fn(req,res);return body;};
    assert.equal(JSON.parse(await call('/hs/catalog/movie/hellspy-main/search=Tom%20%26%20Jerry.json')).query,'Tom & Jerry');
    await call('/hs/catalog/movie/hellspy-main/search=bad%.json');
});
check('Stop closes existing transfers',async f=>{
    f.context.upstream=new PassThrough(); f.context.response=new PassThrough();
    f.run('activeTransfers.add({upstream,response});startProxyServer()');
    await f.servers[0].fn({url:'/api/server/stop',method:'POST',headers:{host:'127.0.0.1:7516'},socket:{remoteAddress:'127.0.0.1'}},{setHeader(){},writeHead(){},end(){}});
    assert.equal(f.context.upstream.destroyed,true);assert.equal(f.context.response.destroyed,true);
});
check('Generated configuration JavaScript parses and passwords are not trimmed',f=>{
    const html=f.run('getConfigHTML()'); const script=html.match(/<script>([\s\S]*?)<\/script>/)[1]; new vm.Script(script);
    assert.ok(!/Password"\)\.value\.trim/.test(script));
    assert.ok(html.includes('lanHostSelect'));new vm.Script(f.run('pairingHTML()').match(/<script>([\s\S]*?)<\/script>/)[1]);
});
check('Android install stays local without tunnels or Stremio account writes',f=>{
    const html=f.run('getConfigHTML()');
    const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
    const install=script.match(/async function installOne\(key\) \{[\s\S]*?\n\}/)[0];
    assert.ok(install.includes('addonUrls[key]'));
    assert.ok(install.includes('stremio:///addons?addon='));
    assert.ok(install.includes('encodeURIComponent(url)'));
    assert.ok(!install.includes('url.replace'));
    assert.ok(!install.includes('accountInstall'));
    assert.ok(source.includes('http://127.0.0.1:${ADDON_PORT}/st/manifest.json'));
    assert.ok(!source.toLowerCase().includes('cloudflared'));
    assert.ok(!source.includes('/api/install-url'));
    assert.ok(!source.includes('/api/stremio/install'));
    assert.ok(!source.includes('addonCollectionSet'));
    assert.ok(!source.includes('stremioTitle'));
});
check('OTA rejects invalid syntax without replacing the installed addon',async f=>{
    fs.writeFileSync(path.join(f.dir,'addon.js'),'original');
    f.run('startProxyServer()');
    const invalid='const APP_VERSION = 37; function startAddonServer( '+ ' '.repeat(5100);
    f.axios.get=async url=>url.endsWith('update.json') ? {data:{version:37,addonUrl:'https://raw.githubusercontent.com/lerrel129/stream-hub-updates/test/addon.js'}} : {status:200,data:invalid};
    let body;await f.servers[0].fn({url:'/api/update/apply',method:'POST',headers:{host:'127.0.0.1:7516'},socket:{remoteAddress:'127.0.0.1'}},{setHeader(){},writeHead(){},end(v){body=v}});
    assert.equal(JSON.parse(body).ok,false);assert.equal(fs.readFileSync(path.join(f.dir,'addon.js'),'utf8'),'original');
});
