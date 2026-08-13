const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');

// ===================== Config =====================
const CONFIG_COUNTRIES = ['Spain','Germany','France','Poland','Italy','Russia','Greece','Croatia'];

// ===================== Password Hashing =====================
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return salt + ':' + hash;
}

function verifyPassword(password, stored) {
  try {
    const [salt, hash] = stored.split(':');
    const testHash = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(testHash, 'hex'));
  } catch {
    return false;
  }
}

// ===================== Session Tokens =====================
const sessions = new Map(); // token -> { userId, username, createdAt }

function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId: user.id, username: user.username, createdAt: Date.now() });
  // Expire after 12 hours
  setTimeout(() => sessions.delete(token), 12 * 60 * 60 * 1000);
  return token;
}

function getSession(token) {
  return sessions.get(token);
}

function destroySession(token) {
  sessions.delete(token);
}

// ===================== Data Layer =====================
function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveData(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function logActivity(action, customer, user) {
  const entry = {
    id: crypto.randomUUID(),
    action,
    companyName: customer.companyName,
    country: customer.country,
    funnelStage: customer.funnelStage,
    user: user ? user.displayName : 'System',
    timestamp: new Date().toISOString()
  };
  db.activity.unshift(entry);
  if (db.activity.length > 100) db.activity.pop();
  io.emit('activity:new', entry);
}

// ===================== Permission Helpers =====================
function canEditCountry(user, country) {
  if (user.role === 'super_admin') return true;
  return user.assignedCountries.includes(country);
}

function sanitizeUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    assignedCountries: user.assignedCountries,
    color: user.color
  };
}

// ===================== Auth Middleware =====================
function authMiddleware(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token) return res.status(401).json({ error: '未提供认证令牌' });
  const session = getSession(token);
  if (!session) return res.status(401).json({ error: '会话已过期' });
  const user = db.users.find(u => u.id === session.userId);
  if (!user) return res.status(401).json({ error: '用户不存在' });
  req.user = user;
  req.token = token;
  next();
}

// ===================== Seed Data =====================
const SEED_USERS = [
  { id: 'u1', username: 'michelle', displayName: 'Michelle', role: 'super_admin', assignedCountries: ['France','Poland'], color: '#3b82f6', password: hashPassword('michelle2026') },
  { id: 'u2', username: 'terry', displayName: 'Terry', role: 'super_admin', assignedCountries: ['Spain','Germany'], color: '#10b981', password: hashPassword('terry2026') },
  { id: 'u3', username: 'alla', displayName: 'Alla', role: 'country_admin', assignedCountries: ['Russia','Italy'], color: '#f59e0b', password: hashPassword('alla2026') },
  { id: 'u4', username: 'chris', displayName: 'Chris', role: 'country_admin', assignedCountries: ['Greece','Croatia'], color: '#8b5cf6', password: hashPassword('chris2026') }
];

// [name, type, country, contact, email, phone, website, products[], stage, value, assignedTo, notes]
const FOLLOWUP_TYPES = ['电话沟通', '邮件往来', '视频会议', '现场拜访', '样品寄送', '报价发送', '合同谈判', '其他'];

// 跟进内容模板（按漏斗阶段匹配）
const FOLLOWUP_TEMPLATES = {
  Lead: [
    '初次接触Cold Call，介绍华普永明产品线和欧洲市场布局，对方表示有兴趣进一步沟通',
    '通过LinkedIn建立联系，已发送公司简介+产品手册PDF',
    '客户收到资料，约定下周电话会议详细沟通需求'
  ],
  Qualified: [
    '电话会议详细沟通产品规格、认证（CE/ENEC/TÜV）、交期，客户技术团队反馈积极',
    '视频会议演示LED路灯+AI控制器+储能完整方案，客户对智能控制系统兴趣浓厚',
    '客户确认预算区间和招标时间表，安排寄送样品测试'
  ],
  Proposal: [
    '发送正式报价单（含DDP、CIF两种贸易条款）和技术规格书，等待客户内审',
    '客户反馈报价偏高，争取通过批量优惠+长期框架协议调整价格',
    '按客户要求补充ENEC、CE、TÜV认证证书扫描件+测试报告',
    '参加客户组织的线上答疑会议，技术+商务团队Q&A完整记录'
  ],
  Negotiation: [
    '客户内审通过，谈判合同条款：付款方式T/T 30/70、交期、质保期、售后响应',
    '现场拜访客户总部，参观路灯安装案例+工厂连线演示，建立深度信任',
    'EMC（合同能源管理）模式谈判：节能收益分成比例、测量验证方案',
    '锁定最终价格，进入法务合同审阅阶段'
  ],
  Won: [
    '合同正式签订，确认首批订单数量+交付节点+开票信息',
    '已收预付款30%，工厂排产中，下周发生产线照片+质量跟踪表',
    '首批货物到港清关完成，已发货至客户仓库'
  ],
  Lost: [
    '客户最终选择竞品方案（价格更低或本地化优势），保持定期回访争取下次机会'
  ]
};

function generateSeedFollowups(customer) {
  const stage = customer.funnelStage;
  const templates = FOLLOWUP_TEMPLATES[stage] || FOLLOWUP_TEMPLATES.Lead;
  // 跟进次数：Won 3次、Negotiation 4次、Proposal 3次、Qualified 2次、Lead 1次、Lost 1次
  const countByStage = { Won: 3, Negotiation: 4, Proposal: 3, Qualified: 2, Lead: 1, Lost: 1 };
  const count = countByStage[stage] || 2;
  const customerCreated = new Date(customer.createdAt);
  const now = new Date('2026-08-13T15:00:00Z');
  const span = now - customerCreated;
  const followups = [];
  for (let i = 0; i < count; i++) {
    const createdAt = new Date(customerCreated.getTime() + (span * (i + 1) / (count + 1)));
    const type = FOLLOWUP_TYPES[Math.floor(Math.abs(hashCode(customer.id + i)) % FOLLOWUP_TYPES.length)];
    const content = templates[i % templates.length];
    const nextFollowAt = i === count - 1
      ? new Date(createdAt.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()
      : null;
    followups.push({
      id: crypto.randomUUID(),
      customerId: customer.id,
      type,
      content,
      followAt: createdAt.toISOString(),
      nextFollowAt,
      createdBy: customer.assignedTo,
      createdByName: customer.assignedTo === 'michelle' ? 'Michelle'
        : customer.assignedTo === 'terry' ? 'Terry'
        : customer.assignedTo === 'alla' ? 'Alla'
        : customer.assignedTo === 'chris' ? 'Chris' : customer.assignedTo,
      createdAt: createdAt.toISOString()
    });
  }
  return followups;
}

// 简单字符串哈希（用于种子数据稳定的随机分布）
function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h) + str.charCodeAt(i);
  return h;
}

const SEED_RAW = [
  // ==================== 西班牙 Spain -> terry ====================
  ['Cobra Instalaciones y Servicios','EPC','Spain','Javier Garcia','jgarcia@cobra.es','+34 917 223 300','grupocobra.com',['LED Street Light','LED Tunnel Light'],'Negotiation',1200000,'terry','Madrid城市照明改造项目，需求约3000套路灯'],
  ['Endesa X','ESCO','Spain','Maria Lopez','mlopez@endesax.es','+34 913 792 000','endesax.com',['LED Street Light','Solar Street Light'],'Proposal',850000,'terry','巴塞罗那智慧城市照明项目，含智能控制系统'],
  ['Artec Lighting','Distributor','Spain','Carlos Sanchez','csanchez@arteclighting.es','+34 914 556 700','arteclighting.es',['LED Street Light'],'Qualified',320000,'terry','瓦伦西亚区域经销商，有稳定渠道'],
  ['GRESA','Contractor','Spain','Ana Torres','atorres@gresa.es','+34 976 123 456','gresa.es',['LED Street Light','Solar Street Light'],'Lead',450000,'terry','萨拉戈萨道路照明工程承包商'],
  ['Urbaser','Investor','Spain','Pedro Martin','pmartin@urbaser.com','+34 914 100 100','urbaser.com',['LED Street Light'],'Won',2100000,'terry','塞维利亚全市LED路灯改造PPP项目已签约'],
  ['ACS Group','EPC','Spain','Rafael Delgado','rdelgado@acs.com.es','+34 913 338 100','acs.com.es',['LED Street Light','LED Tunnel Light'],'Proposal',1650000,'terry','西班牙最大基建集团，马德里主干道照明EPC项目'],
  ['FCC Construccion','EPC','Spain','Beatriz Ruiz','bruiz@fcc.es','+34 917 499 000','fcc.es',['LED Street Light','LED Tunnel Light'],'Lead',920000,'terry','毕尔巴鄂城市基础设施EPC，含照明系统'],
  ['Iberdrola Servicios','ESCO','Spain','Antonio Moreno','amoreno@iberdrola.es','+34 901 200 200','iberdrola.es',['LED Street Light','Solar Street Light'],'Qualified',1350000,'terry','Iberdrola子公司，安达卢西亚节能照明EMC合同'],
  ['Elecnor','Contractor','Spain','Carmen Vidal','cvidal@elecnor.es','+34 914 313 100','elecnor.es',['LED Street Light','LED Tunnel Light'],'Negotiation',780000,'terry','马德里大区公路隧道照明工程承包商'],
  ['Signify Spain','Distributor','Spain','David Castro','dcastro@signify.es','+34 914 828 000','signify.es',['LED Street Light','LED Tunnel Light','Solar Street Light'],'Proposal',560000,'terry','飞利浦照明西班牙分销，智慧路灯+InteractCity系统'],
  ['Schrader Spain','Brand','Spain','Patricia Nunez','pnunez@schrader.es','+34 913 286 500','schrader.es',['LED Street Light'],'Lead',290000,'terry','Schrader伊比利亚区域品牌，关注城市美化照明'],
  ['Sonepar Iberia','Distributor','Spain','Roberto Aguilar','raguilar@sonepar.es','+34 932 280 300','sonepar.es',['LED Street Light'],'Lead',410000,'terry','西班牙全国电气分销巨头，覆盖50省'],
  ['Naturgy Servicios','ESCO','Spain','Sandra Diez','sdiez@naturgy.es','+34 901 220 220','naturgy.es',['LED Street Light','Solar Street Light'],'Lead',680000,'terry','原Gas Natural Fenosa，瓦伦西亚EMC节能照明项目'],

  // ==================== 德国 Germany -> terry ====================
  ['Hochtief','EPC','Germany','Klaus Weber','kweber@hochtief.de','+49 201 182 0','hochtief.com',['LED Street Light','LED Tunnel Light'],'Proposal',1500000,'terry','柏林高速公路隧道照明项目'],
  ['Stadtwerke Munchen','ESCO','Germany','Sabine Schmidt','sschmidt@swm.de','+49 89 6378 0','swm.de',['LED Street Light'],'Negotiation',980000,'terry','慕尼黑市政照明节能改造项目'],
  ['Siteco','Manufacturer','Germany','Thomas Bauer','tbauer@siteco.de','+49 871 302 0','siteco.de',['LED Street Light','LED Tunnel Light'],'Qualified',560000,'terry','德国本土制造商，有OEM合作意向'],
  ['Selux','Brand','Germany','Andreas Fischer','afischer@selux.de','+49 30 6107 0','selux.de',['LED Street Light'],'Lead',280000,'terry','柏林品牌商，关注高端景观道路照明'],
  ['Elektror','Distributor','Germany','Julia Wagner','jwagner@elektror.de','+49 711 8109 0','elektror.de',['LED Street Light'],'Won',430000,'terry','斯图加特电气分销商，首批订单已交付'],
  ['Bilfinger SE','EPC','Germany','Hans Mueller','hmueller@bilfinger.de','+49 621 108 0','bilfinger.com',['LED Street Light','LED Tunnel Light'],'Negotiation',1750000,'terry','法兰克福城市照明EPC总承包，含智能控制'],
  ['STRABAG','Contractor','Germany','Petra Schneider','pschneider@strabag.de','+49 201 260 0','strabag.com',['LED Street Light','LED Tunnel Light'],'Proposal',980000,'terry','科隆-亚琛高速公路照明工程承包'],
  ['EnBW','ESCO','Germany','Michael Braun','mbraun@enbw.com','+49 711 789 0','enbw.com',['LED Street Light','Solar Street Light'],'Qualified',1250000,'terry','巴登-符腾堡州ESCO，斯图加特节能照明合同'],
  ['Trilux','Manufacturer','Germany','Stefan Hoffmann','shoffmann@trilux.de','+49 2932 993 0','trilux.de',['LED Street Light','LED Tunnel Light'],'Lead',470000,'terry','德国领先照明制造商，多用途LED路灯产品线'],
  ['RheinEnergie AG','ESCO','Germany','Katrin Becker','kbecker@rheinenergie.com','+49 221 178 0','rheinenergie.com',['LED Street Light'],'Lead',890000,'terry','科隆最大能源服务公司，城市照明EMC项目'],
  ['Sonepar Deutschland','Distributor','Germany','Felix Richter','frichter@sonepar.de','+49 30 6108 0','sonepar.de',['LED Street Light'],'Lead',520000,'terry','德国全境电气分销网络，B2B渠道覆盖广泛'],
  ['ThyssenKrupp Infrastructure','EPC','Germany','Wolfgang Hartmann','whartmann@thyssenkrupp.com','+49 201 844 0','thyssenkrupp.com',['LED Tunnel Light'],'Lead',2100000,'terry','鲁尔区隧道照明EPC项目，含智能监控'],

  // ==================== 法国 France -> michelle ====================
  ['VINCI Energies','EPC','France','Jean-Pierre Martin','jpmartin@vinci-energies.fr','+33 1 7276 3000','vinci-energies.com',['LED Street Light','LED Tunnel Light'],'Negotiation',2200000,'michelle','巴黎大区城市照明EPC总承包项目'],
  ['Dalkia','ESCO','France','Sophie Bernard','sbernard@dalkia.fr','+33 1 5560 7000','dalkia.fr',['LED Street Light','Solar Street Light'],'Proposal',1100000,'michelle','里昂节能照明服务合同'],
  ['Schreder','Brand','France','Antoine Dubois','adubois@schreder.com','+33 1 3486 9000','schreder.com',['LED Street Light','LED Tunnel Light'],'Won',1850000,'michelle','法国最大照明品牌商，年度框架协议已签'],
  ['Rexel France','Distributor','France','Marie Laurent','mlaurent@rexel.fr','+33 1 7276 7276','rexel.fr',['LED Street Light'],'Qualified',390000,'michelle','法国全国性电气分销网络'],
  ['Spie Batignolles','Contractor','France','Philippe Roux','proux@spiebatignolles.fr','+33 1 4197 7000','spiebatignolles.fr',['LED Street Light','LED Tunnel Light'],'Lead',670000,'michelle','马赛港口照明工程承包商'],
  ['Eiffage Energie Systemes','EPC','France','Claire Moreau','cmoreau@eiffage.com','+33 1 3493 6000','eiffage.com',['LED Street Light','LED Tunnel Light'],'Proposal',1650000,'michelle','图卢兹大区城市照明EPC，含远程管理系统'],
  ['Citelum (EDF)','ESCO','France','Nicolas Petit','npetit@citelum.fr','+33 1 5560 9000','citelum.fr',['LED Street Light','LED Tunnel Light'],'Negotiation',1420000,'michelle','EDF旗下城市照明专业ESCO，覆盖法国200+城市'],
  ['Bouygues Energies & Services','EPC','France','Julie Fournier','jfournier@bouygues-es.fr','+33 1 4825 6000','bouygues-es.com',['LED Street Light','Solar Street Light'],'Proposal',1280000,'michelle','南特-波尔多城市照明EPC+维护合同'],
  ['Engie Ineo','Contractor','France','Pascal Lefebvre','plefebvre@engie.com','+33 1 4422 0000','engie.com',['LED Street Light','LED Tunnel Light'],'Qualified',890000,'michelle','Engie旗下电气工程承包商，斯特拉斯堡公路照明'],
  ['Sonepar France','Distributor','France','Anne Girard','agirard@sonepar.fr','+33 1 3079 5000','sonepar.fr',['LED Street Light'],'Lead',450000,'michelle','法国最大电气分销商，B2B覆盖全法'],
  ['Fonroche Lighting','Manufacturer','France','Olivier Roy','oroy@fonroche-lighting.com','+33 555 555 555','fonroche-lighting.com',['Solar Street Light'],'Lead',380000,'michelle','法国太阳能路灯制造商，离网照明方案'],
  ['Eiffage Route','Contractor','France','Bruno Henry','bhenry@eiffage.com','+33 1 3493 1000','eiffage.com',['LED Street Light'],'Lead',560000,'michelle','Eiffage道路工程部门，里尔公路照明承包'],
  ['Saur Group','ESCO','France','Isabelle Martinez','imartinez@saur.com','+33 1 4053 6000','saur.com',['LED Street Light','Solar Street Light'],'Lead',720000,'michelle','法国环境服务集团，含市政照明EMC'],

  // ==================== 波兰 Poland -> michelle ====================
  ['Lena Lighting','Manufacturer','Poland','Piotr Nowak','pnowak@lenalighting.pl','+48 85 7435 100','lenalighting.com',['LED Street Light','LED Tunnel Light'],'Proposal',520000,'michelle','波兰最大照明制造商之一，OEM合作'],
  ['ZUMA Line','Manufacturer','Poland','Katarzyna Wisniewska','kwisniewska@zumaline.pl','+48 22 123 4567','zumaline.pl',['LED Street Light'],'Qualified',340000,'michelle','华沙照明制造商，产品线互补'],
  ['MT Elektro','Distributor','Poland','Marcin Kowalczyk','mkowalczyk@mtelektro.pl','+48 22 456 7890','mtelektro.pl',['LED Street Light','Solar Street Light'],'Lead',180000,'michelle','波兰全国电气分销商'],
  ['Tauron','ESCO','Poland','Anna Wojcik','awojcik@tauron.pl','+48 328 234 567','tauron.pl',['LED Street Light'],'Negotiation',890000,'michelle','波兰最大电力公司，城市照明节能改造'],
  ['Budimex','EPC','Poland','Tomasz Kaminski','tkaminski@budimex.pl','+48 22 511 8000','budimex.pl',['LED Street Light','LED Tunnel Light'],'Proposal',1350000,'michelle','波兰最大基建EPC，华沙主干道照明改造'],
  ['ES-System','Manufacturer','Poland','Grzegorz Mazur','gmazur@essystem.pl','+48 12 298 0100','essystem.pl',['LED Street Light','LED Tunnel Light'],'Qualified',430000,'michelle','克拉科夫照明制造商，出口欧盟多国'],
  ['PGE Polska Grupa Energetyczna','ESCO','Poland','Magdalena Zielinska','mzielinska@pge.pl','+48 22 340 5000','pge.pl',['LED Street Light','Solar Street Light'],'Lead',1120000,'michelle','波兰最大电力公用事业，全国EMC照明项目'],
  ['Elektrotim','Contractor','Poland','Przemyslaw Wójcik','pwojcik@elektrotim.pl','+48 32 724 5000','elektrotim.pl',['LED Street Light','LED Tunnel Light'],'Qualified',680000,'michelle','卡托维兹电气工程承包商，西里西亚公路照明'],
  ['Enea','ESCO','Poland','Katarzyna Lewandowska','klewandowska@enea.pl','+48 22 311 6000','enea.pl',['LED Street Light'],'Lead',790000,'michelle','波兰第三大电力公司，波兹南节能照明项目'],
  ['Onninen Polska','Distributor','Poland','Robert Adamski','radamski@onninen.pl','+48 22 373 7000','onninen.pl',['LED Street Light'],'Lead',250000,'michelle','芬兰电气分销商波兰分部，覆盖全国B2B'],
  ['Erbud','Contractor','Poland','Marek Dabrowski','mdabrowski@erbud.pl','+48 22 101 2000','erbud.pl',['LED Street Light'],'Lead',410000,'michelle','华沙大型建筑工程承包商，含照明系统'],
  ['Mirbud','EPC','Poland','Stanislaw Sikora','ssikora@mirbud.pl','+48 22 103 3000','mirbud.pl',['LED Street Light','LED Tunnel Light'],'Lead',580000,'michelle','格但斯克基建EPC，含港口及道路照明'],
  ['LUG Light Factory','Manufacturer','Poland','Wojciech Zielinski','wzielinski@luglight.pl','+48 81 535 0100','luglight.pl',['LED Street Light','LED Tunnel Light'],'Qualified',360000,'michelle','卢布林LED制造商，路灯与隧道灯产品线'],

  // ==================== 意大利 Italy -> alla ====================
  ['AEC Illumazione','Manufacturer','Italy','Giorgio Conti','gconti@aeclighting.it','+39 035 651111','aeclighting.com',['LED Street Light','LED Tunnel Light'],'Negotiation',760000,'alla','意大利高端照明制造商'],
  ['iGuzzini','Brand','Italy','Francesca Bianchi','fbianchi@iguzzini.it','+39 071 6901','iguzzini.it',['LED Street Light','LED Tunnel Light'],'Proposal',1300000,'alla','意大利顶级照明品牌，罗马项目合作'],
  ['Disano','Manufacturer','Italy','Luca Romano','lromano@disano.it','+39 011 9305 1','disano.it',['LED Street Light'],'Qualified',450000,'alla','都灵照明制造商，性价比高'],
  ['Salini Impregilo','EPC','Italy','Marco Ferrara','mferrara@salini-impregilo.com','+39 06 8747 1','salini-impregilo.com',['LED Tunnel Light'],'Lead',1800000,'alla','意大利最大基建EPC，隧道项目'],
  ['ABB SACE','Contractor','Italy','Stefano Colombo','scolombo@abb.it','+39 02 2414 1','abb.com',['LED Street Light'],'Won',620000,'alla','ABB意大利电气承包部门，已完成交货'],
  ['Webuild','EPC','Italy','Andrea Mancini','amancini@webuild.com','+39 02 4389 1','webuild.com',['LED Tunnel Light','LED Street Light'],'Qualified',1650000,'alla','原Salini Impregilo更名，米兰-那不勒斯隧道照明'],
  ['A2A','ESCO','Italy','Chiara Greco','cgreco@a2a.eu','+39 02 6305 1','a2a.eu',['LED Street Light','Solar Street Light'],'Proposal',980000,'alla','伦巴第大区多能源服务公司，布雷西亚照明EMC'],
  ['GEWISS','Brand','Italy','Roberto Ferrara','rferrara@gewiss.com','+39 035 836 0','gewiss.com',['LED Street Light'],'Lead',520000,'alla','意大利电气+照明品牌，北意大利用户基础好'],
  ['Iren','ESCO','Italy','Giulia Marino','gmarino@iren.it','+39 010 555 1','iren.it',['LED Street Light','Solar Street Light'],'Qualified',720000,'alla','热那亚-帕尔马多能源公司，利古里亚照明项目'],
  ['Rexel Italia','Distributor','Italy','Fabio Conti','fconti@rexel.it','+39 02 318 1','rexel.it',['LED Street Light'],'Lead',380000,'alla','Rexel意大利分部，全国电气B2B分销'],
  ['Astaldi','EPC','Italy','Paolo Russo','prusso@astaldi.com','+39 06 8395 1','astaldi.com',['LED Street Light','LED Tunnel Light'],'Lead',1150000,'alla','罗马基建EPC，含城市道路照明系统'],
  ['Artemide','Brand','Italy','Valentina Costa','vcosta@artemide.com','+39 02 394 751','artemide.com',['LED Street Light'],'Lead',440000,'alla','意大利高端照明设计品牌，景观+建筑照明'],

  // ==================== 俄罗斯 Russia -> alla ====================
  ['Lighting Technologies','Manufacturer','Russia','Dmitri Volkov','dvolkov@ltcompany.ru','+7 495 785 5555','ltcompany.ru',['LED Street Light','LED Tunnel Light'],'Proposal',950000,'alla','俄罗斯最大照明制造商，莫斯科项目'],
  ['Varton','Manufacturer','Russia','Elena Sokolova','esokolova@varton.ru','+7 495 120 3040','varton.ru',['LED Street Light'],'Qualified',420000,'alla','莫斯科LED制造商，OEM合作'],
  ['M-Energy','Distributor','Russia','Sergei Ivanov','sivanov@m-energy.ru','+7 812 333 4455','m-energy.ru',['LED Street Light','Solar Street Light'],'Lead',230000,'alla','圣彼得堡能源设备分销商'],
  ['Rosseti','ESCO','Russia','Andrei Petrov','apetrov@rosseti.ru','+7 495 995 9090','rosseti.ru',['LED Street Light','LED Tunnel Light'],'Negotiation',1850000,'alla','俄罗斯国家电网公司，全国LED照明节能改造'],
  ['Itera','EPC','Russia','Olga Smirnova','osmirnova@iteragroup.com','+7 495 913 5500','iteragroup.com',['LED Street Light'],'Proposal',680000,'alla','莫斯科能源基建EPC，含城市照明改造'],
  ['EKF Electrotechnica','Distributor','Russia','Maxim Sokolov','msokolov@ekf.com','+7 812 320 4000','ekf.com',['LED Street Light','LED Tunnel Light'],'Qualified',480000,'alla','俄罗斯最大电气分销商之一，全国仓储网络'],
  ['K-Light Group','Manufacturer','Russia','Natalia Orlova','norlova@klight.ru','+7 812 387 5500','klight.ru',['LED Street Light'],'Lead',290000,'alla','圣彼得堡LED照明制造商，性价比路线'],
  ['Stroygazconsulting','Contractor','Russia','Viktor Morozov','vmorozov@sgcm.ru','+7 343 218 0000','sgcm.ru',['LED Street Light','LED Tunnel Light'],'Lead',890000,'alla','叶卡捷琳堡基建承包商，乌拉尔区公路照明'],
  ['Inter RAO UES','ESCO','Russia','Pavel Kozlov','pkozlov@interrao.ru','+7 495 969 7000','interrao.ru',['LED Street Light','Solar Street Light'],'Lead',1320000,'alla','俄罗斯能源巨头，莫斯科区域ESCO项目'],
  ['Blagovest-S','Contractor','Russia','Irina Lebedeva','ilebedeva@blagovest-s.ru','+7 812 640 3000','blagovest-s.ru',['LED Street Light'],'Lead',320000,'alla','圣彼得堡电气工程承包商，城市照明施工'],

  // ==================== 希腊 Greece -> chris ====================
  ['HEDNO','ESCO','Greece','Nikos Papadopoulos','npapadopoulos@hedno.gr','+30 210 9466 000','hedno.gr',['LED Street Light','Solar Street Light'],'Negotiation',750000,'chris','希腊配电网络运营商，雅典照明改造'],
  ['Andromeda Lighting','Distributor','Greece','Elena Papadaki','epapadaki@andromeda-lighting.gr','+30 210 8967 000','andromeda-lighting.gr',['LED Street Light'],'Qualified',190000,'chris','塞萨洛尼基照明分销商'],
  ['Aktor (Ellaktor)','EPC','Greece','Dimitris Kostas','dkostas@aktor.gr','+30 210 7935 000','aktor.gr',['LED Street Light','LED Tunnel Light'],'Lead',380000,'chris','希腊大型基建工程承包商'],
  ['PPC (Public Power Corp)','ESCO','Greece','Yannis Pappas','ypappas@dei.gr','+30 210 523 5000','dei.gr',['LED Street Light','Solar Street Light'],'Proposal',1080000,'chris','希腊国家电力公司，全国路灯节能改造'],
  ['J&P Avax','EPC','Greece','Maria Georgiou','mgeorgiou@jpavax.gr','+30 210 860 3000','jpavax.gr',['LED Street Light','LED Tunnel Light'],'Proposal',920000,'chris','雅典大型基建EPC，克里特岛照明项目'],
  ['TER S.A.','Contractor','Greece','Spiros Athanasiou','sathanasiou@ter.gr','+30 210 924 5000','ter.gr',['LED Street Light'],'Lead',520000,'chris','雅典道路工程承包商，阿提卡大区照明施工'],
  ['Schrader Hellas','Distributor','Greece','Dimitra Iakovou','diakovou@schrader.gr','+30 210 682 5000','schrader.gr',['LED Street Light','LED Tunnel Light'],'Qualified',380000,'chris','Schrader希腊分销子公司，覆盖全国'],
  ['Mytilineos Energy','Investor','Greece','Thanos Dimitriou','tdimitriou@mytilineos.gr','+30 210 689 8000','mytilineos.gr',['LED Street Light','Solar Street Light'],'Lead',720000,'chris','希腊最大能源+冶金集团，投资光伏+照明'],
  ['Plaisio S.E.','Contractor','Greece','Anna Vlachou','avlachou@plaisio.gr','+30 210 393 4000','plaisio.gr',['LED Street Light'],'Lead',290000,'chris','塞萨洛尼基电气工程承包商'],
  ['Ellaktor Group','EPC','Greece','Costas Nikolopoulos','cnikolopoulos@ellaktor.com','+30 210 860 3000','ellaktor.com',['LED Street Light','LED Tunnel Light'],'Lead',1100000,'chris','希腊最大基建集团之一，EPC照明项目'],

  // ==================== 克罗地亚 Croatia -> chris ====================
  ['Koncar','EPC','Croatia','Ivan Horvat','ihorvat@koncar.hr','+385 1 3656 111','koncar.hr',['LED Street Light','LED Tunnel Light'],'Proposal',580000,'chris','克罗地亚最大电气工程集团'],
  ['Dalekovod','Contractor','Croatia','Marko Pavlovic','mpavlovic@dalekovod.hr','+385 1 3093 000','dalekovod.hr',['LED Street Light'],'Qualified',310000,'chris','萨格勒布电力工程承包商'],
  ['HEP','ESCO','Croatia','Ana Maric','amaric@hep.hr','+385 1 6326 222','hep.hr',['LED Street Light'],'Lead',460000,'chris','克罗地亚国家电力公司'],
  ['Montmontaza','Contractor','Croatia','Davor Stanic','dstanic@montmontaza.hr','+385 1 2385 100','montmontaza.hr',['LED Street Light','LED Tunnel Light'],'Lead',340000,'chris','萨格勒布大型建筑承包商，含照明施工'],
  ['HEP ODS','ESCO','Croatia','Marija Kos','mkos@hep.hr','+385 1 6326 111','hep.hr',['LED Street Light','Solar Street Light'],'Lead',690000,'chris','HEP配电子公司，负责全国路灯运营维护'],
  ['Koncar Lighting','Manufacturer','Croatia','Tomislav Begovic','tbegovic@koncar-lighting.hr','+385 1 3656 200','koncar-lighting.hr',['LED Street Light'],'Lead',280000,'chris','Koncar照明事业部，本土LED路灯生产'],
  ['Strabag Hrvatska','EPC','Croatia','Zoran Basic','zbasic@strabag.hr','+385 1 3489 100','strabag.hr',['LED Street Light','LED Tunnel Light'],'Lead',720000,'chris','STRABAG克罗地亚分部，萨格勒布-斯普利特公路照明'],
  ['Tehnika','Contractor','Croatia','Igor Radic','iradic@tehnika.hr','+385 1 305 4000','tehnika.hr',['LED Street Light'],'Lead',380000,'chris','里耶卡地区电气工程承包商'],
  ['Dalekovod Prodajni','Distributor','Croatia','Petra Novak','pnovak@dalekovod.hr','+385 1 3093 200','dalekovod.hr',['LED Street Light'],'Lead',210000,'chris','Dalekovod旗下电气设备分销部门']
];

const SEED_CUSTOMERS = SEED_RAW.map((c, i) => ({
  id: 'c' + (i + 1),
  companyName: c[0],
  companyType: c[1],
  country: c[2],
  contactPerson: c[3],
  email: c[4],
  phone: c[5],
  website: c[6],
  productInterest: c[7],
  funnelStage: c[8],
  estimatedValue: c[9],
  assignedTo: c[10],
  notes: c[11],
  createdAt: '2026-0' + ((i % 8) + 1) + '-' + String(10 + (i % 18)).padStart(2, '0') + 'T10:00:00Z',
  updatedAt: '2026-08-' + String(1 + (i % 30)).padStart(2, '0') + 'T14:00:00Z'
}));

// ===================== Init DB =====================
let db = loadData();
if (!db) {
  const seedFollowups = [];
  SEED_CUSTOMERS.forEach(c => {
    const items = generateSeedFollowups(c);
    seedFollowups.push(...items);
  });
  db = { users: SEED_USERS, customers: SEED_CUSTOMERS, followups: seedFollowups, activity: [] };
  saveData(db);
} else {
  // 兼容性升级：老数据库没有 followups 时自动生成
  let dirty = false;
  if (!db.followups) {
    const seedFollowups = [];
    db.customers.forEach(c => {
      const items = generateSeedFollowups(c);
      seedFollowups.push(...items);
    });
    db.followups = seedFollowups;
    dirty = true;
  }
  if (!db.activity) {
    db.activity = [];
    dirty = true;
  }
  if (dirty) saveData(db);
}

// ===================== Express =====================
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ===================== Auth Routes =====================

// Login with password
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.users.find(u => u.username === username);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (!verifyPassword(password, user.password)) return res.status(401).json({ error: '密码错误' });
  const token = createSession(user);
  res.json({ ...sanitizeUser(user), token });
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (token) destroySession(token);
  res.json({ success: true });
});

// Change password
app.post('/api/auth/change-password', authMiddleware, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!verifyPassword(currentPassword, req.user.password)) {
    return res.status(401).json({ error: '当前密码错误' });
  }
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: '新密码至少6位' });
  }
  const user = db.users.find(u => u.id === req.user.id);
  user.password = hashPassword(newPassword);
  saveData(db);
  res.json({ success: true, message: '密码修改成功' });
});

// Get current user info
app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json(sanitizeUser(req.user));
});

// ===================== User Routes =====================
app.get('/api/users', authMiddleware, (req, res) => {
  res.json(db.users.map(sanitizeUser));
});

// ===================== Customer Routes =====================
app.get('/api/customers', authMiddleware, (req, res) => {
  let customers = db.customers;
  const { country, type, stage, search } = req.query;
  if (country && country !== 'all') customers = customers.filter(c => c.country === country);
  if (type && type !== 'all') customers = customers.filter(c => c.companyType === type);
  if (stage && stage !== 'all') customers = customers.filter(c => c.funnelStage === stage);
  if (search) {
    const s = search.toLowerCase();
    customers = customers.filter(c =>
      c.companyName.toLowerCase().includes(s) ||
      (c.contactPerson || '').toLowerCase().includes(s) ||
      (c.email || '').toLowerCase().includes(s) ||
      (c.notes || '').toLowerCase().includes(s)
    );
  }
  res.json(customers);
});

app.post('/api/customers', authMiddleware, (req, res) => {
  const country = req.body.country || '';
  if (!canEditCountry(req.user, country)) {
    return res.status(403).json({ error: '无权操作该国家数据' });
  }
  const customer = {
    id: crypto.randomUUID(),
    companyName: req.body.companyName || '',
    companyType: req.body.companyType || 'EPC',
    country: country,
    contactPerson: req.body.contactPerson || '',
    email: req.body.email || '',
    phone: req.body.phone || '',
    website: req.body.website || '',
    productInterest: req.body.productInterest || [],
    funnelStage: req.body.funnelStage || 'Lead',
    estimatedValue: Number(req.body.estimatedValue) || 0,
    assignedTo: req.body.assignedTo || req.user.username,
    notes: req.body.notes || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  db.customers.push(customer);
  saveData(db);
  logActivity('created', customer, req.user);
  io.emit('customer:created', customer);
  res.status(201).json(customer);
});

app.put('/api/customers/:id', authMiddleware, (req, res) => {
  const idx = db.customers.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '客户不存在' });
  const oldCountry = db.customers[idx].country;
  const newCountry = req.body.country || oldCountry;
  if (!canEditCountry(req.user, oldCountry) || (!canEditCountry(req.user, newCountry))) {
    return res.status(403).json({ error: '无权操作该国家数据' });
  }
  const oldStage = db.customers[idx].funnelStage;
  db.customers[idx] = {
    ...db.customers[idx],
    ...req.body,
    id: req.params.id,
    updatedAt: new Date().toISOString()
  };
  saveData(db);
  logActivity(oldStage !== db.customers[idx].funnelStage ? 'stage_changed' : 'updated', db.customers[idx], req.user);
  io.emit('customer:updated', db.customers[idx]);
  res.json(db.customers[idx]);
});

app.delete('/api/customers/:id', authMiddleware, (req, res) => {
  const idx = db.customers.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '客户不存在' });
  const customer = db.customers[idx];
  if (!canEditCountry(req.user, customer.country)) {
    return res.status(403).json({ error: '无权操作该国家数据' });
  }
  db.customers.splice(idx, 1);
  saveData(db);
  logActivity('deleted', customer, req.user);
  io.emit('customer:deleted', customer.id);
  res.json({ success: true });
});

// ===================== Stats =====================
app.get('/api/stats', authMiddleware, (req, res) => {
  const customers = db.customers;
  const won = customers.filter(c => c.funnelStage === 'Won');
  const lost = customers.filter(c => c.funnelStage === 'Lost');
  const pipeline = customers.filter(c => c.funnelStage !== 'Won' && c.funnelStage !== 'Lost');
  const totalPipeline = pipeline.reduce((s, c) => s + (c.estimatedValue || 0), 0);
  const wonValue = won.reduce((s, c) => s + (c.estimatedValue || 0), 0);
  const totalDeals = won.length + lost.length;
  const winRate = totalDeals > 0 ? Math.round((won.length / totalDeals) * 100) : 0;

  const byCountry = {};
  const byStage = {};
  const byType = {};

  CONFIG_COUNTRIES.forEach(c => { byCountry[c] = 0; });
  customers.forEach(c => {
    byCountry[c.country] = (byCountry[c.country] || 0) + 1;
    byStage[c.funnelStage] = (byStage[c.funnelStage] || 0) + 1;
    byType[c.companyType] = (byType[c.companyType] || 0) + 1;
  });

  res.json({
    totalCustomers: customers.length,
    activeCustomers: pipeline.length,
    wonCount: won.length,
    totalPipelineValue: totalPipeline,
    wonValue,
    winRate,
    byCountry,
    byStage,
    byType
  });
});

// ===================== Funnel =====================
app.get('/api/funnel', authMiddleware, (req, res) => {
  const { country } = req.query;
  let customers = db.customers;
  if (country && country !== 'all') customers = customers.filter(c => c.country === country);

  const stages = ['Lead','Qualified','Proposal','Negotiation','Won'];
  const funnel = stages.map(stage => {
    const sc = customers.filter(c => c.funnelStage === stage);
    return { stage, count: sc.length, value: sc.reduce((s, c) => s + (c.estimatedValue || 0), 0) };
  });
  const lostCustomers = customers.filter(c => c.funnelStage === 'Lost');
  if (lostCustomers.length > 0) {
    funnel.push({ stage: 'Lost', count: lostCustomers.length, value: lostCustomers.reduce((s, c) => s + (c.estimatedValue || 0), 0) });
  }

  const total = customers.length;
  res.json({ funnel, total, totalValue: customers.reduce((s, c) => s + (c.estimatedValue || 0), 0) });
});

// ===================== Activity =====================
app.get('/api/activity', authMiddleware, (req, res) => {
  res.json(db.activity.slice(0, 30));
});

// ===================== Followups =====================
// 获取某客户的跟进记录（按时间倒序）
app.get('/api/customers/:id/followups', authMiddleware, (req, res) => {
  const customer = db.customers.find(c => c.id === req.params.id);
  if (!customer) return res.status(404).json({ error: '客户不存在' });
  const list = (db.followups || []).filter(f => f.customerId === req.params.id);
  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(list);
});

// 批量获取所有客户的跟进次数（用于列表展示）
app.get('/api/followups/counts', authMiddleware, (req, res) => {
  const counts = {};
  (db.followups || []).forEach(f => {
    counts[f.customerId] = (counts[f.customerId] || 0) + 1;
  });
  res.json(counts);
});

// 新增跟进记录
app.post('/api/customers/:id/followups', authMiddleware, (req, res) => {
  const customer = db.customers.find(c => c.id === req.params.id);
  if (!customer) return res.status(404).json({ error: '客户不存在' });
  if (!canEditCountry(req.user, customer.country)) {
    return res.status(403).json({ error: '无权操作该国家数据' });
  }
  if (!req.body.content || !req.body.content.trim()) {
    return res.status(400).json({ error: '跟进内容不能为空' });
  }
  const followup = {
    id: crypto.randomUUID(),
    customerId: req.params.id,
    type: req.body.type || '电话沟通',
    content: req.body.content.trim(),
    followAt: req.body.followAt || new Date().toISOString(),
    nextFollowAt: req.body.nextFollowAt || null,
    createdBy: req.user.username,
    createdByName: req.user.displayName,
    createdAt: new Date().toISOString()
  };
  if (!db.followups) db.followups = [];
  db.followups.unshift(followup);
  // 同步更新客户的updatedAt，让漏斗列表也能感知到有新动向
  customer.updatedAt = followup.createdAt;
  saveData(db);
  io.emit('followup:created', { followup, customerId: customer.id });
  logActivity('followup_added', customer, req.user);
  res.status(201).json(followup);
});

// 删除跟进记录
app.delete('/api/followups/:id', authMiddleware, (req, res) => {
  const idx = (db.followups || []).findIndex(f => f.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '跟进记录不存在' });
  const followup = db.followups[idx];
  const customer = db.customers.find(c => c.id === followup.customerId);
  if (customer && !canEditCountry(req.user, customer.country)) {
    return res.status(403).json({ error: '无权操作该国家数据' });
  }
  db.followups.splice(idx, 1);
  saveData(db);
  io.emit('followup:deleted', { id: followup.id, customerId: followup.customerId });
  res.json({ success: true });
});

// ===================== Fallback =====================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===================== Socket.io =====================
const onlineUsers = new Map();

io.on('connection', (socket) => {
  socket.on('user:login', (user) => {
    onlineUsers.set(socket.id, user);
    io.emit('users:online', Array.from(onlineUsers.values()));
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(socket.id);
    io.emit('users:online', Array.from(onlineUsers.values()));
  });
});

// ===================== Start =====================
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  LED 客户管理系统已启动`);
  console.log(`  ========================`);
  console.log(`  本地访问: http://localhost:${PORT}`);
  console.log(`  网络访问: http://0.0.0.0:${PORT}`);
  console.log(`  用户数: ${db.users.length}`);
  console.log(`  客户数: ${db.customers.length}`);
  console.log();
});
