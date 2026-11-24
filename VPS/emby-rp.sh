#!/usr/bin/env bash
# =============================================================================
#  emby-rp — Emby / Jellyfin 反向代理管理器
#  单文件 · 无外部依赖 · 支持独立反代与前后端分离反代
#  引擎：Caddy（自动 HTTPS） | Nginx（配合 certbot）
#
#  设计要点
#   1. split 模式默认「不剥前缀」(keep)：源站 Emby 的 Base URL 设为 /emby，
#      官方 Web UI / WebSocket / 图片 / HLS 全部自带前缀，不会出现半残状态。
#      需要兼容 Base URL 留空的后端时用 --strip。
#   2. /emby 前缀可以随便用。
#   3. 所有落地物登记在 /etc/emby-rp 下，uninstall 按清单清除并自检残留。
#   4. 不使用 set -e，避免单条命令失败导致半途退出留下残局。
# =============================================================================
set -uo pipefail

CMD_NAME="emby-rp"
VERSION="1.1.4"

CONF_DIR="/etc/emby-rp"
SITES_DIR="$CONF_DIR/sites"
BACKUP_DIR="$CONF_DIR/backups"
BIN_PATH="/usr/local/bin/${CMD_NAME}"
ALIAS_NAME="emby"
ALIAS_PATH="/usr/local/bin/${ALIAS_NAME}"
STATE_FILE="$CONF_DIR/self.state"
ACME_WEBROOT="/var/www/emby-rp-acme"

CADDYFILE="/etc/caddy/Caddyfile"
NGINX_CONF_D="/etc/nginx/conf.d"

CADDY_BEGIN="# >>> ${CMD_NAME} managed block (do not edit) >>>"
CADDY_END="# <<< ${CMD_NAME} managed block <<<"

# ---------- 颜色 ----------
if [[ -t 1 && "${NO_COLOR:-0}" != "1" ]]; then
	C_R=$'\033[31m'; C_G=$'\033[32m'; C_Y=$'\033[33m'
	C_C=$'\033[36m'; C_D=$'\033[2m'; C_B=$'\033[1m'; C_0=$'\033[0m'
else
	C_R=''; C_G=''; C_Y=''; C_C=''; C_D=''; C_B=''; C_0=''
fi

# ---------- 输出 ----------
info() { printf '%s·%s %s\n' "$C_C" "$C_0" "$*"; }
ok()   { printf '%s✓%s %s\n' "$C_G" "$C_0" "$*"; }
warn() { printf '%s!%s %s\n' "$C_Y" "$C_0" "$*" >&2; }
err()  { printf '%s×%s %s\n' "$C_R" "$C_0" "$*" >&2; }
die()  { err "$*"; exit 1; }
hr()   { printf '%s%s%s\n' "$C_D" "$(printf '─%.0s' $(seq 1 58))" "$C_0"; }
# 提示符走 stderr，答案走 stdout —— 这样 a="$(ask ...)" 只拿到答案
ask()  { local p="$1" d="${2:-}" a; printf '%s?%s %s' "$C_C" "$C_0" "$p" >&2; if [[ -n "$d" ]]; then printf ' %s[%s]%s' "$C_D" "$d" "$C_0" >&2; fi; printf ': ' >&2; read -r a || a=""; printf '%s' "${a:-$d}"; }
ask_secret() { local p="$1" a; printf '%s?%s %s: ' "$C_C" "$C_0" "$p" >&2; read -r a || a=""; printf '%s' "$a"; }
confirm() { local p="$1" d="${2:-n}" a; [[ "${EMBY_RP_YES:-0}" == "1" ]] && return 0; a="$(ask "$p (y/N)" "$d")"; [[ "$a" =~ ^[Yy] ]]; }

# ---------- 基础工具 ----------
need_root() {	[[ "${EUID}" -eq 0 ]] || die "需要 root 权限：sudo ${CMD_NAME} $*"
}

have() { command -v "$1" >/dev/null 2>&1; }

version_ge() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" == "$2" ]]; }

strip_trailing_slash() { local v="$1"; while [[ "$v" != "/" && "$v" == */ ]]; do v="${v%/}"; done; printf '%s' "$v"; }

gen_name_from_domain() {
	local d="$1"
	printf '%s' "$d" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//' | cut -c1-32
}

default_email_for() { printf 'admin@%s' "$1"; }

detect_pkg_mgr() {
	if have apt-get; then printf 'apt'
	elif have dnf; then printf 'dnf'
	elif have yum; then printf 'yum'
	elif have apk; then printf 'apk'
	else printf 'unknown'
	fi
}

pkg_install() {
	local mgr; mgr="$(detect_pkg_mgr)"
	case "$mgr" in
		apt) DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null 2>&1 ;;
		dnf) dnf install -y -q "$@" >/dev/null 2>&1 ;;
		yum) yum install -y -q "$@" >/dev/null 2>&1 ;;
		apk) apk add --no-cache "$@" >/dev/null 2>&1 ;;
		*)   return 1 ;;
	esac
}

# ---------- 自记录（卸载用清单） ----------
state_set() {
	local k="$1" v="${2:-}"
	mkdir -p "$CONF_DIR"
	touch "$STATE_FILE"
	if grep -q "^${k}=" "$STATE_FILE" 2>/dev/null; then
		sed -i "s|^${k}=.*|${k}=${v}|" "$STATE_FILE"
	else
		printf '%s=%s\n' "$k" "$v" >> "$STATE_FILE"
	fi
}

state_get() {
	local k="$1" d="${2:-}"
	[[ -f "$STATE_FILE" ]] || { printf '%s' "$d"; return; }
	local v; v="$(sed -n "s|^${k}=||p" "$STATE_FILE" | head -n1)"
	printf '%s' "${v:-$d}"
}

# ---------- 站点元数据 ----------
reset_site_vars() {
	SITE_NAME=""; SITE_DOMAIN=""; SITE_ENGINE="caddy"; SITE_MODE="standalone"
	SITE_PREFIX="/emby"; SITE_STRIP=0
	SITE_FRONTEND=""; SITE_UPSTREAM=""
	SITE_TLS="auto"; SITE_CERT=""; SITE_KEY=""; SITE_EMAIL=""
	SITE_HTTP_PORT="80"; SITE_HTTPS_PORT="443"
	SITE_CF=0; SITE_UPSTREAM_INSECURE=0; SITE_ACCESS_LOG=1
	SITE_HTTP2="off"
	SITE_HOST_MODE="upstream"; SITE_HOST_VALUE=""; SITE_REWRITES=""
	SITE_CREATED=""; FRONTEND_CREATED=0
}
reset_site_vars

load_site() {
	local name="${1:-}" f
	[[ -n "$name" ]] || return 1
	f="$SITES_DIR/${name}.conf"
	[[ -f "$f" ]] || return 1
	reset_site_vars
	# shellcheck disable=SC1090
	. "$f"
	SITE_NAME="$name"
	return 0
}

save_site() {
	mkdir -p "$SITES_DIR"
	local f="$SITES_DIR/${SITE_NAME}.conf"
	{
		printf 'SITE_NAME=%q\n'      "$SITE_NAME"
		printf 'SITE_DOMAIN=%q\n'    "$SITE_DOMAIN"
		printf 'SITE_ENGINE=%q\n'    "$SITE_ENGINE"
		printf 'SITE_MODE=%q\n'      "$SITE_MODE"
		printf 'SITE_PREFIX=%q\n'    "$SITE_PREFIX"
		printf 'SITE_STRIP=%q\n'     "$SITE_STRIP"
		printf 'SITE_FRONTEND=%q\n'  "$SITE_FRONTEND"
		printf 'SITE_UPSTREAM=%q\n'  "$SITE_UPSTREAM"
		printf 'SITE_TLS=%q\n'       "$SITE_TLS"
		printf 'SITE_CERT=%q\n'      "$SITE_CERT"
		printf 'SITE_KEY=%q\n'       "$SITE_KEY"
		printf 'SITE_EMAIL=%q\n'     "$SITE_EMAIL"
		printf 'SITE_HTTP_PORT=%q\n' "$SITE_HTTP_PORT"
		printf 'SITE_HTTPS_PORT=%q\n' "$SITE_HTTPS_PORT"
		printf 'SITE_HTTP2=%q\n'    "${SITE_HTTP2:-off}"
		printf 'SITE_CF=%q\n'        "$SITE_CF"
		printf 'SITE_UPSTREAM_INSECURE=%q\n' "$SITE_UPSTREAM_INSECURE"
		printf 'SITE_ACCESS_LOG=%q\n' "$SITE_ACCESS_LOG"
		printf 'SITE_HOST_MODE=%q\n' "${SITE_HOST_MODE:-upstream}"
		printf 'SITE_HOST_VALUE=%q\n' "${SITE_HOST_VALUE:-}"
		printf 'SITE_REWRITES=%q\n' "${SITE_REWRITES:-}"
		printf 'SITE_CREATED=%q\n'   "${SITE_CREATED:-$(date '+%F %T')}"
		printf 'FRONTEND_CREATED=%q\n' "$FRONTEND_CREATED"
	} > "$f"
}

list_site_names() {
	[[ -d "$SITES_DIR" ]] || return 0
	local f
	for f in "$SITES_DIR"/*.conf; do
		[[ -e "$f" ]] || continue
		basename "$f" .conf
	done
}

site_count() { list_site_names | grep -c . || true; }

# =============================================================================
#  引擎层
# =============================================================================
CADDY_LOG_DIR="/var/log/caddy"
NGINX_LOG_DIR="/var/log/nginx"

engine_running() {
	case "$1" in
		caddy) systemctl is-active --quiet caddy 2>/dev/null ;;
		nginx) systemctl is-active --quiet nginx 2>/dev/null ;;
		*) return 1 ;;
	esac
}

engine_installed() { have "$1"; }

port_holders() {
	local p="$1"
	ss -lntp 2>/dev/null | awk -v p=":$p" '$4 ~ p"$" {print $4, $6}' | sort -u
}

port_in_use() {
	ss -lnt 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1$"
}

install_caddy() {
	if engine_installed caddy; then
		ok "Caddy 已安装：$(caddy version 2>/dev/null | head -n1)"
		[[ "$(state_get ENGINE_CADDY_PREEXISTING 0)" == "1" ]] || state_set ENGINE_CADDY_PREEXISTING 1
		return 0
	fi
	local mgr; mgr="$(detect_pkg_mgr)"
	[[ "$mgr" == "apt" ]] || die "自动安装 Caddy 仅支持 apt 系发行版；请先手动安装 caddy。"
	info "添加 Caddy 官方软件源……"
	pkg_install curl gnupg2 ca-certificates debian-keyring debian-archive-keyring apt-transport-https || true
	mkdir -p /usr/share/keyrings
	if curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
		| gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null; then
		curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
			> /etc/apt/sources.list.d/caddy-stable.list || true
		state_set CADDY_REPO_ADDED 1
	else
		warn "Cloudsmith GPG 获取失败，尝试发行版自带软件源。"
	fi
	apt-get update -qq || true
	if ! pkg_install caddy; then
		die "Caddy 安装失败。请手动安装后重试，或改用 --engine nginx。"
	fi
	state_set ENGINE_CADDY_INSTALLED_BY_US 1
	systemctl enable --now caddy >/dev/null 2>&1 || true
	caddy_prepare_dirs
	ok "Caddy 安装完成：$(caddy version 2>/dev/null | head -n1)"
}

install_nginx() {
	if engine_installed nginx; then
		ok "Nginx 已安装：$(nginx -v 2>&1)"
		[[ "$(state_get ENGINE_NGINX_PREEXISTING 0)" == "1" ]] || state_set ENGINE_NGINX_PREEXISTING 1
		return 0
	fi
	pkg_install nginx || die "Nginx 安装失败。"
	state_set ENGINE_NGINX_INSTALLED_BY_US 1
	systemctl enable --now nginx >/dev/null 2>&1 || true
	ok "Nginx 安装完成：$(nginx -v 2>&1)"
}

install_certbot() {
	engine_installed certbot && { ok "certbot 已安装：$(certbot --version 2>&1)"; return 0; }
	pkg_install certbot || die "certbot 安装失败。"
	state_set CERTBOT_INSTALLED_BY_US 1
	ok "certbot 安装完成：$(certbot --version 2>&1)"
}

caddy_site_path() { printf '%s/%s.caddy' "$SITES_DIR" "$1"; }

# caddy 以非 root 用户运行，日志目录必须归它所有，否则启动时打不开日志文件
caddy_service_user() {
	local u; u="$(systemctl show -p User --value caddy 2>/dev/null)"
	[[ -n "$u" ]] || u="caddy"
	id -u "$u" >/dev/null 2>&1 || u="root"
	printf '%s' "$u"
}

caddy_prepare_dirs() {
	mkdir -p "$CADDY_LOG_DIR"
	local u g
	u="$(caddy_service_user)"
	g="$(systemctl show -p Group --value caddy 2>/dev/null)"
	[[ -n "$g" ]] || g="$u"
	if [[ "$u" != "root" ]]; then
		chown "$u:$g" "$CADDY_LOG_DIR" 2>/dev/null || true
		# 之前用 root 跑 validate 可能留下 root 属主的日志文件
		find "$CADDY_LOG_DIR" -maxdepth 1 -name 'emby-rp-*' -exec chown "$u:$g" {} + 2>/dev/null || true
	fi
	chmod 755 "$CADDY_LOG_DIR" 2>/dev/null || true
}
nginx_site_path() { printf '%s/%s-%s.conf' "$NGINX_CONF_D" "emby-rp" "$1"; }

caddy_ensure_block() {
	mkdir -p "$SITES_DIR" "$BACKUP_DIR"
	touch "$CADDYFILE"
	if grep -qF "$CADDY_BEGIN" "$CADDYFILE"; then return 0; fi
	cp -a "$CADDYFILE" "$BACKUP_DIR/Caddyfile.$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true
	{
		printf '\n%s\n' "$CADDY_BEGIN"
		printf 'import %s/*.caddy\n' "$SITES_DIR"
		printf '%s\n' "$CADDY_END"
	} >> "$CADDYFILE"
}

caddy_remove_block() {
	[[ -f "$CADDYFILE" ]] || return 0
	grep -qF "$CADDY_BEGIN" "$CADDYFILE" || return 0
	cp -a "$CADDYFILE" "$BACKUP_DIR/Caddyfile.$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true
	awk -v b="$CADDY_BEGIN" -v e="$CADDY_END" '
		index($0,b)==1 {skip=1; next}
		index($0,e)==1 {skip=0; next}
		!skip {print}
	' "$CADDYFILE" > "$CADDYFILE.tmp" && mv "$CADDYFILE.tmp" "$CADDYFILE"
}

caddyfile_has_content() {
	[[ -f "$CADDYFILE" ]] || return 1
	grep -qvE '^[[:space:]]*(#|$)' "$CADDYFILE"
}

wait_active() {
	local unit="$1" i=0
	while [[ $i -lt 12 ]]; do
		systemctl is-active --quiet "$unit" 2>/dev/null && return 0
		sleep 0.5
		i=$((i + 1))
	done
	return 1
}

apply_caddy() {
	local out u
	if caddyfile_has_content; then
		u="$(caddy_service_user)"
		# 用服务用户跑 validate，否则 root 会顺手创建 root 属主的日志文件，导致 caddy 启动失败
		if [[ "$u" != "root" ]]; then
			local uhome
			uhome="$(getent passwd "$u" | cut -d: -f6)"
			[[ -n "$uhome" ]] || uhome="/var/lib/caddy"
			out="$(su -s /bin/sh "$u" -c "HOME='$uhome' caddy validate --config '$CADDYFILE' --adapter caddyfile" 2>&1)"
		else
			out="$(caddy validate --config "$CADDYFILE" --adapter caddyfile 2>&1)"
		fi
		if [[ $? -ne 0 ]]; then
			printf '%s\n' "$out" >&2
			return 1
		fi
	fi
	out="$(systemctl reload caddy 2>&1)"
	if [[ $? -ne 0 ]]; then
		warn "caddy reload 失败：${out:-无输出}"
		out="$(systemctl restart caddy 2>&1)"
		[[ $? -ne 0 ]] && warn "caddy restart 失败：${out:-无输出}"
	fi
	if wait_active caddy; then return 0; fi
	err "caddy 未能进入 running 状态，最近日志："
	journalctl -u caddy -n 12 --no-pager 2>/dev/null | tail -12 >&2
	return 1
}

apply_nginx() {
	local out
	if ! out="$(nginx -t 2>&1)"; then
		printf '%s\n' "$out" >&2
		return 1
	fi
	out="$(systemctl reload nginx 2>&1)"
	if [[ $? -ne 0 ]]; then
		warn "nginx reload 失败：${out:-无输出}"
		out="$(systemctl restart nginx 2>&1)"
		[[ $? -ne 0 ]] && warn "nginx restart 失败：${out:-无输出}"
	fi
	if wait_active nginx; then return 0; fi
	err "nginx 未能进入 running 状态，最近日志："
	journalctl -u nginx -n 12 --no-pager 2>/dev/null | tail -12 >&2
	return 1
}

nginx_listen_ssl_lines() {
	local v v6="" h2=""
	v="$(nginx -v 2>&1 | sed -n 's#.*nginx/\([0-9][0-9.]*\).*#\1#p')"
	ipv6_enabled && v6="yes"
	[[ "${SITE_HTTP2:-off}" == "on" ]] && h2="yes"
	if [[ -n "$v" ]] && version_ge "$v" "1.25.1"; then
		printf '    listen %s ssl;\n' "$SITE_HTTPS_PORT"
		[[ -n "$v6" ]] && printf '    listen [::]:%s ssl;\n' "$SITE_HTTPS_PORT"
		# 显式写 off：全局 http{} 层若开了 http2 on，server 会继承，省略指令关不掉
		if [[ -n "$h2" ]]; then printf '    http2 on;\n'; else printf '    http2 off;\n'; fi
	elif [[ -n "$h2" ]]; then
		printf '    listen %s ssl http2;\n' "$SITE_HTTPS_PORT"
		[[ -n "$v6" ]] && printf '    listen [::]:%s ssl http2;\n' "$SITE_HTTPS_PORT"
	else
		printf '    listen %s ssl;\n' "$SITE_HTTPS_PORT"
		[[ -n "$v6" ]] && printf '    listen [::]:%s ssl;\n' "$SITE_HTTPS_PORT"
	fi
}

# =============================================================================
#  配置渲染层
# =============================================================================

SITE_HEAD_COMMENT() {
	printf '# ---------------------------------------------------------------\n'
	printf '# %s %s  ·  site: %s  ·  engine: %s  ·  mode: %s\n' \
		"$CMD_NAME" "$VERSION" "$SITE_NAME" "$SITE_ENGINE" "$SITE_MODE"
	printf '# domain:   %s\n' "$SITE_DOMAIN"
	printf '# upstream: %s\n' "$SITE_UPSTREAM"
	if [[ "$SITE_MODE" == "split" ]]; then
		printf '# frontend: %s   prefix: %s  (%s)\n' "$SITE_FRONTEND" "$SITE_PREFIX" \
			"$([[ "$SITE_STRIP" == "1" ]] && printf 'strip 前缀被剥离' || printf 'keep 前缀保留')"
	fi
	printf '# tls:      %s\n' "$SITE_TLS"
	[[ "$SITE_ENGINE" == "nginx" ]] && printf '# http2:    %s\n' "${SITE_HTTP2:-off}"
	printf '# generated: %s\n' "$(date '+%F %T')"
	printf '# 手工修改会在下一次 add/remove 时被覆盖\n'
	printf '# ---------------------------------------------------------------\n'
}

# ---------- Caddy ----------
caddy_proxy_block() {
	local ind="$1" upstream="$2" pubprefix="${3:-}"
	local hostport url_scheme ip_expr
	url_scheme="http"
	[[ "$upstream" == https://* ]] && url_scheme="https"
	hostport="${upstream#*://}"
	hostport="$(strip_trailing_slash "$hostport")"
	# 上游未写端口时补全默认端口（否则 https 源站会被误发到 80）
	if [[ "$hostport" != *:* ]]; then
		hostport="${hostport}:$( [[ "$url_scheme" == "https" ]] && printf 443 || printf 80 )"
	fi
	ip_expr='{remote_host}'
	[[ "$SITE_CF" == "1" ]] && ip_expr='{http.request.header.Cf-Connecting-Ip}'

	printf '%sreverse_proxy %s {\n' "$ind" "$hostport"
	printf '%s\tflush_interval -1\n' "$ind"
	printf '%s\ttransport http {\n' "$ind"
	printf '%s\t\tdial_timeout 10s\n' "$ind"
	printf '%s\t\tresponse_header_timeout 0\n' "$ind"
	if [[ "$url_scheme" == "https" ]]; then
		printf '%s\t\ttls\n' "$ind"
		[[ "$SITE_UPSTREAM_INSECURE" == "1" ]] && printf '%s\t\ttls_insecure_skip_verify\n' "$ind"
	fi
	printf '%s\t}\n' "$ind"
	local host_up
	case "${SITE_HOST_MODE:-upstream}" in
		client)        host_up='{host}' ;;
		upstream-port) host_up='{upstream_hostport}' ;;
		value)         host_up="${SITE_HOST_VALUE}" ;;
		*)             host_up="$(upstream_host_only "$SITE_UPSTREAM")" ;;
	esac
	printf '%s\theader_up Host %s\n' "$ind" "$host_up"
	printf '%s\theader_up X-Real-IP %s\n' "$ind" "$ip_expr"
	# X-Forwarded-Proto / Host 由 reverse_proxy 默认透传，无需重复设置
	[[ -n "$pubprefix" ]] && printf '%s\theader_up X-Forwarded-Prefix %s\n' "$ind" "$pubprefix"
	printf '%s}\n' "$ind"
}

caddy_frontend_block() {
	local ind="$1"
	case "$SITE_FRONTEND" in
		dir:*)
			printf '%shandle {\n' "$ind"
			printf '%s\troot * %s\n' "$ind" "${SITE_FRONTEND#dir:}"
			printf '%s\ttry_files {path} /index.html\n' "$ind"
			printf '%s\tfile_server\n' "$ind"
			printf '%s}\n' "$ind"
			;;
		http://*|https://*)
			printf '%shandle {\n' "$ind"
			printf '%s\treverse_proxy %s {\n' "$ind" "$SITE_FRONTEND"
			printf '%s\t\tflush_interval -1\n' "$ind"
			printf '%s\t\theader_up Host {host}\n' "$ind"
			printf '%s\t}\n' "$ind"
			printf '%s}\n' "$ind"
			;;
	esac
}

render_caddy() {
	local site_addr
	if [[ "$SITE_TLS" == "none" ]]; then
		if [[ "$SITE_HTTP_PORT" == "80" ]]; then site_addr="http://${SITE_DOMAIN}"
		else site_addr="http://${SITE_DOMAIN}:${SITE_HTTP_PORT}"; fi
	else
		if [[ "$SITE_HTTPS_PORT" == "443" ]]; then site_addr="${SITE_DOMAIN}"
		else site_addr="${SITE_DOMAIN}:${SITE_HTTPS_PORT}"; fi
	fi

	SITE_HEAD_COMMENT
	printf '%s {\n' "$site_addr"

	if [[ "$SITE_TLS" == "auto" ]]; then
		[[ -n "$SITE_EMAIL" ]] && printf '\ttls %s\n' "$SITE_EMAIL"
	elif [[ "$SITE_TLS" == "file" ]]; then
		printf '\ttls %s %s\n' "$SITE_CERT" "$SITE_KEY"
	fi

	if [[ "$SITE_ACCESS_LOG" == "1" ]]; then
		printf '\tlog {\n'
		printf '\t\toutput file %s/%s-%s.log {\n' "$CADDY_LOG_DIR" "emby-rp" "$SITE_NAME"
		printf '\t\t\troll_size 20MiB\n'
		printf '\t\t\troll_keep 5\n'
		printf '\t\t}\n'
		printf '\t\tlevel INFO\n'
		printf '\t}\n'
	fi

	printf '\tencode zstd gzip\n\n'
	printf '\thandle /_emby_rp_health {\n'
	printf '\t\trespond "ok" 200\n'
	printf '\t}\n\n'

	if [[ "$SITE_MODE" == "split" ]]; then
		if [[ "$SITE_STRIP" == "1" ]]; then
			printf '\t# API/WebSocket：前缀在回源前被剥离（源站 Base URL 必须留空）\n'
			printf '\thandle_path %s/* {\n' "$SITE_PREFIX"
		else
			printf '\t# API/WebSocket：前缀原样回源（源站 Base URL 设为 %s）\n' "$SITE_PREFIX"
			printf '\thandle %s/* {\n' "$SITE_PREFIX"
		fi
		caddy_proxy_block $'\t\t' "$SITE_UPSTREAM" "$SITE_PREFIX"
		printf '\t}\n\n'
		printf '\thandle %s {\n\t\tredir * %s/ 308\n\t}\n\n' "$SITE_PREFIX" "$SITE_PREFIX"
		caddy_frontend_block $'\t'
	else
		caddy_proxy_block $'\t' "$SITE_UPSTREAM" ""
	fi
	printf '}\n'
}

# ---------- Nginx ----------
nginx_proxy_common() {
	local ind="$1" mapvar="$2" pubprefix="${3:-}"
	printf '%sproxy_http_version 1.1;\n' "$ind"
	printf '%sproxy_set_header Upgrade $http_upgrade;\n' "$ind"
	printf '%sproxy_set_header Connection $emby_rp_conn_%s;\n' "$ind" "$mapvar"
	case "${SITE_HOST_MODE:-upstream}" in
		client)        printf '%sproxy_set_header Host $host;\n' "$ind" ;;
		upstream-port) printf '%sproxy_set_header Host $proxy_host;\n' "$ind" ;;
		value)         printf '%sproxy_set_header Host %s;\n' "$ind" "${SITE_HOST_VALUE}" ;;
		*)             printf '%sproxy_set_header Host %s;\n' "$ind" "$(upstream_host_only "$SITE_UPSTREAM")" ;;
	esac
	if [[ "$SITE_CF" == "1" ]]; then
		printf '%sproxy_set_header X-Real-IP $http_cf_connecting_ip;\n' "$ind"
	else
		printf '%sproxy_set_header X-Real-IP $remote_addr;\n' "$ind"
	fi
	printf '%sproxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n' "$ind"
	printf '%sproxy_set_header X-Forwarded-Proto $scheme;\n' "$ind"
	printf '%sproxy_set_header X-Forwarded-Host $host;\n' "$ind"
	[[ -n "$pubprefix" ]] && printf '%sproxy_set_header X-Forwarded-Prefix %s;\n' "$ind" "$pubprefix"
	printf '%sproxy_buffering off;\n' "$ind"
	printf '%sproxy_request_buffering off;\n' "$ind"
	printf '%sproxy_read_timeout 3600s;\n' "$ind"
	printf '%sproxy_send_timeout 3600s;\n' "$ind"
	printf '%sproxy_max_temp_file_size 0;\n' "$ind"
	printf '%ssend_timeout 3600s;\n' "$ind"
	if [[ "$SITE_UPSTREAM_INSECURE" == "1" ]]; then
		printf '%sproxy_ssl_verify off;\n' "$ind"
	fi
	# https 上游必须带 SNI，否则 Cloudflare 会回 421 Misdirected Request
	if [[ "$SITE_UPSTREAM" == https://* ]]; then
		printf '%sproxy_ssl_server_name on;\n' "$ind"
	fi
	# 响应体替换（把上游的推流域名/旧域名换成自己的）
	if [[ -n "${SITE_REWRITES:-}" ]]; then
		local pair from to
		printf '%sproxy_set_header Accept-Encoding "";\n' "$ind"
		for pair in $SITE_REWRITES; do
			from="${pair%%=>*}"
			to="${pair#*=>}"
			[[ -n "$from" ]] || continue
			printf "%ssub_filter '%s' '%s';\n" "$ind" "$from" "$to"
			# 同一域名出现在 302 Location 里时也得换，否则客户端会追到原域名
			printf '%sproxy_redirect ~^https?://%s(.*)$ https://%s$1;\n' "$ind" "$(printf '%s' "$from" | sed 's/\./\\./g')" "$to"
		done
		printf '%ssub_filter_once off;\n' "$ind"
		printf '%ssub_filter_types *;\n' "$ind"
	fi
	return 0
}

nginx_frontend_body() {
	local ind="$1" mapvar="$2"
	case "$SITE_FRONTEND" in
		dir:*)
			printf '%slocation / {\n' "$ind"
			printf '%s    root %s;\n' "$ind" "${SITE_FRONTEND#dir:}"
			printf '%s    index index.html;\n' "$ind"
			printf '%s    try_files $uri $uri/ /index.html;\n' "$ind"
			printf '%s}\n' "$ind"
			;;
		http://*|https://*)
			printf '%slocation / {\n' "$ind"
			printf '%s    proxy_pass %s;\n' "$ind" "$SITE_FRONTEND"
			nginx_proxy_common "${ind}    " "$mapvar" ""
			printf '%s}\n' "$ind"
			;;
	esac
}

nginx_route_body() {
	local ind="$1" mapvar="$2"
	if [[ "$SITE_MODE" == "split" ]]; then
		printf '%slocation = %s {\n' "$ind" "$SITE_PREFIX"
		printf '%s    return 308 %s/;\n' "$ind" "$SITE_PREFIX"
		printf '%s}\n\n' "$ind"
		printf '%slocation ^~ %s/ {\n' "$ind" "$SITE_PREFIX"
		if [[ "$SITE_STRIP" == "1" ]]; then
			printf '%s    proxy_pass %s/;\n' "$ind" "$SITE_UPSTREAM"
		else
			printf '%s    proxy_pass %s;\n' "$ind" "$SITE_UPSTREAM"
		fi
		nginx_proxy_common "${ind}    " "$mapvar" "$SITE_PREFIX"
		printf '%s}\n\n' "$ind"
		nginx_frontend_body "$ind" "$mapvar"
	else
		printf '%slocation / {\n' "$ind"
		printf '%s    proxy_pass %s;\n' "$ind" "$SITE_UPSTREAM"
		nginx_proxy_common "${ind}    " "$mapvar" ""
		printf '%s}\n' "$ind"
	fi
}

render_nginx() {
	local mapvar
	mapvar="$(printf '%s' "$SITE_NAME" | sed 's/[^a-zA-Z0-9_]/_/g')"

	SITE_HEAD_COMMENT
	printf 'map $http_upgrade $emby_rp_conn_%s {\n' "$mapvar"
	printf '    default upgrade;\n'
	printf "    ''      close;\n"
	printf '}\n\n'

	# ---- HTTP server：仅用于 ACME 校验 / 跳转 ----
	printf 'server {\n'
	printf '    listen %s;\n' "$SITE_HTTP_PORT"
	ipv6_enabled && printf '    listen [::]:%s;\n' "$SITE_HTTP_PORT"
	printf '    server_name %s;\n\n' "$SITE_DOMAIN"
	printf '    location ^~ /.well-known/acme-challenge/ {\n'
	printf '        root %s;\n' "$ACME_WEBROOT"
	printf '        default_type text/plain;\n'
	printf '    }\n\n'
	printf '    location = /_emby_rp_health {\n'
	printf '        access_log off;\n'
	printf '        add_header Content-Type text/plain always;\n'
	printf '        return 200 "ok\\n";\n'
	printf '    }\n\n'
	if [[ "$SITE_TLS" != "none" ]]; then
		printf '    location / {\n'
		if [[ "$SITE_HTTPS_PORT" == "443" ]]; then
			printf '        return 301 https://$host$request_uri;\n'
		else
			printf '        return 301 https://$host:%s$request_uri;\n' "$SITE_HTTPS_PORT"
		fi
		printf '    }\n'
	else
		printf '    client_max_body_size 0;\n'
		if [[ "$SITE_ACCESS_LOG" == "1" ]]; then
			printf '    access_log %s/%s-%s.log;\n' "$NGINX_LOG_DIR" "emby-rp" "$SITE_NAME"
			printf '    error_log  %s/%s-%s.error.log warn;\n' "$NGINX_LOG_DIR" "emby-rp" "$SITE_NAME"
		fi
		printf '\n'
		nginx_route_body '    ' "$mapvar"
	fi
	printf '}\n'

	[[ "$SITE_TLS" == "none" ]] && return 0

	# ---- HTTPS server ----
	printf '\nserver {\n'
	nginx_listen_ssl_lines
	printf '    server_name %s;\n\n' "$SITE_DOMAIN"
	if [[ "$SITE_TLS" == "file" ]]; then
		printf '    ssl_certificate     %s;\n' "$SITE_CERT"
		printf '    ssl_certificate_key %s;\n' "$SITE_KEY"
	else
		printf '    ssl_certificate     /etc/letsencrypt/live/%s/fullchain.pem;\n' "$SITE_DOMAIN"
		printf '    ssl_certificate_key /etc/letsencrypt/live/%s/privkey.pem;\n' "$SITE_DOMAIN"
	fi
	printf '    ssl_protocols TLSv1.2 TLSv1.3;\n'
	printf '    ssl_prefer_server_ciphers off;\n'
	printf '    ssl_session_cache shared:emby_rp_ssl:10m;\n'
	printf '    ssl_session_timeout 1d;\n'
	printf '    ssl_session_tickets off;\n\n'
	printf '    client_max_body_size 0;\n'
	if [[ "$SITE_ACCESS_LOG" == "1" ]]; then
		printf '    access_log %s/%s-%s.log;\n' "$NGINX_LOG_DIR" "emby-rp" "$SITE_NAME"
		printf '    error_log  %s/%s-%s.error.log warn;\n' "$NGINX_LOG_DIR" "emby-rp" "$SITE_NAME"
	fi
	printf '\n'
	printf '    location = /_emby_rp_health {\n'
	printf '        access_log off;\n'
	printf '        add_header Content-Type text/plain always;\n'
	printf '        return 200 "ok\\n";\n'
	printf '    }\n\n'
	nginx_route_body '    ' "$mapvar"
	printf '}\n'
}

render_site() {
	case "$SITE_ENGINE" in
		caddy) render_caddy ;;
		nginx) render_nginx ;;
		*)     die "未知引擎：$SITE_ENGINE" ;;
	esac
}

# =============================================================================
#  校验与落地
# =============================================================================
normalize_prefix() {
	local p="${1:-/emby}"
	[[ "$p" == /* ]] || p="/$p"
	p="$(strip_trailing_slash "$p")"
	[[ -z "$p" ]] && p="/"
	printf '%s' "$p"
}

validate_prefix() {
	local p="$1"
	[[ "$p" == /* ]] || die "前缀必须以 / 开头：$p"
	[[ "$p" =~ ^/[A-Za-z0-9._/-]*$ ]] || die "前缀只允许字母、数字和 . _ - / ：$p"
	case "$p" in
		/|"/.well-known"|/"_emby_rp_health") die "前缀 $p 与内置路径冲突，请换一个（例如 /emby）。" ;;
	esac
}

validate_upstream() {
	local u="$1"
	[[ "$u" =~ ^https?://[^/[:space:]]+ ]] || die "源站格式不对：$u（例：https://stream-1.example.com 或 http://127.0.0.1:8096）"
}

# 系统是否开了 IPv6（开了才监听 [::]）
ipv6_enabled() {
	local d
	d="$(sysctl -n net.ipv6.conf.all.disable_ipv6 2>/dev/null)"
	[[ "$d" == "0" ]]
}

# 从 upstream URL 取纯主机名（无协议/路径/端口）
upstream_host_only() {	local h="${1#*://}"
	h="${h%%/*}"
	case "$h" in
		*:* ) h="${h%:*}" ;;
	esac
	printf '%s' "$h"
}

# 没写协议时自动补：无端口或 :443 → https，其它端口 → http
normalize_upstream() {
	local u="$1" hostport
	case "$u" in
		http://*|https://*) printf '%s' "$u"; return 0 ;;
	esac
	hostport="${u%%/*}"
	if [[ "$hostport" == *:* && "$hostport" != *:443 ]]; then
		printf 'http://%s' "$u"
	else
		printf 'https://%s' "$u"
	fi
}

site_public_base() {
	local scheme="http" port="$SITE_HTTP_PORT"
	if [[ "$SITE_TLS" != "none" ]]; then scheme="https"; port="$SITE_HTTPS_PORT"; fi
	local b="${scheme}://${SITE_DOMAIN}"
	if [[ "$scheme" == "https" && "$port" != "443" ]] || [[ "$scheme" == "http" && "$port" != "80" ]]; then
		b="${b}:${port}"
	fi
	printf '%s' "$b"
}

pick_site() {
	local n; n="$(site_count)"
	[[ "$n" -gt 0 ]] || die "还没有任何站点，先执行：${CMD_NAME} add"
	if [[ "$n" -eq 1 ]]; then list_site_names | head -n1; return 0; fi
	local i=0 x
	while read -r x; do i=$((i + 1)); printf '  %d) %s\n' "$i" "$x" >&2; done < <(list_site_names)
	local sel name
	sel="$(ask "选择站点序号")"
	name="$(list_site_names | sed -n "${sel}p")"
	[[ -n "$name" ]] || die "无效的序号：$sel"
	printf '%s' "$name"
}

site_cert_file() {
	case "$SITE_TLS" in
		file) printf '%s' "$SITE_CERT" ;;
		auto) printf '%s' "/etc/letsencrypt/live/${SITE_DOMAIN}/fullchain.pem" ;;
		*)    printf '' ;;
	esac
}

cert_expiry_of() {
	local f="$1" d
	[[ -n "$f" && -r "$f" ]] || { printf '—'; return 0; }
	d="$(openssl x509 -in "$f" -noout -enddate 2>/dev/null | sed 's/^notAfter=//')"
	printf '%s' "${d:-—}"
}

site_apply() {
	local path prev="" applied=1
	if [[ "$SITE_ENGINE" == "caddy" ]]; then
		caddy_ensure_block
		caddy_prepare_dirs
		path="$(caddy_site_path "$SITE_NAME")"
	else
		mkdir -p "$NGINX_CONF_D" "$NGINX_LOG_DIR" "$BACKUP_DIR"
		path="$(nginx_site_path "$SITE_NAME")"
	fi
	if [[ -f "$path" ]]; then
		prev="$BACKUP_DIR/$(basename "$path").$(date +%Y%m%d-%H%M%S)"
		cp -a "$path" "$prev" 2>/dev/null || prev=""
	fi
	if ! render_site > "$path"; then
		err "写入配置失败：$path"
		return 1
	fi
	if [[ "$SITE_ENGINE" == "caddy" ]]; then apply_caddy || applied=0; else apply_nginx || applied=0; fi
	if [[ "$applied" == "1" ]]; then
		ok "配置已生效：$path"
		return 0
	fi
	err "引擎拒绝了新配置，正在回滚…"
	if [[ -n "$prev" && -f "$prev" ]]; then
		cp -a "$prev" "$path"
		warn "已回滚到上一版配置：$prev"
	else
		rm -f "$path"
		warn "新配置已删除。"
	fi
	if [[ "$SITE_ENGINE" == "caddy" ]]; then apply_caddy || true; else apply_nginx || true; fi
	return 1
}

self_install() {
	local src="$0" quiet="${1:-}" installed=0 cur
	[[ -f "$src" ]] || return 0
	src="$(cd "$(dirname "$src")" 2>/dev/null && pwd)/$(basename "$src")"
	[[ -n "$src" && "$src" == *"/"* ]] || return 0

	cur="$(sed -n 's/^VERSION="\(.*\)"$/\1/p' "$BIN_PATH" 2>/dev/null | head -n1)"
	if [[ ! -f "$BIN_PATH" || "$cur" != "$VERSION" ]]; then
		mkdir -p "$(dirname "$BIN_PATH")" 2>/dev/null || return 0
		if cp -f "$src" "$BIN_PATH" 2>/dev/null; then
			chmod 755 "$BIN_PATH" 2>/dev/null || true
			installed=1
		fi
	fi

	# 快捷入口：emby -> emby-rp（不覆盖已有同名命令，包括指向别处的软链）
	if [[ -f "$BIN_PATH" && "$ALIAS_PATH" != "$BIN_PATH" ]]; then
		if [[ -L "$ALIAS_PATH" ]]; then
			if [[ "$(readlink "$ALIAS_PATH" 2>/dev/null)" != "$BIN_PATH" ]]; then
				[[ "$quiet" == "quiet" ]] || warn "快捷命令 $ALIAS_PATH 已存在且指向别处，未覆盖。"
			fi
		elif [[ ! -e "$ALIAS_PATH" ]]; then
			ln -s "$BIN_PATH" "$ALIAS_PATH" 2>/dev/null || true
		fi
	fi

	if [[ $installed -eq 1 ]]; then
		[[ "$quiet" == "quiet" ]] || info "已装到 $BIN_PATH（v$VERSION），快捷命令：${ALIAS_NAME}"
	fi
	return 0
}

# ---------- nginx 的 ACME 流程 ----------
nginx_acme_prepare() {
	mkdir -p "${ACME_WEBROOT}/.well-known/acme-challenge" "$NGINX_CONF_D"
	local path; path="$(nginx_site_path "$SITE_NAME")"
	{
		SITE_HEAD_COMMENT
		printf 'server {\n'
		printf '    listen %s;\n' "$SITE_HTTP_PORT"
		ipv6_enabled && printf '    listen [::]:%s;\n' "$SITE_HTTP_PORT"
		printf '    server_name %s;\n\n' "$SITE_DOMAIN"
		printf '    location ^~ /.well-known/acme-challenge/ {\n'
		printf '        root %s;\n' "$ACME_WEBROOT"
		printf '        default_type text/plain;\n'
		printf '    }\n'
		printf '}\n'
	} > "$path"
	apply_nginx
}

cert_obtain_nginx() {
	local mail="$1" out rc
	install_certbot || return 1
	info "先以 HTTP 模式开放 ACME 校验路径…"
	nginx_acme_prepare || warn "临时 HTTP 配置未生效，仍尝试签发。"
	out="$(certbot certonly --webroot -w "$ACME_WEBROOT" -d "$SITE_DOMAIN" \
		--non-interactive --agree-tos --email "$mail" \
		--keep-until-expiring --expand 2>&1)"
	rc=$?
	printf '%s\n' "$out" | sed 's/^/    /'
	if [[ $rc -ne 0 ]]; then
		err "证书签发失败。常见原因：域名未解析到本机、80 端口不通、CDN 未放行 /.well-known。"
		err "如果报错里出现 IPv6 地址（如 2400:...），检查域名的 AAAA 记录：要么让本机 nginx 监听 [::]:80（新版已默认加上），要么暂时删掉 AAAA 记录重试。"
		return 1
	fi
	[[ -f "/etc/letsencrypt/live/${SITE_DOMAIN}/fullchain.pem" ]]
}

# =============================================================================
#  add
# =============================================================================
cmd_add() {
	local interactive=0
	[[ $# -eq 0 ]] && interactive=1
	OVERWRITE_BACKUP_DIR=""  # 本次 add 的旧站备份目录（菜单里连用两次时不串）

	local domain="" engine="" mode="" prefix="" strip="0" frontend="" upstream=""
	local tls="" cert="" key="" email="" name="" http_port="" https_port=""
	local cf="0" insecure="0" access_log="1" yes=0 force=0 pick host_mode="" host_value="" rewrites="" http2=""

	while [[ $# -gt 0 ]]; do
		# 需要值的选项放在最后且没给值时，shift 2 会失败且不移动，导致无限循环
		case "$1" in
			-d|--domain|-e|--engine|-m|--mode|-p|--prefix|-F|--frontend|-u|--upstream|\
			--tls|--cert|--key|--email|-n|--name|--http-port|--https-port|\
			--host-mode|--upstream-host|-R|--rewrite|--http2)
				[[ $# -ge 2 ]] || die "选项 $1 缺少参数值" ;;
		esac
		case "$1" in
			-d|--domain)   domain="${2:-}"; shift 2 ;;
			-e|--engine)   engine="${2:-}"; shift 2 ;;
			-m|--mode)     mode="${2:-}"; shift 2 ;;
			-p|--prefix)   prefix="${2:-}"; shift 2 ;;
			--strip)       strip="1"; shift ;;
			--keep)        strip="0"; shift ;;
			-F|--frontend) frontend="${2:-}"; shift 2 ;;
			-u|--upstream) upstream="${2:-}"; shift 2 ;;
			--tls)         tls="${2:-}"; shift 2 ;;
			--cert)        cert="${2:-}"; shift 2 ;;
			--key)         key="${2:-}"; shift 2 ;;
			--email)       email="${2:-}"; shift 2 ;;
			-n|--name)     name="${2:-}"; shift 2 ;;
			--http-port)   http_port="${2:-}"; shift 2 ;;
			--https-port)  https_port="${2:-}"; shift 2 ;;
			--http2)
				http2="${2:-}"
				case "$http2" in
					on|off) shift 2 ;;
					*) die "--http2 只能是 on 或 off（当前 HTTP/2 有未认证 RCE 风险，默认 off）" ;;
				esac ;;
			--cf)          cf="1"; shift ;;
			--upstream-insecure) insecure="1"; shift ;;
			--no-log)      access_log="0"; shift ;;
			--host-mode)   host_mode="${2:-}"; shift 2 ;;
			--upstream-host) host_mode="value"; host_value="${2:-}"; shift 2 ;;
			-R|--rewrite)
				local rv="${2:-}" rn="${3:-}"
				if [[ "$rn" != "" && "$rn" != -* ]]; then
					rv="$rv=>$rn"; shift 3
				else
					shift 2
				fi
				case "$rv" in
					*=) die "--rewrite 参数被 shell 当成重定向了（末尾的 = 后面那个 > 被吃掉了）。用引号包起来：--rewrite 'old.com=>new.com'" ;;
				esac
				rewrites="${rewrites:+$rewrites }$rv" ;;
			--force)       force=1; shift ;;
			-y|--yes)      yes=1; shift ;;
			-h|--help)     usage; return 0 ;;
			*) die "未知参数：$1（--help 查看帮助）" ;;
		esac
	done

	need_root add

	# ---------- 域名 ----------
	if [[ -z "$domain" ]]; then
		[[ $yes -eq 1 ]] && die "缺少 --domain"
		domain="$(ask "主域名（对外访问用的域名）")"
	fi
	domain="$(printf '%s' "$domain" | tr '[:upper:]' '[:lower:]' | sed 's#^https\?://##; s#/.*##; s#:[0-9]*$##')"
	[[ -n "$domain" ]] || die "域名不能为空"
	[[ "$domain" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$ ]] || die "域名格式不对：$domain"

	# ---------- 站点名冲突（提前检查，别问完全部才失败） ----------
	[[ -n "$name" ]] || name="$(gen_name_from_domain "$domain")"
	[[ -n "$name" ]] || name="site"
	if [[ -f "$SITES_DIR/${name}.conf" ]]; then
		local old_domain
		old_domain="$(sed -n 's/^SITE_DOMAIN=//p' "$SITES_DIR/${name}.conf" 2>/dev/null | tr -d "'\"" | head -n1)"
		warn "站点 ${name} 已存在（域名 ${old_domain:-未知}）"
		if [[ $force -eq 1 ]]; then
			info "--force：先拆除旧配置，再按新参数重建"
			site_teardown "$name" || die "拆除旧站点失败"
		elif [[ $yes -eq 1 ]]; then
			die "站点 $name 已存在。加 --force 覆盖，或 -n <名字> 换个站点名，或先 ${CMD_NAME} remove $name"
		elif confirm "覆盖已有站点 $name？（旧配置会被替换）" n; then
			site_teardown "$name" || die "拆除旧站点失败"
		else
			die "已取消。可加 -n <名字> 换个站点名，或先 ${CMD_NAME} remove $name"
		fi
	fi

	# ---------- 引擎 ----------
	if [[ -z "$engine" ]]; then
		engine="caddy"
		if [[ $yes -eq 0 ]]; then
			printf '  1) Caddy   %s自动申请 HTTPS，零额外配置%s\n' "$C_D" "$C_0" >&2
			printf '  2) Nginx   %s配 certbot，适合已有 nginx 的机器%s\n' "$C_D" "$C_0" >&2
			pick="$(ask "选择引擎" "1")"
			case "$pick" in
				1|[Cc]addy) engine="caddy" ;;
				2|[Nn]ginx) engine="nginx" ;;
				*) die "无效选项：$pick" ;;
			esac
		fi
	fi
	case "$engine" in caddy|nginx) ;; *) die "--engine 只能是 caddy 或 nginx" ;; esac

	if [[ -n "${rewrites:-}" && "$engine" != "nginx" ]]; then
		die "--rewrite（修改响应体里的推流域名）依赖 nginx 的 sub_filter，Caddy 原生不支持；请改用 -e nginx"
	fi

	# ---------- 模式 ----------
	if [[ -z "$mode" ]]; then
		mode="standalone"
		if [[ $yes -eq 0 ]]; then
			printf '  1) 独立反代     %s域名根路径就是 Emby（反代别人的 Emby / 推流域名选这个）%s\n' "$C_D" "$C_0" >&2
			printf '  2) 前后端分离   %s根路径给前端，/前缀 回源 Emby 后端%s\n' "$C_D" "$C_0" >&2
			pick="$(ask "选择模式" "1")"
			case "$pick" in
				1|[Ss]tandalone|s|S) mode="standalone" ;;
				2|[Ss]plit) mode="split" ;;
				*) die "无效选项：$pick" ;;
			esac
		fi
	fi
	case "$mode" in standalone|split) ;; *) die "--mode 只能是 standalone 或 split" ;; esac

	# ---------- 前缀与前端 ----------
	if [[ "$mode" == "split" ]]; then
		[[ -n "$prefix" ]] || prefix="/emby"
		prefix="$(normalize_prefix "$prefix")"
		validate_prefix "$prefix"

		if [[ -z "$frontend" ]]; then
			printf '  前端可以是目录（如 /var/www/emby-web）或 URL（如 http://127.0.0.1:8080）\n' >&2
			if [[ $yes -eq 1 ]]; then
				frontend="dir:${EMBY_RP_DEFAULT_WEBROOT:-/var/www/html}"
			else
				frontend="$(ask "前端位置" "dir:/var/www/html")"
			fi
		fi
		case "$frontend" in
			dir:*|http://*|https://*) : ;;
			/*) frontend="dir:${frontend}" ;;
			*) die "前端只能是目录或 http(s) URL：$frontend" ;;
		esac
	else
		prefix="/"
		frontend=""
		strip="0"
	fi

	# ---------- 源站 ----------
	if [[ -z "$upstream" ]]; then
		if [[ $yes -eq 1 ]]; then
			upstream="http://127.0.0.1:8096"
		else
			upstream="$(ask "Emby 后端地址" "http://127.0.0.1:8096")"
		fi
	fi
	upstream="$(strip_trailing_slash "$upstream")"
	upstream="$(normalize_upstream "$upstream")"
	validate_upstream "$upstream"

	# ---------- TLS ----------
	if [[ -z "$tls" ]]; then
		tls="auto"
		if [[ $yes -eq 0 ]]; then
			printf '  1) auto  Caddy/certbot 自动申请 Let'"'"'s Encrypt%s\n' "" >&2
			printf '  2) file  使用已有证书文件\n' >&2
			printf '  3) none  不启用 HTTPS\n' >&2
			pick="$(ask "TLS 方式" "1")"
			case "$pick" in
				1|auto) tls="auto" ;;
				2|file) tls="file" ;;
				3|none) tls="none" ;;
				*) die "无效选项：$pick" ;;
			esac
		fi
	fi
	case "$tls" in auto|file|none) ;; *) die "--tls 只能是 auto / file / none" ;; esac
	if [[ "$tls" == "file" ]]; then
		[[ -n "$cert" ]] || cert="$(ask "证书 fullchain 路径")"
		[[ -n "$key" ]] || key="$(ask "私钥路径")"
		[[ -r "$cert" ]] || die "证书不存在或不可读：$cert"
		[[ -r "$key" ]] || die "私钥不存在或不可读：$key"
	fi
	if [[ "$tls" == "auto" && -z "$email" ]]; then
		email="$(default_email_for "$domain")"
		[[ $yes -eq 0 ]] && email="$(ask "Let's Encrypt 联系邮箱" "$email")"
	fi
	[[ -z "$http_port" ]] && http_port="80"
	if [[ "$tls" == "none" ]]; then
		[[ -z "$https_port" ]] && https_port="80"
	else
		[[ -z "$https_port" ]] && https_port="443"
	fi

	# ---------- 自签源站自动识别 ----------
	if [[ "$upstream" == https://* && "$insecure" == "0" ]]; then
		if ! curl -sS -o /dev/null --max-time 6 "$upstream" 2>/dev/null; then
			if curl -sk -o /dev/null --max-time 6 "$upstream" 2>/dev/null; then
				warn "源站证书不被信任（自签），已自动开启 --upstream-insecure"
				insecure="1"
			fi
		fi
	fi

	# ---------- 端口占用 ----------
	if ! engine_running "$engine"; then
		local p
		for p in "$http_port" "$https_port"; do
			if port_in_use "$p"; then
				warn "端口 $p 已被占用："
				port_holders "$p" | sed 's/^/    /' >&2
				if [[ $yes -eq 0 ]]; then
					confirm "仍然继续？" n || return 1
				fi
			fi
		done
	fi

	# ---------- 引擎 ----------
	hr
	if [[ "$engine" == "caddy" ]]; then install_caddy; else install_nginx; fi

	# ---------- 写入站点元数据 ----------
	reset_site_vars
	SITE_NAME="$name"
	SITE_DOMAIN="$domain"
	SITE_ENGINE="$engine"
	SITE_MODE="$mode"
	SITE_PREFIX="$prefix"
	SITE_STRIP="$strip"
	SITE_FRONTEND="$frontend"
	SITE_UPSTREAM="$upstream"
	SITE_TLS="$tls"
	SITE_CERT="$cert"
	SITE_KEY="$key"
	SITE_EMAIL="$email"
	SITE_HTTP_PORT="$http_port"
	SITE_HTTPS_PORT="$https_port"
	SITE_CF="$cf"
	SITE_UPSTREAM_INSECURE="$insecure"
	SITE_ACCESS_LOG="$access_log"
	SITE_HTTP2="${http2:-off}"
	SITE_HOST_MODE="${host_mode:-upstream}"
	SITE_HOST_VALUE="$host_value"
	# --rewrite from[=>to]，只写 from 时换成本站域名
	SITE_REWRITES=""
	if [[ -n "$rewrites" ]]; then
		local rk rf rt
		for rk in $rewrites; do
			if [[ "$rk" == *"=>"* ]]; then
				rf="${rk%%=>*}"; rt="${rk#*=>}"
			else
				rf="$rk"; rt="$domain"
			fi
			[[ -n "$rf" && -n "$rt" ]] || continue
			SITE_REWRITES="${SITE_REWRITES:+$SITE_REWRITES }$rf=>$rt"
		done
	fi
	save_site

	# ---------- 证书 ----------
	if [[ "$tls" == "auto" && "$engine" == "nginx" ]]; then
		if ! cert_obtain_nginx "$email"; then
			rm -f "$SITES_DIR/${name}.conf" "$(nginx_site_path "$name")"
			if site_restore_overwrite "$name"; then
				die "证书签发失败，覆盖前的旧站点已恢复。"
			fi
			apply_nginx >/dev/null 2>&1 || true
			die "证书签发失败，已删除站点记录与临时 HTTP 配置。"
		fi
		ok "证书就绪：/etc/letsencrypt/live/${domain}/"
	fi

	# ---------- 落地 ----------
	if ! site_apply; then
		rm -f "$SITES_DIR/${name}.conf"
		if site_restore_overwrite "$name"; then
			die "新配置未生效，覆盖前的旧站点已恢复。"
		fi
		die "站点未写入，已回滚。"
	fi

	hr
	ok "站点 $name 创建完成"
	printf '   访问地址   %s\n' "$(site_public_base)"
	printf '   上游       %s\n' "$upstream"
	if [[ "$mode" == "split" ]]; then
		printf '   前缀       %s (%s)\n' "$prefix" "$([[ "$strip" == "1" ]] && printf 'strip 剥离' || printf 'keep 保留')"
		printf '   前端       %s\n' "$frontend"
		printf '\n'
		if [[ "$strip" == "1" ]]; then
			warn "strip 模式下请把源站 Emby 的 Base URL 留空，否则会双重前缀。"
		else
			printf '%s需在 Emby 设置%s\n' "$C_B" "$C_0"
			printf '   Emby:     设置 → 高级 → 主机(Base URL) = %s\n' "$prefix"
			printf '   Jellyfin: 控制台 → 网络 → Base URL = %s\n' "$prefix"
			printf '   %s设完重启 Emby，官方 Web UI 会自动带着 %s 前缀工作。%s\n' "$C_D" "$prefix" "$C_0"
		fi
	else
		printf '   模式       独立反代（整站）\n'
	fi
	printf '\n'
	self_install
	info "自检：${CMD_NAME} check ${name}"
	return 0
}

# =============================================================================
#  list / status
# =============================================================================
cmd_list() {
	local names; names="$(list_site_names)"
	if [[ -z "$names" ]]; then
		info "还没有任何站点。执行 ${CMD_NAME} add 开始创建。"
		return 0
	fi
	printf '%s%-12s %-30s %-6s %-11s %-10s %s%s\n' \
		"$C_B" "NAME" "DOMAIN" "ENGINE" "MODE" "PREFIX" "TLS" "$C_0"
	hr
	local n
	while read -r n; do
		[[ -n "$n" ]] || continue
		load_site "$n" || continue
		printf '%-12s %-30s %-6s %-11s %-10s %s\n' \
			"$SITE_NAME" "$SITE_DOMAIN" "$SITE_ENGINE" "$SITE_MODE" \
			"$([[ "$SITE_MODE" == "split" ]] && printf '%s' "$SITE_PREFIX" || printf '/') " "$SITE_TLS"
	done <<< "$names"
	hr
	printf '%s共 %s 个站点%s\n' "$C_D" "$(site_count)" "$C_0"
}

cmd_status() {
	need_root status
	local name="${1:-}"
	[[ -n "$name" ]] || name="$(pick_site)"
	load_site "$name" || die "站点不存在：$name"

	local base; base="$(site_public_base)"
	local cpath; cpath="$(site_cert_file)"
	local cfg
	if [[ "$SITE_ENGINE" == "caddy" ]]; then cfg="$(caddy_site_path "$SITE_NAME")"
	else cfg="$(nginx_site_path "$SITE_NAME")"; fi

	hr
	printf '%s%s%s  ·  %s\n' "$C_B" "$SITE_NAME" "$C_0" "$base"
	hr
	printf '  引擎        %s\n' "$SITE_ENGINE"
	printf '  运行状态    %s\n' "$(engine_running "$SITE_ENGINE" && printf 'running' || printf 'stopped')"
	printf '  模式        %s\n' "$SITE_MODE"
	[[ "$SITE_MODE" == "split" ]] && printf '  前缀        %s (%s)\n' "$SITE_PREFIX" "$([[ "$SITE_STRIP" == "1" ]] && printf strip || printf keep)"
	[[ "$SITE_MODE" == "split" ]] && printf '  前端        %s\n' "$SITE_FRONTEND"
	printf '  源站        %s\n' "$SITE_UPSTREAM"
	printf '  TLS         %s\n' "$SITE_TLS"
	printf '  证书到期    %s\n' "$(cert_expiry_of "$cpath")"
	printf '  监听        %s / %s\n' "$SITE_HTTP_PORT" "$SITE_HTTPS_PORT"
	if [[ "$SITE_ENGINE" == "nginx" && "$SITE_TLS" != "none" ]]; then
		# 元数据里的 SITE_HTTP2 是期望值；1.1.3 之前建的站重渲染前，线上配置可能还开着 h2
		local live_h2="off"
		if [[ -f "$cfg" ]] && grep -Eq 'http2 on;|listen [^;]* ssl http2' "$cfg"; then live_h2="on"; fi
		if [[ "${SITE_HTTP2:-off}" == "on" ]]; then
			printf '  HTTP/2      on（注意：nginx 1.9.5–1.31.8 有 CVE-2026-123007 未认证 RCE）\n'
		elif [[ "$live_h2" == "on" ]]; then
			printf '  HTTP/2      off（但线上配置仍开着 h2，请 add --force 重新渲染）\n'
		else
			printf '  HTTP/2      off\n'
		fi
	fi
	printf '  配置文件    %s\n' "$cfg"
	printf '  创建时间    %s\n' "${SITE_CREATED:-—}"
	hr
}

# =============================================================================
#  check
# =============================================================================
_http_code() {
	local c
	c="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 8 "$@" 2>/dev/null)"
	[[ -n "$c" ]] || c="000"
	printf '%s' "$c"
}

cmd_check() {
	need_root check
	local name="${1:-}"
	[[ -n "$name" ]] || name="$(pick_site)"
	load_site "$name" || die "站点不存在：$name"

	local base scheme port path
	base="$(site_public_base)"
	scheme="http"; port="$SITE_HTTP_PORT"
	if [[ "$SITE_TLS" != "none" ]]; then scheme="https"; port="$SITE_HTTPS_PORT"; fi
	if [[ "$SITE_MODE" == "split" ]]; then path="$SITE_PREFIX"; else path=""; fi

	local up="${SITE_UPSTREAM%/}/System/Info/Public"
	local local_base="${scheme}://127.0.0.1:${port}"
	hr
	printf '%s自检：%s%s\n' "$C_B" "$SITE_NAME" "$C_0"
	hr

	# 1. 引擎
	if engine_running "$SITE_ENGINE"; then ok "1. $SITE_ENGINE 运行中"; else err "1. $SITE_ENGINE 未运行：systemctl status $SITE_ENGINE"; fi

	# 2. 源站直连
	local c; c="$(_http_code "$up")"
	case "$c" in
		2*) ok "2. 源站可达（$c）$up" ;;
		000) err "2. 源站不通：$up" ;;
		*) warn "2. 源站返回 $c（可能需要 API Key，连通性本身正常）" ;;
	esac

	# 3. 本机健康探针
	c="$(_http_code --resolve "${SITE_DOMAIN}:${port}:127.0.0.1" "${base}/_emby_rp_health")"
	if [[ "$c" == "200" ]]; then ok "3. 健康探针 200（本机 $local_base）"; else err "3. 健康探针异常：$c"; fi

	# 4. 业务路径
	local biz="${base}${path}/System/Info/Public"
	c="$(_http_code --resolve "${SITE_DOMAIN}:${port}:127.0.0.1" "$biz")"
	case "$c" in
		2*) ok "4. 业务路径 $c：$biz" ;;
		000) err "4. 业务路径不可达：$biz" ;;
		*) warn "4. 业务路径返回 $c：$biz" ;;
	esac

	# 5. WebSocket 升级
	local ws="${base}${path}/embywebsocket?api_key=probe&deviceId=probe"
	local wc
	wc="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 8 --http1.1 \
		--resolve "${SITE_DOMAIN}:${port}:127.0.0.1" \
		-H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
		-H 'Sec-WebSocket-Key: ZW1ieS1ycC1wcm9iZS0xMjM0' "$ws" 2>/dev/null || printf '000')"
	case "$wc" in
		101) ok "5. WebSocket 升级成功（101）" ;;
		000) err "5. WebSocket 不可达" ;;
		4*|5*) warn "5. WebSocket 链路已通，上游返回 $wc（API Key 无效时正常）" ;;
		*)    warn "5. WebSocket 返回 $wc" ;;
	esac

	# 6. 证书
	if [[ "$scheme" == "https" ]]; then
		local end
		end="$(openssl s_client -connect "127.0.0.1:${port}" -servername "$SITE_DOMAIN" </dev/null 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | sed 's/^notAfter=//')"
		if [[ -n "$end" ]]; then ok "6. 证书到期：$end"; else warn "6. 未能读取线上证书"; fi
	fi

	hr
	[[ "$SITE_MODE" == "split" ]] && info "前端应为 ${base}/ ，接口为 ${base}${path}/"
	return 0
}

# =============================================================================
#  logs / render / remove
# =============================================================================
cmd_logs() {
	local name="" follow=0 a
	for a in "$@"; do
		case "$a" in
			-f|--follow) follow=1 ;;
			-*) die "未知参数：$a" ;;
			*) [[ -z "$name" ]] && name="$a" ;;
		esac
	done
	[[ -n "$name" ]] || name="$(pick_site)"
	load_site "$name" || die "站点不存在：$name"
	local f
	if [[ "$SITE_ENGINE" == "caddy" ]]; then f="$CADDY_LOG_DIR/emby-rp-${SITE_NAME}.log"
	else f="$NGINX_LOG_DIR/emby-rp-${SITE_NAME}.log"; fi
	[[ -f "$f" ]] || die "日志尚未生成：$f"
	info "日志：$f"
	if [[ $follow -eq 1 ]]; then tail -n 40 -F "$f"; else tail -n "${EMBY_RP_TAIL:-80}" "$f"; fi
}

cmd_render() {
	local name="${1:-}"
	[[ -n "$name" ]] || name="$(pick_site)"
	load_site "$name" || die "站点不存在：$name"
	render_site
}

# 拆除一个站点的落地物（不动证书、不重载引擎），供 remove 与 add --force 复用。
# 拆除前先把旧站备份到 $BACKUP_DIR，add 失败时可由 site_restore_overwrite 恢复；
# 备份目录记在 OVERWRITE_BACKUP_DIR（cmd_add 开头会清空，避免菜单里连用两次串了）。
site_teardown() {
	local n="$1"
	[[ -f "$SITES_DIR/${n}.conf" ]] || return 0
	local bd="$BACKUP_DIR/overwrite-${n}.$(date +%Y%m%d-%H%M%S)"
	mkdir -p "$bd" 2>/dev/null || true
	cp -a "$SITES_DIR/${n}.conf" "$bd/" 2>/dev/null || true
	[[ -f "$(caddy_site_path "$n")" ]] && cp -a "$(caddy_site_path "$n")" "$bd/" 2>/dev/null || true
	[[ -f "$(nginx_site_path "$n")" ]] && cp -a "$(nginx_site_path "$n")" "$bd/" 2>/dev/null || true
	OVERWRITE_BACKUP_DIR="$bd"
	rm -f "$(caddy_site_path "$n")" "$(nginx_site_path "$n")"
	rm -f "$NGINX_LOG_DIR/emby-rp-${n}.log" "$NGINX_LOG_DIR/emby-rp-${n}.error.log"
	rm -f "$CADDY_LOG_DIR/emby-rp-${n}.log" "$CADDY_LOG_DIR/emby-rp-${n}".log.*
	rm -f "$SITES_DIR/${n}.conf"
	return 0
}

cmd_remove() {
	need_root remove
	local name="${1:-}" purge_cert=0

	[[ -n "$name" ]] || name="$(pick_site)"
	load_site "$name" || die "站点不存在：$name"
	local domain="$SITE_DOMAIN"
	info "即将删除站点 $SITE_NAME（$SITE_DOMAIN）"
	confirm "确认？" n || { info "已取消。"; return 0; }
	confirm "同时删除 Let's Encrypt 证书？" n && purge_cert=1

	rm -f "$(caddy_site_path "$SITE_NAME")" "$(nginx_site_path "$SITE_NAME")"
	rm -f "$NGINX_LOG_DIR/emby-rp-${SITE_NAME}.log" "$NGINX_LOG_DIR/emby-rp-${SITE_NAME}.error.log"
	rm -f "$CADDY_LOG_DIR/emby-rp-${SITE_NAME}.log"
	rm -f "$SITES_DIR/${SITE_NAME}.conf"
	ok "已删除站点配置"

	if [[ "$SITE_ENGINE" == "caddy" ]]; then
		if [[ "$(site_count)" -eq 0 ]]; then
			caddy_remove_block
			info "已清理 Caddyfile 托管块（无剩余站点）"
		else
			apply_caddy || warn "Caddy 重载失败，请手动检查"
		fi
		systemctl reload caddy >/dev/null 2>&1 || true
	else
		apply_nginx || warn "Nginx 重载失败，请手动检查"
	fi

	if [[ $purge_cert -eq 1 && -d "/etc/letsencrypt/live/${domain}" ]]; then
		if have certbot && certbot delete --cert-name "$domain" --non-interactive >/dev/null 2>&1; then
			ok "已删除证书：$domain"
		else
			warn "证书删除失败：$domain"
		fi
	fi
	[[ "$domain" == "" ]] || true
}

# 恢复 --force 覆盖前备份的旧站（add 失败时调用；无备份返回 1）
site_restore_overwrite() {
	local n="$1" bd="${OVERWRITE_BACKUP_DIR:-}"
	[[ -n "$bd" && -d "$bd" && -f "$bd/${n}.conf" ]] || return 1
	local eng
	eng="$(sed -n 's/^SITE_ENGINE=//p' "$bd/${n}.conf" 2>/dev/null | tr -d "'\"" | head -n1)"
	cp -a "$bd/${n}.conf" "$SITES_DIR/${n}.conf" 2>/dev/null
	[[ -f "$bd/${n}.caddy" ]] && cp -a "$bd/${n}.caddy" "$(caddy_site_path "$n")" 2>/dev/null
	[[ -f "$bd/emby-rp-${n}.conf" ]] && cp -a "$bd/emby-rp-${n}.conf" "$(nginx_site_path "$n")" 2>/dev/null
	case "$eng" in
		caddy) apply_caddy >/dev/null 2>&1 || true ;;
		nginx) apply_nginx >/dev/null 2>&1 || true ;;
	esac
	return 0
}

# =============================================================================
#  uninstall
# =============================================================================
residue_audit() {
	info "残留自检…"
	local hits units
	hits="$(find / -xdev \( -path /proc -o -path /sys -o -path /dev -o -path /run \) -prune -o \
		\( -iname '*emby-rp*' -o -iname '*emby_rp*' \) -print 2>/dev/null \
		| grep -vE '^/(var/lib/dpkg|tmp/ep\.sh)' || true)"
	units="$(systemctl list-unit-files 2>/dev/null | grep -i 'emby-rp' || true)"
	if [[ -z "$hits" && -z "$units" ]]; then
		ok "未发现残留。"
	else
		if [[ -n "$hits" ]]; then
			warn "磁盘上仍有以下文件："
			printf '%s\n' "$hits" | sed 's/^/    /'
		fi
		if [[ -n "$units" ]]; then
			warn "systemd 单元："
			printf '%s\n' "$units" | sed 's/^/    /'
		fi
	fi
	if [[ -d /etc/letsencrypt/renewal ]] && ls /etc/letsencrypt/renewal 2>/dev/null | grep -q .; then
		info "/etc/letsencrypt/renewal 下仍有条目（可能属于其它站点）："
		ls /etc/letsencrypt/renewal 2>/dev/null | sed 's/^/    /'
	fi
	if [[ -d /var/log/caddy ]] && ls /var/log/caddy 2>/dev/null | grep -q 'emby-rp'; then
		warn "/var/log/caddy 下仍有 emby-rp 日志"
	fi
	if [[ -f /etc/apt/sources.list.d/caddy-stable.list || -f /usr/share/keyrings/caddy-stable-archive-keyring.gpg ]]; then
		warn "仍有 Caddy 软件源残留：/etc/apt/sources.list.d/caddy-stable.list / keyring"
	fi
	if [[ -d /var/log/caddy ]]; then
		local left; left="$(ls -A /var/log/caddy 2>/dev/null | head -5 | tr '\n' ' ')"
		[[ -n "$left" ]] && info "/var/log/caddy 还有其它内容：$left"
	fi
	if [[ -e "$ALIAS_PATH" || -L "$ALIAS_PATH" ]]; then
		warn "快捷命令仍在：$ALIAS_PATH -> $(readlink "$ALIAS_PATH" 2>/dev/null || printf '非链接')"
	fi
	if [[ -d /var/www/html ]] && [[ -f /var/www/html/index.html ]]; then
		info "/var/www/html 存在（前端目录，常为系统自带，未动）"
	fi
}

cmd_uninstall() {
	need_root uninstall
	local purge_cert=0 purge_engine=0 purge_pkgs=0
	local caddy_by_us nginx_by_us certbot_by_us caddy_repo
	caddy_by_us="$(state_get ENGINE_CADDY_INSTALLED_BY_US 0)"
	nginx_by_us="$(state_get ENGINE_NGINX_INSTALLED_BY_US 0)"
	certbot_by_us="$(state_get CERTBOT_INSTALLED_BY_US 0)"
	caddy_repo="$(state_get CADDY_REPO_ADDED 0)"

	local names domains=() d n
	names="$(list_site_names)"

	hr
	printf '%s卸载 %s %s%s\n' "$C_B" "$CMD_NAME" "$VERSION" "$C_0"
	hr
	if [[ -n "$names" ]]; then
		printf '将删除这些站点：\n'
		printf '%s\n' "$names" | sed 's/^/  - /'
	fi
	printf '将删除：%s、%s、%s、%s\n' "$CONF_DIR" "$ACME_WEBROOT" "$BIN_PATH" "各站点日志"

	confirm "确认卸载？" n || { info "已取消。"; return 0; }
	confirm "同时删除 Let's Encrypt 证书？" n && purge_cert=1
	if [[ "$caddy_by_us" == "1" || "$nginx_by_us" == "1" || "$certbot_by_us" == "1" ]]; then
		confirm "同时卸载本工具装上的软件包（caddy/nginx/certbot）？" n && purge_pkgs=1
	fi

	if [[ -d "$SITES_DIR" ]]; then
		while read -r d; do
			d="$(printf '%s' "$d" | tr -d "'\"")"
			[[ -n "$d" ]] && domains+=("$d")
		done < <(sed -n 's/^SITE_DOMAIN=//p' "$SITES_DIR"/*.conf 2>/dev/null)
	fi

	# 1) 站点配置与日志
	if [[ -n "$names" ]]; then
		while read -r n; do
			[[ -n "$n" ]] || continue
			rm -f "$(caddy_site_path "$n")" "$(nginx_site_path "$n")"
			rm -f "$NGINX_LOG_DIR/emby-rp-${n}.log" "$NGINX_LOG_DIR/emby-rp-${n}.error.log"
			rm -f "$CADDY_LOG_DIR/emby-rp-${n}.log"
			rm -f "$CADDY_LOG_DIR/emby-rp-${n}".log.*
		done <<< "$names"
		ok "站点配置与日志已删除"
	fi

	# 2) Caddyfile 托管块
	if have caddy; then
		caddy_remove_block && info "Caddyfile 托管块已移除"
	fi

	# 3) 证书
	if [[ $purge_cert -eq 1 && ${#domains[@]} -gt 0 ]]; then
		for d in "${domains[@]}"; do
			[[ -d "/etc/letsencrypt/live/$d" ]] || continue
			if have certbot && certbot delete --cert-name "$d" --non-interactive >/dev/null 2>&1; then
				ok "已删除证书：$d"
			else
				warn "证书删除失败：$d"
			fi
		done
	fi

	# 4) 目录与二进制
	rm -rf "$CONF_DIR" "$ACME_WEBROOT"
	rm -f "$BIN_PATH"
	if [[ -L "$ALIAS_PATH" && "$(readlink "$ALIAS_PATH" 2>/dev/null)" == "$BIN_PATH" ]]; then rm -f "$ALIAS_PATH"; fi
	ok "已删除 $CONF_DIR / $ACME_WEBROOT / $BIN_PATH / $ALIAS_PATH"

	# 5) 重载引擎
	if engine_running caddy; then systemctl reload caddy >/dev/null 2>&1 || true; fi
	if engine_running nginx; then systemctl reload nginx >/dev/null 2>&1 || true; fi

	# 6) 软件包
	if [[ $purge_pkgs -eq 1 ]]; then
		local mgr; mgr="$(detect_pkg_mgr)"
		local pkgs=()
		[[ "$caddy_by_us" == "1" ]] && pkgs+=(caddy)
		if [[ "$nginx_by_us" == "1" ]]; then
			pkgs+=(nginx)
			# Debian 系 purge nginx 会留下 nginx-common（带 /etc/nginx），一并删掉
			if [[ "$mgr" == "apt" ]]; then pkgs+=(nginx-common); fi
		fi
		[[ "$certbot_by_us" == "1" ]] && pkgs+=(certbot)
		if [[ ${#pkgs[@]} -gt 0 ]]; then
			info "卸载软件包：${pkgs[*]}"
			case "$mgr" in
				apt) DEBIAN_FRONTEND=noninteractive apt-get purge -y -qq "${pkgs[@]}" >/dev/null 2>&1 && ok "已卸载" || warn "卸载未全部成功" ;;
				dnf|yum) "$mgr" remove -y -q "${pkgs[@]}" >/dev/null 2>&1 && ok "已卸载" || warn "卸载未全部成功" ;;
				apk) apk del "${pkgs[@]}" >/dev/null 2>&1 && ok "已卸载" || warn "卸载未全部成功" ;;
				*) warn "未知包管理器，请手动卸载：${pkgs[*]}" ;;
			esac
		fi
	fi

	# 7) 本工具添加的 apt 软件源
	if [[ "$caddy_repo" == "1" ]]; then
		rm -f /etc/apt/sources.list.d/caddy-stable.list \
			/usr/share/keyrings/caddy-stable-archive-keyring.gpg \
			/etc/apt/trusted.gpg.d/caddy-stable-archive-keyring.gpg
		if have apt-get; then apt-get update -qq >/dev/null 2>&1 || true; fi
		ok "已删除 Caddy 软件源与 GPG 密钥"
	fi

	hr
	residue_audit
	hr
	info "当前会话仍在内存中运行，退出后 ${CMD_NAME} 命令即消失。"
	return 0
}

# =============================================================================
#  usage / menu / main
# =============================================================================
usage() {
	cat <<EOF
${CMD_NAME} ${VERSION} — Emby / Jellyfin 反向代理管理器

用法： ${CMD_NAME} <命令> [选项]

命令：
  （直接敲 ${ALIAS_NAME} 也能进菜单：${ALIAS_NAME} = ${CMD_NAME} 的快捷入口）
  add        新建站点（不带参数进入向导）
  list       列出站点
  status     查看站点详情        $ ${CMD_NAME} status [name]
  check      连通性 / 证书自检    $ ${CMD_NAME} check [name]
  logs       看日志（-f 跟踪）    $ ${CMD_NAME} logs [name] [-f]
  render     只打印渲染结果，不写文件
  remove     删除站点            $ ${CMD_NAME} remove <name>
  uninstall  彻底卸载（含残留自检）
  menu       交互菜单（直接执行 ${CMD_NAME} / ${ALIAS_NAME} 无参数也是这个）

add 选项：
  -d, --domain <域名>            主域名（必填）
  -e, --engine caddy|nginx       默认 caddy
  -m, --mode standalone|split    默认 standalone
  -p, --prefix </emby>           split 模式对外前缀，默认 /emby
      --keep / --strip           split 模式是否保留前缀，默认 keep
  -F, --frontend <dir:/path|URL> split 模式的前端位置
      -u, --upstream <URL>           后端，默认 http://127.0.0.1:8096
                                     可省略协议与端口：stream-1.example.com → https://stream-1.example.com:443
      --tls auto|file|none       默认 auto
      --cert <路径> --key <路径>  tls=file 时必填
      --email <邮箱>             ACME 联系邮箱
      --http-port <端口> --https-port <端口>
      --http2 on|off             仅 nginx，默认 off（CVE-2026-123007）
      --cf                       前端走 Cloudflare（从 Cf-Connecting-IP 取真实 IP）
      --upstream-insecure        上游证书自签时跳过校验（会自动检测）
      --upstream-host <host>     传给上游的 Host 头（默认自动用上游自身域名，不带端口）
  -R, --rewrite <from[=>to]>     nginx：替换响应体里的域名（可重复）
                                 --rewrite stream-1.a.com=>wawo3.lhc520.com
                                 只写 from 时换成本站域名；依赖 sub_filter，仅 nginx
      --host-mode upstream|client|upstream-port
                                 upstream=只用上游域名（默认，推荐）
                                 upstream-port=上游域名:端口（有的站会拒绝）
                                 client=客户端访问的域名（老行为）
      --no-log                   不写访问日志
  -n, --name <名字>              站点名，默认由域名生成
      --force                    同名站点已存在时直接覆盖（先拆旧配置再建）
  -y, --yes                      全部用默认值，不提问

examples:
  # 独立反代（整站 HTTPS）
  ${CMD_NAME} add -d emby.example.com -y

  # 前后端分离：域名根给前端，/emby 给后端，保留前缀
  ${CMD_NAME} add -d emby.example.com -m split -p /emby \\
      -F dir:/var/www/emby-web -u http://127.0.0.1:8096 -y

  # 前后端分离 + Nginx + 后端是自签 HTTPS
  ${CMD_NAME} add -d emby.example.com -e nginx -m split \\
      -F http://127.0.0.1:8080 -u https://10.0.0.5:8920 --upstream-insecure -y

split 模式下默认 keep（不剥前缀），需要把 Emby 的 Base URL 设成前缀本身：
  Emby:     设置 → 高级 → 主机(Base URL) = /emby
  Jellyfin: 控制台 → 网络 → Base URL   = /emby
若后端是别人的、动不了 Base URL，请加 --strip（前缀会被剥离，官方 Web UI 会半残）。

环境变量：
  EMBY_RP_YES=1     所有确认自动为“是”（适合脚本化）
  NO_COLOR=1        关闭颜色
  EMBY_RP_TAIL=<n>  logs 默认显示行数（默认 80）
EOF
}

menu() {
	while true; do
		printf '\n'
		hr
		printf '%s %s %s %s\n' "$C_B" "$CMD_NAME" "$VERSION" "$C_0"
		hr
		printf '  1) 新建站点\n'
		printf '  2) 列出站点\n'
		printf '  3) 查看站点详情\n'
		printf '  4) 连通性自检\n'
		printf '  5) 查看日志\n'
		printf '  6) 只渲染配置（不写入）\n'
		printf '  7) 删除站点\n'
		printf '  0) 退出\n'
		hr
		local c; c="$(ask "选择")"
		case "$c" in
			1) cmd_add ;;
			2) cmd_list ;;
			3) cmd_status ;;
			4) cmd_check ;;
			5) cmd_logs ;;
			6) cmd_render ;;
			7) cmd_remove ;;
			0|q|Q) return 0 ;;
			'') return 0 ;;
			*) warn "无效选项：$c" ;;
		esac
	done
}

main() {
	local cmd="${1:-}"
	[[ $# -gt 0 ]] && shift

	# root 下每次执行都确保命令已安装 / 已升级（静默）
	[[ "$(id -u)" == "0" ]] && self_install quiet
	case "$cmd" in
		add|new)          cmd_add "$@" ;;
		list|ls)          cmd_list ;;
		status|info)      cmd_status "$@" ;;
		check|test)       cmd_check "$@" ;;
		logs|log)         cmd_logs "$@" ;;
		render|dry-run)   cmd_render "$@" ;;
		remove|rm|del)    cmd_remove "$@" ;;
		uninstall|purge)  cmd_uninstall "$@" ;;
		menu)             menu ;;
		version|-V|--version) printf '%s %s\n' "$CMD_NAME" "$VERSION" ;;
		help|-h|--help)   usage ;;
		"")               menu ;;
		*)                die "未知命令：$cmd（${CMD_NAME} --help）" ;;
	esac
}

# 直接执行才跑 main；source 时不执行（便于测试渲染）
if [[ "${BASH_SOURCE[0]:-$0}" == "$0" ]]; then
	main "$@"
fi


