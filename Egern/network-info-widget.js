/**
 * 网络信息监控小组件
 * 使用公开 API 获取真实网络数据
 */

// 获取国家国旗 Emoji
function getCountryFlag(countryCode) {
  if (!countryCode) return '🌐';
  const code = countryCode.toUpperCase();
  if (code.length !== 2) return '🌐';
  return String.fromCodePoint(
    ...[...code].map(c => 0x1F1E6 + c.charCodeAt(0) - 65)
  );
}

// 带重试的 HTTP 请求
async function fetchWithRetry(ctx, urls, timeout = 5000) {
  for (const url of urls) {
    try {
      const resp = await ctx.http.get({
        url: url,
        timeout: timeout,
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'
        }
      });
      if (resp && resp.body) {
        return resp.body;
      }
    } catch (e) {
      console.log(`请求失败: ${url}, 尝试下一个...`);
      continue;
    }
  }
  return null;
}

// 主函数
export default async function(ctx) {
  // API 配置
  const APIs = {
    // 公网 IP 查询（多个备选）
    publicIP: [
      'https://cip.cc',
      'https://myip.ipip.net',
      'https://api.ip.sb/ip',
      'https://icanhazip.com'
    ],
    // IP 详细信息查询
    ipInfo: [
      'https://ipapi.co/json/',
      'https://ipwho.is/'
    ]
  };

  // 获取本机网络信息（来自 Egern API）
  const localIPv4 = ctx.device.ipv4.address || '获取中...';
  const localIPv6 = ctx.device.ipv6.address || '-';
  const wifiSSID = ctx.device.wifi.ssid;
  const networkType = ctx.device.wifi.ssid ? 'Wi-Fi' : '蜂窝网络';
  const carrier = ctx.device.cellular.carrier || '-';

  // 初始化公网 IP 信息
  let publicIPv4 = '获取中...';
  let ipCity = '-';
  let ipISP = '-';
  let ipCountry = '-';
  let ipCountryFlag = '🌐';

  // 异步获取公网 IP 信息
  try {
    // 获取公网 IP 地址
    const ipResp = await fetchWithRetry(ctx, APIs.publicIP);
    if (ipResp) {
      const ipMatch = ipResp.match(/\d+\.\d+\.\d+\.\d+/);
      if (ipMatch) {
        publicIPv4 = ipMatch[0];
      }
    }

    // 获取 IP 详细信息
    const infoResp = await fetchWithRetry(ctx, APIs.ipInfo);
    if (infoResp) {
      try {
        const info = JSON.parse(infoResp);
        ipCity = info.city || info.district || '-';
        ipISP = info.isp || info.org || info.connection?.isp || '-';
        ipCountry = info.country_name || info.country || '-';
        ipCountryFlag = getCountryFlag(info.country_code || info.country);
      } catch (e) {
        console.log('IP 信息解析失败:', e);
      }
    }
  } catch (e) {
    console.log('获取公网 IP 失败:', e);
  }

  // 根据小组件尺寸调整布局
  const isSmall = ctx.widgetFamily === 'systemSmall' || ctx.widgetFamily === 'accessoryCircular';
  const isMedium = ctx.widgetFamily === 'systemMedium';

  // 构建小组件 DSL
  return {
    type: "widget",
    backgroundGradient: {
      type: "linear",
      colors: ["#0f0c29", "#302b63", "#24243e"],
      startPoint: { x: 0, y: 0 },
      endPoint: { x: 0, y: 1 }
    },
    padding: isSmall ? 12 : 16,
    gap: isSmall ? 6 : 10,
    children: [
      // 标题栏
      {
        type: "stack",
        direction: "row",
        alignItems: "center",
        children: [
          {
            type: "image",
            src: "sf-symbol:globe.asia.australia",
            color: "#00D4FF",
            width: 22,
            height: 22
          },
          { type: "spacer", length: 8 },
          {
            type: "text",
            text: "网络信息",
            font: { size: "title3", weight: "bold" },
            textColor: "#FFFFFF"
          },
          { type: "spacer" },
          {
            type: "date",
            format: "time",
            font: { size: "caption2", weight: "medium" },
            textColor: "#FFFFFF60"
          }
        ]
      },

      // 本机网络信息卡片
      {
        type: "stack",
        direction: "column",
        gap: 6,
        padding: 12,
        background: {
          type: "roundedRect",
          color: "#FFFFFF10",
          radius: 10
        },
        children: [
          {
            type: "stack",
            direction: "row",
            alignItems: "center",
            children: [
              {
                type: "image",
                src: wifiSSID ? "sf-symbol:wifi" : "sf-symbol:antenna.radiowaves.left.and.right",
                color: "#00D4FF",
                width: 16,
                height: 16
              },
              { type: "spacer", length: 6 },
              {
                type: "text",
                text: networkType,
                font: { size: "caption1", weight: "semibold" },
                textColor: "#FFFFFF"
              }
            ]
          },
          ...(!isSmall ? [{
            type: "text",
            text: wifiSSID ? `SSID: ${wifiSSID}` : `运营商: ${carrier}`,
            font: { size: "caption2" },
            textColor: "#FFFFFF80"
          }] : []),
          {
            type: "text",
            text: `内网 IP: ${localIPv4}`,
            font: { size: "caption2" },
            textColor: "#FFFFFF80"
          },
          ...(localIPv6 !== '-' ? [{
            type: "text",
            text: `IPv6: ${localIPv6.substring(0, 16)}...`,
            font: { size: "caption2" },
            textColor: "#FFFFFF60"
          }] : [])
        ]
      },

      // 公网 IP 信息卡片
      {
        type: "stack",
        direction: "column",
        gap: 6,
        padding: 12,
        background: {
          type: "roundedRect",
          color: "#00D4FF15",
          radius: 10
        },
        children: [
          {
            type: "stack",
            direction: "row",
            alignItems: "center",
            children: [
              {
                type: "image",
                src: "sf-symbol:server.rack",
                color: "#00D4FF",
                width: 16,
                height: 16
              },
              { type: "spacer", length: 6 },
              {
                type: "text",
                text: "公网 IP",
                font: { size: "caption1", weight: "semibold" },
                textColor: "#00D4FF"
              }
            ]
          },
          {
            type: "text",
            text: publicIPv4,
            font: { size: isSmall ? "caption1" : "subheadline", weight: "bold" },
            textColor: "#FFFFFF"
          },
          ...(!isSmall ? [
            {
              type: "text",
              text: `📍 ${ipCity}`,
              font: { size: "caption2" },
              textColor: "#FFFFFFAA"
            },
            {
              type: "text",
              text: `🌐 ${ipCountryFlag} ${ipCountry}`,
              font: { size: "caption2" },
              textColor: "#FFFFFFAA"
            },
            {
              type: "text",
              text: `📡 ${ipISP}`,
              font: { size: "caption2" },
              textColor: "#FFFFFF80"
            }
          ] : [])
        ]
      },

      // 刷新状态提示
      ...(!isSmall ? [{
        type: "stack",
        direction: "row",
        alignItems: "center",
        justifyContent: "center",
        children: [
          {
            type: "image",
            src: "sf-symbol:arrow.clockwise",
            color: "#FFFFFF40",
            width: 12,
            height: 12
          },
          { type: "spacer", length: 4 },
          {
            type: "text",
            text: "自动刷新 · 数据来自公开 API",
            font: { size: "caption2" },
            textColor: "#FFFFFF40"
          }
        ]
      }] : [])
    ]
  };
}
