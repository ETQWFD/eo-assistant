# 发布与签名

## Android APK

本仓库的 APK 是 WebView 壳，内置扫码页和完整 PWA；首启扫码后加载 APK 内的 `assets/app/`，不要求用户填写 relay。

```bash
cd apps/android
ANDROID_HOME=/path/to/Android/Sdk ./build-apk.sh
```

脚本使用无 Gradle 的工具链：`aapt2 → javac → d8 → zipalign → apksigner`。默认签名文件是 `apps/android/keystore/eo-release.jks`（已被 `.gitignore` 忽略），首次构建自动生成；后续升级必须复用同一 keystore，否则 Android 会拒绝覆盖安装。

发布前：

```bash
export EO_KEYSTORE=/secure/path/eo-release.jks
export EO_KEYSTORE_PASS='<strong-password>'
export EO_KEY_ALIAS=eo
./build-apk.sh
apksigner verify --min-sdk-version 24 --print-certs releases/eo-assistant-0.3.0.apk
```

密钥托管：离线加密备份，不要提交到公开仓库；CI 中放 secrets，构建后删除临时文件。丢失 keystore 等于放弃应用升级能力。

## Windows / macOS

DSH 插件是运行在 DeepSeek Harness profile 中的 Cordis 插件，不是独立 EXE/DMG：

- Windows/macOS 的“安装”就是 `dsh plugin --profile web add github:ETQWFD/eo-dsh-plugin`；
- 插件代码是 ESM + 已构建的 `lib/client.js`，没有原生二进制，因此不存在 Windows Authenticode / macOS codesign+notarize 的签名对象；
- 若未来要做独立托盘客户端，需要单独引入 Electron/Tauri 工程、分别做 Authenticode 与 Apple Developer ID 公证，不能把本插件冒充成已签名的桌面程序。

当前发布物：插件 GitHub 包 + Android APK。插件默认自带内置 relay，不需要单独部署；外部 relay 仍可选。

## GitHub Release

```bash
gh release create v0.2.0 \
  apps/android/releases/eo-assistant-0.3.0.apk \
  --repo ETQWFD/eo-assistant \
  --title "EO助手 0.3.0" \
  --notes "0.3.0：零输入扫码、内置 relay、Android 内置 PWA、图片视觉输入。"
```

插件仓库单独打 tag：

```bash
cd eo-dsh-plugin
git tag v0.3.0 && git push origin v0.3.0
gh release create v0.3.0 --repo ETQWFD/eo-dsh-plugin --title "dsh-eo-assistant 0.3.0" --notes "..." 
```

## 升级顺序

1. 先升级 relay（向后兼容旧信封；新增 `/v1/blob`、`/v1/profile`）。
2. 再升级 DSH 插件，重启 `dsh web`。
3. 最后升级手机 PWA/APK；旧 PWA 仍可收发文本。
4. 回滚：relay 旧数据表保留，插件回退 tag；附件表不影响文本。

## 生产检查

- `GET /health` 与 `/app/` 经 HTTPS 可访问；8787 不直接暴露。
- Caddy/Nginx 的 WebSocket 超时 > 60s，否则长连接会被切断（客户端会自动重连）。
- `DATA_FILE` 所在磁盘有备份；`blobs/` 与 SQLite 必须一起备份。
- 反向代理限制请求体 ≥ 18MB（默认 `client_max_body_size` 可能只有 1MB，会导致附件 413）。
- 手机端公网 http 会被拒绝，确认使用 `https://`。
