// ==UserScript==
// @name         Supjav
// @namespace    gmspider
// @version      2026.04.07
// @description  Supjav GMSpider (EVS, VAS, ST, VOE, LUC Fully Supported)
// @author       Luomo
// @match        https://supjav.com/*
// @require      https://cdn.jsdelivr.net/npm/jquery@1.12.4/dist/jquery.min.js
// @grant        unsafeWindow
// ==/UserScript==
(function () {
    const GMSpiderArgs = {};
    if (typeof GmSpiderInject !== 'undefined') {
        let args = JSON.parse(GmSpiderInject.GetSpiderArgs());
        GMSpiderArgs.fName = args.shift();
        GMSpiderArgs.fArgs = args;
    } else {
        GMSpiderArgs.fName = "homeContent";
        GMSpiderArgs.fArgs = ["tag"];
    }
    Object.freeze(GMSpiderArgs);

    // 辅助网络请求函数（适配 GM 环境，支持自动重定向跟踪）
    function request(url, options = {}) {
        try {
            let xhr = new XMLHttpRequest();
            let method = options.method || 'GET';
            xhr.open(method, url, false); // 同步请求
            if (options.headers) {
                for (let h in options.headers) {
                    xhr.setRequestHeader(h, options.headers[h]);
                }
            }
            xhr.send(options.data || null);
            if (xhr.status === 200 || xhr.status === 302 || xhr.status === 301) {
                return xhr.responseText;
            }
        } catch (e) {
            console.log("Request error: " + e);
        }
        return "";
    }

    const GmSpider = (function () {
        function listVideos() {
            let itemList = [];
            jQuery(".post").each(function () {
                const url = new URL(jQuery(this).find(".img").attr("href"));
                itemList.push({
                    vod_id: url.pathname.split('/').at(2),
                    vod_name: jQuery(this).find(".img").attr("title"),
                    vod_pic: formatImgUrl(jQuery(this).find("img").data("original")),
                    vod_remarks: jQuery(this).find(".date").text(),
                    vod_year: jQuery(this).find(".meta").children().remove().end().text()
                })
            });
            return itemList;
        }

        function formatImgUrl(url) {
            return url;
        }

        return {
            homeContent: function (filter) {
                const defaultFilter = [{
                    key: "sort",
                    name: "排序",
                    value: [
                        { n: "观看数", v: "views" },
                        { n: "更新时间", v: "" }
                    ]
                }];
                let result = {
                    class: [
                        {type_id: "popular", type_name: "热门"},
                        {type_id: "category/censored-jav", type_name: "有码"},
                        {type_id: "category/uncensored-jav", type_name: "无码"},
                        {type_id: "category/amateur", type_name: "素人"},
                        {type_id: "category/chinese-subtitles", type_name: "中文字幕"},
                        {type_id: "category/reducing-mosaic", type_name: "无码破解"},
                        {type_id: "category/english-subtitles", type_name: "英文字幕"},
                        {type_id: "tag", type_name: "类别"},
                    ],
                    filters: {
                        popular: [{
                            key: "sort",
                            name: "时间",
                            value: [
                                { n: "本月热门", v: "month" },
                                { n: "本周热门", v: "week" },
                                { n: "今日热门", v: "" }
                            ]
                        }]
                    },
                    list: []
                };
                result.class.forEach((item) => {
                    if (typeof result.filters[item.type_id] === "undefined") {
                        result.filters[item.type_id] = defaultFilter;
                    }
                })
                result.list = listVideos()
                return result;
            },
            categoryContent: function (tid, pg, filter, extend) {
                let result = {
                    list: [],
                    pagecount: 1
                };
                if (tid === "tag") {
                    jQuery(".categorys .child").each(function () {
                        const url = new URL(jQuery(this).find("a").attr("href")).pathname.split('/');
                        const text = jQuery(this).text().trim().split("(")
                        result.list.push({
                            vod_id: url[2] + "/" + url[3],
                            vod_name: text[0],
                            vod_remarks: parseInt(text[1]) + " 部影片",
                            vod_tag: "folder",
                            style: {
                                "type": "rect",
                                "ratio": 1
                            }
                        })
                    });
                    result.pagecount = jQuery(".pagination li").not(".next-page").last().text().trim();
                } else {
                    if (jQuery(".pagination li").length > 0) {
                        result.pagecount = jQuery(".pagination li").not(".next-page").last().text().trim();
                    }
                    result.list = listVideos();
                }
                return result;
            },
            detailContent: function (ids) {
                let vodActor = [], tags = [];
                jQuery(".post-meta .cats a").each(function () {
                    const id = new URL(jQuery(this).attr("href")).pathname.replace("/zh/", "");
                    const name = jQuery(this).text().trim();
                    vodActor.unshift(`[a=cr:{"id":"${id}","name":"${name}"}/]${name}[/a]`);
                });
                jQuery(".post-meta .tags a").each(function () {
                    const id = new URL(jQuery(this).attr("href")).pathname.replace("/zh/", "");
                    const name = jQuery(this).text().trim();
                    tags.push(`[a=cr:{"id":"${id}","name":"${name}"}/]#${name}[/a]`);
                });
                let vodContent = jQuery(".post-meta .img").attr("alt").trim();
                let vodName = vodContent.replace("[无码破解]", '');
                let match = vodName.match(/^[\w|-]+/g);
                if (match) {
                    if (match[0].includes("-")) {
                        vodName = match[0];
                    } else {
                        match = vodContent.match(/^[\w]+\s[\w]+/g);
                        if (match) {
                            vodName = match[0].replace(" ", "-");
                        }
                    }
                }

                let vodPlayData = [];
                let btnServers = jQuery(".video-wrap .btn-server");
                if (btnServers.length === 0 && jQuery(".video-wrap .cd-server").length > 0) {
                    btnServers = jQuery(".video-wrap .cd-server:first .btn-server");
                }

                btnServers.each(function (i) {
                    let serverName = jQuery(this).text().trim();
                    let lk = jQuery(this).attr("data-link") || "";
                    if (!lk) {
                        let parentHtml = jQuery(this).prop('outerHTML') || "";
                        let lkMatch = parentHtml.match(/data-link="([0-9a-f]{40,})"/);
                        if (lkMatch) lk = lkMatch[1];
                    }
                    
                    vodPlayData.push({
                        from: serverName || ('线路' + (i + 1)),
                        media: [{
                            name: vodName,
                            type: "xurl",
                            ext: {
                                url: ids[0] + "$" + lk + "$" + i
                            }
                        }]
                    });
                });

                const result = {
                    list: [{
                        vod_id: ids[0],
                        vod_name: vodName,
                        vod_pic: formatImgUrl(jQuery(".post-meta .img").attr("src")),
                        vod_actor: vodActor.join(" "),
                        vod_remarks: tags.join(" "),
                        vod_content: vodContent,
                        vod_play_data: vodPlayData
                    }]
                };
                return result;
            },
            playerContent: function (flag, id, vipFlags) {
                let parts = id.split("$");
                let vid = parts[0];
                let lk = parts[1];
                
                if (!lk || lk.length < 20) {
                    return { parse: 1, url: "https://supjav.com/zh/" + vid + ".html" };
                }

                let detailUrl = "https://supjav.com/zh/" + vid + ".html";
                let lkBase = "https://lk1.supremejav.com/supjav.php";
                
                // 第一步：请求获取签名
                let s1Url = lkBase + "?l=" + lk;
                let s1 = request(s1Url, { headers: { "Referer": detailUrl } });
                
                let olidMatch = s1.match(/var\s+OLID\s*=\s*'([0-9a-f]{40,})'/);
                let olid = olidMatch ? olidMatch[1].split('').reverse().join('') : lk.split('').reverse().join('');
                
                // 第二步：请求真实解密数据
                let s2 = request(lkBase + "?c=" + olid, { headers: { "Referer": s1Url } });
                if (!s2) {
                    return { parse: 1, url: detailUrl };
                }

                // 1. 通用 m3u8 匹配（适用于 EVS, LUC, VAS 等直出 m3u8 的线路）
                let m3u8Match = s2.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>:]*/);
                if (m3u8Match) {
                    let playUrl = m3u8Match[0].replace(/\\/g, '');
                    return { parse: 0, url: playUrl };
                }

                // 2. Streamtape (ST) 线路解析
                let stMatch = s2.match(/https?:\/\/streamtape\.com\/e\/([A-Za-z0-9]+)/);
                if (stMatch) {
                    let stPage = request("https://streamtape.com/e/" + stMatch[1] + "/");
                    let linkMatch = stPage.match(/innerHTML\s*=\s*'([^']+)'\s*\+\s*\('([^']+)'\)\.substring\((\d+)\)/);
                    if (linkMatch) {
                        let directUrl = linkMatch[1] + linkMatch[2].substring(parseInt(linkMatch[3]));
                        if (directUrl.startsWith('//')) directUrl = 'https:' + directUrl;
                        if (directUrl.indexOf('dl=') === -1) {
                            directUrl += (directUrl.indexOf('?') !== -1 ? '&dl=1' : '?dl=1');
                        }
                        return { parse: 0, url: directUrl };
                    }
                }

                // 3. VOE / LUC / EVS 动态跳转重定向解析
                let locMatches = [
                    ...s2.matchAll(/window\.location\.href\s*=\s*'([^']+)'/g),
                    ...s2.matchAll(/https?:\/\/[a-z0-9.-]+\/(?:e|embed|v)\/[a-z0-9-_]+/gi)
                ];
                
                for (let match of locMatches) {
                    let targetUrl = match[1] || match[0];
                    if (targetUrl && targetUrl.startsWith('http')) {
                        let subPage = request(targetUrl, { headers: { "Referer": s1Url } });
                        // 尝试在跳转后的页面中捞 m3u8
                        let subM3u8 = subPage.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>:]*/);
                        if (subM3u8) {
                            return { parse: 0, url: subM3u8[0].replace(/\\/g, '') };
                        }
                        // 尝试捞 mp4 直链
                        let subMp4 = subPage.match(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>:]*/);
                        if (subMp4) {
                            return { parse: 0, url: subMp4[0].replace(/\\/g, '') };
                        }
                    }
                }

                // 4. 通用兜底：如果文本里藏了任何 mp4 或视频链接
                let genericMp4 = s2.match(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>:]*/);
                if (genericMp4) {
                    return { parse: 0, url: genericMp4[0].replace(/\\/g, '') };
                }

                // 最终如果均无法自主解析，交由客户端内置 WebView/解析器兜底
                return { parse: 1, url: detailUrl };
            },
            searchContent: function (key, quick, pg) {
                const result = {
                    list: [],
                    pagecount: 1
                };
                result.list = listVideos();
                if (jQuery(".pagination li").length > 0) {
                    result.pagecount = jQuery(".pagination li").not(".next-page").last().text().trim();
                }
                return result;
            }
        };
    })();
    jQuery(function () {
        const result = GmSpider[GMSpiderArgs.fName](...GMSpiderArgs.fArgs);
        console.log(result);
        if (typeof GmSpiderInject !== 'undefined') {
            GmSpiderInject.SetSpiderResult(JSON.stringify(result));
        }
    });
})();
