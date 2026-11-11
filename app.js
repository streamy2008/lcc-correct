/* LCC PWA 主程序：UI、解码调度、IndexedDB、导出 */
(function () {
  'use strict';
  const C = self.LccCodec;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  const state = {
    photoFile: null, photoMeta: null, photo: null,
    flats: [], profile: null, profiles: [], result: null,
    lastReport: null,
  };

  /* ---------------- 小工具 ---------------- */
  let toastTimer = null;
  function toast(msg, kind) {
    const el = $('#toast');
    el.textContent = msg;
    el.dataset.kind = kind || 'info';
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'err' ? 6000 : 3200);
  }
  function busy(on, text) {
    $('#busy').hidden = !on;
    if (text) $('#busyText').textContent = text;
  }
  const fmt = (n) => n.toLocaleString('zh-CN');

  /* ---------------- Worker ---------------- */
  const worker = new Worker('worker.js');
  let seq = 0;
  const waiting = new Map();
  worker.onmessage = (e) => {
    const { id } = e.data;
    const w = waiting.get(id);
    if (!w) return;
    waiting.delete(id);
    if (e.data.ok) w.resolve(e.data); else w.reject(new Error(e.data.error || '处理失败'));
  };
  worker.onerror = (e) => {
    for (const [, w] of waiting) w.reject(new Error('Worker 出错：' + (e.message || '未知')));
    waiting.clear();
  };
  function callWorker(cmd, payload, transfer) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      worker.postMessage({ id, cmd, payload }, transfer || []);
    });
  }

  /* ---------------- 解码 ---------------- */
  function maxPixels() { return parseInt($('#maxPixels').value, 10) || 12000000; }

  async function decodeFile(file, cap) {
    try {
      return await C.decodeImage(file, cap);
    } catch (err) {
      throw new Error(`${file.name}：${err.message}`);
    }
  }

  function resizeNearest(img, w, h) {
    const out = img.bits === 8 ? new Uint8Array(w * h * 3) : new Uint16Array(w * h * 3);
    for (let y = 0; y < h; y++) {
      const sy = Math.min(img.h - 1, Math.round((y + 0.5) * img.h / h - 0.5));
      for (let x = 0; x < w; x++) {
        const sx = Math.min(img.w - 1, Math.round((x + 0.5) * img.w / w - 0.5));
        const si = (sy * img.w + sx) * 3, di = (y * w + x) * 3;
        out[di] = img.data[si]; out[di + 1] = img.data[si + 1]; out[di + 2] = img.data[si + 2];
      }
    }
    return { w, h, bits: img.bits, data: out, channels: 3 };
  }

  /* 预览：降采样成 ImageData（盒式平均）。8bit 视为 sRGB 直接显示；16bit 视为线性，先编码成 sRGB。 */
  function toImageData(img, maxSide) {
    const M = self.LccMath;
    const scale = Math.min(1, maxSide / Math.max(img.w, img.h));
    const w = Math.max(1, Math.round(img.w * scale));
    const h = Math.max(1, Math.round(img.h * scale));
    const out = new Uint8ClampedArray(w * h * 4);
    const fx = img.w / w, fy = img.h / h;
    const box = Math.max(1, Math.floor(Math.min(fx, fy)));
    const src = img.data, bits = img.bits;
    const lin = bits === 16;
    for (let y = 0; y < h; y++) {
      const sy0 = Math.min(img.h - 1, Math.floor(y * fy));
      const sy1 = Math.min(img.h, sy0 + box);
      for (let x = 0; x < w; x++) {
        const sx0 = Math.min(img.w - 1, Math.floor(x * fx));
        const sx1 = Math.min(img.w, sx0 + box);
        let r = 0, g = 0, b = 0, n = 0;
        for (let yy = sy0; yy < sy1; yy++) {
          let p = (yy * img.w + sx0) * 3;
          for (let xx = sx0; xx < sx1; xx++) {
            if (lin) { r += src[p] / 65535; g += src[p + 1] / 65535; b += src[p + 2] / 65535; }
            else { r += src[p]; g += src[p + 1]; b += src[p + 2]; }
            p += 3; n++;
          }
        }
        const o = (y * w + x) * 4;
        if (lin) {
          out[o] = M.srgb8(r / n); out[o + 1] = M.srgb8(g / n); out[o + 2] = M.srgb8(b / n);
        } else {
          out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n;
        }
        out[o + 3] = 255;
      }
    }
    return new ImageData(out, w, h);
  }

  function paintCanvas(canvas, img, maxSide) {
    const id = toImageData(img, maxSide || 1500);
    canvas.width = id.width;
    canvas.height = id.height;
    canvas.getContext('2d').putImageData(id, 0, 0);
  }

  /* ---------------- IndexedDB ---------------- */
  const DB_NAME = 'lcc-db', STORE = 'profiles';
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function dbAll() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }
  async function dbPut(rec) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(rec);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function dbDel(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /* ---------------- 轮廓库 ---------------- */
  async function loadLibrary() {
    state.profiles = await dbAll();
    renderLibrary();
    renderProfileSelect();
  }
  function cornerText(rep) {
    if (!rep || !rep.corners) return '';
    const c = rep.corners.br;
    return `右下增益 R ${c[0].toFixed(2)} / G ${c[1].toFixed(2)} / B ${c[2].toFixed(2)}`;
  }
  function renderLibrary() {
    const ul = $('#library');
    ul.innerHTML = '';
    if (!state.profiles.length) {
      ul.innerHTML = '<li class="dim">还没有保存的轮廓。生成后点「存入库」。</li>';
      return;
    }
    for (const p of state.profiles) {
      const li = document.createElement('li');
      li.className = 'lib-item';
      const meta = p.report ? cornerText(p.report) : `${p.json.model} · ${new Date(p.created).toLocaleString('zh-CN')}`;
      li.innerHTML = `<div><strong></strong><br><span class="mono dim"></span></div>
        <div class="lib-actions"><button class="btn tiny" data-act="use">用</button>
        <button class="btn tiny ghost danger" data-act="del">删</button></div>`;
      li.querySelector('strong').textContent = p.name || '(未命名)';
      li.querySelector('.dim').textContent = meta;
      li.querySelector('[data-act="use"]').onclick = () => {
        state.profile = p.json;
        state.lastReport = p.report;
        renderProfileSelect(p.id);
        updateProfileMeta();
        toast('已选用：' + (p.name || '(未命名)'));
      };
      li.querySelector('[data-act="del"]').onclick = async () => {
        await dbDel(p.id);
        await loadLibrary();
        toast('已删除');
      };
      ul.appendChild(li);
    }
  }
  function renderProfileSelect(selectId) {
    const sel = $('#profileSelect');
    const cur = selectId || sel.value;
    sel.innerHTML = '<option value="">（未选，先建轮廓或用应急模式）</option>';
    for (const p of state.profiles) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = (p.name || '(未命名)') + ' · ' + (p.json.model || '');
      sel.appendChild(o);
    }
    if (cur) sel.value = cur;
    syncButtons();
  }
  function updateProfileMeta() {
    const rep = state.lastReport;
    const el = $('#profileMeta');
    if (!state.profile) { el.textContent = ''; return; }
    const base = `${state.profile.model}${state.profile.deg ? ' deg' + state.profile.deg : ''} · 中心 ${Math.round(state.profile.center[0])},${Math.round(state.profile.center[1])}`;
    el.textContent = rep ? `${base} · ${cornerText(rep)}` : base;
  }

  /* ---------------- 平场 ---------------- */
  async function addFlats(files) {
    if (!files.length) return;
    busy(true, '读取平场');
    try {
      const cap = Math.min(maxPixels(), 3000000);
      const loaded = [];
      for (const f of files) loaded.push(await decodeFile(f, cap));
      // 统一尺寸：以第一张为准
      const w = loaded[0].w, h = loaded[0].h;
      state.flats = loaded.map((im) => (im.w === w && im.h === h ? im : resizeNearest(im, w, h)));
      renderFlats();
      toast(`已读入 ${state.flats.length} 张平场`);
    } catch (err) {
      toast(err.message, 'err');
    } finally { busy(false); }
  }
  function renderFlats() {
    const ul = $('#flatList');
    ul.innerHTML = '';
    state.flats.forEach((im, i) => {
      const li = document.createElement('li');
      const cv = document.createElement('canvas');
      cv.width = 96; cv.height = 64;
      const ctx = cv.getContext('2d');
      ctx.drawImage(canvasFromImage(im, 96, 64), 0, 0, 96, 64);
      li.appendChild(cv);
      const b = document.createElement('button');
      b.className = 'thumb-x';
      b.textContent = '×';
      b.title = '移除';
      b.onclick = () => { state.flats.splice(i, 1); renderFlats(); };
      li.appendChild(b);
      ul.appendChild(li);
    });
    const im = state.flats[0];
    $('#flatMeta').textContent = im ? `${state.flats.length} 张 · ${im.w}×${im.h}` : '';
    syncButtons();
  }
  function canvasFromImage(img, w, h) {
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    cv.getContext('2d').putImageData(toImageData(img, Math.max(w, h)), 0, 0);
    return cv;
  }

  /* ---------------- 建轮廓 ---------------- */
  async function buildProfile() {
    if (state.flats.length < 1) { toast('先选平场', 'err'); return; }
    busy(true, `建轮廓（${state.flats.length} 张）`);
    try {
      const opts = {
        black: parseTriple($('#black').value),
        model: $('#model').value,
        deg: parseInt($('#deg').value, 10),
        gainMax: parseFloat($('#gainMax').value) || 6,
        smooth: parseFloat($('#smooth').value) || 0,
        block: Math.max(8, Math.round(Math.min(state.flats[0].w, state.flats[0].h) / 40)),
        label: $('#profileLabel').value.trim(),
      };
      const frames = state.flats.map((f) => ({ w: f.w, h: f.h, bits: f.bits, data: f.data }));
      const res = await callWorker('profile', { frames, opts });
      state.profile = res.profile;
      state.lastReport = res.report;
      updateProfileMeta();
      await drawGainPreview(res.profile);
      $('#saveBtn').disabled = false;
      syncButtons();
      toast(`轮廓就绪：${cornerText(res.report)}`);
    } catch (err) {
      toast(err.message, 'err');
    } finally { busy(false); }
  }

  function parseTriple(s) {
    const v = String(s).split(/[,，\s]+/).filter(Boolean).map(Number);
    if (v.length !== 3 || v.some((x) => !isFinite(x))) return [0, 0, 0];
    return v.map((x) => Math.max(0, x));
  }

  async function drawGainPreview(profile) {
    const res = await callWorker('gainpreview', { profile, w: 480, h: 320 });
    const cv = $('#cvGain');
    cv.width = res.image.w; cv.height = res.image.h;
    cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(res.image.rgba), res.image.w, res.image.h), 0, 0);
    $('#gainBox').hidden = false;
    const rep = state.lastReport;
    $('#gainMeta').textContent = rep ? `网格 ${rep.grid[0]}×${rep.grid[1]} · 最大增益 ${rep.gain_max.toFixed(2)}` : '';
  }

  /* ---------------- 选照片 ---------------- */
  async function pickPhoto(file) {
    busy(true, '读取照片');
    try {
      const img = await decodeFile(file, maxPixels());
      state.photoFile = file;
      state.photo = img;
      state.result = null;
      state.photoMeta = { ...img, data: undefined };
      $('#emptyState').hidden = true;
      $('#viewer').hidden = false;
      const capped = (img.origW || img.w) !== img.w;
      $('#imgMeta').textContent = `${img.w}×${img.h} · ${img.bits}bit${capped ? ` · 原图 ${img.origW}×${img.origH}（已按上限缩小）` : ''}`;
      paintCanvas($('#cvBefore'), img, 1600);
      paintCanvas($('#cvAfter'), img, 1600);
      $('#cvAfter').style.clipPath = 'inset(0 0 0 50%)';
      $('#photoName').textContent = file.name;
      $('#resultMeta').textContent = '';
      $('#exportBtn').disabled = true;
      syncButtons();
    } catch (err) {
      toast(err.message, 'err');
    } finally { busy(false); }
  }

  /* ---------------- 校正 ---------------- */
  async function applyProfile() {
    if (!state.photo || !state.profile) { toast('需要照片和轮廓', 'err'); return; }
    busy(true, '校正中');
    try {
      const img = state.photo;
      const copy = img.bits === 8 ? Uint8Array.from(img.data) : Uint16Array.from(img.data);
      const res = await callWorker('apply', {
        image: { w: img.w, h: img.h, bits: img.bits, data: copy },
        profile: state.profile,
        opts: { chromaOnly: $('#chromaOnly').checked, exposure: $('#keepExposure').checked ? 'preserve' : 'none', gainRes: 1200, outBits: 16 },
      }, [copy.buffer]);
      state.result = res.image;
      paintCanvas($('#cvAfter'), res.image, 1600);
      $('#exportBtn').disabled = false;
      $('#resultMeta').textContent = `曝光系数 ${res.report.exposure.toFixed(3)} · 削顶 ${(res.report.clipped / (img.w * img.h) * 100).toFixed(2)}%`;
      syncButtons();
      toast('校正完成');
    } catch (err) {
      toast(err.message, 'err');
    } finally { busy(false); }
  }

  async function autoCorrect() {
    if (!state.photo) { toast('先选照片', 'err'); return; }
    busy(true, '估计色度渐变');
    try {
      const img = state.photo;
      const copy = img.bits === 8 ? Uint8Array.from(img.data) : Uint16Array.from(img.data);
      const res = await callWorker('auto', {
        image: { w: img.w, h: img.h, bits: img.bits, data: copy },
        opts: { deg: 3, maxCorr: 0.7, label: 'scene-auto' },
      });
      state.profile = res.profile;
      state.lastReport = { ...res.report, corners: null };
      updateProfileMeta();
      await drawGainPreview(res.profile);
      await applyProfile();
      toast(`应急轮廓：用到 ${res.report.validBlocks} 个平坦块`);
    } catch (err) {
      toast(err.message, 'err');
    } finally { busy(false); }
  }

  /* ---------------- 导出 ---------------- */
  async function exportImage() {
    if (!state.result) { toast('先校正', 'err'); return; }
    const fmtv = $('#exportFormat').value;
    const img = state.result;
    const base = (state.photoFile ? state.photoFile.name.replace(/\.[^.]+$/, '') : 'photo') + '_lcc';
    try {
      busy(true, '导出');
      if (fmtv === 'tiff16') {
        let rgb16;
        if (img.bits === 16) rgb16 = img.data;
        else {
          rgb16 = new Uint16Array(img.data.length);
          for (let i = 0; i < img.data.length; i++) rgb16[i] = img.data[i] * 257;
        }
        const blob = C.encodeTiff16(img.w, img.h, rgb16);
        saveBlob(blob, base + '.tif');
      } else {
        const cv = document.createElement('canvas');
        cv.width = img.w; cv.height = img.h;
        const ctx = cv.getContext('2d');
        ctx.putImageData(toImageData(img, Math.max(img.w, img.h)), 0, 0);
        const type = fmtv === 'png' ? 'image/png' : 'image/jpeg';
        const blob = await new Promise((r) => cv.toBlob(r, type, 0.92));
        saveBlob(blob, base + (fmtv === 'png' ? '.png' : '.jpg'));
      }
      toast('已导出');
    } catch (err) {
      toast('导出失败：' + err.message, 'err');
    } finally { busy(false); }
  }
  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 8000);
    window.__lccLastExport = { name, size: blob.size };
  }

  /* ---------------- 轮廓存取 ---------------- */
  async function saveProfileToLibrary() {
    if (!state.profile) return;
    const name = $('#profileLabel').value.trim() || `轮廓 ${new Date().toLocaleString('zh-CN')}`;
    const rec = { id: 'p' + Date.now(), name, json: state.profile, report: state.lastReport, created: new Date().toISOString() };
    await dbPut(rec);
    await loadLibrary();
    toast('已存入本机轮廓库');
  }
  async function exportProfileJson() {
    if (!state.profile) { toast('没有轮廓', 'err'); return; }
    const blob = new Blob([JSON.stringify(state.profile, null, 1)], { type: 'application/json' });
    saveBlob(blob, 'lcc-profile.json');
  }
  async function importProfileJson(file) {
    try {
      const json = JSON.parse(await file.text());
      if (json.schema !== 'lenscast-profile/1') throw new Error('不是 LCC 轮廓文件（schema 不符）');
      state.profile = json;
      state.lastReport = null;
      updateProfileMeta();
      await drawGainPreview(json);
      $('#saveBtn').disabled = false;
      syncButtons();
      toast('已导入轮廓');
    } catch (err) { toast('导入失败：' + err.message, 'err'); }
  }

  /* ---------------- 其它 UI ---------------- */
  function syncButtons() {
    $('#applyBtn').disabled = !(state.photo && state.profile);
    $('#autoBtn').disabled = !state.photo;
    $('#buildBtn').disabled = state.flats.length === 0;
    $('#mobileBuild').disabled = state.flats.length === 0;
    $('#mobileApply').disabled = !(state.photo && state.profile);
    $('#saveBtn').disabled = !state.profile;
  }

  function setSplit(v) {
    const pct = Math.max(0, Math.min(100, Number(v)));
    $('#cvAfter').style.clipPath = `inset(0 0 0 ${pct}%)`;
    const wrap = $('.canvas-wrap');
    const r = wrap.getBoundingClientRect();
    $('#splitHandle').style.left = `calc(${pct}% - 1px)`;
    $('.tag-before').style.opacity = pct > 8 ? 1 : 0;
    $('.tag-after').style.opacity = pct < 92 ? 1 : 0;
  }

  /* ---------------- 事件 ---------------- */
  function bind() {
    $('#pickPhoto').onclick = () => $('#photoInput').click();
    $('#pickPhotoEmpty').onclick = () => $('#photoInput').click();
    $('#photoInput').onchange = (e) => { if (e.target.files[0]) pickPhoto(e.target.files[0]); };

    $('#pickFlat').onclick = () => $('#flatInput').click();
    $('#flatInput').onchange = (e) => addFlats(Array.from(e.target.files || []));

    $('#buildBtn').onclick = buildProfile;
    $('#mobileBuild').onclick = buildProfile;
    $('#applyBtn').onclick = applyProfile;
    $('#mobileApply').onclick = applyProfile;
    $('#autoBtn').onclick = autoCorrect;
    $('#exportBtn').onclick = exportImage;
    $('#saveBtn').onclick = saveProfileToLibrary;
    $('#exportProfile').onclick = exportProfileJson;
    $('#importProfile').onclick = () => $('#importInput').click();
    $('#importInput').onchange = (e) => { if (e.target.files[0]) importProfileJson(e.target.files[0]); };
    $('#deleteProfile').onclick = async () => {
      const id = $('#profileSelect').value;
      if (!id) { toast('先在库里选一个'); return; }
      await dbDel(id);
      state.profile = null;
      state.lastReport = null;
      $('#gainBox').hidden = true;
      updateProfileMeta();
      await loadLibrary();
      toast('已删除');
    };
    $('#profileSelect').onchange = (e) => {
      const rec = state.profiles.find((p) => p.id === e.target.value);
      state.profile = rec ? rec.json : null;
      state.lastReport = rec ? rec.report : null;
      updateProfileMeta();
      if (state.profile) drawGainPreview(state.profile); else $('#gainBox').hidden = true;
      syncButtons();
    };

    $('#split').oninput = (e) => setSplit(e.target.value);
    $('#mobileFlat').onclick = () => {
      $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === 'flat'));
      $$('.tab-panel').forEach((p) => p.classList.toggle('is-active', p.dataset.panel === 'flat'));
      $('#flatInput').click();
    };
    $$('.tab').forEach((t) => {
      t.onclick = () => {
        $$('.tab').forEach((x) => x.classList.toggle('is-active', x === t));
        $$('.tab-panel').forEach((p) => p.classList.toggle('is-active', p.dataset.panel === t.dataset.tab));
      };
    });

    // 拖放（桌面）
    const stage = $('.stage');
    ['dragover', 'dragenter'].forEach((ev) => stage.addEventListener(ev, (e) => {
      e.preventDefault(); stage.classList.add('dragging');
    }));
    ['dragleave', 'drop'].forEach((ev) => stage.addEventListener(ev, (e) => {
      e.preventDefault(); stage.classList.remove('dragging');
    }));
    stage.addEventListener('drop', (e) => {
      const files = Array.from(e.dataTransfer.files || []);
      if (!files.length) return;
      const photo = files.find((f) => /^image\//.test(f.type) || /\.tiff?$/i.test(f.name));
      if (photo) pickPhoto(photo);
    });

    // 安装
    let deferred = null;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferred = e;
      $('#installBtn').hidden = false;
    });
    $('#installBtn').onclick = async () => {
      if (!deferred) return;
      deferred.prompt();
      const r = await deferred.userChoice;
      if (r.outcome === 'accepted') $('#installBtn').hidden = true;
      deferred = null;
    };

    const online = () => { $('#netState').textContent = navigator.onLine ? '在线' : '离线可用'; };
    window.addEventListener('online', online);
    window.addEventListener('offline', online);
    online();

    $('#clearCache').onclick = async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      location.reload();
    };

    window.addEventListener('resize', () => setSplit($('#split').value));
  }

  /* ---------------- 启动 ---------------- */
  async function boot() {
    bind();
    setSplit(50);
    await loadLibrary();
    $('#verLine').textContent = 'v1 · ' + new Date().getFullYear();
    if ('serviceWorker' in navigator) {
      try { await navigator.serviceWorker.register('sw.js'); } catch (e) { /* 离线能力在 file:// 下不可用，忽略 */ }
    }
    // 测试钩子
    window.__lcc = {
      state, callWorker, decodeFile, toImageData,
      async buildFromFiles(files, opts) {
        const flats = [];
        for (const f of files) flats.push(await decodeFile(f, 3000000));
        const w = flats[0].w, h = flats[0].h;
        const frames = flats.map((im) => (im.w === w && im.h === h ? im : resizeNearest(im, w, h)));
        return callWorker('profile', { frames, opts: opts || {} });
      },
      async applyTo(img, profile, opts) {
        const copy = img.bits === 8 ? Uint8Array.from(img.data) : Uint16Array.from(img.data);
        return callWorker('apply', { image: { w: img.w, h: img.h, bits: img.bits, data: copy }, profile, opts: opts || {} }, [copy.buffer]);
      },
      async autoFrom(img, opts) {
        const copy = img.bits === 8 ? Uint8Array.from(img.data) : Uint16Array.from(img.data);
        return callWorker('auto', { image: { w: img.w, h: img.h, bits: img.bits, data: copy }, opts: opts || {} });
      },
      encodeTiff16: C.encodeTiff16,
    };
  }
  document.addEventListener('DOMContentLoaded', boot);
})();
