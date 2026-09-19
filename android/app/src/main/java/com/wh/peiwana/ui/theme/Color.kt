package com.wh.peiwana.ui.theme

import androidx.compose.ui.graphics.Color

// 浅色主题（对齐 Telegram iOS 浅色：白底、浅灰次级背景、近黑文字、灰色辅助文字）+ 玫红渐变强调色
// 2026-09-19 由纯黑沉浸切换：纯黑底白字长时间看费眼
val Bg = Color(0xFFFFFFFF)
/** 卡片 / 顶栏 / 底栏 */
val Bg2 = Color(0xFFF5F5F8)
/** 输入框 / 未选中胶囊 / 对方气泡 */
val Bg3 = Color(0xFFEBEBF0)
val Line = Color(0xFFE5E5EA)
val TextMain = Color(0xFF111114)
val TextSub = Color(0xFF8E8E93)
val TextDim = Color(0xFFB5B5BC)
val Accent = Color(0xFFFE2C55)
val Accent2 = Color(0xFFFF6B81)
val Danger = Color(0xFFFF4D4F)
val Success = Color(0xFF0BD07D)
val Warn = Color(0xFFE6A100)
/** 自己消息气泡：浅玫红底 + 深色文字（浅色主题下不再用白字） */
val BubbleMine = Color(0xFFFFE1E7)

// 兼容旧引用名（映射到玫红系）
val Gold = Accent
val Gold2 = Accent2
val GoldDim = Color(0x59FE2C55)
