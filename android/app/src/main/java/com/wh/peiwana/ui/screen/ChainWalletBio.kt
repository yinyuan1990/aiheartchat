package com.wh.peiwana.ui.screen

import android.app.Activity
import android.content.Context
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.CancellationSignal
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import com.wh.peiwana.i18n.t
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * 钱包指纹解锁：钱包密码用一把「每次使用都要验证强生物识别」的 Keystore 密钥加密后存 App 私有目录。
 * 解锁时系统弹指纹框，验证通过才能解密出密码交给钱包页（钱包页再用它解开钱包数据）。
 * 新录入指纹后密钥自动失效（setInvalidatedByBiometricEnrollment），需要重新用密码开启。
 * 只支持 Android 10+（API 29 起才能可靠判断有没有录入强生物识别）。
 */
object ChainWalletBio {
    private const val KEY_ALIAS = "arm_wallet_bio_v1"
    private const val FILE = "arm_wallet_bio.bin"
    private const val GCM = "AES/GCM/NoPadding"

    private fun file(ctx: Context) = File(ctx.filesDir, FILE)
    private fun keyStore() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    private fun existingKey(): SecretKey? = (keyStore().getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.secretKey

    fun available(ctx: Context): Boolean {
        if (Build.VERSION.SDK_INT < 29) return false
        val bm = ctx.getSystemService(BiometricManager::class.java) ?: return false
        val r = if (Build.VERSION.SDK_INT >= 30) bm.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)
        else @Suppress("DEPRECATION") bm.canAuthenticate()
        return r == BiometricManager.BIOMETRIC_SUCCESS
    }

    fun enabled(ctx: Context) = file(ctx).exists() && runCatching { existingKey() != null }.getOrDefault(false)

    fun status(ctx: Context): JsonObject = buildJsonObject {
        put("available", available(ctx))
        put("enabled", enabled(ctx))
        put("kind", "fingerprint")
    }

    fun clear(ctx: Context) {
        file(ctx).delete()
        runCatching { keyStore().deleteEntry(KEY_ALIAS) }
    }

    private fun newKey(): SecretKey {
        runCatching { keyStore().deleteEntry(KEY_ALIAS) }
        val spec = KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true)
        if (Build.VERSION.SDK_INT >= 30) spec.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(spec.build())
            generateKey()
        }
    }

    /** 结果：Result.success(true) 已开启，success(false) 用户取消；失败带原因 */
    fun enable(activity: Activity, password: String, done: (Result<Boolean>) -> Unit) {
        if (!available(activity)) return done(Result.failure(IllegalStateException(t("bio.noFingerprint"))))
        val cipher = runCatching { Cipher.getInstance(GCM).apply { init(Cipher.ENCRYPT_MODE, newKey()) } }
            .getOrElse { return done(Result.failure(it)) }
        prompt(activity, cipher, t("bio.enableTitle"), t("bio.enableSubtitle")) { c, err ->
            when {
                err != null -> done(Result.failure(IllegalStateException(err)))
                c == null -> done(Result.success(false))
                else -> done(runCatching {
                    val out = c.iv + c.doFinal(password.toByteArray(Charsets.UTF_8))
                    val tmp = File(activity.filesDir, "$FILE.tmp")
                    tmp.writeText(Base64.encodeToString(out, Base64.NO_WRAP))
                    tmp.renameTo(file(activity))
                    true
                })
            }
        }
    }

    /** 结果：success(密码)；success(null) 用户取消（改用密码）；失败 "invalidated" = 指纹有变动，已自动关闭 */
    fun unlock(activity: Activity, done: (Result<String?>) -> Unit) {
        val f = file(activity)
        val key = runCatching { existingKey() }.getOrNull()
        if (!f.exists() || key == null) {
            clear(activity)
            return done(Result.failure(IllegalStateException("not enabled")))
        }
        val raw = runCatching { Base64.decode(f.readText(), Base64.NO_WRAP) }.getOrNull()
        if (raw == null || raw.size <= 12) {
            clear(activity)
            return done(Result.failure(IllegalStateException("not enabled")))
        }
        val cipher = try {
            Cipher.getInstance(GCM).apply { init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, raw.copyOfRange(0, 12))) }
        } catch (e: KeyPermanentlyInvalidatedException) {
            clear(activity)
            return done(Result.failure(IllegalStateException("invalidated")))
        } catch (e: Exception) {
            return done(Result.failure(e))
        }
        prompt(activity, cipher, t("bio.unlockTitle"), null) { c, err ->
            when {
                err != null -> done(Result.failure(IllegalStateException(err)))
                c == null -> done(Result.success(null))
                else -> done(runCatching { String(c.doFinal(raw.copyOfRange(12, raw.size)), Charsets.UTF_8) })
            }
        }
    }

    /** cb(cipher, null) 通过；cb(null, null) 用户取消 / 点了「用密码」；cb(null, 原因) 出错（例如尝试太多次被锁） */
    private fun prompt(activity: Activity, cipher: Cipher, title: String, subtitle: String?, cb: (Cipher?, String?) -> Unit) {
        val exec = activity.mainExecutor
        var answered = false
        fun answer(c: Cipher?, err: String?) {
            if (answered) return
            answered = true
            cb(c, err)
        }
        val b = BiometricPrompt.Builder(activity).setTitle(title)
        if (subtitle != null) b.setSubtitle(subtitle)
        if (Build.VERSION.SDK_INT >= 30) b.setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
        b.setNegativeButton(t("bio.usePassword"), exec) { _, _ -> answer(null, null) }
        b.build().authenticate(BiometricPrompt.CryptoObject(cipher), CancellationSignal(), exec, object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                answer(result.cryptoObject?.cipher, if (result.cryptoObject?.cipher == null) "no cipher" else null)
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                val cancelled = errorCode == BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED || errorCode == BiometricPrompt.BIOMETRIC_ERROR_CANCELED
                answer(null, if (cancelled) null else errString.toString())
            }
        })
    }
}
