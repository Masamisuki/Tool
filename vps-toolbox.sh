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

VERSION="1.6"

# 安装后的命令名
CMD_NAME="qc"
INSTALL_PATH="/usr/local/bin/${CMD_NAME}"

# Emby 反代面板（wuuduf/emby-proxy）—— 一条命令安装，之后用 ep 打开菜单
EMBY_PROXY_URL="https://raw.githubusercontent.com/wuuduf/emby-proxy/main/setup-emby-proxy.sh"

# BBR / TCP 调优（Eric86777/vps-tcp-tune）
NET_TUNE_URL="https://raw.githubusercontent.com/Eric86777/vps-tcp-tune/refs/heads/main/net-tcp-tune.sh"
NET_ALIAS_URL="https://raw.githubusercontent.com/Eric86777/vps-tcp-tune/refs/heads/main/install-alias.sh"

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
  local tmp rc=0
  tmp="$(mktemp "${TMPDIR:-/tmp}/vpstool.XXXXXX.sh")"

  step "下载 $name"
  dim "$url"
  if ! fetch "$url" "$tmp"; then
    err "下载失败（网络不通 / 地址失效 / 被墙）"
    rm -f "$tmp"; return 1
  fi
  if [ ! -s "$tmp" ]; then
    err "下载内容为空"
    rm -f "$tmp"; return 1
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
  rm -f "$tmp"
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

act_alias() {
  local a
  step "bbr 快捷命令 / 官方别名管理"
  if command -v bbr >/dev/null 2>&1; then
    ok "bbr 当前可用：$(command -v bbr)"
  else
    warn "bbr 当前不可用"
  fi
  echo
  info "  1) 安装 / 修复 bbr 命令  ${DIM}(推荐：装完立刻可用，无需 source)${NC}"
  info "  2) 安装官方别名           ${DIM}(写入 ~/.bashrc，需 source 或重连 SSH)${NC}"
  info "  3) 卸载官方别名"
  info "  4) 卸载 bbr 命令"
  info "  0) 返回"
  echo
  ask "  请选择 [0-4]: " a
  case "${a:-0}" in
    1)
      if install_bbr_cmd; then
        ok "已安装 /usr/local/bin/bbr"
        info "现在直接敲 ${BOLD}bbr${NC} 试试"
      fi
      ;;
    2)
      run_remote "官方别名安装" "${NET_ALIAS_URL}?$(date +%s)" bash install
      echo
      dim "提示：执行 source ~/.bashrc（或重连 SSH）后生效"
      ;;
    3) run_remote "官方别名卸载" "${NET_ALIAS_URL}?$(date +%s)" bash uninstall ;;
    4)
      if [ -f /usr/local/bin/bbr ]; then
        rm -f /usr/local/bin/bbr && ok "已删除 /usr/local/bin/bbr"
      else
        info "/usr/local/bin/bbr 不存在"
      fi
      ;;
    *) return 0 ;;
  esac
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

act_vless() {
  step "vless-server.sh —— VLESS Reality 一键部署"
  warn "脚本较大（约 1.2MB），且会占用 443 端口、写 systemd 服务"
  if ! confirm "确认继续？"; then warn "已取消"; return 0; fi
  run_remote "vless-server.sh" \
    "https://raw.githubusercontent.com/mozisen/surge/main/vless-server.sh?$(date +%s)" \
    bash
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

act_emby_proxy() {
  local a
  step "Emby 反代面板 —— wuuduf/emby-proxy"
  echo
  if [ -x /usr/local/sbin/emby-proxy ] || command -v ep >/dev/null 2>&1; then
    ok "检测到已安装"
    info "  列出入口   ep list"
    info "  完整诊断   ep doctor"
    info "  服务概况   ep status"
    info "  检查更新   ep update --check"
    echo
    info "  1) 打开菜单 (ep)"
    info "  2) 运行完整诊断 (ep doctor)"
    info "  3) 检查更新"
    info "  4) 重新运行安装器 / 升级"
    info "  0) 返回"
    echo
    ask "  请选择 [0-4]: " a
    case "${a:-0}" in
      1)
        local epbin=""
        command -v ep >/dev/null 2>&1 && epbin="ep"
        [ -z "$epbin" ] && [ -x /usr/local/sbin/emby-proxy ] && epbin="/usr/local/sbin/emby-proxy"
        if [ -z "$epbin" ]; then
          err "找不到 ep 命令"
        elif [ "$HAVE_TTY" = 1 ]; then
          "$epbin" < /dev/tty
        else
          warn "当前没有终端，ep 是交互式菜单，请在 SSH 里直接运行 ep"
        fi
        ;;
      2) ep doctor 2>/dev/null || /usr/local/sbin/emby-proxy doctor ;;
      3) ep update --check 2>/dev/null || /usr/local/sbin/emby-proxy update --check ;;
      4) run_remote "emby-proxy 安装器" "${EMBY_PROXY_URL}?$(date +%s)" bash ;;
      *) return 0 ;;
    esac
    return 0
  fi

  info "基于 Caddy / Nginx 的 Emby HTTPS 反代管理面板"
  info "自带 ACME 证书申请，支持子域名 / 端口 / 路径三种入口模式"
  echo
  warn "前提：需要准备一个域名并把 A 记录指向本机，安全组放行 TCP 80 / 443"
  dim "  安装器第一次运行只会部署管理器，不会改动你现有的 Caddy / Nginx 站点"
  echo
  if ! confirm "确认安装？"; then warn "已取消"; return 0; fi

  run_remote "emby-proxy 安装器" "${EMBY_PROXY_URL}?$(date +%s)" bash
  echo
  if [ -x /usr/local/sbin/emby-proxy ] || command -v ep >/dev/null 2>&1; then
    ok "安装完成"
    info "之后输入 ${BOLD}ep${NC} 打开菜单（或从本菜单选 15 再选 1）"
    info "卸载：sudo ep uninstall"
  fi
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
  printf '   %s7)%s 管理 bbr 快捷命令 / 官方别名\n' "$GREEN" "$NC"
  echo
  printf '%s\n' "${BOLD}  ── 安全 / 代理 / 监控 ───────────────────────────────────${NC}"
  printf '   %s8)%s key.sh           %sSSH 密钥登录加固%s\n' "$GREEN" "$NC" "$DIM" "$NC"
  printf '   %s9)%s 节点搭建          %svless-server.sh (VLESS Reality)%s\n' "$GREEN" "$NC" "$DIM" "$NC"
  printf '  %s10)%s Komari 探针安装    %sLite Agent%s\n' "$GREEN" "$NC" "$DIM" "$NC"
  echo
  printf '%s\n' "${BOLD}  ── 测评 ─────────────────────────────────────────────────${NC}"
  printf '  %s11)%s NodeQuality  %sIP质量 / 硬件 / 网络 / 回程%s\n' "$GREEN" "$NC" "$DIM" "$NC"
  printf '  %s12)%s TcpQuality   %sTCP 质量测试%s\n' "$GREEN" "$NC" "$DIM" "$NC"
  echo
  printf '%s\n' "${BOLD}  ── 其他 ─────────────────────────────────────────────────${NC}"
  printf '  %s13)%s 查看系统状态汇总\n' "$CYAN" "$NC"
  printf '  %s14)%s 安装/卸载 %s 快捷命令  %s(之后直接敲 %s 进菜单)%s\n' "$GREEN" "$NC" "$CMD_NAME" "$DIM" "$CMD_NAME" "$NC"
  printf '  %s15)%s %sEmby 反代面板%s  %swuuduf/emby-proxy (Caddy/Nginx + 自动证书)%s\n' "$GREEN" "$NC" "$BOLD" "$NC" "$DIM" "$NC"
  printf '  %s16)%s %s重装系统 (DD)%s  %s会清空整台机器%s\n' "$GREEN" "$NC" "$RED" "$NC" "$DIM" "$NC"
  printf '   %s0)%s 退出\n' "$RED" "$NC"
  echo
  hr
}

main() {
  local choice
  while true; do
    banner
    menu
    if ! ask "  ${BOLD}请输入选项${NC} [0-16]: " choice; then
      printf '\n  %s输入结束，退出%s\n\n' "$CYAN" "$NC"; exit 0
    fi
    case "${choice:-}" in
      1)  act_deps ;;
      2)  act_timezone ;;
      3)  act_journal ;;
      4)  act_bootstrap ;;
      5)  act_net_tune ;;
      6)  act_tcpfit ;;
      7)  act_alias ;;
      8)  act_keysh ;;
      9)  act_vless ;;
      10) act_lite ;;
      11) act_nodequality ;;
      12) act_tcpquality ;;
      13) act_status ;;
      14) act_qc_menu ;;
      15) act_emby_proxy ;;
      16) act_reinstall ;;
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
  alias         安装 bbr/dog 别名
  key           SSH 加固 (key.sh)
  vless         VLESS Reality 部署
  lite          Komari Lite Agent
  nodequality   NodeQuality 测评
  tcpquality    TcpQuality 测试
  qc            安装/卸载 qc 快捷命令
  install       安装 qc 快捷命令，装完自动进入菜单
  uninstall     卸载 qc 快捷命令
  emby          Emby 反代面板 (wuuduf/emby-proxy)
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
  alias)                  act_alias ;;
  key|key.sh)             act_keysh ;;
  vless|reality)          act_vless ;;
  lite|komari)            act_lite ;;
  nodequality|nq)         act_nodequality ;;
  tcpquality|tq)          act_tcpquality ;;
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
  emby|embyproxy)         act_emby_proxy ;;
  reinstall|dd)           act_reinstall ;;
  -h|--help|help)         usage ;;
  *) printf '%s\n' "未知参数: $1"; echo; usage; exit 1 ;;
esac
