"use strict";
/* =========================================================
   手搖飲帝國 — MVP 原型
   對應 PRD / 資料架構 / UI-UX 三份規格 v1
   決策預設：圖鑑 Prestige 保留 ｜ OFFLINE_CAP=4h ｜ 暫名沿用
   注意：MVP 原型以原生 number 取代 break_infinity（JS 上限 ~1e308，
        對驗證循環綽綽有餘）；正式版依架構文件換 Decimal。
   ========================================================= */

const OFFLINE_CAP_MS = 4 * 3600 * 1000;          // 離線收益 4 小時上限
const PRESTIGE_THRESHOLD = 1e6;                  // 首次可轉型門檻 (lifetime)
const SAVE_KEY = "idle_game_save";
const SAVE_VERSION = 17;

/* ---------- 靜態設定：傳送帶工廠 ---------- */
const PRICE_PER_DRINK = 4;           // 每杯成品售價（再乘各種全域加成）
const GRID_COLS = 24, GRID_ROWS = 20;   // 大地圖（固定，不擴地；視窗只顯示一部分，用「✋移動」平移）
const LEGACY_COLS = 8;                   // 舊版欄數（遷移用）
function gridRows(){ return S.factory ? S.factory.length/GRID_COLS : GRID_ROWS; }
const BELT_SPEED_BASE = 1.6;        // 每秒跨越的格數（基礎，科技可提升）
function beltSpeed(){ return BELT_SPEED_BASE * (1 + 0.25*researchLevel("belt_tech")) * (1 + 0.15*researchLevel("belt_long_tech")); }
const DIRS = {
  right:{dx:1,  dy:0,  arrow:"▶", fastArrow:"⏩"},
  down: {dx:0,  dy:1,  arrow:"▼", fastArrow:"⏬"},
  left: {dx:-1, dy:0,  arrow:"◀", fastArrow:"⏪"},
  up:   {dx:0,  dy:-1, arrow:"▲", fastArrow:"⏫"},
};
const DIR_ORDER = ["right","down","left","up"];

/* 可放置的機台（沿用 generators 存檔結構：S.generators[id] = 已放置數，用於計價）
   kind: source 原料機 / process 加工機 / sink 出貨口 */
const GENERATORS = [
  {id:"tea_farm",      kind:"source",  material:"tea",      name:"茶園",     icon:"🍃", baseCost:15,  emit:1.0, terrain:"grass", power:1},
  {id:"pearl_mill",    kind:"source",  material:"pearl",    name:"粉圓廠",   icon:"⚫", baseCost:20,  emit:1.0, power:1},
  {id:"cup_plant",     kind:"source",  material:"cup",      name:"製杯廠",   icon:"🥤", baseCost:25,  emit:1.0, power:1},
  {id:"greentea_farm", kind:"source",  material:"greentea", name:"綠茶園",   icon:"🍵", baseCost:60,  emit:1.0, terrain:"grass", power:1},
  {id:"dairy",         kind:"source",  material:"milk",     name:"牧場",     icon:"🥛", baseCost:220, emit:1.0, terrain:"grass", power:2},
  {id:"orchard",       kind:"source",  material:"fruit",    name:"果園",     icon:"🍓", baseCost:450, emit:1.0, terrain:"grass", power:2},
  {id:"highland_farm", kind:"source",  material:"premium_tea", name:"高山茶園", icon:"🌟", baseCost:800, emit:0.6, terrain:"grass", power:3, rare:true}, // 只能蓋在稀有高山茶產地
  {id:"brewer",        kind:"refine",  name:"煮茶機",   icon:"🫖", baseCost:180, craft:1.0, recipe:{tea:1},  output:"brewed_tea", power:2}, // 茶葉→茶湯
  {id:"whipper",       kind:"refine",  name:"打發機",   icon:"🍦", baseCost:250, craft:1.0, recipe:{milk:1}, output:"cream",      power:2}, // 鮮奶→奶霜
  {id:"mixer",         kind:"process", name:"調製站",   icon:"🫕", baseCost:150, craft:1.0, power:3},
  {id:"counter",       kind:"sink",    name:"出貨口",   icon:"🧋", baseCost:120, power:2},
  {id:"lab",           kind:"lab",     name:"科技廠",   icon:"🔬", baseCost:300, power:4},  // 吃飲料 → 產研究點
  {id:"order_station", kind:"order",   name:"批發站",   icon:"📦", baseCost:200, power:2},  // 吃飲料 → 推進 B2B 批發訂單
  {id:"warehouse",     kind:"store",   name:"倉儲",     icon:"🏬", baseCost:400, power:2, store:200}, // 囤積飲料，等高點拋售
  {id:"power_plant",   kind:"power",   name:"發電廠",   icon:"⚡", baseCost:500, capacity:25}, // 提供電力容量
];
function warehouseCapacity(){ let s=0; for(const c of S.factory){ if(c&&c.t==="machine"&&GEN_MAP[c.id].kind==="store") s += GEN_MAP[c.id].store*(1+0.5*modLvl(c,"store_cap")); } return s; }
const BASE_POWER = 10;               // 不蓋發電廠也有的基礎電力（讓早期不卡）
function powerDemand(){ let s=0; for(const c of S.factory){ if(c&&c.t==="machine"){ const d=GEN_MAP[c.id]; s+=(d.power||0); } } return s; }
function powerCapacity(){ let s=BASE_POWER; for(const c of S.factory){ if(c&&c.t==="machine"){ const d=GEN_MAP[c.id]; if(d.kind==="power") s += d.capacity*(1+0.30*modLvl(c,"power_boost")); } } return s * powerEngMult(); }
function powerFactor(){ const d=powerDemand(), cap=powerCapacity(); return d<=cap ? 1 : cap/d; }   // 超載 → 全廠降速
/* 地形：採集類機台(茶園/綠茶園/牧場/果園)只能蓋在🌿草地；工廠類蓋空地；水域不能蓋(需整地) */
const TERRAIN = {
  grass: {name:"草地", emoji:"🌿"},
  plain: {name:"空地", emoji:""},
  water: {name:"水域", emoji:"💧"},
};
const TERRAFORM_COST = 150;
const ADV_BELT_COST = {splitter:200, merger:200, bridge:150};
function isAdvConveyorTool(t){ return t==="splitter"||t==="merger"||t==="bridge"; }
function canPlaceOn(terrain, def){
  if(terrain==="water") return false;
  if(def && def.terrain==="grass") return terrain==="grass";   // 採集機需草地
  return true;                                                  // 工廠類：草地/空地皆可
}
function genTerrainCells(n){
  const a=[];
  for(let i=0;i<n;i++){ const r=Math.random(); a.push(r<0.45?"grass":r<0.90?"plain":"water"); }
  return a;
}
/* 資源產地：把對應採集機台蓋在上面 → 產出大增（像 Factorio 礦脈）。只有天然作物有產地 */
const RESOURCE_TYPES = ["tea","greentea","milk","fruit"];
const RESOURCE_BONUS = 2.5;          // 蓋在產地上的採集機產出倍率
// 在地形上灑出成片的資源產地（會把產地格設成草地），回傳 resources 陣列
function genResources(terrain){
  const res = new Array(terrain.length).fill(null);
  for(const mat of RESOURCE_TYPES){
    const patches = 2 + Math.floor(Math.random()*3);               // 每種 2~4 片
    for(let p=0;p<patches;p++){
      let cx=Math.floor(Math.random()*GRID_COLS), cy=Math.floor(Math.random()*GRID_ROWS);
      const cells=[[cx,cy]], size=4+Math.floor(Math.random()*4);   // 4~7 格的小團
      for(let i=0;i<size;i++){
        const [bx,by]=cells[Math.floor(Math.random()*cells.length)];
        const k=Math.floor(Math.random()*4);
        const nx=bx+[1,-1,0,0][k], ny=by+[0,0,1,-1][k];
        if(nx>=0&&ny>=0&&nx<GRID_COLS&&ny<GRID_ROWS) cells.push([nx,ny]);
      }
      for(const [x,y] of cells){ const idx=y*GRID_COLS+x; res[idx]=mat; terrain[idx]="grass"; }
    }
  }
  // 稀有：高山茶 1 片小產地（很少，造成稀缺取捨）
  { let cx=Math.floor(Math.random()*GRID_COLS), cy=Math.floor(Math.random()*GRID_ROWS);
    const cells=[[cx,cy]]; for(let i=0;i<2;i++){ const [bx,by]=cells[Math.floor(Math.random()*cells.length)]; const k=Math.floor(Math.random()*4); const nx=bx+[1,-1,0,0][k], ny=by+[0,0,1,-1][k]; if(nx>=0&&ny>=0&&nx<GRID_COLS&&ny<GRID_ROWS) cells.push([nx,ny]); }
    for(const [x,y] of cells){ const idx=y*GRID_COLS+x; res[idx]="premium_tea"; terrain[idx]="grass"; } }
  return res;
}
// 一次生成 地形 + 資源
function genMap(){ const terrain=genTerrainCells(GRID_COLS*GRID_ROWS); const resources=genResources(terrain); return {terrain, resources}; }
const RP_PER_DRINK = 0.5;            // 每杯飲料進科技廠產出的基礎研究點
const MATERIAL_ICON = {tea:"🍃", pearl:"⚫", cup:"🥤", greentea:"🍵", milk:"🥛", fruit:"🍓", brewed_tea:"🫖", cream:"🍦", premium_tea:"🌟"};
const MATERIAL_NAME = {tea:"茶葉", pearl:"珍珠", cup:"杯材", greentea:"綠茶", milk:"鮮奶", fruit:"水果", brewed_tea:"茶湯", cream:"奶霜", premium_tea:"高山茶"};

/* 飲料配方：每台調製站可選一種；不同配方需不同原料、售價不同
   解鎖綁定地圖展店 → 讓工廠與通路互扣 */
const DRINKS = {
  pearl_milk: {name:"珍珠奶茶", icon:"🧋", recipe:{tea:1, pearl:1, cup:1}, value:1.0, unlock:null},
  green_tea:  {name:"綠茶",     icon:"🍵", recipe:{greentea:1, cup:1},    value:0.8, unlock:{type:"stores", n:3}},
  milk_cap:   {name:"奶蓋茶",   icon:"🧉", recipe:{tea:1, milk:1, cup:1}, value:1.7, unlock:{type:"region", region:"japan"}},
  fruit_tea:  {name:"水果茶",   icon:"🍹", recipe:{tea:1, fruit:1, cup:1},value:2.2, unlock:{type:"region", region:"korea"}},
  // 進階配方：需中間品(茶湯/奶霜)，產線更長、售價更高
  artisan:    {name:"職人珍奶", icon:"🧋", recipe:{brewed_tea:1, pearl:1, cup:1}, value:2.6, unlock:{type:"research", tech:"refine_tech"}},
  cloud_cap:  {name:"雲朵奶蓋", icon:"☁️", recipe:{brewed_tea:1, cream:1, cup:1}, value:3.6, unlock:{type:"research", tech:"refine_tech"}},
  emperor:    {name:"帝王特調", icon:"👑", recipe:{premium_tea:1, cream:1, cup:1}, value:6.5, unlock:{type:"research", tech:"refine_tech"}}, // 需稀有高山茶
};
function drinkUnlocked(id){
  const d = DRINKS[id]; if(!d.unlock) return true;
  if(d.unlock.type==="stores") return Object.keys(S.landmarks).length >= d.unlock.n;
  if(d.unlock.type==="region") return regionUnlockedCount(d.unlock.region) >= 1;
  if(d.unlock.type==="research") return researchLevel(d.unlock.tech) > 0;
  return true;
}
function unlockedDrinks(){ return Object.keys(DRINKS).filter(drinkUnlocked); }
// 某原料是否被任一已解鎖配方用到（決定該原料機是否出現在工具列）
function materialUnlocked(mat){ return unlockedDrinks().some(id=> (DRINKS[id].recipe[mat]||0) > 0); }
function isDrink(mat){ return !!DRINKS[mat]; }

/* 新局 / 轉型後的起始工廠：空地皮，整條產線都要自己蓋 */
function starterFactory(){ return new Array(GRID_COLS*GRID_ROWS).fill(null); }
function starterStations(){ return {}; }
/* 舊版（v6）自動附贈的起始產線佈局——用來判斷玩家是否動過，沒動過才清掉 */
function legacyStarterFactory(){
  const cells = new Array(GRID_COLS*6).fill(null);   // 舊版固定 8×6
  const put = (x,y,c)=>{ cells[y*GRID_COLS+x] = c; };
  put(0,1,{t:"machine", id:"tea_farm"});  put(0,2,{t:"machine", id:"pearl_mill"});
  put(0,3,{t:"machine", id:"cup_plant"}); put(1,1,{t:"belt", dir:"down"});
  put(1,2,{t:"belt", dir:"right"});       put(1,3,{t:"belt", dir:"up"});
  put(2,2,{t:"machine", id:"mixer"});     put(3,2,{t:"belt", dir:"right"});
  put(4,2,{t:"belt", dir:"right"});       put(5,2,{t:"machine", id:"counter"});
  return cells;
}

/* ---------- 靜態設定：區域（世界地圖）---------- */
const REGIONS = [
  {id:"taiwan", name:"台灣篇", flag:"🇹🇼", tagline:"手搖飲的故鄉",     needPrevPct:0},
  {id:"japan",  name:"日本篇", flag:"🇯🇵", tagline:"抹茶與和風珍奶",   needPrevPct:0.6},
  {id:"korea",  name:"韓國篇", flag:"🇰🇷", tagline:"歐巴的手搖潮流",   needPrevPct:0.6},
];

/* ---------- 靜態設定：品牌（套裝，歸屬區域）---------- */
const BRANDS = [
  // 台灣篇
  {id:"fiftydegree", name:"五十度嵐",     setBonus:1.25, color:"#C89B6E", region:"taiwan"},
  {id:"halfsugar",   name:"半糖去冰大帝", setBonus:1.30, color:"#9B8AB8", region:"taiwan"},
  {id:"truedan",     name:"珍煮丹道",     setBonus:1.20, color:"#8BB174", region:"taiwan"},
  {id:"dayungs",     name:"大苑子嵐山",   setBonus:1.35, color:"#E0A03C", region:"taiwan"},
  {id:"cleanfu",     name:"清新福茶",     setBonus:1.20, color:"#5FA86B", region:"taiwan"},
  // 日本篇
  {id:"matcha",      name:"抹茶物語",     setBonus:1.40, color:"#7BA05B", region:"japan"},
  {id:"wafu",        name:"和風五十鈴",   setBonus:1.35, color:"#C97B84", region:"japan"},
  // 韓國篇
  {id:"ktea",        name:"K-Tea 潮飲",   setBonus:1.45, color:"#5B8DA0", region:"korea"},
  {id:"oppa",        name:"歐巴茶研所",   setBonus:1.40, color:"#B05B8E", region:"korea"},
];
const BRAND_MAP = Object.fromEntries(BRANDS.map(b=>[b.id,b]));

/* ---------- 靜態設定：地標（台灣篇 20）---------- */
/* 每間分店各階段提供的「銷售產能」（杯/秒），累加 */
function stages(u){ return [
  {level:1, upgradeCost:0,     sellRate:3,  label:"路邊小攤"},
  {level:2, upgradeCost:u*4,   sellRate:12, label:"店面"},
  {level:3, upgradeCost:u*30,  sellRate:35, label:"旗艦店"},
];}
const LANDMARKS = [
  // 五十度嵐
  {id:"taipei101",  name:"台北101店", brandId:"fiftydegree", emoji:"🏙️", unlockCost:1e6},
  {id:"alishan",    name:"阿里山店",   brandId:"fiftydegree", emoji:"🏔️", unlockCost:4e6},
  {id:"kenting",    name:"墾丁店",     brandId:"fiftydegree", emoji:"🏖️", unlockCost:2e7},
  {id:"sunmoon",    name:"日月潭店",   brandId:"fiftydegree", emoji:"🛶", unlockCost:1e8},
  {id:"taroko",     name:"太魯閣店",   brandId:"fiftydegree", emoji:"⛰️", unlockCost:5e8},
  // 半糖去冰大帝
  {id:"ximen",      name:"西門町店",   brandId:"halfsugar", emoji:"🎬", unlockCost:8e6},
  {id:"jiufen",     name:"九份店",     brandId:"halfsugar", emoji:"🏮", unlockCost:3e7},
  {id:"tamsui",     name:"淡水店",     brandId:"halfsugar", emoji:"🌅", unlockCost:1.5e8},
  {id:"pier2",      name:"高雄駁二店", brandId:"halfsugar", emoji:"🚢", unlockCost:7e8},
  {id:"yehliu",     name:"野柳店",     brandId:"halfsugar", emoji:"🗿", unlockCost:3e9},
  // 珍煮丹道
  {id:"fengjia",    name:"逢甲夜市店", brandId:"truedan", emoji:"🌃", unlockCost:5e7},
  {id:"chihkan",    name:"赤崁樓店",   brandId:"truedan", emoji:"🏯", unlockCost:2.5e8},
  {id:"lukang",     name:"鹿港老街店", brandId:"truedan", emoji:"⛩️", unlockCost:1.2e9},
  // 大苑子嵐山
  {id:"qixingtan",  name:"七星潭店",   brandId:"dayungs", emoji:"🌊", unlockCost:2e8},
  {id:"balloon",    name:"熱氣球店",   brandId:"dayungs", emoji:"🎈", unlockCost:9e8},
  {id:"penghu",     name:"澎湖跨海店", brandId:"dayungs", emoji:"🌉", unlockCost:4e9},
  {id:"lanyu",      name:"蘭嶼店",     brandId:"dayungs", emoji:"🐬", unlockCost:1.8e10},
  // 清新福茶
  {id:"cks",        name:"中正紀念堂店",brandId:"cleanfu", emoji:"🏛️", unlockCost:6e8},
  {id:"longshan",   name:"龍山寺店",   brandId:"cleanfu", emoji:"🛕", unlockCost:3e9},
  {id:"caowo",      name:"草悟道店",   brandId:"cleanfu", emoji:"🌳", unlockCost:1.4e10},

  // ===== 日本篇 =====
  // 抹茶物語
  {id:"tokyotower", name:"東京鐵塔店",   brandId:"matcha", emoji:"🗼", unlockCost:2e10},
  {id:"kiyomizu",   name:"京都清水寺店", brandId:"matcha", emoji:"⛩️", unlockCost:6e10},
  {id:"fuji",       name:"富士山店",     brandId:"matcha", emoji:"🗻", unlockCost:2e11},
  {id:"hakodate",   name:"北海道函館店", brandId:"matcha", emoji:"❄️", unlockCost:6e11},
  // 和風五十鈴
  {id:"shinsaibashi",name:"大阪心齋橋店", brandId:"wafu", emoji:"🎏", unlockCost:4e10},
  {id:"nara",       name:"奈良鹿公園店", brandId:"wafu", emoji:"🦌", unlockCost:1e11},
  {id:"okinawa",    name:"沖繩海灘店",   brandId:"wafu", emoji:"🐠", unlockCost:4e11},
  {id:"nagoya",     name:"名古屋城店",   brandId:"wafu", emoji:"🏯", unlockCost:1e12},

  // ===== 韓國篇 =====
  // K-Tea 潮飲
  {id:"namsan",     name:"首爾N塔店",    brandId:"ktea", emoji:"🌃", unlockCost:2e12},
  {id:"haeundae",   name:"釜山海雲台店", brandId:"ktea", emoji:"🏖️", unlockCost:6e12},
  {id:"jeju",       name:"濟州島店",     brandId:"ktea", emoji:"🍊", unlockCost:2e13},
  // 歐巴茶研所
  {id:"gyeongbok",  name:"景福宮店",     brandId:"oppa", emoji:"🏯", unlockCost:4e12},
  {id:"hongdae",    name:"弘大店",       brandId:"oppa", emoji:"🎤", unlockCost:1e13},
  {id:"namiseom",   name:"南怡島店",     brandId:"oppa", emoji:"🍂", unlockCost:4e13},
];
// 通路角色：開店成本改為可達的指數進程（依全域順序），階段提供銷售產能
LANDMARKS.forEach((l,i)=>{
  l.unlockCost = Math.round(200 * Math.pow(2.7, i));
  l.stages = stages(l.unlockCost);
  l.region = BRAND_MAP[l.brandId].region;
});
const LM_BY_BRAND = {};
BRANDS.forEach(b=> LM_BY_BRAND[b.id] = LANDMARKS.filter(l=>l.brandId===b.id));
const LM_MAP = Object.fromEntries(LANDMARKS.map(l=>[l.id,l]));
const GEN_MAP = Object.fromEntries(GENERATORS.map(g=>[g.id,g]));

/* ---------- 靜態設定：天賦樹（暗黑風，3 大系 × 4 階，高階需該系投點解鎖）----------
   花天賦點 🌟（轉型上市取得）。req = 解鎖該節點需在「同系」累積的點數。 */
const TALENT_TREE = [
  {id:"prod", name:"生產", icon:"🏭", color:"#8BB174", nodes:[
    {id:"prod_speed", tier:1, col:0, name:"加速生產", icon:"⚡", max:10, eff:l=>`全廠機台速度 +${l*10}%`},
    {id:"thrift",     tier:1, col:2, name:"精打細算", icon:"🧮", max:15, eff:l=>`蓋機台成本 −${Math.min(60,l*4)}%`},
    {id:"prod_yield", tier:2, col:0, name:"量產線",   icon:"📦", max:8,  eff:l=>`全廠生產量 +${l*15}%`,        deps:[{id:"prod_speed",lvl:1}]},
    {id:"power_eng",  tier:2, col:2, name:"能源工程", icon:"🔋", max:8,  eff:l=>`發電容量 +${l*15}%`,          deps:[{id:"thrift",lvl:1}]},
    {id:"industry",   tier:3, col:0, name:"工業革命", icon:"🏗️", max:5, excl:"ks_prod", eff:l=>`【規模流】生產與售價 ×${(1+0.2*l).toFixed(1)}`, deps:[{id:"prod_yield",lvl:3},{id:"power_eng",lvl:1}]},
    {id:"automate",   tier:3, col:2, name:"自動精煉", icon:"⚙️", max:5, excl:"ks_prod", eff:l=>`【掛機流】全廠速度 +${l*15}%、離線上限 +${l*2}h`, deps:[{id:"prod_yield",lvl:3},{id:"power_eng",lvl:1}]},
  ]},
  {id:"dist", name:"通路", icon:"🏪", color:"#C89B6E", nodes:[
    {id:"collector",  tier:1, col:0, name:"集郵狂熱", icon:"🗺️", max:10, eff:l=>`分店銷量 +${l*20}%`},
    {id:"output",     tier:1, col:2, name:"黃金店長", icon:"💵", max:20, eff:l=>`全域售價 +${l*10}%`},
    {id:"premium",    tier:2, col:0, name:"精品路線", icon:"💎", max:8,  eff:l=>`飲料售價 +${l*12}%`,          deps:[{id:"collector",lvl:1}]},
    {id:"wholesale",  tier:2, col:2, name:"批發大王", icon:"📦", max:8,  eff:l=>`批發款項 +${l*15}%`,          deps:[{id:"output",lvl:1}]},
    {id:"franchise",  tier:3, col:0, name:"全球連鎖", icon:"🌐", max:5,  excl:"ks_dist", eff:l=>`【鋪量流】銷售產能 ×${(1+0.25*l).toFixed(2)}`, deps:[{id:"premium",lvl:3},{id:"wholesale",lvl:1}]},
    {id:"luxury",     tier:3, col:2, name:"奢華品牌", icon:"💎", max:5,  excl:"ks_dist", eff:l=>`【精品流】飲料售價 +${l*30}%、品質 +${l*10}%`, deps:[{id:"premium",lvl:3},{id:"wholesale",lvl:1}]},
  ]},
  {id:"wealth", name:"財富", icon:"💰", color:"#9B8AB8", nodes:[
    {id:"click",      tier:1, col:0, name:"手速狂人", icon:"👆", max:10, eff:l=>`點擊收益 +${l*50}%`},
    {id:"nightowl",   tier:1, col:2, name:"夜貓經濟", icon:"🌙", max:8,  eff:l=>`離線上限 +${l} 小時`},
    {id:"ipo",        tier:2, col:0, name:"上市鬼才", icon:"💹", max:10, eff:l=>`轉型股票 +${l*15}%`,          deps:[{id:"click",lvl:1}]},
    {id:"merger",     tier:2, col:2, name:"併購高手", icon:"🤝", max:6,  eff:l=>`併購對手成本 −${Math.min(60,l*8)}%`, deps:[{id:"nightowl",lvl:1}]},
    {id:"tycoon",     tier:3, col:0, name:"財閥帝國", icon:"👑", max:5,  excl:"ks_wealth", eff:l=>`【穩健流】永久乘數加成 +${l*10}%`, deps:[{id:"ipo",lvl:3},{id:"merger",lvl:1}]},
    {id:"leverage",   tier:3, col:2, name:"金融槓桿", icon:"🎰", max:5,  excl:"ks_wealth", eff:l=>`【投機流】點擊收益 +${l*120}%、轉型股票 +${l*25}%`, deps:[{id:"ipo",lvl:3},{id:"merger",lvl:1}]},
  ]},
  {id:"ops", name:"經營", icon:"🏪", color:"#5B9A4C", nodes:[
    {id:"clerk_eff",   tier:1, col:0, name:"店員效率", icon:"👔", max:10, eff:l=>`店員產能 +${l*8}%、薪資 −${l*3}%`},
    {id:"marketing",   tier:1, col:2, name:"行銷大師", icon:"📢", max:8,  eff:l=>`廣告成本 −${Math.min(60,l*8)}%、廣告吸引力 +${l*5}%`},
    {id:"brand_asset", tier:2, col:1, name:"品牌資產", icon:"🏅", max:8,  eff:l=>`品質 +${l*8}%、各區品牌力 +${(l*0.05).toFixed(2)}`, deps:[{id:"clerk_eff",lvl:1},{id:"marketing",lvl:1}]},
    {id:"channel_king",tier:3, col:0, name:"通路霸權", icon:"👑", max:5,  excl:"ks_ops", eff:l=>`【市佔流】市場吸引力 ×${(1+0.18*l).toFixed(2)}`, deps:[{id:"brand_asset",lvl:3}]},
    {id:"acquirer",    tier:3, col:2, name:"併購之王", icon:"🤝", max:5,  excl:"ks_ops", eff:l=>`【收購流】併購成本 −${l*12}%、各區品牌力 +${(l*0.1).toFixed(1)}`, deps:[{id:"brand_asset",lvl:3}]},
  ]},
];
// 攤平成節點清單（沿用既有 6 個 id → 舊存檔等級保留）
const TALENTS = TALENT_TREE.flatMap(b=> b.nodes.map(n=>({...n, branch:b.id})));
const TALENT_MAP = Object.fromEntries(TALENTS.map(t=>[t.id,t]));
function talentLevel(id){ return S.talents[id]||0; }
function talentCost(t){ return t.tier * (talentLevel(t.id)+1); }                 // 階數越高越貴
function totalTalentLevels(){ return TALENTS.reduce((s,t)=>s+talentLevel(t.id),0); }
function branchPoints(bid){ return TALENTS.filter(t=>t.branch===bid).reduce((s,t)=>s+talentLevel(t.id),0); }
// 二擇一互斥：同 excl 組只要有別的節點投了點，本節點就鎖死（洗點可重選）
function exclSibling(t){ return t.excl ? TALENTS.find(o=>o.excl===t.excl && o.id!==t.id && talentLevel(o.id)>0) : null; }
function exclLocked(t){ return !!exclSibling(t); }
function talentDepsOk(t){ return !t.deps || t.deps.every(d=> talentLevel(d.id) >= (d.lvl||1)); }
function talentUnlocked(t){ return talentDepsOk(t) && !exclLocked(t); }
function talentReqText(t){ return !t.deps ? "" : t.deps.map(d=>`${TALENT_MAP[d.id].icon}${TALENT_MAP[d.id].name} Lv.${d.lvl||1}`).join("、"); }
// —— 二擇一 keystone 的效果 ——
function automateSpeedMult(){ return 1 + 0.15*talentLevel("automate"); }
function luxuryPriceMult(){ return 1 + 0.30*talentLevel("luxury"); }
function luxuryQualityMult(){ return 1 + 0.10*talentLevel("luxury"); }
function leverageClickAdd(){ return 1.2*talentLevel("leverage"); }
function acquirerCostMult(){ return Math.max(0.3, 1 - 0.12*talentLevel("acquirer")); }
function acquirerBrandAdd(){ return 0.1*talentLevel("acquirer"); }
// 各新天賦效果（給計算函式取用）
function factorySpeedMult(){ return (1 + 0.10*talentLevel("prod_speed")) * automateSpeedMult() * researchSpeedMult() * eventMult("speed") * powerFactor() * pathMult("speed"); }
function productionMult(){ return (1 + 0.15*talentLevel("prod_yield")) * (1 + 0.2*talentLevel("industry")) * researchProdMult() * eventMult("prod") * petProdMult() * pathMult("prod"); }
function talentPriceMult(){ return (1 + 0.10*talentLevel("output")) * (1 + 0.12*talentLevel("premium")) * (1 + 0.2*talentLevel("industry")) * luxuryPriceMult() * researchPriceMult(); }
function talentSellMult(){ return (1 + 0.20*talentLevel("collector")) * (1 + 0.25*talentLevel("franchise")); }
function tycoonMult(){ return 1 + 0.10*talentLevel("tycoon"); }
// —— 經營系 + 舊系新節點 的效果（給各計算函式取用）——
function clerkCapMult(){ return 1 + 0.08*talentLevel("clerk_eff"); }                       // 店員產能
function clerkWageMult(){ return Math.max(0.4, 1 - 0.03*talentLevel("clerk_eff")); }        // 薪資折扣
function adCostMult(){ return Math.max(0.4, 1 - Math.min(0.6, 0.08*talentLevel("marketing"))); }
function adAttractBoost(){ return 1.6 + 0.05*talentLevel("marketing"); }                    // 廣告吸引力倍率（含天賦）
function brandQualityMult(){ return 1 + 0.08*talentLevel("brand_asset"); }                  // 品質
function brandAssetBonus(){ return 0.05*talentLevel("brand_asset"); }                       // 各區品牌力加成
function channelKingMult(){ return 1 + 0.18*talentLevel("channel_king"); }                  // 市場吸引力
function powerEngMult(){ return 1 + 0.15*talentLevel("power_eng"); }                        // 發電容量
function wholesaleMult(){ return 1 + 0.15*talentLevel("wholesale"); }                       // 批發款項
function mergerMult(){ return Math.max(0.4, 1 - Math.min(0.6, 0.08*talentLevel("merger"))); } // 併購成本

/* ---------- 科技研究樹（用工廠生產的「研究點 RP」解鎖）----------
   研究點靠出貨累積 → 像真・自動化工廠：生產推動科技，科技再強化生產 */
const RESEARCH_TREE = [
  {id:"prod", name:"生產科技", icon:"⚙️", color:"#8BB174", nodes:[
    {id:"belt_tech",  tier:1, req:0, name:"傳送帶提速", icon:"💨", max:6, eff:l=>`全廠輸送帶速度 +${l*25}%`},
    {id:"machine_tech",tier:1,req:0, name:"精密機械",   icon:"🔧", max:6, eff:l=>`全廠機台速度 +${l*15}%`},
    {id:"yield_tech", tier:2, req:4, name:"量產科技",   icon:"📦", max:6, eff:l=>`全廠生產量 +${l*20}%`},
    {id:"auto_tech",  tier:3, req:10,name:"全自動產線", icon:"🤖", max:4, eff:l=>`生產 ×${(1+0.3*l).toFixed(1)}`},
  ]},
  {id:"biz", name:"商業科技", icon:"📈", color:"#C89B6E", nodes:[
    {id:"price_tech", tier:1, req:0, name:"品牌研究",   icon:"💵", max:8, eff:l=>`全域售價 +${l*10}%`},
    {id:"logi_tech",  tier:1, req:0, name:"物流中心",   icon:"🚛", max:6, eff:l=>`基礎銷售產能 +${l*10}/秒`},
    {id:"premium_tech",tier:2,req:4, name:"精品工藝",   icon:"💎", max:6, eff:l=>`飲料品質售價 +${l*15}%`},
    {id:"market_tech",tier:3, req:10,name:"全球市場",   icon:"🌐", max:4, eff:l=>`售價與銷量 ×${(1+0.25*l).toFixed(2)}`},
  ]},
  {id:"rnd", name:"研發科技", icon:"🔬", color:"#9B8AB8", nodes:[
    {id:"lab_power",  tier:1, req:0, name:"研究效率",   icon:"📚", max:8, eff:l=>`科技廠 RP 產出 +${l*30}%`},
    {id:"fast_belt",  tier:1, req:0, name:"高速帶藍圖", icon:"⏩", max:1, eff:l=>l?`已解鎖：可蓋 ⏩高速帶（item ×2 速）`:`🔓 解鎖「高速帶」建造工具`},
    {id:"refine_tech",tier:2, req:3, name:"精製工藝",   icon:"🫖", max:1, eff:l=>l?`已解鎖：🫖煮茶機/🍦打發機 + 職人珍奶/雲朵奶蓋`:`🔓 解鎖中間品與進階配方`},
    {id:"double_lab", tier:2, req:3, name:"並行運算",   icon:"🧠", max:6, eff:l=>`研究點再 +${l*25}%`},
    {id:"singularity",tier:3, req:9, name:"科技奇點",   icon:"🌌", max:3, eff:l=>`研究點 ×${(1+0.5*l).toFixed(1)}`},
  ]},
  {id:"logi", name:"物流科技", icon:"🚚", color:"#5B8DA0", nodes:[
    {id:"splitter_tech", tier:1, req:0, name:"分流系統", icon:"🔀", max:1, eff:l=>l?`已解鎖：🔀分流器 / 🔃合流器`:`🔓 解鎖分流器 / 合流器`},
    {id:"bridge_tech",   tier:1, req:0, name:"立體運輸", icon:"✚", max:1, eff:l=>l?`已解鎖：✚橋接（帶子交叉不混料）`:`🔓 解鎖橋接`},
    {id:"belt_long_tech",tier:2, req:2, name:"幹線物流", icon:"🛣️", max:5, eff:l=>`全廠輸送帶速度再 +${l*15}%`},
    {id:"auto_route",    tier:3, req:8, name:"智慧調度", icon:"🛰️", max:3, eff:l=>`全廠生產量 +${l*15}%`},
  ]},
];
const RESEARCH = RESEARCH_TREE.flatMap(b=> b.nodes.map(n=>({...n, branch:b.id})));
const RESEARCH_MAP = Object.fromEntries(RESEARCH.map(t=>[t.id,t]));
function researchLevel(id){ return (S.research&&S.research[id])||0; }
function researchCost(t){ return Math.round(40 * t.tier * Math.pow(1.8, researchLevel(t.id))); }
function researchBranchPoints(bid){ return RESEARCH.filter(t=>t.branch===bid).reduce((s,t)=>s+researchLevel(t.id),0); }
function researchUnlocked(t){ return researchBranchPoints(t.branch) >= (t.req||0); }
// 研究效果
function researchSpeedMult(){ return 1 + 0.15*researchLevel("machine_tech"); }
function researchProdMult(){ return (1 + 0.20*researchLevel("yield_tech")) * (1 + 0.3*researchLevel("auto_tech")) * (1 + 0.15*researchLevel("auto_route")); }
function researchPriceMult(){ return (1 + 0.10*researchLevel("price_tech")) * (1 + 0.15*researchLevel("premium_tech")) * (1 + 0.25*researchLevel("market_tech")); }
function researchSellMult(){ return 1 + 0.25*researchLevel("market_tech"); }
function researchLogi(){ return 10*researchLevel("logi_tech"); }
// 研究點：全域倍率（研發系科技）
function rpMult(){ return (1 + 0.30*researchLevel("lab_power")) * (1 + 0.25*researchLevel("double_lab")) * (1 + 0.5*researchLevel("singularity")) * pathMult("rp"); }
function fastBeltUnlocked(){ return researchLevel("fast_belt") > 0; }
function splitterUnlocked(){ return researchLevel("splitter_tech") > 0; }
function bridgeUnlocked(){ return researchLevel("bridge_tech") > 0; }
let rpPerSec = 0;                         // 最近研究點產出速率（顯示用）
function rpRate(){ return rpPerSec; }

/* ---------- 寵物系統（第二養成軸：被動加成 + 情感陪伴）---------- */
const PETS = {
  cat:   {name:"招財貓", emoji:"🐱", bonus:"sale",    per:0.03, adopt:3000,   desc:l=>`全域售價 +${(l*3)}%`},
  frog:  {name:"珍珠蛙", emoji:"🐸", bonus:"prod",    per:0.03, adopt:8000,   desc:l=>`全廠生產量 +${(l*3)}%`},
  dog:   {name:"看店犬", emoji:"🐶", bonus:"click",   per:0.20, adopt:15000,  desc:l=>`點擊收益 +${(l*20)}%`},
  bunny: {name:"兔財神", emoji:"🐰", bonus:"offline", per:0.5,  adopt:40000,  desc:l=>`離線上限 +${(l*0.5)} 小時`},
};
const PET_HAPPY_MS = 2*3600*1000;        // 約 2 小時快樂度歸零
function petOwned(id){ return S.pet && S.pet.owned && S.pet.owned[id]; }
function petLevel(id){ return petOwned(id) ? S.pet.owned[id].lvl : 0; }
function petXpNeed(lvl){ return 5 + lvl*3; }
function petFeedCost(lvl){ return Math.round(200 * Math.pow(1.5, lvl)); }
function petHappy(){ if(!S.pet) return 0; return Math.max(0, Math.round(100 - (Date.now()-(S.pet.lastFed||0))/PET_HAPPY_MS*100)); }
function petHappyFactor(){ return 0.5 + 0.5*(petHappy()/100); }     // 50%~100% 效力
function activePet(){ return (S.pet && S.pet.active && petOwned(S.pet.active)) ? S.pet.active : null; }
function petBonus(type){                                            // 只有「使用中且 bonus 對應」才生效
  const a = activePet(); if(!a) return type==="offline"?0:1;
  const def = PETS[a]; if(def.bonus!==type) return type==="offline"?0:1;
  const amt = def.per * petLevel(a) * petHappyFactor();
  return type==="offline" ? amt : 1+amt;
}
function petSaleMult(){ return petBonus("sale"); }
function petProdMult(){ return petBonus("prod"); }
function petClickMult(){ return petBonus("click"); }
function petOfflineHours(){ return petBonus("offline"); }

/* ---------- 互斥企業路線（首次轉型後解鎖；三選一，各有代價）---------- */
const PATHS = {
  mass:    {name:"量產路線", icon:"🏭", color:"#8BB174", desc:["全廠生產量 ×1.5","機台速度 ×1.3","但每杯售價 ×0.7（薄利多銷）"], mult:{prod:1.5, speed:1.3, price:0.7}},
  premium: {name:"精品路線", icon:"💎", color:"#9B8AB8", desc:["全域售價 ×1.8","但全廠生產量 ×0.6（慢工出細活）"], mult:{price:1.8, prod:0.6}},
  auto:    {name:"自動化路線", icon:"🤖", color:"#5B8DA0", desc:["研究點 ×1.5","銷售產能 ×1.3","離線上限 +4 小時","但點擊收益 ×0.3"], mult:{rp:1.5, sell:1.3, offlineH:4, click:0.3}},
};
function pathUnlocked(){ return (S.prestige?.count||0) >= 1; }
function activePath(){ return (S.path && PATHS[S.path]) ? S.path : null; }
function pathMult(key, def){ def=def===undefined?1:def; const p=activePath(); return p && PATHS[p].mult[key]!==undefined ? PATHS[p].mult[key] : def; }
function pathOfflineHours(){ const p=activePath(); return p ? (PATHS[p].mult.offlineH||0) : 0; }

/* ---------- 區域（地圖）輔助 ---------- */
function regionLandmarks(rid){ return LANDMARKS.filter(l=>l.region===rid); }
function regionBrands(rid){ return BRANDS.filter(b=>b.region===rid); }
function regionUnlockedCount(rid){ return regionLandmarks(rid).filter(l=>(S.landmarks[l.id]||0)>=1).length; }
function regionPct(rid){ const t=regionLandmarks(rid).length; return t? regionUnlockedCount(rid)/t : 0; }
function regionIndex(rid){ return REGIONS.findIndex(r=>r.id===rid); }
function regionUnlocked(rid){
  const i = regionIndex(rid);
  if(i<=0) return true;                                  // 台灣篇永遠開放
  const prev = REGIONS[i-1];
  return regionPct(prev.id) >= REGIONS[i].needPrevPct;
}
function codexPctAll(){ const u=Object.keys(S.landmarks).length; return LANDMARKS.length? u/LANDMARKS.length : 0; }

/* ---------- 靜態設定：成就（達成發放招牌聲望 🏅）---------- */
function factoryMachineCount(){ return S.factory.filter(c=>c&&c.t==="machine").length; }
function factoryBeltCount(){ return S.factory.filter(c=>c&&c.t==="belt").length; }
const FULL_LINE_IDS = ["tea_farm","pearl_mill","cup_plant","mixer","counter"];
const ACHIEVEMENTS = [
  // —— 起步 ——
  {id:"first_drink",  icon:"🥤", name:"第一杯",   desc:"賣出第一杯飲料",          ap:1, check:()=>S.lifetimeResource>0},
  {id:"build_first",  icon:"🔧", name:"動工！",   desc:"蓋出第一台機台",          ap:1, check:()=>S.factory.some(c=>c&&c.t==="machine")},
  {id:"full_line",    icon:"🏭", name:"一條龍",   desc:"集齊一整條完整產線",      ap:2, check:()=>FULL_LINE_IDS.every(id=>(S.generators[id]||0)>=1)},
  {id:"clerk10",      icon:"🍃", name:"茶園主",   desc:"放置 10 座茶園",          ap:1, check:()=>(S.generators.tea_farm||0)>=10},
  {id:"belt20",       icon:"⏩", name:"輸送達人", desc:"鋪設 20 段輸送帶",        ap:2, check:()=>factoryBeltCount()>=20},
  {id:"first_store",  icon:"🏪", name:"開張大吉", desc:"開出第一間分店",          ap:1, check:()=>Object.keys(S.landmarks).length>=1},
  {id:"first_set",    icon:"🎀", name:"套裝控",   desc:"集滿第一組品牌套裝",      ap:2, check:()=>BRANDS.some(b=>brandComplete(b))},
  // —— 中期 ——
  {id:"machines20",   icon:"⚙️", name:"產線擴張", desc:"放置 20 台機台",          ap:3, check:()=>factoryMachineCount()>=20},
  {id:"prod10",       icon:"📦", name:"量產起步", desc:"生產速率突破 10 杯/秒",   ap:2, check:()=>(factoryRate||0)>=10},
  {id:"cap50",        icon:"🛒", name:"通路鋪開", desc:"銷售產能達 50 杯/秒",     ap:2, check:()=>storeSellCapacity()>=50},
  {id:"balanced",     icon:"⚖️", name:"產銷平衡", desc:"生產≥20 且與銷售產能誤差<10%", ap:4, check:()=>(factoryRate||0)>=20 && Math.abs((factoryRate||0)-storeSellCapacity())<=(factoryRate||0)*0.1},
  {id:"flagship",     icon:"🏆", name:"旗艦帝國", desc:"將任一分店升到旗艦店",    ap:2, check:()=>Object.values(S.landmarks).some(l=>l>=3)},
  {id:"first_ipo",    icon:"💹", name:"上市公司", desc:"首次轉型上市",            ap:2, check:()=>S.prestige.count>=1},
  {id:"talent10",     icon:"🌟", name:"天賦異稟", desc:"累計升級天賦 10 級",      ap:2, check:()=>totalTalentLevels()>=10},
  {id:"store10",      icon:"🏬", name:"連鎖品牌", desc:"開出 10 間分店",          ap:3, check:()=>Object.keys(S.landmarks).length>=10},
  {id:"abroad",       icon:"✈️", name:"進軍海外", desc:"在台灣以外開第一間店",    ap:3, check:()=>LANDMARKS.some(l=>l.region!=="taiwan"&&S.landmarks[l.id])},
  {id:"codex_half",   icon:"🗺️", name:"環遊半界", desc:"圖鑑完成度達 50%",        ap:3, check:()=>codexPctAll()>=0.5},
  // —— 後期 ——
  {id:"prod100",      icon:"🚀", name:"工業巨擘", desc:"生產速率突破 100 杯/秒",  ap:4, check:()=>(factoryRate||0)>=100},
  {id:"cap200",       icon:"🌐", name:"通路霸主", desc:"銷售產能達 200 杯/秒",    ap:3, check:()=>storeSellCapacity()>=200},
  {id:"ops_1m",       icon:"💰", name:"日進斗金", desc:"每秒收入突破 $1M",        ap:3, check:()=>opsPerSec()>=1e6},
  {id:"rich1b",       icon:"🤑", name:"十億帝國", desc:"累積總收入達 $1B",        ap:4, check:()=>S.lifetimeResource>=1e9},
  {id:"talent_max",   icon:"✨", name:"登峰造極", desc:"把任一天賦點到滿級",      ap:3, check:()=>TALENTS.some(t=>t.max&&talentLevel(t.id)>=t.max)},
  {id:"prestige5",    icon:"📈", name:"連續上市", desc:"轉型上市 5 次",           ap:5, check:()=>S.prestige.count>=5},
  {id:"all_taiwan",   icon:"🇹🇼", name:"稱霸台灣", desc:"解鎖所有台灣分店",        ap:5, check:()=>regionUnlockedCount("taiwan")===regionLandmarks("taiwan").length},
  {id:"all_japan",    icon:"🇯🇵", name:"征服日本", desc:"解鎖所有日本分店",        ap:6, check:()=>regionUnlockedCount("japan")===regionLandmarks("japan").length},
  {id:"all_korea",    icon:"🇰🇷", name:"征服韓國", desc:"解鎖所有韓國分店",        ap:6, check:()=>regionUnlockedCount("korea")===regionLandmarks("korea").length},
  // —— 零售經營 ——
  {id:"hire1",        icon:"👔", name:"我的員工",   desc:"雇用第一名店員",          ap:1, check:()=>retailClerks()>=1},
  {id:"hire5",        icon:"👥", name:"開枝散葉",   desc:"同時雇用 5 名店員",        ap:2, check:()=>retailClerks()>=5},
  {id:"hire10",       icon:"🧑‍🤝‍🧑", name:"人力帝國", desc:"同時雇用 10 名店員",      ap:3, check:()=>retailClerks()>=10},
  {id:"stockfull",    icon:"📦", name:"庫存滿載",   desc:"中央倉囤到上限",          ap:2, check:()=>(S.retail?.stock||0)>=retailStockCap()*0.98},
  {id:"retail10k",    icon:"💰", name:"零售金流",   desc:"零售淨利達 $10K/秒",      ap:3, check:()=>opsPerSec()>=10000},
  // —— 市場戰 ——
  {id:"lead50",       icon:"📊", name:"市場領導",   desc:"任一區市佔突破 50%",      ap:3, check:()=>unlockedSellRegions().some(r=>marketShare(r)>=0.5)},
  {id:"firstacq",     icon:"🤝", name:"第一筆併購", desc:"併購第一家對手",          ap:3, check:()=>(S.statAcquired||0)>=1},
  {id:"acq3",         icon:"🏢", name:"併購狂",     desc:"累計併購 3 家對手",        ap:4, check:()=>(S.statAcquired||0)>=3},
  {id:"monopoly",     icon:"👑", name:"獨霸一方",   desc:"在任一已開的區壟斷市場（對手全退）", ap:5, check:()=>unlockedSellRegions().some(r=>competitorsFor(r).length===0)},
  {id:"firstad",      icon:"📢", name:"打廣告",     desc:"投放第一次廣告",          ap:1, check:()=>(S.statAds||0)>=1},
  // —— 定價 & 品質投資 ——
  {id:"globalsell",   icon:"🌐", name:"三區同賣",   desc:"同時在台日韓三區銷售",    ap:3, check:()=>unlockedSellRegions().length>=3},
  {id:"premiumprice", icon:"💎", name:"精品定位",   desc:"把任一區定價拉到精品級（×1.3+）", ap:2, check:()=>Object.keys(MARKETS).some(r=>priceLevel(r)>=1.3)},
  {id:"q2x",          icon:"⭐", name:"品質至上",   desc:"品質投資加成達 ×2",       ap:3, check:()=>qualityInvestMult()>=2},
  {id:"qmax1",        icon:"🧪", name:"品質職人",   desc:"把任一品質投資線點到 Lv.10", ap:3, check:()=>QUALITY_INVEST.some(q=>qualityLevel(q.id)>=10)},
  // —— B2B 批發 ——
  {id:"order1",       icon:"📦", name:"第一張批發單", desc:"完成第一張 B2B 批發單",  ap:1, check:()=>(S.ordersCompleted||0)>=1},
  {id:"order10",      icon:"🚚", name:"批發通路",   desc:"完成 10 張批發單",        ap:3, check:()=>(S.ordersCompleted||0)>=10},
  {id:"order50",      icon:"🏭", name:"通路大盤",   desc:"完成 50 張批發單",        ap:5, check:()=>(S.ordersCompleted||0)>=50},
  {id:"order_full",   icon:"⚡", name:"通殺三單",   desc:"三張批發單同時完成待領",  ap:4, check:()=>claimableOrders()>=ORDER_SLOTS},
  // —— 工廠進階 ——
  {id:"power1",       icon:"⚡", name:"自主供電",   desc:"蓋出第一座發電廠",        ap:2, check:()=>S.factory.some(c=>c&&c.t==="machine"&&GEN_MAP[c.id].kind==="power")},
  {id:"nopower",      icon:"🔌", name:"供電無虞",   desc:"需求≥30 仍不超載運轉",     ap:3, check:()=>powerDemand()>=30 && powerFactor()>=1},
  {id:"allrecipe",   icon:"🍹", name:"配方全解",   desc:"解鎖所有飲料配方",        ap:4, check:()=>unlockedDrinks().length>=Object.keys(DRINKS).length},
  {id:"tech5",        icon:"🔬", name:"科技狂人",   desc:"研究 5 項科技",            ap:3, check:()=>Object.values(S.research||{}).filter(v=>v>0).length>=5},
  {id:"talent20",     icon:"🌠", name:"天賦滿溢",   desc:"累計升級天賦 20 級",      ap:3, check:()=>totalTalentLevels()>=20},
  {id:"world_tour",   icon:"🌏", name:"環球帝國", desc:"圖鑑 100% 全收集",        ap:10, check:()=>codexPctAll()>=1},
];
const ACH_MAP = Object.fromEntries(ACHIEVEMENTS.map(a=>[a.id,a]));

/* ---------- 存檔狀態 ---------- */
// 每區的 AI 連鎖店：price(定價0.6~1.6)、quality(品質)、size(規模/聲量)、style(風格)
const COMPETITOR_TEMPLATES = {
  taiwan: [
    {id:"happy",  name:"幸福茶",  emoji:"🧋", price:0.85, quality:0.9,  size:0.85, style:"低價走量"},
    {id:"chacha", name:"喫茶趣",  emoji:"🍵", price:1.15, quality:1.25, size:0.60, style:"精品路線"},
  ],
  japan: [
    {id:"sakura", name:"櫻花堂",  emoji:"🌸", price:1.20, quality:1.45, size:0.80, style:"高端精品"},
    {id:"oishi",  name:"美味茶屋", emoji:"🏯", price:1.00, quality:1.05, size:0.70, style:"均衡"},
  ],
  korea: [
    {id:"seoul",  name:"首爾鮮茶", emoji:"🥤", price:0.95, quality:1.20, size:0.85, style:"網紅打卡"},
    {id:"kpop",   name:"星茶KPOP", emoji:"⭐", price:1.30, quality:1.50, size:0.70, style:"高端精品"},
  ],
};
function initCompetitors(){ return JSON.parse(JSON.stringify(COMPETITOR_TEMPLATES)); }
function newSave(){
  const __map = genMap();
  return {
    version: SAVE_VERSION,
    resource: 0,
    lifetimeResource: 0,
    generators: starterStations(),       // 各機台已放置數（計價用）
    factory: starterFactory(),           // 工廠地皮格子（已放置的機台/輸送帶佈局）
    terrain: __map.terrain,              // 地形圖層（草地/空地/水域）
    resources: __map.resources,          // 資源產地圖層（隨機礦脈）
    factoryRate: 0,                      // 最近出貨速率（杯/秒，離線估算用）
    factoryAvgValue: 1,                  // 最近出貨飲料平均配方價值（離線估算用）
    orders: [],                          // 進行中的訂單
    ordersCompleted: 0,                  // 已完成訂單數（決定難度與獎勵）
    nextOrderId: 1,
    event: null,                         // 進行中的隨機事件 {id, endsAt}
    nextEventAt: 0,                      // 下次事件觸發時間
    pendingDecision: null,               // 待玩家選擇的決策事件 id
    nextDecisionAt: 0,                   // 下次決策事件時間
    rp: 0,                               // 研究點（工廠生產累積）
    research: {},                        // {techId: level} 已研究科技
    landmarks: {},                       // {id: level}
    talents: {},                         // {talentId: level}
    talentPoints: 0,                     // 天賦點（轉型時依股票數獲得）
    achievements: {},                    // {achId: true} 已達成
    achievementPoints: 0,                // 招牌聲望 🏅（成就獎勵，永久全域產量加成）
    prestige: { count:0, multiplier:1 },
    pet: { active:null, owned:{}, lastFed:0 },   // 寵物：已領養/使用中/上次餵食
    warehouse: { count:0, value:0 },             // 倉儲囤積：杯數 + 累計配方價值
    retail: { stock:0, value:0, clerks:0 },      // 零售中央倉 + 店員
    retailRate: 0,                               // 零售收入速率（離線估算）
    pricing: { taiwan:1.0, japan:1.0, korea:1.0 }, // 各區定價策略（0.6~1.6）
    competitors: initCompetitors(),              // 各區 AI 競爭對手（市場佔有率競爭）
    ads: {},                                     // 各區廣告到期時間
    brandPower: { taiwan:1, japan:1, korea:1 },  // 各區品牌力（併購對手吸收 → 永久吸引力）
    quality: { ingredient:0, training:0, brand:0, rnd:0 },  // 品質投資線等級（獨立於配方均價）
    tutorial: { step:0, done:false, granted:false },  // 新手互動教學進度
    sellMarket: "taiwan",                        // （保留，現已賣到所有開的區）
    path: null,                                  // 互斥企業路線（mass/premium/auto）
    playTime: 0,                         // 累計遊玩秒數
    totalClicks: 0,                      // 累計點擊次數
    startedAt: Date.now(),               // 帝國建立時間
    lastSaved: Date.now(),
    settings: { soundOn:true, darkMode:false },
  };
}
let S = newSave();

/* ---------- 衍生計算 ---------- */
// 蓋機台＝固定價（不再隨數量上升）；天賦「精打細算」仍打折
function genCost(g){
  const discount = 1 - Math.min(0.60, 0.04*talentLevel("thrift"));
  return g.baseCost * discount;
}
/* 機台升級模塊：每台可獨立升級多個模塊（存在 cell.mods = {模塊id: 等級}）*/
const MODULES = {
  speed:   {icon:"⚡", name:"加速器",   kinds:["source","process","refine"], base:1.2, eff:l=>`產出速度 ×${(1+0.5*l).toFixed(1)}`},
  yield:   {icon:"📦", name:"增產模組", kinds:["source","process","refine"], base:1.7, eff:l=>`每次多產 +${l} 件`},
  quality: {icon:"💎", name:"品質模組", kinds:["source","process","sink"], base:2.4, eff:l=>`全廠售價 +${l*10}%`},
  logistics:{icon:"🚛", name:"物流模組", kinds:["sink"], base:2.0, eff:l=>`基礎銷售產能 +${l*3}/秒`},
  lab_eff:  {icon:"🔬", name:"研究效率", kinds:["lab"], base:1.8, eff:l=>`此科技廠 RP +${l*30}%`},
  power_boost:{icon:"⚡", name:"超頻發電", kinds:["power"], base:1.6, eff:l=>`此發電廠容量 +${l*30}%`},
  store_cap: {icon:"🏬", name:"擴充倉容", kinds:["store"], base:1.6, eff:l=>`此倉儲容量 +${l*50}%`},
};
function modLvl(cell, m){ return (cell.mods&&cell.mods[m])||0; }
function speedMult(cell){ return 1 + 0.5*modLvl(cell,"speed"); }
function yieldQty(cell){ return 1 + modLvl(cell,"yield"); }
function modulesFor(kind){ return Object.keys(MODULES).filter(id=>MODULES[id].kinds.includes(kind)).map(id=>({id,...MODULES[id]})); }
function moduleCost(def, mod, lvl){ return Math.round(def.baseCost * mod.base * Math.pow(1.7, lvl)); }
// 跨全廠統計：品質總等級（→售價）、物流總等級（→銷售產能）
function totalModule(m){ let s=0; for(const c of S.factory){ if(c&&c.t==="machine") s+=modLvl(c,m); } return s; }
function qualityBonus(){ return 1 + 0.10*totalModule("quality"); }
function genUnlocked(g){
  if(!g.unlock) return true;
  if(g.unlock.type==="generatorOwned") return (S.generators[g.unlock.targetId]||0) >= g.unlock.amount;
  if(g.unlock.type==="resource") return S.resource >= g.unlock.amount;
  return true;
}
function brandComplete(b){
  const lms = LM_BY_BRAND[b.id];
  return lms.every(l=> (S.landmarks[l.id]||0) >= 1);
}
// 通路：分店總銷售產能（杯/秒）＝ 自家小攤基礎 + 各分店各階段 sellRate，再乘集郵天賦
const BASELINE_SELL = 5;     // 沒有分店時，自家小攤也有的基礎顧客需求
// 某區「原始」顧客需求（分店銷售產能；台灣含自家小攤基礎與全域物流加成）
function regionDemand(r){
  let d = (r==="taiwan") ? (BASELINE_SELL + 3*totalModule("logistics") + researchLogi()) : 0;
  for(const id in S.landmarks){ const lm=LM_MAP[id]; if(lm.region!==r) continue; const lvl=S.landmarks[id]; for(const st of lm.stages){ if(st.level<=lvl) d+=st.sellRate; } }
  return d * talentSellMult() * researchSellMult() * eventMult("sell") * pathMult("sell");
}
// 實際需求 = 該區市場規模 × 你的市佔率（定價/品質/廣告 vs 競爭對手決定市佔）
function regionEffDemand(r){ return regionDemand(r) * marketShare(r); }
function unlockedSellRegions(){ return Object.keys(MARKETS).filter(regionUnlockedForSell); }
function totalEffDemand(){ return unlockedSellRegions().reduce((s,r)=>s+regionEffDemand(r),0); }
function retailDemand(){ return totalEffDemand(); }   // 聚合顧客需求（含定價彈性）
const storeSellCapacity = retailDemand;       // 舊名相容（成就等）
// 零售：店員（掛機自動上架賣）、中央倉
const CLERK_RATE = 3;                          // 每位店員（含你自己）每秒可賣杯數
function retailClerks(){ return (S.retail?.clerks)||0; }
function clerkCap(){ return (1 + retailClerks()) * CLERK_RATE * clerkCapMult(); }   // 你=1 基礎
function clerkCost(){ return Math.round(500 * Math.pow(1.8, retailClerks())); }
function retailStockCap(){ return Math.round(300 + 120*retailClerks()); }
const WAGE_CUPS = 1.1;                          // 每名店員每秒薪資 ≈ 1.1 杯的銷售額（閒置也要付）
function cupRevenue(){                           // 目前每杯實際售價（含庫存均價/全域/各區行情）
  const r=S.retail; const av=(r && r.stock>0) ? r.value/r.stock : (factoryAvgValue||1);
  return av * priceMult();
}
function clerkWage(){ return retailClerks() * WAGE_CUPS * cupRevenue() * clerkWageMult(); }   // 總薪資/秒（你=基礎店員免薪）
// 零售健康燈：缺貨 / 爆滿 / 店員閒置(薪資空燒) / 正常
function retailStatus(){
  const r=S.retail||{stock:0,clerks:0}, scap=retailStockCap();
  const demand=retailDemand(), cap=clerkCap(), pct=scap>0?r.stock/scap:0;
  if(pct>=0.98) return {lvl:"red", icon:"🔴", msg:"中央倉爆滿 → 出貨口回壓、工廠被卡，快雇店員/開分店把貨賣掉"};
  if(r.stock<scap*0.05 && cap>0) return {lvl:"red", icon:"🔴", msg:"中央倉缺貨 → 店員空等領乾薪，回工廠衝高生產量"};
  if(retailClerks()>0 && cap>demand*1.25) return {lvl:"yellow", icon:"🟡", msg:"店員過剩 → 需求吃不滿，薪資空燒，去 🗺️地圖 多開分店提升需求"};
  if(cap<demand*0.95) return {lvl:"yellow", icon:"🟡", msg:"店員不夠賣 → 多雇店員把需求吃滿"};
  return {lvl:"green", icon:"🟢", msg:"營運健康 → 供需與人力平衡，獲利穩定"};
}
function setBonusProduct(){
  let p = 1;
  for(const b of BRANDS){ if(brandComplete(b)) p *= b.setBonus; }   // 集滿品牌 → 售價加成
  return p;
}
function reputationBonus(){ return 1 + 0.03*(S.achievementPoints||0); }   // 招牌聲望：每點 +3%
// 市場行情：隨時間平滑波動（約 [0.5, 1.5]），影響所有售價
const MKT_P1 = 95000, MKT_P2 = 41000;
// 各區市場：基礎溢價 + 物流成本 + 不同相位（行情錯開波動）
const MARKETS = {
  taiwan: {name:"台灣", flag:"🇹🇼", base:1.0,  logi:0.0,  phase:0},
  japan:  {name:"日本", flag:"🇯🇵", base:1.18, logi:0.10, phase:2.1},
  korea:  {name:"韓國", flag:"🇰🇷", base:1.34, logi:0.18, phase:4.0},
};
function marketPrice(region, t){ t=t||Date.now(); const m=MARKETS[region]||MARKETS.taiwan; return 1 + 0.35*Math.sin(t/MKT_P1 + m.phase) + 0.15*Math.sin(t/MKT_P2 + m.phase*1.3); }
function regionUnlockedForSell(r){ return r==="taiwan" || regionUnlockedCount(r)>0; }
function sellMarket(){ return (S.sellMarket && MARKETS[S.sellMarket] && regionUnlockedForSell(S.sellMarket)) ? S.sellMarket : "taiwan"; }
function regionSellMult(region){ const m=MARKETS[region]||MARKETS.taiwan; return m.base * marketPrice(region) * (1-m.logi); }
function marketTrend(region){ return marketPrice(region) >= marketPrice(region, Date.now()-3000) ? "📈" : "📉"; }
// 各區定價（玩家設定，0.6~1.6）；售價因子 = 行情×溢價×物流×定價
function priceLevel(r){ const p=(S.pricing&&S.pricing[r]); return (p===undefined?1.0:p); }
function regionFactor(r){ const m=MARKETS[r]||MARKETS.taiwan; return m.base * marketPrice(r) * (1-m.logi) * priceLevel(r); }
// 各區依「實際需求」加權的平均售價因子（零售收入用）
function avgRegionFactor(){
  const rs=unlockedSellRegions(); let tot=0,wf=0;
  for(const r of rs){ const e=regionEffDemand(r); tot+=e; wf+=e*regionFactor(r); }
  return tot>0 ? wf/tot : regionFactor("taiwan");
}
/* ===================== 競爭對手 & 市場佔有率 ===================== */
const OUTSIDE_OPTION = 0.40;   // 「不買」外部選項：你定價越高，越多客人乾脆不買（自然彈性）
const AD_BOOST = 1.6;          // 廣告期間吸引力倍率
const AD_DURATION = 120000;    // 廣告持續 2 分鐘
function competitorsFor(r){ return (S.competitors && S.competitors[r]) || []; }
function priceAttract(pl){ return Math.max(0.2, 2.0 - pl); }                       // 定價越低越吸引客
// 品質投資線（獨立於配方均價，用錢/研究點直接買品質）
const QUALITY_INVEST = [
  {id:"ingredient", name:"頂級原料",   emoji:"🌱", per:0.08, baseCost:2000, growth:1.55, cur:"money", desc:"嚴選茶葉鮮乳"},
  {id:"training",   name:"職人培訓",   emoji:"🎓", per:0.07, baseCost:3000, growth:1.60, cur:"money", desc:"店員調飲技術"},
  {id:"brand",      name:"品牌形象",   emoji:"🏅", per:0.06, baseCost:5000, growth:1.65, cur:"money", desc:"包裝與形象設計"},
  {id:"rnd",        name:"研發實驗室", emoji:"🧪", per:0.10, baseCost:30,   growth:1.50, cur:"rp",    desc:"獨家配方研發（需研究點）"},
];
const QI_MAP = Object.fromEntries(QUALITY_INVEST.map(q=>[q.id,q]));
function qualityLevel(id){ return (S.quality && S.quality[id]) || 0; }
function qualityInvestMult(){ let m=1; for(const q of QUALITY_INVEST) m += q.per * qualityLevel(q.id); return m; }
function qualityInvestCost(q){ return Math.round(q.baseCost * Math.pow(q.growth, qualityLevel(q.id))); }
// 品質 = 配方均價底(封頂2.8) × 品質加成 × 品質投資線（投資線不封頂，靠遞增成本自限）
function playerQuality(){ return Math.max(0.8, Math.min(2.8, 0.6 + (factoryAvgValue||1)*0.4)) * Math.min(1.4, qualityBonus()) * qualityInvestMult() * brandQualityMult() * luxuryQualityMult(); }
function adActive(r){ return ((S.ads && S.ads[r])||0) > Date.now(); }
function adFactor(r){ return adActive(r) ? adAttractBoost() : 1; }
function brandPower(r){ return ((S.brandPower && S.brandPower[r]) || 1) + brandAssetBonus() + acquirerBrandAdd(); }   // 併購吸收 + 品牌資產 + 併購之王
function playerAttract(r){ return priceAttract(priceLevel(r)) * playerQuality() * adFactor(r) * brandPower(r) * channelKingMult(); }
function compAttractTotal(r){ return competitorsFor(r).reduce((s,c)=> s + priceAttract(c.price)*c.quality*c.size, 0); }
function marketShare(r){ const p=playerAttract(r), tot=p + compAttractTotal(r) + OUTSIDE_OPTION; return tot>0 ? p/tot : 1; }
function compShare(r,c){ const tot=playerAttract(r)+compAttractTotal(r)+OUTSIDE_OPTION; return tot>0 ? priceAttract(c.price)*c.quality*c.size/tot : 0; }
function adCost(r){ return Math.max(200, Math.round(regionDemand(r) * Math.max(0.3,cupRevenue()) * 45)); }   // ≈45秒該區營收
function launchAd(r){
  if(!regionUnlockedForSell(r)){ toast("此區尚未進場"); return; }
  const c=adCost(r); if(S.resource<c){ toast("資源不足，無法投放廣告"); return; }
  S.resource-=c; S.ads=S.ads||{}; S.ads[r]=Date.now()+AD_DURATION;
  S.statAds=(S.statAds||0)+1;
  if(navigator.vibrate) navigator.vibrate(12); confettiBurst();
  toast(`📢 ${MARKETS[r].flag}廣告開跑！吸引力×${adAttractBoost().toFixed(2)}，搶回市佔`);
  openMarketWar(); renderHeader();
}
window.launchAd=launchAd;
// 對手 AI：依市佔調整定價(降價反擊/漲價收割) + 擴張(贏家滾雪球)/倒閉(輸家退場)
let compAcc=0, lastCompAlert=0;
function competitorTick(dt){
  if(!S.competitors) return;
  compAcc += dt; if(compAcc < 4) return; compAcc = 0;
  for(const r of Object.keys(S.competitors)){
    if(!regionUnlockedForSell(r)) continue;                 // 只有你進場的區才有競爭動態
    const yours = marketShare(r);
    const gone = [];
    for(const c of S.competitors[r]){
      // --- 定價反應 ---
      let dp = 0;
      if(yours > 0.52) dp -= 0.04;                          // 你太強 → 對手降價搶客
      else if(yours < 0.30) dp += 0.03;                     // 你弱 → 對手漲價收割
      dp += (Math.random()-0.5)*0.03;                       // 隨機波動
      const home = c.style==="低價走量"?0.85 : c.style.includes("精品")||c.style==="高端精品"?1.25 : 1.0;
      dp += (home - c.price)*0.06;                          // 往自己風格回歸
      const np = Math.max(0.6, Math.min(1.6, c.price + dp));
      if(np < c.price - 0.03) flagCompetitorMove(r, c, "cut");
      c.price = Math.round(np*100)/100;
      // --- 擴張 / 萎縮（依對手自身市佔）---
      const cs = compShare(r, c);
      if(cs > 0.40)      { const ns=Math.min(1.6, c.size*1.035); if(ns>c.size+0.04) flagCompetitorMove(r,c,"grow"); c.size=ns; }
      else if(cs < 0.14) { c.size = Math.max(0.18, c.size*0.955); }
      c.size = Math.round(c.size*1000)/1000;
      // --- 倒閉：規模太小且市佔極低 → 退出市場 ---
      if(c.size <= 0.2 && cs < 0.07) gone.push(c.id);
    }
    if(gone.length){
      S.competitors[r] = S.competitors[r].filter(c=>!gone.includes(c.id));
      toast(`🏳️ ${MARKETS[r].flag} 有 ${gone.length} 家對手不敵倒閉退出市場，你的市佔提升！`);
    }
  }
}
function flagCompetitorMove(r, c, type){
  const now=Date.now(); if(now - lastCompAlert < 26000) return; lastCompAlert=now;
  if(type==="grow") toast(`📈 ${MARKETS[r].flag}${c.emoji}${c.name} 擴張展店、聲量大增！再不壓制會坐大 → 📊市場戰況`);
  else toast(`⚔️ ${MARKETS[r].flag}${c.emoji}${c.name} 降價搶客！你的市佔受壓 → 📊市場戰況`);
}
// 併購：砸錢買下對手 → 移除他、吸收品牌力（該區永久吸引力↑）
function acquireCost(r, c){ return Math.round(((compShare(r,c)+0.12) * Math.max(1,regionDemand(r)) * Math.max(0.6,cupRevenue()) * 650 + 3000) * mergerMult() * acquirerCostMult()); }
function acquireCompetitor(r, id){
  const list = (S.competitors&&S.competitors[r]) || [];
  const i = list.findIndex(c=>c.id===id); if(i<0) return;
  const c = list[i], cost = acquireCost(r, c);
  if(S.resource < cost){ toast("資金不足，無法併購這家對手"); return; }
  S.resource -= cost;
  list.splice(i, 1);                                        // 移除對手
  S.brandPower = S.brandPower || {};
  S.brandPower[r] = Math.round(((S.brandPower[r]||1) + 0.25)*1000)/1000;   // 吸收品牌/店點
  S.statAcquired=(S.statAcquired||0)+1;
  if(navigator.vibrate) navigator.vibrate(15); confettiBurst();
  toast(`🤝 併購 ${c.emoji}${c.name}！吸收店點，${MARKETS[r].flag}品牌力×${brandPower(r).toFixed(2)}`);
  openMarketWar(); renderHeader();
}
window.acquireCompetitor=acquireCompetitor;
/* ================================================================ */
// 全域售價加成（天賦 / 套裝 / Prestige / 聲望）—— 地標已改為銷售產能，不再進這裡
function globalMult(){
  return talentPriceMult() * setBonusProduct() * S.prestige.multiplier * tycoonMult() * reputationBonus() * qualityBonus() * eventMult("price") * petSaleMult() * pathMult("price");
}
// 每杯售價乘數（不含配方價值與各區行情；各區因子在 retailTick 加權套用）
function priceMult(){ return PRICE_PER_DRINK * globalMult() * avgRegionFactor(); }
// 收入顯示 / 點擊 / 離線：用零售實際銷售速率（retailTick 量測的 money/秒）
let retailRate = 0;
function opsPerSec(){ return retailRate; }
function clickValue(){
  const clickMult = 1 + 0.50*talentLevel("click") + leverageClickAdd();   // 手速狂人 + 金融槓桿
  return Math.max(1, opsPerSec()*0.10) * S.prestige.multiplier * clickMult * petClickMult() * pathMult("click");
}
function offlineCapMs(){
  return OFFLINE_CAP_MS + (talentLevel("nightowl") + 2*talentLevel("automate"))*3600*1000 + petOfflineHours()*3600*1000 + pathOfflineHours()*3600*1000;
}
// 轉型可獲得的新股票（永久乘數來源）
function prestigeSharesAvailable(){
  if(S.lifetimeResource < PRESTIGE_THRESHOLD) return 0;
  const base = Math.floor(Math.sqrt(S.lifetimeResource / PRESTIGE_THRESHOLD));
  return Math.floor(base * (1 + 0.15*talentLevel("ipo") + 0.25*talentLevel("leverage")));     // 上市鬼才 + 金融槓桿
}
function sharesOwned(){ return Math.round((S.prestige.multiplier - 1) / 0.02); }

/* ---------- 數字格式化 (K/M/B/T/aa…) ---------- */
const SUFFIX = ["","K","M","B","T","aa","ab","ac","ad","ae","af","ag","ah","ai","aj","ak"];
function fmt(n){
  if(n < 1000) return (Math.floor(n*100)/100).toString().replace(/\.00$/,"");
  let tier = Math.floor(Math.log10(n)/3);
  if(tier >= SUFFIX.length) return n.toExponential(2);
  const scaled = n / Math.pow(10, tier*3);
  return scaled.toFixed(2) + SUFFIX[tier];
}
function money(n){ return "$" + fmt(n); }

/* =========================================================
   遊戲循環
   ========================================================= */
let lastTick = Date.now();
let acc = 0;
function loop(){
  const now = Date.now();
  let dt = (now - lastTick)/1000;
  lastTick = now;
  if(dt > 1) dt = 1;                       // 分頁喚醒保護（離線另算）
  eventTick();                             // 隨機事件排程
  decisionTick();                          // 風險決策事件排程
  factoryTick(dt);                         // 跑傳送帶模擬：生產 + 出貨口入中央倉
  competitorTick(dt);                      // 競爭對手 AI：依市佔調整定價
  retailTick(dt);                          // 零售：店員把中央倉的貨賣給顧客 → 賺錢
  S.playTime = (S.playTime||0) + dt;       // 累計遊玩時間
  // 研究點由「科技廠」消耗飲料產生（見 factoryTick 的 lab 分支）
  const over = powerFactor()<1;            // 電力超載偵測（進入時提示一次）
  if(over !== lastOverload){
    lastOverload = over;
    const grid=document.getElementById("factoryGrid"); if(grid) grid.classList.toggle("power-over", over);
    if(over) toast(`⚡ 電力超載！物流線降速至 ${Math.round(powerFactor()*100)}% — 快蓋發電廠`);
    else toast("✅ 電力恢復正常，物流線全速運轉");
  }
  if(isVisible("page-biz")) factoryRenderItems();   // 只在工廠頁畫運送動畫
  renderHeader();
  renderPrestigeBtn();
  tutorialUpdate();                         // 新手教學：檢查步驟完成 + 對齊聚光燈
  requestAnimationFrame(loop);
}

/* =========================================================
   操作
   ========================================================= */
function doClick(e){
  const v = clickValue();
  S.resource += v; S.lifetimeResource += v;
  S.totalClicks = (S.totalClicks||0)+1;
  spawnFloat(e, "+"+money(v));
  if(navigator.vibrate) navigator.vibrate(10);
  const hint = document.getElementById("tapHint");
  if(hint && S.lifetimeResource>50) hint.style.display="none";
}
function buyGen(g){
  const cost = genCost(g);
  if(S.resource < cost) return;
  S.resource -= cost;
  S.generators[g.id] = (S.generators[g.id]||0)+1;
  renderGenList();
}
function tapLandmark(lm){
  const lvl = S.landmarks[lm.id]||0;
  if(lvl===0){
    if(S.resource < lm.unlockCost){ toast(`需要 ${money(lm.unlockCost)} 才能在此開店`); return; }
    S.resource -= lm.unlockCost;
    S.landmarks[lm.id] = 1;
    afterLandmarkChange(lm, 1);
  }else{
    const next = lm.stages.find(s=>s.level===lvl+1);
    if(!next){ toast(`${lm.name} 已達旗艦店頂級`); return; }
    if(S.resource < next.upgradeCost){ toast(`升級需要 ${money(next.upgradeCost)}`); return; }
    S.resource -= next.upgradeCost;
    S.landmarks[lm.id] = lvl+1;
    afterLandmarkChange(lm, lvl+1);
  }
  renderMap();
  checkAchievements();
}
function afterLandmarkChange(lm, lvl){
  const stage = lm.stages.find(s=>s.level===lvl);
  const b = BRANDS.find(x=>x.id===lm.brandId);
  // 解鎖剛好集滿整組 → 慶祝
  if(lvl===1 && brandComplete(b)){
    celebrateSet(b);
  }else{
    openModal(`<h2>${lm.emoji} ${lm.name}</h2>
      <p>升級為「<b>${stage.label}</b>」</p>
      <p>銷售產能 <b>+${stage.sellRate} 杯/秒</b></p>
      <button class="primary" onclick="closeModal()">太棒了</button>`);
  }
}
function celebrateSet(b){
  confettiBurst();
  openModal(`<h2>🎉 套裝集滿！</h2>
    <p style="color:${b.color};font-weight:800;font-size:17px">${b.name}</p>
    <div class="big">售價 ×${b.setBonus}</div>
    <p>整組分店收齊，全品牌售價加成永久生效（轉型後保留）。</p>
    <button class="primary" onclick="closeModal()">收下加成</button>
    <button class="ghost" onclick="closeModal();doShare()">炫耀一下 📤</button>`);
}

/* ---------- Prestige ---------- */
function openPrestige(){
  const shares = prestigeSharesAvailable();
  if(shares<=0){ toast("尚未達到轉型門檻"); return; }
  const newMult = 1 + (sharesOwned()+shares)*0.02;
  openModal(`<h2>✨ 轉型上市 (IPO)</h2>
    <p>將<b>重置</b>：資源、生產者、未集滿地標的升級進度。</p>
    <p>已收集的<b>圖鑑永久保留</b> 🗺️</p>
    <div class="big">永久乘數 ×${S.prestige.multiplier.toFixed(2)} → ×${newMult.toFixed(2)}</div>
    <p>本次可獲得 <b>${shares}</b> 張股票（+${(shares*2)}%）<br>＋ <b>${shares}</b> 點天賦 🌟</p>
    <div class="row">
      <button class="ghost" onclick="closeModal()">再想想</button>
      <button class="primary" onclick="doPrestige()">確認上市</button>
    </div>`);
}
function doPrestige(){
  const shares = prestigeSharesAvailable();
  S.prestige.count += 1;
  S.prestige.multiplier = 1 + (sharesOwned()+shares)*0.02;
  S.talentPoints += shares;                          // 轉型給予天賦點
  S.resource = 0;
  S.lifetimeResource = 0;
  S.generators = starterStations();    // 重置產線為起始站點
  // 圖鑑保留：landmarks 不動
  closeModal();
  confettiBurst();
  renderAll();
  toast(`已上市！永久乘數 ×${S.prestige.multiplier.toFixed(2)}`);
}

/* =========================================================
   渲染
   ========================================================= */
let dispResource = 0;
function renderHeader(){
  // 數字平滑滾動（大跳動時尤其明顯）
  const diff = S.resource - dispResource;
  if(Math.abs(diff) < Math.max(1, S.resource*0.001)) dispResource = S.resource;
  else dispResource += diff*0.25;
  document.getElementById("resourceEl").textContent = money(dispResource);
  document.getElementById("opsEl").textContent = "⚡ "+money(opsPerSec())+" / 秒";
}
function renderPrestigeBtn(){
  const btn = document.getElementById("prestigeBtn");
  const shares = prestigeSharesAvailable();
  btn.classList.toggle("show", shares>0);
  if(shares>0) btn.textContent = `✨ 轉型上市 — 可獲 ${shares} 張股票`;
  const pb = document.getElementById("pathBtn");
  if(pb){
    pb.classList.toggle("hidden", !pathUnlocked());
    const p = activePath();
    pb.textContent = p ? `${PATHS[p].icon} 企業路線：${PATHS[p].name}` : "🏢 選擇企業路線";
    pb.style.borderColor = p ? PATHS[p].color : "";
  }
}
function openPath(){
  if(!pathUnlocked()){ toast("首次轉型上市後才能選企業路線"); return; }
  const cur = activePath();
  const cards = Object.keys(PATHS).map(id=>{
    const d=PATHS[id], on=cur===id;
    return `<div class="path-card ${on?'on':''}" style="${on?`border-color:${d.color}`:''}" onclick="choosePath('${id}')">
      <div class="path-ico">${d.icon}</div>
      <div class="path-name" style="color:${d.color}">${d.name}${on?' ✓':''}</div>
      <ul class="path-eff">${d.desc.map(x=>`<li>${x}</li>`).join("")}</ul>
    </div>`;
  }).join("");
  openModal(`<h2>🏢 企業路線（三選一）</h2>
    <p style="font-size:12px;opacity:.7">選一條專精路線——強力加成但有代價，彼此互斥。可隨時切換，依工廠與市場狀況調整。</p>
    <div class="path-list">${cards}</div>
    ${cur?`<button class="ghost" onclick="choosePath(null)">取消路線（回中立）</button>`:''}
    <button class="primary" onclick="closeModal()">完成</button>`);
}
function choosePath(id){
  S.path = id;
  if(navigator.vibrate) navigator.vibrate(12);
  if(id) confettiBurst();
  openPath(); renderPrestigeBtn(); renderHeader(); renderGenList();
}
window.openPath=openPath; window.choosePath=choosePath;
/* =========================================================
   傳送帶工廠：模擬 + 渲染 + 建造
   ========================================================= */
const CELL_PX = 38, BUF_CAP = 9;
let panX = 0, panY = 0;                  // 大地圖平移位移
let factoryRate = 0;                          // 最近出貨速率（杯/秒）
let lastOverload = false;                      // 上一幀是否電力超載（用來偵測進入/離開）
let factoryAvgValue = 1;                       // 最近出貨飲料的平均配方價值
let selectedTool = "belt";                    // 目前建造工具
let beltDir = "right";                         // 放置輸送帶的方向（可切換）
const FX = { items:[], nextId:1, emitCd:{}, buf:{}, craft:{}, pendingOut:{}, delivered:0, deliveredValue:0, rpDelivered:0, acc:0 };
function factoryResetRuntime(){ FX.items=[]; FX.nextId=1; FX.emitCd={}; FX.buf={}; FX.craft={}; FX.pendingOut={}; FX.delivered=0; FX.deliveredValue=0; FX.rpDelivered=0; FX.acc=0; }
function mixerRecipe(cell){ const id=cell.recipe||"pearl_milk"; return DRINKS[id]?id:"pearl_milk"; }

function cellXY(idx){ return {x: idx%GRID_COLS, y: Math.floor(idx/GRID_COLS)}; }
function dirDelta(dir){ return DIRS[dir].dx + DIRS[dir].dy*GRID_COLS; }
function inBounds(x,y){ return x>=0 && y>=0 && x<GRID_COLS && y<gridRows(); }
function nextIdx(idx, dir){ const {x,y}=cellXY(idx); const nx=x+DIRS[dir].dx, ny=y+DIRS[dir].dy; return inBounds(nx,ny) ? ny*GRID_COLS+nx : -1; }
function itemOn(idx){ return FX.items.find(it=>it.idx===idx); }
function neighborsOf(idx){
  const {x,y}=cellXY(idx); const r=[];
  for(const d of DIR_ORDER){ const nx=x+DIRS[d].dx, ny=y+DIRS[d].dy; if(inBounds(nx,ny)) r.push(ny*GRID_COLS+nx); }
  return r;
}
// 輸送類元件：belt 一般帶 / splitter 分流器 / merger 合流器 / bridge 橋接
const CONVEYORS = {belt:1, splitter:1, merger:1, bridge:1};
function isConveyor(c){ return c && CONVEYORS[c.t]; }
function oppositeDir(d){ return d==="right"?"left":d==="left"?"right":d==="up"?"down":d==="down"?"up":null; }
function splitterWeight(cell, d){ return (cell.weights && cell.weights[d]!==undefined) ? cell.weights[d] : 1; }   // 預設權重 1（平均）
// 機台是否能接受此 item
function canMachineAccept(target, nIdx, it){
  const def = GEN_MAP[target.id];
  if(def.kind==="process"){ const rec=DRINKS[mixerRecipe(target)].recipe; return (rec[it.mat]||0)>0 && (FX.buf[nIdx]?.[it.mat]||0)<BUF_CAP && !isDrink(it.mat); }
  if(def.kind==="refine"){ return (def.recipe[it.mat]||0)>0 && (FX.buf[nIdx]?.[it.mat]||0)<BUF_CAP; }
  if(def.kind==="sink") return isDrink(it.mat) && (S.retail?.stock||0) < retailStockCap();   // 中央倉滿 → 回壓
  if(def.kind==="lab"||def.kind==="order") return isDrink(it.mat);
  if(def.kind==="store") return isDrink(it.mat) && (S.warehouse?.count||0) < warehouseCapacity();
  return false;
}
// item 進入機台（消化）。出貨口=錢、科技廠=研究、訂單站=訂單進度（三者互斥，要靠分流分配）
function deliverToMachine(target, nIdx, it){
  const def = GEN_MAP[target.id], q=(it.qty||1);
  if(def.kind==="process"||def.kind==="refine"){ FX.buf[nIdx]=FX.buf[nIdx]||{}; FX.buf[nIdx][it.mat]=(FX.buf[nIdx][it.mat]||0)+q; }
  else if(def.kind==="sink"){ FX.delivered+=q; FX.deliveredValue+=q*DRINKS[it.mat].value; S.retail=S.retail||{stock:0,value:0,clerks:0}; S.retail.stock+=q; S.retail.value+=q*DRINKS[it.mat].value; }   // → 中央倉
  else if(def.kind==="lab"){ const rp=q*RP_PER_DRINK*rpMult()*(1+0.30*modLvl(target,"lab_eff")); S.rp=(S.rp||0)+rp; FX.rpDelivered+=rp; }
  else if(def.kind==="order"){ if(S.orders){ for(const o of S.orders){ if(o.drink===it.mat && !orderDone(o)) o.progress+=q; } } }
  else if(def.kind==="store"){ S.warehouse=S.warehouse||{count:0,value:0}; S.warehouse.count+=q; S.warehouse.value+=q*DRINKS[it.mat].value; }
  it._gone=true;
}
// 目標格是否能接收（輸送格空 or 橋接 or 機台可吃）
function canFlowInto(nIdx, it){
  const t = S.factory[nIdx];
  if(isConveyor(t)) return t.t==="bridge" || !itemOn(nIdx);
  if(t && t.t==="machine") return canMachineAccept(t, nIdx, it);
  return false;
}
// 依輸送格類型決定 item 的出口方向
function exitDir(cell, it, idx){
  if(cell.t==="belt" || cell.t==="merger") return cell.dir;
  if(cell.t==="bridge") return it.dir;                       // 直行穿過
  if(cell.t==="splitter"){                                   // 依比例分配到可用出口（平滑加權輪詢）
    const back = it.dir ? oppositeDir(it.dir) : null;
    const cand = DIR_ORDER.filter(d=>{ if(d===back) return false; if(splitterWeight(cell,d)<=0) return false; const n=nextIdx(idx,d); return n>=0 && canFlowInto(n,it); });
    if(!cand.length) return null;
    cell.cur = cell.cur || {};
    let total=0, best=null, bestVal=-Infinity;
    for(const d of cand){ const wv=splitterWeight(cell,d); cell.cur[d]=(cell.cur[d]||0)+wv; total+=wv; if(cell.cur[d]>bestVal){ bestVal=cell.cur[d]; best=d; } }
    cell.cur[best]-=total;
    return best;
  }
  return cell.dir;
}
// 找一條「往外、可接收」的相鄰輸送格，給機台出料；回傳 {idx,dir}
function freeOutConveyor(srcIdx){
  for(const d of DIR_ORDER){
    const nIdx = nextIdx(srcIdx, d); if(nIdx<0) continue;
    const c = S.factory[nIdx];
    if(isConveyor(c)){
      if((c.t==="belt"||c.t==="merger") && nIdx + dirDelta(c.dir) === srcIdx) continue;  // 指回機台
      if(c.t==="bridge" || !itemOn(nIdx)) return {idx:nIdx, dir:d};
    }
  }
  return null;
}

function factoryTick(dt){
  if(!S.factory) return;
  // 1) 物件沿輸送格前進 / 交棒
  for(const it of FX.items){
    const cell = S.factory[it.idx];
    if(!isConveyor(cell)){ continue; }
    it.prog += beltSpeed()*(cell.fast?2:1)*dt;
    if(it.prog < 1) continue;
    it.prog = 1;
    const ed = exitDir(cell, it, it.idx);
    if(!ed){ continue; }                                // 分流器無可用出口 → 等
    const nIdx = nextIdx(it.idx, ed);
    if(nIdx<0){ continue; }
    const target = S.factory[nIdx];
    if(!target){ continue; }                            // 盡頭沒接東西 → 卡住
    if(isConveyor(target)){
      if(target.t==="bridge" || !itemOn(nIdx)){ it.idx=nIdx; it.prog=0; it.dir=ed; }   // 進下一格
    }else if(target.t==="machine"){
      if(canMachineAccept(target, nIdx, it)) deliverToMachine(target, nIdx, it);
    }
  }
  FX.items = FX.items.filter(it=>!it._gone);

  // 2) 機台運作
  for(let idx=0; idx<S.factory.length; idx++){
    const cell = S.factory[idx];
    if(!cell || cell.t!=="machine") continue;
    const def = GEN_MAP[cell.id];
    if(def.kind==="source"){
      FX.emitCd[idx] = (FX.emitCd[idx]||0) - dt;
      if(FX.emitCd[idx] <= 0){
        const out = freeOutConveyor(idx);
        const resBonus = (S.resources && S.resources[idx]===def.material) ? RESOURCE_BONUS : 1;   // 蓋在產地上 → 加速
        if(out){ FX.items.push({id:FX.nextId++, mat:def.material, idx:out.idx, prog:0, qty:yieldQty(cell), dir:out.dir}); FX.emitCd[idx]=1/(def.emit*speedMult(cell)*factorySpeedMult()*resBonus); }
        else FX.emitCd[idx]=0.15;                        // 出口塞住，稍後重試
      }
    }else if(def.kind==="process"){
      const drinkId = mixerRecipe(cell);
      const rec = DRINKS[drinkId].recipe;
      // 完成品等待出料（產出的是該配方的飲料）
      if(FX.pendingOut[idx]){
        const out = freeOutConveyor(idx);
        if(out){ FX.items.push({id:FX.nextId++, mat:FX.pendingOut[idx], idx:out.idx, prog:0, qty:yieldQty(cell), dir:out.dir}); FX.pendingOut[idx]=null; }
      }else if(FX.craft[idx]>0){
        FX.craft[idx]-=dt;
        if(FX.craft[idx]<=0){ FX.craft[idx]=0; FX.pendingOut[idx]=drinkId; }
      }else{
        const b = FX.buf[idx]||{};
        let ok=true; for(const m in rec){ if((b[m]||0) < rec[m]) ok=false; }
        if(ok){ for(const m in rec){ b[m]-=rec[m]; } FX.buf[idx]=b; FX.craft[idx]=def.craft/(speedMult(cell)*factorySpeedMult()); }
      }
    }else if(def.kind==="refine"){              // 精製機：固定 input→中間品
      const rec = def.recipe;
      if(FX.pendingOut[idx]){
        const out = freeOutConveyor(idx);
        if(out){ FX.items.push({id:FX.nextId++, mat:def.output, idx:out.idx, prog:0, qty:yieldQty(cell), dir:out.dir}); FX.pendingOut[idx]=null; }
      }else if(FX.craft[idx]>0){
        FX.craft[idx]-=dt;
        if(FX.craft[idx]<=0){ FX.craft[idx]=0; FX.pendingOut[idx]=def.output; }
      }else{
        const b = FX.buf[idx]||{};
        let ok=true; for(const m in rec){ if((b[m]||0) < rec[m]) ok=false; }
        if(ok){ for(const m in rec){ b[m]-=rec[m]; } FX.buf[idx]=b; FX.craft[idx]=def.craft/(speedMult(cell)*factorySpeedMult()); }
      }
    }
  }

  // 3) 出貨速率 + 平均配方價值（EMA），存進存檔供離線估算
  FX.acc += dt;
  if(FX.acc >= 0.5){
    const rate = FX.delivered/FX.acc;
    factoryRate = factoryRate*0.6 + rate*0.4;
    if(FX.delivered>0){ const av=FX.deliveredValue/FX.delivered; factoryAvgValue = factoryAvgValue*0.6 + av*0.4; }
    rpPerSec = rpPerSec*0.6 + (FX.rpDelivered/FX.acc)*0.4;
    FX.delivered=0; FX.deliveredValue=0; FX.rpDelivered=0; FX.acc=0;
    S.factoryRate = factoryRate; S.factoryAvgValue = factoryAvgValue;
  }
}

/* 零售：店員把中央倉的飲料賣給顧客（min(顧客需求, 店員產能, 庫存)）→ 賺錢 */
let retailAcc = 0, retailMoneyWin = 0;
function retailTick(dt){
  S.retail = S.retail || {stock:0, value:0, clerks:0};
  const wh = S.retail;
  const sellRate = Math.min(retailDemand(), clerkCap());     // 顧客需求 與 店員產能 的較小者
  let sold = Math.min(sellRate*dt, wh.stock);
  let gross = 0;
  if(sold > 0){
    const avgVal = wh.value / Math.max(1e-9, wh.stock);       // 庫存平均配方價值
    gross = sold * avgVal * priceMult();
    if(gross>0) S.lifetimeResource += gross;                  // 成就用：累積總營收（不扣薪資）
    wh.stock -= sold; wh.value = Math.max(0, wh.value - sold*avgVal);
  }
  // 店員薪資：不論有沒有賣出都要付（閒置=純虧）
  const wages = clerkWage() * dt;
  let net = gross - wages;
  if(net < 0) net = Math.max(net, -S.resource);              // 軟下限：薪資最多把現金扣到 0
  S.resource += net;
  // 淨收入速率 EMA（顯示/離線/點擊用）
  retailAcc += dt; retailMoneyWin += net;
  if(retailAcc >= 0.5){
    retailRate = retailRate*0.6 + (retailMoneyWin/retailAcc)*0.4;
    S.retailRate = retailRate; retailAcc=0; retailMoneyWin=0;
  }
}

// 每幀畫出運送中的物件
function factoryRenderItems(){
  const layer = document.getElementById("factoryItems");
  if(!layer) return;
  // 同步：以 id 對應 DOM
  const seen = {};
  for(const it of FX.items){
    let el = layer.querySelector(`[data-iid="${it.id}"]`);
    if(!el){ el=document.createElement("div"); el.className="fitem"; el.dataset.iid=it.id; el.textContent=(DRINKS[it.mat]?.icon)||MATERIAL_ICON[it.mat]||"?"; layer.appendChild(el); }
    const {x,y}=cellXY(it.idx);
    const cell=S.factory[it.idx];
    // 渲染方向：一般帶/合流器照「該格流向」走；橋接/分流器才用 item 自身方向
    const rdir = (cell && (cell.t==="belt"||cell.t==="merger")) ? cell.dir : it.dir;
    const d = rdir && DIRS[rdir] ? DIRS[rdir] : {dx:0,dy:0};
    const px = (x + d.dx*(it.prog-0.5))*CELL_PX;
    const py = (y + d.dy*(it.prog-0.5))*CELL_PX;
    el.style.transform = `translate(${px}px,${py}px)`;
    seen[it.id]=1;
  }
  layer.querySelectorAll(".fitem").forEach(el=>{ if(!seen[el.dataset.iid]) el.remove(); });
}

// 主渲染：工具列 + 工廠地皮 + 統計
function renderGenList(){
  renderFactoryStats();
  renderPalette();
  renderGrid();
}
function renderFactoryStats(){
  let machines=0, belts=0;
  for(const c of S.factory){ if(!c) continue; if(c.t==="machine") machines++; else belts++; }
  const prod = factoryRate||0;
  const r = S.retail||{stock:0}; const scap=retailStockCap();
  const sell = Math.min(retailDemand(), clerkCap());
  const pd=powerDemand(), pc=powerCapacity(), pf=powerFactor();
  const overload = pf<1;
  let advice;
  if(overload) advice = `🔴 電力超載！全廠降速至 ${Math.round(pf*100)}% → 蓋 ⚡發電廠`;
  else if(machines===0) advice = `⚪ 原料機 → 🫕調製站 → 🧋出貨口 接成一條線（出貨口的貨進中央倉）`;
  else if(r.stock>=scap*0.95) advice = `🔴 中央倉快滿！店員賣不夠快 → 🏪零售經營 雇店員`;
  else if(prod > sell*1.05) advice = `🟡 產量＞銷售 → 🏪雇店員 或 🗺️開分店提升需求`;
  else if(sell > prod*1.2) advice = `🟡 賣得比產得快 → 衝高工廠生產量`;
  else advice = `🟢 產銷順暢`;
  const powerBar = `<div class="power-row ${overload?'over':''}">⚡ 電力 <div class="bar"><i style="width:${Math.min(100,pd/pc*100)}%"></i></div> <b class="tabular">${pd}/${Math.round(pc)}</b></div>`;
  const alertBar = overload ? `<div class="power-alert">⚡ 電力超載！物流線降速至 ${Math.round(pf*100)}% — 蓋 ⚡發電廠 補電力</div>` : '';
  document.getElementById("chainSummary").innerHTML = `
    <div class="chain-summary">
      ${alertBar}
      <div class="chain-flow">🏭 生產 <b class="tabular">${prod.toFixed(1)}</b> ｜ 📦 中央倉 <b class="tabular">${Math.floor(r.stock)}/${scap}</b> ｜ 🛒 銷售 <b class="tabular">${sell.toFixed(0)}</b> → 💰 <b class="tabular">${money(opsPerSec())}/秒</b></div>
      ${powerBar}
      <div class="chain-pipe">${advice}　・配方均價×${(factoryAvgValue||1).toFixed(2)}・市場售價×${avgRegionFactor().toFixed(2)}</div>
    </div>`;
}
function renderPalette(){
  // 原料機只在「該原料被已解鎖配方用到」時才出現在工具列
  const avail = GENERATORS.filter(g=>{
    if(g.kind==="source") return materialUnlocked(g.material);
    if(g.kind==="refine") return researchLevel("refine_tech")>0;   // 精製機需研究解鎖
    return true;
  });
  const tools = [
    {tool:"belt", icon:DIRS[beltDir].arrow, name:"輸送帶", sub:"再點此轉向"},
  ];
  if(fastBeltUnlocked()) tools.push({tool:"fast_belt", icon:DIRS[beltDir].fastArrow, name:"高速帶", sub:"×2 速"});
  if(splitterUnlocked()){
    tools.push({tool:"splitter", icon:"🔀", name:"分流器", sub:money(ADV_BELT_COST.splitter)});
    tools.push({tool:"merger", icon:"🔃", name:"合流器", sub:money(ADV_BELT_COST.merger)});
  }
  if(bridgeUnlocked()) tools.push({tool:"bridge", icon:"✚", name:"橋接", sub:money(ADV_BELT_COST.bridge)});
  tools.push(
    ...avail.map(g=>({tool:g.id, icon:g.icon, name:g.name, sub:money(genCost(g))})),
    {tool:"move", icon:"✋", name:"移動", sub:"拖曳平移"},
    {tool:"blueprint", icon:"📐", name:"藍圖", sub:bpClip?`已複製 ${bpClip.cells.length}`:"框選複製"},
    {tool:"terraform", icon:"🏞️", name:"整地", sub:money(TERRAFORM_COST)},
    {tool:"delete", icon:"🗑️", name:"拆除", sub:"退一半"},
  );
  const isToolTool = (tool)=> tool==="terraform"||tool==="delete"||tool==="move"||tool==="blueprint";
  const toolGroup = (tool)=> (isBeltTool(tool)||isAdvConveyorTool(tool)) ? "transport" : isToolTool(tool) ? "tool" : "machine";
  const chip = (t)=>{
    const special = isBeltTool(t.tool)||isAdvConveyorTool(t.tool)||isToolTool(t.tool);
    const sel = t.tool===selectedTool ? "sel" : "";
    const afford = t.tool==="terraform" ? S.resource>=TERRAFORM_COST : isAdvConveyorTool(t.tool) ? S.resource>=ADV_BELT_COST[t.tool] : special ? true : S.resource>=genCost(GEN_MAP[t.tool]);
    const cat = t.tool==="fast_belt" ? "fbelt" : isBeltTool(t.tool) ? "belt" : t.tool==="delete" ? "del" : t.tool==="terraform" ? "terra" : t.tool==="move" ? "move" : t.tool==="blueprint" ? "bp" : isAdvConveyorTool(t.tool) ? "adv" : GEN_MAP[t.tool].kind;
    return `<button class="ptool cat-${cat} ${sel} ${afford?'':'poor'}" data-tool="${t.tool}">
      <span class="pico">${t.icon}</span><span class="pname">${t.name}</span><span class="psub tabular">${t.sub}</span></button>`;
  };
  const groups = [{key:"transport", label:"🚚 輸送"}, {key:"machine", label:"🏭 機台"}, {key:"tool", label:"🛠️ 工具"}];
  document.getElementById("factoryPalette").innerHTML = groups.map(g=>{
    const items = tools.filter(t=>toolGroup(t.tool)===g.key);
    if(!items.length) return "";
    return `<div class="pal-group"><div class="pal-label">${g.label}</div><div class="pal-row">${items.map(chip).join("")}</div></div>`;
  }).join("");
}
// 單格的 class / 內容（renderGrid 與增量 updateCell 共用）
function cellRender(idx){
  const c = S.factory[idx];
  const terr = S.terrain[idx]||"plain";
  const res = S.resources && S.resources[idx];
  let inner="", cls="fcell terr-"+terr;
  if(res) cls+=" res";                                  // 資源產地底色
  if(c && c.t==="belt"){ cls+=" belt belt-"+c.dir+(c.fast?" fast":""); inner=c.fast?DIRS[c.dir].fastArrow:DIRS[c.dir].arrow; }
  else if(c && c.t==="splitter"){ cls+=" splitter"; inner="🔀"; }
  else if(c && c.t==="merger"){ cls+=" merger"; inner=DIRS[c.dir].arrow; }
  else if(c && c.t==="bridge"){ cls+=" bridge"; inner="✚"; }
  else if(c && c.t==="machine"){
    const def=GEN_MAP[c.id], ml=c.mods?Object.values(c.mods).reduce((a,b)=>a+b,0):0;
    cls+=" machine"; if(res===def.material) cls+=" boosted";   // 蓋對產地 → 發光
    inner=def.icon + (ml>0?`<span class="flvl">${ml}</span>`:"") + (res===def.material?`<span class="boost">×${RESOURCE_BONUS}</span>`:"");
  }
  else { inner=`<span class="terr-ico${res?' res-ico':''}">${res?MATERIAL_ICON[res]:TERRAIN[terr].emoji}</span>`; }  // 空產地顯示資源圖示
  return {cls, inner};
}
// 增量：只更新幾格（大地圖拖曳時的熱路徑，不全部重畫）
function updateCells(indices){
  const grid=document.getElementById("factoryGrid"); if(!grid) return;
  for(const idx of indices){
    const el=grid.querySelector(`[data-cell="${idx}"]`); if(!el) continue;
    const {cls,inner}=cellRender(idx); el.className=cls; el.innerHTML=inner;
  }
  grid.classList.toggle("power-over", powerFactor()<1);
  drawMinimap();
}
function renderGrid(){
  let html="";
  for(let idx=0; idx<S.factory.length; idx++){
    const {cls,inner}=cellRender(idx);
    html += `<div class="${cls}" data-cell="${idx}">${inner}</div>`;
  }
  const grid=document.getElementById("factoryGrid");
  grid.style.gridTemplateColumns = `repeat(${GRID_COLS}, ${CELL_PX}px)`;
  grid.style.gridAutoRows = CELL_PX+"px";
  grid.innerHTML = html;
  grid.classList.toggle("power-over", powerFactor()<1);   // 超載時的視覺
  applyPan();
}
let factoryZoom = 1;
// 平移 + 縮放：位移 #factoryPan、夾在邊界內、畫小地圖
function applyPan(){
  const wrap=document.getElementById("factoryWrap"), pan=document.getElementById("factoryPan");
  if(!wrap||!pan) return;
  const gw=GRID_COLS*CELL_PX*factoryZoom, gh=gridRows()*CELL_PX*factoryZoom;
  const vw=wrap.clientWidth||gw, vh=wrap.clientHeight||gh;
  panX=Math.min(0, Math.max(Math.min(0,vw-gw), panX));
  panY=Math.min(0, Math.max(Math.min(0,vh-gh), panY));
  pan.style.transformOrigin="0 0";
  pan.style.transform=`translate(${panX}px,${panY}px) scale(${factoryZoom})`;
  drawMinimap();
}
function zoomBy(mult){
  const wrap=document.getElementById("factoryWrap"); if(!wrap) return;
  const vw=wrap.clientWidth||1, vh=wrap.clientHeight||1;
  const z0=factoryZoom, z1=Math.max(0.45, Math.min(1.6, z0*mult));
  // 以視窗中心為錨點縮放
  const wx=(vw/2 - panX)/z0, wy=(vh/2 - panY)/z0;
  factoryZoom=z1;
  panX=vw/2 - wx*z1; panY=vh/2 - wy*z1;
  applyPan();
}
// 小地圖：整張地皮縮圖 + 目前視窗框，點擊可跳轉
function drawMinimap(){
  const cv=document.getElementById("miniMap"); if(!cv||!cv.getContext) return;
  const ctx=cv.getContext("2d"); if(!ctx) return;
  const W=cv.width, H=cv.height, sx=W/GRID_COLS, sy=H/gridRows();
  ctx.clearRect(0,0,W,H);
  ctx.fillStyle="#EFE3CC"; ctx.fillRect(0,0,W,H);
  for(let idx=0; idx<S.factory.length; idx++){
    const c=S.factory[idx], terr=S.terrain[idx], res=S.resources&&S.resources[idx];
    let col=null;
    if(c&&c.t==="machine") col="#5FA86B";
    else if(c&&c.t==="belt") col=c.fast?"#3E7BC0":"#C89B6E";
    else if(c) col="#9B8AB8";
    else if(res) col="#E0A03C";
    else if(terr==="water") col="#6096C8";
    else if(terr==="grass") col="#B6D49A";
    if(col){ const {x,y}=cellXY(idx); ctx.fillStyle=col; ctx.fillRect(x*sx, y*sy, Math.ceil(sx), Math.ceil(sy)); }
  }
  // 視窗框
  const wrap=document.getElementById("factoryWrap"); if(wrap){
    const vw=wrap.clientWidth||1, vh=wrap.clientHeight||1, gz=CELL_PX*factoryZoom;
    const vx=(-panX)/gz, vy=(-panY)/gz, vcw=vw/gz, vch=vh/gz;
    ctx.strokeStyle="#3A2A20"; ctx.lineWidth=1.5;
    ctx.strokeRect(vx*sx, vy*sy, vcw*sx, vch*sy);
  }
}
// 點小地圖 → 平移到該位置（置中）
function minimapJump(e){
  const cv=document.getElementById("miniMap"), wrap=document.getElementById("factoryWrap"); if(!cv||!wrap) return;
  const r=cv.getBoundingClientRect();
  const fx=(e.clientX-r.left)/r.width*GRID_COLS, fy=(e.clientY-r.top)/r.height*gridRows();
  const gz=CELL_PX*factoryZoom;
  panX = wrap.clientWidth/2 - fx*gz;
  panY = wrap.clientHeight/2 - fy*gz;
  applyPan();
}

// 建造：點格子
function buildAt(idx){
  if(selectedTool==="move") return;        // 移動工具：單點不建造
  const c = S.factory[idx];
  const terr = S.terrain[idx]||"plain";
  // 點到已放的機台（非拆除模式）→ 倉儲開行情面板，其餘開升級選單
  if(c && c.t==="machine" && selectedTool!=="delete"){
    if(GEN_MAP[c.id].kind==="store") openWarehouse(idx); else openUpgrade(idx);
    return;
  }
  // 點到分流器（非拆除）→ 設定分配比例
  if(c && c.t==="splitter" && selectedTool!=="delete"){ openSplitterConfig(idx); return; }
  if(selectedTool==="terraform"){                          // 整地：清除資源產地 / 水→空地→草地→空地
    if(c){ toast("先拆除上面的東西才能整地"); return; }
    if(S.resource < TERRAFORM_COST){ toast(`整地需要 ${money(TERRAFORM_COST)}`); return; }
    S.resource -= TERRAFORM_COST;
    if(S.resources && S.resources[idx]){ S.resources[idx]=null; S.terrain[idx]="plain"; toast("已清除資源產地，這格可自由建造"); }
    else S.terrain[idx] = terr==="water" ? "plain" : terr==="plain" ? "grass" : "plain";
    if(navigator.vibrate) navigator.vibrate(8);
    renderGenList(); return;
  }
  if(isBeltTool(selectedTool)){
    if(terr==="water"){ toast("💧 水域不能鋪帶，先用 🏞️整地 填平"); return; }
    const fast = selectedTool==="fast_belt";
    if(!c){ S.factory[idx]={t:"belt", dir:beltDir, fast}; }
    else if(c.t==="belt"){
      if(c.fast!==fast) c.fast=fast;                         // 同位置換帶種
      else { const i=DIR_ORDER.indexOf(c.dir); c.dir=DIR_ORDER[(i+1)%4]; }  // 否則旋轉
    }
  }else if(isAdvConveyorTool(selectedTool)){
    if(terr==="water"){ toast("💧 水域不能蓋，先整地"); return; }
    if(c){
      if(c.t==="merger" && selectedTool==="merger"){ const i=DIR_ORDER.indexOf(c.dir); c.dir=DIR_ORDER[(i+1)%4]; }  // 旋轉合流器出口
      else { toast("此格已被佔用"); return; }
    }else{
      const cost = ADV_BELT_COST[selectedTool];
      if(S.resource < cost){ toast(`需要 ${money(cost)} 才能蓋`); return; }
      S.resource -= cost;
      if(selectedTool==="splitter") S.factory[idx]={t:"splitter", weights:{right:1,down:1,left:1,up:1}, cur:{}};
      else if(selectedTool==="merger") S.factory[idx]={t:"merger", dir:beltDir};
      else S.factory[idx]={t:"bridge"};
    }
  }else if(selectedTool==="delete"){
    if(!c){ return; }
    if(c.t==="machine"){
      // 拆除最後一座倉儲且還有庫存 → 提醒（會清空庫存）
      if(GEN_MAP[c.id].kind==="store" && warehouseCount()===1 && (S.warehouse?.count||0)>0){ confirmDeleteWarehouse(idx); return; }
      removeMachine(idx, true); if(navigator.vibrate) navigator.vibrate(8); renderGenList(); return;
    }
    FX.items = FX.items.filter(it=>it.idx!==idx);             // 清掉這格上的 item
    S.factory[idx]=null;
  }else{                                                  // 蓋機台（固定價 + 地形 + 資源產地限制）
    const g = GEN_MAP[selectedTool];
    const res = S.resources && S.resources[idx];
    if(g.rare && res!==g.material){                          // 稀有採集機只能蓋在對應稀有產地
      toast(`${g.name} 只能蓋在 ${MATERIAL_ICON[g.material]}${MATERIAL_NAME[g.material]}產地（很稀有，找找看！）`);
      return;
    }
    if(res && !(g.kind==="source" && g.material===res)){    // 資源產地只能蓋對應採集機
      toast(`此為 ${MATERIAL_ICON[res]}${MATERIAL_NAME[res]||res}產地，只能蓋對應採集機（或用 🏞️整地 清除）`);
      return;
    }
    if(!canPlaceOn(terr, g)){
      toast(terr==="water" ? "💧 水域不能蓋，先整地" : `${g.name} 只能蓋在 🌿草地上（先用 🏞️整地）`);
      return;
    }
    const cost = genCost(g);
    if(S.resource < cost){ toast(`需要 ${money(cost)} 才能蓋${g.name}`); return; }
    S.resource -= cost; S.generators[g.id]=(S.generators[g.id]||0)+1;
    S.factory[idx]={t:"machine", id:g.id, mods:{}};
    if(g.kind==="process") S.factory[idx].recipe="pearl_milk";
  }
  if(navigator.vibrate) navigator.vibrate(8);
  renderGenList();
}
// 移除機台（退一半放置費）
function warehouseCount(){ return S.factory.filter(c=>c&&c.t==="machine"&&GEN_MAP[c.id].kind==="store").length; }
function removeMachine(idx, refund){
  const c = S.factory[idx]; if(!c || c.t!=="machine") return;
  const g = GEN_MAP[c.id];
  S.generators[c.id] = Math.max(0,(S.generators[c.id]||0)-1);
  if(refund) S.resource += g.baseCost*0.5;
  delete FX.buf[idx]; delete FX.craft[idx]; delete FX.pendingOut[idx]; delete FX.emitCd[idx];
  FX.items = FX.items.filter(it=>it.idx!==idx);
  S.factory[idx]=null;
  if(g.kind==="store" && warehouseCount()===0 && S.warehouse){ S.warehouse={count:0,value:0}; }  // 沒倉儲了 → 庫存歸零
}
// 升級選單：多模塊面板
function openUpgrade(idx){
  const c = S.factory[idx]; if(!c || c.t!=="machine") return;
  const def = GEN_MAP[c.id];
  const totalLv = modulesFor(def.kind).reduce((s,m)=>s+modLvl(c,m.id),0);
  const rows = modulesFor(def.kind).map(m=>{
    const lv = modLvl(c, m.id);
    const cost = moduleCost(def, m, lv);
    const can = S.resource>=cost;
    return `<div class="mod-row">
      <div class="mod-ico">${m.icon}</div>
      <div class="mod-info">
        <div class="mod-name">${m.name} <small>Lv.${lv}</small></div>
        <div class="mod-eff">${lv>0?m.eff(lv)+'　→　':''}${m.eff(lv+1)}</div>
      </div>
      <button class="mod-buy ${can?'':'cant'}" ${can?`onclick="upgradeModule(${idx},'${m.id}')"`:''}>
        升級<span class="tabular">${money(cost)}</span></button>
    </div>`;
  }).join("");
  // 調製站：配方切換
  let recipeBlock = "";
  if(def.kind==="process"){
    const cur = mixerRecipe(c);
    const opts = unlockedDrinks().map(id=>{
      const d=DRINKS[id];
      const need = Object.entries(d.recipe).map(([m,n])=>`${MATERIAL_ICON[m]}×${n}`).join(" ");
      return `<button class="dpick ${id===cur?'sel':''}" onclick="setMixerRecipe(${idx},'${id}')">
        <span style="font-size:20px">${d.icon}</span><b>${d.name}</b>
        <small>${need}　售價×${d.value}</small></button>`;
    }).join("");
    const locked = Object.keys(DRINKS).length - unlockedDrinks().length;
    recipeBlock = `<div class="recipe-pick-title">🍹 配方（去地圖展店解鎖更多）</div>
      <div class="recipe-pick">${opts}</div>
      ${locked>0?`<p style="font-size:11px;opacity:.55;margin:4px 0 0">還有 ${locked} 種配方未解鎖</p>`:''}`;
  }
  openModal(`<h2>${def.icon} ${def.name}　<span style="opacity:.55">模塊 Lv.${totalLv}</span></h2>
    ${recipeBlock}
    <div class="mod-list">${rows}</div>
    <button class="ghost" onclick="tryRemoveMachine(${idx})">🗑️ 拆除（退一半）</button>
    <button class="ghost" onclick="closeModal()">關閉</button>`);
}
function setMixerRecipe(idx, drinkId){
  const c = S.factory[idx]; if(!c||c.t!=="machine") return;
  if(!drinkUnlocked(drinkId)){ toast("此配方尚未解鎖"); return; }
  c.recipe = drinkId;
  FX.buf[idx]={}; FX.craft[idx]=0; FX.pendingOut[idx]=null;   // 換配方清空緩衝
  if(navigator.vibrate) navigator.vibrate(8);
  openUpgrade(idx); renderGenList();
}
window.setMixerRecipe=setMixerRecipe;
function upgradeModule(idx, modId){
  const c = S.factory[idx]; if(!c||c.t!=="machine") return;
  const def = GEN_MAP[c.id], mod = MODULES[modId], lv = modLvl(c, modId);
  const cost = moduleCost(def, mod, lv);
  if(S.resource < cost){ toast("錢不夠升級"); return; }
  S.resource -= cost; c.mods = c.mods||{}; c.mods[modId] = lv+1;
  if(navigator.vibrate) navigator.vibrate(10);
  openUpgrade(idx); renderGenList();
}
window.upgradeModule=upgradeModule; window.removeMachine=removeMachine;
// 分流器：設定各方向的分配比例
function neighborLabel(idx, d){
  const n=nextIdx(idx,d); if(n<0) return "邊界";
  const c=S.factory[n]; if(!c) return "空";
  if(c.t==="machine"){ const k=GEN_MAP[c.id].kind; return GEN_MAP[c.id].icon+GEN_MAP[c.id].name; }
  return c.t==="belt"?"輸送帶":c.t==="splitter"?"分流器":c.t==="merger"?"合流器":c.t==="bridge"?"橋接":"?";
}
function openSplitterConfig(idx){
  const cell=S.factory[idx]; if(!cell||cell.t!=="splitter") return;
  const arrow={right:"▶",down:"▼",left:"◀",up:"▲"};
  const rows=DIR_ORDER.map(d=>{
    const w=splitterWeight(cell,d), tgt=neighborLabel(idx,d);
    return `<div class="split-row">
      <span class="split-dir">${arrow[d]}</span>
      <span class="split-tgt">${tgt}</span>
      <div class="split-step">
        <button onclick="setSplitWeight(${idx},'${d}',-1)">−</button>
        <b class="tabular">${w}</b>
        <button onclick="setSplitWeight(${idx},'${d}',1)">＋</button>
      </div></div>`;
  }).join("");
  openModal(`<h2>🔀 分流比例</h2>
    <p style="font-size:12px;opacity:.7">設定每個方向的分配權重（0＝不送這邊）。例如 出貨▶3：研究▼1 ＝ 3:1</p>
    <div class="split-list">${rows}</div>
    <button class="ghost" onclick="removeMachineLike(${idx})">🗑️ 拆除</button>
    <button class="primary" onclick="closeModal()">完成</button>`);
}
function setSplitWeight(idx, d, delta){
  const cell=S.factory[idx]; if(!cell||cell.t!=="splitter") return;
  cell.weights=cell.weights||{right:1,down:1,left:1,up:1};
  cell.weights[d]=Math.max(0, Math.min(9, (cell.weights[d]??1)+delta));
  cell.cur={};                                    // 重置平滑計數
  if(navigator.vibrate) navigator.vibrate(6);
  openSplitterConfig(idx);
}
function removeMachineLike(idx){                   // 拆除分流器等輸送類
  FX.items=FX.items.filter(it=>it.idx!==idx); S.factory[idx]=null;
  closeModal(); renderGenList();
}
window.openSplitterConfig=openSplitterConfig; window.setSplitWeight=setSplitWeight; window.removeMachineLike=removeMachineLike;
// 倉儲：囤積 + 看行情拋售
function warehouseSaleValue(){
  const wh=S.warehouse||{count:0,value:0};
  return PRICE_PER_DRINK * wh.value * globalMult() * avgRegionFactor();
}
function openWarehouse(idx){
  const wh=S.warehouse||{count:0,value:0};
  const cap=warehouseCapacity();
  const arf=avgRegionFactor();
  const sale=warehouseSaleValue();
  const pctMkt=Math.round((arf-0.6)/1.4*100);
  openModal(`<h2>🏬 倉儲 & 市場</h2>
    <div class="mkt-box">
      <div class="mkt-now">📊 各區加權售價 <b>×${arf.toFixed(2)}</b></div>
      <div class="bar mkt-bar"><i style="width:${Math.max(2,Math.min(100,pctMkt))}%"></i></div>
      <div class="mkt-hint">拋售與零售都賣到所有已開的區，售價依各區行情×你的定價。在 🏪零售經營 可各區分別定價。</div>
    </div>
    <div class="wh-stock">📦 庫存 <b class="tabular">${Math.floor(wh.count)}</b> / ${cap} 杯</div>
    <p style="font-size:12px;opacity:.7">把飲料用輸送帶送進 🏬倉儲 囤起來，等行情高點一次拋售賺價差。</p>
    <button class="primary ${wh.count>0?'':'cant'}" ${wh.count>0?'onclick="sellWarehouse()"':''}>💰 全部拋售 ＠×${arf.toFixed(2)}　＝ ${money(sale)}</button>
    ${idx!==undefined?`<button class="ghost" onclick="openUpgrade(${idx})">🔧 升級 / 拆除此倉儲</button>`:''}
    <button class="ghost" onclick="closeModal()">關閉</button>`);
}
function sellWarehouse(){
  const wh=S.warehouse||{count:0,value:0};
  if(wh.count<=0){ toast("倉庫是空的"); return; }
  const got=warehouseSaleValue();
  S.resource+=got; S.lifetimeResource+=got;
  S.warehouse={count:0,value:0};
  if(navigator.vibrate) navigator.vibrate(14); confettiBurst();
  toast(`拋售 ${money(got)}！`);
  openWarehouse(); renderHeader();
}
function confirmDeleteWarehouse(idx){
  const wh=S.warehouse||{count:0,value:0};
  openModal(`<h2>⚠️ 拆除倉儲？</h2>
    <p>這是最後一座倉儲，裡面還有 <b>${Math.floor(wh.count)} 杯</b> 庫存（約值 ${money(warehouseSaleValue())}）。</p>
    <p style="font-size:12.5px;opacity:.75">拆除後庫存會<b>清空歸零</b>，下次蓋新倉儲是空的。建議先 💰拋售。</p>
    <button class="primary" onclick="openWarehouse(${idx})">← 先去拋售</button>
    <button class="ghost" style="border-color:var(--warning);color:var(--warning)" onclick="doDeleteWarehouse(${idx})">仍要拆除（清空庫存）</button>
    <button class="ghost" onclick="closeModal()">取消</button>`);
}
function doDeleteWarehouse(idx){ removeMachine(idx,true); closeModal(); renderGenList(); toast("倉儲已拆除，庫存清空"); }
function tryRemoveMachine(idx){       // 升級面板的拆除：倉儲有庫存先提醒
  const c=S.factory[idx]; if(!c||c.t!=="machine") return;
  if(GEN_MAP[c.id].kind==="store" && warehouseCount()===1 && (S.warehouse?.count||0)>0){ confirmDeleteWarehouse(idx); return; }
  removeMachine(idx,true); closeModal(); renderGenList();
}
window.openWarehouse=openWarehouse; window.sellWarehouse=sellWarehouse;
window.confirmDeleteWarehouse=confirmDeleteWarehouse; window.doDeleteWarehouse=doDeleteWarehouse; window.tryRemoveMachine=tryRemoveMachine;
/* ---------- 零售店經營（聚合面板）---------- */
function openRetail(){
  const r=S.retail||{stock:0,value:0,clerks:0};
  const demand=retailDemand(), cap=clerkCap(), sell=Math.min(demand,cap), scap=retailStockCap();
  const st=retailStatus();
  const grossRate = sell * cupRevenue();          // 銷售毛收入/秒（產能可吃滿時）
  const wageRate = clerkWage();                   // 店員薪資/秒
  const netRate = opsPerSec();                    // 實際淨利/秒（EMA）
  const wagePer = WAGE_CUPS * cupRevenue();       // 每名店員薪資/秒
  // 各區定價列
  const rows = unlockedSellRegions().map(rg=>{
    const m=MARKETS[rg], pl=priceLevel(rg), eff=regionEffDemand(rg), fac=regionFactor(rg);
    const tag = pl>=1.3?"💎精品": pl>=1.1?"偏高": pl<=0.8?"🏷️走量": pl<0.95?"偏低":"標準";
    return `<div class="price-row">
      <div class="pr-name">${m.flag}${m.name} <span class="pr-tag">${tag}</span></div>
      <div class="pr-ctl">
        <button class="pr-btn ${pl<=0.6?'cant':''}" ${pl<=0.6?'':`onclick="setPrice('${rg}',-0.1)"`}>－</button>
        <b class="tabular pr-lv">×${pl.toFixed(1)}</b>
        <button class="pr-btn ${pl>=1.6?'cant':''}" ${pl>=1.6?'':`onclick="setPrice('${rg}',0.1)"`}>＋</button>
      </div>
      <div class="pr-info">市佔 ${(marketShare(rg)*100).toFixed(0)}%　需求 ${eff.toFixed(0)}/秒　售價×${fac.toFixed(2)} ${marketTrend(rg)}${adActive(rg)?' 📢':''}</div>
    </div>`;
  }).join("");
  openModal(`<h2>🏪 零售經營</h2>
    <p style="font-size:12px;opacity:.7">工廠生產 → 出貨口入中央倉 → 店員自動把貨賣到<b>所有已開的區</b>。各區可分別定價：定價↑單杯賺更多但客人變少。</p>
    <div class="retail-light ${st.lvl}">${st.icon} ${st.msg}</div>
    <div class="stat-list">
      <div class="stat-row"><span>📦 中央倉庫存</span><b class="tabular">${Math.floor(r.stock)} / ${scap}</b></div>
      <div class="stat-row"><span>👥 顧客需求（各區合計）</span><b class="tabular">${demand.toFixed(0)} 杯/秒</b></div>
      <div class="stat-row"><span>👔 店員產能</span><b class="tabular">${cap.toFixed(0)} 杯/秒</b></div>
      <div class="stat-row"><span>🛒 實際銷售</span><b class="tabular">${sell.toFixed(0)} 杯/秒</b></div>
    </div>
    <div class="stat-list" style="margin-top:8px">
      <div class="stat-row"><span>💵 銷售毛收入</span><b class="tabular" style="color:var(--success)">${money(grossRate)}/秒</b></div>
      <div class="stat-row"><span>👔💸 店員薪資</span><b class="tabular" style="color:var(--danger,#d9534f)">−${money(wageRate)}/秒</b></div>
      <div class="stat-row"><span>💰 淨利</span><b class="tabular" style="color:${netRate>=0?'var(--success)':'var(--danger,#d9534f)'}">${netRate<0?'−':''}${money(Math.abs(netRate))}/秒</b></div>
    </div>
    <div class="section-title" style="margin:10px 0 4px">📍 各區定價策略</div>
    <div class="price-list">${rows}</div>
    <div class="wh-stock" style="margin-top:10px">👔 店員 <b class="tabular">${retailClerks()}</b> 名（你=基礎 1，免薪）　每名薪資 ≈ ${money(wagePer)}/秒</div>
    <p style="font-size:11.5px;opacity:.65;margin:4px 0 0">雇店員提升銷售產能，但每秒要付薪水——閒置或缺貨時店員照領乾薪，反而虧錢。雇多少要看需求與產線供得上多少。</p>
    <button class="primary ${S.resource>=clerkCost()?'':'cant'}" ${S.resource>=clerkCost()?'onclick="hireClerk()"':''}>➕ 雇用店員　${money(clerkCost())}</button>
    ${retailClerks()>0?`<button class="ghost" onclick="fireClerk()">➖ 解雇一名店員（省薪資）</button>`:''}
    <button class="ghost" onclick="closeModal()">關閉</button>`);
}
function setPrice(region, delta){
  if(!MARKETS[region]) return;
  S.pricing = S.pricing || {};
  const cur = priceLevel(region);
  const next = Math.round(Math.max(0.6, Math.min(1.6, cur+delta))*10)/10;
  S.pricing[region] = next;
  if(navigator.vibrate) navigator.vibrate(6);
  openRetail();
}
window.setPrice=setPrice;
function hireClerk(){
  const c=clerkCost(); if(S.resource<c){ toast("資源不足"); return; }
  S.resource-=c; S.retail.clerks=(S.retail.clerks||0)+1;
  if(navigator.vibrate) navigator.vibrate(10); confettiBurst();
  openRetail(); renderHeader();
}
function fireClerk(){
  if(retailClerks()<=0) return;
  S.retail.clerks=Math.max(0,(S.retail.clerks||0)-1);   // 解雇不退雇用金，但立刻省下薪資
  if(navigator.vibrate) navigator.vibrate(8);
  toast("已解雇一名店員，薪資負擔下降");
  openRetail(); renderHeader();
}
window.openRetail=openRetail; window.hireClerk=hireClerk; window.fireClerk=fireClerk;
/* ---------- 市場戰況（競爭對手 & 市佔率）---------- */
function openMarketWar(){
  const regions = unlockedSellRegions();
  const blocks = regions.map(r=>{
    const m=MARKETS[r], myShare=marketShare(r), comps=competitorsFor(r);
    // 市佔長條：你 + 各對手 + 其他
    const segs = [`<span class="ms-seg ms-you" style="width:${(myShare*100).toFixed(1)}%" title="你 ${(myShare*100).toFixed(0)}%"></span>`];
    comps.forEach((c,i)=> segs.push(`<span class="ms-seg ms-c${i}" style="width:${(compShare(r,c)*100).toFixed(1)}%"></span>`));
    const other = Math.max(0, 1 - myShare - comps.reduce((s,c)=>s+compShare(r,c),0));
    segs.push(`<span class="ms-seg ms-other" style="width:${(other*100).toFixed(1)}%"></span>`);
    const sizeTag = c=> c.size>=1.1?"🏢大型":c.size>=0.7?"連鎖":c.size>=0.35?"小型":"萎縮";
    const compRows = comps.map((c,i)=>{
      const cost=acquireCost(r,c), can=S.resource>=cost;
      return `<div class="war-comp">
        <div class="wc-line"><span class="wc-dot ms-c${i}"></span>${c.emoji} ${c.name}
          <span class="wc-style">${c.style}・${sizeTag(c)}</span>
          <span class="wc-stat">定價×${c.price.toFixed(2)}・品質${"★".repeat(Math.max(1,Math.round(c.quality*2)))}・${(compShare(r,c)*100).toFixed(0)}%</span></div>
        <button class="wc-buy ${can?'':'cant'}" ${can?`onclick="acquireCompetitor('${r}','${c.id}')"`:''}>🤝 併購　${money(cost)}</button>
      </div>`;
    }).join("");
    const ad = adActive(r);
    const adLeft = ad ? Math.ceil((S.ads[r]-Date.now())/1000) : 0;
    const bp = brandPower(r);
    return `<div class="war-region">
      <div class="war-head">${m.flag} ${m.name}　<b style="color:var(--success)">你 ${(myShare*100).toFixed(0)}%</b>${comps.length===0?' 👑壟斷':''}</div>
      <div class="ms-bar">${segs.join("")}</div>
      <div class="war-you">🧋 你的店：定價×${priceLevel(r).toFixed(1)}・品質${"★".repeat(Math.max(1,Math.round(playerQuality()*2)))}${bp>1?`・品牌力×${bp.toFixed(2)}`:''}${ad?`・📢廣告中 ${adLeft}s`:''}</div>
      ${compRows || '<div class="war-you" style="opacity:.7">✅ 此區對手已全數退場/被併購，你獨佔市場（仍有「不買」客流）</div>'}
      <button class="ghost war-ad ${ad?'on':''}" ${ad?'':`onclick="launchAd('${r}')"`}>${ad?`📢 廣告投放中（${adLeft}s）`:`📢 砸廣告搶市佔　${money(adCost(r))}`}</button>
    </div>`;
  }).join("");
  openModal(`<h2>📊 市場戰況</h2>
    <p style="font-size:12px;opacity:.7">各區有 AI 連鎖店跟你搶客。<b>市佔率</b>＝你的吸引力 ÷（你＋對手＋不買）。吸引力＝低定價 × 高品質 × 廣告。市佔越高，該區實際需求越多。</p>
    <div class="how-win">💡 搶市佔：<b>降定價</b>（🏪零售經營）、<b>拼品質</b>（做高階配方＋🧪品質投資）、<b>砸廣告</b>（2分鐘×${adAttractBoost().toFixed(2)}）、<b>🤝併購對手</b>（吸收品牌力永久加成）。<br>⚠️ 對手會<b>擴張坐大</b>（市佔高→規模滾雪球），輸家會<b>倒閉退場</b>。放著不管強敵會吃掉你的市場！</div>
    <button class="primary" style="background:linear-gradient(135deg,#7B6CC0,#5B4E9A)" onclick="openQuality()">🧪 品質投資（綜合品質 ${playerQuality().toFixed(2)}・加成×${qualityInvestMult().toFixed(2)}）</button>
    ${blocks || '<p style="opacity:.6">尚未在任何海外區開店。先去地圖展店進場競爭。</p>'}
    <button class="ghost" onclick="closeModal()">關閉</button>`);
}
window.openMarketWar=openMarketWar;
/* ---------- 品質投資線 ---------- */
function investQuality(id){
  const q=QI_MAP[id]; if(!q) return;
  const cost=qualityInvestCost(q);
  if(q.cur==="rp"){ if((S.rp||0)<cost){ toast("研究點不足，去工廠用科技廠產 RP"); return; } S.rp-=cost; }
  else { if(S.resource<cost){ toast("資金不足"); return; } S.resource-=cost; }
  S.quality=S.quality||{}; S.quality[id]=qualityLevel(id)+1;
  if(navigator.vibrate) navigator.vibrate(10); confettiBurst();
  openQuality(); renderHeader();
}
window.investQuality=investQuality;
function openQuality(){
  const rows = QUALITY_INVEST.map(q=>{
    const lvl=qualityLevel(q.id), cost=qualityInvestCost(q);
    const isRp=q.cur==="rp", have=isRp?(S.rp||0):S.resource, can=have>=cost;
    const price=isRp?`${Math.round(cost)} RP`:money(cost);
    return `<div class="qi-row">
      <div class="qi-head"><span class="qi-name">${q.emoji} ${q.name}</span><span class="qi-lv">Lv.${lvl}</span></div>
      <div class="qi-desc">${q.desc}　<b>+${Math.round(q.per*100)}%/級</b>　目前 +${Math.round(q.per*lvl*100)}%</div>
      <button class="qi-buy ${can?'':'cant'}" ${can?`onclick="investQuality('${q.id}')"`:''}>投資升級　${price}</button>
    </div>`;
  }).join("");
  openModal(`<h2>🧪 品質投資</h2>
    <p style="font-size:12px;opacity:.7">直接砸錢/研究點提升品質，<b>獨立於你賣什麼飲料</b>。品質越高，市場戰的吸引力越強 → 搶更多市佔。就算賣平價飲料，也能靠投資做出高品質形象。</p>
    <div class="stat-list">
      <div class="stat-row"><span>🧪 品質投資加成</span><b class="tabular" style="color:var(--success)">×${qualityInvestMult().toFixed(2)}</b></div>
      <div class="stat-row"><span>⭐ 綜合品質（市場戰用）</span><b class="tabular">${playerQuality().toFixed(2)}　${"★".repeat(Math.max(1,Math.round(playerQuality()*2)))}</b></div>
      <div class="stat-row"><span>🔬 可用研究點</span><b class="tabular">${Math.floor(S.rp||0)} RP</b></div>
    </div>
    <div class="qi-list">${rows}</div>
    <button class="ghost" onclick="openMarketWar()">← 回市場戰況</button>
    <button class="ghost" onclick="closeModal()">關閉</button>`);
}
window.openQuality=openQuality;
function isBeltTool(t){ return t==="belt" || t==="fast_belt"; }
function selectTool(t){
  if((isBeltTool(t)||t==="merger") && t===selectedTool){   // 再點同一帶子/合流器 → 切換放置方向
    beltDir = DIR_ORDER[(DIR_ORDER.indexOf(beltDir)+1)%4];
    if(navigator.vibrate) navigator.vibrate(8);
  }
  selectedTool=t; renderPalette();
}

/* ---------- 拖曳鋪設 ---------- */
let dragging=false, dragLast=-1, dragMoved=false;
function cellFromPoint(x,y){
  const el = document.elementFromPoint(x,y);
  const c = el && el.closest && el.closest("[data-cell]");
  return c ? +c.dataset.cell : -1;
}
// 把 from 與 to 之間鋪成往 to 方向的帶子（或拖曳刪除）
function paintBetween(fromIdx, toIdx){
  const fx=fromIdx%GRID_COLS, fy=Math.floor(fromIdx/GRID_COLS);
  const tx=toIdx%GRID_COLS,   ty=Math.floor(toIdx/GRID_COLS);
  const dx=tx-fx, dy=ty-fy;
  if(Math.abs(dx)+Math.abs(dy)!==1) return;          // 只處理相鄰格
  const dir = dx===1?"right":dx===-1?"left":dy===1?"down":"up";
  if(isBeltTool(selectedTool)){
    beltDir = dir; const fast = selectedTool==="fast_belt";
    if(S.terrain[fromIdx]!=="water"){ const f=S.factory[fromIdx]; if(!f || f.t==="belt") S.factory[fromIdx]={t:"belt",dir,fast}; }
    if(S.terrain[toIdx]!=="water"){ const t=S.factory[toIdx]; if(!t){ S.factory[toIdx]={t:"belt",dir,fast}; } else if(t.t==="belt"){ t.dir=dir; t.fast=fast; } }
  }else if(selectedTool==="delete"){
    [fromIdx,toIdx].forEach(i=>{ const c=S.factory[i]; if(c&&c.t==="machine") removeMachine(i,true); else if(c) S.factory[i]=null; });
  }
}
let panLastX=0, panLastY=0;
const ptrs=new Map();                 // 目前按住的指標（多指偵測）
let panMode=false, panCx=0, panCy=0, gestureWasPan=false;
function ptrCentroid(){ let x=0,y=0,n=0; for(const p of ptrs.values()){x+=p.x;y+=p.y;n++;} return {x:n?x/n:0, y:n?y/n:0, n}; }
function bindFactoryDrag(){
  const grid=document.getElementById("factoryGrid");
  const wrap=document.getElementById("factoryWrap");
  grid.addEventListener("pointerdown", e=>{
    ptrs.set(e.pointerId,{x:e.clientX,y:e.clientY});
    grid.setPointerCapture?.(e.pointerId);
    if(ptrs.size>=2){                                   // 雙指 → 平移
      panMode=true; gestureWasPan=true; dragging=false;
      const c=ptrCentroid(); panCx=c.x; panCy=c.y;
    }else{                                              // 單指 → 可能建造
      dragging=true; dragMoved=false; gestureWasPan=(selectedTool==="move");
      panLastX=e.clientX; panLastY=e.clientY;
      dragLast=cellFromPoint(e.clientX,e.clientY);
    }
  });
  grid.addEventListener("pointermove", e=>{
    if(ptrs.has(e.pointerId)) ptrs.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(panMode || ptrs.size>=2){                        // 雙指平移
      const c=ptrCentroid(); panX += c.x-panCx; panY += c.y-panCy; panCx=c.x; panCy=c.y; applyPan(); return;
    }
    if(!dragging) return;
    if(selectedTool==="move"){                          // ✋ 單指平移
      panX += e.clientX-panLastX; panY += e.clientY-panLastY;
      panLastX=e.clientX; panLastY=e.clientY; dragMoved=true; applyPan(); return;
    }
    if(selectedTool==="blueprint"){                     // 📐 藍圖：拖曳框選範圍
      const idx=cellFromPoint(e.clientX,e.clientY); if(idx<0) return;
      dragMoved=true; bpShowSelect(dragLast, idx); return;
    }
    if(!isBeltTool(selectedTool) && selectedTool!=="delete") return;  // 只有帶子/刪除支援拖曳鋪設
    const idx=cellFromPoint(e.clientX,e.clientY);
    if(idx<0 || idx===dragLast) return;
    paintBetween(dragLast, idx); updateCells([dragLast, idx]);        // 增量更新
    dragMoved=true; dragLast=idx;
  });
  const end=e=>{
    if(e && ptrs.has(e.pointerId)) ptrs.delete(e.pointerId);
    if(ptrs.size>=2){ const c=ptrCentroid(); panCx=c.x; panCy=c.y; return; }
    if(ptrs.size===0){
      if(selectedTool==="blueprint"){
        if(dragMoved){ bpCapture(dragLast, cellFromPoint(e?e.clientX:0, e?e.clientY:0)); bpHideSelect(); }
        else if(dragLast>=0 && bpClip){ bpPaste(dragLast); }            // 單點 → 貼上
        else if(dragLast>=0) toast("拖曳框選一段產線來複製");
      }
      else if(dragging && !dragMoved && !gestureWasPan && dragLast>=0) buildAt(dragLast);  // 單點建造
      else if(dragMoved && selectedTool!=="move" && !panMode) renderFactoryStats();
      dragging=false; dragLast=-1; panMode=false; gestureWasPan=false;
    }else{ panMode=false; }
  };
  grid.addEventListener("pointerup", end);
  grid.addEventListener("pointercancel", end);
  // 桌機：滑鼠滾輪平移
  wrap.addEventListener("wheel", e=>{
    e.preventDefault();
    if(e.ctrlKey){ zoomBy(e.deltaY<0?1.1:0.9); return; }   // Ctrl+滾輪 → 縮放
    if(e.shiftKey){ panX -= e.deltaY + e.deltaX; }
    else { panX -= e.deltaX; panY -= e.deltaY; }
    applyPan();
  }, {passive:false});
}

/* ---------- 藍圖：框選複製 / 貼上重建 ---------- */
let bpClip = null;                    // {w,h,cells:[{dx,dy,cell}]}
function rectOf(a,b){
  const ax=a%GRID_COLS, ay=Math.floor(a/GRID_COLS), bx=b%GRID_COLS, by=Math.floor(b/GRID_COLS);
  return {x0:Math.min(ax,bx), y0:Math.min(ay,by), x1:Math.max(ax,bx), y1:Math.max(ay,by)};
}
function bpShowSelect(a,b){
  const el=document.getElementById("bpSelect"); if(!el) return;
  const r=rectOf(a,b);
  el.classList.remove("hidden");
  el.style.left=(r.x0*CELL_PX)+"px"; el.style.top=(r.y0*CELL_PX)+"px";
  el.style.width=((r.x1-r.x0+1)*CELL_PX)+"px"; el.style.height=((r.y1-r.y0+1)*CELL_PX)+"px";
}
function bpHideSelect(){ const el=document.getElementById("bpSelect"); if(el) el.classList.add("hidden"); }
function bpCapture(a,b){
  if(a<0||b<0) return;
  const r=rectOf(a,b), cells=[];
  for(let y=r.y0;y<=r.y1;y++) for(let x=r.x0;x<=r.x1;x++){
    const idx=y*GRID_COLS+x, c=S.factory[idx];
    if(c) cells.push({dx:x-r.x0, dy:y-r.y0, cell:JSON.parse(JSON.stringify(c))});
  }
  if(cells.length){ bpClip={w:r.x1-r.x0+1, h:r.y1-r.y0+1, cells}; toast(`📐 已複製 ${cells.length} 格 — 點一下即可貼上`); }
  else { bpClip=null; toast("框選範圍內沒有東西"); }
  renderPalette();
}
function bpPaste(anchor){
  if(!bpClip){ toast("先拖曳框選一段產線來複製"); return; }
  const ax=anchor%GRID_COLS, ay=Math.floor(anchor/GRID_COLS);
  let placed=0, cost=0;
  for(const {dx,dy,cell} of bpClip.cells){
    const tx=ax+dx, ty=ay+dy; if(!inBounds(tx,ty)) continue;
    const tidx=ty*GRID_COLS+tx; if(S.factory[tidx]) continue;          // 已佔用 → 跳過
    const terr=S.terrain[tidx]||"plain", res=S.resources&&S.resources[tidx];
    if(cell.t==="machine"){
      const def=GEN_MAP[cell.id];
      if(res && !(def.kind==="source"&&def.material===res)) continue;   // 產地限制
      if(!canPlaceOn(terr,def)) continue;                               // 地形限制
      const cc=genCost(def); if(S.resource<cost+cc) continue;
      cost+=cc; S.generators[cell.id]=(S.generators[cell.id]||0)+1;
      S.factory[tidx]=JSON.parse(JSON.stringify(cell));
    }else{                                                              // 帶子/分流/合流/橋接
      if(terr==="water") continue;
      const cc=ADV_BELT_COST[cell.t]||0; if(S.resource<cost+cc) continue;
      cost+=cc; S.factory[tidx]=JSON.parse(JSON.stringify(cell));
    }
    placed++;
  }
  S.resource-=cost;
  if(navigator.vibrate) navigator.vibrate(12);
  toast(placed? `📐 貼上 ${placed} 格，花費 ${money(cost)}` : "這裡放不下（被佔用/地形/不夠錢）");
  renderGenList();
}

/* ---------- 批次升級 ---------- */
function batchTargets(modId){
  const mod=MODULES[modId];
  return S.factory.map((c,i)=>({c,i})).filter(x=>x.c&&x.c.t==="machine"&&mod.kinds.includes(GEN_MAP[x.c.id].kind));
}
function batchCost(modId){
  return batchTargets(modId).reduce((s,x)=>s+moduleCost(GEN_MAP[x.c.id], MODULES[modId], modLvl(x.c,modId)), 0);
}
function openBatchUpgrade(){
  const rows = Object.keys(MODULES).map(mid=>{
    const mod=MODULES[mid]; const ts=batchTargets(mid); if(!ts.length) return "";
    const cost=batchCost(mid); const can=S.resource>=cost;
    return `<div class="mod-row">
      <div class="mod-ico">${mod.icon}</div>
      <div class="mod-info"><div class="mod-name">${mod.name}</div>
        <div class="mod-eff">全部 ${ts.length} 台各 +1 級</div></div>
      <button class="mod-buy ${can?'':'cant'}" ${can?`onclick="batchUpgrade('${mid}')"`:''}>升級<span class="tabular">${money(cost)}</span></button>
    </div>`;
  }).join("");
  openModal(`<h2>⬆️ 批次升級</h2>
    <p style="font-size:13px;opacity:.7">一鍵把同模塊在所有適用機台各升一級</p>
    <div class="mod-list">${rows||'<p>還沒有機台可升級</p>'}</div>
    <button class="ghost" onclick="closeModal()">關閉</button>`);
}
function batchUpgrade(modId){
  const ts=batchTargets(modId); const cost=batchCost(modId);
  if(S.resource<cost){ toast("錢不夠批次升級"); return; }
  S.resource-=cost;
  ts.forEach(x=>{ x.c.mods=x.c.mods||{}; x.c.mods[modId]=(x.c.mods[modId]||0)+1; });
  if(navigator.vibrate) navigator.vibrate(12);
  openBatchUpgrade(); renderGenList();
}
window.batchUpgrade=batchUpgrade;

/* ---------- 配方圖鑑 ---------- */
function drinkUnlockLabel(id){
  const d=DRINKS[id]; if(!d.unlock) return "預設可用";
  if(d.unlock.type==="stores"){ const have=Object.keys(S.landmarks).length; return `開 ${d.unlock.n} 間分店（現 ${have}/${d.unlock.n}）`; }
  if(d.unlock.type==="region"){ const r=REGIONS[regionIndex(d.unlock.region)]; return `在 ${r.flag}${r.name} 開店`; }
  if(d.unlock.type==="research"){ return `研究「${RESEARCH_MAP[d.unlock.tech]?.name||"精製工藝"}」科技`; }
  return "";
}
function openRecipeBook(){
  const rows = Object.keys(DRINKS).map(id=>{
    const d=DRINKS[id], ok=drinkUnlocked(id);
    const need = Object.entries(d.recipe).map(([m,n])=>`${MATERIAL_ICON[m]}×${n}`).join(" ");
    return `<div class="recipe-row ${ok?'':'locked'}">
      <div class="recipe-ico">${d.icon}</div>
      <div class="recipe-info">
        <div class="recipe-name">${d.name}　<span class="recipe-val">售價×${d.value}</span></div>
        <div class="recipe-need">原料：${need}</div>
        <div class="recipe-unlock">${ok?'✅ 已解鎖':'🔒 '+drinkUnlockLabel(id)}</div>
      </div></div>`;
  }).join("");
  openModal(`<h2>🍹 飲料配方</h2>
    <p style="font-size:12.5px;opacity:.7">在調製站可切換配方；去 🗺️地圖 展店解鎖更多高價飲料</p>
    <div class="recipe-book">${rows}</div>
    <button class="ghost" onclick="closeModal()">關閉</button>`);
}
window.openRecipeBook=openRecipeBook;

/* ---------- 隨機事件 ---------- */
const EVENTS = [
  {id:"viral",    icon:"🔥", name:"爆紅打卡", desc:"售價 ×2",       dur:30, color:"#E0532A", mult:{price:2}},
  {id:"harvest",  icon:"🌾", name:"食材豐收", desc:"全廠速度 ×2",   dur:30, color:"#8BB174", mult:{speed:2}},
  {id:"tourism",  icon:"🚌", name:"觀光人潮", desc:"銷售產能 ×1.5", dur:40, color:"#9B8AB8", mult:{sell:1.5}},
  {id:"sunny",    icon:"☀️", name:"好天氣",   desc:"全部 ×1.3",     dur:35, color:"#E0A03C", mult:{price:1.3,speed:1.3,sell:1.3,prod:1.3}},
  {id:"festival", icon:"🎏", name:"夜市祭典", desc:"售價×1.5 銷量×1.5", dur:35, color:"#C97B84", mult:{price:1.5,sell:1.5}},
  {id:"shortage", icon:"⚠️", name:"原料短缺", desc:"生產 ×0.5",     dur:20, color:"#B8AFA4", mult:{prod:0.5}},
];
const EVENT_MAP = Object.fromEntries(EVENTS.map(e=>[e.id,e]));
function activeEvent(){ return (S.event && EVENT_MAP[S.event.id]) ? EVENT_MAP[S.event.id] : null; }
function eventMult(key){ const e=activeEvent(); return (e && e.mult[key]!==undefined) ? e.mult[key] : 1; }
function eventTick(){
  const now = Date.now();
  if(S.event && now >= S.event.endsAt){ S.event=null; renderEventBanner(); }
  if(!S.event && now >= (S.nextEventAt||0)){
    const e = EVENTS[Math.floor(Math.random()*EVENTS.length)];
    S.event = { id:e.id, endsAt: now + e.dur*1000 };
    S.nextEventAt = now + Math.round((70 + Math.random()*90)*1000);   // 70~160 秒後再來
    toast(`${e.icon} 事件：${e.name}（${e.desc}）`);
    if(navigator.vibrate) navigator.vibrate([10,40,10]);
    renderEventBanner();
  }
}
function renderEventBanner(){
  const el = document.getElementById("eventBanner"); if(!el) return;
  const e = activeEvent();
  if(!e){ el.classList.add("hidden"); return; }
  const left = Math.max(0, Math.ceil((S.event.endsAt - Date.now())/1000));
  el.classList.remove("hidden");
  el.style.background = e.color;
  el.innerHTML = `${e.icon} <b>${e.name}</b>　${e.desc}　<span class="ev-timer tabular">${left}s</span>`;
}

/* ---------- 風險決策事件（穩健 vs 賭一把）---------- */
function gainMoney(x){ S.resource+=x; S.lifetimeResource+=x; }
function startEvent(id, dur){ S.event={id, endsAt:Date.now()+dur*1000}; renderEventBanner(); }
const DECISIONS = [
  {id:"bigorder", icon:"📞", title:"神秘大批發單", color:"#C89B6E",
    desc:"大型通路客戶想簽一筆大量批發合約，但要先壓一筆備貨訂金。",
    options:[
      {label:"穩健接單（保底）", outcome:()=>{ const g=Math.max(500, opsPerSec()*30); gainMoney(g); return `穩穩出貨收款 ${money(g)}`; }},
      {label:"賭大的（押 30% 資源備貨）", outcome:()=>{ const bet=S.resource*0.3; S.resource-=bet; if(Math.random()<0.5){ const wgain=bet*2.5; gainMoney(wgain); return `🎉 大單成交！收款 ${money(wgain)}`; } return `💸 客戶臨時取消，備貨成本賠了 ${money(bet)}`; }},
    ]},
  {id:"typhoon", icon:"🌀", title:"颱風警報", color:"#5B8DA0",
    desc:"颱風要來了，停工避險還是照常營業搶單？",
    options:[
      {label:"停工避險（安全）", outcome:()=>{ startEvent("shortage",10); return "暫時減產，但毫髮無傷"; }},
      {label:"照常營業（賭一把）", outcome:()=>{ if(Math.random()<0.55){ startEvent("viral",30); return "🎉 對手都關門，你爆單！"; } startEvent("shortage",25); return "⚠️ 設備泡水，短暫降速"; }},
    ]},
  {id:"foodsafety", icon:"🦠", title:"食安謠言", color:"#B8AFA4",
    desc:"網路瘋傳對你不利的謠言。",
    options:[
      {label:"花錢公關（穩）", outcome:()=>{ const c=Math.min(S.resource, opsPerSec()*40); S.resource-=c; return `花 ${money(c)} 滅火，風波平息`; }},
      {label:"相信品牌力（賭）", outcome:()=>{ if(Math.random()<0.5){ startEvent("viral",25); return "🎉 反而越罵越紅！"; } startEvent("shortage",20); return "⚠️ 客人卻步，生意暫時下滑"; }},
    ]},
  {id:"grant", icon:"🔬", title:"研究補助", color:"#9B8AB8",
    desc:"政府開放科技補助申請。",
    options:[
      {label:"保守申請（穩）", outcome:()=>{ const r=Math.max(80, rpRate()*30); S.rp=(S.rp||0)+r; return `穩拿 ${fmt(r)} 研究點`; }},
      {label:"大膽提案（賭）", outcome:()=>{ if(Math.random()<0.45){ const r=Math.max(300, rpRate()*120); S.rp=(S.rp||0)+r; return `🎉 補助過件！+${fmt(r)} 研究點`; } return "❌ 提案被退，沒拿到"; }},
    ]},
];
const DECISION_MAP = Object.fromEntries(DECISIONS.map(d=>[d.id,d]));
function decisionTick(){
  const now=Date.now();
  if(!S.pendingDecision && now >= (S.nextDecisionAt||0)){
    const d = DECISIONS[Math.floor(Math.random()*DECISIONS.length)];
    S.pendingDecision = d.id;
    S.nextDecisionAt = now + Math.round((110 + Math.random()*120)*1000);   // 110~230 秒
    toast(`${d.icon} 決策事件：${d.title}（點橫條選擇）`);
    if(navigator.vibrate) navigator.vibrate([10,40,10,40,10]);
    renderDecisionBanner();
  }
}
function renderDecisionBanner(){
  const el=document.getElementById("decisionBanner"); if(!el) return;
  const d = S.pendingDecision ? DECISION_MAP[S.pendingDecision] : null;
  if(!d){ el.classList.add("hidden"); return; }
  el.classList.remove("hidden"); el.style.background=d.color;
  el.innerHTML = `${d.icon} <b>決策：${d.title}</b>　👉 點此選擇`;
}
function openDecision(){
  const d = S.pendingDecision ? DECISION_MAP[S.pendingDecision] : null; if(!d) return;
  const opts = d.options.map((o,i)=>`<button class="${i===0?'primary':'ghost'}" onclick="decideOption(${i})">${o.label}</button>`).join("");
  openModal(`<h2>${d.icon} ${d.title}</h2>
    <p style="font-size:13.5px;opacity:.85">${d.desc}</p>
    <div class="decide-opts">${opts}</div>`);
}
function decideOption(i){
  const d = S.pendingDecision ? DECISION_MAP[S.pendingDecision] : null; if(!d) return;
  const result = d.options[i].outcome();
  S.pendingDecision = null;
  if(navigator.vibrate) navigator.vibrate(12);
  closeModal(); renderDecisionBanner(); renderHeader();
  toast(result);
}
window.openDecision=openDecision; window.decideOption=decideOption;

/* ---------- 寵物 UI ---------- */
function renderPetCompanion(){
  const btn = document.getElementById("petBtn"); if(!btn) return;
  const a = activePet();
  btn.innerHTML = a
    ? `<span class="pet-emoji">${PETS[a].emoji}</span><span class="pet-mini">Lv.${petLevel(a)}</span>`
    : `<span class="pet-emoji">🐾</span>`;
  btn.classList.toggle("sad", a && petHappy()<35);
}
function openPet(){
  const a = activePet();
  let head;
  if(a){
    const def=PETS[a], lvl=petLevel(a), o=S.pet.owned[a], hap=petHappy();
    const need=petXpNeed(lvl), cost=petFeedCost(lvl);
    head = `<div class="pet-hero">
      <div class="pet-big">${def.emoji}</div>
      <div class="pet-name">${def.name} <small>Lv.${lvl}</small></div>
      <div class="pet-eff">${def.desc(lvl)}　<span style="opacity:.6">×效力 ${Math.round(petHappyFactor()*100)}%</span></div>
      <div class="pet-haprow">❤️ 快樂度 <div class="bar"><i style="width:${hap}%;background:${hap<35?'#D9534F':'var(--success)'}"></i></div> ${hap}%</div>
      <div class="pet-xprow">⭐ 經驗 <div class="bar"><i style="width:${Math.round((o.xp||0)/need*100)}%"></i></div> ${o.xp||0}/${need}</div>
      <button class="primary ${S.resource>=cost?'':'cant'}" ${S.resource>=cost?`onclick="feedPet()"`:''}>🍖 餵食（+經驗 +快樂）　${money(cost)}</button>
    </div>`;
  }else{
    head = `<p style="opacity:.75;font-size:13px">領養一隻店寵當夥伴，提供永久被動加成，記得常餵食保持快樂！</p>`;
  }
  const roster = Object.keys(PETS).map(id=>{
    const def=PETS[id], owned=petOwned(id), active=activePet()===id;
    let right;
    if(active) right = `<span class="pet-tag using">使用中</span>`;
    else if(owned) right = `<button class="mod-buy" onclick="setActivePet('${id}')">設為夥伴</button>`;
    else right = `<button class="mod-buy ${S.resource>=def.adopt?'':'cant'}" ${S.resource>=def.adopt?`onclick="adoptPet('${id}')"`:''}>領養 ${money(def.adopt)}</button>`;
    return `<div class="pet-row ${active?'active':''}">
      <div class="pet-row-emoji">${def.emoji}</div>
      <div class="pet-row-info"><div class="pet-row-name">${def.name}${owned?` <small>Lv.${petLevel(id)}</small>`:''}</div>
        <div class="pet-row-eff">${def.desc(owned?petLevel(id):1)}</div></div>
      ${right}</div>`;
  }).join("");
  openModal(`<h2>🐾 店寵</h2>${head}
    <div class="pet-roster">${roster}</div>
    <button class="ghost" onclick="closeModal()">關閉</button>`);
}
function adoptPet(id){
  const def=PETS[id]; if(petOwned(id)) return;
  if(S.resource<def.adopt){ toast("資源不足"); return; }
  S.resource-=def.adopt;
  S.pet.owned[id]={lvl:1, xp:0};
  if(!S.pet.active) S.pet.active=id;
  S.pet.lastFed=Date.now();
  confettiBurst(); if(navigator.vibrate) navigator.vibrate(14);
  openPet(); renderPetCompanion(); renderHeader();
}
function setActivePet(id){ if(!petOwned(id)) return; S.pet.active=id; openPet(); renderPetCompanion(); }
function feedPet(){
  const a=activePet(); if(!a) return;
  const o=S.pet.owned[a], lvl=o.lvl, cost=petFeedCost(lvl);
  if(S.resource<cost){ toast("資源不足"); return; }
  S.resource-=cost; S.pet.lastFed=Date.now();
  o.xp=(o.xp||0)+1;
  if(o.xp>=petXpNeed(lvl)){ o.xp=0; o.lvl++; toast(`${PETS[a].name} 升到 Lv.${o.lvl}！`); confettiBurst(); }
  if(navigator.vibrate) navigator.vibrate(10);
  openPet(); renderPetCompanion(); renderHeader();
}
window.openPet=openPet; window.adoptPet=adoptPet; window.setActivePet=setActivePet; window.feedPet=feedPet;

/* ---------- 科技研究樹 UI ---------- */
function openResearch(){
  const hasLab = S.factory.some(c=>c&&c.t==="machine"&&GEN_MAP[c.id].kind==="lab");
  let html = `<div class="rp-bar">🔬 研究點 <b class="tabular">${fmt(S.rp||0)}</b>　<span style="opacity:.6;font-size:12px">+${rpRate().toFixed(1)}/秒</span></div>
    <p style="font-size:11.5px;opacity:.7;margin:2px 0 0;text-align:left">${hasLab?'把飲料用輸送帶送進 🔬科技廠 即可產出研究點':'⚠️ 先在工廠蓋一座 🔬科技廠，把飲料送進去才有研究點'}</p>
    <div class="talent-tree">`;
  for(const branch of RESEARCH_TREE){
    const bp = researchBranchPoints(branch.id);
    html += `<div class="t-branch"><div class="t-branch-head" style="color:${branch.color}">${branch.icon} ${branch.name}<small>${bp} 級</small></div>`;
    let prev=0;
    for(const t of branch.nodes){
      if(t.tier!==prev && prev!==0) html += `<div class="t-link">⋮</div>`;
      prev=t.tier;
      const L=researchLevel(t.id), maxed=L>=t.max, unlocked=researchUnlocked(t), cost=researchCost(t);
      const can = unlocked && !maxed && (S.rp||0)>=cost;
      const cls=["t-node"]; if(!unlocked)cls.push("locked"); if(L>0)cls.push("owned");
      html += `<div class="${cls.join(' ')}" ${can?`onclick="buyResearch('${t.id}')"`:''} style="${L>0?`border-color:${branch.color}`:''}">
        <div class="t-node-ico">${t.icon}</div>
        <div class="t-node-info"><div class="t-node-name">${t.name} <small>Lv.${L}/${t.max}</small></div>
          <div class="t-node-eff">${unlocked?t.eff(maxed?L:L+1):`🔒 需「${branch.name}」累積 ${t.req} 級`}</div></div>
        <div class="t-node-cost">${maxed?'<span class="lock-tag">MAX</span>':(unlocked?`🔬${fmt(cost)}`:'🔒')}</div>
      </div>`;
    }
    html += `</div>`;
  }
  html += `</div>`;
  openModal(`<h2>🔬 科技研究</h2>
    <p style="font-size:12px;opacity:.7;margin:2px 0 0">蓋好工廠衝高出貨 → 累積研究點 → 解鎖更強科技</p>
    ${html}
    <button class="ghost" onclick="closeModal()">關閉</button>`);
}
function buyResearch(id){
  const t = RESEARCH_MAP[id], L = researchLevel(id);
  if(L>=t.max){ toast("已達最高等級"); return; }
  if(!researchUnlocked(t)){ toast("需先研究前置科技"); return; }
  const cost = researchCost(t);
  if((S.rp||0) < cost){ toast("研究點不足，去衝高出貨量！"); return; }
  S.rp -= cost; S.research = S.research||{}; S.research[id] = L+1;
  if(navigator.vibrate) navigator.vibrate(12);
  openResearch(); renderGenList();
}
window.openResearch=openResearch; window.buyResearch=buyResearch;

/* ---------- B2B 批發通路訂單 ---------- */
const ORDER_SLOTS = 3;
const WHOLESALE_CLIENTS = [
  {name:"7-11 全台鋪貨",  emoji:"🏪"},
  {name:"全家便利商店",   emoji:"🏪"},
  {name:"科技公司尾牙",   emoji:"🏢"},
  {name:"外送平台合約",   emoji:"🛵"},
  {name:"連鎖飯店供應",   emoji:"🏨"},
  {name:"大學園遊會",     emoji:"🎓"},
  {name:"航空公司餐飲",   emoji:"✈️"},
  {name:"百貨週年慶",     emoji:"🛍️"},
];
function genOrder(){
  const drinks = unlockedDrinks();
  const drink = drinks[Math.floor(Math.random()*drinks.length)];
  const tier = S.ordersCompleted||0;
  // 批發＝大量：基數較大，隨完成數成長
  const target = Math.max(40, Math.round((50 + tier*18) * (0.7+Math.random()*0.8)));
  const reward = Math.max(120, Math.round(target * PRICE_PER_DRINK * DRINKS[drink].value * globalMult() * 4 * wholesaleMult()));
  const client = WHOLESALE_CLIENTS[Math.floor(Math.random()*WHOLESALE_CLIENTS.length)];
  return { id: S.nextOrderId++, drink, target, progress:0, reward, client };
}
function ensureOrders(){
  if(!Array.isArray(S.orders)) S.orders=[];
  while(S.orders.length < ORDER_SLOTS) S.orders.push(genOrder());
}
function orderDone(o){ return o.progress >= o.target; }
function claimableOrders(){ return (S.orders||[]).filter(orderDone).length; }
function claimOrder(id){
  const i = S.orders.findIndex(o=>o.id===id); if(i<0) return;
  const o = S.orders[i]; if(!orderDone(o)){ return; }
  S.resource += o.reward; S.lifetimeResource += o.reward;
  S.ordersCompleted = (S.ordersCompleted||0)+1;
  S.orders.splice(i,1); S.orders.push(genOrder());
  if(navigator.vibrate) navigator.vibrate(14);
  confettiBurst();
  openOrders(); renderHeader(); updateOrderBtn();
}
function openOrders(){
  ensureOrders();
  const rows = S.orders.map(o=>{
    const d = DRINKS[o.drink]; const done = orderDone(o);
    const cl = o.client || {name:"批發訂單", emoji:"📦"};
    const pct = Math.min(100, Math.round(o.progress/o.target*100));
    return `<div class="order-row ${done?'done':''}">
      <div class="order-ico">${cl.emoji}</div>
      <div class="order-info">
        <div class="order-name">${cl.name}　<span class="order-rew">款項 ${money(o.reward)}</span></div>
        <div class="order-sub">需 ${d.icon}${d.name} ×${o.target}</div>
        <div class="bar"><i style="width:${pct}%"></i></div>
        <div class="order-prog tabular">${Math.min(o.progress,o.target)} / ${o.target}</div>
      </div>
      ${done?`<button class="mod-buy" onclick="claimOrder(${o.id})">出貨收款</button>`
            :`<span class="order-wait">備貨中</span>`}
    </div>`;
  }).join("");
  const hasOrderStation = S.factory.some(c=>c&&c.t==="machine"&&GEN_MAP[c.id].kind==="order");
  openModal(`<h2>📦 批發通路</h2>
    <p style="font-size:12.5px;opacity:.7">便利商店、企業、外送平台的<b>大量批發單</b>（B2B）。${hasOrderStation?'把指定飲料用輸送帶送進 📦批發站 即可備貨；完成後自動換新單。':'⚠️ 先在工廠蓋一座 📦批發站，把飲料送進去才會備貨。'}<br>批發走的是工廠產能，與 🏪零售（B2C 散客）<b>互搶產出</b>——要用分流器分配多少給批發、多少留著零售賣。</p>
    <div class="order-list">${rows}</div>
    <button class="ghost" onclick="closeModal()">關閉</button>`);
}
function updateOrderBtn(){
  const b=document.getElementById("btnOrders"); if(!b) return;
  const n=claimableOrders();
  b.textContent = n>0 ? `📦 批發 (${n})` : "📦 批發";
  b.classList.toggle("ready", n>0);
}
window.claimOrder=claimOrder; window.openOrders=openOrders;


/* ---------- 清空地皮 ---------- */
function confirmClearFactory(){
  openModal(`<h2>🧹 清空地皮？</h2><p>所有機台與輸送帶將移除（機台退一半費用）。</p>
    <div class="row"><button class="ghost" onclick="closeModal()">取消</button>
    <button class="primary" style="background:var(--warning)" onclick="clearFactory()">確定清空</button></div>`);
}
function clearFactory(){
  for(let i=0;i<S.factory.length;i++){ const c=S.factory[i]; if(!c) continue; if(c.t==="machine") removeMachine(i,true); else S.factory[i]=null; }
  closeModal(); renderGenList(); toast("地皮已清空");
}
window.confirmClearFactory=confirmClearFactory; window.clearFactory=clearFactory; window.openBatchUpgrade=openBatchUpgrade;

let mapView = "world";                       // "world" 或 region id

function renderMap(){
  const world = document.getElementById("mapWorld");
  const region = document.getElementById("mapRegion");
  if(mapView==="world"){ world.classList.remove("hidden"); region.classList.add("hidden"); renderWorld(); }
  else{ world.classList.add("hidden"); region.classList.remove("hidden"); renderRegionDetail(mapView); }
}
function renderWorld(){
  const total = LANDMARKS.length;
  const unlocked = Object.keys(S.landmarks).length;
  const pct = Math.round(unlocked/total*100);
  document.getElementById("codexCount").textContent = `${unlocked} / ${total}`;
  document.getElementById("codexPct").textContent = `(${pct}%)`;
  document.getElementById("codexBar").style.width = pct+"%";
  // 零售經營按鈕：缺貨/爆滿/閒置時亮燈提醒
  const rb=document.getElementById("btnRetail");
  if(rb){ const st=retailStatus(); rb.innerHTML = `🏪 零售經營（雇店員賣貨賺錢）${st.lvl!=="green"?` <span class="retail-badge">${st.icon}</span>`:""}`; }
  // 通路 ↔ 工廠 的關係提示
  const cap = storeSellCapacity(), prod = factoryRate||0;
  const supEl = document.getElementById("codexSupply");
  if(supEl){
    let note;
    if(prod > cap*1.05) note = `🔴 工廠生產 ${prod.toFixed(1)} 超過銷售產能 — 多開分店就能多賺！`;
    else if(cap > prod*1.05) note = `🟡 銷售產能還有餘，回工廠衝高生產量`;
    else note = `🟢 產銷平衡`;
    supEl.innerHTML = `🏪 總銷售產能 <b class="tabular">${cap.toFixed(0)} 杯/秒</b>　｜　🏭 工廠生產 <b class="tabular">${prod.toFixed(1)}</b><br>${note}`;
  }

  let html = "";
  for(const r of REGIONS){
    const open = regionUnlocked(r.id);
    const rp = Math.round(regionPct(r.id)*100);
    const lms = regionLandmarks(r.id);
    const got = regionUnlockedCount(r.id), tot = lms.length;
    let lockOverlay = "";
    if(!open){
      const prev = REGIONS[regionIndex(r.id)-1];
      lockOverlay = `<div class="region-lock">🔒 先讓「${prev.name}」完成度達 ${Math.round(REGIONS[regionIndex(r.id)].needPrevPct*100)}%</div>`;
    }
    // 已蓋店家縮圖排：彩色=已蓋（旗艦店打★），灰點=未開
    let shelf;
    if(got===0){
      shelf = `<span class="shelf-empty">尚未開店，點我進去展店 →</span>`;
    }else{
      shelf = lms.map(l=>{
        const lvl = S.landmarks[l.id]||0;
        if(lvl===0) return `<span class="shelf-dot">·</span>`;
        return `<span class="shelf-lm" title="${l.name}">${l.emoji}${lvl>=3?'<sup>★</sup>':''}</span>`;
      }).join("");
    }
    html += `<div class="region-card ${open?'':'locked'}" ${open?`data-region="${r.id}"`:''}>
      <div class="region-top">
        <div class="region-flag">${r.flag}</div>
        <div class="region-info">
          <div class="region-name">${r.name}</div>
          <div class="region-tag">${r.tagline}　${got}/${tot} 間店</div>
          <div class="bar"><i style="width:${rp}%"></i></div>
        </div>
        <div class="region-pct tabular">${rp}%</div>
      </div>
      <div class="region-shelf">${shelf}</div>
      ${open && MARKETS[r.id] ? `<div class="region-mkt">
        <span>${marketTrend(r.id)} 售價×<b>${regionFactor(r.id).toFixed(2)}</b>　定價×${priceLevel(r.id).toFixed(1)}${MARKETS[r.id].logi>0?` <small>物流−${Math.round(MARKETS[r.id].logi*100)}%</small>`:''}</span>
        <button class="mkt-pick" onclick="event.stopPropagation();openRetail()">定價</button>
      </div>` : ''}
      ${lockOverlay}
    </div>`;
  }
  document.getElementById("regionList").innerHTML = html;
}
function setSellMarket(region){
  if(!regionUnlockedForSell(region)){ toast("此區尚未開店，無法在此銷售"); return; }
  S.sellMarket=region;
  if(navigator.vibrate) navigator.vibrate(8);
  renderMap(); renderGenList();
  toast(`改在 ${MARKETS[region].flag}${MARKETS[region].name} 銷售`);
}
window.setSellMarket=setSellMarket;
function renderRegionDetail(rid){
  const r = REGIONS[regionIndex(rid)];
  const got = regionUnlockedCount(rid), tot = regionLandmarks(rid).length;
  const pct = Math.round(regionPct(rid)*100);
  document.getElementById("regionTitle").innerHTML = `${r.flag} ${r.name}　<span class="tabular">${got}/${tot} (${pct}%)</span>`;
  document.getElementById("regionBar").style.width = pct+"%";

  let html = "";
  for(const b of regionBrands(rid)){
    const lms = LM_BY_BRAND[b.id];
    const cgot = lms.filter(l=>(S.landmarks[l.id]||0)>=1).length;
    const done = cgot===lms.length;
    html += `<div class="brand-group">
      <div class="brand-head">
        <span class="brand-name" style="color:${b.color}">📍 ${b.name}</span>
        <span class="brand-badge ${done?'done':''}">${cgot}/${lms.length}${done?` ・×${b.setBonus}`:''}</span>
      </div><div class="lm-grid">`;
    for(const l of lms){
      const lvl = S.landmarks[l.id]||0;
      const locked = lvl===0;
      const next = l.stages.find(s=>s.level===lvl+1);
      const can = locked ? S.resource>=l.unlockCost : (next && S.resource>=next.upgradeCost);
      const cls = ["lm"]; if(locked) cls.push("locked"); if(can) cls.push("upgradable"); if(done) cls.push("brand-done");
      const curSell = l.stages.filter(s=>s.level<=lvl).reduce((a,s)=>a+s.sellRate,0);
      let meta;
      if(locked) meta = `🔓 ${money(l.unlockCost)}`;
      else if(next) meta = `升→ ${money(next.upgradeCost)}`;
      else meta = "旗艦店 ★";
      html += `<div class="${cls.join(' ')}" data-lm="${l.id}">
        <div class="emoji">${l.emoji}</div>
        <div class="lm-name">${l.name}</div>
        ${locked?'':`<div class="lm-sell tabular">🏪 賣 ${curSell}/s</div>`}
        <div class="lm-meta tabular">${meta}</div></div>`;
    }
    html += `</div></div>`;
  }
  document.getElementById("brandList").innerHTML = html;
}

/* ---------- 成就 ---------- */
function renderAchievements(){
  const done = ACHIEVEMENTS.filter(a=>S.achievements[a.id]).length;
  document.getElementById("achCount").textContent = `${done} / ${ACHIEVEMENTS.length}`;
  const repEl = document.getElementById("repEl");
  if(repEl) repEl.textContent = `${S.achievementPoints} 點・全域產量 +${Math.round(reputationBonus()*100-100)}%`;
  let html = `<div class="ach-grid">`;
  for(const a of ACHIEVEMENTS){
    const got = !!S.achievements[a.id];
    html += `<div class="ach ${got?'done':'locked'}">
      <div class="ach-ico">${a.icon}</div>
      <div class="ach-name">${a.name}</div>
      <div class="ach-desc">${a.desc}</div>
      <div class="ach-tp">🏅 +${a.ap}</div>
    </div>`;
  }
  html += `</div>`;
  document.getElementById("achList").innerHTML = html;
}
function checkAchievements(){
  let changed = false;
  for(const a of ACHIEVEMENTS){
    if(!S.achievements[a.id] && a.check()){
      S.achievements[a.id] = true;
      S.achievementPoints += a.ap;
      changed = true;
      toast(`🏆 成就達成：${a.name}　+${a.ap} 招牌聲望 🏅`);
      confettiBurst();
    }
  }
  if(changed){ renderHeader(); if(isVisible("page-achieve")) renderAchievements(); }
}
function isVisible(id){ return !document.getElementById(id).classList.contains("hidden"); }
let talentTab = "prod";
function selectTalentTab(id){ talentTab = id; renderTalents(); }
window.selectTalentTab = selectTalentTab;
function renderTalents(){
  document.getElementById("tpEl").textContent = "× "+fmt(S.talentPoints);
  if(!TALENT_TREE.some(b=>b.id===talentTab)) talentTab = TALENT_TREE[0].id;
  // 分頁籤：每系一個，可購買時亮點
  const tabs = TALENT_TREE.map(b=>{
    const bp = branchPoints(b.id);
    const buyable = b.nodes.some(t=> talentUnlocked(t) && talentLevel(t.id)<t.max && S.talentPoints>=talentCost(t));
    const active = b.id===talentTab;
    return `<button class="t-tab ${active?'active':''}" onclick="selectTalentTab('${b.id}')" style="${active?`border-color:${b.color};color:${b.color}`:''}">
      ${b.icon}<span>${b.name}</span><small>${bp}</small>${buyable&&!active?'<i class="t-dot"></i>':''}</button>`;
  }).join("");
  const branch = TALENT_TREE.find(b=>b.id===talentTab);
  const rows = Math.max(...branch.nodes.map(n=>n.tier));   // 樹有幾階（列）
  const COLS = 3;
  const cx = col => (col+0.5)/COLS*100;                    // 節點中心 x（%）
  const cy = tier => (tier-0.5)/rows*100;                  // 節點中心 y（%）
  // 連線：每個節點 → 其前置（暗黑技能樹的分支線）
  let lines = "";
  for(const t of branch.nodes){
    if(!t.deps) continue;
    const lit = talentUnlocked(t);                         // 前置已滿足 → 線點亮
    for(const d of t.deps){
      const p = TALENT_MAP[d.id];
      lines += `<line x1="${cx(p.col)}" y1="${cy(p.tier)}" x2="${cx(t.col)}" y2="${cy(t.tier)}"
        stroke="${lit?branch.color:'#000'}" stroke-opacity="${lit?0.85:0.18}" stroke-width="${lit?2.4:1.6}" stroke-linecap="round"/>`;
    }
  }
  let nodes = "";
  for(const t of branch.nodes){
    const L = talentLevel(t.id);
    const maxed = L>=t.max;
    const depsOk = talentDepsOk(t);
    const sib = exclSibling(t);
    const unlocked = depsOk && !sib;
    const cost = talentCost(t);
    const can = unlocked && !maxed && S.talentPoints>=cost;
    const cls = ["t-node"]; if(!unlocked) cls.push("locked"); if(maxed) cls.push("maxed"); if(L>0) cls.push("owned"); if(can) cls.push("can"); if(t.excl) cls.push("fork");
    let msg;
    if(L>0 || unlocked) msg = t.eff(maxed?L:L+1);
    else if(sib) msg = `🚫 已選「${sib.name}」（二擇一）`;
    else if(!depsOk) msg = `🔒 ${talentReqText(t)}`;
    else msg = t.eff(L+1);
    nodes += `<div class="${cls.join(' ')}" ${can?`data-talent="${t.id}"`:''}
      style="grid-column:${t.col+1}; grid-row:${t.tier}; ${L>0?`border-color:${branch.color}; box-shadow:0 0 0 2px ${branch.color}55`:''}">
      ${t.excl?`<span class="t-fork-tag">⚔️二擇一</span>`:''}
      <div class="t-node-ico">${t.icon}</div>
      <div class="t-node-name">${t.name}</div>
      <div class="t-node-eff">${msg}</div>
      <div class="t-node-foot"><span class="t-node-lv">Lv.${L}/${t.max}</span>${maxed?'<span class="t-node-cost lock-tag">MAX</span>':`<span class="t-node-cost">${unlocked?`🌟${cost}`:'🔒'}</span>`}</div>
    </div>`;
  }
  document.getElementById("talentList").innerHTML = `
    <div class="t-tabs">${tabs}</div>
    <div class="t-branch">
      <div class="t-branch-head" style="color:${branch.color}">${branch.icon} ${branch.name}<small>${branchPoints(branch.id)} 點</small></div>
      <div class="t-grid" style="--rows:${rows}">
        <svg class="t-svg" viewBox="0 0 100 100" preserveAspectRatio="none">${lines}</svg>
        ${nodes}
      </div>
    </div>
    <button class="ghost respec-btn" onclick="respecTalents()">🔄 重置天賦（免費洗點，全額退還）</button>`;
  updateTalentTab();
}
function updateTalentTab(){
  const affordable = TALENTS.some(t=> talentUnlocked(t) && talentLevel(t.id)<t.max && S.talentPoints>=talentCost(t));
  const tab = document.getElementById("tab-talent");
  if(tab) tab.querySelector(".ico").textContent = affordable ? "🌟" : "⭐";
}
function buyTalent(t){
  const L = talentLevel(t.id);
  if(L>=t.max){ toast(`${t.name} 已滿級`); return; }
  const sib = exclSibling(t);
  if(sib){ toast(`🚫 已選「${sib.name}」流派，二擇一互斥。要改選請先 🔄 重置天賦`); return; }
  if(!talentDepsOk(t)){ toast(`🔒 需先點出前置：${talentReqText(t)}`); return; }
  const cost = talentCost(t);
  if(S.talentPoints < cost){ toast("天賦點不足，去轉型上市賺取！"); return; }
  S.talentPoints -= cost;
  S.talents[t.id] = L+1;
  if(navigator.vibrate) navigator.vibrate(10);
  renderTalents(); renderHeader(); renderGenList();
}
// 洗點：退還所有已花費的點數（成本 = 各節點 tier × L(L+1)/2 的總和）
function respecTalents(){
  let refund = 0;
  for(const t of TALENTS){ const L=talentLevel(t.id); refund += t.tier * L*(L+1)/2; }
  if(refund<=0){ toast("沒有可重置的天賦"); return; }
  S.talents = {};
  S.talentPoints += refund;
  if(navigator.vibrate) navigator.vibrate(12);
  renderTalents(); renderHeader(); renderGenList();
  toast(`已重置，退還 ${refund} 天賦點 🌟`);
}
window.respecTalents=respecTalents;
function renderAll(){ renderHeader(); renderGenList(); renderMap(); renderAchievements(); renderTalents(); renderPrestigeBtn(); renderPetCompanion(); }

/* =========================================================
   小工具：浮字 / 彩帶 / toast / modal
   ========================================================= */
function spawnFloat(e, text){
  const zone = document.querySelector(".cup-zone");
  const f = document.createElement("div");
  f.className="float"; f.textContent=text;
  const r = zone.getBoundingClientRect();
  const x = (e.clientX||r.left+r.width/2) - r.left;
  f.style.left = x+"px"; f.style.top = "70px";
  zone.appendChild(f); setTimeout(()=>f.remove(),900);
}
function confettiBurst(){
  const chars=["🧋","🎉","✨","🥤","🏆","💛"];
  for(let i=0;i<26;i++){
    const c=document.createElement("div");
    c.className="confetti"; c.textContent=chars[i%chars.length];
    c.style.left=(i/26*100)+"%";
    c.style.animationDuration=(1.2+ (i%5)*0.25)+"s";
    document.body.appendChild(c); setTimeout(()=>c.remove(),2600);
  }
}
let toastT;
function toast(msg){
  let t=document.getElementById("toast");
  if(!t){ t=document.createElement("div"); t.id="toast";
    t.style.cssText="position:fixed;left:50%;bottom:110px;transform:translateX(-50%);background:var(--cocoa);color:var(--cream);padding:10px 18px;border-radius:20px;font-size:13px;font-weight:700;z-index:80;box-shadow:var(--shadow);max-width:80%;text-align:center;";
    document.body.appendChild(t);
  }
  t.textContent=msg; t.style.opacity="1";
  clearTimeout(toastT); toastT=setTimeout(()=>t.style.opacity="0",1700);
}
function openModal(html){
  document.getElementById("modal").innerHTML=html;
  document.getElementById("overlay").classList.remove("hidden");
}
function closeModal(){ document.getElementById("overlay").classList.add("hidden"); }
window.closeModal=closeModal; window.doPrestige=doPrestige; window.doShare=doShare;

/* ---------- 設定 ---------- */
function openSettings(){
  openModal(`<h2>⚙️ 設定</h2>
    <button class="ghost" onclick="openHelp()">❓ 遊戲說明</button>
    <button class="ghost" onclick="replayTutorial()">🎓 重看新手教學</button>
    <button class="ghost" onclick="openStats()">📊 數據統計</button>
    <button class="ghost" onclick="toggleDark()">🌙 切換深色模式</button>
    <button class="ghost" onclick="closeModal();doShare()">📤 分享戰報</button>
    <button class="ghost" style="border-color:var(--warning);color:var(--warning)" onclick="resetGame()">🗑️ 重置存檔</button>
    <button class="primary" onclick="closeModal()">關閉</button>
    <p style="margin-top:14px;font-size:12px">手搖飲帝國 MVP・轉型 ${S.prestige.count} 次・×${S.prestige.multiplier.toFixed(2)}</p>`);
}
/* ---------- 數據統計 ---------- */
function fmtTime(s){
  s=Math.floor(s||0); const h=Math.floor(s/3600), m=Math.floor(s%3600/60);
  return h>0 ? `${h} 小時 ${m} 分` : m>0 ? `${m} 分 ${s%60} 秒` : `${s} 秒`;
}
/* ---------- 遊戲說明 ---------- */
function openHelp(){
  const sec=(t)=>`<div class="help-sect">${t}</div>`;
  const row=(k,v)=>`<div class="help-row"><b>${k}</b><span>${v}</span></div>`;
  openModal(`<h2>❓ 遊戲說明</h2><div class="help-list">
    ${sec("🎯 核心循環")}
    ${row("怎麼玩","蓋產線生產飲料 → 用輸送帶分送到不同機台 → 零售賣錢、做研究、接批發單，逐步變強")}
    ${row("三去處","🧋出貨口＝零售賣錢(B2C)　🔬科技廠＝研究點　📦批發站＝B2B大量批發單（產能有限，要分配！）")}
    ${sec("🏭 工廠操作")}
    ${row("鋪設","選工具在地皮上拖曳＝連續鋪帶（自動轉彎）；單點＝放一個")}
    ${row("升級/轉向","點已放的機台＝升級；點輸送帶＝轉向；點分流器＝設比例")}
    ${row("平移大地圖","滑鼠滾輪 或 雙指拖曳（也可用 ✋移動工具）")}
    ${row("其他","🏞️整地改地形　🗑️拆除(退一半)　⬆️批次升級　🧹清空")}
    ${sec("🗺️ 地形 & 資源產地")}
    ${row("地形","🌿草地＝採集機　空地＝工廠　💧水域＝不可建(整地填平)")}
    ${row("資源產地","隨機散落的作物產地，蓋對應採集機 →產出 ×2.5(發光)；只能蓋對應機台，要蓋別的先 🏞️整地清除")}
    ${row("產地配對", RESOURCE_TYPES.map(m=>{ const g=GENERATORS.find(x=>x.material===m); return `${MATERIAL_ICON[m]}${MATERIAL_NAME[m]}產地 → 只能蓋${g.icon}${g.name}`; }).join("<br>"))}
    ${sec("⚙️ 機台")}
    ${row("原料機","🍃茶園 ⚫粉圓廠 🥤製杯廠 🍵綠茶園 🥛牧場 🍓果園 → 產原料")}
    ${row("調製站 🫕","吃原料做飲料，可切換配方")}
    ${row("出貨口/科技廠/批發站","🧋零售賣錢　🔬吃飲料產研究點　📦推進B2B批發單")}
    ${row("倉儲 🏬 / 發電廠 ⚡","囤飲料等高點拋售　/　提供電力")}
    ${sec("🔀 進階輸送帶（科技解鎖）")}
    ${row("高速帶 ⏩","item ×2 速")}
    ${row("分流器 🔀 / 合流器 🔃","一進多出(設比例) / 多進一出")}
    ${row("橋接 ✚","兩條帶子十字交叉不混料")}
    ${sec("⚡ 電力")}
    ${row("規則","機台耗電，超過容量 → 全廠降速(紅色警示)；蓋發電廠補電力")}
    ${sec("🍹 飲料 & 🌏 通路")}
    ${row("配方","珍奶/綠茶/奶蓋/水果茶，售價不同；去地圖展店解鎖")}
    ${row("地圖分店","開分店＝銷售產能(賣得掉多少)；集滿品牌＝售價加成")}
    ${sec("📈 市場 & 養成")}
    ${row("市場行情","售價隨時間波動；用倉儲低點囤、高點拋售賺價差")}
    ${row("科技/天賦/成就/寵物","🔬科技(研究點)　🌟天賦樹(轉型給點)　🏅成就(招牌聲望)　🐾寵物(餵食升級加成)")}
    ${sec("✨ 轉型 & 🏢 路線 & 🎲 決策")}
    ${row("轉型上市","重置資源/工廠換永久乘數＋天賦點；圖鑑保留")}
    ${row("企業路線","首次轉型後三選一互斥：🏭量產 / 💎精品 / 🤖自動化")}
    ${row("決策事件","隨機抉擇：穩健保底 vs 賭一把高報酬")}
  </div>
    <button class="primary" onclick="closeModal()">開始遊玩！</button>`);
}
window.openHelp=openHelp;
function openStats(){
  const lm=Object.keys(S.landmarks).length, totalLm=LANDMARKS.length;
  const techDone=RESEARCH.reduce((s,t)=>s+researchLevel(t.id),0);
  const talDone=totalTalentLevels();
  const achDone=ACHIEVEMENTS.filter(a=>S.achievements[a.id]).length;
  let mc=0, bc=0; for(const c of S.factory){ if(!c)continue; if(c.t==="machine")mc++; else bc++; }
  const row=(k,v)=>`<div class="stat-row"><span>${k}</span><b class="tabular">${v}</b></div>`;
  const sect=(t)=>`<div class="stat-sect">${t}</div>`;
  openModal(`<h2>📊 數據統計</h2><div class="stat-list">
    ${sect("💰 財務")}
    ${row("當前資源", money(S.resource))}
    ${row("歷史總收入", money(S.lifetimeResource))}
    ${row("每秒收入", money(opsPerSec())+"/秒")}
    ${row("總點擊次數", fmt(S.totalClicks||0))}
    ${sect("🏭 工廠")}
    ${row("生產速率", (factoryRate||0).toFixed(1)+" 杯/秒")}
    ${row("飲料均價", "×"+(factoryAvgValue||1).toFixed(2))}
    ${row("機台 / 輸送", mc+" / "+bc)}
    ${row("廠房規模", gridRows()+" 排（"+S.factory.length+" 格）")}
    ${sect("🏪 通路 & 收集")}
    ${row("總銷售產能", storeSellCapacity().toFixed(0)+" 杯/秒")}
    ${row("分店圖鑑", lm+" / "+totalLm+"（"+Math.round(lm/totalLm*100)+"%）")}
    ${row("完成批發單", S.ordersCompleted||0)}
    ${sect("🔬 養成")}
    ${row("研究點 / 已研究", fmt(S.rp||0)+" / "+techDone+" 級")}
    ${row("天賦點 / 已點", fmt(S.talentPoints)+" / "+talDone+" 級")}
    ${row("招牌聲望 🏅", S.achievementPoints||0)}
    ${row("成就達成", achDone+" / "+ACHIEVEMENTS.length)}
    ${row("轉型上市", (S.prestige.count||0)+" 次・×"+S.prestige.multiplier.toFixed(2))}
    ${sect("⏱️ 時間")}
    ${row("累計遊玩", fmtTime(S.playTime))}
  </div>
    <button class="ghost" onclick="openSettings()">← 返回</button>
    <button class="primary" onclick="closeModal()">關閉</button>`);
}
window.openStats=openStats;
function toggleDark(){
  S.settings.darkMode = !S.settings.darkMode;
  document.body.classList.toggle("dark", S.settings.darkMode);
}
function resetGame(){
  openModal(`<h2>⚠️ 確定重置？</h2><p>所有進度與圖鑑將永久清除，無法復原。</p>
    <div class="row"><button class="ghost" onclick="openSettings()">取消</button>
    <button class="primary" style="background:var(--warning)" onclick="reallyReset()">確定重置</button></div>`);
}
function reallyReset(){ S=newSave(); document.body.classList.remove("dark"); localStorage.removeItem(SAVE_KEY); closeModal(); renderAll(); toast("已重置，重新開始！"); }
window.openSettings=openSettings; window.toggleDark=toggleDark; window.resetGame=resetGame; window.reallyReset=reallyReset;

/* ---------- 分享戰報 ---------- */
function doShare(){
  const unlocked = Object.keys(S.landmarks).length;
  const pct = Math.round(unlocked/LANDMARKS.length*100);
  const top = LANDMARKS.filter(l=>S.landmarks[l.id]).slice(0,5).map(l=>l.emoji).join("") || "🧋";
  openModal(`<div id="shareCard">
      <div class="title">🧋 我的手搖飲帝國</div>
      <div class="pctbig">${pct}%</div>
      <div>圖鑑完成度 ${unlocked}/${LANDMARKS.length}</div>
      <div class="lms">${top}</div>
      <div class="foot">永久乘數 ×${S.prestige.multiplier.toFixed(2)}・轉型 ${S.prestige.count} 次</div>
    </div>
    <button class="primary" onclick="shareOut(${pct})">分享 / 複製</button>
    <button class="ghost" onclick="closeModal()">關閉</button>`);
}
function shareOut(pct){
  const text = `我的手搖飲帝國圖鑑完成度 ${pct}%！一起來展店征服台灣 🧋`;
  if(navigator.share){ navigator.share({title:"手搖飲帝國", text}).catch(()=>{}); }
  else if(navigator.clipboard){ navigator.clipboard.writeText(text); toast("已複製戰報文字！"); }
  else toast(text);
}
window.doShare=doShare; window.shareOut=shareOut;

/* =========================================================
   存檔 / 讀檔 / 離線收益 / 遷移
   ========================================================= */
/* 存檔簽章：偵測 localStorage 被外部直接竄改（非後端驗證，只擋一般手改）*/
const SAVE_SALT = "boba_empire_2026_x7q9";
function hashStr(str){
  let h1=0xdeadbeef, h2=0x41c6ce57;
  for(let i=0;i<str.length;i++){ const ch=str.charCodeAt(i); h1=Math.imul(h1^ch,2654435761); h2=Math.imul(h2^ch,1597334677); }
  h1=Math.imul(h1^(h1>>>16),2246822507)^Math.imul(h2^(h2>>>13),3266489909);
  h2=Math.imul(h2^(h2>>>16),2246822507)^Math.imul(h1^(h1>>>13),3266489909);
  return (4294967296*(2097151&h2)+(h1>>>0)).toString(36);
}
function save(){
  S.lastSaved = Date.now();
  try{
    const data = JSON.stringify(S);
    localStorage.setItem(SAVE_KEY, JSON.stringify({ d: S, s: hashStr(data+SAVE_SALT) }));
  }catch(e){}
}
function migrate(raw){
  if(raw.version === undefined) raw.version = 1;   // V0→V1 佔位
  if(raw.version === 1){                            // V1→V2：新增天賦系統
    raw.talents = raw.talents || {};
    raw.talentPoints = raw.talentPoints || 0;
    raw.version = 2;
  }
  if(raw.version === 2){                            // V2→V3：新增成就 + 多區域地圖
    raw.achievements = raw.achievements || {};
    raw.version = 3;
  }
  if(raw.version === 3){                            // V3→V4：成就改發招牌聲望（不再發天賦星）
    raw.achievements = raw.achievements || {};
    raw.achievementPoints = ACHIEVEMENTS.reduce((s,a)=> s + (raw.achievements[a.id]?a.ap:0), 0);
    raw.version = 4;
  }
  if(raw.version === 4){                            // V4→V5：經營頁改為供應鏈工廠，舊生產者作廢
    raw.generators = starterStations();             // 舊 clerk/sealer… 無對應站點，重置為起始產線
    raw.version = 5;
  }
  if(raw.version === 5){                            // V5→V6：改為自己蓋的傳送帶工廠
    raw.factory = legacyStarterFactory();           // （當時）給一座可運作的起始工廠
    raw.generators = starterStations();
    raw.factoryRate = 0;
    raw.version = 6;
  }
  if(raw.version === 6){                            // V6→V7：起始改為空地皮，自己蓋
    // 只有「沒動過的自動起始線」才清空；玩家已改過的佈局保留
    if(JSON.stringify(raw.factory) === JSON.stringify(legacyStarterFactory())){
      raw.factory = starterFactory();
      raw.generators = {};
      raw.factoryRate = 0;
    }
    raw.version = 7;
  }
  if(raw.version === 7){                            // V7→V8：新增地形圖層
    const n = Array.isArray(raw.factory) ? raw.factory.length : LEGACY_COLS*4;
    raw.terrain = genTerrainCells(n);
    // 已放東西的格子設成相容地形，避免既有佈局變非法
    if(Array.isArray(raw.factory)) raw.factory.forEach((c,i)=>{
      if(!c) return;
      const def = c.t==="machine" ? GEN_MAP[c.id] : null;
      raw.terrain[i] = (def && def.terrain==="grass") ? "grass" : "plain";
    });
    raw.version = 8;
  }
  if(raw.version === 8){                            // V8→V9：小地圖(8寬) → 大地圖(24×20)，取消擴地
    const of = Array.isArray(raw.factory) ? raw.factory : [];
    const ot = Array.isArray(raw.terrain) ? raw.terrain : [];
    const nf = new Array(GRID_COLS*GRID_ROWS).fill(null);
    const nt = genTerrainCells(GRID_COLS*GRID_ROWS);
    for(let i=0;i<of.length;i++){
      const ox=i%LEGACY_COLS, oy=Math.floor(i/LEGACY_COLS);
      if(ox<GRID_COLS && oy<GRID_ROWS){ const ni=oy*GRID_COLS+ox; nf[ni]=of[i]; if(ot[i]) nt[ni]=ot[i]; }
    }
    raw.factory=nf; raw.terrain=nt;
    raw.version = 9;
  }
  if(raw.version === 9){                            // V9→V10：新增隨機資源產地
    const t = Array.isArray(raw.terrain) ? raw.terrain : genTerrainCells(GRID_COLS*GRID_ROWS);
    raw.resources = genResources(t);                // 會把產地格設為草地
    raw.terrain = t;
    raw.version = 10;
  }
  if(raw.version === 10){                           // V10→V11：補上稀有高山茶產地 + 各區市場
    raw.sellMarket = raw.sellMarket || "taiwan";
    if(Array.isArray(raw.resources) && !raw.resources.includes("premium_tea")){
      let placed=0, tries=0;
      while(placed<3 && tries++<300){
        const idx=Math.floor(Math.random()*raw.resources.length);
        if(!raw.resources[idx] && (!raw.factory||!raw.factory[idx])){ raw.resources[idx]="premium_tea"; if(raw.terrain) raw.terrain[idx]="grass"; placed++; }
      }
    }
    raw.version = 11;
  }
  if(raw.version === 11){                           // V11→V12：零售店經營（中央倉+店員）
    raw.retail = raw.retail || {stock:0, value:0, clerks:0};
    raw.retailRate = raw.retailRate || 0;
    raw.version = 12;
  }
  if(raw.version === 12){                           // V12→V13：各區分別定價（賣到所有開的區）
    raw.pricing = raw.pricing || {taiwan:1.0, japan:1.0, korea:1.0};
    raw.version = 13;
  }
  if(raw.version === 13){                           // V13→V14：競爭對手 & 市場佔有率
    raw.competitors = raw.competitors || initCompetitors();
    raw.ads = raw.ads || {};
    raw.version = 14;
  }
  if(raw.version === 14){                           // V14→V15：對手擴張/倒閉 + 併購品牌力
    raw.brandPower = raw.brandPower || {taiwan:1, japan:1, korea:1};
    if(raw.competitors){ for(const r in raw.competitors){ for(const c of raw.competitors[r]){ if(c.size===undefined) c.size=0.7; } } }
    raw.version = 15;
  }
  if(raw.version === 15){                           // V15→V16：品質獨立投資線
    raw.quality = raw.quality || {ingredient:0, training:0, brand:0, rnd:0};
    raw.version = 16;
  }
  if(raw.version === 16){                           // V16→V17：新手互動教學（既有玩家直接跳過）
    raw.tutorial = raw.tutorial || {step:0, done:true, granted:true};
    raw.version = 17;
  }
  return raw;
}
function load(){
  let stored;
  try{ stored = JSON.parse(localStorage.getItem(SAVE_KEY)); }
  catch(e){ stored=null; }
  if(!stored){ S=newSave(); return; }
  let raw, tampered=false;
  if(stored && stored.d && typeof stored.s==="string"){          // 簽章格式
    raw = stored.d;
    if(hashStr(JSON.stringify(raw)+SAVE_SALT) !== stored.s) tampered=true;   // 簽章不符 → 被改過
  }else{
    raw = stored;                                                 // 舊格式（未簽章）→ 下次存檔自動補簽
  }
  try{
    raw = migrate(raw);
    S = Object.assign(newSave(), raw);
    S.prestige = Object.assign({count:0,multiplier:1}, raw.prestige||{});
    S.settings = Object.assign({soundOn:true,darkMode:false}, raw.settings||{});
    // 工廠格子容錯：長度不符就重置為起始工廠
    { const r = Array.isArray(S.factory) ? S.factory.length/GRID_COLS : 0;
      if(r!==GRID_ROWS){ S.factory = starterFactory(); } }
    // 地形容錯：長度需與工廠一致
    if(!Array.isArray(S.terrain) || S.terrain.length!==S.factory.length){ S.terrain = genTerrainCells(S.factory.length); }
    if(!Array.isArray(S.resources) || S.resources.length!==S.factory.length){ S.resources = genResources(S.terrain); }
    // 機台升級格式相容：舊的單一 lvl → 模塊 mods.speed
    for(const c of S.factory){
      if(c && c.t==="machine"){
        if(!c.mods) c.mods = {};
        if(c.lvl && c.lvl>1 && !c.mods.speed){ c.mods.speed = c.lvl-1; }
        delete c.lvl;
      }
    }
    factoryRate = S.factoryRate || 0;
    factoryAvgValue = S.factoryAvgValue || 1;
    retailRate = S.retailRate || 0;
    if(!S.retail) S.retail = {stock:0, value:0, clerks:0};
    factoryResetRuntime();
    if(tampered) S._tampered = true;
  }catch(e){
    // 損毀容錯：不白畫面，提示重置
    setTimeout(()=>openModal(`<h2>存檔讀取失敗</h2><p>存檔可能損毀。</p>
      <button class="primary" onclick="reallyReset()">重置存檔重新開始</button>`),300);
    S=newSave();
  }
}
function applyOffline(){
  const now = Date.now();
  const cap = offlineCapMs();
  const elapsed = Math.min(now - (S.lastSaved||now), cap);
  if(elapsed < 5000) return;                       // <5秒不打擾
  const ops = opsPerSec();
  if(ops<=0) return;
  const reward = ops * (elapsed/1000);
  S.resource += reward; S.lifetimeResource += reward;
  const h=Math.floor(elapsed/3600000), m=Math.floor(elapsed%3600000/60000);
  const capped = (now - S.lastSaved) > cap;
  const capHrs = Math.round(cap/3600000);
  setTimeout(()=>openModal(`<h2>🌙 歡迎回來！</h2>
    <p>離線期間你的帝國賺了</p>
    <div class="big">${money(reward)}</div>
    <p>（累積 ${h}h ${m}m${capped?`，已達 ${capHrs}h 上限`:''}）</p>
    <button class="primary" onclick="closeModal()">領取 ✓</button>`),400);
}

/* =========================================================
   啟動
   ========================================================= */
function bindEvents(){
  document.getElementById("cupBtn").addEventListener("pointerdown", doClick);
  bindFactoryDrag();
  document.getElementById("factoryPalette").addEventListener("click", e=>{
    const t=e.target.closest("[data-tool]"); if(t) selectTool(t.dataset.tool);
  });
  document.getElementById("btnOrders").addEventListener("click", openOrders);
  document.getElementById("btnResearch").addEventListener("click", openResearch);
  document.getElementById("btnRecipe").addEventListener("click", openRecipeBook);
  document.getElementById("btnBatch").addEventListener("click", openBatchUpgrade);
  document.getElementById("btnClear").addEventListener("click", confirmClearFactory);
  document.getElementById("brandList").addEventListener("click", e=>{
    const c=e.target.closest("[data-lm]"); if(c) tapLandmark(LM_MAP[c.dataset.lm]);
  });
  document.getElementById("regionList").addEventListener("click", e=>{
    const c=e.target.closest("[data-region]"); if(c){ mapView=c.dataset.region; renderMap(); }
  });
  document.getElementById("mapBack").addEventListener("click", ()=>{ mapView="world"; renderMap(); });
  document.getElementById("talentList").addEventListener("click", e=>{
    const b=e.target.closest("[data-talent]"); if(b) buyTalent(TALENT_MAP[b.dataset.talent]);
  });
  document.getElementById("prestigeBtn").addEventListener("click", openPrestige);
  document.getElementById("pathBtn").addEventListener("click", openPath);
  document.getElementById("shareBtn").addEventListener("click", doShare);
  document.getElementById("gearBtn").addEventListener("click", openSettings);
  document.getElementById("petBtn").addEventListener("click", openPet);
  document.getElementById("decisionBanner").addEventListener("click", openDecision);
  document.getElementById("btnRetail").addEventListener("click", openRetail);
  document.getElementById("btnMarketWar").addEventListener("click", openMarketWar);
  document.getElementById("zoomIn").addEventListener("click", ()=>zoomBy(1.25));
  document.getElementById("zoomOut").addEventListener("click", ()=>zoomBy(0.8));
  document.getElementById("miniMap").addEventListener("pointerdown", minimapJump);
  document.querySelectorAll("nav button").forEach(btn=>{
    btn.addEventListener("click", ()=>switchPage(btn.dataset.page));
  });
  document.getElementById("overlay").addEventListener("click", e=>{ if(e.target.id==="overlay") closeModal(); });

  // 存檔：每10秒 + 關閉前 + 切背景
  setInterval(save, 10000);
  window.addEventListener("beforeunload", save);
  document.addEventListener("visibilitychange", ()=>{
    if(document.hidden) save(); else lastTick=Date.now();
  });
  // 即時刷新狀態 + 成就偵測
  setInterval(()=>{
    if(isVisible("page-codex")) renderMap();
    if(isVisible("page-talent")) renderTalents();
    if(isVisible("page-achieve")) renderAchievements();
    if(isVisible("page-biz")){ renderFactoryStats(); renderPalette(); renderEventBanner(); renderPetCompanion(); }
    updateTalentTab(); updateOrderBtn(); checkAchievements();
  }, 800);
}
function switchPage(p){
  for(const pg of ["biz","codex","achieve","talent"]){
    document.getElementById("page-"+pg).classList.toggle("hidden", p!==pg);
    document.getElementById("tab-"+pg).classList.toggle("active", p===pg);
  }
  if(p==="codex"){ mapView="world"; renderMap(); }
  if(p==="achieve") renderAchievements();
  if(p==="talent") renderTalents();
  document.getElementById("petBtn").classList.toggle("hidden", p!=="biz");   // 寵物只在經營頁
}
window.openPrestige=openPrestige;

/* ===================== 新手互動教學（手把手聚光燈）===================== */
const FACTORY_SPOT = ["#factoryPalette"];   // 工廠建造：打亮工具列（地皮雖變暗仍可點）
const TUTORIAL = [
  { center:true, html:"👋 歡迎來到 <b>手搖飲帝國</b>！<br>你要從一間小攤，蓋自動化工廠、展店、打市場戰，征服世界。<br>先用一分鐘學會核心：<b>生產飲料 → 賣錢</b>。<br><br>🎁 送你 <b>$1,200 創業基金</b> 起步！", btn:"開始教學" },
  { spot:FACTORY_SPOT, html:"這是你的<b>工具列</b>。珍奶要 3 種原料，先蓋齊原料機：<br>點 🍃<b>茶園</b>、⚫<b>粉圓廠</b>、🥤<b>製杯廠</b> 各一座（選工具→在空地點一下放置；🍃茶園要放<b>綠色草地</b>）。",
    done:()=> (S.generators.tea_farm||0)>=1 && (S.generators.pearl_mill||0)>=1 && (S.generators.cup_plant||0)>=1 },
  { spot:FACTORY_SPOT, html:"很好！接著蓋一座 🫕<b>調製站</b>，它會把原料自動做成珍奶。",
    done:()=> (S.generators.mixer||0)>=1 },
  { spot:FACTORY_SPOT, html:"最後再蓋一座 🧋<b>出貨口</b>。",
    done:()=> (S.generators.counter||0)>=1 },
  { spot:FACTORY_SPOT, html:"現在<b>接管路</b>！選 🔀<b>輸送帶</b>，在格子上<b>拖曳</b>鋪設（朝拖曳方向、自動轉彎）：<br>① 把 3 種原料都送進 🫕調製站<br>② 再從調製站接一條到 🧋出貨口<br>第一杯珍奶送達就完成！",
    done:()=> (S.retail?.stock||0)>0 || (FX.delivered||0)>0 },
  { spot:["#tab-codex"], html:"🎉 珍奶進<b>中央倉</b>了！但還沒換成錢。<br>點底部「🏙️<b>經營</b>」分頁。",
    done:()=> isVisible("page-codex") },
  { spot:["#btnRetail"], html:"點 🏪<b>零售經營</b> — 這裡管店員把貨賣給客人。",
    done:()=> !tutOvHidden() && tutModalHas("零售經營") },
  { spot:["#modal"], html:"雇用<b>第一名店員</b>，他會自動把中央倉的珍奶賣給客人 → 賺錢！",
    done:()=> retailClerks()>=1 },
  { center:true, html:"🎉 <b>你學會核心循環了！</b><br>工廠生產 → 中央倉 → 店員賣錢。<br><br>接下來自由發展：多蓋產線衝產量、🏙️經營展店提需求、📊市場戰搶市佔、🌟天賦樹、✨轉型上市…<br><small>隨時可在 ⚙️設定 重看教學。</small>", btn:"完成，開始遊玩！" },
];
let tutActive = false;
function tutOvHidden(){ return document.getElementById("overlay").classList.contains("hidden"); }
function tutModalHas(s){ return document.getElementById("modal").innerHTML.includes(s); }
function startTutorial(){
  S.tutorial = S.tutorial || {step:0, done:false, granted:false};
  if(S.tutorial.done) return;
  if(!S.tutorial.granted){ S.resource += 1200; S.tutorial.granted = true; renderHeader(); }   // 創業基金
  tutActive = true; renderTutorial();
}
function endTutorial(){
  tutActive = false; S.tutorial.done = true;
  const el = document.getElementById("tutorial"); if(el) el.classList.add("hidden");
  save();
}
function skipTutorial(){ endTutorial(); toast("已跳過教學，可在 ⚙️設定 重看"); }
function advanceTutorial(){
  S.tutorial.step++;
  if(S.tutorial.step >= TUTORIAL.length){ endTutorial(); confettiBurst(); toast("🎓 教學完成，祝你帝國長青！"); return; }
  renderTutorial();
}
function replayTutorial(){ closeModal(); S.tutorial = {step:0, done:false, granted:true}; tutActive=true; renderTutorial(); }
window.replayTutorial = replayTutorial;
function renderTutorial(){
  const step = TUTORIAL[S.tutorial.step]; if(!step){ endTutorial(); return; }
  let el = document.getElementById("tutorial");
  if(!el){ el = document.createElement("div"); el.id="tutorial"; document.body.appendChild(el); }
  el.classList.remove("hidden");
  const n = S.tutorial.step+1, total = TUTORIAL.length;
  const center = step.center || !step.spot;
  el.innerHTML = `
    ${center ? '<div class="tut-dim"></div>' : '<div class="tut-ring"></div>'}
    <div class="tut-bubble ${center?'center':''}">
      <div class="tut-step">📖 教學 ${n} / ${total}</div>
      <div class="tut-text">${step.html}</div>
      ${step.btn ? `<button class="tut-btn primary">${step.btn}</button>` : `<div class="tut-wait">↳ 完成上面的動作會自動繼續</div>`}
      <button class="tut-skip">跳過教學</button>
    </div>`;
  el.querySelector(".tut-skip").onclick = skipTutorial;
  const b = el.querySelector(".tut-btn"); if(b) b.onclick = advanceTutorial;
  positionTutorial(step);
}
function tutUnionRect(selectors){
  let r = null;
  for(const s of selectors){
    const e = document.querySelector(s); if(!e) continue;
    const b = e.getBoundingClientRect(); if(b.width===0 && b.height===0) continue;
    r = r ? {l:Math.min(r.l,b.left), t:Math.min(r.t,b.top), rt:Math.max(r.rt,b.right), bt:Math.max(r.bt,b.bottom)}
          : {l:b.left, t:b.top, rt:b.right, bt:b.bottom};
  }
  return r;
}
function positionTutorial(step){
  const el = document.getElementById("tutorial"); if(!el) return;
  const bub = el.querySelector(".tut-bubble");
  if(step.center || !step.spot){ if(bub) bub.style.cssText=""; return; }
  const ring = el.querySelector(".tut-ring");
  const r = tutUnionRect(step.spot);
  if(!r){ if(ring) ring.style.display="none"; if(bub) bub.style.cssText="left:50%; transform:translateX(-50%); bottom:18px; top:auto;"; return; }
  if(ring) ring.style.display="block";
  const W = window.innerWidth, H = window.innerHeight, pad = 8;
  const L = Math.max(0, r.l-pad), T = Math.max(0, r.t-pad), R = Math.min(W, r.rt+pad), B = Math.min(H, r.bt+pad);
  // 純視覺：發光框 + box-shadow 把框外變暗（不攔截點擊）
  if(ring) ring.style.cssText = `left:${L}px; top:${T}px; width:${R-L}px; height:${B-T}px;`;
  // 氣泡放在打亮區的「空間較大那一側」，避免蓋住操作區
  const bh = bub.offsetHeight || 170;
  const roomBelow = H - B, roomAbove = T;
  let topPx;
  if(roomBelow >= bh + 16) topPx = B + 12;
  else if(roomAbove >= bh + 16) topPx = T - bh - 12;
  else topPx = (roomAbove > roomBelow) ? 8 : Math.max(8, H - bh - 8);   // 兩側都擠 → 貼邊
  bub.style.cssText = `left:50%; transform:translateX(-50%); top:${topPx}px; bottom:auto;`;
}
function tutorialUpdate(){
  if(!tutActive) return;
  const step = TUTORIAL[S.tutorial.step]; if(!step) return;
  if(step.done && step.done()){ advanceTutorial(); return; }
  positionTutorial(step);   // 保持聚光燈對齊（工具列/面板可能捲動）
}
/* ====================================================================== */

function start(){
  load();
  if(S.settings.darkMode) document.body.classList.add("dark");
  applyOffline();
  ensureOrders();
  if(!S.nextEventAt || S.nextEventAt < Date.now()) S.nextEventAt = Date.now() + 45000;  // 首個事件約 45 秒後
  if(S.event && S.event.endsAt < Date.now()) S.event = null;                            // 過期事件清掉
  if(!S.nextDecisionAt || S.nextDecisionAt < Date.now()) S.nextDecisionAt = Date.now() + 75000;  // 首個決策約 75 秒後
  renderDecisionBanner();
  bindEvents();
  renderAll();
  checkAchievements(); updateOrderBtn();
  if(S._tampered){
    setTimeout(()=>openModal(`<h2>⚠️ 偵測到存檔異常</h2>
      <p>存檔的簽章不符，可能被外部工具修改過。</p>
      <p style="font-size:12px;opacity:.7">你可以繼續遊玩，或重置回乾淨的存檔。</p>
      <button class="primary" onclick="closeModal()">我知道了，繼續</button>
      <button class="ghost" style="border-color:var(--warning);color:var(--warning)" onclick="reallyReset()">🗑️ 重置存檔</button>`), 500);
  }
  lastTick = Date.now();
  requestAnimationFrame(loop);
  if(!S.tutorial || !S.tutorial.done) setTimeout(startTutorial, 700);   // 首次遊玩 → 啟動新手教學
  // PWA：僅在以伺服器（http/https）開啟時啟用 manifest + service worker
  if(location.protocol!=="file:"){
    const m=document.createElement("link"); m.rel="manifest"; m.href="manifest.json";
    document.head.appendChild(m);
  }
  if("serviceWorker" in navigator && location.protocol!=="file:"){
    navigator.serviceWorker.register("service-worker.js").catch(()=>{});
  }
}
start();
