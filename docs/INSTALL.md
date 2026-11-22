# 安装与验收

EO助手由两部分组成：

| 组件 | 运行位置 | 作用 |
|---|---|---|
| `eo-dsh-plugin` | 桌面 DSH profile | 内置 relay、二维码绑定、桌面身份、DSH Session 桥接、图片视觉准入、`eo/` 归档 |
| PWA / Android APK | 手机 | 扫码绑定、文本/图片/文件/语音/PPT、Android Keystore |

内置 relay 随插件启动，所以**不需要先部署服务器，也不需要填写 relay 地址**。只有跨公网/多用户共享时才需要外部 relay。

## 1. 安装 DSH 插件

在桌面已安装 DeepSeek Harness 的环境执行：

```bash
dsh plugin --profile web add github:ETQWFD/eo-dsh-plugin
```

桌面版 / lite / macOS 使用同一个包，把 `web` 换成应用实际使用的 profile：

```bash
dsh plugin --profile desktop add github:ETQWFD/eo-dsh-plugin
dsh plugin --profile <profile> add github:ETQWFD/eo-dsh-plugin
```

如果安装报：

```
[ERR_PNPM_GIT_RESOLVE_FAILED] Failed to resolve git dependency "GITHUB:ETQWFD/eo-dsh-plugin/"
remote: Repository not found
```

说明命令写成了大写 `GITHUB:`。pnpm 11 会把它当成 scp 地址，owner 丢失。改用：

```bash
dsh plugin --profile web add github:ETQWFD/eo-dsh-plugin
# 或
dsh plugin --profile web add git+https://github.com/ETQWFD/eo-dsh-plugin.git
```

安装后重启 DSH。打开 `设置 → EO助手连接`，应看到：

- `relay 在线` + `内置 relay` 徽章；
- “生成二维码”按钮；
- 当前设备 ID 和“还没有绑定手机”。

如果看不到分区，检查：

```bash
dsh plugin --profile web list
```

应包含 `dsh-eo-assistant`。

## 2. 零配置连接

1. 桌面 `设置 → EO助手连接 → 生成二维码`。
2. 手机安装 APK，首次打开就是扫码页；或浏览器打开设置页诊断信息中的 `<relayUrl>/app/`。
3. 扫描二维码。桌面显示 6 位确认码，手机输入。
4. 双方显示在线，手机进入聊天页。

二维码里的 `relay` 由插件自动生成：

- 默认 `http://<局域网IPv4>:8787`；
- 8787 被占用时自动换随机端口；
- 电脑有 VPN/虚拟网卡选错地址时：

```bash
# macOS / Linux
EO_RELAY_HOST=192.168.1.10 dsh web

# Windows PowerShell
$env:EO_RELAY_HOST="192.168.1.10"; dsh web
```

手机和电脑必须在同一 Wi-Fi/局域网，且电脑防火墙允许该端口入站。

### Android

安装 `eo-assistant-0.3.0.apk`，允许“安装未知来源”。

### 电脑端模型必须先配置

手机只负责输入和图片，AI 回复由电脑的 DSH 模型生成。先打开 DSH `设置 → 模型` 登录 DeepSeek 或填入 `DEEPSEEK_API_KEY`，再在 `设置 → EO助手连接` 确认状态栏显示可用模型；显示“未配置模型”时手机发消息不会收到回复。模型调用失败会由插件实时推送到手机，并提示去电脑配置模型或检查网络。图片需要模型支持图片输入，`deepseek-flash` 支持。

- 首启是内置扫码页，不出现“连接你的 relay”输入框。
- 聊天页和全部静态资源打包在 APK 的 `assets/app/`，从 `https://app.local` 安全源加载，所以 Web Crypto、相机、相册、录音都可用。
- 局域网 relay 是 `http://` 时，WebView 只对用户扫码得到的局域网地址放开混合内容；不硬编码任何公网地址。
- 私钥保存在 Android Keystore；附件保存到 `Download/EO助手/`。

### iPhone / 浏览器 PWA

浏览器打开桌面设置页诊断信息中的 `<relayUrl>/app/`。

注意：浏览器 Web Crypto 要求安全上下文。`http://localhost` 可以，`http://192.168.x.x` 在 iOS Safari 通常不可用；这时请用 Android APK，或给外部 relay 配 HTTPS 域名。

## 3. 使用外部 relay（可选）

需要跨公网、多人共享或固定域名时：

```bash
git clone https://github.com/ETQWFD/eo-assistant.git
cd eo-assistant/apps/relay
npm install --omit=dev
PORT=8787 HOST=127.0.0.1 DATA_FILE=/var/lib/eo/eo.sqlite node src/server.js
```

Caddy 反代：

```caddyfile
eo.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

在 profile 的 `cordis.patch.yml`：

```yaml
- id: eo-assistant
  config:
    relayUrl: https://eo.example.com
    assistantName: EO助手
    # provider / model 可选，不填使用当前默认模型
    # workspaceDir 可选，默认当前工作目录
    # maxFileMB 可选，默认 50
```

公网必须 HTTPS；8787 不要直接暴露。反向代理请求体上限至少 18MB，WebSocket 超时大于 60 秒。

## 4. 验收清单

- [ ] `dsh plugin --profile web list` 包含 `dsh-eo-assistant`。
- [ ] DSH 设置页出现“EO助手连接”，显示 `内置 relay` 与 `relay 在线`。
- [ ] 生成二维码不报错；二维码 120 秒倒计时。
- [ ] Android 首启直接是扫码页，没有 relay 地址输入框。
- [ ] 扫码后桌面出现 6 位确认码，输入后双方显示在线。
- [ ] 手机发文本，桌面 DSH 会话收到并回复；回复回到手机。
- [ ] 手机发一张 JPEG，DSH 会话记录里出现 `type: "image"` 内容块，且文本为“已作为视觉输入发送给模型”。
- [ ] 手机发 PNG/PDF/PPTX，桌面 `eo/<convId>/attachments/` 出现解密后的原文件。
- [ ] 手机录音发送，桌面保存为 `voice-*.webm`。
- [ ] 桌面改名/换头像，手机列表和聊天页数秒内同步。
- [ ] 手机断网再恢复，离线消息补收且不重复。

### 已验证

- 真实 DSH `0.2.2-rc.5`、profile `web`：插件加载、内置 relay 8787、DSH Web 设置页渲染、二维码生成。
- 真实 DSH 中扫码 claim → 6 位确认 → `bind/confirmed`；手机 PWA 进入聊天。
- 真实 DSH Session 中图片消息生成 `type: "image"` 附件块（`mediaType: image/jpeg`，640×480，14204 bytes），文本为“已作为视觉输入发送给模型”。
- `node --test`：relay 协议、图片准入 content block。
- APK：`aapt2` 校验 versionCode 3 / versionName 0.3.0 / minSdk 24 / targetSdk 35，`apksigner` 验签通过。

### 尚需真机确认

当前构建环境没有 Android 真机、KVM 或系统镜像，因此以下只在代码/产物层验证，未在真实手机上点过：

- `https://app.local` 资产拦截 + WebView 相机权限 + 首启扫码页；
- Android 相册/拍照选择、录音、Keystore 读写；
- 手机与桌面在同一真实局域网下的端到端图片/文件传输。

## 5. 安全边界

- relay 只保存密文信封和密文附件；没有消息明文、私钥、模型 API Key、GitHub token。
- 桌面私钥：`$DSH_HOME/eo/identity.json`（0600）；手机：Android Keystore；浏览器：localStorage。
- 二维码 120 秒有效，确认码是第二通道。
- 内置 relay 绑定 `0.0.0.0`，同一局域网可访问；不要在不可信 Wi-Fi 使用。跨公网请用 HTTPS 外部 relay。
- `GET /v1/profile/:deviceId` 公开返回名称/头像；不要把敏感信息放进去。
- GitHub 私密仓库不能充当实时后端：它没有 WebSocket/常驻进程，私密读取还需要 token。不要把 token 写进客户端。
