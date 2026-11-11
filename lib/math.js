/* LccMath — 色偏/暗角校正的纯数学层。
 * 同时被 Worker（importScripts）与主线程（<script>）使用，挂在 self.LccMath 上。
 *
 * 约定：
 *   - 单通道场用 Float32Array，长度 w*h，行优先。
 *   - 增益图用 Float32Array，长度 w*h*3，交错 RGB。
 *   - 坐标归一化：u=(x-cx)/sx, v=(y-cy)/sy。
 */
(function (root) {
  'use strict';

  /* ---------- sRGB ---------- */
  const LIN = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    LIN[i] = x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  }
  // 线性 → sRGB8 的查表（4096 档，足够 8bit 输出且比 Math.pow 快很多）
  const S8 = new Uint8Array(4097);
  for (let i = 0; i <= 4096; i++) {
    const x = i / 4096;
    const s = x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
    S8[i] = Math.max(0, Math.min(255, Math.round(s * 255)));
  }
  function srgb8(lin) {
    if (lin <= 0) return 0;
    if (lin >= 1) return 255;
    return S8[(lin * 4096) | 0];
  }

  /* ---------- 多项式基 ---------- */
  function polyTerms(deg) {
    const t = [];
    for (let i = 0; i <= deg; i++) for (let j = 0; j <= deg - i; j++) t.push([i, j]);
    return t;
  }

  function evalPoly(coef, terms, u, v) {
    // coef: terms.length × 3 (列存)，返回 [r,g,b]
    let r = 0, g = 0, b = 0;
    for (let k = 0; k < terms.length; k++) {
      const t = Math.pow(u, terms[k][0]) * Math.pow(v, terms[k][1]);
      r += coef[k * 3] * t;
      g += coef[k * 3 + 1] * t;
      b += coef[k * 3 + 2] * t;
    }
    return [r, g, b];
  }

  /* ---------- 高斯消元（部分主元） ---------- */
  function solve(A, b, n) {
    // A: n*n 行优先（会被修改），b: n
    for (let col = 0; col < n; col++) {
      let piv = col, best = Math.abs(A[col * n + col]);
      for (let r = col + 1; r < n; r++) {
        const v = Math.abs(A[r * n + col]);
        if (v > best) { best = v; piv = r; }
      }
      if (best < 1e-14) return null;
      if (piv !== col) {
        for (let c = col; c < n; c++) {
          const tmp = A[col * n + c]; A[col * n + c] = A[piv * n + c]; A[piv * n + c] = tmp;
        }
        const tb = b[col]; b[col] = b[piv]; b[piv] = tb;
      }
      const d = A[col * n + col];
      for (let r = col + 1; r < n; r++) {
        const f = A[r * n + col] / d;
        if (f === 0) continue;
        for (let c = col; c < n; c++) A[r * n + c] -= f * A[col * n + c];
        b[r] -= f * b[col];
      }
    }
    const x = new Float64Array(n);
    for (let r = n - 1; r >= 0; r--) {
      let s = b[r];
      for (let c = r + 1; c < n; c++) s -= A[r * n + c] * x[c];
      x[r] = s / A[r * n + r];
    }
    return x;
  }

  /* ---------- 稳健多项式拟合（IRLS, Cauchy 权重） ----------
   * pts: 采样点 {u,v,y:[r,g,b]}；返回 Float32Array(terms*3) 与残差尺度 */
  function fitPoly(pts, terms, iters) {
    const n = terms.length;
    const m = pts.length;
    const AtA = new Float64Array(n * n);
    const Atb = new Float64Array(n * 3);
    const w = new Float64Array(m).fill(1);
    let coef = null, resid = null;

    const build = () => {
      AtA.fill(0); Atb.fill(0);
      for (let p = 0; p < m; p++) {
        const u = pts[p].u, v = pts[p].v, wp = w[p];
        const basis = new Float64Array(n);
        for (let k = 0; k < n; k++) basis[k] = Math.pow(u, terms[k][0]) * Math.pow(v, terms[k][1]);
        for (let a = 0; a < n; a++) {
          const wa = basis[a] * wp;
          for (let b = a; b < n; b++) AtA[a * n + b] += wa * basis[b];
          const y = pts[p].y;
          Atb[a * 3] += wa * y[0];
          Atb[a * 3 + 1] += wa * y[1];
          Atb[a * 3 + 2] += wa * y[2];
        }
      }
      for (let a = 0; a < n; a++) for (let b = 0; b < a; b++) AtA[a * n + b] = AtA[b * n + a];
    };

    for (let it = 0; it < iters; it++) {
      build();
      const cols = [];
      for (let c = 0; c < 3; c++) {
        const A = Float64Array.from(AtA);
        const b = new Float64Array(n);
        for (let k = 0; k < n; k++) b[k] = Atb[k * 3 + c];
        const sol = solve(A, b, n);
        if (!sol) return null;
        cols.push(sol);
      }
      coef = new Float64Array(n * 3);
      for (let k = 0; k < n; k++) for (let c = 0; c < 3; c++) coef[k * 3 + c] = cols[c][k];

      // 残差 → 权重
      resid = new Float64Array(m);
      for (let p = 0; p < m; p++) {
        let e = 0;
        for (let c = 0; c < 3; c++) {
          const f = evalPoly(coef, terms, pts[p].u, pts[p].v)[c];
          const d = pts[p].y[c] - f;
          e += d * d;
        }
        resid[p] = Math.sqrt(e);
      }
      const sorted = Float64Array.from(resid).sort();
      const med = sorted[sorted.length >> 1];
      const mad = sorted[Math.floor(sorted.length * 0.75)] || 1e-6;
      const s = Math.max(1.4826 * Math.abs(mad - med), 1e-3);
      let changed = false;
      for (let p = 0; p < m; p++) {
        const nw = 1 / (1 + Math.pow(resid[p] / (2.5 * s), 2));
        if (Math.abs(nw - w[p]) > 1e-3) changed = true;
        w[p] = nw;
      }
      if (!changed) break;
    }
    return coef;
  }

  /* ---------- 分块中值（返回网格，未做 padding 偏差修正） ---------- */
  function blockMedian(field, w, h, block) {
    const nx = Math.ceil(w / block), ny = Math.ceil(h / block);
    const out = new Float32Array(nx * ny);
    const buf = [];
    for (let by = 0; by < ny; by++) {
      const y0 = by * block, y1 = Math.min(h, y0 + block);
      for (let bx = 0; bx < nx; bx++) {
        const x0 = bx * block, x1 = Math.min(w, x0 + block);
        buf.length = 0;
        for (let y = y0; y < y1; y++) {
          const row = y * w;
          for (let x = x0; x < x1; x++) buf.push(field[row + x]);
        }
        buf.sort((a, b) => a - b);
        out[by * nx + bx] = buf[buf.length >> 1];
      }
    }
    return { grid: out, nx, ny };
  }

  /* 块中心坐标：与 Python 版一致，按 block 中心算，不能按 H/ny 均分 */
  function blockAxis(n, size, block) {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = Math.min((i + 0.5) * block, size - 0.5);
    return a;
  }

  /* ---------- 粗网格高斯平滑（边界 edge 延拓） ---------- */
  function gaussSmooth(field, w, h, sigma) {
    if (!sigma || sigma <= 0.35) return Float32Array.from(field);
    const r = Math.max(1, Math.round(3 * sigma));
    const k = [];
    let sum = 0;
    for (let i = -r; i <= r; i++) { const v = Math.exp(-0.5 * (i / sigma) ** 2); k.push(v); sum += v; }
    for (let i = 0; i < k.length; i++) k[i] /= sum;

    const tmp = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let i = -r; i <= r; i++) {
          const xx = Math.min(w - 1, Math.max(0, x + i));
          acc += k[i + r] * field[row + xx];
        }
        tmp[row + x] = acc;
      }
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let i = -r; i <= r; i++) {
          const yy = Math.min(h - 1, Math.max(0, y + i));
          acc += k[i + r] * tmp[yy * w + x];
        }
        out[y * w + x] = acc;
      }
    }
    return out;
  }

  /* ---------- 双线性插值权重 ---------- */
  function interpWeights(nOut, nIn) {
    const i0 = new Int32Array(nOut), i1 = new Int32Array(nOut), w = new Float32Array(nOut);
    for (let i = 0; i < nOut; i++) {
      let pos = (i + 0.5) * (nIn / nOut) - 0.5;
      if (pos < 0) pos = 0;
      const max = nIn - 1;
      if (pos > max) pos = max;
      const a = Math.floor(pos);
      i0[i] = a;
      i1[i] = Math.min(a + 1, max);
      w[i] = pos - a;
    }
    return { i0, i1, w };
  }

  /* ---------- profile 求值：在 gw×gh 网格上生成增益图 ---------- */
  function gainMap(profile, gw, gh) {
    const W = profile.image_size[0], H = profile.image_size[1];
    const [cx, cy] = profile.center;
    const [sx, sy] = profile.scale;
    const out = new Float32Array(gw * gh * 3);
    const model = profile.model;
    if (model === 'grid') {
      const g = profile.log_gain_flat; // Float32Array nx*ny*3
      const nx = profile.grid_shape[1], ny = profile.grid_shape[0];
      const wx = interpWeights(gw, nx), wy = interpWeights(gh, ny);
      for (let y = 0; y < gh; y++) {
        const y0 = wy.i0[y], y1 = wy.i1[y], wyy = wy.w[y];
        for (let x = 0; x < gw; x++) {
          const x0 = wx.i0[x], x1 = wx.i1[x], wxx = wx.w[x];
          for (let c = 0; c < 3; c++) {
            const v00 = g[(y0 * nx + x0) * 3 + c], v01 = g[(y0 * nx + x1) * 3 + c];
            const v10 = g[(y1 * nx + x0) * 3 + c], v11 = g[(y1 * nx + x1) * 3 + c];
            const top = v00 * (1 - wxx) + v01 * wxx;
            const bot = v10 * (1 - wxx) + v11 * wxx;
            out[(y * gw + x) * 3 + c] = top * (1 - wyy) + bot * wyy;
          }
        }
      }
    } else {
      const terms = profile.terms;
      const coef = profile.coeffs; // 扁平 terms*3
      const radial = model === 'radial';
      for (let y = 0; y < gh; y++) {
        const py = ((y + 0.5) * (H / gh) - cy) / sy;
        for (let x = 0; x < gw; x++) {
          const px = ((x + 0.5) * (W / gw) - cx) / sx;
          const u = radial ? Math.sqrt(px * px + py * py) : px;
          const v = radial ? 0 : py;
          const lg = evalPoly(coef, terms, u, v);
          const o = (y * gw + x) * 3;
          for (let c = 0; c < 3; c++) out[o + c] = Math.exp(-lg[c]);
        }
      }
    }
    // 上限 + 归一化
    const gmax = profile.gain_max || 6;
    let sum = 0, cnt = 0;
    for (let i = 0; i < out.length; i++) {
      if (out[i] > gmax) out[i] = gmax;
      sum += out[i]; cnt++;
    }
    const mean = sum / cnt;
    if (mean > 1e-6) for (let i = 0; i < out.length; i++) out[i] /= mean;
    return out;
  }

  /* ---------- 从增益图取某一行带的增益（双线性） ---------- */
  function stripGains(gm, gw, gh, W, H, y0, y1) {
    const n = y1 - y0;
    const out = new Float32Array(n * W * 3);
    const wy = interpWeights(H, gh), wx = interpWeights(W, gw);
    for (let yy = 0; yy < n; yy++) {
      const y = y0 + yy;
      const gy0 = wy.i0[y], gy1 = wy.i1[y], wyy = wy.w[y];
      for (let x = 0; x < W; x++) {
        const gx0 = wx.i0[x], gx1 = wx.i1[x], wxx = wx.w[x];
        const o = (yy * W + x) * 3;
        for (let c = 0; c < 3; c++) {
          const v00 = gm[(gy0 * gw + gx0) * 3 + c], v01 = gm[(gy0 * gw + gx1) * 3 + c];
          const v10 = gm[(gy1 * gw + gx0) * 3 + c], v11 = gm[(gy1 * gw + gx1) * 3 + c];
          const top = v00 * (1 - wxx) + v01 * wxx;
          const bot = v10 * (1 - wxx) + v11 * wxx;
          out[o + c] = top * (1 - wyy) + bot * wyy;
        }
      }
    }
    return out;
  }

  root.LccMath = {
    polyTerms, evalPoly, fitPoly, blockMedian, blockAxis, gaussSmooth,
    interpWeights, gainMap, stripGains, solve, srgb8, LIN,
  };
})(typeof self !== 'undefined' ? self : this);
