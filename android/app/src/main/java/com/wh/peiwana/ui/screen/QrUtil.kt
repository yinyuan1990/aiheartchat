package com.wh.peiwana.ui.screen

import android.graphics.Bitmap
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.journeyapps.barcodescanner.CaptureActivity

/** 竖屏扫码页（zxing-embedded 默认横屏） */
class PortraitCaptureActivity : CaptureActivity()

/** 收款码内容格式：peiwan://pay?sid=6位ID */
fun payQrContent(sid: String) = "peiwan://pay?sid=$sid"

/** 从扫码结果里提取 6 位 ID（兼容 peiwan://pay?sid=xxx 和纯数字） */
fun parsePaySid(text: String): String? {
    Regex("sid=(\\d{6})").find(text)?.let { return it.groupValues[1] }
    val digits = text.filter { it.isDigit() }
    return if (digits.length == 6) digits else null
}

/** 群邀请码内容格式：peiwan://group?code=8位邀请码 */
fun groupQrContent(code: String) = "peiwan://group?code=$code"

/** 从扫码结果里提取群邀请码（兼容 peiwan://group?code=xxx 和纯码） */
fun parseGroupCode(text: String): String? {
    Regex("code=([A-Za-z0-9]{6,12})").find(text)?.let { return it.groupValues[1].uppercase() }
    val t = text.trim().uppercase()
    return if (Regex("^[A-Z0-9]{6,12}$").matches(t)) t else null
}

/** 生成二维码 Bitmap */
fun makeQrBitmap(text: String, size: Int = 640): Bitmap {
    val matrix = QRCodeWriter().encode(
        text, BarcodeFormat.QR_CODE, size, size,
        mapOf(EncodeHintType.MARGIN to 1),
    )
    val pixels = IntArray(size * size)
    for (y in 0 until size) {
        for (x in 0 until size) {
            pixels[y * size + x] = if (matrix.get(x, y)) android.graphics.Color.BLACK else android.graphics.Color.WHITE
        }
    }
    return Bitmap.createBitmap(pixels, size, size, Bitmap.Config.ARGB_8888)
}

/** 保存二维码到系统相册 */
fun saveQrToGallery(context: android.content.Context, bitmap: Bitmap): Boolean = runCatching {
    val values = android.content.ContentValues().apply {
        put(android.provider.MediaStore.Images.Media.DISPLAY_NAME, "收款码_${System.currentTimeMillis()}.png")
        put(android.provider.MediaStore.Images.Media.MIME_TYPE, "image/png")
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
            put(android.provider.MediaStore.Images.Media.RELATIVE_PATH, android.os.Environment.DIRECTORY_PICTURES)
        }
    }
    val uri = context.contentResolver.insert(android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
        ?: return@runCatching false
    context.contentResolver.openOutputStream(uri)?.use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    true
}.getOrDefault(false)

/** 调系统分享面板分享二维码图片 */
fun shareQr(context: android.content.Context, bitmap: Bitmap) {
    runCatching {
        val file = java.io.File(context.cacheDir, "share_qr.png")
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        val uri = androidx.core.content.FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        val intent = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
            type = "image/png"
            putExtra(android.content.Intent.EXTRA_STREAM, uri)
            addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        context.startActivity(android.content.Intent.createChooser(intent, "分享收款码"))
    }
}
