// Meme factory: instant meme templates (摸头、举牌、结婚申请 …) from existing pictures and texts, made by the
// `meme-generator` Python package (MIT, Rust core, 300 templates) inside the cloud computer.
//
// Facts measured on the machine (meme_generator 0.2.3, the Rust rewrite): the pip wheel has no resources, so the first
// use after each wake-up installs it (a few seconds) and calls resources.check_resources() once, which downloads
// about 400 MB of images and fonts (about 70 s). After that one generation takes well under a second. The API is
// synchronous: get_meme(key) returns None for an unknown key; meme.generate(images, texts, options) returns the
// PNG/GIF bytes, or an error object (ImageNumberMismatch, TextNumberMismatch, TextOverLength, ...) instead of raising.
import type { Feature } from "./types.ts";
import type { Tool } from "../core.ts";

// ---------- catalogue ----------
// One JSON row per template: [key, keywords, minImages, maxImages, minTexts, maxTexts, defaultTexts, tags, options?]
// with options as [name, type(b|s|i|f), description, default?, choices | [min, max]?].
// Regenerate (when meme-generator is upgraded): run CATALOG_PY in the cloud computer, e.g.
//   node tool.mjs <room> computer '{"commands":["/opt/py/bin/python - 2>/dev/null > catalog.png <<\"X\"\n<CATALOG_PY>\nX"],"collect":["catalog.png"],"deliver":false}'
// (the .png name only makes the admin API keep the text as a downloadable "picture"), download it with
// fetchfile.mjs, and paste the lines below, one row per line.
export const CATALOG_PY = String.raw`import json
from meme_generator import get_memes
def opt(o):
    t = type(o).__name__[0].lower()
    x = [o.name, t, o.description or "", getattr(o, "default", None)]
    ch = getattr(o, "choices", None)
    if ch: x.append(ch)
    elif t in "if" and (o.minimum is not None or o.maximum is not None): x.append([o.minimum, o.maximum])
    while len(x) > 3 and x[-1] in (None, ""): x.pop()
    return x
for m in get_memes():
    i = m.info; p = i.params
    row = [m.key, i.keywords, p.min_images, p.max_images, p.min_texts, p.max_texts, p.default_texts, sorted(i.tags)]
    if p.options: row.append([opt(o) for o in p.options])
    print(json.dumps(row, ensure_ascii=False, separators=(",", ":")))`;

const RAW = String.raw`
["5000choyen",["5000兆"],0,0,2,2,["我去","洛天依"],[]]
["abstinence",["戒导"],1,1,0,0,[],[],[["time","s","时间"]]]
["ace_attorney_dialog",["逆转裁判气泡"],0,0,1,1,["表情包制作"],[]]
["acg_entrance",["二次元入口"],1,1,0,1,["走，跟我去二次元吧"],[]]
["add_chaos",["添乱","给社会添乱"],1,1,0,0,[],[]]
["addiction",["上瘾","毒瘾发作"],1,1,0,1,[],[]]
["alike",["一样"],1,1,0,0,[],[]]
["alipay",["支付宝支付"],1,1,0,0,[],[],[["message","s","二维码内容"]]]
["always",["一直"],1,1,0,0,[],[],[["mode","s","生成模式","normal",["normal","loop","circle"]],["circle","b","套娃模式",false],["loop","b","循环模式",false]]]
["always_like",["我永远喜欢"],1,1,0,0,[],[]]
["anan_say",["安安说"],0,0,1,1,["吾辈很开心"],["夏目安安","魔法少女的魔女审判"],[["expression","s","表情类型",null,["angry","black","happy","shy","speechless"]]]]
["anti_kidnap",["防诱拐"],1,1,0,0,[],[]]
["anya_suki",["阿尼亚喜欢"],1,1,0,0,["阿尼亚喜欢这个"],[]]
["applaud",["鼓掌"],1,1,0,0,[],[]]
["arona_throw",["阿罗娜扔"],1,1,0,0,[],["碧蓝档案","蔚蓝档案","阿罗娜"]]
["ascension",["升天"],0,0,1,1,["学的是机械"],[]]
["ask",["问问"],1,1,0,0,[],[],[["gender","s","性别","unknown",["male","female","unknown"]]]]
["atri_pillow",["亚托莉枕头"],0,0,1,1,["ATRI"],["ATRI","亚托莉","萝卜子"],[["mode","s","模式",null,["yes","no"]],["yes","b","yes 模式",false],["no","b","no 模式",false]]]
["ayachi_holdsign",["宁宁举牌"],0,0,1,1,["我控制不住自己啊"],["柚子社","绫地宁宁","魔女的夜宴"]]
["ba_say",["ba说"],0,0,1,1,["那我问你"],["key","久田泉奈","伊落玛丽","冰室濑名","天童爱丽丝","早濑优香","春原心奈","春原心菜","碧蓝档案","蔚蓝档案"],[["character","s","角色名",null,["arisu","izuna","key","kokona","mari","sena","yuuka"]],["position","s","消息框的位置",null,["left","right"]],["left","b","左",false],["right","b","右",false]]]
["back_to_work",["继续干活","打工人"],1,1,0,0,[],[]]
["backflip",["后空翻"],1,1,0,0,[],[]]
["bad_news",["悲报"],0,0,1,1,["喜报"],[]]
["batitle",["蔚蓝档案标题","batitle"],0,0,2,2,["Blue","Archive"],["碧蓝档案","蔚蓝档案"]]
["beat_head",["拍头"],1,1,0,1,["怎么说话的你"],[]]
["beat_up",["揍"],2,2,0,0,[],["杰瑞","汤姆","猫和老鼠"]]
["blamed_mahiro",["真寻挨骂"],0,0,1,1,["傻逼"],["别当欧尼酱了","绪山真寻"]]
["blood_pressure",["高血压"],1,1,0,0,[],[]]
["bocchi_draft",["波奇手稿"],1,1,0,0,[],["后藤一里","孤独摇滚","波奇酱"]]
["bronya_holdsign",["布洛妮娅举牌","大鸭鸭举牌"],0,0,1,1,["V我50"],["崩坏3","布洛妮娅·扎伊切克","米哈游"]]
["bubble_tea",["奶茶"],1,1,0,0,[],[],[["position","s","奶茶的位置","right",["left","right","both"]],["left","b","左手",false],["right","b","右手",false],["both","b","双手",false]]]
["call_110",["遇到困难请拨打"],2,2,0,0,[],[]]
["capoo_draw",["咖波画"],1,1,0,0,[],["咖波","猫猫虫"]]
["capoo_point",["咖波指"],1,1,0,0,[],["咖波","猫猫虫"]]
["capoo_rip",["咖波撕"],1,1,0,0,[],["咖波","猫猫虫"]]
["capoo_rub",["咖波蹭","咖波贴"],1,1,0,0,[],["咖波","猫猫虫"]]
["capoo_say",["咖波说"],0,0,1,10,["寄"],["咖波","猫猫虫"]]
["capoo_stew",["咖波炖"],1,1,0,0,[],["咖波","猫猫虫"]]
["capoo_strike",["咖波撞","咖波头槌"],1,1,0,0,[],["咖波","猫猫虫"]]
["captain",["舰长"],2,5,0,0,[],["休伯利安号","崩坏3","米哈游","舰长"]]
["caused_by_this",["这个引起的"],1,1,0,1,["心脏病 高血压 心律不齐 心肌梗塞 失眠 脱发 呼吸困难 胸闷气短 缺氧 躁郁 焦虑 脑供血不足 心慌心悸 心脑血管炸裂"],[]]
["certificate",["奖状","证书"],0,0,3,4,["小王","优秀学生","一年一班"],[],[["time","s","时间"]]]
["chanshenzi",["馋身子"],0,0,3,3,["你那叫喜欢吗？","你那是馋她身子","你下贱！"],[]]
["charpic",["字符画"],1,1,0,0,[],[]]
["chase_train",["追列车","追火车"],1,1,0,0,[],[]]
["china_flag",["国旗"],1,1,0,0,[],[]]
["chino_throw",["智乃扔","智乃抛"],1,1,0,0,[],["香风智乃"]]
["clauvio_twist",["鼠鼠搓"],1,1,0,0,[],[]]
["clown",["小丑"],1,1,0,0,[],[],[["person","b","是否使用爷爷头轮廓",false]]]
["clown_mask",["小丑面具"],1,1,0,0,[],[],[["mode","s","小丑在前/后","front",["front","behind"]],["front","b","小丑在前",false],["behind","b","小丑在后",false]]]
["confuse",["迷惑"],1,1,0,0,[],[]]
["coupon",["兑换券"],1,1,0,1,[],[]]
["cover_face",["捂脸"],1,1,0,0,[],[]]
["crawl",["爬"],1,1,0,0,[],[],[["number","i","图片编号",null,[1,92]]]]
["cyan",["群青"],1,1,0,0,[],[]]
["daynight",["白天黑夜","白天晚上"],2,2,0,0,[],[]]
["decent_kiss",["像样的亲亲"],1,1,0,0,[],[]]
["dianzhongdian",["入典","典中典","黑白草图"],1,1,1,2,["救命啊"],[]]
["dinosaur",["恐龙","小恐龙"],1,1,0,0,[],[]]
["distracted",["注意力涣散"],1,1,0,0,[],["明日方舟"]]
["divorce",["离婚协议","离婚申请"],1,1,0,0,[],[]]
["dog_dislike",["狗都不玩"],1,1,0,0,[],[],[["circle","b","是否将图片变为圆形",false]]]
["dog_of_vtb",["管人痴"],1,1,0,0,[],[]]
["dont_go_near",["不要靠近"],1,1,0,0,[],[]]
["dont_press",["不要按"],0,0,1,1,["世界毁灭"],[]]
["dont_touch",["别碰"],1,1,0,0,[],[]]
["doraemon_say",["哆啦A梦说"],0,0,1,1,["开银趴不喊我是吧"],[]]
["douyin",["douyin"],0,0,1,1,["douyin"],[]]
["eat",["吃"],1,1,0,0,[],[]]
["elysia_holdsign",["爱莉举牌"],0,0,1,1,["要好好爱莉哦~"],["崩坏3","爱莉","爱莉希雅","米哈游"],[["number","i","图片编号",null,[1,8]]]]
["emperor_dragon",["皇帝龙图"],0,0,1,1,["听不懂，退朝"],[]]
["erised_mirror",["意若思镜"],1,1,0,0,[],["哈利·波特"]]
["fade_away",["灰飞烟灭"],1,1,0,0,[],[]]
["fanatic",["狂爱","狂粉"],0,0,1,1,["洛天依"],[]]
["father_work",["我爸爸"],1,1,1,1,[],[]]
["fencing",["击剑","🤺"],2,2,0,0,[],[]]
["fight_with_sunuo",["我打宿傩","我打宿傩吗"],1,1,0,0,[],["两面宿傩","咒术回战"]]
["fill_head",["满脑子"],1,1,0,0,[],[]]
["find_chips",["整点薯条"],0,0,4,4,["我们要飞向何方","我打算待会去码头整点薯条","我说的是归根结底，活着是为了什么","为了待会去码头整点薯条"],[]]
["firefly_holdsign",["流萤举牌"],0,0,1,1,["我超爱你"],["崩坏：星穹铁道","流萤","米哈游"],[["number","i","图片编号",null,[1,21]]]]
["flash_blind",["闪瞎"],1,1,0,0,[],[]]
["flick",["弹","脑瓜崩"],1,1,0,0,[],[]]
["flush",["红温"],1,1,0,0,[],[]]
["fogging",["回南天","水雾"],1,1,0,1,["兄弟，回南了"],[]]
["follow",["关注"],1,1,0,0,[],[],[["gender","s","性别","unknown",["male","female","unknown"]]]]
["forbid",["禁止","禁"],1,1,0,0,[],[]]
["frieren_take",["芙莉莲拿"],1,1,0,1,["所谓的男人啊，只要送他们这种东西就会很开心"],["芙莉莲","葬送的芙莉莲"]]
["funny_mirror",["哈哈镜"],1,1,0,0,[],[]]
["garbage",["垃圾","垃圾桶"],1,1,0,0,[],[]]
["genshin_eat",["原神吃"],1,1,0,0,[],["八重神子","刻晴","原神","可莉","妮露","米哈游","胡桃","钟离"],[["character","s","角色名",null,["hutao","keqing","klee","nilou","yae_miko","zhongli"]]]]
["genshin_start",["原神启动"],1,1,0,1,["原神，启动！"],[]]
["good_news",["喜报"],0,0,1,1,["悲报"],[]]
["google",["google"],0,0,1,1,["Google"],[]]
["google_captcha",["谷歌验证码"],1,1,0,0,[],[]]
["gorilla_throw",["猩猩扔"],1,1,0,0,[],[]]
["grab",["抓"],1,1,0,0,[],[]]
["grab_both_hands",["双手抓"],1,1,0,0,[],[]]
["guichu",["鬼畜"],1,1,0,0,[],[],[["direction","s","鬼畜对称方向","left",["left","right","top","bottom"]],["left","b","左",false],["right","b","右",false],["top","b","上",false],["bottom","b","下",false]]]
["gun",["手枪"],1,1,0,0,[],[],[["position","s","枪的位置","right",["left","right","both"]],["left","b","左手",false],["right","b","右手",false],["both","b","双手",false]]]
["hammer",["锤"],1,1,0,0,[],[]]
["haruhi_raise",["凉宫春日举"],1,1,0,0,[],["凉宫春日"]]
["head_butt",["顶"],1,1,0,0,[],["咖波","猫猫虫"]]
["high_eq",["高低情商","低高情商"],0,0,2,2,["高情商","低情商"],[]]
["hit_screen",["打穿","打穿屏幕"],1,1,0,0,[],[]]
["hold_grudge",["记仇"],0,0,1,1,["群友不发涩图"],[],[["time","s","时间"]]]
["hold_tight",["抱紧"],1,1,0,0,[],[]]
["hug",["抱","抱抱"],2,2,0,0,[],[]]
["hug_leg",["抱大腿"],1,1,0,0,[],[]]
["hutao_bite",["胡桃啃"],1,1,0,0,[],["原神","米哈游","胡桃"]]
["imprison",["坐牢"],0,0,1,1,["我发涩图被抓起来了"],[]]
["incivilization",["不文明"],1,1,0,1,["你刚才说的话不是很礼貌！"],[]]
["intel_inside",["inside"],0,0,1,1,["intel"],[]]
["interview",["采访"],1,2,0,1,["采访大佬经验"],[]]
["jerry_stare",["杰瑞盯"],1,1,0,0,[],["杰瑞","猫和老鼠"]]
["jiamianqishi",["假面骑士"],0,0,4,4,["哦～","（飞扑）","一直想看你这幅表情","这幅嫉妒我的表情"],[]]
["jiji_king",["急急国王"],1,1,0,1,["我是急急国王"],[],[["block_text","s","方块中的文字","急"]]]
["jinhsi",["汐汐","今汐"],0,0,1,1,["汐汐"],["今汐","鸣潮"],[["number","i","图片编号",null,[1,13]]]]
["jiubingfufa",["旧病复发"],1,1,0,1,["此乃旧病复发也"],[]]
["jiujiu",["啾啾"],1,1,0,0,[],[]]
["jump",["跳"],1,1,0,0,[],[]]
["kaleidoscope",["万花筒","万花镜"],1,1,0,0,[],[],[["circle","b","是否将图片变为圆形",false]]]
["karyl_point",["凯露指"],1,1,0,0,[],["公主连结","凯露"]]
["keep_away",["远离"],1,8,0,1,["如何提高社交质量 : \n远离以下头像的人"],[]]
["keep_your_money",["压岁钱不要交给"],1,1,0,0,[],["普拉娜","碧蓝档案","蔚蓝档案","阿罗娜"],[["character","s","角色名",null,["arona","plana"]]]]
["kick_ball",["踢球"],1,1,0,0,[],[]]
["kirby_hammer",["卡比锤","卡比重锤"],1,1,0,0,[],["星之卡比"],[["circle","b","是否将图片变为圆形",false]]]
["kiss",["亲","亲亲"],2,2,0,0,[],[]]
["klee_eat",["可莉吃"],1,1,0,0,[],["原神","可莉","米哈游"]]
["knock",["敲"],1,1,0,0,[],["Gawr Gura","噶呜·古拉","鲨鲨"]]
["kokona_seal",["心奈印章"],0,0,1,1,["满分"],["春原心奈","春原心菜","碧蓝档案","蔚蓝档案"],[["number","i","图片编号",null,[1,12]]]]
["konata_watch",["泉此方看"],1,1,0,0,[],["幸运星","泉此方"]]
["learn",["偷学"],1,1,0,1,["偷学群友数理基础"],[]]
["left_right_jump",["左右横跳"],1,1,0,0,[],[],[["direction","s","跑动方向","left_right",["left_right","right_left"]],["left_right","b","左右",false],["right_left","b","右左",false]]]
["let_me_in",["让我进去"],1,1,0,0,[],[]]
["lick_candy",["舔糖","舔棒棒糖"],1,1,0,0,[],[]]
["lim_x_0",["等价无穷小"],1,1,0,0,[],[]]
["listen_music",["听音乐"],1,1,0,0,[],[]]
["little_angel",["小天使"],1,1,0,0,[],[],[["gender","s","性别","unknown",["male","female","unknown"]]]]
["loading",["加载中"],1,1,0,0,[],[]]
["look_flat",["看扁"],1,1,0,1,["可恶...被人看扁了"],[],[["ratio","f","图片“压扁”比例",2.0,[1.0,10.0]]]]
["look_this_icon",["看图标"],1,1,0,1,["朋友\n先看看这个图标再说话"],[]]
["loop",["循环"],1,1,0,0,[],[],[["direction","s","循环方向","top",["left","right","top","bottom"]],["left","b","左",false],["right","b","右",false],["top","b","上",false],["bottom","b","下",false]]]
["lost_dog",["寻狗启事"],1,1,0,0,[],["原神","神里绫华","米哈游"]]
["love_you",["永远爱你"],1,1,0,0,[],[]]
["luotianyi_need",["洛天依要","天依要"],1,1,0,0,[],["洛天依"]]
["luotianyi_say",["洛天依说","天依说"],0,0,1,1,["好想去海边啊～"],["洛天依"]]
["luoyonghao_say",["罗永浩说"],0,0,1,1,["又不是不能用"],[]]
["luxun_say",["鲁迅说","鲁迅说过"],0,0,1,1,["我没有说过这句话"],[]]
["mahiro_readbook",["真寻看书"],1,1,0,0,[],["别当欧尼酱了","绪山真寻"]]
["maikease",["麦克阿瑟说"],0,0,4,4,["美国前五星上将麦克阿瑟","曾这样评价道","如果让我去阻止xxx","那么我宁愿去阻止上帝"],[]]
["maimai_awaken",["旅行伙伴觉醒"],1,1,0,0,[],["舞萌"]]
["maimai_join",["旅行伙伴加入"],1,1,0,0,[],["舞萌"]]
["make_friend",["交个朋友"],1,1,0,1,[],[]]
["marriage",["结婚申请","结婚登记"],1,1,0,0,[],[]]
["meteor",["流星"],0,0,1,1,["我要对象"],[]]
["mihoyo",["米哈游"],1,1,0,0,[],[]]
["mourning",["上香"],1,1,0,0,[],[],[["gray","b","是否将图片变为黑白",false]]]
["murmur",["低语"],0,0,1,1,["你的假期余额不足"],[]]
["my_friend_say",["我朋友说"],1,1,1,10,["让我康康"],[]]
["my_opinion",["我的意见如下","我的意见是"],0,0,1,1,[],["东方Project"]]
["my_wife",["我老婆","这是我老婆"],1,1,0,0,[],[],[["pronoun","s","人称代词","我"],["name","s","称呼","老婆"]]]
["nahida_bite",["纳西妲啃","草神啃"],1,1,0,0,[],["原神","米哈游","纳西妲","草神"]]
["name_generator",["亚文化取名机","亚名"],1,1,0,0,[],[]]
["need",["需要","你可能需要"],1,1,0,0,[],[]]
["nekoha_holdsign",["猫羽雫举牌","猫猫举牌"],0,0,1,1,["V我50"],["猫羽雫"]]
["nihaosaoa",["你好骚啊"],0,0,3,3,["既然追求刺激","就贯彻到底了","你好骚啊"],[]]
["nijika_holdsign",["虹夏举牌"],0,0,1,1,["你可少看点二次元吧"],["伊地知虹夏","孤独摇滚"]]
["no_response",["无响应"],1,1,0,0,[],[]]
["nokia",["诺基亚","有内鬼"],0,0,1,1,["无内鬼，继续交易"],[]]
["note_for_leave",["请假条"],1,1,0,1,["想玩原神"],[],[["time","s","时间"]]]
["operator_generator",["合成大干员"],1,1,0,0,[],[]]
["oshi_no_ko",["我推的网友"],1,1,0,0,[],["我推的孩子"],[["name","s","我推的名字","网友"]]]
["osu",["osu"],0,0,1,1,["hso!"],[]]
["out",["out"],1,1,0,0,[],[]]
["overtime",["加班"],1,1,0,0,[],[]]
["p5letter",["p5预告信"],0,0,1,1,["TAKEYOURHEART"],["女神异闻录5"]]
["paint",["这像画吗"],1,1,0,0,[],[]]
["painter",["小画家"],1,1,0,0,[],["崩坏3","格蕾修","米哈游"]]
["panda_dragon_figure",["熊猫龙图"],0,0,1,1,["我要玩原神"],[],[["name","s","龙图名字","责怪龙"]]]
["pass_the_buck",["推锅","甩锅"],1,1,0,1,["你写!"],[]]
["pat",["拍"],1,1,0,0,[],[]]
["pepe_raise",["佩佩举"],2,2,0,0,[],["明日方舟"]]
["perfect",["完美"],1,1,0,0,[],[]]
["petpet",["摸","摸摸","摸头","rua"],1,1,0,0,[],[],[["circle","b","是否将图片变为圆形",false]]]
["pinch",["捏","捏脸"],1,1,0,0,[],[]]
["pixelate",["像素化"],1,1,0,0,[],[],[["number","i","像素化大小",10,[2,50]]]]
["pjsk",["pjsk","世界计划"],0,0,1,1,[],["世界计划"],[["character","s","角色名",null,["airi","akito","an","emu","ena","haruka","honami","ichika","kaito","kanade","kohane","len","luka","mafuyu","meiko","miku","minori","mizuki","nene","rin","rui","saki","shiho","shizuku","touya","tsukasa"]],["number","i","图片编号",null,[1,16]],["size","i","字体大小",50,[20,100]],["rotate","i","文字旋转角度",null,[-40,40]],["x_offset","i","x方向偏移",0,[-100,100]],["y_offset","i","y方向偏移",0,[-50,150]]]]
["plana_eat",["普拉娜吃","普拉娜舔"],1,1,0,0,[],["普拉娜","碧蓝档案","蔚蓝档案"]]
["play_baseball",["打棒球"],1,1,0,0,[],["咖波","猫猫虫"]]
["play_basketball",["打篮球","火柴人打篮球"],1,1,0,0,[],["火柴人"]]
["play_game",["玩游戏"],1,1,0,1,["来玩休闲游戏啊"],[]]
["play_together",["一起玩"],1,1,0,0,[],["碧蓝档案","蔚蓝档案"]]
["police",["出警"],1,1,0,1,["平安名すみれ"],[]]
["policeman",["警察"],1,1,0,0,[],[]]
["pornhub",["ph","pornhub"],0,0,2,2,["You","Tube"],[]]
["potato",["土豆"],1,1,0,0,[],[]]
["pound",["捣"],1,1,0,0,[],[]]
["praise",["表扬"],0,0,1,1,["好，不愧是顶尖运营"],[]]
["printing",["打印"],1,1,0,0,[],[]]
["prpr",["舔","舔屏","prpr"],1,1,0,0,[],[]]
["psyduck",["可达鸭"],0,0,2,2,["来份","涩图"],[]]
["punch",["打拳"],1,1,0,0,[],[]]
["pyramid",["四棱锥","金字塔"],1,4,0,0,[],[]]
["qiegewala",["切格瓦拉"],0,0,6,6,["没有钱啊 肯定要做的啊","不做的话没有钱用","那你不会去打工啊","有手有脚的","打工是不可能打工的","这辈子不可能打工的"],[]]
["raise_image",["举"],1,1,0,0,[],[]]
["raise_sign",["举牌"],0,0,1,1,["大佬带带我"],[]]
["read_book",["看书"],1,1,0,1,["エロ本"],[]]
["remote_control",["遥控","控制"],1,1,0,0,[],[]]
["repeat",["复读"],1,5,1,1,["救命啊"],[]]
["rip",["撕"],1,2,0,0,[],[]]
["rip_angrily",["怒撕"],1,1,0,0,[],[]]
["rip_clothes",["撕衣服"],1,1,0,0,[],[]]
["rise_dead",["诈尸","秽土转生"],1,1,0,0,[],[]]
["roll",["滚"],1,1,0,0,[],[]]
["rotate_3d",["三维旋转"],1,1,0,0,[],[]]
["rub",["贴","贴贴","蹭","蹭蹭"],2,2,0,0,[],[]]
["run",["快跑"],0,0,1,1,["快跑"],[]]
["run_away",["快逃"],1,1,0,0,[],["初音未来"]]
["safe_sense",["安全感"],1,1,0,0,["你给我的安全感\n远不及他的万分之一"],[]]
["saimin_app",["催眠app"],1,1,0,0,[],[]]
["scratch_head",["挠头"],1,1,0,0,[],[]]
["scratchcard",["刮刮乐"],0,0,1,1,["谢谢参与"],[]]
["scroll",["滚屏"],0,0,1,1,["你们说话啊"],[]]
["seal",["源石封印"],1,1,0,0,[],["明日方舟"]]
["sekaiichi_kawaii",["世界第一可爱"],1,1,0,0,[],["学园偶像大师","藤田琴音"]]
["shake_head",["晃脑"],1,1,0,0,[],[]]
["shiroko_pero",["白子舔"],1,1,0,0,[],["砂狼白子","碧蓝档案","蔚蓝档案"]]
["shishilani",["食屎啦你"],0,0,4,4,["穿西装打领带","拿大哥大有什么用","跟着这样的大哥","食屎啦你"],[]]
["shock",["震惊"],1,1,0,0,[],[]]
["shuifandui",["谁反对"],0,0,4,4,["我话说完了","谁赞成","谁反对","我反对"],[]]
["shutup",["别说了"],0,0,1,1,["你不要再说了"],[]]
["sit_still",["坐得住"],1,1,0,0,[],[]]
["slap",["一巴掌"],0,0,1,1,["你不要再说了"],[]]
["slogan",["口号"],0,0,6,6,["我们是谁？","浙大人！","到浙大来做什么？","混！","将来毕业后要做什么样的人？","混混！"],[]]
["smash",["砸"],1,1,0,0,[],[]]
["sold_out",["卖掉了"],1,1,0,0,[],[]]
["speechless",["无语"],1,1,0,1,[],[]]
["sphere_rotate",["球面旋转"],1,1,0,0,[],[]]
["spider",["蜘蛛","蜘蛛爬"],1,1,0,0,[],[]]
["stare_at_you",["盯着你"],1,1,0,0,[],[]]
["steam_message",["steam消息"],1,1,1,1,["黑神话：悟空"],[]]
["step_on",["踩"],1,1,0,0,[],[]]
["stew",["炖"],1,1,0,1,[],[]]
["stickman_dancing",["跳舞","火柴人跳舞"],1,1,0,0,[],["火柴人"]]
["subject3",["科目三"],1,1,0,0,[],[]]
["suck",["吸","嗦"],1,1,0,0,[],[]]
["support",["精神支柱"],1,1,0,0,[],[]]
["swirl_turn",["回旋转","旋风转"],1,1,0,0,[],[]]
["symmetric",["对称"],1,1,0,0,[],[],[["direction","s","对称方向","left",["left","right","top","bottom"]],["left","b","左",false],["right","b","右",false],["top","b","上",false],["bottom","b","下",false]]]
["tankuku_raisesign",["唐可可举牌"],1,1,0,0,[],["LoveLive!Superstar!!","唐可可"]]
["taunt",["嘲讽"],1,1,0,0,[],[]]
["teach",["讲课","敲黑板"],1,1,0,1,["我老婆"],["井之上泷奈","莉可丽丝"]]
["tease",["拿捏","戏弄"],1,1,0,0,[],["碧蓝档案","蔚蓝档案"]]
["telescope",["望远镜"],1,1,0,0,[],[]]
["thermometer_gun",["体温枪"],1,1,0,1,["笨蛋"],[]]
["think_what",["想什么"],1,1,0,0,[],[]]
["this_chicken",["这是鸡","🐔"],1,1,0,1,["这是十二生肖中的鸡"],[]]
["throw",["丢","扔"],1,1,0,0,[],["东方Project"]]
["throw_gif",["抛","掷"],1,1,0,0,[],[]]
["thump",["捶"],1,1,0,0,[],[]]
["thump_wildly",["捶爆","爆捶"],1,1,0,0,[],["明日方舟"]]
["tightly",["紧贴","紧紧贴着"],1,1,0,0,[],[]]
["time_to_go",["该走了"],1,1,0,1,["说完了吗？该走了"],[]]
["together",["一起"],1,1,0,1,[],[]]
["tom_tease",["汤姆嘲笑"],1,1,0,0,[],["汤姆","猫和老鼠"]]
["tomb_yeah",["上坟","坟前比耶"],1,2,0,0,[],[]]
["trance",["恍惚"],1,1,0,0,[],[]]
["trolley",["推车"],1,1,0,0,[],[]]
["turn",["转"],1,1,0,0,[],[]]
["twist",["搓"],1,1,0,0,[],[]]
["universal",["万能表情","空白表情"],1,1,1,1,[],[],[["size","i","字体大小",50,[20,100]],["font","s","字体名"],["color","s","文字颜色"],["position","s","文字位置","bottom_outer",["top","bottom","center","top_outer","bottom_outer"]],["bold","b","文字是否加粗",false],["italic","b","文字是否倾斜",false],["rotate","i","文字旋转角度",0,[-180,180]],["align","s","文字对齐","center",["left","center","right"]],["stroke_width","i","文字描边宽度",null,[1,10]],["stroke_color","s","文字描边颜色"],["x_offset","i","x方向偏移",0,[-200,200]],["y_offset","i","y方向偏移",0,[-200,200]]]]
["upside_down",["反了"],1,1,0,1,["我看你们是反了！"],[]]
["vibrate",["震动"],1,1,0,0,[],[]]
["wakeup",["好起来了"],0,0,1,1,["好"],[]]
["wallpaper",["墙纸"],1,1,0,0,[],["瑞克·桑切斯","瑞克和莫蒂"]]
["walnut_pad",["胡桃平板"],1,1,0,0,[],["胡桃","莉可丽丝"]]
["walnut_zoom",["胡桃放大"],1,1,0,0,[],["胡桃","莉可丽丝"]]
["wangjingze",["王境泽"],0,0,4,4,["我就是饿死","死外边 从这里跳下去","不会吃你们一点东西","真香"],[]]
["washer",["洗衣机"],1,1,0,0,[],[]]
["wave",["波纹"],1,1,0,0,[],[]]
["wechat_pay",["微信支付"],1,1,0,0,[],[],[["message","s","二维码内容"]]]
["weisuoyuwei",["为所欲为"],0,0,9,9,["好啊","别说我是一等良民","就算你们真的想要诬告我","我有的是钱请律师帮我打官司","我想我根本不用坐牢","有钱了不起啊","Sorry，有钱真的了不起","不过我想你不会明白这种感觉","不明白，不明白"],[]]
["what_he_wants",["最想要的东西"],1,1,0,1,["今年520"],[]]
["what_i_want_to_do",["我想上的"],1,1,0,0,[],[]]
["why_at_me",["为什么@我"],1,1,0,0,[],["东方Project"]]
["why_have_hands",["为什么要有手"],1,1,0,0,[],[]]
["windmill_turn",["风车转"],1,1,0,0,[],[]]
["wish_fail",["许愿失败"],0,0,1,1,["我要对象"],[]]
["wooden_fish",["木鱼"],1,1,0,0,[],[]]
["worship",["膜","膜拜"],1,1,0,0,[],[]]
["wujing",["吴京中国"],0,0,2,4,["不买华为不是","人"],[]]
["wunian",["五年怎么过的"],0,0,4,4,["五年","你知道我这五年是怎么过的吗","我每天躲在家里玩贪玩蓝月","你知道有多好玩吗"],[]]
["wuyage",["乌鸦哥"],0,0,3,3,["哟 云崽机器人","今天掉线了没","来给他弹个版本过低"],[]]
["yalidaye",["压力大爷"],0,0,3,3,["外界都说我们压力大","我觉得吧压力也没有那么大","主要是28岁了还没媳妇儿"],[]]
["yeshu",["椰树椰汁"],0,0,8,8,["椰子特产在海南","正宗","椰树","29年","坚持在海南岛","用新鲜椰子肉","鲜榨","不用椰浆\n不加香精当生榨"],[]]
["you_dont_get",["你不懂啦"],1,1,0,0,[],["咖波","猫猫虫"]]
["you_should_call",["致电","你应该致电"],1,1,0,0,[],[]]
["your_new_years_eve",["你的跨年"],1,1,0,0,[],[]]
["youtube",["yt","youtube"],0,0,2,2,["Porn","Hub"],[]]
["zengxiaoxian",["曾小贤"],0,0,4,4,["平时你打电子游戏吗","偶尔","星际还是魔兽","连连看"],[]]
`;

export type MemeOpt = { name: string; type: "b" | "s" | "i" | "f"; desc: string; def?: any; choices?: string[]; range?: [number | null, number | null] };
export type Meme = { key: string; kw: string[]; minI: number; maxI: number; minT: number; maxT: number; dt: string[]; tags: string[]; opts: MemeOpt[] };

export const CATALOG: Meme[] = RAW.trim().split("\n").map(l => {
  const r = JSON.parse(l);
  const opts: MemeOpt[] = (r[8] || []).map((o: any[]) => ({ name: o[0], type: o[1], desc: o[2] || "", def: o[3] ?? undefined, ...(Array.isArray(o[4]) && typeof o[4][0] === "string" ? { choices: o[4] } : Array.isArray(o[4]) ? { range: o[4] } : {}) }));
  return { key: r[0], kw: r[1], minI: r[2], maxI: r[3], minT: r[4], maxT: r[5], dt: r[6], tags: r[7], opts };
});
const BY_KEY = new Map(CATALOG.map(m => [m.key, m]));

const norm = (s: string) => String(s ?? "").toLowerCase().replace(/[\s_\-·，。！？,.!?、：:"“”'「」『』（）()]+/g, "");
const bigrams = (s: string) => { const out = new Set<string>(); for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2)); return out; };

/** How well one search term fits a template: exact keyword > keyword inside the wording > wording inside a keyword > shared character pairs. */
function score(m: Meme, term: string): number {
  if (!term) return 0;
  let best = 0;
  const hit = (words: string[], weight: number) => {
    for (const w0 of words) {
      const w = norm(w0);
      if (!w) continue;
      let s = 0;
      if (w === term) s = 100;
      else if (term.includes(w)) s = 60 + Math.min(w.length, 20) * 1.5;
      else if (w.includes(term)) s = 50 + (term.length / w.length) * 10;
      else {
        const a = bigrams(term), b = bigrams(w);
        let n = 0; for (const g of a) if (b.has(g)) n++;
        if (n) s = 20 + Math.min(n, 5) * 2 + (n / Math.max(a.size, 1)) * 8;
      }
      best = Math.max(best, s * weight);
    }
  };
  hit([m.key], 1); hit(m.kw, 1); hit(m.tags, 0.6); hit(m.dt, 0.35);
  return best;
}

// Plain wordings people use that no template keyword contains.
const SYNONYMS: [RegExp, string][] = [
  [/打人|打他|打你|殴打|暴打|教训/, "揍 打拳 锤 一巴掌"], [/亲吻|接吻|么么/, "亲"], [/拥抱/, "抱"], [/摸摸|安慰|抚摸/, "摸头"],
  [/求婚|婚礼|领证/, "结婚申请"], [/表扬|夸/, "表扬 奖状 喜报"], [/祝贺|恭喜|好消息/, "喜报"], [/坏消息|通报/, "悲报"],
  [/丢掉|扔掉|丢弃/, "丢 扔"], [/滚蛋|走开/, "滚 爬"], [/崇拜|佩服/, "膜拜"], [/嫌弃|鄙视/, "垃圾 踩 嘲讽"],
];

/** Templates that fit a wording (a Chinese keyword, or a few words about what is wanted), best first. */
export function findMemes(query: string, limit = 12): { meme: Meme; score: number }[] {
  const q0 = String(query ?? ""), extra = SYNONYMS.filter(([re]) => re.test(q0)).flatMap(([, w]) => w.split(" "));
  const terms = [...new Set([q0].concat(q0.split(/[\s,，、/|]+/), extra).map(norm).filter(Boolean))];
  if (!terms.length) return [];
  return CATALOG.map(meme => ({ meme, score: Math.max(...terms.map(t => score(meme, t))) }))
    .filter(x => x.score >= 25).sort((a, b) => b.score - a.score || a.meme.key.localeCompare(b.meme.key)).slice(0, limit);
}

/** A template from its key or a Chinese keyword; an error text when nothing fits or several fit about equally. */
export function pickMeme(name: string): { meme: Meme } | { error: string } {
  const raw = String(name ?? "").trim();
  if (!raw) return { error: "没说用哪个模板。先用 op=find 搜一下，再把模板的 key 或中文名填进 template" };
  const exact = BY_KEY.get(raw) || BY_KEY.get(raw.toLowerCase()) || CATALOG.find(m => m.kw.some(k => norm(k) === norm(raw)));
  if (exact) return { meme: exact };
  const found = findMemes(raw, 5);
  if (!found.length) return { error: "没有叫「" + raw + "」的模板。用 op=find 换个说法搜搜" };
  const [a, b] = found;
  if (a.score >= 50 && (!b || a.score - b.score >= 8)) return { meme: a.meme };
  return { error: "「" + raw + "」不确定是哪个模板，可能是：" + found.map(x => x.meme.key + "（" + x.meme.kw.join("/") + "）").join("、") + "。把要用的 key 填进 template" };
}

const needImgs = (m: Meme) => (m.maxI === 0 ? "不用图片" : m.minI === m.maxI ? m.minI + " 张图" : m.minI + " 到 " + m.maxI + " 张图");
const needTexts = (m: Meme) => (m.maxT === 0 ? "不用文字" : m.minT === m.maxT ? m.minT + " 段文字" : m.minT === 0 ? "最多 " + m.maxT + " 段文字（可不写）" : m.minT + " 到 " + m.maxT + " 段文字");

/** What `find` returns for one template. */
export function describe(m: Meme) {
  return {
    key: m.key, keywords: m.kw, images: m.minI === m.maxI ? m.minI : m.minI + "-" + m.maxI, texts: m.minT === m.maxT ? m.minT : m.minT + "-" + m.maxT,
    needs: needImgs(m) + "，" + needTexts(m),
    ...(m.dt.length ? { default_texts: m.dt } : {}),
    ...(m.opts.length ? { options: m.opts.map(o => o.name + "（" + (o.desc || o.type) + (o.choices ? "，可选 " + o.choices.join("/") : "") + (o.def !== undefined ? "，默认 " + o.def : "") + "）") } : {}),
  };
}

/** A Chinese complaint when the pictures, texts or options do not fit the template; null when they do. */
export function checkArgs(m: Meme, images: number, texts: string[], options: Record<string, any> = {}): string | null {
  const name = "「" + m.kw[0] + "」";
  if (images < m.minI) return name + "要 " + (m.minI === m.maxI ? m.minI : m.minI + " 到 " + m.maxI) + " 张图，你只给了 " + images + " 张。把图的编号填进 images" + (m.minI > 1 ? "（按顺序，每个人一张）" : "");
  if (images > m.maxI) return m.maxI === 0 ? name + "不用图片，只要文字：" + needTexts(m) + "。images 留空" : name + "最多 " + m.maxI + " 张图，你给了 " + images + " 张，去掉多的";
  if (texts.length < m.minT) return name + "要 " + (m.minT === m.maxT ? m.minT : m.minT + " 到 " + m.maxT) + " 段文字，你只给了 " + texts.length + " 段。" + (m.dt.length ? "它默认的文字是：" + m.dt.map(t => "「" + t.replace(/\n/g, " / ") + "」").join("") + "，照这个意思换成要的内容" : "把文字填进 texts");
  if (texts.length > m.maxT) return m.maxT === 0 ? name + "不用文字，texts 留空" : name + "最多 " + m.maxT + " 段文字，你给了 " + texts.length + " 段，合并或去掉多的";
  for (const [k, v] of Object.entries(options || {})) {
    const o = m.opts.find(x => x.name === k);
    if (!o) return name + "没有叫 " + k + " 的选项" + (m.opts.length ? "，能用的有：" + m.opts.map(x => x.name).join("、") : "，options 留空");
    if (o.choices && !o.choices.includes(String(v))) return "选项 " + k + " 只能是 " + o.choices.join(" / ");
    if (o.type === "i" || o.type === "f") {
      const n = Number(v);
      if (!Number.isFinite(n) || (o.type === "i" && !Number.isInteger(n))) return "选项 " + k + " 要填一个" + (o.type === "i" ? "整数" : "数");
      if (o.range && ((o.range[0] != null && n < o.range[0]) || (o.range[1] != null && n > o.range[1]))) return "选项 " + k + " 要在 " + o.range[0] + " 到 " + o.range[1] + " 之间";
    }
  }
  return null;
}

/** Option values in the type the generator expects. */
export function coerceOptions(m: Meme, options: Record<string, any> = {}): Record<string, boolean | string | number> {
  const out: Record<string, boolean | string | number> = {};
  for (const [k, v] of Object.entries(options || {})) {
    const o = m.opts.find(x => x.name === k);
    out[k] = !o ? v : o.type === "b" ? (v === true || v === "true" || v === 1 || v === "1") : o.type === "i" ? Math.trunc(Number(v)) : o.type === "f" ? Number(v) : String(v);
  }
  return out;
}

// ---------- running it in the cloud computer ----------
const WORKDIR = "/work/meme";
const MARK = "ready-1";

// Reads job.json, makes the meme, writes out-<id>.<ext> and prints one line "MEME_RESULT {json}". Errors of the
// generator come back as objects, so they are reported here instead of crashing.
export const GEN_PY = String.raw`import sys, json
from meme_generator import get_meme, Image
job = json.load(open(sys.argv[1]))
def out(d): print("MEME_RESULT " + json.dumps(d, ensure_ascii=False))
m = get_meme(job["key"])
if m is None:
    out({"err": "NoSuchMeme"}); sys.exit(0)
imgs = [Image(i["name"], open(i["file"], "rb").read()) for i in job["images"]]
r = m.generate(imgs, job["texts"], job["options"])
if isinstance(r, bytes):
    ext = "gif" if r[:3] == b"GIF" else "jpg" if r[:2] == b"\xff\xd8" else "webp" if r[:4] == b"RIFF" else "png"
    p = "out-%s.%s" % (job["id"], ext)
    open(p, "wb").write(r)
    out({"ok": True, "file": p, "size": len(r)})
else:
    d = {"err": type(r).__name__}
    for k in ("min", "max", "actual", "text", "error", "path", "feedback"):
        if hasattr(r, k): d[k] = getattr(r, k)
    out(d)`;

// Installs the package and downloads the resources once per wake-up (the disk is wiped when the machine sleeps).
// flock keeps two simultaneous first uses from downloading twice; the download is tried twice.
const SETUP = [
  "exec 9>.lock; flock 9",
  "if [ ! -f " + MARK + " ]; then",
  "  uv pip install -q --python /opt/py/bin/python meme-generator >&2 || { echo MEME_SETUP_FAILED_INSTALL; exit 3; }",
  "  for n in 1 2; do /opt/py/bin/python -c 'from meme_generator.resources import check_resources as c; c()' >&2 && break; [ $n = 2 ] && { echo MEME_SETUP_FAILED_RESOURCES; exit 3; }; done",
  "  touch " + MARK,
  "fi",
  "flock -u 9",
].join("\n");

export type Job = { id: string; key: string; images: { file: string; name: string }[]; texts: string[]; options: Record<string, any> };

/** The one shell command for the whole generation. The job (texts included) travels as base64, so no quote or
 *  newline in a text can break the command. Input pictures were put in /work as `<file>` by runComputer. */
export function buildCommand(job: Job): string {
  const b64 = btoa(Array.from(new TextEncoder().encode(JSON.stringify(job)), c => String.fromCharCode(c)).join(""));
  const files = job.images.map(i => i.file);
  return [
    "mkdir -p " + WORKDIR + " && cd " + WORKDIR,
    SETUP,
    ...files.map(f => "mv -f ../" + f + " . 2>/dev/null"),
    "printf %s '" + b64 + "' | base64 -d > job-" + job.id + ".json",
    "cat > gen.py <<'MEME_PY_END'\n" + GEN_PY + "\nMEME_PY_END",
    "/opt/py/bin/python gen.py job-" + job.id + ".json 2>gen-" + job.id + ".err; code=$?",
    "rm -f job-" + job.id + ".json " + files.join(" "),
    "[ $code = 0 ] || { tail -c 600 gen-" + job.id + ".err | grep -v Fontconfig >&2; rm -f gen-" + job.id + ".err; exit $code; }",
    "rm -f gen-" + job.id + ".err",
  ].join("\n");
}
export const outPattern = (id: string) => "meme/out-" + id + ".*";

export function mimeOf(name: string): string {
  const ext = (String(name).split(".").pop() || "").toLowerCase();
  return ext === "gif" ? "image/gif" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
}

/** The generator's result line from a step's output, or null. */
export function parseResult(stdout: string): any | null {
  const line = String(stdout || "").split("\n").reverse().find(l => l.startsWith("MEME_RESULT "));
  if (!line) return null;
  try { return JSON.parse(line.slice(12)); } catch { return null; }
}

/** Chinese words for what the generator reported. */
export function explainError(m: Meme, r: any): string {
  const name = "「" + m.kw[0] + "」";
  switch (r?.err) {
    case "NoSuchMeme": return "模板 " + m.key + " 在这个版本里没有了";
    case "ImageNumberMismatch": return name + "要 " + (r.min === r.max ? r.min : r.min + " 到 " + r.max) + " 张图，给了 " + r.actual + " 张";
    case "TextNumberMismatch": return name + "要 " + (r.min === r.max ? r.min : r.min + " 到 " + r.max) + " 段文字，给了 " + r.actual + " 段";
    case "TextOverLength": return "文字「" + String(r.text || "").slice(0, 30) + "」太长，排不下，缩短一点再来";
    case "ImageDecodeError": return "有一张图读不出来（格式不支持或文件坏了），换一张图试试";
    case "MemeFeedback": return String(r.feedback || "这个模板没法用这些内容生成");
    case "ImageAssetMissing": return "模板素材缺了一个文件，云电脑上的素材可能没下载完整，稍后再试一次";
    case "DeserializeError": return "选项的值模板不认：" + String(r.error || "").slice(0, 120);
    case "ImageEncodeError": return "图片生成出来后编码失败了，再试一次";
    default: return "生成失败：" + String(r?.err || "未知原因");
  }
}

const sniffExt = (b: Uint8Array, mime: string) =>
  b[0] === 0x47 && b[1] === 0x49 ? "gif" : b[0] === 0xff && b[1] === 0xd8 ? "jpg" : b[0] === 0x52 && b[1] === 0x49 ? "webp" : b[0] === 0x89 ? "png" : mime.split("/")[1]?.replace("jpeg", "jpg").replace(/[^a-z0-9]/g, "") || "png";

/** A reference as the model may write it ("[图片 123-0]", " g12 ", "奶蛙") reduced to what imageRef understands. */
const cleanRef = (s: any) => { const t = String(s ?? "").trim(); const m = t.match(/(?:图片\s*)?(\d+-\d+|g\d+)/i); return /^\[.*\]$/.test(t) && m ? m[1] : t; };

const HOT = "摸头（petpet，动图）、拍、吃、结婚申请、举牌（要文字）、喜报、悲报（要文字）、亲亲（2 张图）、抱抱（2 张图）、贴贴（2 张图）、揍（2 张图）、扔、爬、垃圾桶、小丑、国旗、奖状（3–4 段文字）、王境泽（4 段文字）、我朋友说（1 图 + 文字）、一直、永远爱你、我永远喜欢、咖波说（文字）、鲁迅说（文字）、膜拜、踩、震惊、精神支柱、万能表情（1 图 + 文字）";

const feature: Feature = {
  name: "meme",
  tunables: { meme_daily: { default: 80, min: 0, max: 500, what: "每天最多做几个表情包" } },
  about: [
    "做表情包用 meme 工具：套现成的表情包模板（摸头、拍、举牌、结婚申请等约 300 个），拿群里的图、我画过的图或保存的形象，配上文字，几秒出图，动图保持动图",
    "模板由开源库 meme-generator 在云电脑里生成；云电脑每次开机后第一次做表情包要先装库、下素材，要多等一分多钟，之后很快",
    "做表情包不花画图额度，有自己的每日上限（meme_daily，默认 80）；想画全新的东西用 generate_image",
  ],
  tools(ctx): Tool[] {
    const host = ctx.host;
    return [{
      name: "meme", slow: true,
      description: "套现成的表情包模板做图：把已有的图片（和文字）套进“摸头”“举牌”“结婚申请”这类模板，免费、几秒出图，动图模板出来还是动图。群友说“摸摸他”“做个举牌表情包”“把这张图做成喜报”就用它；要画全新的东西、改画风、画没有的画面用 generate_image。两个 op：find 按中文关键词或想要的效果搜模板（最多 12 个，返回 key、中文名、要几张图几段文字、默认文字），拿不准用哪个先 find；make 生成。make 的 template 填 key 或中文名；images 填图的来源，按模板需要的张数给（聊天里的图 123-0、你画过的图 g12、保存的形象名字如 奶蛙；需要两张图的模板按谁在前谁在后的顺序给，如“亲”是 先亲的人、被亲的人）；texts 填文字，每段对应模板里的一处文字，不需要文字的模板留空；options 极少用，如摸头 {\"circle\":true} 把图变圆。deliver 默认 true 直接发群里，只是素材时填 false，只返回编号。常用模板（中文名，括号里是特点）：" + HOT + "。不确定叫什么、要几张图，先 find。",
      parameters: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["find", "make"], description: "find 搜模板，make 生成" },
          query: { type: "string", description: "find 用：中文关键词或想要的效果，如 摸头、举牌、结婚、吃掉、打人" },
          template: { type: "string", description: "make 用：模板的 key（如 petpet）或中文名（如 摸头）" },
          images: { type: "array", items: { type: "string" }, description: "make 用：图的来源，聊天里的图 123-0、你画过的图 g12、保存的形象名字；按模板要的张数和顺序给" },
          texts: { type: "array", items: { type: "string" }, description: "make 用：模板里的文字，按顺序一段一项；不需要文字就不填" },
          options: { type: "object", description: "make 用：模板的特殊选项，find 的结果里列了名字，一般不用填" },
          deliver: { type: "boolean", description: "默认 true，做完直接发群里。只是素材、之后要排进别的东西时填 false：不发群，只返回编号" },
        },
        required: ["op"],
      },
      run: async (a: any) => {
        if (a?.op === "find") {
          const found = findMemes(String(a.query ?? a.template ?? ""), 12);
          if (!found.length) return { ok: true, matches: [], note: "没搜到。换个说法，或者用更短的关键词（如 摸、拍、吃、抱）再 find 一次" };
          return { ok: true, matches: found.map(x => describe(x.meme)), note: "用 op=make，template 填 key 或中文名；images、texts 按每个模板需要的数量给" };
        }
        if (a?.op !== "make") return { ok: false, error: "op 只能是 find 或 make" };

        const picked = pickMeme(String(a.template ?? ""));
        if ("error" in picked) return { ok: false, error: picked.error };
        const m = picked.meme;
        const texts = (Array.isArray(a.texts) ? a.texts : a.texts == null || a.texts === "" ? [] : [a.texts]).map((t: any) => String(t));
        const refs = (Array.isArray(a.images) ? a.images : a.images ? [a.images] : []).map(cleanRef).filter(Boolean);
        const options = a.options && typeof a.options === "object" ? a.options : {};
        const bad = checkArgs(m, refs.length, texts, options);
        if (bad) return { ok: false, error: bad };

        const loaded: { ref: string; label: string; bytes: Uint8Array; mime: string }[] = [];
        for (const ref of refs) {
          const got = await host.imageRef(ref).catch(() => null);
          if (!got) return { ok: false, error: "图 " + ref + " 找不到（可能过期了，或编号写错了）。让群友重发一次图，或换一张" };
          loaded.push({ ref, label: got.label || ref, bytes: got.bytes, mime: got.mime });
        }
        if (!(await host.quota("meme", Number(host.cfg("meme_daily"))))) return { ok: false, error: "今天做表情包的次数用完了，明天再做" };

        const id = Math.random().toString(36).slice(2, 8) + (host.now() % 100000).toString(36);
        const files = loaded.map((p, i) => ({ name: "meme_" + id + "_" + i + "." + sniffExt(p.bytes, p.mime), bytes: p.bytes }));
        const job: Job = { id, key: m.key, images: loaded.map((p, i) => ({ file: files[i].name, name: p.label })), texts, options: coerceOptions(m, options) };
        const out = await host.computer({ commands: [buildCommand(job)], files, collect: [outPattern(id)], timeoutSeconds: 330 });
        const step = out.steps[0];
        const setupFail = /MEME_SETUP_FAILED/.test(step?.stdout || "");
        if (setupFail) return { ok: false, error: "表情包工具在云电脑上没装成功（下载素材失败），过几分钟再试一次" };
        const res = parseResult(step?.stdout || "");
        if (res && res.err) return { ok: false, error: explainError(m, res) };
        const file = out.files.find(f => f.name.startsWith("meme/out-" + id));
        if (!out.ok || !res || !file) {
          const why = out.error || (step && step.exit === 124 ? "超时了" : step?.stderr?.trim() ? step.stderr.trim().slice(-200) : "没有产出");
          return { ok: false, error: "表情包生成失败：" + why };
        }
        const mime = mimeOf(file.name), deliver = a.deliver !== false;
        const note = "表情包：" + m.kw[0] + (texts.length ? "（" + texts.join(" ").slice(0, 30) + "）" : "");
        const sent = await host.sendImage(file.bytes, note, mime, !deliver);
        if (!sent.ok) return { ok: false, sent: false, error: sent.error || "图做好了但没发出去" };
        return {
          ok: true, template: m.key, name: m.kw[0], format: mime === "image/gif" ? "动图" : "静图", kb: Math.round(file.bytes.length / 1024), seconds: out.seconds,
          ...(out.bootstrap_seconds ? { note_boot: "电脑刚开机，装软件用了 " + out.bootstrap_seconds + " 秒" } : {}),
          ...(deliver ? { sent: true, ...(sent.id ? { id: sent.id } : {}), ...(sent.queued ? { delivery: "群里暂时发不出去，已排队，稍后自动补发" } : {}) } : { sent: false, id: sent.id, note: "没发群里，只是素材：" + (sent.id || "没存下") }),
        };
      },
    }];
  },
};
export default feature;
