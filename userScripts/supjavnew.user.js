// ==UserScript==
// @name         Supjav
// @namespace    gmspider
// @version      2026.10.18.1
// @description  Supjav GMSpider（兼容新版播放器 + 屏蔽广告/弹窗视频 + 厂牌分类）
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
    // "inplace"：网址不变，立即把 supjav 页面替换成只有播放器的空白页（快，EVS / VAS 都能用，推荐）
    // "navigate"：直接跳转到播放器页面（VAS 最快；EVS 会提示“播放地址加载失败”）
    // "iframe"：等 supjav 页面加载完，再在页面里嵌入播放器（最慢，最保守）
    const PLAYER_OPEN = "inplace";
    // 播放器嗅探到地址、App 开始播放后，网页里的播放器可能还在后台加载同一个视频，和 App 抢带宽。
    // 设成毫秒数（如 15000）：播放器页面加载后过这么久，就关掉网页里的播放器。0 = 不关闭。
    // 注意：设得太短，App 还没嗅探到地址就关了，会直接播放失败。
    const RELEASE_PLAYER_MS = 0;
    // 播放时线路地址从哪里取：
    // "fresh"：打开影片页，按线路名（TV/ST/VOE...）取页面上最新的 data-link（推荐）。
    //          新片/更新过的影片线路会被网站替换，详情里缓存的旧地址会失效 → 播放失败。
    // "cached"：直接用详情页生成时写进播放链接的地址（最快，但旧地址失效时无法播放）
    const PLAY_LINK_SOURCE = "fresh";
    // fresh 模式下最多等影片页多久（毫秒），超时就退回用缓存的地址
    const FRESH_WAIT_MS = 6000;
    // 详情页：DOM 解析完后线路按钮仍未出现（网站用 AJAX 加载线路）时，再等多久（毫秒）
    const DETAIL_BTN_WAIT_MS = 8000;
    // 等待页面的最长时间（毫秒），超时后用已有内容返回结果，避免 App 一直转圈
    const MAX_WAIT_MS = 30000;
    // Cloudflare 验证页最多等多久（毫秒），超过就返回结果，避免 App 永远转圈
    const CHALLENGE_MAX_MS = 60000;
    // 调试：true 时把页面诊断信息写进详情简介（vod_content），方便在 App 里查看失败原因
    const DEBUG = false;

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
    // 线路按钮文字像广告的排除（按整词匹配，避免误伤含 app/vip 字母的线路名）
    const AD_TEXT_RE = /(广告|推广|赞助|下载|\b(download|sponsor|ads?|vip|app)\b)/i;
    // 网站正文容器：广告屏蔽永远不删除这些节点（以及包含它们的节点）
    const KEEP_SEL = ".video-wrap, .post-meta, .post, .posts, .btn-server, .cd-server, .btns, .categorys, .pagination, [data-link], #vserver, .archive-title";
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

        function isProtected(el) {
            try {
                return !!(el.matches && (el.matches(KEEP_SEL) || el.querySelector(KEEP_SEL) ||
                    el.querySelector("[data-gm-player='1']")));
            } catch (e) {
                return false;
            }
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
            // 解析期间节点刚插入、子元素还没解析出来，无法判断里面有没有正文，
            // 所以这里只隐藏，不删除（删掉的话，被广告类名包住的线路按钮/列表会一起丢失）
            if (isAdByName(node) && !isProtected(node)) {
                try {
                    node.style.setProperty("display", "none", "important");
                } catch (e) {
                }
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
                if (el.isConnected && el !== document.body && isAdByName(el) && !isProtected(el)) el.remove();
            });
            // 悬浮/全屏遮罩只检查 body 的直接子元素，避免对整页做样式计算
            if (document.body) {
                Array.from(document.body.children).forEach(el => {
                    if (isProtected(el)) return;
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

        return {install, clean, freeze, isProtected};
    })();

    // 尽早安装（不等 DOM ready），避免广告视频在 playerContent 之前就被嗅探到
    AdGuard.install();

    /* ============================ 爬虫 ============================ */
    const GmSpider = (function () {
        // stopSel：向上查到这个容器为止（线路按钮只查到 .video-wrap，外层布局容器的类名不影响判断）
        function isAdNode($el, stopSel) {
            let node = $el.get(0);
            while (node && node !== document.body) {
                if (stopSel && node.matches && node.matches(stopSel)) return false;
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

        /* ---------------------------- 厂牌 ---------------------------- */
        // 厂牌链接：/zh/maker/xxx
        const MAKER_PATH_RE = /(^|\/)makers?\/[^/]+/i;

        // 站内链接 → 分类 id（去掉语言前缀和 /page/N），例如 "maker/s1-no-1-style"
        function linkToTid(href) {
            const u = safeUrl(href);
            if (!u || !SITE_HOST_RE.test(u.hostname)) return "";
            const path = u.pathname.split('/').filter(Boolean);
            if (path[0] === "zh" || path[0] === "en" || path[0] === "ja") path.shift();
            const pi = path.indexOf("page");
            if (pi >= 0) path.length = pi;
            return path.join("/");
        }

        // "S1 NO.1 STYLE (1,234)" → {name, count}
        function parseCountText(text) {
            const t = String(text).replace(/\s+/g, " ").trim();
            const m = t.match(/^(.*?)\s*[(（]\s*([\d,]+)\s*[)）]\s*$/);
            if (m) return {name: m[1].trim(), count: parseInt(m[2].replace(/,/g, ""), 10)};
            return {name: t, count: NaN};
        }

        // 厂牌列表页（https://supjav.com/zh/maker）：
        // 先按“类别”页同样的结构（.categorys .child）取；取不到就收集页面里所有厂牌链接
        function listMakers() {
            const list = [], seen = {};

            function add(href, text) {
                const tid = linkToTid(href);
                if (!tid || !MAKER_PATH_RE.test(tid) || seen[tid]) return;
                const info = parseCountText(text);
                if (!info.name) return;
                seen[tid] = true;
                list.push({
                    vod_id: tid,
                    vod_name: info.name,
                    vod_remarks: isNaN(info.count) ? "" : info.count + " 部影片",
                    vod_tag: "folder",
                    style: {type: "rect", ratio: 1},
                    _count: info.count
                });
            }

            jQuery(".categorys .child").each(function () {
                const $c = jQuery(this);
                if (isAdNode($c)) return;
                add($c.find("a").attr("href"), $c.text());
            });
            if (list.length === 0) {
                jQuery("a[href]").each(function () {
                    const $a = jQuery(this);
                    if (isAdNode($a) || $a.closest("header, nav, footer, .menu, .nav").length) return;
                    let text = $a.text();
                    // 数量写在链接外面的情况，如 <a>S1</a> (1234)
                    if (!/[(（]\s*[\d,]+\s*[)）]/.test(text)) {
                        const next = $a.get(0).nextSibling;
                        if (next && next.nodeType === 3) text += " " + next.textContent;
                    }
                    add($a.attr("href"), text);
                });
            }
            return list;
        }

        // 排序：count_desc / count_asc / name_asc / name_desc，空 = 网站原顺序
        function sortMakers(list, order) {
            const byName = (a, b) => a.vod_name.localeCompare(b.vod_name, "en", {numeric: true, sensitivity: "base"});
            const cnt = x => isNaN(x._count) ? -1 : x._count;
            if (order === "count_desc") list.sort((a, b) => cnt(b) - cnt(a) || byName(a, b));
            else if (order === "count_asc") list.sort((a, b) => cnt(a) - cnt(b) || byName(a, b));
            else if (order === "name_asc") list.sort(byName);
            else if (order === "name_desc") list.sort((a, b) => byName(b, a));
            list.forEach(x => delete x._count);
            return list;
        }

        function getPageCount() {
            let max = 1;
            jQuery(".pagination li").not(".next-page").each(function () {
                const n = parseInt(jQuery(this).text().trim(), 10);
                if (!isNaN(n) && n > max) max = n;
            });
            return max;
        }

        // 线路按钮分组：多段影片（CD1/CD2...）每段一个 .cd-server，单段影片只有一组
        // detail 与 player 用同一函数，保证下标一致
        function getServerGroups() {
            const groups = [];
            jQuery(".cd-server").each(function () {
                const $g = jQuery(this);
                const $b = $g.find(".btn-server");
                if (!$b.length) return;
                // 段名：.cd-server 里按钮以外的文字，如 "CD1"
                const label = $g.clone().find(".btn-server").remove().end().text().replace(/\s+/g, " ").trim();
                groups.push({$btns: $b, label: label});
            });
            if (!groups.length) {
                let $b = jQuery(".video-wrap .btn-server");
                if (!$b.length) $b = jQuery(".btn-server[data-link]");
                if ($b.length) groups.push({$btns: $b, label: ""});
            }
            return groups;
        }

        function getServerButtons() {
            const g = getServerGroups();
            return g.length ? g[0].$btns : jQuery();
        }

        function serverName($btn) {
            return $btn.text().replace(/\s+/g, " ").trim().replace(/\$|#/g, "");
        }

        // 真实线路必须带 data-link；没有 data-link 或文字/链接像广告的都排除
        function isRealServer($btn) {
            const link = ($btn.attr("data-link") || "").trim();
            if (!link) return false;
            const text = $btn.text().trim();
            if (!text || AD_TEXT_RE.test(text)) return false;
            // 只看按钮自己和所在的线路组；外层包裹（如 class="ad-free-box"）不算广告
            if (isAdNode($btn, ".cd-server, .btns, .video-wrap")) return false;
            const href = $btn.attr("href");
            if (href && !href.startsWith("#") && !href.startsWith("javascript")) {
                const u = safeUrl(href);
                if (u && !SITE_HOST_RE.test(u.hostname)) return false;
            }
            return true;
        }

        // 播放参数放在 query 里（不用 #，因为 # 是 vod_play_url 的剧集分隔符）
        // gmname（线路名）用于播放时在页面上找最新地址；gmlink 只作为找不到时的后备
        function buildPlayPageUrl(vodId, idx, link, name, cd) {
            let u = "https://supjav.com/zh/" + vodId + "?gmsrv=" + idx;
            if (cd !== undefined) u += "&gmcd=" + cd;
            if (name) u += "&gmname=" + encodeURIComponent(name);
            if (link) u += "&gmlink=" + encodeURIComponent(link);
            return u;
        }

        function readPlayParams(id) {
            const p = {idx: NaN, cd: 0, name: "", link: ""};
            const sources = [location.href];
            if (typeof id === "string") sources.push(id);
            for (const s of sources) {
                const u = safeUrl(s);
                if (!u) continue;
                if (u.searchParams.has("gmsrv")) {
                    p.idx = parseInt(u.searchParams.get("gmsrv"), 10);
                    p.cd = parseInt(u.searchParams.get("gmcd") || "0", 10) || 0;
                    p.name = u.searchParams.get("gmname") || "";
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

        // 在当前页面上找播放参数对应的最新线路地址
        // 返回 {link, exact}：exact=true 表示按线路名/下标确切找到；false 表示只是兜底（第一条可用线路）
        function resolveLink(p) {
            const groups = getServerGroups();
            if (!groups.length) return {link: "", exact: false};
            const g = groups[p.cd] || groups[0];
            const $btns = g.$btns;
            const real = [];
            $btns.each(function (i) {
                const $b = jQuery(this);
                if (isRealServer($b)) real.push({i: i, name: serverName($b), link: $b.attr("data-link").trim()});
            });
            if (!real.length) return {link: "", exact: false};
            let hit = null;
            if (p.name) {
                const same = real.filter(r => r.name === p.name);
                // 同名线路有多条时（详情里会命名为 TV、TV2...），按下标挑
                hit = same.find(r => r.i === p.idx) || same[0] || null;
                if (!hit) {
                    const m = p.name.match(/^(.*?)(\d+)$/);
                    if (m) {
                        const base = real.filter(r => r.name === m[1]);
                        hit = base[parseInt(m[2], 10) - 1] || null;
                    }
                }
            } else if (!isNaN(p.idx)) {
                // 旧版播放链接没有线路名，只能按下标
                hit = real.find(r => r.i === p.idx) || null;
            }
            if (!hit && p.link) hit = real.find(r => r.link === p.link) || null;
            if (hit) return {link: hit.link, exact: true};
            const sameIdx = real.find(r => r.i === p.idx);
            return {link: (sameIdx || real[0]).link, exact: false};
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
                        {type_id: "maker", type_name: "厂牌"},
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
                        }],
                        // 厂牌列表在脚本里排序（用 order，避免和网站的 sort 参数混在一起）
                        maker: [{
                            key: "order",
                            name: "排序",
                            value: [
                                {n: "默认", v: ""},
                                {n: "数量 多→少", v: "count_desc"},
                                {n: "数量 少→多", v: "count_asc"},
                                {n: "名称 A→Z", v: "name_asc"},
                                {n: "名称 Z→A", v: "name_desc"}
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
                } else if (tid === "maker") {
                    const ext = (extend && typeof extend === "object") ? extend : {};
                    result.list = sortMakers(listMakers(), ext.order || "");
                } else {
                    result.list = listVideos();
                }
                result.pagecount = getPageCount();
                result.limit = result.list.length;
                result.total = result.pagecount * result.list.length;
                return result;
            },

            detailContent: function (ids) {
                let vodActor = [], vodDirector = [], tags = [];
                // 名字里有引号/方括号时，手拼的 JSON 会让 App 解析失败，这里用 JSON.stringify 并去掉方括号
                const crLink = function (id, name, prefix) {
                    const n = name.replace(/[\[\]]/g, "");
                    return "[a=cr:" + JSON.stringify({id: id, name: n}) + "/]" + (prefix || "") + n + "[/a]";
                };
                jQuery(".post-meta .cats a").each(function () {
                    const tid = linkToTid(jQuery(this).attr("href"));
                    const name = jQuery(this).text().trim();
                    if (!tid || !name) return;
                    // 厂牌单独放到“导演”一栏，点击进入该厂牌的影片列表
                    if (MAKER_PATH_RE.test(tid)) vodDirector.push(crLink(tid, name));
                    else vodActor.unshift(crLink(tid, name));
                });
                jQuery(".post-meta .tags a").each(function () {
                    const tid = linkToTid(jQuery(this).attr("href"));
                    const name = jQuery(this).text().trim();
                    if (!tid || !name) return;
                    tags.push(crLink(tid, name, "#"));
                });

                let vodContent = (jQuery(".post-meta .img").attr("alt") || jQuery(".archive-title h1, h1").first().text() || document.title || "").trim();
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

                if (!vodName) vodName = String(ids[0]).replace(/\.html$/, "");
                const epName = vodName.replace(/\$|#/g, "");

                // 每个线路名一条线路；多段影片（CD1/CD2）作为该线路下的多集
                const lineOrder = [], lines = {};
                const groups = getServerGroups();
                groups.forEach(function (g, cd) {
                    const seenLink = {}, nameCount = {};
                    const ep = groups.length > 1 ? (g.label || ("第" + (cd + 1) + "部分")).replace(/\$|#/g, "") : epName;
                    g.$btns.each(function (i) {
                        const $btn = jQuery(this);
                        if (!isRealServer($btn)) return;
                        const link = $btn.attr("data-link").trim();
                        if (seenLink[link]) return;
                        seenLink[link] = true;
                        let from = serverName($btn);
                        nameCount[from] = (nameCount[from] || 0) + 1;
                        if (nameCount[from] > 1) from = from + nameCount[from];
                        if (!lines[from]) {
                            lines[from] = [];
                            lineOrder.push(from);
                        }
                        lines[from].push({name: ep, url: buildPlayPageUrl(ids[0], i, link, from, cd)});
                    });
                });
                // 页面上没有线路（未加载出来/结构变化）：给一条“自动”线路，播放时再到页面上找
                if (!lineOrder.length) {
                    lineOrder.push("自动");
                    lines["自动"] = [{name: epName, url: buildPlayPageUrl(ids[0], 0, "", "", 0)}];
                }

                const vodPlayData = lineOrder.map(from => ({
                    from: from,
                    media: lines[from].map(e => ({name: e.name, type: "webview", ext: {url: e.url}}))
                }));
                const playFrom = lineOrder;
                const playUrl = lineOrder.map(from => lines[from].map(e => e.name + "$" + e.url).join("#"));

                if (DEBUG) vodContent = "[调试] " + pageDiag() + "\n" + vodContent;

                return {
                    list: [{
                        vod_id: ids[0],
                        vod_name: vodName,
                        vod_pic: formatImgUrl(jQuery(".post-meta .img").attr("src") || jQuery("meta[property='og:image']").attr("content")),
                        vod_actor: vodActor.join(" "),
                        vod_director: vodDirector.join(" "),
                        vod_remarks: tags.join(" "),
                        vod_content: vodContent,
                        vod_play_data: vodPlayData,
                        vod_play_from: playFrom.join("$$$"),
                        vod_play_url: playUrl.join("$$$")
                    }]
                };
            },

            // 在 supjav 页面里嵌入播放器（PLAYER_OPEN = "iframe"，或 inplace 失败时的后备）
            playerContent: function (flag, id, vipFlags, linkOverride) {
                const link = linkOverride || resolveLink(readPlayParams(id)).link || readPlayParams(id).link;
                if (!link) return {type: "match"};

                // 不再点击网站按钮（会触发 popunder + 前贴片广告页），直接嵌入真实播放页
                // 先清掉页面上的广告并冻结主页面（停止所有加载和网站定时器），再插入播放器
                AdGuard.clean();
                AdGuard.freeze(false);
                const iframe = document.createElement("iframe");
                iframe.setAttribute("data-gm-player", "1");
                iframe.setAttribute("allow", "autoplay; fullscreen; encrypted-media");
                iframe.setAttribute("allowfullscreen", "true");
                iframe.setAttribute("referrerpolicy", "unsafe-url");
                iframe.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:0;";
                iframe.src = playerUrl(link);
                getPlayerBox().appendChild(iframe);

                return {type: "match"};
            },

            _resolveLink: resolveLink,
            _readPlayParams: readPlayParams,
            _getServerGroups: getServerGroups,

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
    // 页面上有网站正文 → 一定不是验证页
    function hasSiteContent() {
        return !!document.querySelector(".post, .video-wrap, .post-meta, .categorys, .pagination, .archive-title, .btn-server");
    }

    // 只认真正的 Cloudflare 验证页。
    // 旧版把 script[src*='challenge-platform'] 也当成验证页，但 Cloudflare 会往【正常页面】里注入
    // /cdn-cgi/challenge-platform/.../jsd/main.js（尤其是还没进缓存的新影片页），
    // 导致脚本一直以为在验证、永远不返回结果 —— 新片“打不开、重试几次才偶尔能开”就是这个原因之一。
    function isChallengePage() {
        if (/^\/cdn-cgi\//.test(location.pathname)) return true;
        if (hasSiteContent()) return false;
        const t = document.title || "";
        if (/just a moment|attention required|请稍候|請稍候|checking your browser|one more step/i.test(t)) return true;
        return !!document.querySelector("#challenge-form, #challenge-running, #cf-challenge-running, #challenge-stage, #challenge-success-text, .cf-turnstile, #cf-wrapper");
    }

    function pageDiag() {
        const q = s => document.querySelectorAll(s).length;
        return "ready=" + document.readyState +
            " t=" + (Date.now() - started) + "ms" +
            " challenge=" + isChallengePage() +
            " title=" + JSON.stringify((document.title || "").slice(0, 40)) +
            " video-wrap=" + q(".video-wrap") +
            " cd-server=" + q(".cd-server") +
            " btn-server=" + q(".btn-server") +
            " data-link=" + q("[data-link]") +
            " vserver=" + q("#vserver") +
            " post-meta=" + q(".post-meta") +
            " tags=" + q(".post-meta .tags a");
    }

    let done = false;
    const started = Date.now();

    function sendResult(result) {
        if (done) return;
        done = true;
        console.log(result);
        if (typeof GmSpiderInject !== 'undefined') {
            GmSpiderInject.SetSpiderResult(JSON.stringify(result));
        }
    }

    function getPlayArg() {
        return String((GMSpiderArgs.fArgs || [])[1] || "");
    }

    function playerUrl(link) {
        return PLAY_MODE === "direct"
            ? PLAYER_BASE + "supjav.php?c=" + encodeURIComponent(reverseStr(link))
            : PLAYER_BASE + "supjav.php?l=" + encodeURIComponent(link) + "&bg=undefined";
    }

    // 把当前页面换成只有播放器的空白页（网址不变）
    function openPlayerInPlace(src) {
        const esc = src.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
        const html = '<!DOCTYPE html><html><head><meta charset="utf-8">' +
            '<meta name="viewport" content="width=device-width,initial-scale=1">' +
            '<meta name="referrer" content="unsafe-url">' +
            '<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}' +
            'iframe{position:fixed;left:0;top:0;width:100%;height:100%;border:0}</style></head>' +
            '<body><iframe data-gm-player="1" allow="autoplay; fullscreen; encrypted-media" allowfullscreen ' +
            'referrerpolicy="unsafe-url" src="' + esc + '"></iframe></body></html>';
        try {
            // 中止 supjav 页面剩余部分的解析和加载，换成只有播放器的页面
            document.open();
            document.write(html);
            document.close();
        } catch (e) {
            console.error(e);
        }
        const frame = document.querySelector("iframe[data-gm-player='1']");
        if (frame && RELEASE_PLAYER_MS > 0) {
            let released = false;
            frame.addEventListener("load", function () {
                if (released) return;
                released = true;
                setTimeout(function () {
                    try {
                        frame.src = "about:blank";
                        frame.remove();
                    } catch (e) {
                    }
                }, RELEASE_PLAYER_MS);
            });
        }
        return !!(frame && frame.getAttribute("src") === src);
    }

    // 按 PLAYER_OPEN 打开播放器。返回 true 表示已处理完（结果已发送）
    function openPlayer(link) {
        const src = playerUrl(link);
        if (PLAYER_OPEN === "navigate") {
            sendResult({type: "match"});
            try {
                window.stop();
            } catch (e) {
            }
            location.replace(src);
            return true;
        }
        if (PLAYER_OPEN === "inplace" && openPlayerInPlace(src)) {
            sendResult({type: "match"});
            return true;
        }
        // iframe 方式（或 inplace 失败）：要等 jQuery 和页面结构
        if (!hasJq() || !document.body) return false;
        let result;
        try {
            result = GmSpider.playerContent(GMSpiderArgs.fArgs[0], getPlayArg(), GMSpiderArgs.fArgs[2], link);
        } catch (e) {
            console.error(e);
            result = {type: "match"};
        }
        sendResult(result);
        return true;
    }

    let vserverClicked = false;

    // 网站把线路改成点击 #vserver 后 AJAX 加载时，静态 HTML 里没有按钮，触发一次网站自己的加载
    // （window.open 已被屏蔽，触发的弹窗广告不会出现）
    function triggerServerLoad() {
        if (vserverClicked) return;
        vserverClicked = true;
        try {
            const v = document.querySelector("#vserver");
            if (v) {
                if (hasJq()) jQuery(v).trigger("click");
                else v.dispatchEvent(new MouseEvent("click", {bubbles: true}));
            }
        } catch (e) {
        }
    }

    // 线路区块是否已解析完：区块（或它的任一祖先）后面已经出现了别的元素
    function serverBlockClosed() {
        const all = document.querySelectorAll(".btn-server[data-link]");
        if (!all.length) return false;
        const last = all[all.length - 1];
        let node = last.closest(".video-wrap") || (last.parentElement && last.parentElement.parentElement) || last;
        while (node && node !== document.body && node !== document.documentElement) {
            if (node.nextElementSibling) return true;
            node = node.parentElement;
        }
        return false;
    }

    function countButtons() {
        return document.querySelectorAll(".btn-server[data-link]").length;
    }

    let pendingLink = "";

    function runPlayer(elapsed, challenge) {
        const p = GmSpider._readPlayParams(getPlayArg());
        let link = "";
        if (PLAY_LINK_SOURCE === "cached" && p.link) {
            link = p.link;
        } else if (!pendingLink) {
            if (!challenge && hasJq()) {
                const domDone = document.readyState !== "loading";
                const r = GmSpider._resolveLink(p);
                if (r.link && (r.exact || domDone)) link = r.link;
                else if (domDone && !r.link) triggerServerLoad();
            }
            // 页面迟迟拿不到（验证页 / 网站很慢）：退回到详情里缓存的地址
            if (!link && elapsed > FRESH_WAIT_MS && p.link) link = p.link;
            if (!link && elapsed > (challenge ? CHALLENGE_MAX_MS : MAX_WAIT_MS)) {
                sendResult({type: "match"});
                return;
            }
        }
        if (pendingLink) link = pendingLink;
        if (!link) return;
        pendingLink = link;     // iframe 方式要等页面结构时，下一轮继续用同一个地址
        openPlayer(link);
    }

    let lastBtnCount = -1, stableTicks = 0, domDoneAt = 0;

    function hasJq() {
        return typeof jQuery === "function" && jQuery.fn && jQuery.fn.jquery;
    }

    function run(source) {
        if (done) return;
        const elapsed = Date.now() - started;
        const fName = GMSpiderArgs.fName;
        const challenge = isChallengePage();

        if (fName === "playerContent") return runPlayer(elapsed, challenge);

        // 验证页：等验证通过后页面自动刷新；但最多等 CHALLENGE_MAX_MS，避免 App 永远转圈
        if (challenge) {
            if (elapsed > CHALLENGE_MAX_MS) sendResult({list: [], error: "cloudflare challenge timeout"});
            return;
        }
        if (!hasJq()) {
            if (elapsed > MAX_WAIT_MS) sendResult({list: [], error: "jquery not loaded"});
            return;
        }
        const domDone = document.readyState !== "loading";
        const overtime = elapsed > MAX_WAIT_MS;

        if (fName === "detailContent") {
            const n = countButtons();
            if (n !== lastBtnCount) {
                lastBtnCount = n;
                stableTicks = 0;
            } else if (source === "tick") {
                stableTicks++;
            }
            let ready = false;
            if (overtime) {
                ready = true;
            } else if (n > 0) {
                // 解析中途提前返回：只有当线路区块已经解析完（解析器已经走到它后面的元素），
                // 且标题/标签已出现时才返回，避免只解析出第一个按钮就返回、丢掉后面的线路
                ready = domDone || (stableTicks >= 1 && serverBlockClosed() &&
                    !!document.querySelector(".post-meta .img") &&
                    !!document.querySelector(".post-meta .tags, .post-meta .cats"));
            } else if (domDone) {
                // DOM 已完成但没有线路按钮：可能是 AJAX 加载，触发并等一会儿
                if (!domDoneAt) domDoneAt = Date.now();
                triggerServerLoad();
                ready = Date.now() - domDoneAt > DETAIL_BTN_WAIT_MS;
            }
            if (!ready) return;
        } else if (!domDone && !overtime) {
            return;
        }

        let result;
        try {
            result = GmSpider[fName](...GMSpiderArgs.fArgs);
        } catch (e) {
            console.error(e);
            result = {list: [], error: String(e)};
        }
        // 列表页 DOM 已完成却一条都没取到：可能页面还在被替换（验证通过后刷新等），最多再等 3 秒
        if (fName !== "detailContent" && result && Array.isArray(result.list) && result.list.length === 0) {
            if (!domDoneAt) domDoneAt = Date.now();
            if (!overtime && source !== "load" && Date.now() - domDoneAt < 3000) return;
        }
        if (DEBUG && result && fName !== "detailContent") result._debug = pageDiag();
        sendResult(result);
        // 列表/搜索/详情拿到数据后立即冻结页面，避免后台广告继续加载、拖慢 App
        AdGuard.freeze(true);
    }

    // 1. 立即尝试（cached 模式的播放快速通道）
    run("start");
    if (!done) {
        // 2. DOM 解析完成
        document.addEventListener("DOMContentLoaded", function () {
            run("dom");
        });
        // 3. 解析过程中轮询（详情页提前返回、AJAX 线路、验证通过后继续、超时兜底）
        const timer = setInterval(function () {
            if (done) return clearInterval(timer);
            run("tick");
        }, 250);
        // 4. 页面完全加载
        window.addEventListener("load", function () {
            run("load");
        });
    }
})();
