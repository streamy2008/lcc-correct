/* LCC 校正 Worker：建轮廓 / 校正 / 自校准 / 增益预览
 * 与 Python 版算法同源，profile JSON 结构兼容（schema: lenscast-profile/1）
 */
importScripts('lib/math.js');

const M = self.LccMath;

const LIN16 = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    const lin = x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    t[i] = Math.round(lin * 65535);
  }
  return t;
})();

function toLinear16(img) {
  // 统一成 Uint16 线性（0..65535），8bit 走 sRGB 反变换
  const n = img.w * img.h * 3;
  const out = new Uint16Array(n);
  if (img.bits === 8) {
    const d = img.data;
    for (let i = 0; i < n; i++) out[i] = LIN16[d[i]];
  } else {
    out.set(img.data.subarray(0, n));
  }
  return out;
}

function median(a) {
  a.sort((x, y) => x - y);
  const k = a.length;
  return k % 2 ? a[(k - 1) >> 1] : 0.5 * (a[(k >> 1) - 1] + a[k >> 1]);
}

/* ---------------- 建轮廓 ---------------- */
function buildProfile(msg) {
  const frames = msg.frames;           // [{w,h,bits,data}] 已统一尺寸
  const opt = msg.opts || {};
  const W = frames[0].w, H = frames[0].h;
  const N = frames.length;
  const black = (opt.black || [0, 0, 0]).map((v) => v * 65535);
  const block = Math.max(4, opt.block || 32);

  const lin = frames.map(toLinear16);

  // 逐像素跨帧中值（N 通常 3~9，直接排序取中值）
  const F = new Uint16Array(W * H * 3);
  const vals = new Float64Array(N);
  for (let p = 0; p < W * H; p++) {
    for (let c = 0; c < 3; c++) {
      const idx = p * 3 + c;
      for (let k = 0; k < N; k++) vals[k] = lin[k][idx];
      F[idx] = Math.round(median(vals.subarray(0, N)));
    }
  }

  // 扣黑电平 → 中心参考值
  const cx0 = Math.floor(W * 0.42), cx1 = Math.floor(W * 0.58);
  const cy0 = Math.floor(H * 0.42), cy1 = Math.floor(H * 0.58);
  const cv = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const tmp = [];
    for (let y = cy0; y < cy1; y++) for (let x = cx0; x < cx1; x++) tmp.push(F[(y * W + x) * 3 + c] - black[c]);
    cv[c] = Math.max(1, median(tmp));
  }

  // log 场（三通道）
  const logf = [new Float32Array(W * H), new Float32Array(W * H), new Float32Array(W * H)];
  for (let p = 0; p < W * H; p++) {
    for (let c = 0; c < 3; c++) {
      const v = (F[p * 3 + c] - black[c]) / cv[c];
      logf[c][p] = Math.log(Math.max(v, 1e-4));
    }
  }

  // 分块中值 → 粗网格
  const grids = logf.map((f) => M.blockMedian(f, W, H, block));
  const nx = grids[0].nx, ny = grids[0].ny;
  let gR = grids[0].grid, gG = grids[1].grid, gB = grids[2].grid;
  const smooth = opt.smooth || 0;
  if (smooth > 0.35) {
    gR = M.gaussSmooth(gR, nx, ny, smooth);
    gG = M.gaussSmooth(gG, nx, ny, smooth);
    gB = M.gaussSmooth(gB, nx, ny, smooth);
  }

  // 光轴 = 平场最亮处（log 最大）
  const meanField = new Float32Array(nx * ny);
  for (let i = 0; i < nx * ny; i++) meanField[i] = (gR[i] + gG[i] + gB[i]) / 3;
  let best = -Infinity, bi = 0;
  for (let i = 0; i < meanField.length; i++) if (meanField[i] > best) { best = meanField[i]; bi = i; }
  const bx = bi % nx, by = (bi / nx) | 0;
  const axX = M.blockAxis(nx, W, block), axY = M.blockAxis(ny, H, block);
  let cx = axX[bx], cy = axY[by];
  // 抛物线亚网格修正
  if (bx > 0 && bx < nx - 1) {
    const a = meanField[by * nx + bx - 1], b = meanField[by * nx + bx], c = meanField[by * nx + bx + 1];
    const den = a - 2 * b + c;
    if (Math.abs(den) > 1e-9) cx += Math.max(-0.5, Math.min(0.5, -0.5 * (a - c) / den)) * block;
  }
  if (by > 0 && by < ny - 1) {
    const a = meanField[(by - 1) * nx + bx], b = meanField[by * nx + bx], c = meanField[(by + 1) * nx + bx];
    const den = a - 2 * b + c;
    if (Math.abs(den) > 1e-9) cy += Math.max(-0.5, Math.min(0.5, -0.5 * (a - c) / den)) * block;
  }

  const sx = W / 2, sy = H / 2;
  const model = opt.model === 'grid' ? 'grid' : 'poly';
  const deg = Math.max(2, Math.min(6, opt.deg || 4));
  const terms = M.polyTerms(deg);

  let profile;
  if (model === 'grid') {
    const flat = new Float32Array(nx * ny * 3);
    for (let i = 0; i < nx * ny; i++) { flat[i * 3] = gR[i]; flat[i * 3 + 1] = gG[i]; flat[i * 3 + 2] = gB[i]; }
    profile = {
      schema: 'lenscast-profile/1', created: new Date().toISOString(), label: opt.label || '',
      image_size: [W, H], black: (opt.black || [0, 0, 0]), gain_max: opt.gainMax || 6,
      model: 'grid', center: [cx, cy], scale: [sx, sy], grid_shape: [ny, nx],
      log_gain_flat: Array.from(flat),
    };
  } else {
    const pts = [];
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const i = y * nx + x;
        pts.push({ u: (axX[x] - cx) / sx, v: (axY[y] - cy) / sy, y: [gR[i], gG[i], gB[i]] });
      }
    }
    const coef = M.fitPoly(pts, terms, 3);
    if (!coef) throw new Error('拟合失败：有效块太少，请拍更均匀的平场');
    // 只平移常数项，让中心增益 = 1
    const eval0 = M.evalPoly(coef, terms, 0, 0);
    for (let c = 0; c < 3; c++) coef[c] -= eval0[c];
    profile = {
      schema: 'lenscast-profile/1', created: new Date().toISOString(), label: opt.label || '',
      image_size: [W, H], black: (opt.black || [0, 0, 0]), gain_max: opt.gainMax || 6,
      model: 'poly', deg, terms, coeffs: Array.from(coef),
      center: [cx, cy], scale: [sx, sy],
    };
  }

  // 统计：角落增益
  const gm = M.gainMap(profile, 160, 120);
  let gmax = 0, gmin = Infinity;
  for (let i = 0; i < gm.length; i++) { if (gm[i] > gmax) gmax = gm[i]; if (gm[i] < gmin) gmin = gm[i]; }
  const corner = (px, py) => {
    const o = (py * 160 + px) * 3;
    return [gm[o], gm[o + 1], gm[o + 2]];
  };
  return {
    ok: true, profile,
    report: {
      model: profile.model, deg: profile.deg || null, center: [Math.round(cx), Math.round(cy)],
      grid: [nx, ny], frames: N, gain_min: gmin, gain_max: gmax,
      corners: { tl: corner(2, 2), tr: corner(157, 2), bl: corner(2, 117), br: corner(157, 117) },
      center_values: cv.map((v) => v / 65535),
    },
  };
}

/* ---------------- 应用校正 ---------------- */
function applyProfile(msg) {
  const { w: W, h: H, bits, data } = msg.image;
  const profile = msg.profile;
  const opt = msg.opts || {};
  const gainRes = Math.max(200, opt.gainRes || 1200);
  const scale = Math.min(1, gainRes / Math.max(W, H));
  const gw = Math.max(8, Math.round(W * scale)), gh = Math.max(8, Math.round(H * scale));

  let gm = M.gainMap(profile, gw, gh);

  if (opt.chromaOnly) {
    // 只校色度：把三通道增益归一化到亮度增益，亮度保持 1
    gm = Float32Array.from(gm);
    for (let i = 0; i < gw * gh; i++) {
      const o = i * 3;
      const lum = 0.2126 * gm[o] + 0.7152 * gm[o + 1] + 0.0722 * gm[o + 2];
      if (lum > 1e-6) {
        gm[o] /= lum; gm[o + 1] /= lum; gm[o + 2] /= lum;
      }
    }
  }

  // 曝光保持：先在缩略图上估算中位亮度比
  let expo = 1;
  if ((opt.exposure || 'preserve') === 'preserve') {
    const stride = Math.max(1, Math.floor(Math.sqrt((W * H) / 200000)));
    let before = [], after = [];
    const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
    for (let y = 0; y < H; y += stride) {
      for (let x = 0; x < W; x += stride) {
        const px = (y * W + x) * 3;
        const gx = Math.min(gw - 1, Math.round(x * gw / W));
        const gy = Math.min(gh - 1, Math.round(y * gh / H));
        const go = (gy * gw + gx) * 3;
        let r, g, b;
        if (bits === 8) { r = M.LIN[data[px]]; g = M.LIN[data[px + 1]]; b = M.LIN[data[px + 2]]; }
        else { r = data[px] / 65535; g = data[px + 1] / 65535; b = data[px + 2] / 65535; }
        before.push(luma(r, g, b));
        after.push(luma(Math.min(1, r * gm[go]), Math.min(1, g * gm[go + 1]), Math.min(1, b * gm[go + 2])));
      }
    }
    before.sort((a, b) => a - b); after.sort((a, b) => a - b);
    const mb = before[before.length >> 1], ma = after[after.length >> 1];
    if (ma > 1e-6) expo = mb / ma;
  }

  // 输出统一用 16bit 线性：预览端再编码成 sRGB，导出 TIFF 直接可用，避免「sRGB 当线性」的色阶灾难
  const outBits = opt.outBits || 16;
  const out = outBits === 8 ? new Uint8Array(W * H * 3) : new Uint16Array(W * H * 3);
  const strip = 256;
  let clipped = 0;
  // 变化量统计（用 8bit sRGB 域，和肉眼看的一致）
  let dSum = 0, dMax = 0, dN = 0;
  const cw = Math.max(4, Math.round(W * 0.1)), chh = Math.max(4, Math.round(H * 0.1));
  let cSum = 0, cN = 0;
  for (let y0 = 0; y0 < H; y0 += strip) {
    const y1 = Math.min(H, y0 + strip);
    const gains = M.stripGains(gm, gw, gh, W, H, y0, y1);
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < W; x++) {
        const p = (y * W + x) * 3, q = ((y - y0) * W + x) * 3;
        const gr = gains[q] * expo, gg = gains[q + 1] * expo, gb = gains[q + 2] * expo;
        let r, g, b;
        if (bits === 8) {
          r = M.LIN[data[p]] * gr; g = M.LIN[data[p + 1]] * gg; b = M.LIN[data[p + 2]] * gb;
        } else {
          r = (data[p] / 65535) * gr; g = (data[p + 1] / 65535) * gg; b = (data[p + 2] / 65535) * gb;
        }
        if (r >= 1 || g >= 1 || b >= 1) clipped++;
        // 变化量：每 3 个像素采一次，够代表整幅
        if (((y * W + x) % 3) === 0) {
          let br, bg, bb;
          if (bits === 8) { br = data[p] / 255; bg = data[p + 1] / 255; bb = data[p + 2] / 255; }
          else { br = data[p] / 65535; bg = data[p + 1] / 65535; bb = data[p + 2] / 65535; }
          const or_ = M.srgb8(r), og = M.srgb8(g), ob = M.srgb8(b);
          const od = Math.abs(or_ - M.srgb8(br)) + Math.abs(og - M.srgb8(bg)) + Math.abs(ob - M.srgb8(bb));
          const d = od / 3;
          dSum += d; dN++;
          if (d > dMax) dMax = d;
          const inCorner = (x < cw || x >= W - cw) && (y < chh || y >= H - chh);
          if (inCorner) { cSum += d; cN++; }
        }
        if (outBits === 8) {
          out[p] = M.srgb8(r); out[p + 1] = M.srgb8(g); out[p + 2] = M.srgb8(b);
        } else {
          out[p] = Math.min(65535, Math.round(Math.min(r, 1) * 65535));
          out[p + 1] = Math.min(65535, Math.round(Math.min(g, 1) * 65535));
          out[p + 2] = Math.min(65535, Math.round(Math.min(b, 1) * 65535));
        }
      }
    }
  }
  return { ok: true, image: { w: W, h: H, bits: outBits, data: out },
           report: { exposure: expo, clipped, gainRes: [gw, gh], outBits,
                     change: { mean: dN ? dSum / dN : 0, max: dMax, corner: cN ? cSum / cN : 0 } } };
}

/* ---------------- 无平场：自估色度渐变 ---------------- */
function autoProfile(msg) {
  const { w: W, h: H, bits, data } = msg.image;
  const opt = msg.opts || {};
  const deg = Math.max(2, Math.min(5, opt.deg || 3));
  const maxCorr = opt.maxCorr || 0.7;
  const block = 64;
  const nx = Math.ceil(W / block), ny = Math.ceil(H / block);
  const pts = [];
  const tmp = new Float64Array(block * block);

  for (let by = 0; by < ny; by++) {
    for (let bx = 0; bx < nx; bx++) {
      const x0 = bx * block, y0 = by * block;
      const x1 = Math.min(W, x0 + block), y1 = Math.min(H, y0 + block);
      // 块内中值（三通道）与粗糙梯度（与块中值偏差的均值）
      const med = [0, 0, 0], dev = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        let k = 0;
        for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
          const p = (y * W + x) * 3 + c;
          const v = bits === 8 ? M.LIN[data[p]] : data[p] / 65535;
          tmp[k++] = v;
        }
        const arr = tmp.subarray(0, k);
        arr.sort();
        const m = arr[k >> 1];
        med[c] = m;
        let s = 0; for (let i = 0; i < k; i++) s += Math.abs(arr[i] - m);
        dev[c] = s / Math.max(1, k);
      }
      const g = med[0] + med[1] + med[2];
      if (g < 0.06 || g > 2.90) continue;              // 太暗/过曝
      if (dev[1] > 0.06) continue;                     // 纹理太多
      const u = ((x0 + x1) / 2 - W / 2) / (W / 2);
      const v = ((y0 + y1) / 2 - H / 2) / (H / 2);
      pts.push({ u, v, y: [Math.log(Math.max(med[0], 1e-4) / Math.max(med[1], 1e-4)),
                            0,
                            Math.log(Math.max(med[2], 1e-4) / Math.max(med[1], 1e-4))] });
    }
  }
  if (pts.length < 40) throw new Error('可用于自校准的平坦块太少：换一张更均匀的照片（天空/墙面）');

  const terms = M.polyTerms(deg);
  const coef = M.fitPoly(pts, terms, 3);
  // 只取 R/B 的色度场，且限幅
  for (let k = 0; k < terms.length; k++) {
    for (let c = 0; c < 3; c++) {
      const idx = k * 3 + c;
      let val = c === 1 ? 0 : -coef[idx];
      if (c !== 1) val = Math.max(-maxCorr, Math.min(maxCorr, val));
      coef[idx] = val;
    }
  }
  const e0 = M.evalPoly(coef, terms, 0, 0);
  for (let c = 0; c < 3; c++) coef[c] -= e0[c];

  const profile = {
    schema: 'lenscast-profile/1', created: new Date().toISOString(),
    label: opt.label || 'scene-auto', image_size: [W, H], black: [0, 0, 0],
    gain_max: Math.exp(maxCorr), model: 'poly', deg, terms, coeffs: Array.from(coef),
    center: [W / 2, H / 2], scale: [W / 2, H / 2],
  };
  return { ok: true, profile, report: { validBlocks: pts.length, deg, maxCorr } };
}

/* ---------------- 增益预览图 ---------------- */
function gainPreview(msg) {
  const profile = msg.profile;
  const w = msg.w || 480, h = msg.h || 320;
  const gm = M.gainMap(profile, w, h);
  // 每通道按 2%/98% 拉伸，输出 RGBA
  const out = new Uint8ClampedArray(w * h * 4);
  for (let c = 0; c < 3; c++) {
    const vals = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) vals[i] = gm[i * 3 + c];
    const sorted = Float32Array.from(vals).sort();
    const lo = sorted[Math.floor(sorted.length * 0.02)];
    const hi = sorted[Math.floor(sorted.length * 0.98)];
    for (let i = 0; i < w * h; i++) {
      const t = hi - lo < 1e-6 ? 0.5 : (vals[i] - lo) / (hi - lo);
      out[i * 4 + c] = Math.round(255 * Math.pow(t, 0.8));
    }
  }
  for (let i = 0; i < w * h; i++) out[i * 4 + 3] = 255;
  return { ok: true, image: { w, h, rgba: out } };
}

self.onmessage = async (e) => {
  const { id, cmd, payload } = e.data;
  try {
    let res;
    if (cmd === 'profile') res = buildProfile(payload);
    else if (cmd === 'apply') res = applyProfile(payload);
    else if (cmd === 'auto') res = autoProfile(payload);
    else if (cmd === 'gainpreview') res = gainPreview(payload);
    else throw new Error('未知命令 ' + cmd);
    self.postMessage({ id, ...res }, transferOf(res));
  } catch (err) {
    self.postMessage({ id, ok: false, error: err && err.message ? err.message : String(err) });
  }
};

function transferOf(res) {
  const t = [];
  if (res && res.image && res.image.data) t.push(res.image.data.buffer);
  if (res && res.image && res.image.rgba) t.push(res.image.rgba.buffer);
  return t;
}
