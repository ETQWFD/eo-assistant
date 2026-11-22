# EO助手

- `apps/relay`：自建 relay，QR 绑定、签名 REST、WebSocket、离线密文队列、在线状态，另托管手机 PWA。
- `apps/mobile-web`：手机端 PWA，扫码绑定、E2EE 文本、在线状态；可由 relay 的 `/app/` 直接打开。

## 本地运行

```bash
cd apps/relay
npm install
PORT=8787 DATA_FILE=./data/eo.sqlite node src/server.js
# 手机/浏览器打开 http://<host>:8787/app/
```

生产必须使用 HTTPS（`Caddy`/`Nginx` 反代）。手机端公网 relay 只允许 https。

## 构建 PWA

```bash
cd apps/mobile-web
npm install
npm run build
```

## 测试

```bash
cd apps/relay
node --test test/*.test.js
```

## 阶段状态

阶段 1 已完成并在真实 DSH 0.2.2-rc.2 中验证：插件安装、设置分区、二维码、扫码绑定、E2EE 文本、在线状态、`eo/` 落盘。
阶段 2-4（文件/语音/PPT、图标自定义完善、APK/EXE/macOS 签名分发）尚未在本仓库完成。
