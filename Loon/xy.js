/*

脚本功能：咸鱼之王 - 通用配置修改（敌伤害=1, 血量=1）
软件版本：微信小程序（需通过新手教程=通关10层）
更新时间：2026

*******************************

[rewrite_local]

# >咸鱼之王 - 通用配置修改（敌伤害=1,血量=1）
^https?:\/\/xxz-xyzw-res\.hortorgames\.com\/remote\/config\/import.* url script-response-body https://raw.githubusercontent.com/WeiGiegie/666/main/xyzw.js

[mitm]
hostname = xxz-xyzw-res.hortorgames.com

*******************************

*/

var body = $response.body;

if (!body) {
    $done({});
    return;
}

let obj;

try {
    obj = JSON.parse(body);
} catch (e) {
    console.log("JSON解析失败");
    $done({});
    return;
}


// 递归修改函数
(function modify(node) {

    if (!node || typeof node !== 'object') return;

    // 找到关卡配置对象（包含 monsters 字段）
    if (Array.isArray(node.monsters)) {

        // 修改预览金币（仅界面显示）
        if ('waveCoin' in node) node.waveCoin = 999999999;

        if ('coinBase' in node && node.coinBase > 0) {
            node.coinBase = 999999999;
        }

        // 修改怪物参数
        // monster结构：[怪物ID, 难度等级, 出现数量]
        node.monsters.forEach(wave => {

            if (Array.isArray(wave)) {

                wave.forEach(monster => {

                    if (Array.isArray(monster) && monster.length >= 3) {

                        // 难度等级设为1（最低血量伤害）
                        if (typeof monster[1] === 'number') {
                            monster[1] = 1;
                        }

                        // 数量设为1
                        if (typeof monster[2] === 'number') {
                            monster[2] = 1;
                        }

                    }

                });

            }

        });

    }

    // 递归遍历所有字段
    for (let key in node) {
        modify(node[key]);
    }

})(obj);


$done({
    body: JSON.stringify(obj)
});
