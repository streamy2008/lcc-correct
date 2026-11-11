/* LccCodec — 图像编解码：JPEG/PNG/WebP（浏览器原生）+ 16bit TIFF（自实现，无依赖）
 *
 * 支持读取：未压缩（1）与 Deflate/ZIP（8, 32946）的 TIFF，8/16bit，RGB 或 RGBA（丢弃 alpha），
 *           PlanarConfiguration=1（交错）。LZW / PackBits 暂不支持，会明确报错而不是静默出错。
 * 支持写出：未压缩 16bit RGB TIFF（单文件、多 strip，浏览器里可直接 Blob 存盘）。
 */
(function (root) {
  'use strict';

  function u8ToDataView(buf) { return new DataView(buf); }

  /* 判断是否为 TIFF（II*\0 或 MM\0*） */
  function isTiff(bytes) {
    if (bytes.length < 4) return false;
    const i0 = bytes[0], i1 = bytes[1], i2 = bytes[2], i3 = bytes[3];
    return (i0 === 0x49 && i1 === 0x49 && i2 === 42) || (i0 === 0x4d && i1 === 0x4d && i2 === 0 && i3 === 42);
  }

  async function inflate(u8, kind) {
    // kind: 'deflate'(zlib) | 'deflate-raw'
    const ds = new DecompressionStream(kind || 'deflate');
    const stream = new Blob([u8]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /* ---------- TIFF 解码 ---------- */
  async function decodeTiff(buf) {
    const dv = new DataView(buf);
    const little = dv.getUint16(0, true) === 0x4949;
    const rd16 = (o) => dv.getUint16(o, little);
    const rd32 = (o) => dv.getUint32(o, little);
    if (rd16(2) !== 42) throw new Error('不是 TIFF 文件（magic 不是 42）');
    let ifd = rd32(4);

    const tags = {};
    const typeSize = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8 };
    const n = rd16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      const tag = rd16(e), type = rd16(e + 2), count = rd32(e + 4);
      const tsz = typeSize[type] || 1;
      const total = tsz * count;
      const valOff = total <= 4 ? e + 8 : rd32(e + 8);
      const vals = [];
      for (let k = 0; k < count; k++) {
        const p = valOff + k * tsz;
        if (type === 3) vals.push(rd16(p));
        else if (type === 4) vals.push(rd32(p));
        else if (type === 1) vals.push(dv.getUint8(p));
        else if (type === 2) vals.push(dv.getUint8(p));
        else if (type === 5) vals.push(rd32(p) / (rd32(p + 4) || 1));
        else if (type === 11) vals.push(dv.getFloat32(p, little));
        else vals.push(rd32(p));
      }
      tags[tag] = vals.length === 1 ? vals[0] : vals;
    }

    const W = tags[256], H = tags[257];
    if (!W || !H) throw new Error('TIFF 缺少 ImageWidth/ImageLength');
    let bps = tags[258] || 8;
    if (Array.isArray(bps)) {
      // 多 sample 时取第一个；不同位深混排不支持
      if (bps.some((v) => v !== bps[0])) throw new Error('TIFF 各通道位深不一致，暂不支持');
      bps = bps[0];
    }
    const spp = tags[277] || (Array.isArray(tags[258]) ? tags[258].length : 3);
    const comp = tags[259] || 1;
    const photo = tags[262] ?? 2;
    const planar = tags[284] || 1;
    const rowsPerStrip = tags[278] || H;
    let stripOffsets = tags[273];
    let stripCounts = tags[279];
    if (!Array.isArray(stripOffsets)) stripOffsets = [stripOffsets];
    if (!Array.isArray(stripCounts)) stripCounts = [stripCounts];

    if (photo !== 2) throw new Error(`只支持 RGB 照片（PhotometricInterpretation=${photo}）`);
    if (planar !== 1) throw new Error('只支持 PlanarConfiguration=1（交错）的 TIFF');
    if (comp !== 1 && comp !== 8 && comp !== 32946) {
      throw new Error(`该 TIFF 的压缩方式（${comp}）暂不支持；请在 Phocus/Capture One 里导出「未压缩」或「ZIP」TIFF`);
    }
    if (bps !== 8 && bps !== 16) throw new Error(`只支持 8/16bit TIFF，当前为 ${bps}bit`);

    const bytesPerSample = bps / 8;
    const rowBytes = W * spp * bytesPerSample;
    const outCh = Math.min(spp, 3);
    const data = bps === 8 ? new Uint8Array(W * H * 3) : new Uint16Array(W * H * 3);

    let row = 0;
    for (let s = 0; s < stripOffsets.length; s++) {
      let raw = new Uint8Array(buf, stripOffsets[s], stripCounts[s]);
      if (comp !== 1) raw = await inflate(raw, 'deflate');
      const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      const rows = Math.min(rowsPerStrip, H - row);
      for (let r = 0; r < rows; r++) {
        const srcBase = r * rowBytes;
        const dstBase = (row + r) * W * 3;
        for (let x = 0; x < W; x++) {
          for (let c = 0; c < outCh; c++) {
            const idx = (x * spp + c) * bytesPerSample;
            data[dstBase + x * 3 + c] = bps === 8 ? raw[srcBase + idx]
              : view.getUint16(srcBase + idx, little);
          }
        }
      }
      row += rows;
    }
    return { w: W, h: H, bits: bps, data, channels: 3 };
  }

  /* ---------- TIFF 编码（未压缩 16bit RGB） ---------- */
  function encodeTiff16(w, h, rgb16) {
    // 每 strip 目标约 4MB，避免单个 Blob part 过大
    const ROWS_PER_STRIP = Math.max(1, Math.min(h, Math.floor((4 * 1024 * 1024) / (w * 6))));
    const strips = Math.ceil(h / ROWS_PER_STRIP);
    const rowsOf = [];
    let payload = 0;
    for (let s = 0; s < strips; s++) {
      const rows = Math.min(ROWS_PER_STRIP, h - s * ROWS_PER_STRIP);
      rowsOf.push(rows);
      payload += rows * w * 6;
    }
    const headerSize = 8;
    const bpsOffset = headerSize;                 // SHORT ×3 = 6B，放不进 4B 值域 → 用偏移
    const needOffsetsArray = strips > 1;
    const offOffset = bpsOffset + 6;
    const cntOffset = needOffsetsArray ? offOffset + strips * 4 : offOffset;
    const ifdOffset = needOffsetsArray ? cntOffset + strips * 4 : offOffset + 4;
    const nTags = 11;
    const ifdSize = 2 + 12 * nTags + 4;
    const stripDataStart = ifdOffset + ifdSize;
    const total = stripDataStart + payload;

    const buf = new ArrayBuffer(total);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    u8[0] = 0x49; u8[1] = 0x49; dv.setUint16(2, 42, true); dv.setUint32(4, ifdOffset, true);

    dv.setUint16(bpsOffset, 16, true);
    dv.setUint16(bpsOffset + 2, 16, true);
    dv.setUint16(bpsOffset + 4, 16, true);

    const stripOffsets = new Array(strips);
    let cursor0 = stripDataStart;
    for (let s = 0; s < strips; s++) {
      stripOffsets[s] = cursor0;
      cursor0 += rowsOf[s] * w * 6;
    }
    if (needOffsetsArray) {
      for (let s = 0; s < strips; s++) {
        dv.setUint32(offOffset + s * 4, stripOffsets[s], true);
        dv.setUint32(cntOffset + s * 4, rowsOf[s] * w * 6, true);
      }
    } else {
      // 只有一条 strip：值必须内联，指向数组会被解码器判成 bogus
      dv.setUint32(offOffset, stripOffsets[0], true);
    }

    const inline = (type, count, value) => ({ type, count, value, inlineVal: (count * (type === 3 ? 2 : 4) <= 4) });
    const entries = [
      inline(4, 1, w), inline(4, 1, h), inline(3, 3, bpsOffset), inline(3, 1, 1),
      inline(3, 1, 2),
      needOffsetsArray ? inline(4, strips, offOffset) : inline(4, 1, stripOffsets[0]),
      inline(3, 1, 3), inline(4, 1, ROWS_PER_STRIP),
      needOffsetsArray ? inline(4, strips, cntOffset) : inline(4, 1, rowsOf[0] * w * 6),
      inline(3, 1, 1), inline(3, 1, 1),   // PlanarConfiguration=1, SampleFormat=1(UINT)
    ];
    dv.setUint16(ifdOffset, entries.length, true);
    entries.forEach((e, i) => {
      const p = ifdOffset + 2 + i * 12;
      dv.setUint16(p, [256, 257, 258, 259, 262, 273, 277, 278, 279, 284, 339][i], true);
      dv.setUint16(p + 2, e.type, true);
      dv.setUint32(p + 4, e.count, true);
      if (e.type === 3 && e.count === 1) dv.setUint16(p + 8, e.value, true);
      else dv.setUint32(p + 8, e.value, true);
    });
    dv.setUint32(ifdOffset + 2 + 12 * entries.length, 0, true);

    let cursor = stripDataStart;
    for (let s = 0; s < strips; s++) {
      const y0 = s * ROWS_PER_STRIP;
      for (let r = 0; r < rowsOf[s]; r++) {
        const base = ((y0 + r) * w) * 3;
        for (let x = 0; x < w; x++) {
          const i = base + x * 3;
          dv.setUint16(cursor, rgb16[i], true);
          dv.setUint16(cursor + 2, rgb16[i + 1], true);
          dv.setUint16(cursor + 4, rgb16[i + 2], true);
          cursor += 6;
        }
      }
    }
    return new Blob([buf], { type: 'image/tiff' });
  }

  /* ---------- 通用图像解码（浏览器原生） ---------- */
  async function decodeImage(file, maxPixels) {
    if (file.type === 'image/tiff' || /\.tiff?$/i.test(file.name)) {
      const buf = await file.arrayBuffer();
      if (isTiff(new Uint8Array(buf))) {
        const img = await decodeTiff(buf);
        return maybeDownscale(img, maxPixels, file.name);
      }
      throw new Error('这个 .tif 文件不是标准 TIFF（可能是 RAW 包装），请在 Phocus 里导出 16bit TIFF');
    }
    const bmp = await createImageBitmap(file);
    let { width: w, height: h } = bmp;
    let scale = 1;
    if (maxPixels && w * h > maxPixels) scale = Math.sqrt(maxPixels / (w * h));
    const dw = Math.max(1, Math.round(w * scale)), dh = Math.max(1, Math.round(h * scale));
    const cv = (typeof OffscreenCanvas !== 'undefined')
      ? new OffscreenCanvas(dw, dh)
      : Object.assign(document.createElement('canvas'), { width: dw, height: dh });
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, dw, dh);
    bmp.close && bmp.close();
    const im = ctx.getImageData(0, 0, dw, dh);
    const rgb = new Uint8Array(dw * dh * 3);
    const d = im.data;
    for (let i = 0, j = 0; i < d.length; i += 4, j += 3) {
      rgb[j] = d[i]; rgb[j + 1] = d[i + 1]; rgb[j + 2] = d[i + 2];
    }
    return { w: dw, h: dh, bits: 8, data: rgb, channels: 3, origW: w, origH: h, name: file.name };
  }

  function maybeDownscale(img, maxPixels, name) {
    if (!maxPixels || img.w * img.h <= maxPixels) return Object.assign(img, { origW: img.w, origH: img.h, name });
    const scale = Math.sqrt(maxPixels / (img.w * img.h));
    const dw = Math.max(1, Math.round(img.w * scale)), dh = Math.max(1, Math.round(img.h * scale));
    const src = img.data;
    const dst = img.bits === 8 ? new Uint8Array(dw * dh * 3) : new Uint16Array(dw * dh * 3);
    for (let y = 0; y < dh; y++) {
      const sy = Math.min(img.h - 1, Math.round((y + 0.5) / scale - 0.5));
      for (let x = 0; x < dw; x++) {
        const sx = Math.min(img.w - 1, Math.round((x + 0.5) / scale - 0.5));
        const si = (sy * img.w + sx) * 3, di = (y * dw + x) * 3;
        dst[di] = src[si]; dst[di + 1] = src[si + 1]; dst[di + 2] = src[si + 2];
      }
    }
    return { w: dw, h: dh, bits: img.bits, data: dst, channels: 3, origW: img.w, origH: img.h, name };
  }

  root.LccCodec = { decodeImage, decodeTiff, encodeTiff16, isTiff, inflate };
})(typeof self !== 'undefined' ? self : this);
