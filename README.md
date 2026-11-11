# LCC 校正 · 色偏与暗角

平场（flat-field / LCC）色偏与暗角校正，**纯浏览器端**：照片不上传，装成 App 后可离线使用。
给「施耐德 Apo-Digitar 35 XL + 哈苏 CFV 100C」这类短后焦技术相机组合用，也可用于任何镜头。

## 用法

打开站点 → 「平场」页签选 5~9 张同条件白场 → 生成轮廓 → 存入库
→ 回「校正」页签选照片 → 校正 → 导出 16bit 线性 TIFF。

- 支持输入：JPEG / PNG / WebP / 16bit TIFF（未压缩或 ZIP 压缩）
- 支持导出：16bit 线性 TIFF / PNG / JPEG
- 安装：iOS Safari「分享 → 添加到主屏幕」；Android Chrome「菜单 → 安装应用」；桌面 Chrome 地址栏「安装」

## 结构

```
index.html styles.css tokens.css app.js worker.js sw.js manifest.webmanifest
lib/math.js    多项式拟合、分块中值、增益图（纯数学）
lib/codec.js   TIFF 解码 / 16bit TIFF 编码 / 图像解码
icons/         应用图标
```

无构建步骤，改完刷新即可。`worker.js` 在 Web Worker 里跑全部像素计算。

## 限制

- 浏览器内存有限：默认处理上限 1200 万像素，设置页可调到 4800 万；1 亿像素（全幅 3FR）请用桌面脚本版。
- 8bit 平场在暗角落有量化误差（实测残余色偏 ~2.9%），用 16bit TIFF 平场可改善。
- 不支持 3FR/RAW、LZW 压缩 TIFF、CMYK —— 会明确报错。

## 许可

MIT
