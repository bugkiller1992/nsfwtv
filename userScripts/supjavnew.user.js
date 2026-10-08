// ==UserScript==
// @name         Supjav
// @namespace    gmspider
// @version      2026.10.07.3
// @description  Supjav GMSpider（兼容新版播放器 + 屏蔽广告/弹窗视频）
// @author       Luomo
// @match        https://supjav.com/*
// @require      https://cdn.jsdelivr.net/npm/jquery@1.12.4/dist/jquery.min.js
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==
(function () {
    /* ============================ 配置 ============================ */
    // 播放器真实入口：supjav.php?c=<反转的 data-link> 会 302 到各线路(TV/ST/FST/VOE...)的播放页
    // supjav.php?l=<data-link> 是带前贴片广告的中间页，默认跳过
    const PLAYER_BASE = "https://lk1.supremejav.com/";
    // "direct"：直接进真实播放页（跳过前贴片广告，推荐）
    // "preroll"：走网站原流程的中间页（仅当 direct 模式黑屏/403 时再改成这个）
    const PLAY_MODE = "direct";

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

    const AD_CLASS_RE = /(^|[\s_-])(ad|ads|adv|advert|adsbox|banner|sponsor|sponsored|promo|popup|popunder)([\s_-]|$)/i;
    const AD_TEXT_RE = /(广告|推广|赞助|下载|download|sponsor|\bads?\b|vip|app)/i;
    const SITE_HOST_RE = /(^|\.)supjav\.com$/i;
    const PLAYER_HOST_RE = /(^|\.)supremejav\.com$/i;
    const W = (typeof unsafeWindow !== "undefined") ? unsafeWindow : window;

    function safeUrl(href, base) {
        try {
            return new URL(href, base || location.href);
        } catch (e) {
            return null;
        }
    }

    function reverseStr(s) {
        return String(s).split("").reverse().join("");
    }

    /* ======================= 广告/弹窗屏蔽 ======================= */
    const AdGuard = (function () {
        let installed = false;

        // 本页（supjav 主站）本身不存在正片 <video>，正片都在播放器 iframe 里，
        // 所以主页面上的 video/audio 一律视为广告
        function killMedia(el) {
            try {
                el.pause && el.pause();
                el.muted = true;
                el.removeAttribute("src");
                el.querySelectorAll && el.querySelectorAll("source").forEach(s => s.remove());
                el.load && el.load();
            } catch (e) {
            }
            el.remove();
        }

        function isOurPlayer(el) {
            return el && el.getAttribute && el.getAttribute("data-gm-player") === "1";
        }

        function isAdBox(el) {
            if (!el || el.nodeType !== 1) return false;
            if (el.matches && el.matches(".post, .posts, .video-wrap, .post-meta, .pagination, .categorys, body, html")) return false;
            const cls = typeof el.className === "string" ? el.className : "";
            if (AD_CLASS_RE.test(cls) || AD_CLASS_RE.test(el.id || "")) return true;
            // 全屏/悬浮遮罩层（弹窗广告常用）
            try {
                const st = getComputedStyle(el);
                if ((st.position === "fixed" || st.position === "sticky") && parseInt(st.zIndex, 10) >= 999 &&
                    (el.querySelector("a[target=_blank], iframe, video") || el.tagName === "A")) {
                    return true;
                }
            } catch (e) {
            }
            return false;
        }

        function handleNode(node) {
            if (!node || node.nodeType !== 1) return;
            const tag = node.tagName;
            if (tag === "VIDEO" || tag === "AUDIO") {
                killMedia(node);
                return;
            }
            if (tag === "IFRAME" || tag === "EMBED" || tag === "OBJECT") {
                if (!isOurPlayer(node)) node.remove();
                return;
            }
            if (isAdBox(node) && !node.querySelector("[data-gm-player='1']")) {
                node.remove();
                return;
            }
            if (node.querySelectorAll) {
                node.querySelectorAll("video, audio").forEach(killMedia);
                node.querySelectorAll("iframe, embed, object").forEach(f => {
                    if (!isOurPlayer(f)) f.remove();
                });
            }
        }

        function clean() {
            if (!document.documentElement) return;
            handleNode(document.documentElement);
            document.querySelectorAll("div, section, aside, a, ins").forEach(el => {
                if (el.isConnected && isAdBox(el) && !el.querySelector("[data-gm-player='1']")) el.remove();
            });
        }

        function install() {
            if (installed) return;
            installed = true;

            // 1. 禁止弹窗/新窗口（WebView 会把 window.open 直接在当前页打开广告）
            const fakeWin = function () {
                return {
                    closed: false, close() {
                    }, focus() {
                    }, blur() {
                    }, postMessage() {
                    },
                    location: {href: "", replace() {
                        }, assign() {
                        }},
                    document: {write() {
                        }, close() {
                        }, open() {
                        }}
                };
            };
            try {
                W.open = fakeWin;
                window.open = fakeWin;
            } catch (e) {
            }

            // 2. 拦截外站链接/弹窗点击（捕获阶段，优先于网站自己的 popunder 脚本）
            window.addEventListener("click", function (e) {
                const a = e.target && e.target.closest ? e.target.closest("a") : null;
                if (a && a.href) {
                    const u = safeUrl(a.href);
                    if (a.target === "_blank" || (u && !SITE_HOST_RE.test(u.hostname))) {
                        e.preventDefault();
                        e.stopImmediatePropagation();
                    }
                }
            }, true);

            // 3. 主页面上的任何媒体一律禁止播放/加载
            try {
                const proto = HTMLMediaElement.prototype;
                proto.play = function () {
                    killMedia(this);
                    return Promise.reject(new DOMException("blocked by gmspider", "NotAllowedError"));
                };
                proto.load = function () {
                };
                const srcDesc = Object.getOwnPropertyDescriptor(proto, "src");
                if (srcDesc && srcDesc.configurable) {
                    Object.defineProperty(proto, "src", {
                        configurable: true,
                        get: function () {
                            return srcDesc.get.call(this);
                        },
                        set: function () { /* 拦截 */
                        }
                    });
                }
            } catch (e) {
            }

            // 4. CSP：主页面禁止加载任何音视频（正片在播放器 iframe 里，不受影响）
            let cspAdded = false;

            function addCsp() {
                if (cspAdded) return;
                const parent = document.head || document.documentElement;
                if (!parent) return;
                const meta = document.createElement("meta");
                meta.httpEquiv = "Content-Security-Policy";
                meta.content = "media-src 'none'";
                parent.insertBefore(meta, parent.firstChild);
                cspAdded = true;
            }

            addCsp();

            // 5. 持续监听后插入的广告节点
            const mo = new MutationObserver(function (list) {
                if (!cspAdded) addCsp();
                for (const m of list) {
                    m.addedNodes && m.addedNodes.forEach(handleNode);
                    if (m.type === "attributes" && m.target.tagName === "IFRAME" && !isOurPlayer(m.target)) {
                        m.target.remove();
                    }
                }
            });
            // document-start 时 documentElement 可能还不存在，监听 document 本身
            mo.observe(document, {childList: true, subtree: true, attributes: true, attributeFilter: ["src"]});

            if (document.documentElement) clean();
        }

        return {install, clean};
    })();

    // 尽早安装（不等 DOM ready），避免广告视频在 playerContent 之前就被嗅探到
    AdGuard.install();

    /* ============================ 爬虫 ============================ */
    const GmSpider = (function () {
        function isAdNode($el) {
            let node = $el.get(0);
            while (node && node !== document.body) {
                const cls = (node.className && typeof node.className === "string") ? node.className : "";
                if (AD_CLASS_RE.test(cls) || AD_CLASS_RE.test(node.id || "")) return true;
                node = node.parentElement;
            }
            return false;
        }

        // 只保留指向本站正常影片页的条目
        function isValidVideoUrl(url) {
            if (!url || !SITE_HOST_RE.test(url.hostname)) return false;
            const parts = url.pathname.split('/').filter(Boolean);
            return /^\d+\.html$/.test(parts[parts.length - 1] || "");
        }

        function getVideoId(url) {
            const parts = url.pathname.split('/').filter(Boolean);
            return parts[parts.length - 1];
        }

        function formatImgUrl(url) {
            if (!url) return "";
            if (url.startsWith("//")) return "https:" + url;
            return url;
        }

        function getImg($el) {
            const $img = $el.find("img").first();
            return formatImgUrl($img.attr("data-original") || $img.attr("data-src") || $img.attr("data-lazy-src") || $img.attr("src") || "");
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
            let max = 1;
            jQuery(".pagination li").not(".next-page").each(function () {
                const n = parseInt(jQuery(this).text().trim(), 10);
                if (!isNaN(n) && n > max) max = n;
            });
            return max;
        }

        // 线路按钮（detail 与 player 用同一选择器，保证下标一致）
        function getServerButtons() {
            if (jQuery(".video-wrap .cd-server").length > 0) {
                return jQuery(".video-wrap .cd-server:first .btn-server");
            }
            return jQuery(".video-wrap .btn-server");
        }

        // 真实线路必须带 data-link；没有 data-link 或文字/链接像广告的都排除
        function isRealServer($btn) {
            const link = ($btn.attr("data-link") || "").trim();
            if (!link) return false;
            const text = $btn.text().trim();
            if (!text || AD_TEXT_RE.test(text)) return false;
            if (isAdNode($btn)) return false;
            const href = $btn.attr("href");
            if (href && !href.startsWith("#") && !href.startsWith("javascript")) {
                const u = safeUrl(href);
                if (u && !SITE_HOST_RE.test(u.hostname)) return false;
            }
            return true;
        }

        // 播放参数放在 query 里（不用 #，因为 # 是 vod_play_url 的剧集分隔符）
        function buildPlayPageUrl(vodId, idx, link) {
            return "https://supjav.com/zh/" + vodId + "?gmsrv=" + idx + "&gmlink=" + encodeURIComponent(link);
        }

        function readPlayParams(id) {
            const p = {idx: NaN, link: ""};
            const sources = [location.href];
            if (typeof id === "string") sources.push(id);
            for (const s of sources) {
                const u = safeUrl(s);
                if (!u) continue;
                if (u.searchParams.has("gmsrv")) {
                    p.idx = parseInt(u.searchParams.get("gmsrv"), 10);
                    p.link = u.searchParams.get("gmlink") || "";
                    return p;
                }
                // 兼容旧版 #序号
                const h = u.hash.replace("#", "");
                if (/^\d+$/.test(h)) {
                    p.idx = parseInt(h, 10);
                    return p;
                }
            }
            return p;
        }

        function getPlayerBox() {
            let box = document.querySelector("#dz_video, #player, .video-wrap .player, .video-wrap .video, .video-wrap .embed-responsive");
            if (!box) {
                box = document.createElement("div");
                const wrap = document.querySelector(".video-wrap") || document.body;
                wrap.insertBefore(box, wrap.firstChild);
            }
            box.innerHTML = "";
            box.style.cssText += ";position:relative;width:100%;min-height:240px;";
            return box;
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
                let result = {page: parseInt(pg, 10) || 1, pagecount: 1, limit: 0, total: 0, list: []};
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
                // 线路按钮在静态 HTML 里就有，不再点击 #vserver（点击会触发弹窗广告）
                if (getServerButtons().length === 0) {
                    const v = document.querySelector("#vserver");
                    v && v.dispatchEvent(new Event("click"));
                }
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

                let vodPlayData = [], playFrom = [], playUrl = [];
                const seenLink = {};
                getServerButtons().each(function (i) {
                    const $btn = jQuery(this);
                    if (!isRealServer($btn)) return;
                    const link = $btn.attr("data-link").trim();
                    if (seenLink[link]) return;
                    seenLink[link] = true;
                    const from = $btn.text().trim().replace(/\$|#/g, "");
                    const pageUrl = buildPlayPageUrl(ids[0], i, link);
                    vodPlayData.push({
                        from: from,
                        media: [{name: vodName, type: "webview", ext: {url: pageUrl}}]
                    });
                    playFrom.push(from);
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
                const p = readPlayParams(id);
                let link = p.link;
                if (!link) {
                    const btns = getServerButtons();
                    let $btn = isNaN(p.idx) ? jQuery() : btns.eq(p.idx);
                    if (!$btn.length || !isRealServer($btn)) {
                        $btn = btns.filter(function () {
                            return isRealServer(jQuery(this));
                        }).first();
                    }
                    link = ($btn.attr("data-link") || "").trim();
                }
                if (!link) return {type: "match"};

                // 不再点击网站按钮（会触发 popunder + 前贴片广告页），直接嵌入真实播放页
                AdGuard.clean();
                const src = PLAY_MODE === "direct"
                    ? PLAYER_BASE + "supjav.php?c=" + encodeURIComponent(reverseStr(link))
                    : PLAYER_BASE + "supjav.php?l=" + encodeURIComponent(link) + "&bg=undefined";
                const iframe = document.createElement("iframe");
                iframe.setAttribute("data-gm-player", "1");
                iframe.setAttribute("allow", "autoplay; fullscreen; encrypted-media");
                iframe.setAttribute("allowfullscreen", "true");
                iframe.setAttribute("referrerpolicy", "unsafe-url");
                iframe.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:0;";
                iframe.src = src;
                getPlayerBox().appendChild(iframe);

                return {type: "match"};
            },

            searchContent: function (key, quick, pg) {
                return {
                    page: parseInt(pg, 10) || 1,
                    pagecount: getPageCount(),
                    list: listVideos()
                };
            }
        };
    })();

    jQuery(function () {
        AdGuard.clean();
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

