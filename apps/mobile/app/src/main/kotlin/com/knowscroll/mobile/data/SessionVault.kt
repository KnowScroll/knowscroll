package com.knowscroll.mobile.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * #135 (ADR-0026): where a signed-in owner's bearer token lives between process runs. A device
 * that has never signed in, or has since signed out / been reset / had its account deleted, holds
 * none. Kept behind an interface so a JVM test exercises real decision logic (credential
 * selection, sign-in/out flows) without AndroidKeyStore.
 */
interface SessionVault {
    fun readToken(): String?
    fun writeToken(token: String)
    fun clear()
}

/**
 * The real vault: an AndroidKeyStore AES/GCM key that never leaves the keystore encrypts the
 * token; only ciphertext and its IV ever touch `SharedPreferences`. `javax.crypto` +
 * `AndroidKeyStore` only -- no new dependency (no EncryptedSharedPreferences/Tink). Every read
 * re-decrypts from storage rather than caching in memory, so a write from another `SessionVault`
 * instance pointed at the same app (e.g. a different ViewModel's own instance) is visible on the
 * very next read.
 */
class AndroidKeyStoreSessionVault(context: Context) : SessionVault {
    private val prefs =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    override fun readToken(): String? {
        val ciphertext = prefs.getString(KEY_CIPHERTEXT, null) ?: return null
        val iv = prefs.getString(KEY_IV, null) ?: return null
        return runCatching {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(
                Cipher.DECRYPT_MODE,
                secretKey(),
                GCMParameterSpec(GCM_TAG_BITS, Base64.decode(iv, Base64.NO_WRAP)),
            )
            String(cipher.doFinal(Base64.decode(ciphertext, Base64.NO_WRAP)), Charsets.UTF_8)
        }.getOrNull()
    }

    override fun writeToken(token: String) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val ciphertext = cipher.doFinal(token.toByteArray(Charsets.UTF_8))
        check(
            prefs
                .edit()
                .putString(KEY_CIPHERTEXT, Base64.encodeToString(ciphertext, Base64.NO_WRAP))
                .putString(KEY_IV, Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
                .commit()
        ) { "Could not save the signed-in session" }
    }

    override fun clear() {
        check(prefs.edit().remove(KEY_CIPHERTEXT).remove(KEY_IV).commit()) {
            "Could not clear the signed-in session"
        }
    }

    private fun secretKey(): SecretKey {
        val keyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
        generator.init(
            KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return generator.generateKey()
    }

    private companion object {
        const val PREFS_NAME = "ks_session_vault_v1"
        const val PROVIDER = "AndroidKeyStore"
        const val KEY_ALIAS = "ks_session_vault_key"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val GCM_TAG_BITS = 128
        const val KEY_CIPHERTEXT = "token_ciphertext"
        const val KEY_IV = "token_iv"
    }
}
