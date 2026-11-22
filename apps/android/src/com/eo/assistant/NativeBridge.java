package com.eo.assistant;

import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/** Save a decrypted attachment into the phone's Downloads collection. */
public class NativeBridge {
    private final Context context;

    public NativeBridge(Context context) {
        this.context = context.getApplicationContext();
    }

    private String safeName(String value) {
        String name = String.valueOf(value == null ? "attachment" : value)
                .replace("/", "_").replace("\\", "_").replace("..", "_");
        name = name.replaceAll("[\\u0000-\\u001f]", "").trim();
        if (name.isEmpty()) name = "attachment";
        return name.length() > 120 ? name.substring(0, 120) : name;
    }

    @JavascriptInterface
    public String saveFile(String name, String mime, String base64) {
        try {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            if (bytes.length == 0) return "empty";
            String fileName = safeName(name);
            String type = String.valueOf(mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
                values.put(MediaStore.Downloads.MIME_TYPE, type);
                values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/EO助手");
                values.put(MediaStore.Downloads.IS_PENDING, 1);
                Uri uri = context.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) return "insert_failed";
                try (OutputStream out = context.getContentResolver().openOutputStream(uri)) {
                    if (out == null) return "open_failed";
                    out.write(bytes);
                }
                values.clear();
                values.put(MediaStore.Downloads.IS_PENDING, 0);
                context.getContentResolver().update(uri, values, null, null);
                return "Download/EO助手/" + fileName;
            }
            File dir = new File(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "EO助手");
            if (!dir.exists() && !dir.mkdirs()) return "mkdir_failed";
            File file = new File(dir, fileName);
            try (FileOutputStream out = new FileOutputStream(file)) {
                out.write(bytes);
            }
            return file.getAbsolutePath();
        } catch (Exception error) {
            return "error:" + error.getMessage();
        }
    }
}
