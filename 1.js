/**
 * 豆瓣热榜 —— TVBox / FongMi 数据源（170 类，含多标签组合榜）
 *
 * 加载机制（关键，改错就整站空白且不报错）：
 *   脚本必须把爬虫对象赋给全局名 __JS_SPIDER__，方法名用短名 home/category/detail。
 *   两个引擎对同一个写法的处理不同，但结果一致：
 *     FongMi      ：把 "__JS_SPIDER__" 整词替换为 "globalThis.__JS_SPIDER__"，再按 ES 模块执行，
 *                   最后从 globalThis 上取回该对象。
 *     TVBox(Box)  ：把「__JS_SPIDER__ 后接等号」正则替换成 "export default "，模板再
 *                   `import * as spider`，走 spider.default 挂回 globalThis.__JS_SPIDER__。
 *   所以写法只有一个要求：顶层直接写「__JS_SPIDER__ 后接等号」再跟一个对象字面量，
 *   既不要加 globalThis. 前缀（TVBox 的正则就匹配不到了），也不要写成 module.exports / export default。
 *
 * 网络层：按引擎逐个尝试 req / http / Request，谁可用用谁（见 dbFetch）。
 *   FongMi(QuickJS)：req(url,{async:false,headers}) => { code, headers, content }
 *   其它分支      ：Request(url,{headers}) 链式调用
 *
 * 三个数据源：
 *   1) m.douban.com/rexxar                     —— 官方榜单（Top250、实时热门、周榜…）
 *   2) movie.douban.com/j/search_subjects      —— 按单标签选片（地区/类型/年代/精选）
 *   3) movie.douban.com/j/chart/top_list       —— 豆瓣类型高分榜；服务端不支持地区/年代筛选，
 *                                                 但返回数据自带 regions / release_date，
 *                                                 故由本脚本在本地做二次筛选，实现「多标签组合」。
 *
 * 全部集合 ID、标签、类型 ID、地区组合、年代组合均于 2026-09-30 逐个实测验证。
 * 首页 = 综合混流：10 个主打榜单各取前 10 条轮转交错，打开即全部可见。
 *
 * 想减少分类：把对应数组清空即可（如 DB_ERA = [] 去掉年代全部）。
 */

var DB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
var DB_API = 'https://m.douban.com/rexxar/api/v2';
var DB_TAG = 'https://movie.douban.com/j/search_subjects';
var DB_CHART = 'https://movie.douban.com/j/chart/top_list';
var DB_SUGGEST = 'https://movie.douban.com/j/subject_suggest?q=';
var DB_SIZE = 20;

/* ============================================================================
 * 详情页「多站聚合」配置
 * ----------------------------------------------------------------------------
 * 豆瓣只是元数据站：有海报、简介、评分，但一条播放地址都没有。
 * 所以默认点进详情页是没有片源的，必须自己再去搜索 —— 这一节就是为了解决它。
 *
 * 打开详情页时，本脚本会用片名去下面这些资源站各搜一遍，把命中的
 * vod_play_url（实测绝大多数是 m3u8 直链）直接挂成详情页的「线路」，
 * 点开即播，不用再手动搜索。
 *
 * 实测结论（2026-09-30，关键词「肖申克的救赎」电影 / 「庆余年」剧集）：
 *   全量 39 个站里只有 22 个能同时搜到电影与剧集、且返回 m3u8 直链；
 *   下面按平均响应速度由快到慢排列，全部 https（http 站不安全，已剔除）。
 *   单站耗时 0.5 ~ 2.5 秒，串行查 DB_SRC_MAX 个，所以详情页会比原来慢几秒；
 *   结果有内存缓存，同一部片第二次进去是秒开的。
 *
 * 嫌慢：把 DB_SRC_MAX 调小（如 3）；想更全：调大（如 8），代价是等更久。
 * ========================================================================== */
var DB_SRC = [
  { n: '猫眼资源',  a: 'https://api.maoyanapi.top/api.php/provide/vod/' },
  { n: '非凡资源',  a: 'https://cj.ffzyapi.com/api.php/provide/vod/' },
  { n: '量子资源',  a: 'https://cj.lziapi.com/api.php/provide/vod/' },
  { n: '2100影视', a: 'https://p2100.net/api.php/provide/vod/' },
  { n: '电影天堂',  a: 'https://caiji.dyttzyapi.com/api.php/provide/vod/' },
  { n: '浩瀚资源',  a: 'https://hhzyapi.com/api.php/provide/vod/' },
  { n: '魔都资源',  a: 'https://caiji.moduapi.cc/api.php/provide/vod/' },
  { n: '虎牙资源',  a: 'https://www.huyaapi.com/api.php/provide/vod/' },
  { n: '无尽资源',  a: 'https://api.wujinapi.com/api.php/provide/vod/' },
  { n: '红牛资源',  a: 'https://hongniuzy2.com/api.php/provide/vod/' },
  { n: '360影视',   a: 'https://360zy.com/api.php/provide/vod/' },
  { n: '最大资源',  a: 'https://api.zuidapi.com/api.php/provide/vod/' },
  { n: '速播资源',  a: 'https://subocaiji.com/api.php/provide/vod/' },
  { n: '光速资源',  a: 'https://api.guangsuapi.com/api.php/provide/vod/' },
  { n: '爱奇艺资源', a: 'https://iqiyizyapi.com/api.php/provide/vod/' }
];
var DB_SRC_MAX = 5;       // 详情页最多串行查几个站
var DB_SRC_SCORE = 200;   // 片名相似度下限，低于它认为是别的片子，丢弃
var DB_INDEX = {};        // vod_id -> 列表页那一条（豆瓣接口对个别老条目会 404，用它兜底）
var DB_AGG = {};          // 片名 -> 聚合结果缓存
var DB_AGG_N = 0;         // 缓存条数，超过 DB_AGG_MAX 就整体清空（够用且不会涨内存）

/* ① 官方榜单：rexxar subject_collection */
var DB_RANK = [
  { id: 'subject_real_time_hotest', n: '实时热门榜' },
  { id: 'movie_real_time_hotest',  n: '电影实时热榜' },
  { id: 'tv_real_time_hotest',     n: '剧集实时热榜' },
  { id: 'show_hot',                n: '综艺热播榜' },
  { id: 'movie_top250',            n: '豆瓣Top250' },
  { id: 'movie_weekly_best',       n: '一周口碑电影' },
  { id: 'tv_chinese_best_weekly',  n: '一周华语好剧' },
  { id: 'movie_hot_gaia',          n: '本周热门电影' },
  { id: 'movie_high_score',        n: '高分电影榜' },
  { id: 'movie_classic',           n: '经典电影榜' },
  { id: 'tv_animation',            n: '高分动画剧集' },
  { id: 'tv_documentary',          n: '高分纪录片' }
];

/* ② 豆瓣类型 ID（j/chart/top_list）+ 取 9 分以上 */
var DB_TYPES = [
  { t: 17, n: '科幻' }, { t: 25, n: '动画' }, { t: 3, n: '犯罪' }, { t: 10, n: '悬疑' },
  { t: 5, n: '动作' },  { t: 13, n: '爱情' }, { t: 24, n: '喜剧' }, { t: 20, n: '恐怖' },
  { t: 15, n: '冒险' }, { t: 16, n: '奇幻' }, { t: 22, n: '战争' }, { t: 19, n: '惊悚' },
  { t: 1, n: '纪录片' }, { t: 28, n: '家庭' }, { t: 11, n: '剧情' }, { t: 2, n: '传记' }
];

/* ③ 组合榜：类型 × 地区（数量取自实测9分以上样本，均为有充足内容的组合） */
var DB_REGION_COMBO = [
  { t: 17, g: '科幻', rg: '美国' },   { t: 17, g: '科幻', rg: '日本' },   { t: 17, g: '科幻', rg: '英国' },
  { t: 25, g: '动画', rg: '日本' },   { t: 25, g: '动画', rg: '美国' },   { t: 25, g: '动画', rg: '中国大陆' },
  { t: 3,  g: '犯罪', rg: '美国' },   { t: 3,  g: '犯罪', rg: '中国香港' }, { t: 3,  g: '犯罪', rg: '英国' },
  { t: 10, g: '悬疑', rg: '美国' },   { t: 10, g: '悬疑', rg: '英国' },   { t: 10, g: '悬疑', rg: '日本' },
  { t: 5,  g: '动作', rg: '美国' },   { t: 5,  g: '动作', rg: '中国香港' }, { t: 5,  g: '动作', rg: '中国大陆' },
  { t: 13, g: '爱情', rg: '美国' },   { t: 13, g: '爱情', rg: '中国香港' }, { t: 13, g: '爱情', rg: '法国' },
  { t: 24, g: '喜剧', rg: '美国' },   { t: 24, g: '喜剧', rg: '中国香港' }, { t: 24, g: '喜剧', rg: '中国大陆' },
  { t: 20, g: '恐怖', rg: '美国' },   { t: 20, g: '恐怖', rg: '日本' },   { t: 20, g: '恐怖', rg: '英国' }
];

/* ④ 组合榜：类型 × 年代 */
var DB_ERA_COMBO = [
  { t: 17, g: '科幻', y0: 2010, y1: 2019 }, { t: 17, g: '科幻', y0: 2000, y1: 2009 },
  { t: 25, g: '动画', y0: 2010, y1: 2019 }, { t: 25, g: '动画', y0: 2000, y1: 2009 },
  { t: 3,  g: '犯罪', y0: 2000, y1: 2009 }, { t: 3,  g: '犯罪', y0: 2010, y1: 2019 },
  { t: 10, g: '悬疑', y0: 2010, y1: 2019 }, { t: 10, g: '悬疑', y0: 2000, y1: 2009 },
  { t: 5,  g: '动作', y0: 2010, y1: 2019 }, { t: 5,  g: '动作', y0: 2000, y1: 2009 },
  { t: 13, g: '爱情', y0: 2000, y1: 2009 }, { t: 13, g: '爱情', y0: 1990, y1: 1999 },
  { t: 24, g: '喜剧', y0: 2010, y1: 2019 }, { t: 24, g: '喜剧', y0: 2000, y1: 2009 },
  { t: 20, g: '恐怖', y0: 2000, y1: 2009 }, { t: 20, g: '恐怖', y0: 2010, y1: 2019 }
];

/* ⑤ 精选标签 */
var DB_FEAT = ['豆瓣高分', '冷门佳片', '经典', '高分电影', '必看', '感人', '史诗', '群像', '暗黑', '治愈系',
               '邪典', 'cult', '一生必看', '青春校园', '良心剧', '烧脑', '反转', '高能', '催泪', '神作'];

/* ⑥ 剧集标签 */
var DB_TV = ['国产剧', '美剧', '日剧', '韩剧', '英剧', '港剧', '纪录片', '综艺'];

/* ⑦ 电影按地区 / ⑧ 按类型 / ⑨ 按年代 */
var DB_AREA = ['华语', '中国大陆', '中国香港', '中国台湾', '美国', '日本', '韩国', '英国', '法国', '德国',
               '意大利', '西班牙', '俄罗斯', '印度', '泰国', '巴西', '加拿大', '澳大利亚', '爱尔兰', '瑞典',
               '丹麦', '波兰', '墨西哥', '阿根廷', '荷兰', '瑞士'];
var DB_GENRE = ['剧情', '喜剧', '爱情', '动作', '科幻', '悬疑', '犯罪', '恐怖', '惊悚', '动画', '纪录片',
                '历史', '战争', '家庭', '音乐', '传记', '奇幻', '冒险', '武侠', '古装', '短片', '运动',
                '儿童', '西部', '黑白', '灾难', '同性', '文艺', '治愈', '青春', '赛车', '校内'];
var DB_ERA = [2024, 2022, 2021, 2020, 2019, 2018, 2017, 2016, 2015, 2014, 2013, 2012, 2011, 2010, 2009];

/* 首页综合混流来源 */
var DB_MIX = [
  'rk|subject_real_time_hotest', 'rk|movie_top250', 'rk|movie_weekly_best', 'rk|tv_real_time_hotest',
  'rk|show_hot', 'rk|movie_high_score', 'tg|movie|豆瓣高分', 'tg|movie|冷门佳片', 'tg|movie|华语', 'tg|tv|国产剧'
];

/*
 * type_id 编码：
 *   mix                      首页综合混流
 *   rk|<集合ID>              官方榜单
 *   cb|<类型ID>              类型高分榜
 *   cb|<类型ID>|rg=<地区>     类型 × 地区（本地筛选）
 *   cb|<类型ID>|y=<起>-<止>   类型 × 年代（本地筛选）
 *   tg|movie|<标签>          标签选片
 *   tg|tv|<标签>             剧集标签
 */
var DB_CATES = [];
(function () {
  function add(tid, name) { DB_CATES.push({ type_id: tid, type_name: name }); }
  var i;
  add('mix', '综合推荐');
  for (i = 0; i < DB_RANK.length; i++)         add('rk|' + DB_RANK[i].id, DB_RANK[i].n);
  for (i = 0; i < DB_TYPES.length; i++)        add('cb|' + DB_TYPES[i].t, DB_TYPES[i].n + '高分榜');
  for (i = 0; i < DB_REGION_COMBO.length; i++) add('cb|' + DB_REGION_COMBO[i].t + '|rg=' + DB_REGION_COMBO[i].rg, DB_REGION_COMBO[i].g + '·' + DB_REGION_COMBO[i].rg);
  for (i = 0; i < DB_ERA_COMBO.length; i++)    add('cb|' + DB_ERA_COMBO[i].t + '|y=' + DB_ERA_COMBO[i].y0 + '-' + DB_ERA_COMBO[i].y1, DB_ERA_COMBO[i].g + '·' + DB_ERA_COMBO[i].y0 + 's');
  for (i = 0; i < DB_FEAT.length; i++)         add('tg|movie|' + DB_FEAT[i], '精选·' + DB_FEAT[i]);
  for (i = 0; i < DB_TV.length; i++)           add('tg|tv|' + DB_TV[i], '剧集·' + DB_TV[i]);
  for (i = 0; i < DB_AREA.length; i++)         add('tg|movie|' + DB_AREA[i], '地区·' + DB_AREA[i]);
  for (i = 0; i < DB_GENRE.length; i++)        add('tg|movie|' + DB_GENRE[i], '类型·' + DB_GENRE[i]);
  for (i = 0; i < DB_ERA.length; i++)          add('tg|movie|' + DB_ERA[i], '年代·' + DB_ERA[i]);
})();

function dbRef(url) {
  if (url.indexOf('m.douban.com') >= 0) return 'https://m.douban.com/movie/';
  if (url.indexOf('/j/chart/') >= 0) return 'https://movie.douban.com/typerank';
  return 'https://movie.douban.com/';
}

/* ---------- 图片：豆瓣图床有防盗链，必须带 Referer ----------
 * 实测（2026-09-30）：
 *   直接请求 img3.doubanio.com/...        -> HTTP 418，返回 14 字节假图（封面空白）
 *   带 Referer: https://movie.douban.com/ -> HTTP 200，正常海报
 *
 * 两个盒子都支持在图片地址后用 @Referer= 追加请求头（引擎加载前会拆掉这一段）：
 *   FongMi  ImgUtil.getUrl()：识别 @Referer= -> 加 Referer 头，再取 @ 之前的地址
 *   TVBox   ImgUtil.getUrl()：同样识别 @Referer=；若没有它会自动补 api.douban.com
 * 所以显式写上，两边都能出封面。
 * 注意：地址里不能含 @（引擎用 split("@") 切分），豆瓣图床地址本身不含 @。
 */
function dbPic(url) {
  if (!url) return '';
  url = String(url);
  if (url.indexOf('@') >= 0) return url;                 // 已带头信息，不重复加
  if (url.indexOf('doubanio.com') >= 0) return url + '@Referer=https://movie.douban.com/';
  return url;
}

/* 过滤掉没有封面的条目
 * 对齐 jar 里 Douban 类的 filterItemsWithoutPic：豆瓣部分接口会混进无图条目，
 * 在电视上渲染成灰块很难看，直接丢掉。 */
function dbNoPic(items) {
  var out = [], i;
  for (i = 0; i < items.length; i++) {
    if (items[i] && items[i].vod_pic) out.push(items[i]);
  }
  return out;
}

/* 取分类显示名：可填入 type_name，避免个别布局用到它时为空 */
function dbCateName(tid) {
  var i;
  for (i = 0; i < DB_CATES.length; i++) {
    if (DB_CATES[i].type_id === tid) return DB_CATES[i].type_name;
  }
  return '';
}

/* ---------- 网络层：按引擎逐个尝试 ----------
 * hdr 不传时用豆瓣默认头（带 Referer，豆瓣接口缺它会被拒）；
 * 请求资源站时传一个不带豆瓣 Referer 的头（采集站对陌生 Referer 敏感）。 */
function dbFetch(url, hdr) {
  var h = hdr || { 'User-Agent': DB_UA, 'Referer': dbRef(url), 'Accept': 'application/json' };
  var r;

  // FongMi：req(url, { async: false }) => { code, headers, content }
  try {
    if (typeof req === 'function') {
      r = req(url, { async: false, headers: h });
      if (r && r.content && String(r.content).length) return String(r.content);
    }
  } catch (e) {}

  // FongMi：http(url, { async: false })
  try {
    if (typeof http === 'function') {
      r = http(url, { async: false, headers: h });
      if (r && r.content && String(r.content).length) return String(r.content);
    }
  } catch (e) {}

  // 其它分支：Request(url, { headers }).get().body
  try {
    if (typeof Request === 'function') {
      var b = Request(url, { headers: h }).get().body;
      if (b) return String(b);
    }
  } catch (e) {}

  // 其它分支：Request(url).headers().get().body
  try {
    if (typeof Request === 'function') {
      var b2 = Request(url).headers(h).get().body;
      if (b2) return String(b2);
    }
  } catch (e) {}

  return '';
}

function dbJson(url) {
  var txt = dbFetch(url);
  if (!txt) return null;
  try { return JSON.parse(txt); } catch (e) { return null; }
}

function dbArray(url) {
  var txt = dbFetch(url);
  if (!txt) return [];
  try {
    var d = JSON.parse(txt);
    return (d && d.length) ? d : [];
  } catch (e) { return []; }
}

/* ============================================================================
 * 详情页多站聚合
 * ========================================================================== */

/* 请求采集站：不带豆瓣 Referer（采集站对陌生 Referer 敏感） */
function dbApiFetch(url) {
  return dbFetch(url, { 'User-Agent': DB_UA, 'Accept': 'application/json' });
}

/* 归一化：只留中文、字母、数字，抹平空格与各种标点 */
function dbNorm(s) {
  return String(s === null || s === undefined ? '' : s).toLowerCase()
         .replace(/[^0-9a-z\u4e00-\u9fa5]/g, '');
}

/* 片名相似度：
 *   完全相同 1000；候选以目标开头 800；候选包含目标 600；目标以候选开头 500；
 *   其余按「目标的去重字符有多少出现在候选里」给 0~300。
 * 目的：搜「庆余年 第一季」时不要选中「庆余年第二季粤语」「庆余年之风起沧州」。 */
function dbScore(cand, want) {
  var a = dbNorm(cand), b = dbNorm(want);
  if (!a || !b) return 0;
  if (a === b) return 1000;
  if (a.indexOf(b) === 0) return 800 - Math.min(99, a.length - b.length);
  if (a.indexOf(b) > 0) return 600 - Math.min(99, a.length - b.length);
  if (b.indexOf(a) === 0) return 500 - Math.min(99, b.length - a.length);
  var hit = 0, tot = 0, seen = {}, i, c;
  for (i = 0; i < b.length; i++) {
    c = b.charAt(i);
    if (seen[c]) continue;
    seen[c] = 1; tot++;
    if (a.indexOf(c) >= 0) hit++;
  }
  return Math.round(hit / Math.max(1, tot) * 300);
}

/* 从采集站返回的 vod_play_url 里挑出可播的 m3u8 条目，重新拼成播放列表。
 * 采集站格式：多组用 $$$ 隔开，组内多集用 # 隔开，每集「集名$地址」。
 * 有的站（非凡、光速）第一组给的是网页播放页而非 m3u8，所以按 .m3u8 过滤。 */
function dbEps(pu) {
  if (!pu) return '';
  var groups = String(pu).split('$$$'), out = [], i, j, p, nm, ur;
  for (i = 0; i < groups.length; i++) {
    var items = groups[i].split('#');
    for (j = 0; j < items.length; j++) {
      var it = String(items[j] || '');
      if (it.indexOf('.m3u8') < 0) continue;
      p = it.indexOf('$');
      nm = p >= 0 ? it.slice(0, p) : '';
      ur = p >= 0 ? it.slice(p + 1) : it;
      if (!ur || ur.indexOf(' ') >= 0) continue;
      if (!nm || nm.indexOf('$') >= 0 || nm.indexOf('#') >= 0) nm = '第' + (out.length + 1) + '集';
      out.push(nm + '$' + ur);
      if (out.length >= 600) break;
    }
    if (out.length >= 600) break;
  }
  return out.join('#');
}

/* 在单个资源站里找这部片，返回可直接用的播放列表（找不到返回空串） */
function dbSrcLookup(src, title) {
  var txt = dbApiFetch(src.a + '?ac=detail&wd=' + encodeURIComponent(title));
  if (!txt) return '';
  var d = null;
  try { d = JSON.parse(txt); } catch (e) { return ''; }
  var list = (d && d.list) ? d.list : [];
  if (!list.length) return '';

  var best = null, bs = 0, i, lim = Math.min(list.length, 20);
  for (i = 0; i < lim; i++) {
    if (!list[i]) continue;
    var sc = dbScore(list[i].vod_name, title);
    if (sc > bs) { bs = sc; best = list[i]; }
  }
  if (!best || bs < DB_SRC_SCORE) return '';
  return dbEps(best.vod_play_url);
}

/* 串行查 DB_SRC_MAX 个站，把有资源的站拼成 from / url 两条平行串（必须等长） */
function dbAgg(title) {
  title = String(title || '').trim();
  if (!title) return null;
  if (DB_AGG[title]) return DB_AGG[title];
  if (DB_AGG_N > 60) { DB_AGG = {}; DB_AGG_N = 0; }

  var from = [], url = [], i, n = Math.min(DB_SRC_MAX, DB_SRC.length);
  for (i = 0; i < n; i++) {
    var eps = '';
    try { eps = dbSrcLookup(DB_SRC[i], title); } catch (e) { eps = ''; }
    if (!eps) continue;
    from.push(DB_SRC[i].n);
    url.push(eps);
  }
  var r = { from: from.join('$$$'), url: url.join('$$$') };
  DB_AGG[title] = r; DB_AGG_N++;
  return r;
}

/* ---------- URL 构造 ---------- */
function dbUrl(tid, pg) {
  var page = parseInt(pg, 10) || 1;
  var start = (page - 1) * DB_SIZE;
  if (isNaN(start) || start < 0) start = 0;
  if (!tid || tid.indexOf('|') < 0) tid = 'rk|' + DB_RANK[0].id;

  if (tid.indexOf('rk|') === 0) {
    return DB_API + '/subject_collection/' + tid.slice(3) + '/items?start=' + start + '&count=' + DB_SIZE;
  }
  if (tid.indexOf('cb|') === 0) {
    return DB_CHART + '?type=' + tid.slice(3).split('|')[0] + '&interval_id=100:90&action=&start=0&limit=500';
  }
  var p = tid.slice(3).split('|');
  return DB_TAG + '?type=' + encodeURIComponent(p[0]) + '&tag=' + encodeURIComponent(p[1]) +
         '&sort=rank&page_limit=' + DB_SIZE + '&page_start=' + start;
}

/* ---------- 数据转换 ---------- */
function dbMapTag(items, tname) {
  var out = [], i;
  for (i = 0; i < items.length; i++) {
    var it = items[i];
    if (!it) continue;
    var o = {
      vod_id: String(it.id || ''),
      vod_name: it.title || '',
      vod_pic: dbPic(it.cover || it.cover_url || ''),
      vod_remarks: it.rate ? (it.rate + '分') : '',
      vod_year: '',
      vod_content: '',
      type_name: tname || ''
    };
    DB_INDEX[o.vod_id] = o;                              // 供详情页兜底取片名
    out.push(o);
  }
  return out;
}

function dbMapRank(items, tname) {
  var out = [], i;
  for (i = 0; i < items.length; i++) {
    var it = items[i];
    if (!it) continue;
    var pic = '';
    if (it.pic) pic = it.pic.normal || it.pic.large || it.pic.small || '';
    if (!pic) pic = it.cover_url || '';                  // 部分条目只有 cover_url，兜底
    var rating = (it.rating && it.rating.value) ? it.rating.value : '';
    var card = it.card_subtitle || it.info || '';
    var year = '', m = /^(\d{4})/.exec(String(card));
    if (m) year = m[1];
    var o = {
      vod_id: String(it.id || ''),
      vod_name: it.title || '',
      vod_pic: dbPic(pic),
      vod_remarks: rating !== '' ? (rating + '分') : (it.episodes_info || ''),
      vod_year: year,
      vod_content: card,
      type_name: tname || ''
    };
    DB_INDEX[o.vod_id] = o;
    out.push(o);
  }
  return out;
}

function dbMapChart(items, tname) {
  var out = [], i;
  for (i = 0; i < items.length; i++) {
    var x = items[i];
    if (!x) continue;
    var score = (x.rating && x.rating[0]) ? x.rating[0] : (x.score || '');
    var year = String(x.release_date || '').slice(0, 4);
    var meta = (x.regions || []).join('/') + ' · ' + (x.types || []).join(',');
    var o = {
      vod_id: String(x.id || ''),
      vod_name: x.title || '',
      vod_pic: dbPic(x.cover_url || ''),
      vod_remarks: score !== '' ? (score + '分') : '',
      vod_year: year,
      vod_content: meta,
      type_name: tname || '',
      _regions: x.regions || [],
      _year: year
    };
    DB_INDEX[o.vod_id] = o;
    out.push(o);
  }
  return out;
}

function dbPage(tid) {
  var d = dbJson(dbUrl(tid, 1)) || {};
  var tn = dbCateName(tid);
  return d.subjects ? dbMapTag(d.subjects, tn) : dbMapRank(d.subject_collection_items || [], tn);
}

/* 组合榜：拉整份类型高分榜后在本地按地区 / 年代筛选 */
function dbCombo(tid, pg) {
  pg = parseInt(pg, 10) || 1;
  var all = dbMapChart(dbArray(dbUrl(tid, pg)), dbCateName(tid));
  var parts = String(tid).split('|'), i, pass = [], mode = '', val = '';

  for (i = 1; i < parts.length; i++) {
    if (parts[i].indexOf('rg=') === 0) { mode = 'rg'; val = parts[i].slice(3); }
    else if (parts[i].indexOf('y=') === 0) { mode = 'y'; val = parts[i].slice(2); }
  }

  for (i = 0; i < all.length; i++) {
    var it = all[i];
    if (mode === 'rg') {
      var regs = it._regions || [], hit = false, j;
      for (j = 0; j < regs.length; j++) if (regs[j] === val) hit = true;
      if (hit) pass.push(it);
    } else if (mode === 'y') {
      var ys = val.split('-');
      var y = parseInt(it._year, 10);
      if (y >= parseInt(ys[0], 10) && y <= parseInt(ys[1], 10)) pass.push(it);
    } else {
      pass.push(it);
    }
  }

  pass = dbNoPic(pass);
  for (i = 0; i < pass.length; i++) { delete pass[i]._regions; delete pass[i]._year; }

  var total = pass.length;
  var start = (pg - 1) * DB_SIZE;
  var list = pass.slice(start, start + DB_SIZE);
  return { page: pg, pagecount: Math.max(1, Math.ceil(total / DB_SIZE)), limit: DB_SIZE, total: total, list: list };
}

/* 首页综合：多榜单轮转交错 */
function dbMix() {
  var pools = [], i, j;
  for (i = 0; i < DB_MIX.length; i++) {
    var list = dbPage(DB_MIX[i]);
    var part = [];
    for (j = 0; j < list.length && j < 10; j++) {
      if (list[j].vod_name) part.push(list[j]);
    }
    pools.push(part);
  }
  var out = [], seen = {}, k;
  for (k = 0; k < 10; k++) {
    for (i = 0; i < pools.length; i++) {
      var v = pools[i][k];
      if (!v || !v.vod_pic) continue;            // 无封面的不要
      var key = v.vod_id || v.vod_name;          // 榜单之间有交叉，首页去重
      if (seen[key]) continue;
      seen[key] = 1;
      out.push(v);
    }
  }
  return out;
}

function dbList(tid, pg) {
  pg = parseInt(pg, 10) || 1;
  if (tid === 'mix') {
    var mlist = dbMix();
    return { page: 1, pagecount: 1, limit: mlist.length, total: mlist.length, list: mlist };
  }
  if (String(tid).indexOf('cb|') === 0) return dbCombo(tid, pg);

  var d = dbJson(dbUrl(tid, pg)) || {};
  var items = d.subjects || d.subject_collection_items || [];
  var tn = dbCateName(tid);
  var list = dbNoPic(d.subjects ? dbMapTag(items, tn) : dbMapRank(items, tn));
  var pagecount = d.total ? (Math.ceil(d.total / DB_SIZE) || 1)
                          : (list.length >= DB_SIZE ? pg + 1 : pg);
  return { page: pg, pagecount: pagecount, limit: DB_SIZE, total: d.total || (pg * DB_SIZE), list: list };
}

/* ============================================================================
 * 对外接口
 * ============================================================================
 * 必须把爬虫对象赋给 __JS_SPIDER__，而不是散落的全局函数。
 * 写成散落函数（function homeContent(){} 这种）会导致两个引擎都取不到对象：
 * FongMi 取 globalThis.__JS_SPIDER__ 得到 undefined，异常被 JsLoader 的
 * catch(Throwable) 吞掉 -> 降级成 SpiderNull -> 点进去一片空白且不报错。
 *
 * 两个引擎的实际处理（源码位置）：
 *
 *   FongMi  quickjs/crawler/Spider.java#createObj()
 *       ctx.evaluateModule(content.replace("__JS_SPIDER__", "globalThis.__JS_SPIDER__"), api)
 *       jsObject = ctx.getProperty(ctx.getGlobalObject(), "__JS_SPIDER__")
 *
 *   TVBox   util/js/JsSpider.java#initializeJS()  与  SpiderJS.java#initjs()
 *       content.replaceAll("__JS_SPIDER__\\s*=", "export default ")   // 注意这会全局替换
 *       // 再用模板 import * as spider from 'api'
 *       //   if (!globalThis.__JS_SPIDER__) { if (spider.default) 全局赋值 = spider.default }
 *
 * 三条硬规则：
 *   1) 顶层只写「__JS_SPIDER__ 后接等号」再跟对象字面量。不要加 globalThis. 前缀（TVBox
 *      的正则就匹配不到，它找不到 default 导出）；也不要写 var/let/const 声明（会变成模块内局部变量）。
 *      写成 export default 也不行，FongMi 那边不会走 default 分支。
 *   2) 只用短名：home / homeVod / category / detail / search / play / sniffer / isVideo / init / destroy。
 *      不要用 homeContent 这类长名（两个引擎都只调短名，长名永远不会被调用）。
 *   3) 每个方法返回 JSON 字符串（引擎会强转 String）。
 *
 * 注意：本文件有两类「文本级」约束，注释里出现也算，务必遵守：
 *   a) 除下面那一行真实赋值外，任何地方都不要再出现「__JS_SPIDER__ 后接等号」的写法。
 *      TVBox 用的是正则【全局】替换，多一处就多产生一个默认导出，污染替换结果。
 *   b) 不要在文件里写出引擎用来识别「导出方式」的两个哨兵字面量
 *      （一个是 jsEval 系列的下划线名，一个是 默认导出关键字 紧跟左花括号）。
 *      加载器会先用 contains() 判断它们，命中就走错分支：会给脚本追加上一句
 *      调用并不存在的导出函数的代码，直接 ReferenceError 导致整个数据源加载失败。
 *      所以此处刻意不复述原文，改代码时也不要"顺手"把它们写进注释。
 * ========================================================================== */

__JS_SPIDER__ = {

  init: function (ext) { return ''; },

  /* 首页：分类 Tab + 综合混流内容 */
  home: function (filter) {
    return JSON.stringify({ 'class': DB_CATES, list: dbMix(), filters: {} });
  },

  /* 首页推荐位（可留空，这里复用混流） */
  homeVod: function () {
    return JSON.stringify({ list: dbMix() });
  },

  /* 分类列表 */
  category: function (tid, pg, filter, extend) {
    return JSON.stringify(dbList(tid, pg));
  },

  /* 详情：豆瓣元数据 + 多资源站聚合
   * 打开详情页时就用片名去各资源站搜一遍，把命中的 m3u8 挂成「线路」，
   * 这样点进去直接就能播，不必再去搜索页手动搜。 */
  detail: function (id) {
    id = String(id || '').trim();

    /* 豆瓣详情：movie 接口对电影和剧集都通，404 时再试 tv（综艺类常只有 tv） */
    var d = dbJson(DB_API + '/movie/' + id + '?platform=web');
    if (!d || !d.title) {
      var d2 = dbJson(DB_API + '/tv/' + id + '?platform=web');
      if (d2 && d2.title) d = d2;
    }
    if (!d) d = {};

    /* 片名：豆瓣优先，列表页缓存兜底（豆瓣对个别老条目会 404） */
    var memo = DB_INDEX[id] || {};
    var title = d.title || memo.vod_name || '';

    var pic = '';
    if (d.pic) pic = d.pic.normal || d.pic.large || d.pic.small || '';
    if (!pic) pic = d.cover_url || memo.vod_pic || '';

    var rating = (d.rating && d.rating.value) ? (d.rating.value + '分') : (memo.vod_remarks || '');
    var actors = [], directors = [];
    try {
      var cs = d.actors || d.credits || [];
      for (var i = 0; i < cs.length && i < 6; i++) actors.push(cs[i].title || cs[i].name || '');
      var ds = d.directors || [];
      for (var j = 0; j < ds.length && j < 3; j++) directors.push(ds[j].title || ds[j].name || '');
    } catch (e) {}

    var vod = {
      vod_id: id,
      vod_name: title,
      vod_pic: dbPic(pic),
      vod_remarks: rating,
      vod_year: String(d.year || memo.vod_year || ''),
      vod_area: (d.countries || []).join(','),
      vod_actor: actors.join(','),
      vod_director: directors.join(','),
      vod_content: d.intro || d.card_subtitle || memo.vod_content || '',
      type_name: (d.genres || []).join(',')
    };

    /* 聚合：有资源的站才进线路列表；两条串必须等长，否则盒子会错位 */
    var agg = dbAgg(title);
    if (agg && agg.from && agg.url) {
      vod.vod_play_from = agg.from;
      vod.vod_play_url = agg.url;
    }

    return JSON.stringify({ list: [vod] });
  },

  /* 搜索：豆瓣 j/subject_suggest
   * 实测（2026-09-30）：这是目前唯一还活着的"关键词搜索"接口。
   * 注意 m.douban.com/rexxar/api/v2/search 已返回 {"msg":"need_login","code":103}，
   * 需要登录态，用不了；所以搜索只能走这一个。返回 1~4 条建议，量不大但准。 */
  search: function (key, quick, pg) {
    key = String(key || '').trim();
    if (!key) return JSON.stringify({ list: [] });
    var arr = dbArray(DB_SUGGEST + encodeURIComponent(key));
    var out = [], i, isTv;
    for (i = 0; i < arr.length; i++) {
      var x = arr[i];
      if (!x || !x.id || !x.title) continue;
      isTv = (x.type === 'tv');
      out.push({
        vod_id: String(x.id),
        vod_name: x.title,
        vod_pic: dbPic(x.img || ''),
        vod_remarks: x.year ? (x.year + (isTv ? ' 剧集' : '')) : '',
        vod_year: String(x.year || ''),
        vod_content: x.sub_title || '',
        type_name: isTv ? '剧集' : '电影'
      });
    }
    return JSON.stringify({ list: out });
  },

  /* 播放：聚合挂上来的地址本身就是 m3u8 直链，直接交播放器，不解析 */
  play: function (flag, id, vipFlags) {
    var u = String(id || '').trim();
    if (u.indexOf('http') === 0) {
      return JSON.stringify({ parse: 0, url: u, header: { 'User-Agent': DB_UA } });
    }
    return JSON.stringify({ parse: 0, url: '', header: {} });
  },

  sniffer: function () { return false; },
  isVideo: function (url) { return false; },
  destroy: function () { return ''; }
};
