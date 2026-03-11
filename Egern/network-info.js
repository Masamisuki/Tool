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
    Canada: "🇨🇦",
    Australia: "🇦🇺"
  };

  return map[country] || "🌍";
}

function line(name, value) {

  const pad = 8;
  const space = " ".repeat(Math.max(1, pad - name.length));

  return `${name}${space}${value}`;
}

(async () => {

  try {

    const local = await http(LOCAL_API);
    const exit = await http(EXIT_API);

    const node = $environment?.node || "直连";

    const localFlag = flag(local.country);
    const exitFlag = flag(exit.country);

    const content =

`📍 本机信息
${line("IP", local.query)}
${line("位置", `${localFlag} ${local.regionName} ${local.city}`)}
${line("运营商", local.isp)}

🚪 入口信息
${line("入口IP", local.query)}

🌍 出口信息
${line("出口IP", exit.ip)}
${line("位置", `${exitFlag} ${exit.region} ${exit.city}`)}
${line("运营商", exit.isp)}

🚀 当前节点
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
