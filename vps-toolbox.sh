#!/usr/bin/env bash
# ==============================================================================
#  VPS 常用工具箱  (vps-toolbox)
#
#  把常用的一键脚本整合成一个带菜单的入口。
#
#  用法:
#     bash vps-toolbox.sh                # 本地运行
#     curl -fsSL <地址> | bash           # 在线运行（已处理 tty，可正常交互）
#     bash <(curl -fsSL <地址>)
#
#  说明:
#     · 所有需要输入的地方都强制从 /dev/tty 读取，所以 curl|bash 也不会出错
#     · 交互式子脚本的 stdin 也从 /dev/tty 接入
#     · 每项执行完会暂停，按回车回到菜单
# ==============================================================================
set -uo pipefail

VERSION="2.5"

# 安装后的命令名
CMD_NAME="qc"
INSTALL_PATH="/usr/local/bin/${CMD_NAME}"


# BBR / TCP 调优（Eric86777/vps-tcp-tune）
NET_TUNE_URL="https://raw.githubusercontent.com/Eric86777/vps-tcp-tune/refs/heads/main/net-tcp-tune.sh"

# WARP (warp-go) —— fscarmen/warp，纯用户态实现，专治「纯 IPv6 机器没有 IPv4」
WARPGO_URL="https://gitlab.com/fscarmen/warp/-/raw/main/warp-go.sh"

# NAT64 / DNS64 网关（第三方公共服：Mythic Beasts 英国 / Hetzner 德国）
# 只换 DNS 就能让纯 IPv6 机器访问 IPv4 域名，但对 IPv4 字面量无效
NAT64_DNS="2a00:1098:2b::1 2a00:1098:2c::1 2a01:4f8:c2c:123f::1"

# Docker 官方安装脚本
DOCKER_GET_URL="https://get.docker.com"

# 自身在线地址（自安装/自更新时按顺序尝试，第一个成功即止）
# 可用环境变量覆盖，例如：
#   SELF_URL="https://raw.githubusercontent.com/Masamisuki/Tool/main/vps-toolbox.sh" \
#     bash vps-toolbox.sh install
SELF_URLS=(
  "${SELF_URL:-https://raw.githubusercontent.com/Masamisuki/Tool/main/vps-toolbox.sh}"
  "https://cdn.jsdelivr.net/gh/Masamisuki/Tool@main/vps-toolbox.sh"
  "https://raw.gitmirror.com/Masamisuki/Tool/main/vps-toolbox.sh"
  "https://ghfast.top/https://raw.githubusercontent.com/Masamisuki/Tool/main/vps-toolbox.sh"
)

# ---------------------------------------------------------------- tty 检测
# 注意：不能只用 `[ -r /dev/tty ]`，ssh 无 pty 时该判断会误判，
#       必须真正尝试打开一次。
HAVE_TTY=0
if { true < /dev/tty; } 2>/dev/null; then HAVE_TTY=1; fi

# ---------------------------------------------------------------- 颜色
if [ "$HAVE_TTY" = 1 ] || [ -t 1 ]; then
  RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'
  BLUE=$'\033[0;34m'; CYAN=$'\033[0;36m'; MAGENTA=$'\033[0;35m'
  BOLD=$'\033[1m'; DIM=$'\033[2m'; NC=$'\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; BLUE=''; CYAN=''; MAGENTA=''; BOLD=''; DIM=''; NC=''
fi

# ---------------------------------------------------------------- 基础输出
hr()    { printf '%s\n' "${DIM}──────────────────────────────────────────────────────────────${NC}"; }
info()  { printf '  %s\n' "$1"; }
dim()   { printf '  %s%s%s\n' "$DIM" "$1" "$NC"; }
ok()    { printf '  %s✔%s %s\n' "$GREEN" "$NC" "$1"; }
warn()  { printf '  %s⚠%s %s\n' "$YELLOW" "$NC" "$1"; }
err()   { printf '  %s✘%s %s\n' "$RED" "$NC" "$1"; }
step()  { printf '\n%s▸ %s%s\n' "$BOLD" "$1" "$NC"; }

# ---------------------------------------------------------------- 输入（关键）
# 优先读 /dev/tty，保证 `curl | bash` 时也能交互
# 返回非 0 表示读到 EOF（Ctrl+D），调用方应据此退出
ask() {
  local prompt="$1" __var="$2" __in=''
  if [ "$HAVE_TTY" = 1 ]; then
    if ! read -r -p "$prompt" __in < /dev/tty; then printf -v "$__var" '%s' ''; return 1; fi
  else
    if ! read -r -p "$prompt" __in; then printf -v "$__var" '%s' ''; return 1; fi
  fi
  printf -v "$__var" '%s' "$__in"
  return 0
}

pause() {
  local _dummy
  ask $'\n'"${DIM}按回车返回菜单 ...${NC}" _dummy || true
}

confirm() {
  local a
  ask "  ${YELLOW}$1 [y/N]: ${NC}" a
  case "$a" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# ---------------------------------------------------------------- root 检查
if [ "$(id -u)" -ne 0 ]; then
  printf '%s\n' "${YELLOW}本工具多数功能需要 root 权限。${NC}"
  if [ -f "$0" ] && [ -r "$0" ]; then
    printf '%s\n' "正在尝试用 sudo 重新运行 ..."
    exec sudo -E bash "$0" "$@"
  else
    printf '%s\n' "${RED}请用 root 运行，例如： sudo bash vps-toolbox.sh${NC}"
    exit 1
  fi
fi

# ---------------------------------------------------------------- 下载并执行
HAVE_CURL=0; command -v curl >/dev/null 2>&1 && HAVE_CURL=1
HAVE_WGET=0; command -v wget >/dev/null 2>&1 && HAVE_WGET=1

fetch() {   # fetch <url> <outfile>
  local url="$1" out="$2"
  if [ "$HAVE_CURL" = 1 ]; then
    curl -q -fsSL --connect-timeout 20 --retry 2 --retry-delay 2 "$url" -o "$out"
  elif [ "$HAVE_WGET" = 1 ]; then
    wget -q -T 20 -t 2 -O "$out" "$url"
  else
    err "curl / wget 都没有，请先执行「1. 安装基础依赖」"
    return 1
  fi
}

# run_remote <显示名> <url> [解释器] [传给脚本的参数...]
run_remote() {
  local name="$1" url="$2" interp="${3:-bash}"; shift 3 || true
  local tmp rc=0 base dir
  # 用 URL 里的文件名落盘：部分脚本会读 $0 判断自身名字（例如 warp-go 的自更新）
  base="$(printf '%s' "${url%%\?*}" | sed 's|.*/||; s|[^A-Za-z0-9._-]|_|g')"
  [ -n "$base" ] || base="script.sh"
  dir="$(mktemp -d "${TMPDIR:-/tmp}/vpstool.XXXXXX")"
  tmp="$dir/$base"

  step "下载 $name"
  dim "$url"
  if ! fetch "$url" "$tmp"; then
    err "下载失败（网络不通 / 地址失效 / 被墙）"
    rm -rf "$dir"; return 1
  fi
  if [ ! -s "$tmp" ]; then
    err "下载内容为空"
    rm -rf "$dir"; return 1
  fi
  ok "已下载 $(wc -c < "$tmp") 字节"

  step "执行 $name"
  dim "交互式操作请按提示直接输入；Ctrl+C 可中断"
  hr
  if [ "$HAVE_TTY" = 1 ]; then
    "$interp" "$tmp" "$@" < /dev/tty
  else
    "$interp" "$tmp" "$@"
  fi
  rc=$?
  hr
  if [ "$rc" -eq 0 ]; then ok "$name 执行完成"
  elif [ "$rc" -ge 130 ]; then warn "$name 被中断（退出码 $rc）"
  else warn "$name 退出码 $rc，请留意上方输出"; fi
  rm -rf "$dir"
  return 0
}

# ================================================================ 各项功能

act_deps() {
  local missing="" c
  step "安装基础依赖：sudo curl wget ca-certificates"
  for c in sudo curl wget; do
    command -v "$c" >/dev/null 2>&1 || missing="$missing $c"
  done
  if [ -z "$missing" ]; then ok "所需命令都已存在"; return 0; fi
  info "缺少:$missing"
  if   command -v apt-get >/dev/null 2>&1; then apt-get update -y && apt-get install -y $missing ca-certificates
  elif command -v dnf     >/dev/null 2>&1; then dnf install -y $missing ca-certificates
  elif command -v yum     >/dev/null 2>&1; then yum install -y $missing ca-certificates
  elif command -v apk     >/dev/null 2>&1; then apk add --no-cache $missing ca-certificates
  elif command -v pacman  >/dev/null 2>&1; then pacman -Sy --noconfirm $missing ca-certificates
  elif command -v zypper  >/dev/null 2>&1; then zypper -n install $missing ca-certificates
  else err "未识别的包管理器"; return 1; fi
  for c in $missing; do
    command -v "$c" >/dev/null 2>&1 && ok "$c 安装成功" || err "$c 仍然缺失"
  done
  HAVE_CURL=0; command -v curl >/dev/null 2>&1 && HAVE_CURL=1
  HAVE_WGET=0; command -v wget >/dev/null 2>&1 && HAVE_WGET=1
}

act_timezone() {
  local tz="${1:-Asia/Shanghai}"
  step "设置时区为 $tz"
  if command -v timedatectl >/dev/null 2>&1; then
    if timedatectl set-timezone "$tz" 2>/dev/null; then
      ok "已设置：$(timedatectl show -p Timezone --value 2>/dev/null)"
    else
      err "设置失败"; return 1
    fi
  else
    ln -sf "/usr/share/zoneinfo/$tz" /etc/localtime && echo "$tz" > /etc/timezone
    ok "已设置：$(cat /etc/timezone 2>/dev/null)"
  fi
  info "当前时间：$(date '+%Y-%m-%d %H:%M:%S %Z')"
}

act_journal() {
  local f=/etc/systemd/journald.conf size="${1:-500M}"
  step "限制 journald 日志为 $size（单文件 50M）"
  if ! command -v journalctl >/dev/null 2>&1; then err "没有 systemd-journald，跳过"; return 1; fi
  info "清理前：$(journalctl --disk-usage 2>/dev/null | sed 's/^/  /')"
  journalctl --vacuum-size="$size" >/dev/null 2>&1 || true
  [ -f "$f" ] && cp -a "$f" "$f.bak-$(date +%Y%m%d-%H%M)" 2>/dev/null
  touch "$f"
  if grep -qE '^#?\s*SystemMaxUse=' "$f"; then
    sed -i -E "s|^#?\s*SystemMaxUse=.*|SystemMaxUse=$size|" "$f"
  else
    printf 'SystemMaxUse=%s\n' "$size" >> "$f"
  fi
  if grep -qE '^#?\s*SystemMaxFileSize=' "$f"; then
    sed -i -E 's|^#?\s*SystemMaxFileSize=.*|SystemMaxFileSize=50M|' "$f"
  else
    printf 'SystemMaxFileSize=50M\n' >> "$f"
  fi
  systemctl restart systemd-journald 2>/dev/null && ok "已生效"
  info "生效配置：$(grep -E '^SystemMax(Use|FileSize)=' "$f" | tr '\n' ' ')"
  info "清理后：$(journalctl --disk-usage 2>/dev/null | sed 's/^/  /')"
}

act_bootstrap() {
  step "一键基础初始化（依赖 + 时区 + 日志限制）"
  act_deps; echo
  act_timezone; echo
  act_journal
  echo
  ok "基础初始化完成"
}

# 把 bbr 装成 /usr/local/bin/bbr 真实命令。
# 官方做法是往 ~/.bashrc 写 alias，但 alias 必须 source 或重连 SSH 才生效，
# 所以这里额外落一个可执行文件：任何 shell、任何时刻敲 bbr 都能用。
install_bbr_cmd() {
  local dst="/usr/local/bin/bbr"
  mkdir -p /usr/local/bin 2>/dev/null || { err "无法创建 /usr/local/bin"; return 1; }
  cat > "$dst" <<'BBR_CMD_EOF'
#!/usr/bin/env bash
# bbr —— net-tcp-tune 快捷入口（由 vps-toolbox 安装）
# 等价于官方别名：
#   alias bbr="bash <(curl -q -fsSL ".../net-tcp-tune.sh?$(date +%s)")"
set -uo pipefail
URL="https://raw.githubusercontent.com/Eric86777/vps-tcp-tune/refs/heads/main/net-tcp-tune.sh?$(date +%s)"
TMP="$(mktemp "${TMPDIR:-/tmp}/net-tcp-tune.XXXXXX.sh")"
if command -v curl >/dev/null 2>&1; then
  curl -q -fsSL --connect-timeout 20 --retry 2 "$URL" -o "$TMP" || { echo "下载 net-tcp-tune.sh 失败" >&2; rm -f "$TMP"; exit 1; }
elif command -v wget >/dev/null 2>&1; then
  wget -q -T 20 -t 2 -O "$TMP" "$URL" || { echo "下载 net-tcp-tune.sh 失败" >&2; rm -f "$TMP"; exit 1; }
else
  echo "需要 curl 或 wget，请先在工具箱里执行「1. 安装基础依赖」" >&2
  exit 1
fi
[ -s "$TMP" ] || { echo "下载内容为空" >&2; rm -f "$TMP"; exit 1; }
bash "$TMP"
rc=$?
rm -f "$TMP"
exit $rc
BBR_CMD_EOF
  chmod +x "$dst" 2>/dev/null || { err "chmod 失败"; return 1; }
  [ -s "$dst" ] || { err "写入失败"; return 1; }
  return 0
}

act_net_tune() {
  step "BBR v3 优化 —— net-tcp-tune"
  info "Eric86777/vps-tcp-tune 主脚本，带完整交互菜单"
  echo

  # 先确保 bbr 命令存在，否则用户装完敲 bbr 会 command not found
  if command -v bbr >/dev/null 2>&1; then
    ok "bbr 命令已就绪：$(command -v bbr)"
  else
    info "先安装 bbr 快捷命令 ..."
    if install_bbr_cmd; then
      ok "已安装 /usr/local/bin/bbr"
      dim "任何 shell 直接敲 bbr 即可，不需要 source"
    else
      warn "bbr 命令安装失败，但下面仍会直接运行调优脚本"
    fi
  fi
  echo

  run_remote "net-tcp-tune" "${NET_TUNE_URL}?$(date +%s)" bash

  echo
  info "以后随时输入 ${BOLD}bbr${NC} 即可再次打开调优菜单"
}

act_tcpfit() {
  step "tcpfit —— 单机 TCP 精细调优"
  info "实测推导参数，不使用抄来的固定值；交互式菜单"
  run_remote "tcpfit" \
    "https://raw.githubusercontent.com/Kylin010/tcpfit/main/tcpfit.sh?$(date +%s)" \
    bash
}

act_keysh() {
  step "key.sh —— SSH 安全加固（密钥登录 / 端口 / 防爆破）"
  warn "此脚本会修改 SSH 配置，请务必先确认新的登录方式可用再断开当前连接"
  if ! confirm "确认继续？"; then warn "已取消"; return 0; fi
  run_remote "key.sh" \
    "https://raw.githubusercontent.com/BeacherZ/key.sh/main/key.sh?$(date +%s)" \
    bash
}

act_embyproxy() {
  step "emby-proxy —— Emby HTTPS 反代管理器（Caddy / Nginx）"
  info "给 Emby 源站快速套一层域名 HTTPS 反代，支持多个入口和同域名多路径"
  echo

  local up="https://raw.githubusercontent.com/wuuduf/emby-proxy/main/setup-emby-proxy.sh"
  local cmd="bash <(curl -fsSL ${up})"

  # ---------- 检测是否已经装过 ----------
  local installed=0
  if [ -x /usr/local/bin/ep ] || [ -x /usr/bin/ep ] \
     || command -v ep >/dev/null 2>&1 \
     || [ -d /opt/emby-proxy ] || [ -d /etc/emby-proxy ]; then
    installed=1
  fi

  if [ "$installed" = 1 ]; then
    # ================= 已安装：不询问，直接执行 =================
    ok "检测到 emby-proxy 已安装 —— 直接执行（升级 / 重新配置）"
    dim "  已有站点配置会被保留，脚本只追加它自己托管的部分"
    command -v ep >/dev/null 2>&1 && dim "  短命令: $(command -v ep)"
    echo
    info "执行："
    dim "  $cmd"
    echo
  else
    info "执行作者提供的原始命令（未做任何修改）："
    echo
    dim "  $cmd"
    echo
    dim "  装完可用短命令: ep"
    dim "  要求: Debian/Ubuntu + systemd，安全组放行 80/443，域名 A 记录指向本机"
    dim "  脚本只允许固定源站，不会被当成通用代理"
    echo
    if ! confirm "确认执行？"; then warn "已取消"; return 0; fi
    echo
  fi

  if [ "$HAVE_TTY" = 1 ]; then
    bash -c "$cmd" < /dev/tty
  else
    bash -c "$cmd"
  fi

  echo
  info "装完之后："
  dim "  ep            打开菜单"
  dim "  ep doctor     自检（系统/DNS/端口/源站）"
  dim "  ep status     查看现有入口"
  dim "  菜单里选 3    新增反代入口"
  echo
  dim "  访问验证: https://你的域名/"
  dim "  ⚠️ /_emby_proxy_health 返回 200 只代表反代链路通，不代表 Emby 能登录/播放"
}

act_warpgo() {
  step "WARP (warp-go) —— 给纯 IPv6 机器加 IPv4 出口"
  info "fscarmen/warp 的 warp-go.sh；纯用户态实现，不碰内核，兼容性最好"
  echo
  dim "  适用：机器只有 IPv6，但需要 IPv4 下载东西 / 跑脚本 / 访问 IPv4-only 站点"
  dim "  装完命令：warp-go（之后直接敲 warp-go 进菜单）"
  echo
  info "  ${BOLD}菜单里选 2${NC} = 「IPv4 全局 + IPv6 优先」（推荐）"
  dim "  只加 IPv4 接口，IPv6 保持原生 —— 只有纯 IPv4 的站点才走 WARP"
  warn "不要选 3~7：那些会把 IPv6 一起劫持，原生 IPv6 性能会崩"
  echo
  warn "「全局」会改写 IPv4 默认路由，确认机器上没有别的 IPv4 配置"

  # ---------- 检测是否已经装过 ----------
  local installed=0
  if command -v warp-go >/dev/null 2>&1 || [ -x /opt/warp-go/warp-go ] || [ -d /opt/warp-go ]; then
    installed=1
  fi

  if [ "$installed" = 1 ]; then
    ok "检测到 warp-go 已安装 —— 直接执行（重新配置 / 重装）"
    [ -x /opt/warp-go/warp-go ] && dim "  程序: /opt/warp-go/warp-go"
    command -v warp-go >/dev/null 2>&1 && dim "  短命令: $(command -v warp-go)"
    echo
  else
    if ! confirm "确认继续？"; then warn "已取消"; return 0; fi
  fi

  run_remote "warp-go.sh" "$WARPGO_URL" bash

  echo
  step "验证出口"
  local v4 v6
  v4=$(curl -4 -s --max-time 10 https://ifconfig.me 2>/dev/null)
  v6=$(curl -6 -s --max-time 10 https://ifconfig.me 2>/dev/null)
  if [ -n "$v4" ]; then ok "IPv4 出口: $v4      ${DIM}(应该是 Cloudflare 的地址)${NC}"
  else warn "IPv4 出口取不到 —— 检查 WARP 是否已启动"; fi
  if [ -n "$v6" ]; then ok "IPv6 出口: $v6      ${DIM}(应该还是你原来的)${NC}"
  else dim "  IPv6 出口取不到（这台可能没有 IPv6）"; fi
  echo

  if command -v warp-go >/dev/null 2>&1; then
    ok "warp-go 已就绪：$(command -v warp-go)"
  else
    dim "  没看到 warp-go 命令，重新登录 SSH 或执行 hash -r 再试"
  fi
}

act_nat64() {
  local a
  step "NAT64 / DNS64 —— 纯 IPv6 机器的 IPv4 出口（只换 DNS）"
  info "由第三方 NAT64 网关把 IPv4 目标合成成 IPv6 地址，不用装任何软件"
  echo
  dim "  DNS: $NAT64_DNS"
  dim "  归属: Mythic Beasts（英国 Cambridge） / Hetzner（德国）"
  echo
  warn "只对【域名】生效 —— 直接写 IPv4 字面量（如 1.2.3.4）完全无效"
  warn "所有 IPv4 流量绕英国/德国（延迟 +200ms），依赖第三方个人项目，随时可能失效"
  dim "  要稳定可靠的 IPv4 出口，请改用「WARP (warp-go)」"
  echo
  info "  1) 应用 NAT64 DNS（自动备份原配置）"
  info "  2) 恢复 / 移除 NAT64 配置"
  info "  0) 返回"
  echo
  ask "  请选择 [0-2]: " a
  case "${a:-0}" in
    1)
      local ts; ts="$(date +%Y%m%d-%H%M%S)"
      cp -a /etc/resolv.conf "/root/resolv.conf.bak-$ts" 2>/dev/null || true
      if systemctl is-active --quiet systemd-resolved 2>/dev/null || [ -L /etc/resolv.conf ]; then
        info "检测到 systemd-resolved —— 用 drop-in 配置（重启后不会被覆盖）"
        mkdir -p /etc/systemd/resolved.conf.d
        cat > /etc/systemd/resolved.conf.d/99-nat64.conf <<RESOLVED_EOF
[Resolve]
DNS=$NAT64_DNS
FallbackDNS=223.5.5.5 119.29.29.29
Domains=~.
RESOLVED_EOF
        if systemctl restart systemd-resolved 2>/dev/null; then
          ok "已应用 /etc/systemd/resolved.conf.d/99-nat64.conf"
        else
          err "systemd-resolved 重启失败"; return 1
        fi
      else
        { for n in $NAT64_DNS; do echo "nameserver $n"; done; } > /etc/resolv.conf
        ok "已写入 /etc/resolv.conf"
      fi
      echo
      info "验证（应该看到 2a00:1098: / 2a01:4f8: 开头的合成地址）："
      getent ahostsv6 ipv4.google.com 2>/dev/null | awk '{print $1}' | sort -u | head -3 | sed 's/^/    /' \
        || warn "解析失败 —— 检查这台机器到 IPv6 DNS 的连通性"
      ;;
    2)
      rm -f /etc/systemd/resolved.conf.d/99-nat64.conf
      systemctl restart systemd-resolved 2>/dev/null || true
      local f
      f="$(ls -1t /root/resolv.conf.bak-* 2>/dev/null | head -1)"
      if [ -n "$f" ] && [ ! -L "$f" ]; then
        cp -a "$f" /etc/resolv.conf
        ok "已恢复 /etc/resolv.conf（来自 $f）"
      else
        ok "已移除 NAT64 的 resolved 配置"
      fi
      resolvectl status 2>/dev/null | head -8 | sed 's/^/    /'
      ;;
    *) return 0 ;;
  esac
}

act_lite() {
  step "Komari / Lite Agent 安装"
  info "nuomiiiii/lite 的 POSIX 安装脚本（systemd 与 OpenWrt 通用）"
  run_remote "install-lite.sh" \
    "https://raw.githubusercontent.com/nuomiiiii/lite/main/install-lite.sh?$(date +%s)" \
    sh
}

act_nodequality() {
  step "NodeQuality —— 综合测评（IP 质量 / 硬件 / 网络 / 回程）"
  info "会下载 BenchOS 运行环境，耗时较长（数分钟）"
  run_remote "NodeQuality" "https://run.NodeQuality.com?$(date +%s)" bash
}

act_tcpquality() {
  step "TcpQuality —— TCP 质量测试"
  info "默认在临时 Debian rootfs 的 chroot 中运行"
  run_remote "TcpQuality" \
    "https://raw.githubusercontent.com/ibsgss/TcpQuality/main/runTcpQuality.sh?$(date +%s)" \
    bash
}

act_iperf3() {
  step "iperf3 服务端 —— 状态 / 启动 / 停止"
  info "需要测速时才启动，用完可以关掉（不占端口、不随开机启动）"
  echo

  # ---------- 确保已安装 ----------
  if ! command -v iperf3 >/dev/null 2>&1; then
    info "iperf3 未安装，正在安装 ..."
    if command -v apt-get >/dev/null 2>&1; then
      apt-get update -qq >/dev/null 2>&1
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iperf3 >/dev/null 2>&1
    elif command -v dnf >/dev/null 2>&1; then
      dnf install -y -q iperf3 >/dev/null 2>&1
    elif command -v yum >/dev/null 2>&1; then
      yum install -y -q iperf3 >/dev/null 2>&1
    elif command -v apk >/dev/null 2>&1; then
      apk add --no-cache iperf3 >/dev/null 2>&1
    fi
    if ! command -v iperf3 >/dev/null 2>&1; then
      err "自动安装失败，请手动装：apt install -y iperf3"
      return 1
    fi
    ok "已安装：$(iperf3 --version 2>&1 | head -1)"
  fi

  local a running curport port myip unit_state
  while true; do
    # ---------- 刷新状态 ----------
    running=0; curport=""
    if pgrep -x iperf3 >/dev/null 2>&1; then
      running=1
      curport=$(ss -tlnp 2>/dev/null | grep iperf3 | head -1 | sed -E 's/.*:([0-9]+)[[:space:]].*/\1/')
    fi
    unit_state=""
    if systemctl list-unit-files 2>/dev/null | grep -q '^iperf3\.service'; then
      unit_state=$(systemctl is-enabled iperf3.service 2>/dev/null || echo unknown)
    fi

    echo
    hr
    if [ "$running" = 1 ]; then
      ok "当前状态：iperf3 【运行中】"
      printf '    PID  : %s\n' "$(pgrep -x iperf3 | tr '\n' ' ')"
      printf '    端口 : %s\n' "${curport:-未知}"
      ss -tlnp 2>/dev/null | grep iperf3 | sed 's/^/    /'
    else
      warn "当前状态：iperf3 【未运行 / 已关闭】"
      dim "    不占端口，也不随开机启动 —— 只有你手动启动时才会跑"
    fi
    if [ -n "$unit_state" ] && [ "$unit_state" = "enabled" ]; then
      warn "检测到 iperf3.service 处于 enabled（开机会自动启动）"
      dim "    永久关闭开机自启: systemctl disable --now iperf3"
    fi
    hr
    echo
    info "  1) 启动（可指定端口，默认 5201）"
    info "  2) 停止（关闭，释放端口）"
    info "  3) 重启（换端口）"
    info "  4) 显示测速命令"
    info "  0) 返回"
    echo
    if ! ask "  请选择 [0-4]: " a; then return 0; fi

    case "${a:-0}" in
      1)
        if [ "$running" = 1 ]; then
          warn "已经在运行（端口 ${curport:-?}）。要换端口请选 3。"
        else
          if ! ask "  监听端口 [默认 5201]: " port; then return 0; fi
          port="${port:-5201}"
          if ! [ "$port" -ge 1 ] 2>/dev/null || [ "$port" -gt 65535 ] 2>/dev/null; then
            err "端口不合法：$port"; continue
          fi
          iperf3 -s -D -p "$port" >/dev/null 2>&1 || true
          sleep 1
          if pgrep -x iperf3 >/dev/null 2>&1; then
            ok "已启动（端口 $port）"
            dim "  防火墙放行: iptables -I INPUT -p tcp --dport $port -j ACCEPT"
            dim "  ⚠️ 云安全组也要放行 TCP $port"
          else
            err "启动失败 —— 端口 $port 可能被占用"
            ss -tlnp 2>/dev/null | grep ":$port " | sed 's/^/    /' || true
          fi
        fi
        ;;
      2)
        if [ "$running" = 1 ]; then
          pkill -x iperf3 2>/dev/null || true
          sleep 1
          if pgrep -x iperf3 >/dev/null 2>&1; then
            err "停止失败，进程还在：$(pgrep -x iperf3 | tr '\n' ' ')"
          else
            ok "已停止，端口已释放"
          fi
        else
          dim "  本来就没在跑"
        fi
        ;;
      3)
        if [ "$running" = 0 ]; then
          warn "当前没在运行，请选 1 启动"
        else
          if ! ask "  新端口 [当前 ${curport:-5201}]: " port; then return 0; fi
          port="${port:-5201}"
          pkill -x iperf3 2>/dev/null || true
          sleep 1
          iperf3 -s -D -p "$port" >/dev/null 2>&1 || true
          sleep 1
          if pgrep -x iperf3 >/dev/null 2>&1; then
            ok "已重启到端口 $port"
          else
            err "重启失败 —— 端口 $port 可能被占用"
          fi
        fi
        ;;
      4)
        if [ "$running" = 1 ]; then
          myip=""
          if [ "$HAVE_CURL" = 1 ]; then
            myip=$(curl -4 -s --max-time 5 https://ifconfig.me 2>/dev/null)
          elif [ "$HAVE_WGET" = 1 ]; then
            myip=$(wget -q -T 5 -t 1 -O - https://ifconfig.me 2>/dev/null)
          fi
          myip="${myip:-<本机IP>}"
          echo
          info "在【另一台机器】上跑："
          dim "  iperf3 -c $myip -p ${curport:-5201} -t 30 -P 8 -R      # 下载方向（服务器→你）"
          dim "  iperf3 -c $myip -p ${curport:-5201} -t 30 -P 8         # 上传方向（你→服务器）"
          echo
          dim "  -P 8 是多流（单流受 TCP 拥塞影响，测不准）；-R 是反向"
        else
          warn "iperf3 没在运行，先选 1 启动"
        fi
        ;;
      *) return 0 ;;
    esac
  done
}

act_docker() {
  step "Docker 安装 —— 容器化应用的前置依赖"
  if command -v docker >/dev/null 2>&1; then
    ok "Docker 已安装：$(docker --version 2>/dev/null)"
    docker compose version 2>/dev/null | sed 's/^/    /' || true
    docker info --format '    数据目录: {{.DockerRootDir}}   存储驱动: {{.Driver}}' 2>/dev/null || true
    printf '    服务状态: '; systemctl is-active docker 2>/dev/null || echo unknown
    local cnt
    cnt=$(docker ps -q 2>/dev/null | wc -l)
    printf '    运行中容器: %s 个\n' "${cnt:-0}"
    echo
    dim "  已安装，跳过安装（重装会重启 docker 守护进程，把所有容器停掉）"
    dim "  真要重装：curl -fsSL $DOCKER_GET_URL | sh"
    echo
    info "常用命令："
    dim "  docker ps                看运行中的容器"
    dim "  docker compose up -d     按当前目录的 compose 启动"
    dim "  docker system df         看空间占用"
    dim "  docker image prune -f    清悬空镜像"
    return 0
  fi

  info "将使用 Docker 官方脚本：$DOCKER_GET_URL"
  dim "  自动配置 apt/yum 源，安装 docker-ce + compose 插件 + buildx"
  dim "  国内机器如果卡住，先在「1) 安装基础依赖」里确认网络，或自行配镜像源"
  echo
  if ! confirm "确认安装？"; then warn "已取消"; return 0; fi

  local tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/get-docker.XXXXXX.sh")"
  step "下载安装脚本"
  if ! fetch "$DOCKER_GET_URL" "$tmp"; then
    err "下载失败（$DOCKER_GET_URL 不通）"; rm -f "$tmp"; return 1
  fi
  [ -s "$tmp" ] || { err "下载内容为空"; rm -f "$tmp"; return 1; }
  ok "已下载 $(wc -c < "$tmp") 字节"

  step "执行安装（约 1-3 分钟）"
  hr
  if [ "$HAVE_TTY" = 1 ]; then
    sh "$tmp" < /dev/tty
  else
    sh "$tmp"
  fi
  local rc=$?
  hr
  rm -f "$tmp"

  echo
  if command -v docker >/dev/null 2>&1; then
    ok "$(docker --version 2>/dev/null)"
    printf '  服务状态: '; systemctl is-active docker 2>/dev/null || echo unknown
    docker compose version 2>/dev/null | sed 's/^/  /' || dim "  (compose 插件可能需单独装)"
    if [ -z "$(docker ps -q 2>/dev/null)" ] && ! docker info >/dev/null 2>&1; then
      warn "docker 命令在但守护进程没起来，试：systemctl enable --now docker"
    fi
  else
    err "安装失败（退出码 $rc）"
    dim "  排查：确认能访问 download.docker.com，或手动执行"
    dim "  curl -fsSL $DOCKER_GET_URL | sh"
    return 1
  fi
}

act_flyx() {
  step "FLYX 面板 —— 转发 + 节点编排（Xray / sing-box / Snell）"
  echo

  local up="https://github.com/kure29/flyx/releases/latest/download/panel_install.sh"
  local cmd="curl -L ${up} -o panel_install.sh && chmod +x panel_install.sh && ./panel_install.sh"

  # ---------- 检测是否已经装过 ----------
  local installed=0 instdir="" myip=""
  if command -v docker >/dev/null 2>&1; then
    if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx 'flux-panel-backend'; then
      installed=1
    fi
  fi
  if [ "$installed" = 0 ]; then
    local probe
    for probe in "$(pwd)" /root /opt/flvx-panel; do
      if [ -f "$probe/docker-compose.yml" ] && grep -q 'flux-panel-backend' "$probe/docker-compose.yml" 2>/dev/null; then
        installed=1
        instdir="$probe"
        break
      fi
    done
  fi
  # 已装但还没定位到目录时，从容器标签里问出来
  if [ "$installed" = 1 ] && [ -z "$instdir" ] && command -v docker >/dev/null 2>&1; then
    instdir=$(docker inspect flux-panel-backend \
      --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null || true)
    [ "$instdir" = "<no value>" ] && instdir=""
  fi

  if [ "$installed" = 1 ]; then
    # ================= 已安装：不询问，直接执行 =================
    ok "检测到 FLYX 面板已安装 —— 直接执行（升级 / 重建）"
    dim "  面板数据在 Docker 数据卷里，重建容器不会丢配置"
    echo
    if command -v docker >/dev/null 2>&1; then
      docker ps -a --filter name=flux-panel-backend --format '    {{.Names}}   {{.Status}}   {{.Ports}}' 2>/dev/null || true
    fi
    [ -n "$instdir" ] && dim "  部署目录: $instdir"
    myip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit }}')
    dim "  面板地址: http://${myip:-<本机IP>}:6366"
    echo
    info "执行："
    dim "  $cmd"
    echo
  else
    # ================= 未安装：显示命令 + 确认 =================
    info "执行作者提供的原始命令（未做任何修改）："
    echo
    dim "  $cmd"
    echo
    if ! command -v docker >/dev/null 2>&1; then
      warn "未检测到 Docker —— 这个脚本会自己要求 Docker"
      dim "  可以先选「16) Docker 安装」"
      echo
    fi
    dim "  当前目录: $(pwd)（panel_install.sh 会以它为部署目录）"
    echo
    if ! confirm "确认执行？"; then warn "已取消"; return 0; fi
    echo
  fi

  if [ "$HAVE_TTY" = 1 ]; then
    bash -c "$cmd" < /dev/tty
  else
    bash -c "$cmd"
  fi

  echo
  info "装完之后："
  dim "  ① 访问 http://<本机IP>:6366"
  dim "  ② 默认账号 admin_user / admin_user —— 立刻改密码"
  dim "  ③ 设置 → 基础设置 → 面板后端地址 = http://<本机IP>:6365（是 6365，不是 6366）"
  dim "  ④ 节点页新建节点 → 安装 → 复制命令到节点机 root 执行"
}


act_status() {
  step "系统状态汇总"
  local cc qd
  info "系统    : $( (. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-未知}") )"
  info "内核    : $(uname -r)   ($(uname -m))"
  info "虚拟化  : $(systemd-detect-virt 2>/dev/null || echo 未知)"
  info "CPU     : $(nproc) 核   负载: $(cut -d' ' -f1-3 /proc/loadavg)"
  info "内存    : $(free -m | awk '/^Mem:/{printf "%dMB 总 / %dMB 可用", $2, $7}')"
  info "Swap    : $(free -m | awk '/^Swap:/{printf "%dMB 总 / %dMB 已用", $2, $3}')"
  info "磁盘 /  : $(df -h / | awk 'NR==2{printf "%s 总 / %s 已用 (%s)", $2, $3, $5}')"
  info "时区    : $(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo 未知)"
  info "当前时间: $(date '+%Y-%m-%d %H:%M:%S %Z')"
  info "运行时长: $(uptime -p 2>/dev/null || uptime)"
  hr
  info "网络地址:"
  local v4 v6 p4 p6 gw4 gw6 vfilter
  # 过滤掉 docker / 网桥 / 容器 等虚拟网卡，只留真实对外网卡
  vfilter='^(docker|br-|veth|virbr|cni|flannel|cali|kube|podman|lxc)'
  v4=$(ip -4 -o addr show scope global 2>/dev/null | awk -v re="$vfilter" '$2 !~ re {print $4}' | tr '\n' ' ' | sed 's/ $//')
  v6=$(ip -6 -o addr show scope global 2>/dev/null | awk -v re="$vfilter" '$2 !~ re {print $4}' | tr '\n' ' ' | sed 's/ $//')
  gw4=$(ip -4 route show default 2>/dev/null | awk '{print $3}' | head -1)
  gw6=$(ip -6 route show default 2>/dev/null | awk '{print $3}' | head -1)
  printf '  %s本地 IPv4%s : %s\n' "$DIM" "$NC" "${v4:-无}"
  printf '  %s本地 IPv6%s : %s\n' "$DIM" "$NC" "${v6:-无}"
  printf '  %s默认网关%s : IPv4 %s   IPv6 %s\n' "$DIM" "$NC" "${gw4:-无}" "${gw6:-无}"
  # 出口 IP：best effort，各 5 秒超时，拿不到就写"取不到"
  if command -v curl >/dev/null 2>&1; then
    p4=$(curl -4 -s --max-time 5 https://ifconfig.me 2>/dev/null)
    p6=$(curl -6 -s --max-time 5 https://ifconfig.me 2>/dev/null)
  elif command -v wget >/dev/null 2>&1; then
    p4=$(wget -q -T 5 -t 1 -O - https://ifconfig.me 2>/dev/null)
    p6=$(wget -q -T 5 -t 1 -O - https://ifconfig.me 2>/dev/null)
  fi
  if [ "$HAVE_CURL" = 1 ] || [ "$HAVE_WGET" = 1 ]; then
    printf '  %s出口 IPv4%s : %s\n' "$DIM" "$NC" "${p4:-取不到（可能没有 IPv4 出口）}"
    printf '  %s出口 IPv6%s : %s\n' "$DIM" "$NC" "${p6:-取不到（可能没有 IPv6 出口）}"
  else
    dim "  出口 IP: 需要 curl 或 wget（可选 1 装依赖）"
  fi
  hr
  cc=$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null || echo '?')
  qd=$(sysctl -n net.core.default_qdisc 2>/dev/null || echo '?')
  info "拥塞控制: $cc     队列算法: $qd"
  if [ "$cc" = "bbr" ]; then ok "BBR 已启用"; else warn "BBR 未启用"; fi
  if command -v modinfo >/dev/null 2>&1; then
    local bv; bv=$(modinfo tcp_bbr 2>/dev/null | awk '/^version:/{print $2}')
    [ -n "${bv:-}" ] && info "tcp_bbr 模块版本: $bv  （v3 通常为 3.x）"
  fi
  hr
  info "journald: $(journalctl --disk-usage 2>/dev/null | grep -oE '[0-9.]+[KMG]' | head -1)"
  hr
  info "监听端口:"
  ss -tlnp 2>/dev/null | awk 'NR>1{split($4,a,":"); printf "    %-8s %s\n", a[length(a)], $6}' | head -14
  hr
  info "相关服务状态:"
  local found=0 s st
  for s in vless-reality xray sing-box hysteria-server lite-agent komari-agent docker caddy nginx snell-server wg-quick@wg0; do
    st=$(systemctl is-active "$s" 2>/dev/null || true)
    if [ -n "$st" ] && [ "$st" != "inactive" ] && [ "$st" != "unknown" ]; then
      printf '    %-20s %s\n' "$s" "$st"; found=1
    fi
  done
  [ "$found" = 0 ] && dim "    （未检测到常见服务）"
  if command -v docker >/dev/null 2>&1; then
    hr; info "Docker 容器:"
    docker ps -a --format '    {{.Names}}: {{.Status}} ({{.Image}})' 2>/dev/null | head -10
  fi
}

act_reinstall() {
  local c os="" ver="" pw="" key="" img="" winname="" wlang=""
  local sport="" ans="" rc=0 tmp="" url="https://raw.githubusercontent.com/bin456789/reinstall/main/reinstall.sh"

  step "重装系统 —— bin456789/reinstall  (13.5k star)"
  printf '  %s%s⚠  此操作会清空整台机器的所有数据  ⚠%s\n' "$RED" "$BOLD" "$NC"
  warn "重装期间机器完全离线，请先确认服务商控制台 / VNC / 救援模式可用"
  warn "确认无误后再继续，重装失败可能只能让服务商救援"
  echo
  info "请选择要安装的系统："
  printf '     %s1)%s Debian 12          %s最常用、最稳%s\n' "$GREEN" "$NC" "$DIM" "$NC"
  printf '     %s2)%s Debian 13\n' "$GREEN" "$NC"
  printf '     %s3)%s Ubuntu 24.04\n' "$GREEN" "$NC"
  printf '     %s4)%s Ubuntu 22.04\n' "$GREEN" "$NC"
  printf '     %s5)%s Alpine 3.22        %s极小占用%s\n' "$GREEN" "$NC" "$DIM" "$NC"
  printf '     %s6)%s Windows            %s需填镜像名%s\n' "$GREEN" "$NC" "$DIM" "$NC"
  printf '     %s7)%s DD 自定义镜像\n' "$GREEN" "$NC"
  printf '     %s8)%s 只看完整用法（不执行）\n' "$CYAN" "$NC"
  printf '     %s0)%s 返回\n' "$RED" "$NC"
  echo
  ask "  请选择 [0-8]: " c
  case "${c:-0}" in
    1) os=debian; ver=12 ;;
    2) os=debian; ver=13 ;;
    3) os=ubuntu; ver=24.04 ;;
    4) os=ubuntu; ver=22.04 ;;
    5) os=alpine; ver=3.22 ;;
    6) os=windows ;;
    7) os=dd ;;
    8) run_remote "reinstall.sh（用法）" "$url?$(date +%s)" sh
       return 0 ;;
    *) return 0 ;;
  esac

  if [ "$os" = "windows" ]; then
    ask "  Windows 镜像名（例：windows 11 professional）: " winname
    [ -z "$winname" ] && { err "必须填写镜像名"; return 1; }
    ask "  语言 [回车默认 zh-cn]: " wlang
    wlang="${wlang:-zh-cn}"
  elif [ "$os" = "dd" ]; then
    ask "  镜像直链（raw/vhd/tar/gz/xz/zst）: " img
    [ -z "$img" ] && { err "必须填写镜像地址"; return 1; }
  fi

  if [ "$os" != "dd" ]; then
    ask "  登录密码（回车 = 自动生成随机强密码）: " pw
    if [ -z "$pw" ]; then
      pw="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 16)"
      echo
      ok "已生成随机密码：${BOLD}${YELLOW}$pw${NC}"
      warn "请立刻记下，脚本结束时还会再显示一次"
    fi
    ask "  自定义 SSH 端口（回车 = 默认 22）: " sport
    ask "  SSH 公钥（可留空）: " key
  fi

  echo
  hr
  printf '  %s即将执行：%s\n' "$BOLD" "$NC"
  case "$os" in
    windows) printf '    reinstall.sh windows --image-name="%s" --lang=%s --password=***\n' "$winname" "$wlang" ;;
    dd)      printf '    reinstall.sh dd --img="%s"\n' "$img" ;;
    *)       printf '    reinstall.sh %s %s --password=***\n' "$os" "$ver" ;;
  esac
  hr
  printf '  %s%s机器上所有数据将被清空，且不可恢复%s\n' "$RED" "$BOLD" "$NC"
  printf '  %s要放弃，现在就按 Ctrl+C%s\n' "$DIM" "$NC"
  echo
  ask "  确认继续请输入 ${BOLD}REINSTALL${NC} 并回车：" ans
  if [ "$ans" != "REINSTALL" ]; then warn "已取消（输入不匹配）"; return 0; fi

  tmp="$(mktemp /tmp/vpstool-reinstall.XXXXXX.sh)"
  step "下载 reinstall.sh"
  if ! fetch "$url?$(date +%s)" "$tmp"; then
    err "下载失败"; rm -f "$tmp"; return 1
  fi
  ok "已下载 $(wc -c < "$tmp") 字节"

  local -a args=()
  case "$os" in
    windows) args=(windows "--image-name=$winname" "--lang=$wlang") ;;
    dd)      args=(dd "--img=$img") ;;
    *)       args=("$os" "$ver") ;;
  esac
  [ -n "$pw" ]    && args+=("--password=$pw")
  [ -n "$sport" ] && args+=("--ssh-port=$sport")
  [ -n "$key" ]   && args+=("--ssh-key=$key")

  step "开始重装（请勿中断）"
  dim "脚本会自行下载系统镜像并重启进入安装环境"
  hr
  if [ "$HAVE_TTY" = 1 ]; then
    sh "$tmp" "${args[@]}" < /dev/tty
  else
    sh "$tmp" "${args[@]}"
  fi
  rc=$?
  hr
  if [ "$rc" -eq 0 ]; then
    ok "重装脚本执行完毕，机器即将重启"
    if [ -n "$pw" ]; then
      echo
      printf '  %s登录信息（务必保存）%s\n' "$BOLD" "$NC"
      info "  密码: $pw"
      [ -n "$sport" ] && info "  端口: $sport"
      [ -n "$key" ]   && info "  已配置 SSH 公钥"
    fi
  else
    warn "退出码 $rc，请检查上方输出"
  fi
  rm -f "$tmp"
}

act_install_self() {
  step "安装 ${CMD_NAME} 快捷命令"
  info "安装位置: $INSTALL_PATH"
  info "装好后在任意 shell（bash / zsh / fish 均可）直接输入 ${BOLD}${CMD_NAME}${NC} 即可打开本菜单"
  echo

  local src=""
  # 判断当前是不是从真实文件运行（管道运行的话 $0 不是文件）
  if [ -f "$0" ] && [ -r "$0" ] && head -n1 "$0" 2>/dev/null | grep -q '^#!'; then
    src="$0"
    info "来源: 当前文件  $src"
  else
    info "当前是管道方式运行，从网络下载最新版"
  fi

  mkdir -p /usr/local/bin || { err "无法创建 /usr/local/bin"; return 1; }

  if [ -n "$src" ]; then
    cp -f "$src" "$INSTALL_PATH" || { err "复制失败"; return 1; }
  else
    local u got=0
    for u in "${SELF_URLS[@]}"; do
      dim "  尝试 $u"
      if fetch "$u" "$INSTALL_PATH" 2>/dev/null \
         && [ -s "$INSTALL_PATH" ] \
         && head -n1 "$INSTALL_PATH" 2>/dev/null | grep -q '^#!'; then
        ok "  这个源可用"
        got=1
        break
      fi
      dim "  不可用，换下一个"
    done
    if [ "$got" != 1 ]; then
      err "所有下载源都失败"
      rm -f "$INSTALL_PATH"
      return 1
    fi
  fi
  chmod +x "$INSTALL_PATH"

  if [ -s "$INSTALL_PATH" ] && head -n1 "$INSTALL_PATH" | grep -q '^#!'; then
    ok "已安装：$INSTALL_PATH  ($(wc -c < "$INSTALL_PATH") 字节)"
  else
    err "安装异常：文件内容不是有效脚本"
    rm -f "$INSTALL_PATH"
    return 1
  fi

  # 清掉历史上可能存在的同名 alias，避免和命令冲突
  local rc
  for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.bash_profile" "$HOME/.profile"; do
    [ -f "$rc" ] || continue
    if grep -qE "^[[:space:]]*alias[[:space:]]+${CMD_NAME}=" "$rc" 2>/dev/null; then
      cp -a "$rc" "$rc.bak-$(date +%Y%m%d-%H%M)" 2>/dev/null
      sed -i -E "/^[[:space:]]*alias[[:space:]]+${CMD_NAME}=/d" "$rc"
      warn "已从 $rc 中移除旧的 ${CMD_NAME} 别名（备份 .bak-*）"
    fi
  done

  echo
  if command -v "$CMD_NAME" >/dev/null 2>&1; then
    ok "验证通过：$(command -v "$CMD_NAME")"
    info "现在直接输入 ${BOLD}${CMD_NAME}${NC} 就能打开菜单"
  else
    warn "已安装，但当前 PATH 里找不到 /usr/local/bin，请检查 PATH"
  fi
}

act_uninstall_self() {
  step "卸载 ${CMD_NAME} 快捷命令"
  if [ -f "$INSTALL_PATH" ]; then
    rm -f "$INSTALL_PATH" && ok "已删除 $INSTALL_PATH"
  else
    info "$INSTALL_PATH 不存在"
  fi
  local rc
  for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.bash_profile" "$HOME/.profile"; do
    [ -f "$rc" ] || continue
    if grep -qE "^[[:space:]]*alias[[:space:]]+${CMD_NAME}=" "$rc" 2>/dev/null; then
      sed -i -E "/^[[:space:]]*alias[[:space:]]+${CMD_NAME}=/d" "$rc"
      info "已清理 $rc 中的别名"
    fi
  done
}

act_qc_menu() {
  local a
  step "${CMD_NAME} 快捷命令"
  if [ -f "$INSTALL_PATH" ]; then
    ok "当前状态：已安装  ($INSTALL_PATH)"
    info "在任何地方输入 ${BOLD}${CMD_NAME}${NC} 即可打开菜单"
  else
    warn "当前状态：未安装"
    info "安装后可在任意 shell 直接输入 ${CMD_NAME} 打开菜单"
  fi
  echo
  info "  1) 安装 / 更新为最新版"
  info "  2) 卸载"
  info "  0) 返回"
  echo
  ask "  请选择 [0-2]: " a
  case "${a:-0}" in
    1) act_install_self ;;
    2) act_uninstall_self ;;
    *) return 0 ;;
  esac
}

# ================================================================ 菜单

banner() {
  clear 2>/dev/null || true
  printf '%s\n' "${CYAN}${BOLD}"
  printf '   ╔══════════════════════════════════════════════════════════╗\n'
  printf '   ║              VPS 常用工具箱   v%-4s                      ║\n' "$VERSION"
  printf '   ║        基础环境 · 网络调优 · 安全 · 代理 · 测评           ║\n'
  printf '   ╚══════════════════════════════════════════════════════════╝\n'
  printf '%s\n' "${NC}"
  printf '  %s主机%s %s   %s内核%s %s\n' "$DIM" "$NC" "$(hostname)" "$DIM" "$NC" "$(uname -r)"
  printf '  %s系统%s %s\n' "$DIM" "$NC" "$( (. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-未知}") )"
  printf '  %s时间%s %s\n' "$DIM" "$NC" "$(date '+%Y-%m-%d %H:%M:%S %Z')"
  if [ -f "$INSTALL_PATH" ]; then
    printf '  %s✔%s %s 命令已安装，任何地方输入 %s%s%s 即可打开本菜单\n' \
      "$GREEN" "$NC" "$CMD_NAME" "$BOLD" "$CMD_NAME" "$NC"
  else
    printf '  %s提示：选 14 安装 %s%s%s 命令，以后直接敲 %s%s%s 进菜单%s\n' \
      "$DIM" "$BOLD" "$CMD_NAME" "$NC" "$BOLD" "$CMD_NAME" "$NC" "$NC"
  fi
  echo
}

menu() {
  printf '%s\n' "${BOLD}  ── 基础环境 ─────────────────────────────────────────────${NC}"
  printf '   %s1)%s 安装基础依赖 (sudo / curl / wget)\n' "$GREEN" "$NC"
  printf '   %s2)%s 设置时区为 Asia/Shanghai\n' "$GREEN" "$NC"
  printf '   %s3)%s 限制 journald 日志为 500M\n' "$GREEN" "$NC"
  printf '   %s4)%s 一键基础初始化 %s(1+2+3)%s\n' "$MAGENTA" "$NC" "$DIM" "$NC"
  echo
  printf '%s\n' "${BOLD}  ── 网络调优 ─────────────────────────────────────────────${NC}"
  printf '   %s5)%s BBR v3 优化      %snet-tcp-tune 综合调优（菜单）%s\n' "$GREEN" "$NC" "$DIM" "$NC"
  printf '   %s6)%s tcpfit           %sTCP 精细调优（实测推导）%s\n' "$GREEN" "$NC" "$DIM" "$NC"
  echo
  printf '%s\n' "${BOLD}  ── 安全 / 代理 / 监控 ───────────────────────────────────${NC}"
  printf '   %s7)%s key.sh           %sSSH 密钥登录加固%s\n' "$GREEN" "$NC" "$DIM" "$NC"
  printf '   %s8)%s emby-proxy       %sEmby HTTPS 反代（Caddy/Nginx）%s\n' "$GREEN" "$NC" "$DIM" "$NC"
  printf '   %s9)%s Komari 探针安装    %sLite Agent%s\n' "$GREEN" "$NC" "$DIM" "$NC"
  echo
  printf '%s\n' "${BOLD}  ── 测评 ─────────────────────────────────────────────────${NC}"
  printf '  %s10)%s NodeQuality  %sIP质量 / 硬件 / 网络 / 回程%s\n' "$GREEN" "$NC" "$DIM" "$NC"
  printf '  %s11)%s TcpQuality   %sTCP 质量测试%s\n' "$GREEN" "$NC" "$DIM" "$NC"
  printf '  %s12)%s iperf3 服务端 %s状态 / 启动 / 停止（用完可关）%s\n' "$GREEN" "$NC" "$DIM" "$NC"
  echo
  printf '%s\n' "${BOLD}  ── IPv6 / WARP ──────────────────────────────────────────${NC}"
  printf '  %s13)%s WARP (warp-go)   %s给纯 IPv6 机器加 IPv4 出口%s\n' "$GREEN" "$NC" "$DIM" "$NC"
  printf '  %s14)%s NAT64 / DNS64    %s纯 DNS 方案，无需安装%s\n' "$GREEN" "$NC" "$DIM" "$NC"
  echo
  printf '%s\n' "${BOLD}  ── 面板 / 容器 ──────────────────────────────────────────${NC}"
  printf '  %s15)%s FLYX 面板        %s转发 + 节点编排（Xray/sing-box/Snell）%s\n' "$GREEN" "$NC" "$DIM" "$NC"
  printf '  %s16)%s Docker 安装      %s官方脚本（容器化应用的前置）%s\n' "$GREEN" "$NC" "$DIM" "$NC"
  echo
  printf '%s\n' "${BOLD}  ── 其他 ─────────────────────────────────────────────────${NC}"
  printf '  %s17)%s 查看系统状态汇总 %s(含 IPv4 / IPv6 地址)%s\n' "$CYAN" "$NC" "$DIM" "$NC"
  printf '  %s18)%s 安装/卸载 %s 快捷命令  %s(之后直接敲 %s 进菜单)%s\n' "$GREEN" "$NC" "$CMD_NAME" "$DIM" "$CMD_NAME" "$NC"
  printf '  %s19)%s %s重装系统 (DD)%s  %s会清空整台机器%s\n' "$GREEN" "$NC" "$RED" "$NC" "$DIM" "$NC"
  printf '   %s0)%s 退出\n' "$RED" "$NC"
  echo
  hr
}

main() {
  local choice
  while true; do
    banner
    menu
    if ! ask "  ${BOLD}请输入选项${NC} [0-19]: " choice; then
      printf '\n  %s输入结束，退出%s\n\n' "$CYAN" "$NC"; exit 0
    fi
    case "${choice:-}" in
      1)  act_deps ;;
      2)  act_timezone ;;
      3)  act_journal ;;
      4)  act_bootstrap ;;
      5)  act_net_tune ;;
      6)  act_tcpfit ;;
      7)  act_keysh ;;
      8)  act_embyproxy ;;
      9)  act_lite ;;
      10) act_nodequality ;;
      11) act_tcpquality ;;
      12) act_iperf3 ;;
      13) act_warpgo ;;
      14) act_nat64 ;;
      15) act_flyx ;;
      16) act_docker ;;
      17) act_status ;;
      18) act_qc_menu ;;
      19) act_reinstall ;;
      0|q|Q|quit|exit) printf '\n  %s再见%s\n\n' "$CYAN" "$NC"; exit 0 ;;
      "") continue ;;
      *)  err "无效选项：$choice" ;;
    esac
    pause
  done
}

usage() {
  cat <<'USAGE'
VPS 常用工具箱

用法:
  bash vps-toolbox.sh              打开交互菜单
  bash vps-toolbox.sh <命令>       直接执行某一项

命令:
  status        查看系统状态汇总
  deps          安装基础依赖
  tz            设置时区 Asia/Shanghai
  journal       限制 journald 日志 500M
  bootstrap     一键基础初始化 (deps + tz + journal)
  tunenet       net-tcp-tune 调优
  tcpfit        tcpfit 调优
  key           SSH 加固 (key.sh)
  emby          emby-proxy —— Emby HTTPS 反代（Caddy/Nginx）
  lite          Komari Lite Agent
  nodequality   NodeQuality 测评
  tcpquality    TcpQuality 测试
  iperf3        iperf3 服务端（状态 / 启动 / 停止，用完可关）
  warp          WARP (warp-go) —— 给纯 IPv6 机器加 IPv4 出口
  nat64         NAT64 / DNS64 —— 纯 DNS 方案，无需安装
  flyx          FLYX 面板 —— 转发 + 节点编排（需 Docker）
  docker        安装 Docker（官方脚本）
  qc            安装/卸载 qc 快捷命令
  install       安装 qc 快捷命令，装完自动进入菜单
  uninstall     卸载 qc 快捷命令
  reinstall     重装系统 (会清空机器)
  help          显示本帮助
USAGE
}

case "${1:-}" in
  ""|-m|--menu|menu)      main ;;
  status)                 act_status ;;
  deps)                   act_deps ;;
  tz|timezone)            act_timezone ;;
  journal|log)            act_journal ;;
  bootstrap|init)         act_bootstrap ;;
  tunenet|bbr)            act_net_tune ;;
  tcpfit)                 act_tcpfit ;;
  key|key.sh)             act_keysh ;;
  emby|embyproxy|ep)      act_embyproxy ;;
  lite|komari)            act_lite ;;
  nodequality|nq)         act_nodequality ;;
  tcpquality|tq)          act_tcpquality ;;
  iperf3|iperf)           act_iperf3 ;;
  warp|warpgo|warp-go)    act_warpgo ;;
  nat64|dns64|dns)        act_nat64 ;;
  flyx|flvx|panel)        act_flyx ;;
  docker|dockerd)         act_docker ;;
  qc|cmd)                 act_qc_menu ;;
  install)
    # 装完直接进入菜单，省得再敲一次 qc
    if act_install_self; then
      if [ "$HAVE_TTY" = 1 ]; then
        printf '\n'
        info "正在打开菜单 ..."
        sleep 1
        exec "$INSTALL_PATH"
      else
        printf '\n  %s已安装。之后输入 %s 即可打开菜单%s\n\n' "$CYAN" "$CMD_NAME" "$NC"
      fi
    fi
    ;;
  uninstall)              act_uninstall_self ;;
  reinstall|dd)           act_reinstall ;;
  -h|--help|help)         usage ;;
  *) printf '%s\n' "未知参数: $1"; echo; usage; exit 1 ;;
esac
