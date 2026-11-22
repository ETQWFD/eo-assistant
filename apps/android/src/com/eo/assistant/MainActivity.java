package com.eo.assistant;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.AssetManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.SslErrorHandler;
import android.net.http.SslError;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Thin, dependency-free WebView shell for the EO Assistant PWA.
 *
 * The PWA is served by the user's relay at <relay>/app/. The native layer
 * contributes exactly two things the browser cannot: camera/file-chooser
 * plumbing and Android Keystore encryption for the identity blob exposed as
 * window.EoSecure.
 */
public class MainActivity extends Activity {
    private static final int REQ_CAMERA = 21;
    private static final int REQ_MIC = 23;
    private static final int REQ_FILE = 22;
    private static final String PREFS = "eo_native";
    private static final String KEY_SERVER = "server";

    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest pendingPermission;
    private String serverUrl;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        serverUrl = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_SERVER, "");
        if (serverUrl == null || serverUrl.isEmpty()) showScanner();
        else showWeb(serverUrl, "");
    }

    private int dp(int value) {
        return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
    }

    /**
     * First run opens a bundled camera scanner. There is deliberately no relay
     * text field: the QR carries the relay, the bind nonce and the desktop key,
     * so a phone can register and bind in one scan.
     */
    private void showScanner() {
        WebView scanner = createWebView();
        scanner.addJavascriptInterface(new SetupBridge(), "EoSetup");
        scanner.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri != null && "app.local".equals(uri.getHost())) {
                    return assetResponse(uri.getPath());
                }
                return null;
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                String url = error == null ? "" : String.valueOf(error.getUrl());
                if (url.startsWith("https://app.local/")) handler.proceed();
                else handler.cancel();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError error) {
                if (request.isForMainFrame()) {
                    Toast.makeText(MainActivity.this, "扫码页加载失败：" + error.getDescription(), Toast.LENGTH_LONG).show();
                }
            }
        });
        scanner.setWebChromeClient(permissionChromeClient());
        webView = scanner;
        setContentView(scanner);
        scanner.loadUrl("https://app.local/setup/index.html");
    }

    /** Serve the bundled setup page from assets under a secure https origin so getUserMedia works. */
    private WebResourceResponse assetResponse(String rawPath) {
        String pathname = rawPath == null || rawPath.isEmpty() || "/".equals(rawPath)
                ? "setup/index.html"
                : rawPath.startsWith("/") ? rawPath.substring(1) : rawPath;
        if ("app".equals(pathname) || "app/".equals(pathname)) pathname = "app/index.html";
        if (!pathname.startsWith("setup/") && !pathname.startsWith("app/")) {
            return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", null, new ByteArrayInputStream(new byte[0]));
        }
        String mime = pathname.endsWith(".html") ? "text/html"
                : pathname.endsWith(".js") ? "text/javascript"
                : pathname.endsWith(".css") ? "text/css"
                : pathname.endsWith(".svg") ? "image/svg+xml"
                : pathname.endsWith(".webmanifest") ? "application/manifest+json"
                : "application/octet-stream";
        try {
            InputStream input = getAssets().open(pathname);
            java.util.HashMap<String, String> headers = new java.util.HashMap<>();
            headers.put("Cache-Control", "no-store");
            headers.put("X-Content-Type-Options", "nosniff");
            return new WebResourceResponse(mime, "UTF-8", 200, "OK", headers, input);
        } catch (IOException error) {
            return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", null,
                    new ByteArrayInputStream("not found".getBytes(StandardCharsets.UTF_8)));
        }
    }

    private String normalizeServer(String value) {
        if (value == null || value.trim().isEmpty()) return null;
        String text = value.trim();
        if (!text.startsWith("http://") && !text.startsWith("https://")) text = "https://" + text;
        while (text.endsWith("/")) text = text.substring(0, text.length() - 1);
        try {
            URL url = new URL(text);
            if (!"http".equals(url.getProtocol()) && !"https".equals(url.getProtocol())) return null;
            if (url.getHost() == null || url.getHost().isEmpty()) return null;
            return text;
        } catch (Exception error) {
            return null;
        }
    }

    private WebView createWebView() {
        WebView view = new WebView(this);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        // The bundled PWA runs on the secure https://app.local origin so Web Crypto
        // and getUserMedia stay available. A LAN relay is usually plain http://;
        // allow that explicitly because the phone only talks to a relay it scanned.
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setUserAgentString(settings.getUserAgentString() + " EOAssistant/0.3.0");
        view.setBackgroundColor(Color.WHITE);
        return view;
    }

    private WebChromeClient permissionChromeClient() {
        return new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> {
                    boolean wantsCamera = false;
                    boolean wantsAudio = false;
                    for (String resource : request.getResources()) {
                        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) wantsCamera = true;
                        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) wantsAudio = true;
                    }
                    if (!wantsCamera && !wantsAudio) {
                        request.deny();
                        return;
                    }
                    boolean cameraOk = !wantsCamera
                            || checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
                    boolean audioOk = !wantsAudio
                            || checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
                    if (cameraOk && audioOk) {
                        request.grant(request.getResources());
                        return;
                    }
                    pendingPermission = request;
                    java.util.ArrayList<String> permissions = new java.util.ArrayList<>();
                    int code = 0;
                    if (!cameraOk) {
                        permissions.add(Manifest.permission.CAMERA);
                        code = REQ_CAMERA;
                    }
                    if (!audioOk) {
                        permissions.add(Manifest.permission.RECORD_AUDIO);
                        if (code == 0) code = REQ_MIC;
                        else code = REQ_CAMERA;
                    }
                    requestPermissions(permissions.toArray(new String[0]), code);
                });
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    Intent intent = params.createIntent();
                    startActivityForResult(Intent.createChooser(intent, "选择文件"), REQ_FILE);
                    return true;
                } catch (Exception error) {
                    fileCallback = null;
                    Toast.makeText(MainActivity.this, "无法打开文件选择器", Toast.LENGTH_SHORT).show();
                    return false;
                }
            }
        };
    }

    /** Native handoff from the scanner page; the JSON is carried only in the URL fragment. */
    private class SetupBridge {
        @android.webkit.JavascriptInterface
        public void connect(String payloadJson, String relay) {
            String normalized = normalizeServer(relay);
            if (normalized == null) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "二维码里的 relay 地址无效", Toast.LENGTH_LONG).show());
                return;
            }
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_SERVER, normalized).apply();
            serverUrl = normalized;
            runOnUiThread(() -> {
                if (normalized.startsWith("http://")) {
                    Toast.makeText(MainActivity.this, "当前使用局域网 HTTP，公网部署请改用 HTTPS", Toast.LENGTH_LONG).show();
                }
                showWeb(normalized, payloadJson == null ? "" : payloadJson);
            });
        }
    }

    private void showWeb(String server, String bindPayload) {
        if (webView != null) {
            ((ViewGroup) webView.getParent()).removeView(webView);
            webView.destroy();
        }
        webView = createWebView();
        webView.addJavascriptInterface(new SecureStore(this), "EoSecure");
        webView.addJavascriptInterface(new NativeBridge(this), "EoNative");

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri != null && "app.local".equals(uri.getHost())) return assetResponse(uri.getPath());
                return null;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme();
                if ("http".equals(scheme) || "https".equals(scheme)) {
                    String targetHost = uri.getHost();
                    String ourHost = serverUrl == null || serverUrl.isEmpty() ? "" : Uri.parse(serverUrl).getHost();
                    if ("app.local".equals(targetHost) || (targetHost != null && targetHost.equals(ourHost))) return false;
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, uri));
                    } catch (Exception ignored) { }
                    return true;
                }
                return true;
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                String url = error == null ? "" : String.valueOf(error.getUrl());
                if (url.startsWith("https://app.local/")) handler.proceed();
                else handler.cancel();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError error) {
                if (request.isForMainFrame()) {
                    Toast.makeText(MainActivity.this, "无法加载内置页面：" + error.getDescription(), Toast.LENGTH_LONG).show();
                }
            }
        });

        webView.setWebChromeClient(permissionChromeClient());
        setContentView(webView);
        // Load the bundled PWA from a secure origin. The relay URL is carried by
        // the bind payload and stored by the PWA; the native layer never injects
        // a blank relay screen or asks the user to type an address.
        String url = "https://app.local/app/?native=1";
        if (bindPayload != null && !bindPayload.isEmpty()) {
            String encoded = Base64.encodeToString(bindPayload.getBytes(StandardCharsets.UTF_8),
                    Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
            url += "#bind=" + encoded;
        }
        webView.loadUrl(url);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if ((requestCode != REQ_CAMERA && requestCode != REQ_MIC) || pendingPermission == null) return;
        boolean allGranted = grantResults.length > 0;
        for (int result : grantResults) {
            if (result != PackageManager.PERMISSION_GRANTED) allGranted = false;
        }
        if (allGranted) pendingPermission.grant(pendingPermission.getResources());
        else pendingPermission.deny();
        pendingPermission = null;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_FILE || fileCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int count = data.getClipData().getItemCount();
                result = new Uri[count];
                for (int i = 0; i < count; i += 1) result[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        if (serverUrl != null && !serverUrl.isEmpty()) {
            // Escape hatch when the saved relay is unreachable: rescan a desktop.
            showScanner();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.removeJavascriptInterface("EoSecure");
            webView.removeJavascriptInterface("EoNative");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
