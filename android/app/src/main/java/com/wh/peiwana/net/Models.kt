package com.wh.peiwana.net

import kotlinx.serialization.Serializable

@Serializable
data class MomentUser(
    val id: String,
    val nickname: String = "",
    val avatar: String = "",
    val age: Int = 0,
    val isGuide: Boolean = false,
    val online: Boolean = false,
    val latitude: Double? = null,
    val longitude: Double? = null,
    /** 女生视频通话实际价格（分/分钟），男生为 0 */
    val videoPriceFen: Int = 0,
    /** 正在通话中（占线） */
    val busy: Boolean = false,
)

@Serializable
data class RatingInfo(
    val avg: Int = 0,
    val count: Int = 0,
    /** 五维度均分（0-100），展示词：真实度/配合度/腿型/曲线/肤质 */
    val photo: Int = 0,
    val obedience: Int = 0,
    val legs: Int = 0,
    val chest: Int = 0,
    val skin: Int = 0,
)

/** 关注/粉丝列表条目（GET /user/follows/list） */
@Serializable
data class FollowUser(
    val id: String = "0",
    val nickname: String = "",
    val avatar: String = "",
    val age: Int = 0,
    val gender: Int = 1,
    val cityName: String = "",
    val signature: String = "",
    val isGuide: Boolean = false,
)

/** 照片墙条目（user_album） */
@Serializable
data class AlbumItem(
    val id: String = "0",
    val type: Int = 1,
    val url: String = "",
    val coverUrl: String = "",
    val sort: Int = 0,
)

/** 他人主页数据（/user/:id） */
@Serializable
data class HomeProfile(
    val id: String,
    val nickname: String = "",
    val avatar: String = "",
    val gender: Int = 0,
    val age: Int = 0,
    val cityName: String = "",
    val signature: String = "",
    val isGuide: Boolean = false,
    val following: Int = 0,
    val fans: Int = 0,
    val isFollowing: Boolean = false,
    val rating: RatingInfo? = null,
    /** 视频接通率（%），-1=暂无数据，null=男生 */
    val answerRate: Int? = null,
    val videoPriceActualFen: Int = 0,
    val online: Boolean = false,
    val busy: Boolean = false,
    val realnameVerified: Boolean = false,
    /** 照片墙（最多 8 张） */
    val albums: List<AlbumItem> = emptyList(),
)

/** 遇见列表用户卡片（/user/meet/list） */
@Serializable
data class MeetUser(
    val id: String,
    val nickname: String = "",
    val avatar: String = "",
    val gender: Int = 0,
    val age: Int = 0,
    val cityName: String = "",
    val isGuide: Boolean = false,
    val realnameVerified: Boolean = false,
    /** 0-100 平均分，显示时 /20 换算五星 */
    val ratingAvg: Int = 0,
    val ratingCount: Int = 0,
    val videoPriceFen: Int = 0,
    val online: Boolean = false,
    val busy: Boolean = false,
    /** 注册 7 天内 */
    val isNew: Boolean = false,
    /** 与我的亲密度分（0.5 粒度） */
    val intimacy: Double = 0.0,
)

/** 全局会话信息（登录后写入） */
object Session {
    var uid: String = ""
    var gender: Int = 0
    /** App 是否在前台（MainActivity 生命周期维护），后台来电用通知提醒 */
    @Volatile var foreground: Boolean = true
}

@Serializable
data class Moment(
    val id: String,
    val user: MomentUser? = null,
    val content: String = "",
    val type: Int = 1,
    val images: List<String> = emptyList(),
    val videoUrl: String = "",
    val coverUrl: String = "",
    val cityName: String = "",
    val latitude: Double? = null,
    val longitude: Double? = null,
    val likeCount: Int = 0,
    val commentCount: Int = 0,
    val liked: Boolean = false,
    val isFollowing: Boolean = false,
    val createdAt: String = "",
)

@Serializable
data class CommentItem(
    val id: String,
    val user: MomentUser? = null,
    val content: String = "",
    val imageUrl: String = "",
    val replyToNickname: String = "",
    val createdAt: String = "",
)

@Serializable
data class Person(
    val id: String,
    val nickname: String = "",
    val avatar: String = "",
    val age: Int = 0,
    val gender: Int = 0,
    val cityName: String = "",
    val signature: String = "",
    val isGuide: Boolean = false,
)

@Serializable
data class GiftDef(
    val id: Int,
    val name: String,
    val icon: String,
    val price: String,
    val count: Int = 0,
)

@Serializable
data class NotificationItem(
    val id: String,
    val kind: String,
    val title: String,
    val body: String = "",
    val refId: String = "0",
    val isRead: Boolean = false,
    val createdAt: String = "",
)

@Serializable
data class WalletData(val balance: String = "0", val frozen: String = "0")

@Serializable
data class UnreadCounts(val comment: Int = 0, val task: Int = 0)

@Serializable
data class WalletTx(
    val id: String,
    val type: String,
    val amount: String,
    val remark: String = "",
    val createdAt: String = "",
)

@Serializable
data class ContribRankItem(
    val userId: String,
    val nickname: String = "用户",
    val avatar: String = "",
    val totalFen: String = "0",
    val giftFen: String = "0",
    val callFen: String = "0",
    val msgFen: String = "0",
)

@Serializable
data class ContribRankResp(val title: String = "", val list: List<ContribRankItem> = emptyList())

@Serializable
data class ProjectItem(
    val id: Int,
    val name: String,
    val desc: String = "",
    val cover: String = "",
    val type: String = "native",
    val entry: String = "",
)

@Serializable
data class TaskOrder(
    val id: String,
    val owner: MomentUser? = null,
    val title: String = "",
    val detail: String = "",
    val meetAt: String = "",
    val cityName: String = "",
    val address: String = "",
    val reward: String = "0",
    val status: Int = 0,
    val applyCount: Int = 0,
    val takerId: String? = null,
)

@Serializable
data class TaskApplyItem(
    val id: String,
    val user: Person? = null,
    val message: String = "",
    val status: Int = 0,
)

@Serializable
data class TaskDetail(
    val id: String,
    val title: String = "",
    val detail: String = "",
    val meetAt: String = "",
    val cityName: String = "",
    val address: String = "",
    val reward: String = "0",
    val status: Int = 0,
    val isOwner: Boolean = false,
    val applies: List<TaskApplyItem> = emptyList(),
)

@Serializable
data class LookupUser(val id: String, val shortId: String, val nickname: String, val avatar: String = "")

@Serializable
data class CallConfigData(
    val width: Int = 640,
    val height: Int = 480,
    val fps: Int = 25,
    val bitrate: Int = 800,
    val srsServer: String = "",
    val whipUrl: String = "",
    val whepUrl: String = "",
    val msgPriceFen: Int = 10,
    val videoBaseFenPerMin: Int = 2,
    /** 平台倍率：平台每分钟抽成 = videoBaseFenPerMin x videoPlatformX */
    val videoPlatformX: Int = 2,
)
