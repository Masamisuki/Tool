const LOCAL_API = "http://ip-api.com/json/?lang=zh-CN";
const EXIT_API = "https://api.ip.sb/geoip";

function http(url) {
  return new Promise((resolve, reject) => {
    $httpClient.get(url, (err, resp, data) => {
      if (err) reject(err);
      else resolve(JSON.parse(data));
    });
  });
}

function flag(country) {

  const map = {
    China: "🇨🇳",
    "Hong Kong": "🇭🇰",
    Taiwan: "🇹🇼",
    Japan: "🇯🇵",
    Singapore: "🇸🇬",
    Korea: "🇰🇷",
    "United States": "🇺🇸",
    "United Kingdom": "🇬🇧",
    Germany: "🇩🇪",
    France: "🇫🇷",
    Canada: "🇨🇦"
  };

  return map[country] || "🌍";
}

(async () => {

  try {

    const local = await http(LOCAL_API);
    const exit = await http(EXIT_API);

    const node = $environment?.node || "直连";

    const localFlag = flag(local.country);
    const exitFlag = flag(exit.country);

    const content =
`IP: ${local.query}
位置: ${localFlag} ${local.country} ${local.regionName} ${local.city}
运营商: ${local.isp}

入口IP:
${local.query}

落地IP:
${exit.ip}
位置: ${exitFlag} ${exit.country} ${exit.region} ${exit.city}
运营商: ${exit.isp}

节点:
${node}`;

    $done({
      title: "网络信息",
      content: content,
      icon: "network",
      "icon-color": "#007AFF"
    });

  } catch (e) {

    $done({
      title: "网络信息",
      content: "获取网络信息失败",
      icon: "wifi.exclamationmark",
      "icon-color": "#FF3B30"
    });

  }

})();
