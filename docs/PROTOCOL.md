# 协议与实现说明

## 1. 信任模型

- 桌面与手机各自生成 Ed25519 签名密钥 + X25519 密钥协商密钥。
- 双方用 X25519 共享密钥 + HKDF-SHA256（salt=convId，info=`eo-conv-v1`）得到 32 字节会话密钥。
- 消息用 AES-256-GCM；AAD 绑定版本、convId、msgId、seq、sender、ts。
- relay 只验证 Ed25519 签名、成员关系和 seq 冲突，不接触明文。
- 设备 ID = `eo1_` + SHA-256(Ed25519 raw public key) 的 Base32 前 16 位；设备无法冒用别人的 ID。

## 2. 绑定

1. 桌面 `POST /v1/bind/create`（签名）→ `{bindId, nonce, expiresAt}`。
2. 桌面生成 `eo://bind?v=1&r=<relay>&b=<bindId>&x=<desktopXPub>&n=<nonce>&f=<fingerprint>&name=<name>` 二维码。
3. 手机 `GET /v1/bind/:id` 校验 `desktopXPub`/`nonce`，再 `POST /claim`（签名）。
4. relay 把 6 位确认码推给桌面；手机输入确认码后 `POST /confirm`。
5. relay 创建 conversation，双方收到 `bind/confirmed`，各自计算相同会话密钥。

确认码是人工防中间人的第二通道；二维码本身包含 relay 地址和桌面公钥，手机必须校验公钥与 relay 返回值一致。

## 3. 消息信封

```json
{
  "v": 1,
  "convId": "c_...",
  "msgId": "m_...",
  "seq": 1,
  "kind": "text | file | voice | ppt",
  "sender": "eo1_...",
  "ts": 1720000000000,
  "nonce": "base64url",
  "ct": "base64url",
  "sig": "base64url",
  "meta": null
}
```

签名串是字段数组的 JSON：

```js
JSON.stringify([v, convId, msgId, seq, kind, sender, ts, nonce, ct, meta ?? null])
```

`ct` 解密后是 `{ text, meta }`。附件的 `meta` 只存在于密文内部，relay 看不到文件名/类型。

## 4. 附件 / 语音 / PPT

附件二进制不放进信封（避免 WebSocket 大帧），走独立的密文 blob：

1. 手机生成 `blobId = bl_...`，读文件字节，计算 SHA-256。
2. `blobAad = eo|blob|v1|<convId>|<blobId>|<sender>|<ts>|<sha256>`。
3. 用会话密钥 AES-256-GCM 加密文件字节，`nonce` 放进信封 `meta`。
4. `PUT /v1/blob/:blobId?convId=...`，body 是原始密文；签名串覆盖 `sha256hex(密文)`。
5. 发送 `kind=file|voice|ppt` 的信信封，`meta` 含 `{type,name,mime,size,sha256,blobId,blobNonce,blobAad,duration}`。
6. 桌面收到后 `GET /v1/blob/:blobId?convId=...`，解密、校验 SHA-256，保存到 `eo/<convId>/attachments/<msgId>-<name>`。
7. 手机点“打开/播放”时才下载并解密，避免自动拉取大文件；Android 通过 `EoNative.saveFile` 写入 `Download/EO助手/`。

限制：relay 默认单 blob 17MB（16MB 明文 + GCM 开销）、每会话 200 个 blob；插件 `maxFileMB` 默认 50，实际受 relay 上限约束。生产可按需调整 `MAX_BLOB_BYTES`，但手机端 `MAX_FILE_BYTES` 也要同步。

## 5. 名称/头像同步

- 桌面 `POST /v1/profile` 签名上传 `{name, iconBase64}`；relay 校验 PNG/JPEG、<=512KB，写入 `profiles`。
- `GET /v1/profile/:deviceId` 公开返回名称/头像；手机绑定后拉取，并缓存到会话。
- 桌面更新后 relay 只向对端推 `{type:'profile', name, iconVersion}`，手机再拉头像，避免 512KB 走 WebSocket。
- 手机列表/聊天页的 `paintAvatar` 同时支持首字母和头像 data URL。

## 6. DSH 集成

- 每个 `convId` 对应一个 DSH Session `eo-<convId>`。
- 首次消息：`agents.create({sessionId, meta:{cwd}, agentOptions})`；已存在：`agents.resume`。
- 手机消息通过 `Agent.followup({content})` 注入；助手 `assistant/message` 事件被监听并回传手机。
- 手机附件落盘后，注入的文本包含本地相对路径，Agent 可直接用文件工具读取。
- `eo/` 目录布局：

```
<workspace>/eo/index.json
<workspace>/eo/<convId>/meta.json
<workspace>/eo/<convId>/messages.jsonl
<workspace>/eo/<convId>/attachments/...
```

## 7. 已知边界

- relay 是单进程 SQLite 设计；多节点需替换 `db.js` 为 Postgres，并让 blob 存储共享（S3/NFS）。
- 浏览器身份存 localStorage，XSS 可读写；Android 用 Keystore，风险显著更低。
- 语音格式取决于浏览器 `MediaRecorder`：Android WebView 通常是 `audio/webm;codecs=opus`，iOS Safari 可能是 `audio/mp4`；桌面保存原始容器，不做转码。
- PPT 只做“加密传输 + 原文件落盘”，不做在线渲染；手机端打开依赖系统是否有 PPT 查看器。
- 头像公开端点可被枚举 deviceId 后读取；名称/头像不应包含敏感信息。
