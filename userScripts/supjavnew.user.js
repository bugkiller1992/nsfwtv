// ==UserScript==
// @name         Supjav
// @namespace    gmspider
// @version      2026.10.08.1
// @description  Supjav GMSpider（兼容新版播放器 + 屏蔽广告/弹窗视频）
// @author       Luomo
// @match        https://supjav.com/*
// @require      https://cdn.jsdelivr.net/npm/jquery@1.12.4/dist/jquery.min.js
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==
(function () {
    // 只在 supjav 顶层页面运行（不在 Cloudflare 验证 iframe、广告 iframe 里运行）
    try {
        if (window.top !== window.self || !/(^|\.)supjav\.com$/i.test(location.hostname)) return;
    } catch (e) {
        return;
    }
    /* ============================ 配置 ============================ */
    // 播放器真实入口：supjav.php?c=<反转的 data-link> 会 302 到各线路(TV/ST/FST/VOE...)的播放页
    // supjav.php?l=<data-link> 是带前贴片广告的中间页，默认跳过
    const PLAYER_BASE = "https://lk1.supremejav.com/";
    // "direct"：直接进真实播放页（跳过前贴片广告，推荐）
    // "preroll"：走网站原流程的中间页（仅当 direct 模式黑屏/403 时再改成这个）
    const PLAY_MODE = "direct";
    // 播放页打开方式：
    // "navigate"：直接跳转到播放器页面，不再加载 supjav 页面（最快，推荐）
    // "iframe"：等 supjav 页面加载完，在页面里嵌入播放器（navigate 不出画面时再改成这个）
    const PLAYER_OPEN = "navigate";
    // 等待页面的最长时间（毫秒），超时后用已有内容返回结果，避免 App 一直转圈
    const MAX_WAIT_MS = 20000;

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
    // Cloudflare 人机验证要用到的 iframe / 脚本，必须放行，否则验证永远过不去
    const CF_HOST_RE = /(^|\.)cloudflare\.com$/i;
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
    // supjav 主页面本身从不直接播放正片（正片都在播放器 iframe 里），
    // 因此主页面上的任何音视频元素 / 视频网络请求一律视为广告。
    const MEDIA_URL_RE = /\.(m3u8|mp4|m4v|m4s|ts|flv|webm|mpd|mov)(\?|#|$)|[?&/](vast|vpaid|preroll)[=/_.-]/i;
    const SCRIPT_ALLOW_RE = /(^|\.)(cloudflare\.com|jquery\.com|jsdelivr\.net|googleapis\.com|gstatic\.com)$/i;
    const AdGuard = (function () {
        let installed = false;

        function killMedia(el) {
            try {
                el.pause && el.pause();
                el.muted = true;
                el.removeAttribute("src");
                el.querySelectorAll && el.querySelectorAll("source").forEach(s => s.remove());
            } catch (e) {
            }
            el.remove();
        }

        function isOurPlayer(el) {
            if (!el || !el.getAttribute) return false;
            if (el.getAttribute("data-gm-player") === "1") return true;
            // 放行 Cloudflare 验证 iframe（challenges.cloudflare.com）
            const src = el.getAttribute("src") || "";
            const u = src ? safeUrl(src) : null;
            return !!(u && CF_HOST_RE.test(u.hostname));
        }

        // 轻量判断（只看 class/id，不触发样式计算，解析期间可以对每个节点调用）
        function isAdByName(el) {
            const cls = typeof el.className === "string" ? el.className : "";
            return AD_CLASS_RE.test(cls) || AD_CLASS_RE.test(el.id || "");
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
            if (tag === "SCRIPT") {
                // 第三方脚本（广告联盟、弹窗、统计）直接不执行；列表/详情数据都在静态 HTML 里，不依赖它们
                const src = node.getAttribute("src");
                if (src) {
                    const u = safeUrl(src);
                    if (u && !SITE_HOST_RE.test(u.hostname) && !SCRIPT_ALLOW_RE.test(u.hostname)) {
                        node.type = "javascript/blocked";
                        node.remove();
                    }
                }
                return;
            }
            if (tag === "META" || tag === "LINK" || tag === "STYLE") return;
            if (isAdByName(node) && !node.querySelector("[data-gm-player='1']")) {
                node.remove();
                return;
            }
            // 只有带子元素的节点才往下查
            if (node.firstElementChild) {
                node.querySelectorAll("video, audio").forEach(killMedia);
                node.querySelectorAll("iframe, embed, object").forEach(f => {
                    if (!isOurPlayer(f)) f.remove();
                });
            }
        }

        // 一次性清理（只在 DOM ready / 播放前调用，不在解析期间调用）
        function clean() {
            if (!document.documentElement) return;
            document.querySelectorAll("video, audio").forEach(killMedia);
            document.querySelectorAll("iframe, embed, object").forEach(f => {
                if (!isOurPlayer(f)) f.remove();
            });
            document.querySelectorAll("[class*=ad], [id*=ad], [class*=banner], [class*=popup], [class*=sponsor], ins").forEach(el => {
                if (el.isConnected && el !== document.body && isAdByName(el) && !el.querySelector("[data-gm-player='1']")) el.remove();
            });
            // 悬浮/全屏遮罩只检查 body 的直接子元素，避免对整页做样式计算
            if (document.body) {
                Array.from(document.body.children).forEach(el => {
                    if (el.querySelector && el.querySelector("[data-gm-player='1']")) return;
                    try {
                        const st = getComputedStyle(el);
                        if (st.position === "fixed" && parseInt(st.zIndex, 10) >= 999) el.remove();
                    } catch (e) {
                    }
                });
            }
        }

        // 结果交给 App 之后，冻结页面：停止加载、清掉网站的定时器（广告轮播/重试），
        // 让这个 WebView 不再产生任何请求，也不再占用 CPU
        function freeze(stopLoading) {
            // 播放页不调用 window.stop()：它会让页面的 load 事件不再触发，部分播放器靠它开始嗅探
            if (stopLoading) {
                try {
                    window.stop();
                } catch (e) {
                }
            }
            try {
                const maxId = setTimeout(function () {
                }, 0);
                for (let i = 0; i <= maxId; i++) {
                    clearTimeout(i);
                    clearInterval(i);
                }
            } catch (e) {
            }
        }

        function blockMediaRequests() {
            // fetch
            try {
                const origFetch = W.fetch;
                if (origFetch) {
                    const f = function (input, init) {
                        const url = typeof input === "string" ? input : (input && input.url) || "";
                        if (MEDIA_URL_RE.test(url)) return Promise.reject(new TypeError("blocked by gmspider"));
                        return origFetch.apply(this, arguments);
                    };
                    W.fetch = f;
                    window.fetch = f;
                }
            } catch (e) {
            }
            // XHR（hls.js 等广告播放器用它拉 m3u8 / ts 分片，删掉 <video> 也不会停）
            try {
                const XHR = (W.XMLHttpRequest || XMLHttpRequest).prototype;
                const origOpen = XHR.open, origSend = XHR.send;
                XHR.open = function (method, url) {
                    this.__gmBlocked = MEDIA_URL_RE.test(String(url || ""));
                    return origOpen.apply(this, arguments);
                };
                XHR.send = function () {
                    if (this.__gmBlocked) {
                        try {
                            this.abort();
                        } catch (e) {
                        }
                        return;
                    }
                    return origSend.apply(this, arguments);
                };
            } catch (e) {
            }
            // MSE：广告播放器用 MediaSource 喂数据，主页面直接禁用
            try {
                if (W.MediaSource) W.MediaSource.isTypeSupported = function () {
                    return false;
                };
                if (W.ManagedMediaSource) W.ManagedMediaSource.isTypeSupported = function () {
                    return false;
                };
            } catch (e) {
            }
        }

        function install() {
            if (installed) return;
            installed = true;

            // 1. 禁止弹窗/新窗口
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

            // 2. 拦截外站链接/弹窗点击
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

            // 3. 主页面上的媒体元素禁止播放/加载
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
                        set: function () {
                        }
                    });
                }
            } catch (e) {
            }

            // 4. 拦截视频网络请求（fetch / XHR / MSE）
            blockMediaRequests();

            // 5. CSP：主页面禁止加载音视频。meta CSP 只有放在 <head> 里才生效
            let cspAdded = false;

            function addCsp() {
                if (cspAdded || !document.head) return;
                const meta = document.createElement("meta");
                meta.httpEquiv = "Content-Security-Policy";
                meta.content = "media-src 'none'";
                document.head.insertBefore(meta, document.head.firstChild);
                cspAdded = true;
            }

            addCsp();

            // 6. 监听新插入的节点（只做轻量判断，避免列表页卡顿）
            const mo = new MutationObserver(function (list) {
                if (!cspAdded) addCsp();
                for (const m of list) {
                    if (m.type === "attributes") {
                        if (m.target.tagName === "IFRAME" && !isOurPlayer(m.target)) m.target.remove();
                        else if (m.target.tagName === "VIDEO" || m.target.tagName === "AUDIO") killMedia(m.target);
                        continue;
                    }
                    const nodes = m.addedNodes;
                    for (let i = 0; i < nodes.length; i++) handleNode(nodes[i]);
                }
            });
            mo.observe(document, {childList: true, subtree: true, attributes: true, attributeFilter: ["src"]});
        }

        return {install, clean, freeze};
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
                // 先清掉页面上的广告并冻结主页面（停止所有加载和网站定时器），再插入播放器
                AdGuard.clean();
                AdGuard.freeze(false);
                const src = playerUrl(link);
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

    /* ============================ 调度 ============================ */
    function isChallengePage() {
        if (/^\/cdn-cgi\//.test(location.pathname)) return true;
        const t = document.title || "";
        if (/just a moment|attention required|请稍候|請稍候|checking your browser/i.test(t)) return true;
        return !!document.querySelector("#challenge-form, #challenge-running, #cf-challenge-running, .cf-turnstile, #cf-wrapper, script[src*='challenge-platform']");
    }

    let done = false;

    function sendResult(result) {
        if (done) return;
        done = true;
        console.log(result);
        if (typeof GmSpiderInject !== 'undefined') {
            GmSpiderInject.SetSpiderResult(JSON.stringify(result));
        }
    }

    function getPlayLinkFromUrl() {
        for (const s of [location.href, String((GMSpiderArgs.fArgs || [])[1] || "")]) {
            const u = safeUrl(s);
            if (u && u.searchParams.get("gmlink")) return u.searchParams.get("gmlink");
        }
        return "";
    }

    function playerUrl(link) {
        return PLAY_MODE === "direct"
            ? PLAYER_BASE + "supjav.php?c=" + encodeURIComponent(reverseStr(link))
            : PLAYER_BASE + "supjav.php?l=" + encodeURIComponent(link) + "&bg=undefined";
    }

    // 播放快速通道：线路地址已经写在播放链接里，不需要等 supjav 页面加载
    function tryFastPlayer() {
        if (GMSpiderArgs.fName !== "playerContent" || PLAYER_OPEN !== "navigate") return false;
        const link = getPlayLinkFromUrl();
        if (!link) return false;
        sendResult({type: "match"});
        try {
            window.stop();
        } catch (e) {
        }
        location.replace(playerUrl(link));
        return true;
    }

    // 详情页数据（标题 + 线路按钮 + 标签）在 HTML 里出现后就可以提前取，不必等整页加载完
    function detailReady() {
        return !!(document.querySelector(".post-meta .img") &&
            document.querySelector(".video-wrap .btn-server") &&
            document.querySelector(".post-meta .tags"));
    }

    function hasJq() {
        return typeof jQuery === "function" && jQuery.fn && jQuery.fn.jquery;
    }

    function run(force) {
        if (done) return;
        if (isChallengePage()) return;            // 验证页：不返回空结果，等验证通过后页面会自动刷新
        if (tryFastPlayer()) return;
        if (!hasJq()) return;
        const fName = GMSpiderArgs.fName;
        const domDone = document.readyState !== "loading";
        if (!force && !domDone && !(fName === "detailContent" && detailReady())) return;

        const isPlayer = fName === "playerContent";
        let result;
        try {
            result = GmSpider[fName](...GMSpiderArgs.fArgs);
        } catch (e) {
            console.error(e);
            result = {list: [], error: String(e)};
        }
        // 页面还没加载完、却什么都没取到：多半是页面不完整，继续等，不返回空结果
        if (!force && !domDone && !isPlayer && result && Array.isArray(result.list) && result.list.length === 0) return;
        sendResult(result);
        // 列表/搜索/详情拿到数据后立即冻结页面，避免后台广告继续加载、拖慢 App
        if (!isPlayer) AdGuard.freeze(true);
    }

    // 1. 立即尝试（播放快速通道）
    run(false);
    if (!done) {
        // 2. DOM 解析完成
        document.addEventListener("DOMContentLoaded", function () {
            run(false);
        });
        // 3. 解析过程中轮询（详情页提前返回；验证通过后继续）
        const started = Date.now();
        const timer = setInterval(function () {
            if (done) return clearInterval(timer);
            const overtime = Date.now() - started > MAX_WAIT_MS;
            if (overtime && !isChallengePage()) {
                clearInterval(timer);
                run(true);
            } else {
                run(false);
            }
        }, 250);
        // 4. 页面完全加载
        window.addEventListener("load", function () {
            run(true);
        });
    }
})();

