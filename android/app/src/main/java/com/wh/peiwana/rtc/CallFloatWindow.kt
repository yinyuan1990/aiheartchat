package com.wh.peiwana.rtc

import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import coil.imageLoader
import coil.request.ImageRequest
import coil.transform.CircleCropTransformation
import com.wh.peiwana.net.Api

/**
 * 来电悬浮窗（微信式）：App 在后台时弹出，显示对方头像/昵称 + 接听/拒绝。
 * 需要「显示在其他应用上层」权限（登录后引导授权）。
 */
object CallFloatWindow {
    private var view: View? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    fun show(ctx: Context, name: String, avatar: String, type: Int) {
        mainHandler.post {
            if (view != null) return@post
            val canOverlay = runCatching {
                Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(ctx)
            }.getOrDefault(false)
            if (!canOverlay) return@post

            runCatching {
                val wm = ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager
                val density = ctx.resources.displayMetrics.density
                fun dp(v: Int) = (v * density).toInt()

                val card = LinearLayout(ctx).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(dp(14), dp(12), dp(14), dp(12))
                    background = GradientDrawable().apply {
                        cornerRadius = dp(16).toFloat()
                        setColor(0xF21A1A20.toInt())
                    }
                }

                // 头像
                val avatarView = ImageView(ctx).apply {
                    layoutParams = LinearLayout.LayoutParams(dp(48), dp(48))
                }
                if (avatar.isNotEmpty()) {
                    ctx.imageLoader.enqueue(
                        ImageRequest.Builder(ctx)
                            .data(Api.fullUrl(avatar))
                            .transformations(CircleCropTransformation())
                            .target(avatarView)
                            .build(),
                    )
                } else {
                    avatarView.background = GradientDrawable().apply {
                        shape = GradientDrawable.OVAL
                        setColor(0xFF2A2A30.toInt())
                    }
                }
                card.addView(avatarView)

                // 昵称 + 文案
                val textCol = LinearLayout(ctx).apply {
                    orientation = LinearLayout.VERTICAL
                    layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
                        marginStart = dp(12)
                        marginEnd = dp(10)
                    }
                }
                textCol.addView(TextView(ctx).apply {
                    text = name.ifEmpty { "来电" }
                    setTextColor(Color.WHITE)
                    textSize = 16f
                    typeface = Typeface.DEFAULT_BOLD
                    maxLines = 1
                })
                textCol.addView(TextView(ctx).apply {
                    text = if (type == 2) "邀请你进行视频通话" else "邀请你进行语音通话"
                    setTextColor(0xFF8A8A93.toInt())
                    textSize = 13f
                    maxLines = 1
                })
                card.addView(textCol)

                // 拒绝 / 接听 圆形按钮
                fun circleButton(bg: Int, symbol: String, onClick: () -> Unit): FrameLayout =
                    FrameLayout(ctx).apply {
                        layoutParams = LinearLayout.LayoutParams(dp(44), dp(44)).apply { marginStart = dp(8) }
                        background = GradientDrawable().apply {
                            shape = GradientDrawable.OVAL
                            setColor(bg)
                        }
                        addView(TextView(ctx).apply {
                            text = symbol
                            setTextColor(Color.WHITE)
                            textSize = 18f
                            gravity = Gravity.CENTER
                            layoutParams = FrameLayout.LayoutParams(
                                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT,
                            )
                        })
                        setOnClickListener { onClick() }
                    }

                card.addView(circleButton(0xFFFA4545.toInt(), "✕") {
                    CallManager.reject()
                    hide()
                })
                card.addView(circleButton(0xFF0DC76B.toInt(), "✓") {
                    hide()
                    // 回到前台，来电界面已在显示，直接接听
                    runCatching {
                        val intent = Intent(ctx, Class.forName("com.wh.peiwana.MainActivity")).apply {
                            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
                        }
                        ctx.startActivity(intent)
                    }
                    CallManager.attachContext(ctx)
                    CallManager.accept(ctx)
                })

                val layoutType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                } else {
                    @Suppress("DEPRECATION")
                    WindowManager.LayoutParams.TYPE_PHONE
                }
                val params = WindowManager.LayoutParams(
                    WindowManager.LayoutParams.MATCH_PARENT,
                    WindowManager.LayoutParams.WRAP_CONTENT,
                    layoutType,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
                    PixelFormat.TRANSLUCENT,
                ).apply {
                    gravity = Gravity.TOP
                    y = dp(48)
                    horizontalMargin = 0.03f
                }

                wm.addView(card, params)
                view = card
            }
        }
    }

    fun hide() {
        mainHandler.post {
            view?.let { v ->
                runCatching {
                    (v.context.getSystemService(Context.WINDOW_SERVICE) as WindowManager).removeView(v)
                }
            }
            view = null
        }
    }
}
