# EO助手 Android 壳

零 Gradle 依赖的 WebView 壳，加载 relay 托管的 `/app/`。原生层只做三件事：

1. 相机/麦克风权限与 WebRTC `PermissionRequest` 桥接；
2. 文件选择器；
3. `EoSecure`（Android Keystore AES-256-GCM 加密身份）与 `EoNative.saveFile`（附件写入 `Download/EO助手/`）。

## 构建

```bash
ANDROID_HOME=/path/to/Android/Sdk ./build-apk.sh
```

要求：JDK 17、`build-tools/35.0.0`、`platforms/android-35`、`zip`。脚本不依赖 Gradle，产物在 `releases/`。

默认 keystore：`keystore/eo-release.jks`（首次自动生成，务必保留）。发布签名见 `docs/RELEASE.md`。

## 首次配置

安装后输入 relay 地址：

- 公网必须 `https://`
- 局域网调试可用 `http://192.168.x.x:8787`（应用允许 cleartext，但会提示风险）

随后扫码或粘贴绑定链接，输入桌面显示的 6 位确认码。

## 权限

- `INTERNET`
- `CAMERA`（扫码）
- `RECORD_AUDIO`（语音消息）
- 文件选择器使用 SAF，不需要存储权限；Android 10+ 附件通过 MediaStore 写入 Download。
