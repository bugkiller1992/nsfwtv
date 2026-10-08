// ==UserScript==
// @name         Supjav
// @namespace    gmspider
// @version      2026.10.07
// @description  Supjav GMSpider（兼容新版播放器 + 过滤广告）
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

    const AD_CLASS_RE = /(^|\s)(ad|ads|adv|advert|banner|sponsor|sponsored|promo)(\s|$|-|_)/i;
    const AD_TEXT_RE = /(广告|推广|赞助|下载|download|sponsor|\bads?\b|vip|app)/i;
    const SITE_HOST_RE = /(^|\.)supjav\.com$/i;

    const GmSpider = (function () {
        function safeUrl(href) {
            try {
                return new URL(href, location.origin);
            } catch (e) {
                return null;
            }
        }

        function isAdNode($el) {
            // 自身或祖先带广告类名/ID
            let node = $el.get(0);
            while (node && node !== document.body) {
                const cls = (node.className && typeof node.className === "string") ? node.className : "";
                const id = node.id || "";
                if (AD_CLASS_RE.test(cls) || AD_CLASS_RE.test(id)) return true;
                node = node.parentElement;
            }
            return false;
        }

        // 只保留指向本站正常影片页的条目
        function isValidVideoUrl(url) {
            if (!url) return false;
            if (!SITE_HOST_RE.test(url.hostname)) return false;
            const parts = url.pathname.split('/').filter(Boolean);
            // 形如 /zh/123456.html 或 /123456.html
            const last = parts[parts.length - 1] || "";
            return /^\d+\.html$/.test(last);
        }

        function getVideoId(url) {
            const parts = url.pathname.split('/').filter(Boolean);
            return parts[parts.length - 1];
        }

        function getImg($el) {
            const $img = $el.find("img").first();
            return formatImgUrl(
                $img.attr("data-original") || $img.attr("data-src") || $img.attr("data-lazy-src") || $img.attr("src") || ""
            );
        }

        function listVideos() {
            let itemList = [];
            const seen = {};
            jQuery(".post").each(function () {
                const $post = jQuery(this);
                if (isAdNode($post)) return;
                const $a = $post.find(".img").first();
                const url = safeUrl($a.attr("href"));
                if (!isValidVideoUrl(url)) return;
                const vodId = getVideoId(url);
                const vodName = ($a.attr("title") || $post.find("h3, .title").first().text() || "").trim();
                if (!vodId || !vodName || seen[vodId]) return;
                seen[vodId] = true;
                itemList.push({
                    vod_id: vodId,
                    vod_name: vodName,
                    vod_pic: getImg($post),
                    vod_remarks: $post.find(".date").text().trim(),
                    vod_year: $post.find(".meta").clone().children().remove().end().text().trim()
                });
            });
            return itemList;
        }

        function getPageCount() {
            const $li = jQuery(".pagination li").not(".next-page");
            if ($li.length === 0) return 1;
            let max = 1;
            $li.each(function () {
                const n = parseInt(jQuery(this).text().trim(), 10);
                if (!isNaN(n) && n > max) max = n;
            });
            return max;
        }

        // 线路按钮（与 playerContent 使用同一选择器，保证下标一致）
        function getServerButtons() {
            if (jQuery(".video-wrap .cd-server").length > 0) {
                return jQuery(".video-wrap .cd-server:first .btn-server");
            }
            return jQuery(".video-wrap .btn-server");
        }

        function isAdServer($btn) {
            const text = $btn.text().trim();
            if (!text) return true;
            if (AD_TEXT_RE.test(text)) return true;
            if (isAdNode($btn)) return true;
            const href = $btn.attr("href");
            if (href && !href.startsWith("#") && !href.startsWith("javascript")) {
                const u = safeUrl(href);
                if (u && !SITE_HOST_RE.test(u.hostname)) return true;
            }
            return false;
        }

        function formatImgUrl(url) {
            if (!url) return "";
            if (url.startsWith("//")) return "https:" + url;
            return url;
        }

        return {
            homeContent: function (filter) {
                const defaultFilter = [{
                    key: "sort",
                    name: "排序",
                    value: [
                        {n: "观看数", v: "views"},
                        {n: "更新时间", v: ""}
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
                                {n: "本月热门", v: "month"},
                                {n: "本周热门", v: "week"},
                                {n: "今日热门", v: ""}
                            ]
                        }]
                    },
                    list: []
                };
                result.class.forEach((item) => {
                    if (typeof result.filters[item.type_id] === "undefined") {
                        result.filters[item.type_id] = defaultFilter;
                    }
                });
                result.list = listVideos();
                return result;
            },

            categoryContent: function (tid, pg, filter, extend) {
                let result = {
                    page: parseInt(pg, 10) || 1,
                    pagecount: 1,
                    limit: 0,
                    total: 0,
                    list: []
                };
                if (tid === "tag") {
                    jQuery(".categorys .child").each(function () {
                        const $c = jQuery(this);
                        if (isAdNode($c)) return;
                        const u = safeUrl($c.find("a").attr("href"));
                        if (!u || !SITE_HOST_RE.test(u.hostname)) return;
                        const path = u.pathname.split('/').filter(Boolean);
                        if (path[0] === "zh") path.shift();
                        if (path.length < 2) return;
                        const text = $c.text().trim().split("(");
                        const count = parseInt(text[1], 10);
                        result.list.push({
                            vod_id: path[0] + "/" + path[1],
                            vod_name: text[0].trim(),
                            vod_remarks: isNaN(count) ? "" : count + " 部影片",
                            vod_tag: "folder",
                            style: {type: "rect", ratio: 1}
                        });
                    });
                } else {
                    result.list = listVideos();
                }
                result.pagecount = getPageCount();
                result.limit = result.list.length;
                result.total = result.pagecount * result.list.length;
                return result;
            },

            detailContent: function (ids) {
                jQuery("#vserver").click();
                let vodActor = [], tags = [];
                jQuery(".post-meta .cats a").each(function () {
                    const u = safeUrl(jQuery(this).attr("href"));
                    if (!u) return;
                    const id = u.pathname.replace("/zh/", "").replace(/^\//, "");
                    const name = jQuery(this).text().trim();
                    vodActor.unshift(`[a=cr:{"id":"${id}","name":"${name}"}/]${name}[/a]`);
                });
                jQuery(".post-meta .tags a").each(function () {
                    const u = safeUrl(jQuery(this).attr("href"));
                    if (!u) return;
                    const id = u.pathname.replace("/zh/", "").replace(/^\//, "");
                    const name = jQuery(this).text().trim();
                    tags.push(`[a=cr:{"id":"${id}","name":"${name}"}/]#${name}[/a]`);
                });

                let vodContent = (jQuery(".post-meta .img").attr("alt") || document.title || "").trim();
                let vodName = vodContent.replace("[无码破解]", '').trim();
                let match = vodName.match(/^[\w|-]+/g);
                if (match) {
                    if (match[0].includes("-")) {
                        vodName = match[0];
                    } else {
                        match = vodContent.match(/^[\w]+\s[\w]+/g);
                        if (match) vodName = match[0].replace(" ", "-");
                    }
                }

                // 旧格式（vod_play_data）+ 新格式（vod_play_from / vod_play_url）
                let vodPlayData = [];
                let playFrom = [];
                let playUrl = [];
                getServerButtons().each(function (i) {
                    const $btn = jQuery(this);
                    if (isAdServer($btn)) return;   // 跳过广告线路
                    const from = $btn.text().trim();
                    // i 为原始 DOM 下标，playerContent 依赖它点击对应按钮
                    const pageUrl = "https://supjav.com/zh/" + ids[0] + "#" + i;
                    vodPlayData.push({
                        from: from,
                        media: [{
                            name: vodName,
                            type: "webview",
                            ext: {url: pageUrl}
                        }]
                    });
                    playFrom.push(from.replace(/\$|#/g, ""));
                    playUrl.push(vodName.replace(/\$|#/g, "") + "$" + pageUrl);
                });

                return {
                    list: [{
                        vod_id: ids[0],
                        vod_name: vodName,
                        vod_pic: formatImgUrl(jQuery(".post-meta .img").attr("src")),
                        vod_actor: vodActor.join(" "),
                        vod_remarks: tags.join(" "),
                        vod_content: vodContent,
                        vod_play_data: vodPlayData,
                        vod_play_from: playFrom.join("$$$"),
                        vod_play_url: playUrl.join("$$$")
                    }]
                };
            },

            playerContent: function (flag, id, vipFlags) {
                // 兼容 hash 来自 window.location 或直接传入的 id
                let idx = window.location.hash.split("#").at(1);
                if ((idx === undefined || idx === "") && typeof id === "string" && id.includes("#")) {
                    idx = id.split("#").at(-1);
                }
                idx = parseInt(idx, 10) || 0;
                const btns = getServerButtons().get();
                const btn = btns[idx] || btns.find(b => !isAdServer(jQuery(b)));
                if (btn) btn.dispatchEvent(new Event("click", {bubbles: true}));
                return {
                    type: "match",
                    parse: 1,
                    jx: 0,
                    url: window.location.href,
                    header: {
                        "Referer": "https://supjav.com/",
                        "User-Agent": navigator.userAgent
                    }
                };
            },

            searchContent: function (key, quick, pg) {
                const result = {
                    page: parseInt(pg, 10) || 1,
                    pagecount: getPageCount(),
                    list: listVideos()
                };
                return result;
            }
        };
    })();

    jQuery(function () {
        let result;
        try {
            result = GmSpider[GMSpiderArgs.fName](...GMSpiderArgs.fArgs);
        } catch (e) {
            console.error(e);
            result = {list: [], error: String(e)};
        }
        console.log(result);
        if (typeof GmSpiderInject !== 'undefined') {
            GmSpiderInject.SetSpiderResult(JSON.stringify(result));
        }
    });
})();
