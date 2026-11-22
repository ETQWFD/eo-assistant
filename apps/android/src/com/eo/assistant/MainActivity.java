package com.eo.assistant;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.net.URL;

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
        if (serverUrl == null || serverUrl.isEmpty()) showSetup();
        else showWeb(serverUrl);
    }

    private int dp(int value) {
        return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
    }

    private void showSetup() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_VERTICAL);
        root.setPadding(dp(26), dp(26), dp(26), dp(26));
        root.setBackgroundColor(Color.rgb(243, 246, 245));

        TextView title = new TextView(this);
        title.setText("EO助手");
        title.setTextSize(30);
        title.setTextColor(Color.rgb(15, 118, 110));
        title.setGravity(Gravity.CENTER_HORIZONTAL);

        TextView desc = new TextView(this);
        desc.setText("连接你的 relay\n例如 https://eo.example.com\n本地联调可用 http://192.168.1.10:8787");
        desc.setTextSize(14);
        desc.setTextColor(Color.rgb(80, 100, 96));
        desc.setGravity(Gravity.CENTER_HORIZONTAL);
        desc.setPadding(0, dp(10), 0, dp(22));

        EditText input = new EditText(this);
        input.setHint("https://your-relay.example.com");
        input.setSingleLine(true);
        input.setTextSize(15);
        input.setPadding(dp(12), dp(10), dp(12), dp(10));

        Button connect = new Button(this);
        connect.setText("连接 relay");
        connect.setTextColor(Color.WHITE);
        connect.setBackgroundColor(Color.rgb(15, 118, 110));
        LinearLayout.LayoutParams buttonParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(48));
        buttonParams.topMargin = dp(16);

        TextView note = new TextView(this);
        note.setText("身份私钥由 Android Keystore 加密保存；relay 只转发密文。公网部署必须使用 HTTPS。");
        note.setTextSize(12);
        note.setTextColor(Color.rgb(105, 124, 120));
        note.setPadding(0, dp(18), 0, 0);

        connect.setOnClickListener(v -> {
            String value = input.getText().toString().trim();
            String normalized = normalizeServer(value);
            if (normalized == null) {
                Toast.makeText(this, "请输入合法的 http(s) 地址", Toast.LENGTH_LONG).show();
                return;
            }
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_SERVER, normalized).apply();
            serverUrl = normalized;
            if (normalized.startsWith("http://")) {
                Toast.makeText(this, "当前使用明文 HTTP，生产环境请改用 HTTPS", Toast.LENGTH_LONG).show();
            }
            showWeb(normalized);
        });

        root.addView(title);
        root.addView(desc);
        root.addView(input);
        root.addView(connect, buttonParams);
        root.addView(note);
        setContentView(root);
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

    private void showWeb(String server) {
        if (webView != null) {
            ((ViewGroup) webView.getParent()).removeView(webView);
            webView.destroy();
        }
        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setUserAgentString(settings.getUserAgentString() + " EOAssistant/0.1.0");
        webView.setBackgroundColor(Color.WHITE);
        webView.addJavascriptInterface(new SecureStore(this), "EoSecure");
        webView.addJavascriptInterface(new NativeBridge(this), "EoNative");

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme();
                if ("http".equals(scheme) || "https".equals(scheme)) {
                    String targetHost = uri.getHost();
                    String ourHost = Uri.parse(serverUrl).getHost();
                    if (targetHost != null && targetHost.equals(ourHost)) return false;
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, uri));
                    } catch (Exception ignored) { }
                    return true;
                }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError error) {
                if (request.isForMainFrame()) {
                    Toast.makeText(MainActivity.this, "无法连接 relay：" + error.getDescription(), Toast.LENGTH_LONG).show();
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
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
        });

        setContentView(webView);
        webView.loadUrl(server + "/app/?native=1");
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
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
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
