package com.eo.assistant;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.webkit.JavascriptInterface;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Keystore-backed string store exposed to the PWA as window.EoSecure.
 *
 * The AES-256-GCM key lives in AndroidKeyStore and never leaves it. Values are
 * stored as base64(iv || ciphertext) in private SharedPreferences. If the
 * Keystore key is invalidated (device lock change, restore), decryption fails
 * closed and the PWA creates a fresh anonymous identity.
 */
public class SecureStore {
    private static final String KEY_ALIAS = "eo_assistant_state_v1";
    private static final String PREFS = "eo_secure";
    private static final int IV_BYTES = 12;
    private static final int TAG_BITS = 128;

    private final SharedPreferences prefs;

    public SecureStore(Context context) {
        prefs = context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(KEY_ALIAS)) {
            return (SecretKey) store.getKey(KEY_ALIAS, null);
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(false)
                .build());
        return generator.generateKey();
    }

    private String encrypt(String plain) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] iv = cipher.getIV();
        byte[] body = cipher.doFinal(plain.getBytes(StandardCharsets.UTF_8));
        byte[] packed = new byte[iv.length + body.length];
        System.arraycopy(iv, 0, packed, 0, iv.length);
        System.arraycopy(body, 0, packed, iv.length, body.length);
        return Base64.encodeToString(packed, Base64.NO_WRAP);
    }

    private String decrypt(String packedBase64) throws Exception {
        byte[] packed = Base64.decode(packedBase64, Base64.NO_WRAP);
        if (packed.length <= IV_BYTES) throw new IllegalArgumentException("ciphertext too short");
        byte[] iv = new byte[IV_BYTES];
        byte[] body = new byte[packed.length - IV_BYTES];
        System.arraycopy(packed, 0, iv, 0, IV_BYTES);
        System.arraycopy(packed, IV_BYTES, body, 0, body.length);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(TAG_BITS, iv));
        return new String(cipher.doFinal(body), StandardCharsets.UTF_8);
    }

    @JavascriptInterface
    public synchronized String get(String name) {
        String packed = prefs.getString(name, null);
        if (packed == null || packed.isEmpty()) return null;
        try {
            return decrypt(packed);
        } catch (Exception error) {
            return null;
        }
    }

    @JavascriptInterface
    public synchronized boolean put(String name, String value) {
        if (value == null) return delete(name);
        try {
            prefs.edit().putString(name, encrypt(value)).apply();
            return true;
        } catch (Exception error) {
            return false;
        }
    }

    @JavascriptInterface
    public synchronized boolean delete(String name) {
        prefs.edit().remove(name).apply();
        return true;
    }
}
