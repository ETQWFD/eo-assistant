# EO助手

手机 ↔ DeepSeek Harness 的端到端加密桥（阶段 2 支持手机→桌面的文件/语音/PPT）。relay 只做密文转发和附件盲存储，桌面插件把每台手机映射为独立的 DSH 会话，并把文件/语音/PPT 解密落到工作区 `eo/`。

## 组成

- `apps/relay`：Node 24 + `node:sqlite` + `ws`，QR 绑定、签名 REST/WS、离线密文队列、在线状态、加密附件、名称/头像同步，并托管 PWA。
- `apps/mobile-web`：PWA（扫码、文本、文件、语音、PPT、名称/头像同步）。
- `apps/android`：零 Gradle WebView 壳，Android Keystore 加密身份，附件写入 `Download/EO助手/`。
- 桌面插件仓库：[ETQWFD/eo-dsh-plugin](https://github.com/ETQWFD/eo-dsh-plugin)

## 快速开始

```bash
# 1) relay
cd apps/relay && npm install --omit=dev
PORT=8787 DATA_FILE=./data/eo.sqlite node src/server.js

# 2) DSH 插件（在桌面机器）
dsh plugin --profile web add github:ETQWFD/eo-dsh-plugin
# 重启 dsh web，设置里填 relayUrl

# 3) 手机
# 浏览器打开 http://<relay>:8787/app/，或安装 Release 的 APK
```

生产必须 HTTPS；完整步骤与验收清单见 [`docs/INSTALL.md`](docs/INSTALL.md)，协议见 [`docs/PROTOCOL.md`](docs/PROTOCOL.md)，发布见 [`docs/RELEASE.md`](docs/RELEASE.md)。

## 构建

```bash
cd apps/mobile-web && npm install && npm run build
cd apps/android && ANDROID_HOME=/path/to/Android/Sdk ./build-apk.sh
```

## 测试

```bash
cd apps/relay
node --test test/*.test.js
```

测试覆盖：绑定、双向 E2EE 文本、presence、history、重复消息、坏签名、加密 blob 上传/下载、profile 广播与读取。

## 阶段

- 阶段 1：绑定 + 文本 + 在线状态 + `eo/` 归档（已在真实 DSH 0.2.2-rc.2 验证）。
- 阶段 2：文件/语音/PPT 的 E2EE blob、桌面落盘、手机按需解密。
- 阶段 3：桌面名称/头像公开资料与手机实时同步。
- 阶段 4：Android 签名 APK、GitHub Release、部署/回滚文档。Windows/macOS 没有独立二进制，安装即 DSH 插件命令，详见发布文档。
