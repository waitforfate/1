/**
 * 豆瓣热榜 —— TVBox / FongMi 数据源（整理版：9 Tab + 筛选器）
 *
 * 历史改动（2026-09-30）：
 *   原版 170 个分类平铺成 Tab，太长。现改为 9 个 Tab：
 *     综合推荐 / 实时热门 / 电影热榜 / 剧集热榜 / 综艺热播   ← 保留的实时热门
 *     榜单大全 / 电影 / 剧集 / 精选                          ← 其余全部收进筛选器
 *
 * 本版改动（2026-10-04）—— 加载速度，全部改动都以源码为据，两端同一种写法：
 *   1) 真并发：用两端都注入的 _http(url, {complete}) 发起异步请求，JS 侧包成 Promise，
 *      方法返回 Promise 由引擎的 Async 等待。首页混流 6 个源、详情页 5 个采集站
 *      由「逐个排队」变成「同时发出」，耗时从累加变成取最慢的一个。
 *      注意不是用 java.util.concurrent —— 两端都是 QuickJS，JS 里没有 java 对象。
 *   2) home 瘦身：class / filters 是硬编码数组，0 毫秒生成，原先被串行请求拖到数秒后才出现。
 *      现在首屏只发 1 个请求，完整混流放到「综合推荐」Tab 按需跑。
 *   3) 超时：引擎 Req 的默认值是 10 秒，死站会白等；现在豆瓣 8 秒、采集站 3 秒。
 *   4) 持久化：用两端都注入的 local（落盘到 Prefers / Hawk）存首页混流与详情聚合，
 *      进程退出不清空，第二次开盒子直接读盘，不用重新走网络。
 *   5) 采集站按实测速度重排，并把「提前退出」换成并发下的等价做法。
 *   出问题想退回旧行为：把 DB_PARALLEL 改成 false 即可，其余逻辑不用动。
 *   各 Tab 的筛选器（接口全部实测可用）：
 *     榜单大全：榜单（Top250 / 一周口碑 / 华语好剧 / 高分榜 / 经典 / 动画剧集 / 纪录片…）
 *     电影    ：类型 × 地区 × 年代 任意组合 + 排序（热度/高分）
 *     剧集    ：分类（电视剧/综艺/纪录片）× 类型 × 地区 × 年代 + 排序
 *     精选    ：精选 / 地区 / 类型 / 年代（单选，按行优先级取值）
 *
 * 加载机制（关键，改错就整站空白且不报错）：
 *   脚本必须把爬虫对象赋给全局名 __JS_SPIDER__，方法名用短名 home/category/detail。
 *   两个引擎对同一个写法的处理不同，但结果一致：
 *     FongMi      ：把 "__JS_SPIDER__" 整词替换为 "globalThis.__JS_SPIDER__"，再按 ES 模块执行，
 *                   最后从 globalThis 上取回该对象。
 *     TVBox(Box)  ：把「__JS_SPIDER__ 后接等号」正则替换成默认导出，模板再
 *                   `import * as spider`，走 spider.default 挂回 globalThis.__JS_SPIDER__。
 *   所以写法只有一个要求：顶层直接写「__JS_SPIDER__ 后接等号」再跟一个对象字面量，
 *   既不要加 globalThis. 前缀（TVBox 的正则就匹配不到了），也不要写成模块导出。
 *
 * 网络层：按引擎逐个尝试 req / http / Request，谁可用用谁（见 dbFetch）。
 *   FongMi(QuickJS)：req(url,{async:false,headers}) => { code, headers, content }
 *   其它分支      ：Request(url,{headers}) 链式调用
 *
 * 四个数据源（2026-09-30 逐个实测验证）：
 *   1) m.douban.com/rexxar subject_collection  —— 官方榜单（实时热门、Top250、周榜…）
 *   2) movie.douban.com/j/search_subjects      —— 按单标签选片（精选/地区/类型/年代标签）
 *   3) movie.douban.com/j/new_search_subjects  —— 多维筛选（类型×地区×年代×排序，电影/电视剧/
 *                                                  综艺/纪录片通用），本版筛选器的主力接口
 *   4) movie.douban.com/j/subject_suggest       —— 关键词搜索
 *
 * 首页 = 综合混流：10 个主打榜单各取前 10 条轮转交错，打开即全部可见。
 *
 * 想调整筛选项：只改下面 DB_RANK / DB_FEAT / DB_AREA / DB_GENRE / DB_ERA
 * 以及 DB_FILTERS 构建处的枚举数组即可，逻辑不用动。
 */

var DB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
var DB_API = 'https://m.douban.com/rexxar/api/v2';
var DB_TAG = 'https://movie.douban.com/j/search_subjects';
var DB_NEW = 'https://movie.douban.com/j/new_search_subjects';
var DB_SUGGEST = 'https://movie.douban.com/j/subject_suggest?q=';
var DB_SIZE = 20;

/* ---------- 超时 ----------
 * 引擎 Req.getTimeout() 的默认实现是「没传就用 10000ms」，也就是说死站要白等 10 秒
 * 才会失败。详情页串行查多个站时，一个死站就能把整个页面拖垮。这里显式传 timeout：
 *   豆瓣  8 秒（接口偶发慢，太短会误杀）
 *   采集站 3 秒（快站普遍 1~2 秒，3 秒没回就是废站，早放弃早出结果）
 * 两个引擎的 req / _http 都接受 options.timeout，字段名完全一致。 */
var DB_TIMEOUT = 8000;
var DB_SRC_TIMEOUT = 3000;

/* ---------- 并发开关 ----------
 * true ：用 _http 的 complete 回调做真并发，两端通用（见 dbFetchP 的注释）。
 * false：退回原来的同步串行。出任何兼容性问题时，改这一行即可，不用动逻辑。 */
var DB_PARALLEL = true;

/* ---------- 持久化 ----------
 * 原来的缓存全是内存变量，进程一退就消失，所以每次开盒子都要重新等一轮网络。
 * 两端都注入了同名对象 local（FongMi: quickjs/method/Local.java；Box: util/js/local.java），
 * 方法签名完全一致：local.get(空间, 键) / local.set(空间, 键, 值) / local.delete(空间, 键)，
 * 落盘到 Prefers / Hawk，是真正跨进程保存的。这里用它缓存首页混流与详情聚合。 */
var DB_STORE = 'douban';
var DB_STORE_TTL = 30 * 60 * 1000;   // 持久化缓存 30 分钟
var DB_STORE_MAX = 30000;            // 单条超过 30KB 不写盘（避免撑爆 Prefers）

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
 * 排序依据（2026-10-04 复测，关键词「庆余年」「肖申克的救赎」各搜一遍）：
 *   按「响应速度 + 是否真能搜到」综合排，快的在前。两侧网络环境不同，绝对值会有出入，
 *   但靠前的几个在两轮实测里都稳定命中且分数最高（800~1000 分）。
 *   末尾几个是这两轮实测里超时/没命中的，保留但不会被查到（DB_SRC_MAX 之外）。
 *
 * 并发说明：现在这 DB_SRC_MAX 个站是「同时」发出去的，总耗时 = 最慢的那一个，
 *   而不是累加。所以站点数可以从 5 保留甚至调大，时间几乎不变，只提高命中率。
 *   死站由 DB_SRC_TIMEOUT 封顶 3 秒，不会再拖垮整个详情页。
 * ========================================================================== */
var DB_SRC = [
  { n: '猫眼资源',  a: 'https://api.maoyanapi.top/api.php/provide/vod/' },
  { n: '非凡资源',  a: 'https://cj.ffzyapi.com/api.php/provide/vod/' },
  { n: '电影天堂',  a: 'https://caiji.dyttzyapi.com/api.php/provide/vod/' },
  { n: '量子资源',  a: 'https://cj.lziapi.com/api.php/provide/vod/' },
  { n: '浩瀚资源',  a: 'https://hhzyapi.com/api.php/provide/vod/' },
  { n: '360影视',   a: 'https://360zy.com/api.php/provide/vod/' },
  { n: '光速资源',  a: 'https://api.guangsuapi.com/api.php/provide/vod/' },
  { n: '魔都资源',  a: 'https://caiji.moduapi.cc/api.php/provide/vod/' },
  { n: '虎牙资源',  a: 'https://www.huyaapi.com/api.php/provide/vod/' },
  { n: '无尽资源',  a: 'https://api.wujinapi.com/api.php/provide/vod/' },
  { n: '红牛资源',  a: 'https://hongniuzy2.com/api.php/provide/vod/' },
  { n: '2100影视', a: 'https://p2100.net/api.php/provide/vod/' },
  { n: '速播资源',  a: 'https://subocaiji.com/api.php/provide/vod/' },
  { n: '最大资源',  a: 'https://api.zuidapi.com/api.php/provide/vod/' },
  { n: '爱奇艺资源', a: 'https://iqiyizyapi.com/api.php/provide/vod/' }
];
var DB_SRC_MAX = 5;       // 详情页同时并发查几个站（并发下加数量几乎不加时间）
var DB_SRC_SCORE = 200;   // 片名相似度下限，低于它认为是别的片子，丢弃
var DB_INDEX = {};        // vod_id -> 列表页那一条（豆瓣接口对个别老条目会 404，用它兜底）
var DB_AGG = {};          // 片名 -> 聚合结果缓存
var DB_AGG_N = 0;         // 缓存条数，超过 DB_AGG_MAX 就整体清空（够用且不会涨内存）

/* ① 官方榜单：rexxar subject_collection（前 4 个是 Tab，其余进「榜单大全」筛选器） */
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

/* ② 精选标签（j/search_subjects 的 movie 标签，「精选」Tab 用） */
var DB_FEAT = ['豆瓣高分', '冷门佳片', '经典', '高分电影', '必看', '感人', '史诗', '群像', '暗黑', '治愈系',
               '邪典', 'cult', '一生必看', '青春校园', '良心剧', '烧脑', '反转', '高能', '催泪', '神作'];

/* ③ 地区标签（j/search_subjects 的 movie 标签，「精选」Tab 的地区行） */
var DB_AREA = ['华语', '中国大陆', '中国香港', '中国台湾', '美国', '日本', '韩国', '英国', '法国', '德国',
               '意大利', '西班牙', '俄罗斯', '印度', '泰国', '巴西', '加拿大', '澳大利亚', '爱尔兰', '瑞典',
               '丹麦', '波兰', '墨西哥', '阿根廷', '荷兰', '瑞士'];

/* ④ 类型标签（j/search_subjects 的 movie 标签，「精选」Tab 的类型行） */
var DB_GENRE = ['剧情', '喜剧', '爱情', '动作', '科幻', '悬疑', '犯罪', '恐怖', '惊悚', '动画', '纪录片',
                '历史', '战争', '家庭', '音乐', '传记', '奇幻', '冒险', '武侠', '古装', '短片', '运动',
                '儿童', '西部', '黑白', '灾难', '同性', '文艺', '治愈', '青春', '赛车', '校内'];

/* ⑤ 年代标签（j/search_subjects 的 movie 标签，「精选」Tab 的年代行） */
var DB_ERA = [2024, 2022, 2021, 2020, 2019, 2018, 2017, 2016, 2015, 2014, 2013, 2012, 2011, 2010, 2009];

/* 首页综合混流来源
 * 原来是 10 个源「串行」各请求一次，实测 4~8 秒，是首页慢的主因。
 * 现在改成 6 个源「并发」：总耗时 = 最慢的那一个（约 1.5 秒），而不是 6 次累加。
 * 源的取舍：去掉与 Top250 高度重复的高分榜，以及两个冷门标签，保留覆盖
 * 综合热门 / 经典 / 新片口碑 / 剧集 / 综艺 / 精选 六个方向，去重后仍有 50 条左右。 */
var DB_MIX = [
  'rk|subject_real_time_hotest', 'rk|movie_top250', 'rk|movie_weekly_best',
  'rk|tv_real_time_hotest', 'rk|show_hot', 'tg|movie|豆瓣高分'
];

/*
 * type_id 编码（本版只有 9 个 Tab）：
 *   mix                      首页综合混流
 *   rk|<集合ID>              官方榜单（前 5 个 Tab）
 *   rank                     榜单大全（筛选：榜单 -> rk|<集合ID>）
 *   movie                    电影（筛选：类型×地区×年代×排序 -> j/new_search_subjects）
 *   tv                       剧集（筛选：分类×类型×地区×年代×排序 -> j/new_search_subjects）
 *   tag                      精选（筛选：精选/地区/类型/年代 -> j/search_subjects 单标签）
 */
var DB_CATES = [];
var DB_FILTERS = {};
(function () {
  function add(tid, name) { DB_CATES.push({ type_id: tid, type_name: name }); }
  function row(key, opts) { return { key: key, name: key, value: opts }; }
  /* vals 元素：字符串 = 名称即取值；['显示名','取值'] 二元组 = 自定义 */
  function opt(vals) {
    var out = [], i;
    for (i = 0; i < vals.length; i++) {
      if (typeof vals[i] === 'string') out.push({ n: vals[i] === '' ? '全部' : vals[i], v: vals[i] });
      else out.push({ n: vals[i][0], v: vals[i][1] });
    }
    return out;
  }
  var i;

  /* ===== 9 个 Tab：5 个实时热门 + 4 个可筛选 ===== */
  add('mix', '综合推荐');
  add('rk|' + DB_RANK[0].id, '实时热门');
  add('rk|movie_real_time_hotest', '电影热榜');
  add('rk|tv_real_time_hotest', '剧集热榜');
  add('rk|show_hot', '综艺热播');
  add('rank', '榜单大全');
  add('movie', '电影');
  add('tv', '剧集');
  add('tag', '精选');

  /* ===== 榜单大全：其余 8 个官方榜收进一行筛选 ===== */
  var rkOpts = [];
  for (i = 4; i < DB_RANK.length; i++) rkOpts.push({ n: DB_RANK[i].n, v: DB_RANK[i].id });
  DB_FILTERS['rank'] = [row('榜单', rkOpts)];

  /* ===== 电影：类型 × 地区 × 年代 任意组合 + 排序（全部实测可用） ===== */
  DB_FILTERS['movie'] = [
    row('类型', opt(['', '剧情', '喜剧', '爱情', '动作', '科幻', '悬疑', '犯罪', '恐怖', '惊悚', '动画', '纪录片',
                    '历史', '战争', '家庭', '传记', '奇幻', '冒险', '武侠', '古装', '西部', '灾难', '音乐', '同性'])),
    row('地区', opt(['', '中国大陆', '中国香港', '中国台湾', '美国', '日本', '韩国', '英国', '法国', '德国',
                    '意大利', '西班牙', '俄罗斯', '印度', '泰国'])),
    row('年代', opt([['全部', ''], '2024', '2023', '2022', '2021', '2020',
                    ['2015-2019', '2015-2019'], ['2010-2014', '2010-2014'], ['2000-2009', '2000-2009'],
                    ['90年代', '1990-1999'], ['80年代', '1980-1989']])),
    { key: '排序', name: '排序', value: [{ n: '热度', v: 'U' }, { n: '高分', v: 'S' }] }
  ];

  /* ===== 剧集：分类 × 类型 × 地区 × 年代 + 排序 ===== */
  DB_FILTERS['tv'] = [
    { key: '分类', name: '分类', value: [{ n: '电视剧', v: '电视剧' }, { n: '综艺', v: '综艺' }, { n: '纪录片', v: '纪录片' }] },
    row('类型', opt(['', '悬疑', '喜剧', '古装', '犯罪', '科幻', '奇幻', '爱情', '武侠', '历史', '战争', '都市', '青春'])),
    row('地区', opt(['', '中国大陆', '中国香港', '中国台湾', '美国', '日本', '韩国', '英国'])),
    row('年代', opt([['全部', ''], '2024', '2023', '2022', '2021', '2020',
                    ['2015-2019', '2015-2019'], ['2010-2014', '2010-2014'], ['2000-2009', '2000-2009'],
                    ['90年代', '1990-1999']])),
    { key: '排序', name: '排序', value: [{ n: '热度', v: 'U' }, { n: '高分', v: 'S' }] }
  ];

  /* ===== 精选：单标签选片。四行筛选同时只能生效一行，
   * 优先级：精选 > 地区 > 类型 > 年代；全空时默认「豆瓣高分」。
   * （search_subjects 的 tag 参数只收一个标签，多维组合请用「电影/剧集」Tab） */
  var featOpts = [['默认', '']], areaOpts = [['全部', '']], genreOpts = [['全部', '']], eraOpts = [['全部', '']];
  for (i = 0; i < DB_FEAT.length; i++)  featOpts.push(DB_FEAT[i]);
  for (i = 0; i < DB_AREA.length; i++)  areaOpts.push(DB_AREA[i]);
  for (i = 0; i < DB_GENRE.length; i++) genreOpts.push(DB_GENRE[i]);
  for (i = 0; i < DB_ERA.length; i++)   eraOpts.push(String(DB_ERA[i]));
  DB_FILTERS['tag'] = [
    row('精选', opt(featOpts)),
    row('地区', opt(areaOpts)),
    row('类型', opt(genreOpts)),
    row('年代', opt(eraOpts))
  ];
})();

function dbRef(url) {
  if (url.indexOf('/j/new_search_subjects') >= 0) return 'https://movie.douban.com/explore';
  if (url.indexOf('m.douban.com') >= 0) return 'https://m.douban.com/movie/';
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

/* 官方榜单显示名 */
function dbRankName(id) {
  var i;
  for (i = 0; i < DB_RANK.length; i++) if (DB_RANK[i].id === id) return DB_RANK[i].n;
  return '';
}

/* ---------- 短时结果缓存 ----------
 * 豆瓣对「同一 URL 短时间重复请求」会直接返回空串。用户来回切换分类、
 * 上下翻页时极易撞上，表现为列表突然空白。这里缓存 5 分钟内的成功结果：
 * 命中直接返回；所有请求分支都失败时兜底返回旧缓存，避免白屏。
 * --------------------------------------------------------------------------- */
var DB_CACHE = {};
var DB_CACHE_KEYS = [];
var DB_CACHE_TTL = 5 * 60 * 1000;
var DB_CACHE_MAX = 240;

function dbCacheTrim() {
  var now = Date.now(), i, k;
  for (i = DB_CACHE_KEYS.length - 1; i >= 0; i--) {
    k = DB_CACHE_KEYS[i];
    if (now - DB_CACHE[k].t >= DB_CACHE_TTL) { delete DB_CACHE[k]; DB_CACHE_KEYS.splice(i, 1); }
  }
  while (DB_CACHE_KEYS.length > DB_CACHE_MAX) {
    k = DB_CACHE_KEYS.shift();
    delete DB_CACHE[k];
  }
}
function dbCacheGet(url) {
  var c = DB_CACHE[url];
  if (c && Date.now() - c.t < DB_CACHE_TTL) return c.c;
  return '';
}
function dbCachePut(url, txt) {
  if (!txt || dbBanned(txt)) return dbCacheGet(url);   // 拒绝体绝不进缓存，否则会永久污染
  if (DB_CACHE_KEYS.length >= DB_CACHE_MAX) dbCacheTrim();
  if (DB_CACHE[url] === undefined) DB_CACHE_KEYS.push(url);
  DB_CACHE[url] = { t: Date.now(), c: txt };
  return txt;
}

/* 豆瓣反爬拒绝体：连续请求过快时返回
 *   {"msg":"检测到有异常请求从您的IP发出，请登录再试!","r":1}
 * 只有 38 字节，但内容是合法 JSON。若不识别，会被当成空结果/被写进缓存，
 * 导致用户之后看到的都是假空数据。判断条件刻意收紧，避免误伤正常响应。 */
function dbBanned(txt) {
  if (!txt) return true;
  if (txt.length > 500) return false;
  return txt.indexOf('"r":1') >= 0 || txt.indexOf('异常请求') >= 0 || txt.indexOf('请登录') >= 0;
}

/* ---------- 网络层：按引擎逐个尝试 ----------
 * hdr 不传时用豆瓣默认头（带 Referer，豆瓣接口缺它会被拒）；
 * 请求资源站时传一个不带豆瓣 Referer 的头（采集站对陌生 Referer 敏感）。
 * 失败重试：豆瓣限流时返回空串，稍等再试一次通常就能拿到数据。 */
function dbFetchOnce(url, h, ms) {
  var r, b, b2;
  var to = ms || DB_TIMEOUT;

  // FongMi：req(url, { async: false }) => { code, headers, content }
  try {
    if (typeof req === 'function') {
      r = req(url, { async: false, headers: h, timeout: to });
      if (r && r.content && String(r.content).length) return String(r.content);
    }
  } catch (e) {}

  // FongMi：http(url, { async: false })
  try {
    if (typeof http === 'function') {
      r = http(url, { async: false, headers: h, timeout: to });
      if (r && r.content && String(r.content).length) return String(r.content);
    }
  } catch (e) {}

  // 其它分支：Request(url, { headers }).get().body
  try {
    if (typeof Request === 'function') {
      b = Request(url, { headers: h }).get().body;
      if (b) return String(b);
    }
  } catch (e) {}

  // 其它分支：Request(url).headers().get().body
  try {
    if (typeof Request === 'function') {
      b2 = Request(url).headers(h).get().body;
      if (b2) return String(b2);
    }
  } catch (e) {}

  return '';
}

/* 同步忙等（QuickJS 里没有阻塞 sleep，同步 JS 本来就是阻塞的，可接受） */
function dbWait(ms) {
  var end = Date.now() + ms;
  while (Date.now() < end) { /* spin */ }
}

function dbFetch(url, hdr, ms) {
  var cached = dbCacheGet(url);
  if (cached) return cached;
  var h = hdr || { 'User-Agent': DB_UA, 'Referer': dbRef(url), 'Accept': 'application/json' };
  var txt = dbFetchOnce(url, h, ms);
  /* 豆瓣会对同一 IP 的密集请求返回「异常请求，请登录」的拒绝体（合法 JSON 但无数据）。
   * 退避再取一次通常能恢复；仍失败则兜底返回旧缓存，好过给用户空白页。 */
  if (dbBanned(txt)) { dbWait(1500); txt = dbFetchOnce(url, h, ms); }
  if (dbBanned(txt)) return dbCacheGet(url);
  return dbCachePut(url, txt);
}

function dbJson(url) {
  var txt = dbFetch(url);
  if (!txt) return null;
  try { return JSON.parse(txt); } catch (e) { return null; }
}

/* ============================================================================
 * 并发网络层
 * ----------------------------------------------------------------------------
 * 两端注入的 _http(url, options) 签名与语义完全一致（已核对源码）：
 *     Box     util/js/Global.java      @Function  public JSObject _http(...)
 *     FongMi  quickjs/method/Global.java  @JSMethod public JSObject _http(...)
 * 两者都是：options 里没有 complete 就当同步 req 处理并返回结果；
 *          有 complete 就交给 OkHttp 的 enqueue 异步入队，函数本身返回 null。
 * 也就是说它「发起异步请求」但「不返回 Promise」，Promise 要我们在 JS 侧自己包。
 *
 * 引擎侧会等我们返回的 Promise：
 *     Box     util/js/Async.java     result instanceof JSObject -> then(result)
 *     FongMi  quickjs/utils/Async.java  同样的写法
 * 两个 Async 都是「拿到返回值，有 then 就挂回调等 resolve，否则直接当结果」，
 * 且 Spider 里 home/category/detail/search/play 全部走这条路径。
 * 所以方法返回 Promise 是安全的，而且这是唯一能真正并行的办法 ——
 * QuickJS 是单线程，同步的 req 只能一个一个排队，脚本里做不到多线程。
 *
 * 降级：DB_PARALLEL 置 false，或环境里没有 _http / Promise，就整体走原来的同步串行。
 * ========================================================================== */

/* 环境探测：三个全局函数同属一套 QuickJS 注入，缺一个就说明是老引擎，不能用并发 */
var DB_ASYNC = (typeof _http === 'function' && typeof Promise === 'function');

/* 单个异步请求 -> Promise<文本>。命中内存缓存时直接 resolve，不再发请求。 */
function dbFetchP(url, hdr, ms) {
  var to = ms || DB_TIMEOUT;
  var hit = dbCacheGet(url);
  if (hit) return Promise.resolve(hit);
  return new Promise(function (resolve) {
    var done = false;
    function fin(v) {
      if (done) return;
      done = true;
      if (v && !dbBanned(v)) dbCachePut(url, v);
      resolve(v || '');
    }
    try {
      _http(url, {
        headers: hdr || { 'User-Agent': DB_UA, 'Referer': dbRef(url), 'Accept': 'application/json' },
        timeout: to,
        complete: function (r) {
          var c = '';
          try { if (r && r.content) c = String(r.content); } catch (e) { c = ''; }
          fin(c);
        }
      });
    } catch (e) { fin(''); }
    /* 超时兜底：任何一个请求不回调，Promise 就永远挂着，引擎会一直 await，
     * 表现为详情页转圈不出内容。用引擎注入的 setTimeout 兜一手，绝不允许挂死。 */
    try { setTimeout(function () { fin(''); }, to + 2000); } catch (e) {}
  });
}

/* 一批请求并发。jobs: [{url, hdr, ms}] -> Promise<文本数组>
 * 并发不可用时返回 null，调用方据此退回同步路径。 */
function dbFetchAll(jobs) {
  if (!DB_PARALLEL || !DB_ASYNC || !jobs || !jobs.length) return null;
  var ps = [], i;
  for (i = 0; i < jobs.length; i++) ps.push(dbFetchP(jobs[i].url, jobs[i].hdr, jobs[i].ms));
  return Promise.all(ps);
}

/* 返回值统一出口：对象 / Promise<对象> 都能转成引擎要的 JSON 字符串 */
function dbOut(v) {
  if (v && typeof v.then === 'function') {
    return v.then(function (o) { return JSON.stringify(o); });
  }
  return JSON.stringify(v);
}

/* ============================================================================
 * 持久化（local）
 * ----------------------------------------------------------------------------
 * 内存缓存进程一退就清空，所以每次开盒子都要重新等一轮网络。local 写到
 * Prefers / Hawk，是跨进程保存的，用来让「第二次打开」变成秒开。
 * 所有调用都包了 try：某些壳子没注入 local，那就静默退化成不持久化，不影响功能。
 * ========================================================================== */
function dbStoreGet(k) {
  try {
    if (typeof local === 'undefined' || !local) return '';
    var v = local.get(DB_STORE, k);
    return v ? String(v) : '';
  } catch (e) { return ''; }
}
function dbStoreSet(k, v) {
  try {
    if (typeof local === 'undefined' || !local) return;
    v = String(v);
    if (!v || v.length > DB_STORE_MAX) return;   // 太大的不写盘，避免撑爆 Prefers
    local.set(DB_STORE, k, v);
  } catch (e) {}
}
/* 读一个带时间戳的缓存包：过期返回空串 */
function dbStorePack(k) {
  var raw = dbStoreGet(k);
  if (!raw) return '';
  try {
    var o = JSON.parse(raw);
    if (!o || !o.t || Date.now() - o.t > DB_STORE_TTL) return '';
    return o.v || '';
  } catch (e) { return ''; }
}
function dbStoreSave(k, v) {
  try { dbStoreSet(k, JSON.stringify({ t: Date.now(), v: v })); } catch (e) {}
}

/* ============================================================================
 * 详情页多站聚合
 * ========================================================================== */

/* 请求采集站：不带豆瓣 Referer（采集站对陌生 Referer 敏感），超时按采集站的短时限 */
function dbApiFetch(url) {
  return dbFetch(url, { 'User-Agent': DB_UA, 'Accept': 'application/json' }, DB_SRC_TIMEOUT);
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

function dbSrcUrl(src, title) {
  return src.a + '?ac=detail&wd=' + encodeURIComponent(title);
}

/* 从一个采集站的响应文本里挑出这部片的播放列表（没命中返回空串）
 * 拆成「纯解析」是为了让同步和并发两条路复用同一段逻辑。 */
function dbSrcPick(txt, title) {
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

/* 在单个资源站里找这部片（同步版） */
function dbSrcLookup(src, title) {
  return dbSrcPick(dbApiFetch(dbSrcUrl(src, title)), title);
}

/* 把若干站的命中结果拼成 from / url 两条平行串（必须等长，否则盒子会错位）
 * off 是 txts 里采集站响应的起始下标：详情页会把豆瓣详情和采集站并到同一批请求里。 */
function dbAggJoin(txts, title, off) {
  var from = [], url = [], i, n = Math.min(DB_SRC_MAX, DB_SRC.length);
  off = off || 0;
  for (i = 0; i < n; i++) {
    var eps = '';
    try { eps = dbSrcPick(txts[off + i], title); } catch (e) { eps = ''; }
    if (!eps) continue;
    from.push(DB_SRC[i].n);
    url.push(eps);
  }
  return { from: from.join('$$$'), url: url.join('$$$') };
}

/* 聚合结果入内存缓存 + 写盘 */
function dbAggSave(title, r) {
  if (!title || !r) return r;
  if (DB_AGG_N > 60) { DB_AGG = {}; DB_AGG_N = 0; }
  DB_AGG[title] = r; DB_AGG_N++;
  dbStoreSave('agg_' + title, JSON.stringify(r));
  return r;
}

/* 详情页条目组装：豆瓣元数据 + 聚合出来的线路。
 * 抽成函数是因为并发路径和同步路径要共用这一段。 */
function dbVod(id, d, agg) {
  d = d || {};
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

  /* 有资源的站才进线路列表；两条串必须等长，否则盒子会错位 */
  if (agg && agg.from && agg.url) {
    vod.vod_play_from = agg.from;
    vod.vod_play_url = agg.url;
  }
  return vod;
}

/* 同步串行版：并发不可用时的退路 */
function dbAggSync(title) {
  var txts = [], i, n = Math.min(DB_SRC_MAX, DB_SRC.length);
  for (i = 0; i < n; i++) {
    var t = '';
    try { t = dbApiFetch(dbSrcUrl(DB_SRC[i], title)); } catch (e) { t = ''; }
    txts.push(t);
  }
  return dbAggJoin(txts, title);
}

/* 多站聚合：优先并发（耗时 = 最慢的那一站），不可用则退回串行。
 * 结果进内存缓存；同时按片名写一份到 local，下次开盒子直接读盘，不用重新查。 */
function dbAgg(title, useAsync) {
  title = String(title || '').trim();
  if (!title) return null;
  if (DB_AGG[title]) return DB_AGG[title];

  var key = 'agg_' + title;
  var saved = dbStorePack(key);
  if (saved) {
    try {
      var o = JSON.parse(saved);
      if (o && typeof o === 'object') { DB_AGG[title] = o; DB_AGG_N++; return o; }
    } catch (e) {}
  }

  if (DB_AGG_N > 60) { DB_AGG = {}; DB_AGG_N = 0; }

  if (useAsync && DB_PARALLEL && DB_ASYNC) {
    var jobs = [], i, n = Math.min(DB_SRC_MAX, DB_SRC.length);
    for (i = 0; i < n; i++) {
      jobs.push({ url: dbSrcUrl(DB_SRC[i], title), hdr: { 'User-Agent': DB_UA, 'Accept': 'application/json' }, ms: DB_SRC_TIMEOUT });
    }
    var p = dbFetchAll(jobs);
    if (p) {
      return p.then(function (txts) { return dbAggSave(title, dbAggJoin(txts, title)); });
    }
  }

  return dbAggSave(title, dbAggSync(title));
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

/* new_search_subjects 条目：{data:[{id,title,cover,rate,directors,casts,...}]}，无 total 字段 */
function dbMapNew(items, tname) {
  var out = [], i;
  for (i = 0; i < items.length; i++) {
    var it = items[i];
    if (!it || !it.id || !it.title) continue;
    var dr = it.directors || [], ca = it.casts || [], meta = [];
    if (dr.length) meta.push('导演: ' + dr.slice(0, 2).join(' / '));
    if (ca.length) meta.push('主演: ' + ca.slice(0, 4).join(' '));
    var o = {
      vod_id: String(it.id),
      vod_name: it.title,
      vod_pic: dbPic(it.cover || ''),
      vod_remarks: it.rate ? (it.rate + '分') : '',
      vod_year: '',
      vod_content: meta.join('  '),
      type_name: tname || ''
    };
    DB_INDEX[o.vod_id] = o;
    out.push(o);
  }
  return out;
}

/* ---------- 列表：官方榜单（rk） ---------- */
function dbRank(id, pg) {
  pg = parseInt(pg, 10) || 1;
  var start = (pg - 1) * DB_SIZE;
  if (isNaN(start) || start < 0) start = 0;
  var d = dbJson(DB_API + '/subject_collection/' + id + '/items?start=' + start + '&count=' + DB_SIZE) || {};
  var tn = dbRankName(id);
  var list = dbNoPic(dbMapRank(d.subject_collection_items || [], tn));
  var pagecount = d.total ? (Math.ceil(d.total / DB_SIZE) || 1)
                          : (list.length >= DB_SIZE ? pg + 1 : pg);
  return { page: pg, pagecount: pagecount, limit: DB_SIZE, total: d.total || (pg * DB_SIZE), list: list };
}

/* ---------- 列表：单标签选片（tg，search_subjects） ---------- */
function dbTag(type, tag, pg) {
  pg = parseInt(pg, 10) || 1;
  var start = (pg - 1) * DB_SIZE;
  if (isNaN(start) || start < 0) start = 0;
  var d = dbJson(DB_TAG + '?type=' + encodeURIComponent(type) + '&tag=' + encodeURIComponent(tag) +
                 '&sort=rank&page_limit=' + DB_SIZE + '&page_start=' + start) || {};
  var list = dbNoPic(dbMapTag(d.subjects || [], tag));
  var pagecount = d.total ? (Math.ceil(d.total / DB_SIZE) || 1)
                          : (list.length >= DB_SIZE ? pg + 1 : pg);
  return { page: pg, pagecount: pagecount, limit: DB_SIZE, total: d.total || (pg * DB_SIZE), list: list };
}

/* ---------- 列表：多维筛选（new_search_subjects，电影/电视剧/综艺/纪录片通用）
 * ext 取值：分类(仅tv用，默认电视剧) / 类型 / 地区 / 年代(单年或yyyy-yyyy) / 排序(U热度,S高分)
 * 年代 '2015-2019' 会被转成接口要的 year_range=2015,2019；单年 '2024' 转 2024,2024。
 * 实测（2026-09-30）：该接口支持 类型×地区×年代 任意组合，Referer 必须带
 * movie.douban.com/explore（dbRef 已处理），无 total 字段，用「满页则还有下一页」翻页。 */
function dbNew(tags, ext, pg) {
  pg = parseInt(pg, 10) || 1;
  var start = (pg - 1) * DB_SIZE;
  if (isNaN(start) || start < 0) start = 0;

  var sort = ext['排序'] === 'S' ? 'S' : 'U';
  var url = DB_NEW + '?sort=' + sort + '&range=0,10&tags=' + encodeURIComponent(tags) + '&start=' + start;

  var g = ext['类型'] || '', c = ext['地区'] || '', y = String(ext['年代'] || '');
  if (g) url += '&genres=' + encodeURIComponent(g);
  if (c) url += '&countries=' + encodeURIComponent(c);
  if (y) {
    if (y.indexOf('-') >= 0) y = y.split('-')[0] + ',' + y.split('-')[1];
    else y = y + ',' + y;
    url += '&year_range=' + y;
  }

  var d = dbJson(url) || {};
  var items = d.data || [];
  var list = dbNoPic(dbMapNew(items, tags + (g ? '·' + g : '') + (c ? '·' + c : '') + (y ? '·' + ext['年代'] : '')));
  var pagecount = items.length >= DB_SIZE ? pg + 1 : pg;
  return { page: pg, pagecount: pagecount, limit: DB_SIZE, total: pg * DB_SIZE, list: list };
}

/* ---------- 首页混流 ----------
 * 拆成「拼 URL」+「解析响应」两步，是为了让同步和并发两条路共用同一段逻辑。 */
function dbPageUrl(tid) {
  if (String(tid).indexOf('rk|') === 0) {
    return DB_API + '/subject_collection/' + String(tid).slice(3) + '/items?start=0&count=' + DB_SIZE;
  }
  var p = String(tid).slice(3).split('|');
  return DB_TAG + '?type=' + encodeURIComponent(p[0]) + '&tag=' + encodeURIComponent(p[1]) +
         '&sort=rank&page_limit=' + DB_SIZE + '&page_start=0';
}

function dbPageParse(tid, txt) {
  var d = null;
  try { d = JSON.parse(txt); } catch (e) { d = null; }
  if (!d) return [];
  if (String(tid).indexOf('rk|') === 0) {
    return dbMapRank(d.subject_collection_items || [], dbRankName(String(tid).slice(3)));
  }
  var p = String(tid).slice(3).split('|');
  return dbMapTag(d.subjects || [], p[1]);
}

function dbPage(tid) {
  return dbPageParse(tid, dbFetch(dbPageUrl(tid)));
}

/* 多个榜单轮转交错 + 去重（首页混流的收尾） */
function dbMixJoin(pools) {
  var out = [], seen = {}, i, k, v, key;
  for (k = 0; k < 10; k++) {
    for (i = 0; i < pools.length; i++) {
      v = pools[i][k];
      if (!v || !v.vod_pic) continue;            // 无封面的不要
      key = v.vod_id || v.vod_name;              // 榜单之间有交叉，首页去重
      if (seen[key]) continue;
      seen[key] = 1;
      out.push(v);
    }
  }
  return out;
}

function dbMixPools(txts) {
  var pools = [], i, j, list, part;
  for (i = 0; i < DB_MIX.length; i++) {
    list = dbPageParse(DB_MIX[i], txts[i]);
    part = [];
    for (j = 0; j < list.length && j < 10; j++) {
      if (list[j].vod_name) part.push(list[j]);
    }
    pools.push(part);
  }
  return dbMixJoin(pools);
}

/* 完整混流（同步串行）：并发不可用时的退路 */
function dbMix() {
  var txts = [], i;
  for (i = 0; i < DB_MIX.length; i++) txts.push(dbFetch(dbPageUrl(DB_MIX[i])));
  return dbMixPools(txts);
}

/* 完整混流（并发）：返回 Promise，拿不到就返回 null 让调用方走同步 */
function dbMixP() {
  if (!DB_PARALLEL || !DB_ASYNC) return null;
  var jobs = [], i;
  for (i = 0; i < DB_MIX.length; i++) jobs.push({ url: dbPageUrl(DB_MIX[i]), hdr: null, ms: DB_TIMEOUT });
  var p = dbFetchAll(jobs);
  if (!p) return null;
  return p.then(dbMixPools);
}

/* 首屏快出：只取 DB_MIX[0] 一个源（实时热门榜），最多 1 次请求。
 * 首页的 class / filters 都是硬编码数组，生成耗时为 0，真正拖慢首屏的是内容；
 * 所以首屏故意只发一个请求，让用户先看到菜单，完整混流留给用户点「综合推荐」时再跑。 */
var DB_HOME_QUICK = 12;
function dbMixQuick() {
  var list = dbPage(DB_MIX[0]);
  var out = [], seen = {}, i, v, key;
  for (i = 0; i < list.length && out.length < DB_HOME_QUICK; i++) {
    v = list[i];
    if (!v || !v.vod_name || !v.vod_pic) continue;
    key = v.vod_id || v.vod_name;
    if (seen[key]) continue;
    seen[key] = 1;
    out.push(v);
  }
  return out;
}

/* 进程内缓存：跑过一次完整混流后，home 就不用再走快出路径了 */
var DB_MIX_MEM = [];

/* home 的 list 取值顺序：进程内缓存 -> 持久化缓存 -> 单源快出
 * 前两者都是 0 次网络请求，所以只要看过一次完整混流，之后开盒子首页就是秒开。 */
function dbHomeList() {
  if (DB_MIX_MEM.length) return DB_MIX_MEM;
  var saved = dbStorePack('mix');
  if (saved) {
    try {
      var l = JSON.parse(saved);
      if (l && l.length) { DB_MIX_MEM = l; return l; }
    } catch (e) {}
  }
  return dbMixQuick();
}

/* ---------- 统一分发 ----------
 * extend 兼容对象与 JSON 字符串两种传法（两个引擎的 JS 环境有差异）。 */
function dbExt(x) {
  if (!x) return {};
  if (typeof x === 'object') return x;
  try { var o = JSON.parse(String(x)); return o && typeof o === 'object' ? o : {}; }
  catch (e) { return {}; }
}

/* 完整混流跑出来之后：存进进程内缓存，并写一份到磁盘，供下次开盒子直接秒开 */
function dbMixCache(l) {
  if (!l || !l.length) return;
  DB_MIX_MEM = l;
  dbStoreSave('mix', JSON.stringify(l));
}

function dbList(tid, pg, ext) {
  ext = dbExt(ext);
  pg = parseInt(pg, 10) || 1;

  if (tid === 'mix') {
    var p = dbMixP();
    if (p) {
      return p.then(function (mlist) {
        dbMixCache(mlist);
        return { page: 1, pagecount: 1, limit: mlist.length, total: mlist.length, list: mlist };
      });
    }
    var mlist = dbMix();
    dbMixCache(mlist);
    return { page: 1, pagecount: 1, limit: mlist.length, total: mlist.length, list: mlist };
  }
  if (tid === 'rank') return dbRank(ext['榜单'] || 'movie_top250', pg);
  if (tid === 'movie') return dbNew('电影', ext, pg);
  if (tid === 'tv') return dbNew(ext['分类'] || '电视剧', ext, pg);
  if (tid === 'tag') {
    /* 单标签接口，四行筛选只能生效一行：精选 > 地区 > 类型 > 年代 */
    var tag = ext['精选'] || ext['地区'] || ext['类型'] || ext['年代'] || '豆瓣高分';
    return dbTag('movie', String(tag), pg);
  }
  if (String(tid).indexOf('rk|') === 0) return dbRank(String(tid).slice(3), pg);
  if (String(tid).indexOf('tg|') === 0) {
    var p = String(tid).slice(3).split('|');
    return dbTag(p[0], p[1], pg);
  }
  return dbRank(DB_RANK[0].id, pg);
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
 *       content.replaceAll("__JS_SPIDER__\\s*=", ...)   // 注意这是全局替换
 *       // 再用模板 import * as spider from 'api'
 *       //   if (!globalThis.__JS_SPIDER__) { if (spider.default) 全局赋值 = spider.default }
 *
 * 三条硬规则：
 *   1) 顶层只写「__JS_SPIDER__ 后接等号」再跟对象字面量。不要加 globalThis. 前缀（TVBox
 *      的正则就匹配不到，它找不到默认导出）；也不要写 var/let/const 声明（会变成模块内局部变量）。
 *      写成显式导出语句也不行，FongMi 那边不会走 default 分支。
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

  /* 首页：9 个分类 Tab + 4 组筛选器（硬编码数组，0 毫秒生成）+ 一份「快出」内容。
   *
   * 为什么 list 不能留空：FongMi 的 SiteViewModel 只调 homeContent，**不会**补调
   * homeVod（已核对 SiteViewModel.java，全文只有 homeContent）；
   * Box 那边 homeVod 也只在 HOME_REC=1 时才走。所以 list 一空，首页就是永久空白。
   * 因此这里始终给内容，但只发一个请求，让菜单先把画面占住。 */
  home: function (filter) {
    return JSON.stringify({ 'class': DB_CATES, list: dbHomeList(), filters: DB_FILTERS });
  },

  /* 首页推荐位：完整混流（并发）。Box 在 HOME_REC=1 时调它；FongMi 不调，无副作用。 */
  homeVod: function () {
    var p = dbMixP();
    if (p) return p.then(function (l) {
      dbMixCache(l);
      return JSON.stringify({ list: l });
    });
    var l = dbMix();
    dbMixCache(l);
    return JSON.stringify({ list: l });
  },

  /* 分类列表：tid 为 9 个 Tab 之一；extend 为筛选器选中值（对象或 JSON 字符串）
   * 返回值可能是对象也可能是 Promise，交给 dbOut 统一转 JSON 字符串。 */
  category: function (tid, pg, filter, extend) {
    return dbOut(dbList(tid, pg, extend));
  },

  /* 详情：豆瓣元数据 + 多资源站聚合
   * 打开详情页时就用片名去各资源站搜一遍，把命中的 m3u8 挂成「线路」，
   * 这样点进去直接就能播，不必再去搜索页手动搜。
   *
   * 并发路径：豆瓣详情的 movie / tv 两个接口，和 N 个采集站的搜索「同时」发出，
   * 总耗时 = 最慢的那一个，而不是原来的「1~2 次豆瓣 + 5 站串行」累加。
   * 只有已经从列表页拿到片名时才走并发（采集站搜索要用片名），
   * 拿不到就退回同步路径，行为与旧版完全一致。 */
  detail: function (id) {
    id = String(id || '').trim();
    var known = (DB_INDEX[id] || {}).vod_name || '';

    if (DB_PARALLEL && DB_ASYNC && known) {
      var jobs = [
        { url: DB_API + '/movie/' + id + '?platform=web', hdr: null, ms: DB_TIMEOUT },
        { url: DB_API + '/tv/' + id + '?platform=web', hdr: null, ms: DB_TIMEOUT }
      ];
      var agg0 = DB_AGG[known];            // 已有聚合结果就不必再查采集站
      var n = agg0 ? 0 : Math.min(DB_SRC_MAX, DB_SRC.length);
      var i;
      for (i = 0; i < n; i++) {
        jobs.push({
          url: dbSrcUrl(DB_SRC[i], known),
          hdr: { 'User-Agent': DB_UA, 'Accept': 'application/json' },
          ms: DB_SRC_TIMEOUT
        });
      }
      var p = dbFetchAll(jobs);
      if (p) {
        return p.then(function (arr) {
          var dm = null, dt = null;
          try { dm = JSON.parse(arr[0]); } catch (e) { dm = null; }
          try { dt = JSON.parse(arr[1]); } catch (e) { dt = null; }
          /* movie 对电影和剧集都通；综艺类常常只有 tv，所以两个都发，谁有 title 用谁 */
          var d = (dm && dm.title) ? dm : ((dt && dt.title) ? dt : (dm || dt || {}));
          var agg = agg0 || dbAggSave(known, dbAggJoin(arr, known, 2));
          return JSON.stringify({ list: [dbVod(id, d, agg)] });
        });
      }
    }

    /* 同步路径：豆瓣详情先拿，再串行查采集站 */
    var d2 = dbJson(DB_API + '/movie/' + id + '?platform=web');
    if (!d2 || !d2.title) {
      var d3 = dbJson(DB_API + '/tv/' + id + '?platform=web');
      if (d3 && d3.title) d2 = d3;
    }
    if (!d2) d2 = {};
    var memo = DB_INDEX[id] || {};
    var title = d2.title || memo.vod_name || '';
    return JSON.stringify({ list: [dbVod(id, d2, dbAgg(title, false))] });
  },

  /* 搜索：豆瓣 j/subject_suggest
   * 实测（2026-09-30）：这是目前唯一还活着的"关键词搜索"接口。
   * 注意 m.douban.com/rexxar/api/v2/search 已返回 {"msg":"need_login","code":103}，
   * 需要登录态，用不了；所以搜索只能走这一个。返回 1~4 条建议，量不大但准。 */
  search: function (key, quick, pg) {
    key = String(key || '').trim();
    if (!key) return JSON.stringify({ list: [] });
    var arr = [];
    var st = dbFetch(DB_SUGGEST + encodeURIComponent(key));
    if (st) { try { arr = JSON.parse(st) || []; } catch (e) { arr = []; } }
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
