const localAPI = "https://ip-api.com/json/?lang=zh-CN";
const exitAPI = "https://api.ip.sb/geoip";

function getLocalInfo() {
  return new Promise((resolve, reject) => {
    $httpClient.get(localAPI, (err, resp, data) => {
      if (err) reject(err);
      else resolve(JSON.parse(data));
    });
  });
}

function getExitInfo() {
  return new Promise((resolve, reject) => {
    $httpClient.get(exitAPI, (err, resp, data) => {
      if (err) reject(err);
      else resolve(JSON.parse(data));
    });
  });
}

(async () => {

  try {

    const local = await getLocalInfo();
    const exit = await getExitInfo();

    const content =
`IP: ${local.query}
位置: ${local.country} ${local.regionName} ${local.city}
运营商: ${local.isp}

入口:
${local.query}
位置: ${local.country} ${local.regionName} ${local.city}
运营商: ${local.isp}

落地IP: ${exit.ip}
位置: ${exit.country} ${exit.region} ${exit.city}
运营商: ${exit.isp}

节点: ${$environment?.node || "未知"}
`;

    $done({
      title: "网络信息",
      content: content,
      icon: "network",
      "icon-color": "#007AFF"
    });

  } catch (e) {

    $done({
      title: "网络信息",
      content: "获取失败",
      icon: "wifi.exclamationmark"
    });

  }

})();
