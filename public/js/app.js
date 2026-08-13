// ===================== State =====================
const state = {
  currentUser: null,
  token: null,
  view: 'dashboard',
  customers: [],
  users: [],
  stats: {},
  activity: [],
  onlineUsers: [],
  filters: { country: 'all', type: 'all', stage: 'all', search: '' },
  funnelCountry: 'all',
  charts: {},
  socket: null,
  followupCounts: {},
  followupCustomerCache: null
};

// ===================== 中文标签映射 =====================
const COUNTRIES = ['Spain','Germany','France','Poland','Italy','Russia','Greece','Croatia'];
const COUNTRY_CN = {
  Spain: '西班牙', Germany: '德国', France: '法国', Poland: '波兰',
  Italy: '意大利', Russia: '俄罗斯', Greece: '希腊', Croatia: '克罗地亚'
};
const COUNTRY_FLAGS = {
  Spain: '\u{1F1EA}\u{1F1F8}', Germany: '\u{1F1E9}\u{1F1EA}', France: '\u{1F1EB}\u{1F1F7}',
  Poland: '\u{1F1F5}\u{1F1F1}', Italy: '\u{1F1EE}\u{1F1F9}', Russia: '\u{1F1F7}\u{1F1FA}',
  Greece: '\u{1F1EC}\u{1F1F7}', Croatia: '\u{1F1ED}\u{1F1F7}'
};
const STAGES = ['Lead','Qualified','Proposal','Negotiation','Won'];
const STAGE_CN = {
  Lead: '线索', Qualified: '已验证', Proposal: '提案', Negotiation: '谈判', Won: '成交', Lost: '流失'
};
const COMPANY_TYPES = ['EPC','ESCO','Contractor','Investor','Brand','Manufacturer','Distributor'];
const TYPE_CN = {
  EPC: 'EPC总承包', ESCO: 'ESCO能源服务', Contractor: '承包商', Investor: '投资方',
  Brand: '品牌商', Manufacturer: '制造商', Distributor: '渠道商'
};
const PRODUCTS = ['LED Street Light','LED Tunnel Light','Solar Street Light','LED Module','LED Flood Light','LED Garden Light','LED Grow Light','LED Driver'];
const PRODUCT_CN = {
  'LED Street Light': 'LED路灯', 'LED Tunnel Light': 'LED隧道灯', 'Solar Street Light': '太阳能路灯',
  'LED Module': 'LED模组', 'LED Flood Light': 'LED投光灯', 'LED Garden Light': 'LED庭院灯',
  'LED Grow Light': 'LED植物灯', 'LED Driver': 'LED电源'
};
const STAGE_COLORS = { Lead:'#6366f1', Qualified:'#f59e0b', Proposal:'#f97316', Negotiation:'#ec4899', Won:'#16a34a', Lost:'#dc2626' };

// ===================== API =====================
function authHeaders() {
  return { 'Content-Type': 'application/json', 'X-Auth-Token': state.token || '' };
}

const api = {
  async get(url) {
    const res = await fetch(url, { headers: authHeaders() });
    if (res.status === 401) { forceLogout(); throw new Error('会话已过期'); }
    if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(e.error || '接口错误'); }
    return res.json();
  },
  async post(url, body) {
    const res = await fetch(url, { method:'POST', headers: authHeaders(), body: JSON.stringify(body||{}) });
    if (res.status === 401) { forceLogout(); throw new Error('会话已过期'); }
    if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(e.error || '接口错误'); }
    return res.json();
  },
  async put(url, body) {
    const res = await fetch(url, { method:'PUT', headers: authHeaders(), body: JSON.stringify(body) });
    if (res.status === 401) { forceLogout(); throw new Error('会话已过期'); }
    if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(e.error || '接口错误'); }
    return res.json();
  },
  async delete(url) {
    const res = await fetch(url, { method:'DELETE', headers: authHeaders() });
    if (res.status === 401) { forceLogout(); throw new Error('会话已过期'); }
    if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(e.error || '接口错误'); }
    return res.json();
  }
};

// ===================== 权限辅助 =====================
function canEditCountry(country) {
  if (!state.currentUser) return false;
  if (state.currentUser.role === 'super_admin') return true;
  return state.currentUser.assignedCountries.includes(country);
}

function canEditAny() {
  if (!state.currentUser) return false;
  return state.currentUser.role === 'super_admin' || state.currentUser.assignedCountries.length > 0;
}

// ===================== 初始化 =====================
async function init() {
  const savedToken = localStorage.getItem('ledcrm_token');
  const savedUser = localStorage.getItem('ledcrm_user');
  if (savedToken && savedUser) {
    try {
      state.token = savedToken;
      state.currentUser = JSON.parse(savedUser);
      const me = await api.get('/api/auth/me');
      state.currentUser = me;
      localStorage.setItem('ledcrm_user', JSON.stringify(me));
      showApp();
    } catch {
      localStorage.removeItem('ledcrm_token');
      localStorage.removeItem('ledcrm_user');
    }
  }
}

function showApp() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  renderUserBadge();
  connectSocket();
  loadAllData().then(() => navigate('dashboard'));
}

function forceLogout() {
  localStorage.removeItem('ledcrm_token');
  localStorage.removeItem('ledcrm_user');
  if (state.socket) { state.socket.disconnect(); state.socket = null; }
  state.currentUser = null;
  state.token = null;
  document.getElementById('app').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
  showToast('会话已过期，请重新登录', 'warning');
}

// ===================== 登录 =====================
function toggleLoginPw() {
  const inp = document.getElementById('login-password');
  inp.type = inp.type === 'password' ? 'text' : 'password';
}

async function login(event) {
  event.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.classList.add('hidden');

  if (!username || !password) {
    errEl.textContent = '请输入用户名和密码';
    errEl.classList.remove('hidden');
    return false;
  }

  try {
    const result = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await result.json();
    if (!result.ok) {
      errEl.textContent = data.error || '登录失败';
      errEl.classList.remove('hidden');
      return false;
    }
    state.currentUser = data;
    state.token = data.token;
    localStorage.setItem('ledcrm_token', state.token);
    localStorage.setItem('ledcrm_user', JSON.stringify(state.currentUser));
    document.getElementById('login-username').value = '';
    document.getElementById('login-password').value = '';
    showApp();
  } catch (e) {
    errEl.textContent = '网络错误，请重试';
    errEl.classList.remove('hidden');
  }
  return false;
}

function logout() {
  if (state.token) api.post('/api/auth/logout').catch(()=>{});
  localStorage.removeItem('ledcrm_token');
  localStorage.removeItem('ledcrm_user');
  if (state.socket) { state.socket.disconnect(); state.socket = null; }
  state.currentUser = null;
  state.token = null;
  state.onlineUsers = [];
  document.getElementById('app').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
}

// ===================== 修改密码 =====================
function openPwModal() {
  document.getElementById('pw-modal').classList.remove('hidden');
  document.querySelector('#pw-form input[name="currentPassword"]').focus();
}

function closePwModal() {
  document.getElementById('pw-modal').classList.add('hidden');
  document.getElementById('pw-form').reset();
  document.getElementById('pw-error').classList.add('hidden');
}

async function submitChangePw(event) {
  event.preventDefault();
  const form = event.target;
  const fd = new FormData(form);
  const currentPassword = fd.get('currentPassword');
  const newPassword = fd.get('newPassword');
  const confirmPassword = fd.get('confirmPassword');
  const errEl = document.getElementById('pw-error');
  errEl.classList.add('hidden');

  if (newPassword !== confirmPassword) {
    errEl.textContent = '两次输入的新密码不一致';
    errEl.classList.remove('hidden');
    return false;
  }
  if (newPassword.length < 6) {
    errEl.textContent = '新密码至少6位';
    errEl.classList.remove('hidden');
    return false;
  }

  try {
    await api.post('/api/auth/change-password', { currentPassword, newPassword });
    closePwModal();
    showToast('密码修改成功', 'success');
  } catch (e) {
    errEl.textContent = e.message || '修改失败';
    errEl.classList.remove('hidden');
  }
  return false;
}

// ===================== Socket =====================
function connectSocket() {
  if (state.socket) state.socket.disconnect();
  state.socket = io();
  state.socket.on('connect', () => {
    state.socket.emit('user:login', state.currentUser);
  });
  state.socket.on('users:online', (users) => {
    state.onlineUsers = users;
    renderOnlineIndicator();
    if (state.view === 'team') loadTeam();
  });
  state.socket.on('customer:created', (customer) => {
    state.customers.push(customer);
    showToast(`新客户 ${customer.companyName} 已添加`, 'info');
    if (state.view === 'customers') renderCustomerTable();
    if (state.view === 'dashboard') loadDashboard();
    if (state.view === 'funnel') renderFunnelView();
  });
  state.socket.on('customer:updated', (customer) => {
    const idx = state.customers.findIndex(c => c.id === customer.id);
    if (idx !== -1) state.customers[idx] = customer;
    if (state.view === 'customers') renderCustomerTable();
    if (state.view === 'dashboard') loadDashboard();
    if (state.view === 'funnel') renderFunnelView();
  });
  state.socket.on('customer:deleted', (id) => {
    state.customers = state.customers.filter(c => c.id !== id);
    if (state.view === 'customers') renderCustomerTable();
    if (state.view === 'dashboard') loadDashboard();
    if (state.view === 'funnel') renderFunnelView();
  });
  state.socket.on('activity:new', (entry) => {
    state.activity.unshift(entry);
    if (state.activity.length > 30) state.activity.pop();
    if (state.view === 'dashboard') renderActivityList();
  });
  state.socket.on('followup:created', ({ followup, customerId }) => {
    state.followupCounts[customerId] = (state.followupCounts[customerId] || 0) + 1;
    if (state.view === 'customers') {
      // 增量更新表格中的跟进徽章
      const badge = document.getElementById('followup-badge-' + customerId);
      if (badge) {
        badge.textContent = (state.followupCounts[customerId]) + ' 条';
        badge.classList.add('followup-badge-pulse');
        setTimeout(() => badge.classList.remove('followup-badge-pulse'), 1500);
      }
    }
    // 跟进弹窗打开时实时刷新
    if (state.followupCustomerCache && state.followupCustomerCache.id === customerId) {
      const list = document.getElementById('followup-list');
      if (list) {
        const newHtml = renderFollowupItem(followup, true);
        list.insertAdjacentHTML('afterbegin', newHtml);
        document.getElementById('followup-empty')?.remove();
      }
    }
    showToast(`已添加跟进记录 (${followup.type})`, 'success');
  });
  state.socket.on('followup:deleted', ({ id, customerId }) => {
    state.followupCounts[customerId] = Math.max(0, (state.followupCounts[customerId] || 1) - 1);
    if (state.view === 'customers') {
      const badge = document.getElementById('followup-badge-' + customerId);
      if (badge) {
        badge.textContent = (state.followupCounts[customerId] || 0) + ' 条';
      }
    }
    // 跟进弹窗中删除单条
    const item = document.querySelector(`[data-followup-id="${id}"]`);
    if (item) item.remove();
  });
}

// ===================== 数据加载 =====================
async function loadAllData() {
  try {
    const [customers, stats, activity, users, counts] = await Promise.all([
      api.get('/api/customers'),
      api.get('/api/stats'),
      api.get('/api/activity'),
      api.get('/api/users'),
      api.get('/api/followups/counts')
    ]);
    state.customers = customers;
    state.stats = stats;
    state.activity = activity;
    state.users = users;
    state.followupCounts = counts || {};
  } catch (e) {
    showToast('数据加载失败：' + e.message, 'error');
  }
}

// ===================== 导航 =====================
function navigate(view) {
  state.view = view;
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const navEl = document.querySelector(`.nav-item[data-view="${view}"]`);
  if (navEl) navEl.classList.add('active');

  const titles = { dashboard: '仪表盘', customers: '客户管理', funnel: '销售漏斗', team: '团队' };
  document.getElementById('page-title').textContent = titles[view] || view;

  const content = document.getElementById('content');
  content.innerHTML = '<div class="loading"><div class="spinner"></div><p>加载中...</p></div>';

  switch (view) {
    case 'dashboard': loadDashboard(); break;
    case 'customers': loadCustomers(); break;
    case 'funnel': loadFunnel(); break;
    case 'team': loadTeam(); break;
  }

  if (window.innerWidth <= 768) document.getElementById('sidebar').classList.remove('open');
}

// ===================== 仪表盘 =====================
async function loadDashboard() {
  try {
    state.stats = await api.get('/api/stats');
    const s = state.stats;
    const content = document.getElementById('content');
    content.innerHTML = `
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-icon blue">📊</div><div class="stat-info"><div class="stat-value">${s.totalCustomers}</div><div class="stat-label">总客户</div></div></div>
        <div class="stat-card"><div class="stat-icon green">✅</div><div class="stat-info"><div class="stat-value">${s.wonCount}</div><div class="stat-label">已成交</div></div></div>
        <div class="stat-card"><div class="stat-icon purple">💰</div><div class="stat-info"><div class="stat-value">€${(s.totalPipelineValue/1000000).toFixed(1)}M</div><div class="stat-label">管道价值</div></div></div>
        <div class="stat-card"><div class="stat-icon orange">🎯</div><div class="stat-info"><div class="stat-value">${s.winRate}%</div><div class="stat-label">赢单率</div></div></div>
      </div>
      <div class="dashboard-grid">
        <div class="panel"><div class="panel-header"><h3>各国家客户分布</h3></div><div class="chart-container"><canvas id="chart-country"></canvas></div></div>
        <div class="panel"><div class="panel-header"><h3>销售漏斗分布</h3></div><div class="chart-container"><canvas id="chart-stage"></canvas></div></div>
      </div>
      <div class="dashboard-grid">
        <div class="panel"><div class="panel-header"><h3>公司类型分布</h3></div><div class="chart-container"><canvas id="chart-type"></canvas></div></div>
        <div class="panel"><div class="panel-header"><h3>最近活动</h3></div><div class="activity-list" id="activity-list"></div></div>
      </div>`;

    renderActivityList();
    renderCharts();
  } catch (e) {
    showToast('仪表盘加载失败：' + e.message, 'error');
  }
}

function renderActivityList() {
  const list = document.getElementById('activity-list');
  if (!list) return;
  if (state.activity.length === 0) {
    list.innerHTML = '<div style="text-align:center;color:var(--gray-400);padding:20px;">暂无活动记录</div>';
    return;
  }
  list.innerHTML = state.activity.map(a => {
    const actionMap = { created:'新建', updated:'更新', 'stage_changed':'阶段变更', deleted:'删除' };
    const cn = COUNTRY_CN[a.country] || a.country;
    return `<div class="activity-item">
      <span class="activity-badge ${a.action}">${actionMap[a.action]||a.action}</span>
      <span class="activity-text">${a.user} → ${a.companyName} (${cn})</span>
      <span class="activity-time">${formatTime(a.timestamp)}</span>
    </div>`;
  }).join('');
}

function renderCharts() {
  const countryData = COUNTRIES.map(c => state.stats.byCountry?.[c] || 0);
  renderBarChart('chart-country', COUNTRIES.map(c => COUNTRY_FLAGS[c] + ' ' + COUNTRY_CN[c]), countryData, '#2563eb');

  const stageKeys = [...STAGES, 'Lost'];
  const stageData = stageKeys.map(s => state.stats.byStage?.[s] || 0);
  renderBarChart('chart-stage', stageKeys.map(s => STAGE_CN[s] || s), stageData, stageKeys.map(s => STAGE_COLORS[s]));

  const typeLabels = COMPANY_TYPES.map(t => TYPE_CN[t] || t);
  const typeData = COMPANY_TYPES.map(t => state.stats.byType?.[t] || 0);
  renderDoughnutChart('chart-type', typeLabels, typeData);
}

function renderBarChart(id, labels, data, colors) {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  if (state.charts[id]) state.charts[id].destroy();
  const colorArr = Array.isArray(colors) ? colors : Array(labels.length).fill(colors);
  state.charts[id] = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: colorArr, borderRadius: 6, maxBarThickness: 50 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }
  });
}

function renderDoughnutChart(id, labels, data) {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  if (state.charts[id]) state.charts[id].destroy();
  const colors = ['#3b82f6','#10b981','#f59e0b','#ec4899','#8b5cf6','#f97316','#06b6d4','#ef4444'];
  state.charts[id] = new Chart(canvas, {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 2, borderColor:'#fff' }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { font: { size: 11 } } } } }
  });
}

// ===================== 客户管理 =====================
async function loadCustomers() {
  await renderCustomerTable();
}

async function renderCustomerTable() {
  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="toolbar">
      <div class="search-box">
        <input type="text" id="search-input" placeholder="搜索公司名/联系人/邮箱..." value="${state.filters.search}" oninput="onSearchInput(this.value)">
      </div>
      <select class="filter-select" onchange="setFilter('country', this.value)">
        <option value="all">全部国家</option>
        ${COUNTRIES.map(c => `<option value="${c}" ${state.filters.country===c?'selected':''}>${COUNTRY_FLAGS[c]} ${COUNTRY_CN[c]}</option>`).join('')}
      </select>
      <select class="filter-select" onchange="setFilter('type', this.value)">
        <option value="all">全部类型</option>
        ${COMPANY_TYPES.map(t => `<option value="${t}" ${state.filters.type===t?'selected':''}>${TYPE_CN[t]||t}</option>`).join('')}
      </select>
      <select class="filter-select" onchange="setFilter('stage', this.value)">
        <option value="all">全部阶段</option>
        ${[...STAGES,'Lost'].map(s => `<option value="${s}" ${state.filters.stage===s?'selected':''}>${STAGE_CN[s]||s}</option>`).join('')}
      </select>
      ${canEditAny() ? `<button class="btn btn-primary" onclick="openCustomerModal()">+ 新增客户</button>` : ''}
    </div>
    <div class="customer-table-wrap" id="customer-table-wrap"></div>`;

  const params = new URLSearchParams();
  if (state.filters.country !== 'all') params.set('country', state.filters.country);
  if (state.filters.type !== 'all') params.set('type', state.filters.type);
  if (state.filters.stage !== 'all') params.set('stage', state.filters.stage);
  if (state.filters.search) params.set('search', state.filters.search);

  try {
    const customers = await api.get('/api/customers?' + params.toString());
    state.customers = customers;
    const wrap = document.getElementById('customer-table-wrap');

    if (customers.length === 0) {
      wrap.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><p>未找到匹配的客户</p></div>';
      return;
    }

    wrap.innerHTML = `<table class="customer-table">
      <thead><tr>
        <th>公司名称</th><th class="hide-mobile">类型</th><th>国家</th>
        <th class="hide-mobile">联系人</th><th>产品</th><th>漏斗阶段</th>
        <th>估计价值</th><th class="hide-mobile">跟进</th><th>操作</th>
      </tr></thead>
      <tbody>
        ${customers.map(c => {
          const canEdit = canEditCountry(c.country);
          const cn = COUNTRY_CN[c.country] || c.country;
          const flag = COUNTRY_FLAGS[c.country] || '';
          const typeLabel = TYPE_CN[c.companyType] || c.companyType;
          const stageLabel = STAGE_CN[c.funnelStage] || c.funnelStage;
          const products = (c.productInterest||[]).map(p => PRODUCT_CN[p]||p).join('、');
          const fuCount = state.followupCounts[c.id] || 0;
          return `<tr>
            <td class="customer-name">${c.companyName}${c.notes ? `<div style="font-size:11px;color:var(--gray-400);font-weight:400;margin-top:2px;">${c.notes.substring(0,60)}${c.notes.length>60?'...':''}</div>` : ''}</td>
            <td class="hide-mobile"><span class="type-badge ${c.companyType}">${typeLabel}</span></td>
            <td>${flag} ${cn}</td>
            <td class="hide-mobile">${c.contactPerson||'-'}<br><span style="font-size:11px;color:var(--gray-400)">${c.email||''}</span></td>
            <td style="font-size:12px">${products}</td>
            <td><span class="stage-badge ${c.funnelStage}" ${canEdit?`onclick="cycleStage('${c.id}','${c.funnelStage}')"`:''}>${stageLabel}</span></td>
            <td>€${(c.estimatedValue/1000).toFixed(0)}K</td>
            <td class="hide-mobile"><button class="followup-badge" id="followup-badge-${c.id}" onclick="openFollowups('${c.id}')" title="查看跟进记录"><span class="followup-badge-icon">📋</span><span class="followup-badge-count">${fuCount} 条</span></button></td>
            <td><div class="row-actions">
              ${canEdit ? `<button class="btn btn-ghost btn-sm" onclick="openCustomerModal('${c.id}')">✏️</button><button class="btn btn-ghost btn-sm" onclick="confirmDelete('${c.id}','${c.companyName}')">🗑️</button>` : '<span style="font-size:11px;color:var(--gray-400)">只读</span>'}
            </div></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
  } catch (e) {
    showToast('客户列表加载失败：' + e.message, 'error');
  }
}

function setFilter(key, value) {
  state.filters[key] = value;
  renderCustomerTable();
}

let searchTimer;
function onSearchInput(value) {
  state.filters.search = value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => renderCustomerTable(), 350);
}

function cycleStage(id, currentStage) {
  const stages = [...STAGES, 'Lost'];
  const idx = stages.indexOf(currentStage);
  const next = stages[(idx + 1) % stages.length];
  updateCustomer(id, { funnelStage: next });
}

// ===================== 客户表单弹窗 =====================
function openCustomerModal(id) {
  const modal = document.getElementById('customer-modal');
  const body = document.getElementById('modal-body');
  const title = document.getElementById('modal-title');
  const isEdit = !!id;

  title.textContent = isEdit ? '编辑客户' : '新增客户';
  const c = isEdit ? state.customers.find(x => x.id === id) : {};

  body.innerHTML = `
    <form id="customer-form" onsubmit="saveCustomer(event, ${isEdit?`'${id}'`:'null'})">
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">公司名称 <span class="req">*</span></label>
          <input class="form-input" name="companyName" value="${c.companyName||''}" required>
        </div>
        <div class="form-group">
          <label class="form-label">类型 <span class="req">*</span></label>
          <select class="form-select" name="companyType" required>
            ${COMPANY_TYPES.map(t => `<option value="${t}" ${c.companyType===t?'selected':''}>${TYPE_CN[t]||t}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">国家 <span class="req">*</span></label>
          <select class="form-select" name="country" required>
            ${COUNTRIES.map(co => {
              const canAccess = canEditCountry(co);
              return `<option value="${co}" ${c.country===co?'selected':''} ${!canAccess?'disabled':''}>${COUNTRY_FLAGS[co]||''} ${COUNTRY_CN[co]}${!canAccess?'（无权限）':''}</option>`;
            }).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">联系人</label>
          <input class="form-input" name="contactPerson" value="${c.contactPerson||''}">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">邮箱</label>
          <input class="form-input" name="email" type="email" value="${c.email||''}">
        </div>
        <div class="form-group">
          <label class="form-label">电话</label>
          <input class="form-input" name="phone" value="${c.phone||''}">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">网站</label>
          <input class="form-input" name="website" value="${c.website||''}">
        </div>
        <div class="form-group">
          <label class="form-label">估计价值（€）</label>
          <input class="form-input" name="estimatedValue" type="number" value="${c.estimatedValue||''}" step="1000">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">漏斗阶段</label>
          <select class="form-select" name="funnelStage">
            ${[...STAGES,'Lost'].map(s => `<option value="${s}" ${c.funnelStage===s?'selected':''}>${STAGE_CN[s]||s}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">负责人</label>
          <select class="form-select" name="assignedTo">
            ${state.users.map(u => `<option value="${u.username}" ${c.assignedTo===u.username?'selected':''}>${u.displayName}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">产品兴趣</label>
        <div class="form-checkbox-group" id="product-group">
          ${PRODUCTS.map(p => {
            const checked = (c.productInterest||[]).includes(p) ? 'checked' : '';
            const pLabel = PRODUCT_CN[p] || p;
            return `<label class="form-checkbox ${checked?'checked':''}">
              <input type="checkbox" name="product" value="${p}" ${checked} onchange="this.parentElement.classList.toggle('checked', this.checked)"> ${pLabel}
            </label>`;
          }).join('')}
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">备注</label>
        <textarea class="form-textarea" name="notes" rows="3">${c.notes||''}</textarea>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-ghost" onclick="closeCustomerModal()">取消</button>
        <button type="submit" class="btn btn-primary">${isEdit?'保存':'创建'}</button>
      </div>
    </form>`;

  modal.classList.remove('hidden');
}

function closeCustomerModal() {
  document.getElementById('customer-modal').classList.add('hidden');
}

async function saveCustomer(event, id) {
  event.preventDefault();
  const form = event.target;
  const fd = new FormData(form);
  const products = fd.getAll('product');
  const data = {
    companyName: fd.get('companyName'),
    companyType: fd.get('companyType'),
    country: fd.get('country'),
    contactPerson: fd.get('contactPerson'),
    email: fd.get('email'),
    phone: fd.get('phone'),
    website: fd.get('website'),
    estimatedValue: Number(fd.get('estimatedValue')) || 0,
    funnelStage: fd.get('funnelStage'),
    assignedTo: fd.get('assignedTo'),
    productInterest: products,
    notes: fd.get('notes')
  };

  try {
    if (id) {
      await api.put('/api/customers/' + id, data);
      showToast('客户已更新', 'success');
    } else {
      await api.post('/api/customers', data);
      showToast('客户已创建', 'success');
    }
    closeCustomerModal();
  } catch (e) {
    showToast('保存失败：' + e.message, 'error');
  }
}

async function updateCustomer(id, patch) {
  try {
    await api.put('/api/customers/' + id, patch);
  } catch (e) {
    showToast('更新失败：' + e.message, 'error');
  }
}

function confirmDelete(id, name) {
  document.getElementById('confirm-title').textContent = '删除客户';
  document.getElementById('confirm-message').textContent = `确认删除「${name}」？此操作不可撤销。`;
  document.getElementById('confirm-modal').classList.remove('hidden');
  document.getElementById('confirm-ok-btn').onclick = () => doDelete(id);
}

function closeConfirm() {
  document.getElementById('confirm-modal').classList.add('hidden');
}

async function doDelete(id) {
  try {
    await api.delete('/api/customers/' + id);
    closeConfirm();
    showToast('客户已删除', 'success');
  } catch (e) {
    showToast('删除失败：' + e.message, 'error');
  }
}

// ===================== 销售漏斗 =====================
async function loadFunnel() {
  await renderFunnelView();
}

async function renderFunnelView() {
  const content = document.getElementById('content');
  const selectedCountry = state.funnelCountry;

  content.innerHTML = `
    <div class="funnel-controls">
      <label style="font-weight:600;color:var(--gray-600)">选择国家：</label>
      <select class="funnel-country-select" onchange="setFunnelCountry(this.value)">
        <option value="all" ${selectedCountry==='all'?'selected':''}>全部国家（大区汇总）</option>
        ${COUNTRIES.map(c => `<option value="${c}" ${selectedCountry===c?'selected':''}>${COUNTRY_FLAGS[c]} ${COUNTRY_CN[c]}</option>`).join('')}
      </select>
    </div>
    <div class="funnel-container" id="main-funnel"></div>
    <div class="funnel-container">
      <div class="panel-header"><h3>各国家漏斗概览</h3></div>
      <div class="country-funnel-grid" id="country-funnel-grid"></div>
    </div>`;

  await renderMainFunnel(selectedCountry);
  renderCountryFunnelGrid();
}

async function renderMainFunnel(country) {
  try {
    const funnelData = await api.get('/api/funnel?country=' + encodeURIComponent(country));
    const container = document.getElementById('main-funnel');
    const stages = funnelData.funnel;
    const total = funnelData.total;
    const totalValue = funnelData.totalValue;

    const stageClass = { Lead:'lead', Qualified:'qualified', Proposal:'proposal', Negotiation:'negotiation', Won:'won', Lost:'lost' };
    const title = country === 'all' ? '大区销售漏斗（8国汇总）' : `${COUNTRY_FLAGS[country]} ${COUNTRY_CN[country]} 销售漏斗`;

    container.innerHTML = `
      <div class="funnel-title">${title}</div>
      <div class="funnel-stages">
        ${stages.map(s => `
          <div class="funnel-stage ${stageClass[s.stage]}">
            <div class="fs-info"><span>${STAGE_CN[s.stage]||s.stage}</span></div>
            <div style="display:flex;align-items:center;gap:12px">
              <span class="fs-count">${s.count}</span>
              <span class="fs-value">€${(s.value/1000).toFixed(0)}K</span>
            </div>
          </div>`).join('')}
      </div>
      <div class="funnel-stats">
        <div class="funnel-stat"><div class="fs-num">${total}</div><div class="fs-lbl">总客户数</div></div>
        <div class="funnel-stat"><div class="fs-num">€${(totalValue/1000000).toFixed(1)}M</div><div class="fs-lbl">总价值</div></div>
        <div class="funnel-stat"><div class="fs-num">${stages.find(s=>s.stage==='Won')?.count||0}</div><div class="fs-lbl">已成交</div></div>
      </div>`;

    const chartId = 'funnel-chart';
    container.innerHTML += `<div class="chart-container" style="margin-top:20px"><canvas id="${chartId}"></canvas></div>`;
    if (state.charts[chartId]) state.charts[chartId].destroy();
    state.charts[chartId] = new Chart(document.getElementById(chartId), {
      type: 'bar',
      data: { labels: stages.map(s => STAGE_CN[s.stage]||s.stage), datasets: [{ label:'客户数', data: stages.map(s=>s.count), backgroundColor: stages.map(s=>STAGE_COLORS[s.stage]), borderRadius:6 }] },
      options: { responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{y:{beginAtZero:true,ticks:{precision:0}}} }
    });
  } catch (e) {
    showToast('漏斗加载失败：' + e.message, 'error');
  }
}

async function renderCountryFunnelGrid() {
  const grid = document.getElementById('country-funnel-grid');
  if (!grid) return;

  const html = await Promise.all(COUNTRIES.map(async country => {
    try {
      const data = await api.get('/api/funnel?country=' + encodeURIComponent(country));
      const stages = data.funnel.filter(s => s.stage !== 'Lost');
      const maxCount = Math.max(...stages.map(s => s.count), 1);
      const cn = COUNTRY_CN[country] || country;
      return `<div class="country-funnel-card">
        <h4><span class="country-flag">${COUNTRY_FLAGS[country]}</span> ${cn}</h4>
        <div class="mini-funnel">
          ${stages.map(s => {
            const width = Math.max((s.count / maxCount) * 100, 15);
            const stageLabel = STAGE_CN[s.stage] || s.stage;
            return `<div class="mini-funnel-stage" style="background:${STAGE_COLORS[s.stage]};width:${width}%">
              <span>${stageLabel}</span><span>${s.count} | €${(s.value/1000).toFixed(0)}K</span>
            </div>`;
          }).join('')}
        </div>
        <div style="margin-top:10px;font-size:12px;color:var(--gray-500);text-align:center">
          总计 ${data.total} 客户 | €${(data.totalValue/1000000).toFixed(1)}M
        </div>
      </div>`;
    } catch { return ''; }
  }));

  grid.innerHTML = html.join('');
}

function setFunnelCountry(country) {
  state.funnelCountry = country;
  renderMainFunnel(country);
}

// ===================== 团队 =====================
async function loadTeam() {
  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="team-grid" id="team-grid">
      ${state.users.map(u => {
        const initials = u.displayName.split(' ').map(n=>n[0]).join('').slice(0,2).toUpperCase();
        const isOnline = state.onlineUsers.some(ou => ou.id === u.id || ou.username === u.username);
        const userCustomers = state.customers.filter(c => c.assignedTo === u.username);
        const wonCount = userCustomers.filter(c => c.funnelStage === 'Won').length;
        const pipelineValue = userCustomers.filter(c => !['Won','Lost'].includes(c.funnelStage)).reduce((s,c)=>s+(c.estimatedValue||0),0);
        const roleLabel = u.role === 'super_admin' ? '超级管理员' : '国家管理员';
        const countryTags = u.assignedCountries.map(c => {
          const cn = COUNTRY_CN[c] || c;
          return `<span class="team-country-tag">${COUNTRY_FLAGS[c]||''} ${cn}</span>`;
        }).join('');
        return `<div class="team-card" style="border-top-color:${u.color}">
          <div class="team-card-header">
            <div class="team-avatar" style="background:${u.color}">${initials}</div>
            <div class="team-info">
              <div class="team-name">${u.displayName}</div>
              <div class="team-role">${roleLabel}</div>
            </div>
            <span class="team-status ${isOnline?'online':'offline'}">${isOnline?'在线':'离线'}</span>
          </div>
          <div class="team-countries">
            ${countryTags}
            ${u.role === 'super_admin' ? '<span class="team-country-tag" style="background:var(--primary-light);color:var(--primary-dark);font-weight:600">全部国家权限</span>' : ''}
          </div>
          <div class="team-stats">
            <div class="team-stat"><div class="ts-num">${userCustomers.length}</div><div class="ts-lbl">客户数</div></div>
            <div class="team-stat"><div class="ts-num">${wonCount}</div><div class="ts-lbl">已成交</div></div>
            <div class="team-stat"><div class="ts-num">€${(pipelineValue/1000000).toFixed(1)}M</div><div class="ts-lbl">管道价值</div></div>
          </div>
        </div>`;
      }).join('')}
    </div>`;
}

// ===================== 辅助函数 =====================
function renderUserBadge() {
  const badge = document.getElementById('user-badge');
  const u = state.currentUser;
  if (!u) return;
  const initials = u.displayName.split(' ').map(n=>n[0]).join('').slice(0,2).toUpperCase();
  const roleLabel = u.role === 'super_admin' ? '管理员' : '负责人';
  badge.innerHTML = `<div class="ub-avatar" style="background:${u.color}">${initials}</div><span class="ub-name">${u.displayName}</span>`;
}

function renderOnlineIndicator() {
  const el = document.getElementById('online-indicator');
  if (!el) return;
  const count = state.onlineUsers.length;
  el.innerHTML = `<div class="pulse"></div> ${count} 人在线`;
  const mini = document.getElementById('online-users-mini');
  if (mini) mini.innerHTML = state.onlineUsers.map(u => `<div><span class="online-dot"></span>${u.displayName}</div>`).join('');
}

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
}

function formatTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff/60) + '分钟前';
  if (diff < 86400) return Math.floor(diff/3600) + '小时前';
  return d.toLocaleDateString('zh-CN', { month:'short', day:'numeric' });
}

function showToast(msg, type) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast ' + (type||'info');
  const icons = { success:'✅', error:'❌', warning:'⚠️', info:'ℹ️' };
  toast.innerHTML = `<span>${icons[type]||icons.info}</span><span>${msg}</span>`;
  container.appendChild(toast);
  setTimeout(() => { toast.style.transition='all .3s'; toast.style.opacity='0'; toast.style.transform='translateX(120%)'; setTimeout(()=>toast.remove(),300); }, 3500);
}

// ===================== 跟进记录模块 =====================
const FOLLOWUP_TYPES = ['电话沟通', '邮件往来', '视频会议', '现场拜访', '样品寄送', '报价发送', '合同谈判', '其他'];
const FOLLOWUP_ICONS = {
  '电话沟通': '📞', '邮件往来': '✉️', '视频会议': '🎥', '现场拜访': '🤝',
  '样品寄送': '📦', '报价发送': '💼', '合同谈判': '📝', '其他': '🔹'
};

function openFollowups(customerId) {
  const customer = state.customers.find(c => c.id === customerId);
  if (!customer) return;
  state.followupCustomerCache = customer;
  document.getElementById('followup-modal').classList.remove('hidden');
  document.getElementById('followup-modal-title').textContent = `跟进记录 · ${customer.companyName}`;
  renderFollowupModal(customer);
  loadFollowups(customerId);
}

async function renderFollowupModal(customer) {
  const body = document.getElementById('followup-modal-body');
  const canEdit = canEditCountry(customer.country);
  body.innerHTML = `
    ${canEdit ? `
    <div class="followup-form-card">
      <div class="followup-form-title">➕ 新增跟进记录</div>
      <form id="followup-form" onsubmit="return submitFollowup(event, '${customer.id}')">
        <div class="followup-form-grid">
          <div class="form-group">
            <label class="form-label">跟进方式</label>
            <select class="form-input" name="type">
              ${FOLLOWUP_TYPES.map(t => `<option value="${t}">${FOLLOWUP_ICONS[t]} ${t}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">跟进日期</label>
            <input type="datetime-local" class="form-input" name="followAt" value="${toLocalDatetimeInput(new Date())}" required>
          </div>
          <div class="form-group">
            <label class="form-label">下次跟进 <span style="font-weight:400;color:var(--gray-400);font-size:11px">(可选)</span></label>
            <input type="datetime-local" class="form-input" name="nextFollowAt" placeholder="选择日期">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">跟进内容 <span class="req">*</span></label>
          <textarea class="form-input" name="content" rows="3" required placeholder="请输入跟进沟通的关键内容、客户反馈、待办事项..."></textarea>
        </div>
        <div style="display:flex;justify-content:flex-end;gap:8px;">
          <button type="submit" class="btn btn-primary">保存跟进记录</button>
        </div>
      </form>
    </div>` : `
    <div class="followup-readonly-banner">
      🔒 您没有该国家数据的编辑权限，仅可查看跟进记录
    </div>`}
    <div class="followup-timeline-header">
      <span>历史跟进记录</span>
      <span id="followup-total-count" class="followup-total-pill"></span>
    </div>
    <div id="followup-list" class="followup-timeline"></div>
  `;
}

function loadFollowups(customerId) {
  const list = document.getElementById('followup-list');
  if (list) list.innerHTML = '<div class="loading-inline"><div class="spinner"></div></div>';
  fetch('/api/customers/' + customerId + '/followups', { headers: authHeaders() })
    .then(r => r.json())
    .then(items => {
      state.followupCounts[customerId] = items.length;
      const totalEl = document.getElementById('followup-total-count');
      if (totalEl) totalEl.textContent = items.length + ' 条';
      const list = document.getElementById('followup-list');
      if (!list) return;
      if (items.length === 0) {
        list.innerHTML = '<div id="followup-empty" class="empty-state"><div class="empty-icon">📭</div><p>暂无跟进记录，请在上方添加第一条</p></div>';
        return;
      }
      list.innerHTML = items.map(f => renderFollowupItem(f, false)).join('');
    })
    .catch(e => showToast('加载跟进记录失败：' + e.message, 'error'));
}

function renderFollowupItem(f, isNew) {
  const icon = FOLLOWUP_ICONS[f.type] || '🔹';
  const followAt = formatDateTime(f.followAt);
  const nextText = f.nextFollowAt ? `<div class="followup-next">⏰ 下次跟进：${formatDateTime(f.nextFollowAt)}</div>` : '';
  const canEdit = state.followupCustomerCache ? canEditCountry(state.followupCustomerCache.country) : false;
  return `<div class="followup-item${isNew ? ' followup-item-new' : ''}" data-followup-id="${f.id}">
    <div class="followup-dot">${icon}</div>
    <div class="followup-card">
      <div class="followup-card-head">
        <span class="followup-type-tag">${f.type}</span>
        <span class="followup-time">${followAt}</span>
      </div>
      <div class="followup-content">${escapeHtml(f.content)}</div>
      ${nextText}
      <div class="followup-footer">
        <span class="followup-author">👤 ${f.createdByName || f.createdBy}</span>
        ${canEdit ? `<button class="btn btn-ghost btn-sm followup-delete" onclick="deleteFollowup('${f.id}', '${state.followupCustomerCache.id}')">🗑️ 删除</button>` : ''}
      </div>
    </div>
  </div>`;
}

async function submitFollowup(event, customerId) {
  event.preventDefault();
  const form = event.target;
  const fd = new FormData(form);
  const payload = {
    type: fd.get('type'),
    content: fd.get('content'),
    followAt: new Date(fd.get('followAt')).toISOString(),
    nextFollowAt: fd.get('nextFollowAt') ? new Date(fd.get('nextFollowAt')).toISOString() : null
  };
  try {
    await api.post('/api/customers/' + customerId + '/followups', payload);
    form.reset();
    document.querySelector('#followup-form input[name="followAt"]').value = toLocalDatetimeInput(new Date());
    showToast('跟进记录已保存', 'success');
    // Socket会自动广播更新UI，但保险起见重load一次
    loadFollowups(customerId);
  } catch (e) {
    showToast('保存失败：' + e.message, 'error');
  }
  return false;
}

async function deleteFollowup(followupId, customerId) {
  if (!confirm('确认删除此条跟进记录？此操作不可撤销。')) return;
  try {
    await api.delete('/api/followups/' + followupId);
    showToast('跟进记录已删除', 'success');
  } catch (e) {
    showToast('删除失败：' + e.message, 'error');
  }
}

function closeFollowupModal() {
  document.getElementById('followup-modal').classList.add('hidden');
  state.followupCustomerCache = null;
}

function toLocalDatetimeInput(d) {
  const pad = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function formatDateTime(iso) {
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// ===================== 启动 =====================
init();
