# 安装与验收

EO助手由三部分组成：

| 组件 | 运行位置 | 作用 |
|---|---|---|
| `eo-dsh-plugin` | 桌面 / DSH profile | 生成二维码、持有桌面身份、把手机消息送进 DSH 会话、归档到 `eo/` |
| `eo-relay` | 一台 Node 24 服务器 | 盲转发 E2EE 信封、离线密文队列、附件密文、名称/头像同步 |
| PWA / Android APK | 手机 | 扫码绑定、文本/文件/语音/PPT、本地 Keystore |

## 1. 部署 relay

服务器要求：Node.js >= 24.9、可写磁盘、一个域名（公网必须 HTTPS）。

```bash
git clone https://github.com/ETQWFD/eo-assistant.git
cd eo-assistant/apps/relay
npm install --omit=dev
PORT=8787 HOST=127.0.0.1 DATA_FILE=/var/lib/eo/eo.sqlite node src/server.js
```

用 Caddy 反代（自动 HTTPS）：

```caddyfile
eo.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

WebSocket 会自动随同域名升级。不要把 8787 直接暴露到公网；relay 本身不终结 TLS。

systemd 示例：

```ini
[Unit]
Description=EO Assistant relay
After=network.target

[Service]
WorkingDirectory=/opt/eo-assistant/apps/relay
Environment=PORT=8787
Environment=HOST=127.0.0.1
Environment=DATA_FILE=/var/lib/eo/eo.sqlite
ExecStart=/usr/bin/node src/server.js
Restart=always
User=eo

[Install]
WantedBy=multi-user.target
```

验收：`curl https://eo.example.com/health` 返回 `{"ok":true,...}`，浏览器打开 `https://eo.example.com/app/` 能看到 EO助手 登录页。

## 2. 安装 DSH 插件

在桌面已安装 DeepSeek Harness 的环境执行：

```bash
dsh plugin --profile web add github:ETQWFD/eo-dsh-plugin
```

然后重启 `dsh web`。在 profile 的 `cordis.patch.yml` 写入配置（`relayUrl` 必须是手机能访问的地址）：

```yaml
- id: eo-assistant
  config:
    relayUrl: https://eo.example.com
    assistantName: EO助手
    # provider / model 可选，不填使用当前默认模型
    # workspaceDir 可选，默认当前工作目录
    # maxFileMB 可选，默认 50（relay 默认单文件上限 16MB 明文（约 17MB 密文））
```

打开 DSH Web → 设置 → “EO助手连接”，应看到二维码和“生成二维码”。如果分区不存在，检查插件是否被 profile 加载、`dsh plugin list` 是否包含 `dsh-eo-assistant`。

## 3. 手机绑定

### PWA

手机浏览器打开 `https://eo.example.com/app/`。首次进入会生成匿名设备身份。点“扫一扫”，扫描桌面设置页的二维码；相机不可用时粘贴 `eo://bind?...` 链接。桌面设置页会显示 6 位确认码，输入即完成绑定。

### Android APK

安装 `eo-assistant-0.2.0.apk`（Release 附件），允许“安装未知来源”。首次打开填写 relay 地址：

- 公网：`https://eo.example.com`
- 同一局域网调试：`http://192.168.x.x:8787`（APK 允许明文，但只建议调试）

点“连接 relay”，再按 PWA 相同流程扫码/粘贴、输入确认码。APK 的私钥保存在 Android Keystore（AES-256-GCM 加密），附件保存到 `Download/EO助手/`。

## 4. 验收清单

- [ ] `GET /health` 正常，`/app/` 能打开。
- [ ] DSH 设置页出现“EO助手连接”，点“生成二维码”不报错。
- [ ] 手机扫码后桌面出现 6 位确认码，输入后双方显示“已连接/在线”。
- [ ] 手机发文本，桌面 DSH 会话能收到并回复；回复回到手机。
- [ ] 断开手机网络再恢复，离线消息能补收，且不重复。
- [ ] 手机发一个 PNG/PDF/PPTX，桌面 `eo/<convId>/attachments/` 出现解密后的原文件；桌面 DSH 收到带路径的说明。
- [ ] 手机录一段语音发送，桌面保存为 `voice-*.webm`，手机能播放自己/对方语音。
- [ ] 桌面修改名称/头像，手机列表和聊天页在数秒内同步。
- [ ] 手机清除身份后，旧会话无法再解密；重新扫码生成新设备。

## 5. 安全边界

- relay 只保存密文信封和密文附件；没有消息明文、没有私钥、没有 GitHub token。
- 身份私钥：桌面 `~/.dsh/eo/identity.json`（0600）；手机 Android Keystore；浏览器 localStorage（XSS 风险由同源 CSP 限制）。
- 公网必须 HTTPS；HTTP 只允许 loopback / 私有网段，手机设置页会拒绝公网 http。
- `GET /v1/profile/:deviceId` 是公开的，会暴露用户主动设置的名称和头像；不设置则不存在。不要把敏感信息放进名称/头像。
- 本项目不做 GitHub 消息备份；若自行实现，必须先在客户端加密，且不得把 GitHub token 写入 APK/PWA。
