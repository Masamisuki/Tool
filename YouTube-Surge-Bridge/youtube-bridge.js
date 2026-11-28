/**
 * YouTube 去广告 + 双语字幕 桥接脚本
 * 适用：Surge iOS，engine=webview, requires-body=1, binary-body-mode=1, max-size=-1
 *
 * 作用：在 youtubei.googleapis.com 的 player / get_watch 响应上，依次执行
 *       「YouTube Enhance 去广告脚本」和「DualSubs 翻译脚本」，把前一步的
 *       输出喂给后一步，绕开 Surge「一个请求只跑一条 response 脚本」的限制。
 *
 * 部署：
 *   1) 把本文件上传到可访问的 URL（如 GitHub Gist 的 raw 链接）
 *   2) 在 youtube-bridge.sgmodule 里把 script-path 换成该 URL
 *   3) 按说明改造原有两个模块，移除它们各自的冲突 response 规则
 *
 * 注意：本脚本依赖 fetch 从 GitHub 拉取两个子脚本并缓存到 $persistentStore。
 *       若你的网络无法直连 raw.githubusercontent.com，请把两个子脚本也自行
 *       下载托管，并修改下方 AD_URL / DS_URL。
 */

(() => {
  'use strict';

  /* ======== 按你自己的模块参数核对/修改 ======== */
  // YouTube Enhance 的 argument（JSON 字符串）
  const AD_ARG = '{"blockUpload":true,"blockShorts":false,"blockGames":true,"blockVerticalLive":false,"jumpAhead":true,"autoHd":true,"blockStore":true,"blockAi":true,"onTheGo":true}';
  // DualSubs 的 argument（Key="Value"&... 字符串）
  const DS_ARG = 'Type="Official"&Types="Translate"&AutoCC=true&Position="Forward"&Vendor="Google"&ShowOnly=false&Storage="PersistentStore"&LogLevel="WARN"';
  // 执行顺序：'ad-first'（先去广告再翻译，默认）或 'ds-first'
  const ORDER = 'ad-first';
  /* ============================================ */

  const AD_URL = 'https://raw.githubusercontent.com/gholts/surge/main/scripts/youtube/response.js';
  const DS_URL = 'https://github.com/DualSubs/YouTube/releases/download/v1.6.0/response.bundle.js';
  const CACHE_KEY = 'yt_bridge_scripts_v1'; // DualSubs 升级后把 v1 改成 v2 强制刷新缓存
  const log = (...a) => console.log('[yt-bridge]', ...a);

  function getText(url) {
    return fetch(url).then(r => {
      if (!r.ok) throw new Error(url + ' HTTP ' + r.status);
      return r.text();
    });
  }

  function loadScripts() {
    let cache = null;
    try { cache = JSON.parse($persistentStore.read(CACHE_KEY) || 'null'); } catch (_) {}
    if (cache && cache.ad && cache.ds) return Promise.resolve(cache);
    return Promise.all([getText(AD_URL), getText(DS_URL)]).then(([ad, ds]) => {
      if (!ad || !ds) throw new Error('脚本下载为空');
      try { $persistentStore.write(JSON.stringify({ ad, ds }), CACHE_KEY); } catch (_) {}
      return { ad, ds };
    });
  }

  function cloneResp(body) {
    return {
      status: $response.status,
      headers: Object.assign({}, $response.headers),
      body: body
    };
  }

  // 去广告脚本：同步执行，返回改写后的 body
  function runAd(code, body) {
    const resp = cloneResp(body);
    let out;
    let called = false;
    // 用参数遮蔽子脚本里的裸 $done / $argument / $request / $response
    const fn = new Function('$done', '$argument', '$request', '$response',
      code + '\n//# sourceURL=yt-ad.js');
    fn(r => { called = true; out = r; }, AD_ARG, $request, resp);
    if (!called) throw new Error('去广告脚本未调用 $done');
    return out && out.body != null ? out.body : body;
  }

  // 翻译脚本：异步执行（在 .finally 里调 $done），返回改写后的 body
  function runDs(code, body) {
    return new Promise((resolve, reject) => {
      const resp = cloneResp(body);
      const saved = globalThis.$argument;
      globalThis.$argument = DS_ARG; // DualSubs 读的是 globalThis.$argument，必须预设
      let settled = false;
      const finish = r => {
        if (settled) return;
        settled = true;
        globalThis.$argument = saved;
        resolve(r && r.body != null ? r.body : body);
      };
      try {
        const fn = new Function('$done', '$request', '$response',
          code + '\n//# sourceURL=yt-ds.js');
        fn(finish, $request, resp);
      } catch (e) {
        settled = true;
        globalThis.$argument = saved;
        reject(e);
      }
    });
  }

  loadScripts().then(scripts => {
    let body = $response.body;
    const stepAd = () => { body = runAd(scripts.ad, body); };
    const stepDs = () => runDs(scripts.ds, body).then(b => { body = b; });
    const chain = ORDER === 'ds-first'
      ? stepDs().then(stepAd)
      : Promise.resolve().then(stepAd).then(stepDs);
    return chain.then(() => $done({ body }));
  }).catch(e => {
    log('桥接失败，放行原响应：', e && e.message || e);
    $done({});
  });
})();
