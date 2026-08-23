package auth

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"
)

// Token 有效期（产品约定）：
//   - MainTokenTTL：登录 token，7 天；
//   - ResourceTokenTTL：文件直链 token，12 小时（用户明确「时间短」即可，
//     绑定 workspace+path 防越权访问其它文件）。
const (
	MainTokenTTL     = 7 * 24 * time.Hour
	ResourceTokenTTL = 12 * time.Hour
)

// 内存控制：token 上限与后台清理周期（P0 优化，防无界增长 + 消 O(n) 热点）
const (
	tokenMaxEntries      = 5000
	tokenCleanupInterval = 5 * time.Minute
)

// TokenKind 区分主 token（登录态）与资源 token（文件直链）。
type TokenKind int

const (
	// TokenKindMain 主 token：Authorization Bearer 携带，不进 URL。
	TokenKindMain TokenKind = iota
	// TokenKindResource 资源 token：仅存在于直链 URL 的 ?token=，
	// 与主 token 分离，即使出现在访问日志中也不会泄露登录态。
	TokenKindResource
)

// tokenEntry 单个 token 条目。
type tokenEntry struct {
	kind      TokenKind
	username  string // 仅主 token：签发时的用户名
	workspace string // 仅资源 token：绑定的 workspace id
	path      string // 仅资源 token：绑定的相对路径
	expiresAt time.Time
}

// TokenStore 内存 token 存储。
//
// 实现：map + Mutex，过期项懒清理（校验时顺带删除）。
// 单用户量级（几个浏览器 tab）下条目数极少，无需第三方缓存组件（如 freecache），
// 标准库足够且逻辑完全可控。
type TokenStore struct {
	mu      sync.Mutex
	entries map[string]*tokenEntry
}

// NewTokenStore 创建 token 存储，并启动后台过期清理（每 5 分钟全扫一次）。
func NewTokenStore() *TokenStore {
	s := &TokenStore{entries: make(map[string]*tokenEntry)}
	go s.cleanupLoop()
	return s
}

// cleanupLoop 后台定时清理过期 token，避免 issue 路径 O(n) 全扫。
func (s *TokenStore) cleanupLoop() {
	ticker := time.NewTicker(tokenCleanupInterval)
	defer ticker.Stop()
	for range ticker.C {
		s.cleanExpired()
	}
}

// cleanExpired 删除所有过期条目（后台周期调用，O(n) 但低频）。
func (s *TokenStore) cleanExpired() {
	now := time.Now()
	s.mu.Lock()
	for k, e := range s.entries {
		if now.After(e.expiresAt) {
			delete(s.entries, k)
		}
	}
	s.mu.Unlock()
}

// IssueMain 签发主 token（登录态），TTL 7 天。
func (s *TokenStore) IssueMain(username string) string {
	return s.issue(&tokenEntry{
		kind:      TokenKindMain,
		username:  username,
		expiresAt: time.Now().Add(MainTokenTTL),
	})
}

// IssueResource 签发资源 token（文件直链），TTL 12 小时，绑定 workspace 与 path。
func (s *TokenStore) IssueResource(workspace, path string) string {
	return s.issue(&tokenEntry{
		kind:      TokenKindResource,
		workspace: workspace,
		path:      path,
		expiresAt: time.Now().Add(ResourceTokenTTL),
	})
}

// issue 生成随机 token 并写入存储。
// P0 优化：不再每次全扫 O(n)；仅在接近上限时触发一次清理，命中过期项的清理在 Validate 路径单条删除。
func (s *TokenStore) issue(entry *tokenEntry) string {
	token := newTokenValue()
	s.mu.Lock()
	// 仅当条目数接近上限时做一次过期清理，避免无界增长
	if len(s.entries) >= tokenMaxEntries {
		now := time.Now()
		for k, e := range s.entries {
			if now.After(e.expiresAt) {
				delete(s.entries, k)
			}
		}
		// 仍超限则淘汰一个最旧条目（map 随机首项），保证有界
		if len(s.entries) >= tokenMaxEntries {
			for k := range s.entries {
				delete(s.entries, k)
				break
			}
		}
	}
	s.entries[token] = entry
	s.mu.Unlock()
	return token
}
// ValidateMain 校验主 token；有效返回持有者 username，过期/不存在/类型不符返回 false。
func (s *TokenStore) ValidateMain(token string) (username string, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, exists := s.entries[token]
	if !exists || time.Now().After(e.expiresAt) {
		delete(s.entries, token) // 懒清理过期项
		return "", false
	}
	if e.kind != TokenKindMain {
		return "", false
	}
	return e.username, true
}

// ValidateResource 校验资源 token 且绑定匹配（workspace/path 任一不符视为无效，
// 防止一个直链 token 被用于访问其它文件）。
func (s *TokenStore) ValidateResource(token, workspace, path string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, exists := s.entries[token]
	if !exists || time.Now().After(e.expiresAt) {
		delete(s.entries, token)
		return false
	}
	return e.kind == TokenKindResource && e.workspace == workspace && e.path == path
}

// RevokeAll 吊销全部 token（凭证变更时调用，使现有登录态全部失效）。
func (s *TokenStore) RevokeAll() {
	s.mu.Lock()
	s.entries = make(map[string]*tokenEntry)
	s.mu.Unlock()
}

// newTokenValue 生成随机 token：crypto/rand 32 字节 → 64 位 hex。
// 仅含字母数字，兼容 WebSocket Sec-WebSocket-Protocol 子协议的字符集限制
// （RFC 7230 tchar，不含逗号/空格等分隔符）。
func newTokenValue() string {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		// crypto/rand 失败属于系统性问题；token 安全依赖随机性，不能静默降级
		panic("auth: crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(buf)
}
