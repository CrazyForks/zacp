package handlers

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/helloxz/zacp/internal/auth"
)


// AuthHandler 账号认证相关接口（登录 / 状态 / 改凭证）。
type AuthHandler struct {
	svc *auth.Service
}

// NewAuthHandler 创建认证处理器。
func NewAuthHandler(svc *auth.Service) *AuthHandler {
	return &AuthHandler{svc: svc}
}

// loginRequest 登录请求体。
type loginRequest struct {
	Username    string `json:"username"`
	Password    string `json:"password"`
	CaptchaID   string `json:"captchaId"`
	CaptchaCode string `json:"captcha"`
}

// Captcha GET /api/v1/auth/captcha
//
// 生成图形验证码（免认证，5 分钟过期，单次有效）。
// 认证未启用时也允许调用，前端可按需决定是否展示。
func (h *AuthHandler) Captcha(c *gin.Context) {
	id, b64 := h.svc.GenerateCaptcha()
	c.JSON(http.StatusOK, gin.H{
		"id":    id,
		"image": "data:image/png;base64," + b64,
	})
}

// Login POST /api/v1/auth/login
//
// 校验：IP 黑名单 → 验证码 → 用户名密码；成功签发主 token（7 天，存内存，重启失效）。
// 认证未启用时恒返回 401（前端守卫只在 enabled 时展示登录页）。
func (h *AuthHandler) Login(c *gin.Context) {
	var req loginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		writeError(c, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	clientIP := auth.ClientIP(c)
	// 1. IP 黑名单检查（5 次失败后 24 小时，重启即清）
	if h.svc.IsBlocked(clientIP) {
		writeError(c, http.StatusTooManyRequests, "ip_blocked", "IP已被拉黑，请重启服务解除限制")
		return
	}
	// 2. 验证码校验（仅认证启用时强制）
	if h.svc.Enabled() {
		if strings.TrimSpace(req.CaptchaID) == "" || strings.TrimSpace(req.CaptchaCode) == "" {
			writeError(c, http.StatusBadRequest, "captcha_required", "请输入图形验证码")
			return
		}
		if !h.svc.VerifyCaptcha(req.CaptchaID, req.CaptchaCode) {
			writeError(c, http.StatusBadRequest, "captcha_invalid", "图形验证码错误或已过期")
			return
		}
	}
	token, ok := h.svc.Login(strings.TrimSpace(req.Username), req.Password)
	if !ok {
		// 密码错误计入 IP 维度（验证码错误不计入）
		h.svc.RecordFailure(clientIP)
		// 若本次失败后刚好被拉黑，下次请求会 429；本次仍按 401 提示
		writeError(c, http.StatusUnauthorized, "invalid_credentials", "用户名或密码错误")
		return
	}
	h.svc.RecordSuccess(clientIP)
	c.JSON(http.StatusOK, gin.H{
		"token":     token,
		"tokenType": "bearer",
		"expiresIn": int(auth.MainTokenTTL.Seconds()),
		"username":  h.svc.Username(),
	})
}


// Status GET /api/v1/auth/status
//
// 返回认证启用状态。免认证：前端路由守卫依赖它决定是否拦截。
// 刻意不回传 username：该接口无需任何凭证即可访问，回传用户名会
// 与 Login 的防枚举提示（不区分「用户名不存在/密码错误」）相矛盾，
// 相当于对外公开了正确用户名，此处只暴露 enabled 布尔值。
func (h *AuthHandler) Status(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"enabled": h.svc.Enabled(),
	})
}

// authBearerToken 从 Authorization header 提取 Bearer token（与 middleware.bearerToken 同一逻辑）。
func authBearerToken(c *gin.Context) string {
	const prefix = "Bearer "
	h := c.GetHeader("Authorization")
	if len(h) > len(prefix) && strings.EqualFold(h[:len(prefix)], prefix) {
		return strings.TrimSpace(h[len(prefix):])
	}
	return ""
}

// Refresh POST /api/v1/auth/refresh
//
// 用现有主 token 换发新主 token（TTL 重置 7 天，旧 token 立即吊销、一次性有效）。
// 供前端「切换主机」时续期并探测 token 是否仍有效（token 存后端内存，
// 服务重启即全部失效，本地时间预判不可靠，以本接口结果为准）：
//   - 旧 token 有效 → 200 {token, tokenType, expiresIn, username}；
//   - 旧 token 无效/过期 → 401 unauthorized（前端据此引导重新登录）；
//   - 认证未启用 → 400 auth_disabled（正常前端不会调用，仅防御）。
func (h *AuthHandler) Refresh(c *gin.Context) {
	if !h.svc.Enabled() {
		writeError(c, http.StatusBadRequest, "auth_disabled", "认证未启用，无需刷新")
		return
	}
	newToken, expiresIn, username, err := h.svc.RefreshMain(authBearerToken(c))
	if err != nil {
		// 走到这里说明 token 在中间件校验后仍失效（并发刷新等竞态），按未登录处理
		writeError(c, http.StatusUnauthorized, "unauthorized", "未登录或登录已过期")
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"token":     newToken,
		"tokenType": "bearer",
		"expiresIn": expiresIn,
		"username":  username,
	})
}

// UpdateCredentialsRequest 修改凭证请求体。
type UpdateCredentialsRequest struct {
	Username string `json:"username"`
	// Password 为空 = 清除密码（关闭认证，恢复无需登录）；非空 = 启用认证。
	Password string `json:"password"`
}

// UpdateCredentials PUT /api/v1/auth/credentials
//
// 修改用户名/密码：热更新内存 + 原子写回 config.toml，无需重启。
// 成功后所有已签发 token 被吊销，前端应清理本地 token；
// 若新状态为启用，需用新凭证重新登录。
func (h *AuthHandler) UpdateCredentials(c *gin.Context) {
	var req UpdateCredentialsRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		writeError(c, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if err := h.svc.UpdateCredentials(req.Username, req.Password); err != nil {
		writeError(c, http.StatusBadRequest, "update_credentials_failed", err.Error())
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"enabled":  h.svc.Enabled(),
		"username": h.svc.Username(),
	})
}
