/* =========================================================
   FYS SHOP — Telegram Mini App
   Работает без сервера: статический сайт + Telegram CloudStorage.
   Покупка — в демо-режиме (деньги не списываются).
   ========================================================= */
(function () {
  'use strict';

  /* =========================================================
     1. НАСТРОЙКИ — всё, что нужно менять, находится здесь
     ========================================================= */
  var CONFIG = {
    botUsername: 'FYS_shop_bot',  // бот магазина (без @)
    supportUsername: 'TapeAK',    // куда ведёт кнопка «Поддержка» (без @)
    // URL serverless-воркера для уведомлений о заказах (см. README, шаг 3).
    // Пусто — магазин работает полностью без него.
    orderApiUrl: '',
    promoCodes: { FYS10: 10 },    // демо-промокоды: КОД → скидка в %
    demoPaymentDelay: 1400,       // имитация обработки платежа, мс
    maxQty: 10,
  };

  var CATEGORIES = [
    { id: 'all', title: 'Все' },
    { id: 'ai', title: 'AI-подписки' },
    { id: 'trading', title: 'Трейдинг' },
  ];

  // price: число в рублях или null → «Цена уточняется» и кнопка «Узнать цену».
  // test: true — тестовый товар для демонстрации (ассортимент ещё не финальный).
  // glyph: claude | gemini | chart — значок на металлической «монете».
  var PRODUCTS = [
    {
      id: 'claude-pro', cat: 'ai', glyph: 'claude', test: true,
      title: 'Claude Pro', period: '1 месяц', price: 1999, tag: 'Хит',
      short: 'ИИ-ассистент для текстов, кода и анализа документов — расширенный доступ.',
      text: 'Подписка Claude Pro на 1 месяц: больше запросов, доступ к старшим моделям и работа с большими файлами.',
      features: ['Расширенные лимиты сообщений', 'Доступ к старшим моделям', 'Проекты и работа с файлами', 'Активация на ваш аккаунт'],
    },
    {
      id: 'gemini-advanced', cat: 'ai', glyph: 'gemini', test: true,
      title: 'Gemini Advanced', period: '18 месяцев', price: 159, tag: 'Выгодно',
      short: 'Продвинутые модели Google Gemini на долгий срок — сразу на 18 месяцев.',
      text: 'Доступ к Gemini Advanced на 18 месяцев: продвинутые модели, интеграция с сервисами Google и расширенные возможности.',
      features: ['Срок действия — 18 месяцев', 'Продвинутые модели Gemini', 'Интеграция с Gmail и Docs', 'Активация на ваш аккаунт'],
    },
    {
      id: 'trading-indicator', cat: 'trading', glyph: 'chart',
      title: 'Trading Indicator', period: 'Подписка', price: null, tag: 'Новинка',
      short: 'Подписка на торговый индикатор: сигналы входа и выхода для вашей стратегии.',
      text: 'Авторский индикатор для анализа рынка. Цена зависит от срока подписки — оставьте заявку, и менеджер свяжется с вами.',
      features: ['Сигналы на вход и выход', 'Настройка под ваш рынок', 'Обновления включены', 'Помощь с подключением'],
      plans: ['1 месяц', '3 месяца', '12 месяцев'],
    },
  ];

  var PAY_METHODS = [
    { id: 'card', label: 'Карта', full: 'Банковская карта', icon: 'card' },
    { id: 'sbp', label: 'СБП', full: 'СБП', icon: 'phone' },
    { id: 'crypto', label: 'USDT', full: 'Криптовалюта (USDT)', icon: 'coin' },
  ];

  /* =========================================================
     2. TELEGRAM WEBAPP SDK
     ========================================================= */
  var tg = window.Telegram && window.Telegram.WebApp;
  var inTg = !!(tg && tg.initData);           // открыто внутри Telegram
  var tgUser = (inTg && tg.initDataUnsafe && tg.initDataUnsafe.user) || null;
  var BG = '#08090b';

  function can(version) {
    return !!(inTg && typeof tg.isVersionAtLeast === 'function' && tg.isVersionAtLeast(version));
  }
  function tgTry(version, fn) {
    if (!can(version)) return;
    try { fn(); } catch (e) { console.warn('[telegram]', e); }
  }

  if (tg) { try { tg.ready(); tg.expand(); } catch (e) { /* вне Telegram */ } }
  tgTry('6.1', function () { tg.setHeaderColor(BG); tg.setBackgroundColor(BG); });
  tgTry('7.10', function () { tg.setBottomBarColor(BG); });
  tgTry('7.7', function () { tg.disableVerticalSwipes(); });
  tgTry('6.1', function () { tg.BackButton.onClick(onBack); });
  if (inTg) document.documentElement.classList.add('in-telegram');

  function haptic(kind) {
    if (!state.settings.haptics) return;
    tgTry('6.1', function () {
      var h = tg.HapticFeedback;
      if (kind === 'success' || kind === 'error' || kind === 'warning') h.notificationOccurred(kind);
      else if (kind === 'select') h.selectionChanged();
      else h.impactOccurred(kind || 'light');
    });
  }

  function openTgLink(url) {
    haptic('light');
    if (can('6.1')) {
      try { tg.openTelegramLink(url); return; } catch (e) { /* fallback ниже */ }
    }
    window.open(url, '_blank', 'noopener');
  }

  /* =========================================================
     3. ХРАНИЛИЩЕ: Telegram CloudStorage + localStorage
     ========================================================= */
  var KEYS = { cart: 'fys_cart', orders: 'fys_orders', settings: 'fys_settings' };
  var useCloud = can('6.9') && !!tg.CloudStorage;
  var dirty = false; // пользователь что-то изменил до загрузки облака

  var local = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* приватный режим */ } },
  };

  function parse(str, fallback) {
    try { var v = JSON.parse(str); return v == null ? fallback : v; } catch (e) { return fallback; }
  }

  function cloudGetAll(keys) {
    return new Promise(function (resolve) {
      var timer = setTimeout(function () { resolve(null); }, 2000);
      try {
        tg.CloudStorage.getItems(keys, function (err, values) {
          clearTimeout(timer);
          resolve(err ? null : values);
        });
      } catch (e) { clearTimeout(timer); resolve(null); }
    });
  }

  function cloudSet(key, value) {
    if (!useCloud) return;
    try { tg.CloudStorage.setItem(key, value); } catch (e) { /* лимит или старая версия */ }
  }

  // В одной ячейке CloudStorage максимум 4096 символов — храним последние заказы.
  function trimOrders(list) {
    var out = list.slice(0, 15);
    while (out.length > 1 && JSON.stringify(out).length > 4000) out = out.slice(0, -1);
    return out;
  }

  function save(what) {
    dirty = true;
    if (what === 'orders') state.orders = trimOrders(state.orders);
    var value = JSON.stringify(state[what]);
    local.set(KEYS[what], value);
    cloudSet(KEYS[what], value);
  }

  function sanitizeCart(list) {
    if (!Array.isArray(list)) return [];
    return list.filter(function (l) {
      var p = l && byId(l.id);
      return p && p.price != null;
    }).map(function (l) {
      return { id: l.id, qty: Math.min(CONFIG.maxQty, Math.max(1, parseInt(l.qty, 10) || 1)) };
    });
  }

  function loadCloud() {
    if (!useCloud) return;
    cloudGetAll([KEYS.cart, KEYS.orders, KEYS.settings]).then(function (v) {
      if (!v || dirty) return;
      var hasCloud = v[KEYS.cart] || v[KEYS.orders] || v[KEYS.settings];
      if (!hasCloud) { // первый запуск на этом аккаунте — переносим локальные данные в облако
        ['cart', 'orders', 'settings'].forEach(function (k) { cloudSet(KEYS[k], JSON.stringify(state[k])); });
        return;
      }
      if (v[KEYS.cart]) state.cart = sanitizeCart(parse(v[KEYS.cart], state.cart));
      if (v[KEYS.orders]) state.orders = parse(v[KEYS.orders], state.orders);
      if (v[KEYS.settings]) state.settings = Object.assign(state.settings, parse(v[KEYS.settings], {}));
      ['cart', 'orders', 'settings'].forEach(function (k) { local.set(KEYS[k], JSON.stringify(state[k])); });
      renderAll();
    });
  }

  /* =========================================================
     4. СОСТОЯНИЕ И УТИЛИТЫ
     ========================================================= */
  var state = {
    tab: 'home',
    filter: 'all',
    cart: [],
    orders: parse(local.get(KEYS.orders), []),
    settings: Object.assign({ haptics: true }, parse(local.get(KEYS.settings), {})),
    sheet: null,     // какой нижний лист открыт
    checkout: null,  // данные текущего оформления
  };
  state.cart = sanitizeCart(parse(local.get(KEYS.cart), []));

  function $(sel) { return document.querySelector(sel); }
  function byId(id) {
    for (var i = 0; i < PRODUCTS.length; i++) if (PRODUCTS[i].id === id) return PRODUCTS[i];
    return null;
  }
  function catTitle(id) {
    for (var i = 0; i < CATEGORIES.length; i++) if (CATEGORIES[i].id === id) return CATEGORIES[i].title;
    return '';
  }
  var nf = new Intl.NumberFormat('ru-RU');
  function money(n) { return nf.format(Math.round(n)) + ' ₽'; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function plural(n, forms) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return forms[0];
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return forms[1];
    return forms[2];
  }
  function cartCount() { return state.cart.reduce(function (s, l) { return s + l.qty; }, 0); }
  function linesTotal(lines) {
    return lines.reduce(function (s, l) { return s + (byId(l.id).price || 0) * l.qty; }, 0);
  }
  function cartLine(id) {
    for (var i = 0; i < state.cart.length; i++) if (state.cart[i].id === id) return state.cart[i];
    return null;
  }
  function newOrderId() {
    return 'FYS-' + Date.now().toString(36).slice(-4).toUpperCase() + Math.random().toString(36).slice(2, 4).toUpperCase();
  }
  function fmtDate(ts) {
    return new Date(ts).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* =========================================================
     5. ИКОНКИ
     ========================================================= */
  var ICONS = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/>',
    bag: '<path d="M5 8h14l-1.2 11.1a2 2 0 0 1-2 1.9H8.2a2 2 0 0 1-2-1.9z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>',
    bagPlus: '<path d="M5 8h14l-1.2 11.1a2 2 0 0 1-2 1.9H8.2a2 2 0 0 1-2-1.9z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/><path d="M12 11.5v6M9 14.5h6"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 20.5c1.6-3.6 4.6-5.5 8-5.5s6.4 1.9 8 5.5"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    chev: '<path d="M9 6l6 6-6 6"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    shield: '<path d="M12 3l7 3v5.5c0 4.5-3 8-7 9.5-4-1.5-7-5-7-9.5V6z"/><path d="M9 12l2 2 4-4"/>',
    bolt: '<path d="M13 3 5 13.5h6L10 21l9-11h-6z"/>',
    chat: '<path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12z"/><path d="M9 11h6M9 14h4"/>',
    share: '<path d="M12 4v11M7.5 8.5 12 4l4.5 4.5"/><path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/>',
    vibrate: '<rect x="8" y="4" width="8" height="16" rx="2"/><path d="M4 9v6M20 9v6"/>',
    sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
    reset: '<path d="M4 12a8 8 0 0 1 13.7-5.7L20 8.5M20 4v4.5h-4.5"/><path d="M20 12a8 8 0 0 1-13.7 5.7L4 15.5M4 20v-4.5h4.5"/>',
    card: '<rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 10.5h18M7 15h3"/>',
    phone: '<rect x="6" y="3" width="12" height="18" rx="2.5"/><path d="M10.5 17.5h3"/>',
    coin: '<circle cx="12" cy="12" r="9"/><path d="M8 8h8M12 8v9M8.5 11.5c1 .6 2.2.9 3.5.9s2.5-.3 3.5-.9"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    send: '<path d="M21 3 10 14M21 3l-7 18-4-7-7-4z"/>',
    box: '<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/>',
    calendar: '<rect x="4" y="5" width="16" height="15" rx="2.5"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  };

  // Значки товаров (залиты серебряным градиентом #gSilver из index.html)
  var GLYPHS = {
    claude: '<path d="M6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 4v-4A2.5 2.5 0 0 1 4 13.5v-8A2.5 2.5 0 0 1 6.5 3z" fill="none" stroke="url(#gSilver)" stroke-width="1.6" stroke-linejoin="round"/>' +
            '<path d="M12 5.8l1 2.7 2.7 1-2.7 1-1 2.7-1-2.7-2.7-1 2.7-1z" fill="url(#gSilver)"/>',
    gemini: '<circle cx="9" cy="12" r="5.5" fill="none" stroke="url(#gSilver)" stroke-width="1.6"/>' +
            '<circle cx="15" cy="12" r="5.5" fill="none" stroke="url(#gSilver)" stroke-width="1.6"/>' +
            '<circle cx="12" cy="12" r="1.3" fill="url(#gSilver)"/>',
    chart: '<path d="M6 6.5v11M12 3.5v13M18 8v12.5" stroke="url(#gSilver)" stroke-width="1.5" stroke-linecap="round"/>' +
           '<rect x="4.5" y="9" width="3" height="5.5" rx=".8" fill="url(#gSilver)"/>' +
           '<rect x="10.5" y="6" width="3" height="7" rx=".8" fill="#0b0c0f" stroke="url(#gSilver)" stroke-width="1.4"/>' +
           '<rect x="16.5" y="11" width="3" height="6.5" rx=".8" fill="url(#gSilver)"/>',
  };

  function icon(name) {
    return '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
  }
  function emblem(p, size) {
    return '<div class="emblem ' + (size || '') + '"><div class="emblem-core">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true">' + (GLYPHS[p.glyph] || GLYPHS.claude) + '</svg></div></div>';
  }
  function emblemIcon(name) {
    return '<div class="emblem"><div class="emblem-core">' + icon(name) + '</div></div>';
  }
  function priceHtml(p) {
    return p.price == null
      ? '<div class="price price-tbd">Цена уточняется</div>'
      : '<div class="price">' + money(p.price) + '</div>';
  }
  function closeBtn() {
    return '<button class="icon-btn" data-action="close-sheet" aria-label="Закрыть">' + icon('close') + '</button>';
  }

  /* =========================================================
     6. ОТРИСОВКА
     ========================================================= */
  function renderProducts(animate) {
    $('#chips').innerHTML = CATEGORIES.map(function (c) {
      return '<button class="chip' + (state.filter === c.id ? ' active' : '') + '" role="tab" aria-selected="' + (state.filter === c.id) +
        '" data-action="filter" data-cat="' + c.id + '">' + esc(c.title) + '</button>';
    }).join('');

    var list = PRODUCTS.filter(function (p) { return state.filter === 'all' || p.cat === state.filter; });
    $('#products').innerHTML = list.length
      ? list.map(function (p, i) { return productCard(p, i, animate); }).join('')
      : '<div class="card empty compact">' + emblemIcon('box') + '<p>В этой категории пока нет товаров</p></div>';
  }

  function productCard(p, i, animate) {
    var line = cartLine(p.id);
    var actions = p.price == null
      ? '<button class="btn btn-primary" data-action="request" data-id="' + p.id + '">Узнать цену</button>'
      : '<button class="btn btn-ghost btn-icon' + (line ? ' in-cart' : '') + '" data-action="add" data-id="' + p.id + '" aria-label="Добавить в корзину">' +
          icon(line ? 'check' : 'bagPlus') + (line ? '<i class="mini-count">' + line.qty + '</i>' : '') + '</button>' +
        '<button class="btn btn-primary" data-action="buy" data-id="' + p.id + '">Купить</button>';

    return '<article class="card product' + (animate ? ' rise' : '') + '" data-action="open-product" data-id="' + p.id + '"' +
      (animate ? ' style="animation-delay:' + i * 70 + 'ms"' : '') + '>' +
      '<div class="product-top">' + emblem(p) +
        '<div class="product-meta">' +
          '<div class="product-title-row"><h3>' + esc(p.title) + '</h3>' + (p.tag ? '<span class="tag">' + esc(p.tag) + '</span>' : '') + '</div>' +
          '<div class="product-period">' + icon('clock') + esc(p.period) + '</div>' +
        '</div>' +
      '</div>' +
      '<p class="product-desc">' + esc(p.short) + '</p>' +
      '<div class="product-bottom">' + priceHtml(p) + '<div class="product-actions">' + actions + '</div></div>' +
    '</article>';
  }

  function renderCart() {
    var el = $('#view-cart');
    var count = cartCount();
    if (!count) {
      el.innerHTML =
        '<div class="view-head"><h2 class="h2">Корзина</h2></div>' +
        '<div class="card empty">' + emblemIcon('bag') +
          '<h3>Корзина пуста</h3><p>Добавьте товары из каталога — они появятся здесь.</p>' +
          '<button class="btn btn-primary" data-action="go" data-tab="home" data-scroll="catalog">Перейти в каталог' + icon('arrow') + '</button>' +
        '</div>';
      return;
    }
    var total = linesTotal(state.cart);
    el.innerHTML =
      '<div class="view-head"><h2 class="h2">Корзина</h2>' +
        '<button class="link-btn" data-action="clear-cart">' + icon('trash') + 'Очистить</button></div>' +
      '<div class="cart-list">' + state.cart.map(cartItemHtml).join('') + '</div>' +
      '<div class="card summary">' +
        '<div class="sum-row"><span>' + count + ' ' + plural(count, ['товар', 'товара', 'товаров']) + '</span><span>' + money(total) + '</span></div>' +
        '<div class="sum-row"><span>Промокод</span><span>при оформлении</span></div>' +
        '<div class="sum-row total"><span>Итого</span><strong>' + money(total) + '</strong></div>' +
      '</div>' +
      '<div class="checkout-bar"><button class="btn btn-primary btn-block shine" data-action="checkout">Оформить заказ · ' + money(total) + '</button></div>';
  }

  function cartItemHtml(line) {
    var p = byId(line.id);
    return '<div class="card cart-item">' + emblem(p, 'sm') +
      '<div class="ci-info"><div class="ci-title">' + esc(p.title) + '</div>' +
        '<div class="ci-sub">' + esc(p.period) + ' · ' + money(p.price) + '</div></div>' +
      '<div class="ci-right"><div class="ci-price">' + money(p.price * line.qty) + '</div>' +
        '<div class="stepper">' +
          '<button data-action="dec" data-id="' + p.id + '" aria-label="' + (line.qty === 1 ? 'Удалить' : 'Уменьшить') + '">' + icon(line.qty === 1 ? 'trash' : 'minus') + '</button>' +
          '<span>' + line.qty + '</span>' +
          '<button data-action="inc" data-id="' + p.id + '" aria-label="Увеличить"' + (line.qty >= CONFIG.maxQty ? ' disabled' : '') + '>' + icon('plus') + '</button>' +
        '</div></div>' +
    '</div>';
  }

  function avatarHtml(extra) {
    var cls = 'avatar' + (extra ? ' ' + extra : '');
    if (!tgUser) return '<span class="' + cls + '">' + icon('user') + '</span>';
    var first = Array.from(tgUser.first_name || '')[0] || '';
    var last = Array.from(tgUser.last_name || '')[0] || '';
    var photo = typeof tgUser.photo_url === 'string' && /^https:\/\//.test(tgUser.photo_url) ? tgUser.photo_url : '';
    return '<span class="' + cls + '"><b>' + esc((first + last).toUpperCase() || '★') + '</b>' +
      (photo ? '<img src="' + esc(photo) + '" alt="" referrerpolicy="no-referrer" onerror="this.remove()">' : '') + '</span>';
  }

  function renderProfile() {
    var u = tgUser;
    var name = u ? [u.first_name, u.last_name].filter(Boolean).join(' ') : 'Гость';
    var handle = u ? (u.username ? '@' + u.username : 'Telegram-пользователь') : 'Вы открыли магазин вне Telegram';
    var paid = state.orders.filter(function (o) { return o.type === 'order'; });
    var spent = paid.reduce(function (s, o) { return s + (o.total || 0); }, 0);
    var inCart = cartCount();

    var html =
      '<div class="view-head"><h2 class="h2">Профиль</h2></div>' +
      '<div class="card profile-card">' + avatarHtml('avatar-lg') +
        '<div class="pf-info"><div class="pf-name">' + esc(name) + (u && u.is_premium ? '<span class="premium">PREMIUM</span>' : '') + '</div>' +
        '<div class="pf-user">' + esc(handle) + '</div></div>' +
      '</div>';

    if (u) {
      html += '<div class="card pf-id"><span>Telegram ID: <b>' + esc(u.id) + '</b></span>' +
        '<button class="btn btn-ghost" data-action="copy-id">' + icon('copy') + 'Копировать</button></div>';
    } else {
      html += '<div class="note guest-note">' + icon('info') +
        '<span>Откройте магазин через бота @' + esc(CONFIG.botUsername) + ' — тогда здесь появятся ваше имя и фото, а заказы будут храниться в облаке Telegram.</span></div>';
    }

    html +=
      '<div class="stats">' +
        '<div class="card stat"><strong>' + paid.length + '</strong><span>' + plural(paid.length, ['заказ', 'заказа', 'заказов']) + '</span></div>' +
        '<div class="card stat"><strong>' + money(spent) + '</strong><span>потрачено</span></div>' +
        '<div class="card stat"><strong>' + inCart + '</strong><span>в корзине</span></div>' +
      '</div>' +
      '<section class="section"><h2 class="section-title">Мои заказы</h2>' +
        (state.orders.length
          ? '<div class="orders">' + state.orders.map(orderHtml).join('') + '</div>'
          : '<div class="card empty compact">' + emblemIcon('box') + '<h3>Заказов пока нет</h3><p>Оформите демо-заказ — он появится здесь.</p>' +
            '<button class="btn btn-primary" data-action="go" data-tab="home" data-scroll="catalog">В каталог</button></div>') +
      '</section>' +
      '<section class="section"><h2 class="section-title">Настройки</h2><div class="card menu">' +
        menuItem('support', 'chat', 'Поддержка', '@' + CONFIG.supportUsername) +
        menuItem('share', 'share', 'Поделиться магазином') +
        '<label class="menu-item"><span class="mi-ico">' + icon('vibrate') + '</span><span class="mi-label">Вибрация</span>' +
          '<input type="checkbox" class="switch" data-change="haptics"' + (state.settings.haptics ? ' checked' : '') + ' aria-label="Вибрация"></label>' +
        menuItem('about', 'sparkle', 'О магазине') +
        menuItem('reset', 'reset', 'Очистить демо-данные', '', 'danger') +
      '</div></section>' +
      '<p class="footer-note">FYS SHOP · демо-версия 1.0</p>';

    $('#view-profile').innerHTML = html;
  }

  function menuItem(action, ico, label, value, cls) {
    return '<button class="menu-item' + (cls ? ' ' + cls : '') + '" data-action="' + action + '">' +
      '<span class="mi-ico">' + icon(ico) + '</span><span class="mi-label">' + esc(label) + '</span>' +
      (value ? '<span class="mi-value">' + esc(value) + '</span>' : '') + icon('chev').replace('class="ico"', 'class="ico chev"') +
    '</button>';
  }

  function orderHtml(o) {
    var isReq = o.type === 'request';
    var items = (o.items || []).map(function (i) {
      return esc(i.title) + (isReq ? ' · ' + esc(i.period) : (i.qty > 1 ? ' × ' + i.qty : ''));
    }).join(', ');
    return '<div class="card order">' +
      '<div class="order-top"><div><div class="order-id">' + (isReq ? 'Заявка ' : 'Заказ ') + esc(o.id) + '</div>' +
        '<div class="order-date">' + fmtDate(o.ts) + '</div></div>' +
        '<span class="status ' + (isReq ? 'pending' : 'paid') + '">' + (isReq ? 'Ожидает цену' : 'Оплачен · демо') + '</span></div>' +
      '<div class="order-items">' + items + '</div>' +
      (isReq ? '' : '<div class="order-total"><span>' + esc(o.method || '') + '</span><strong>' + money(o.total || 0) + '</strong></div>') +
    '</div>';
  }

  function renderBadge(bump) {
    var n = cartCount();
    var b = $('#cartBadge');
    b.textContent = n > 99 ? '99+' : String(n);
    b.hidden = !n;
    if (bump && n) { b.classList.remove('bump'); void b.offsetWidth; b.classList.add('bump'); }
  }

  function renderAll() {
    renderProducts(false);
    renderCart();
    renderProfile();
    renderBadge();
  }

  /* =========================================================
     7. НАВИГАЦИЯ И НИЖНИЙ ЛИСТ
     ========================================================= */
  function go(tab, scroll) {
    if (['home', 'cart', 'profile'].indexOf(tab) < 0) return;
    if (state.sheet) closeSheet(true);
    var changed = state.tab !== tab;
    state.tab = tab;
    document.querySelectorAll('.view').forEach(function (v) { v.hidden = v.dataset.view !== tab; });
    document.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('active', t.dataset.tab === tab); });
    if (tab === 'cart') renderCart();
    if (tab === 'profile') renderProfile();
    if (scroll === 'catalog') requestAnimationFrame(scrollToCatalog);
    else if (changed) window.scrollTo(0, 0);
    if (changed) haptic('select');
    updateBack();
  }

  function scrollToCatalog() {
    $('#catalog').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  var sheetEl = $('#sheet');
  var backdropEl = $('#backdrop');
  var confirmResolve = null;

  function openSheet(kind, html) {
    state.sheet = kind;
    $('#toast').classList.remove('show');
    $('#sheetBody').innerHTML = html;
    sheetEl.scrollTop = 0;
    sheetEl.classList.add('open');
    backdropEl.classList.add('open');
    document.body.classList.add('sheet-open');
    updateBack();
  }

  function closeSheet(silent) {
    if (!state.sheet) return;
    state.sheet = null;
    state.checkout = null;
    if (confirmResolve) { var r = confirmResolve; confirmResolve = null; r(false); }
    sheetEl.classList.remove('open');
    backdropEl.classList.remove('open');
    document.body.classList.remove('sheet-open');
    if (!silent) haptic('light');
    updateBack();
  }

  // Системная кнопка «Назад» Telegram
  function updateBack() {
    tgTry('6.1', function () {
      if (state.sheet || state.tab !== 'home') tg.BackButton.show();
      else tg.BackButton.hide();
    });
  }
  function onBack() {
    if (state.sheet) closeSheet();
    else go('home');
  }

  var toastTimer;
  function toast(msg, action) {
    var el = $('#toast');
    el.innerHTML = '<span>' + esc(msg) + '</span>' +
      (action ? '<button data-action="go" data-tab="' + action.tab + '">' + esc(action.label) + '</button>' : '');
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2400);
  }

  function confirmDialog(title, message, okText) {
    return new Promise(function (resolve) {
      if (can('6.2')) {
        try { tg.showConfirm(message, function (ok) { resolve(!!ok); }); return; } catch (e) { /* свой диалог */ }
      }
      openSheet('confirm',
        '<div class="confirm"><h3>' + esc(title) + '</h3><p>' + esc(message) + '</p>' +
        '<div class="confirm-actions"><button class="btn btn-ghost" data-action="confirm-no">Отмена</button>' +
        '<button class="btn btn-primary" data-action="confirm-yes">' + esc(okText || 'Да') + '</button></div></div>');
      confirmResolve = resolve;
    });
  }

  /* =========================================================
     8. КОРЗИНА
     ========================================================= */
  function addToCart(id, srcBtn) {
    var p = byId(id);
    if (!p || p.price == null) return;
    var line = cartLine(id);
    if (line && line.qty >= CONFIG.maxQty) { toast('Максимум ' + CONFIG.maxQty + ' шт.'); haptic('warning'); return; }
    if (line) line.qty++;
    else state.cart.push({ id: id, qty: 1 });
    save('cart');
    haptic('medium');
    renderProducts(false);
    renderBadge(true);
    if (srcBtn && srcBtn.closest('#sheet')) srcBtn.textContent = 'Ещё +1';
    toast(p.title + ' — в корзине', { tab: 'cart', label: 'Открыть' });
  }

  function changeQty(id, delta) {
    var line = cartLine(id);
    if (!line) return;
    line.qty = Math.min(CONFIG.maxQty, line.qty + delta);
    if (line.qty <= 0) state.cart = state.cart.filter(function (l) { return l !== line; });
    save('cart');
    haptic(delta > 0 ? 'light' : 'soft');
    renderCart();
    renderBadge();
    renderProducts(false);
  }

  function clearCart() {
    confirmDialog('Очистить корзину?', 'Все товары будут удалены из корзины.', 'Очистить').then(function (ok) {
      if (!ok) return;
      state.cart = [];
      save('cart');
      renderAll();
      haptic('success');
      toast('Корзина очищена');
    });
  }

  /* =========================================================
     9. КАРТОЧКА ТОВАРА, ОФОРМЛЕНИЕ, ЗАЯВКА
     ========================================================= */
  function featuresHtml(p) {
    return '<ul class="features">' + p.features.map(function (f) {
      return '<li>' + icon('check') + '<span>' + esc(f) + '</span></li>';
    }).join('') + '</ul>';
  }

  function productHead(p) {
    return '<div class="pd-head">' + emblem(p, 'lg') + '<div><h3>' + esc(p.title) + '</h3>' +
      '<div class="product-period">' + icon('clock') + esc(p.period) + '</div></div></div>';
  }

  function openProduct(id) {
    var p = byId(id);
    if (!p) return;
    haptic('light');
    var actions = p.price == null
      ? '<button class="btn btn-primary" data-action="request" data-id="' + p.id + '">Узнать цену</button>'
      : '<button class="btn btn-ghost" data-action="add" data-id="' + p.id + '">' + (cartLine(p.id) ? 'Ещё +1' : 'В корзину') + '</button>' +
        '<button class="btn btn-primary" data-action="buy" data-id="' + p.id + '">Купить</button>';
    openSheet('product',
      '<div class="sheet-head"><div class="section-kicker">' + esc(catTitle(p.cat)) + '</div>' + closeBtn() + '</div>' +
      productHead(p) +
      '<p class="pd-text">' + esc(p.text) + '</p>' +
      featuresHtml(p) +
      (p.test ? '<div class="test-note">' + icon('info') + 'Тестовый товар для демонстрации магазина</div>' : '') +
      '<div class="pd-bottom">' + priceHtml(p) + '<div class="product-actions">' + actions + '</div></div>');
  }

  function openCheckout(lines, source) {
    lines = lines.filter(function (l) { var p = byId(l.id); return p && p.price != null; });
    if (!lines.length) return;
    haptic('medium');
    openSheet('checkout', '');
    state.checkout = {
      lines: lines.map(function (l) { return { id: l.id, qty: l.qty }; }),
      source: source, method: 'card', promo: null, discountPct: 0, busy: false,
    };
    $('#sheetBody').innerHTML = checkoutHtml();
  }

  function checkoutTotals() {
    var c = state.checkout;
    var subtotal = linesTotal(c.lines);
    var discount = Math.round(subtotal * c.discountPct / 100);
    return { subtotal: subtotal, discount: discount, total: subtotal - discount };
  }
  function totalHtml(t) { return (t.discount ? '<s>' + money(t.subtotal) + '</s>' : '') + '<strong>' + money(t.total) + '</strong>'; }
  function payLabel(t) { return 'Оплатить ' + money(t.total) + ' · демо'; }

  function optionsHtml(name, items, checkedId) {
    return '<div class="options">' + items.map(function (it) {
      return '<label class="option"><input type="radio" name="' + name + '" value="' + esc(it.id) + '" data-change="' + name + '"' +
        (it.id === checkedId ? ' checked' : '') + '><span class="opt-box">' + icon(it.icon) + '<span>' + esc(it.label) + '</span></span></label>';
    }).join('') + '</div>';
  }

  function checkoutHtml() {
    var c = state.checkout;
    var t = checkoutTotals();
    var contact = tgUser ? (tgUser.username ? '@' + tgUser.username : tgUser.first_name) + ' в Telegram' : 'через Telegram';
    return '<div class="sheet-head"><h3>Оформление</h3>' + closeBtn() + '</div>' +
      '<div class="note">' + icon('info') + '<span>Демо-режим: оплата имитируется, деньги не списываются.</span></div>' +
      '<div class="co-lines">' + c.lines.map(function (l) {
        var p = byId(l.id);
        return '<div class="co-line"><span>' + esc(p.title) + ' <em>· ' + esc(p.period) + (l.qty > 1 ? ' × ' + l.qty : '') + '</em></span><b>' + money(p.price * l.qty) + '</b></div>';
      }).join('') + '</div>' +
      '<div class="field-label">Способ оплаты</div>' + optionsHtml('pay', PAY_METHODS, c.method) +
      '<div class="field-label">Промокод</div>' +
      '<div class="promo-row"><input class="input" id="promoInput" placeholder="Например, FYS10" autocomplete="off" autocapitalize="characters" maxlength="20" enterkeyhint="done">' +
        '<button class="btn btn-ghost" data-action="apply-promo">Применить</button></div>' +
      '<div class="promo-msg" id="promoMsg"></div>' +
      '<div class="field-label">Комментарий</div>' +
      '<textarea class="input" id="coComment" rows="2" maxlength="300" placeholder="Необязательно: email аккаунта или пожелания"></textarea>' +
      '<div class="co-contact">' + icon('send') + '<span>Связь по заказу: ' + esc(contact) + '</span></div>' +
      '<div class="co-total"><span>К оплате</span><div id="coTotal">' + totalHtml(t) + '</div></div>' +
      '<button class="btn btn-primary btn-block shine" data-action="pay" id="payBtn">' + payLabel(t) + '</button>';
  }

  function applyPromo() {
    var c = state.checkout;
    if (!c) return;
    var code = ($('#promoInput').value || '').trim().toUpperCase();
    var msg = $('#promoMsg');
    if (!code) {
      msg.className = 'promo-msg err'; msg.textContent = 'Введите промокод'; haptic('warning'); return;
    }
    if (Object.prototype.hasOwnProperty.call(CONFIG.promoCodes, code)) {
      c.promo = code; c.discountPct = CONFIG.promoCodes[code];
      msg.className = 'promo-msg ok'; msg.textContent = 'Скидка ' + c.discountPct + '% применена';
      haptic('success');
    } else {
      c.promo = null; c.discountPct = 0;
      msg.className = 'promo-msg err'; msg.textContent = 'Промокод не найден';
      haptic('error');
    }
    var t = checkoutTotals();
    $('#coTotal').innerHTML = totalHtml(t);
    $('#payBtn').textContent = payLabel(t);
  }

  function pay() {
    var c = state.checkout;
    if (!c || !c.lines || c.busy) return;
    c.busy = true;
    var btn = $('#payBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Обработка платежа…';
    haptic('medium');
    var comment = ($('#coComment').value || '').trim().slice(0, 300);

    wait(CONFIG.demoPaymentDelay).then(function () {
      if (state.checkout !== c) return; // лист закрыли — «платёж» отменён
      var t = checkoutTotals();
      var method = PAY_METHODS.filter(function (m) { return m.id === c.method; })[0] || PAY_METHODS[0];
      var order = {
        id: newOrderId(), type: 'order', ts: Date.now(),
        items: c.lines.map(function (l) {
          var p = byId(l.id);
          return { id: p.id, title: p.title, period: p.period, qty: l.qty, price: p.price };
        }),
        subtotal: t.subtotal, discount: t.discount, total: t.total,
        promo: c.promo, method: method.full, comment: comment,
      };
      state.orders.unshift(order);
      save('orders');
      if (c.source === 'cart') { state.cart = []; save('cart'); }
      renderAll();
      haptic('success');
      openSheet('success', successHtml(order));
      notifySeller(order);
    });
  }

  function openRequest(id) {
    var p = byId(id);
    if (!p) return;
    haptic('medium');
    var plans = (p.plans || [p.period]).map(function (pl) { return { id: pl, label: pl, icon: 'calendar' }; });
    openSheet('request',
      '<div class="sheet-head"><h3>Запрос цены</h3>' + closeBtn() + '</div>' +
      productHead(p) +
      '<p class="pd-text">' + esc(p.text) + '</p>' +
      featuresHtml(p) +
      '<div class="field-label">Срок подписки</div>' + optionsHtml('plan', plans, plans[0].id) +
      '<div class="field-label">Комментарий</div>' +
      '<textarea class="input" id="reqComment" rows="2" maxlength="300" placeholder="Например: какой рынок торгуете, нужна ли настройка"></textarea>' +
      '<div class="stack"><button class="btn btn-primary btn-block shine" data-action="send-request" id="reqBtn">' + icon('send') + 'Отправить заявку</button></div>');
    state.checkout = { requestId: id, busy: false };
  }

  function sendRequest() {
    var c = state.checkout;
    if (!c || !c.requestId || c.busy) return;
    c.busy = true;
    var btn = $('#reqBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Отправляем…';
    haptic('medium');
    var p = byId(c.requestId);
    var planInput = document.querySelector('input[name="plan"]:checked');
    var plan = planInput ? planInput.value : p.period;
    var comment = ($('#reqComment').value || '').trim().slice(0, 300);

    wait(700).then(function () {
      if (state.checkout !== c) return;
      var order = {
        id: newOrderId(), type: 'request', ts: Date.now(),
        items: [{ id: p.id, title: p.title, period: plan, qty: 1, price: null }],
        total: 0, comment: comment,
      };
      state.orders.unshift(order);
      save('orders');
      renderAll();
      haptic('success');
      openSheet('success', successHtml(order));
      notifySeller(order);
    });
  }

  function successHtml(order) {
    var isReq = order.type === 'request';
    var item = order.items[0];
    return '<div class="success">' +
      '<div class="success-ring"><div>' + icon('check') + '</div></div>' +
      '<h3>' + (isReq ? 'Заявка отправлена' : 'Заказ оформлен') + '</h3>' +
      '<p class="muted">№ ' + esc(order.id) + (isReq ? ' · ' + esc(item.title) : ' · ' + money(order.total)) + '</p>' +
      '<div class="note">' + icon('info') + '<span>' + (isReq
        ? 'Менеджер уточнит цену и свяжется с вами в Telegram. Можно написать ему прямо сейчас.'
        : 'Это демонстрация: деньги не списаны. В рабочей версии здесь будет реальная оплата, а доступ придёт сообщением от бота.') +
      '</span></div>' +
      '<div class="notify-status" id="notifyStatus" data-order="' + esc(order.id) + '"></div>' +
      '<div class="stack">' +
        (isReq
          ? '<button class="btn btn-primary btn-block" data-action="support" data-order="' + esc(order.id) + '" data-plan="' + esc(item.period) + '">' + icon('send') + 'Написать менеджеру</button>'
          : '<button class="btn btn-primary btn-block" data-action="go" data-tab="profile">Мои заказы</button>') +
        '<button class="btn btn-ghost btn-block" data-action="close-sheet">Продолжить покупки</button>' +
      '</div></div>';
  }

  // Необязательное уведомление продавцу через serverless-воркер (CONFIG.orderApiUrl)
  function notifySeller(order) {
    if (!CONFIG.orderApiUrl) return;
    function setStatus(text, cls) {
      var el = $('#notifyStatus');
      if (!el || el.dataset.order !== order.id) return;
      el.className = 'notify-status' + (cls ? ' ' + cls : '');
      el.textContent = text;
    }
    if (!inTg) { setStatus('Уведомление продавцу отправляется только из Telegram'); return; }
    setStatus('Отправляем уведомление продавцу…');
    fetch(CONFIG.orderApiUrl.replace(/\/+$/, '') + '/order', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, // «простой» запрос — без CORS-preflight
      body: JSON.stringify({ initData: tg.initData, order: order }),
    }).then(function (res) {
      setStatus(res.ok ? '✓ Продавец получил уведомление' : 'Не удалось уведомить продавца', res.ok ? 'ok' : 'err');
    }).catch(function () {
      setStatus('Не удалось уведомить продавца', 'err');
    });
  }

  /* =========================================================
     10. ПРОФИЛЬ: поддержка, «поделиться», копирование, сброс
     ========================================================= */
  function openSupport(orderId, plan) {
    var url = 'https://t.me/' + CONFIG.supportUsername;
    if (orderId) {
      var text = 'Здравствуйте! Хочу узнать цену на Trading Indicator' + (plan ? ' (' + plan + ')' : '') + '. Заявка ' + orderId + ', FYS SHOP.';
      url += '?text=' + encodeURIComponent(text);
    }
    openTgLink(url);
  }

  function share() {
    var link = 'https://t.me/' + CONFIG.botUsername + '?startapp';
    var text = 'FYS SHOP — цифровые подписки прямо в Telegram';
    if (inTg) {
      openTgLink('https://t.me/share/url?url=' + encodeURIComponent(link) + '&text=' + encodeURIComponent(text));
    } else if (navigator.share) {
      navigator.share({ title: 'FYS SHOP', text: text, url: link }).catch(function () {});
    } else {
      copyText(link, 'Ссылка на магазин скопирована');
    }
  }

  function copyText(text, okMsg) {
    haptic('light');
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { /* нет доступа */ }
      ta.remove();
      toast(ok ? okMsg : 'Не удалось скопировать');
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { toast(okMsg); }, fallback);
    } else {
      fallback();
    }
  }

  function openAbout() {
    openSheet('about',
      '<div class="sheet-head"><h3>О магазине</h3>' + closeBtn() + '</div>' +
      '<div class="about-brand"><span class="brand-mark">FYS</span><span class="brand-sub">SHOP</span></div>' +
      '<p class="pd-text">Магазин цифровых подписок и инструментов для трейдинга внутри Telegram.</p>' +
      '<ul class="features">' +
        '<li>' + icon('check') + '<span>Работает без сервера: статический сайт + облако Telegram</span></li>' +
        '<li>' + icon('check') + '<span>Корзина и заказы синхронизируются между вашими устройствами</span></li>' +
        '<li>' + icon('check') + '<span>Сейчас включён демо-режим — оплаты не проводятся</span></li>' +
      '</ul>' +
      '<div class="kv"><span>Версия</span><b>1.0 demo</b></div>' +
      '<div class="kv"><span>Платформа</span><b>' + (inTg ? esc(tg.platform) + ' · Bot API ' + esc(tg.version) : 'браузер') + '</b></div>' +
      '<div class="kv"><span>Хранилище</span><b>' + (useCloud ? 'Telegram CloudStorage' : 'localStorage') + '</b></div>');
  }

  function resetData() {
    confirmDialog('Очистить демо-данные?', 'Корзина и история заказов будут удалены.', 'Очистить').then(function (ok) {
      if (!ok) return;
      state.cart = [];
      state.orders = [];
      save('cart');
      save('orders');
      renderAll();
      haptic('success');
      toast('Демо-данные очищены');
    });
  }

  /* =========================================================
     11. ОБРАБОТЧИКИ СОБЫТИЙ (делегирование)
     ========================================================= */
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-action]');
    if (!el || el.disabled) return;
    var id = el.dataset.id;

    switch (el.dataset.action) {
      case 'go':
        if (el.closest('#toast')) $('#toast').classList.remove('show');
        go(el.dataset.tab, el.dataset.scroll);
        break;
      case 'scroll-catalog': haptic('light'); scrollToCatalog(); break;
      case 'filter':
        if (state.filter !== el.dataset.cat) { state.filter = el.dataset.cat; haptic('select'); renderProducts(true); }
        break;
      case 'open-product': openProduct(id); break;
      case 'add': addToCart(id, el); break;
      case 'buy': openCheckout([{ id: id, qty: 1 }], 'direct'); break;
      case 'request': openRequest(id); break;
      case 'inc': changeQty(id, 1); break;
      case 'dec': changeQty(id, -1); break;
      case 'clear-cart': clearCart(); break;
      case 'checkout': openCheckout(state.cart, 'cart'); break;
      case 'apply-promo': applyPromo(); break;
      case 'pay': pay(); break;
      case 'send-request': sendRequest(); break;
      case 'close-sheet': closeSheet(); break;
      case 'confirm-yes':
      case 'confirm-no': {
        var resolve = confirmResolve;
        confirmResolve = null;
        closeSheet(true);
        if (resolve) resolve(el.dataset.action === 'confirm-yes');
        break;
      }
      case 'support': openSupport(el.dataset.order, el.dataset.plan); break;
      case 'share': share(); break;
      case 'copy-id': if (tgUser) copyText(String(tgUser.id), 'ID скопирован'); break;
      case 'about': haptic('light'); openAbout(); break;
      case 'reset': resetData(); break;
    }
  });

  document.addEventListener('change', function (e) {
    var el = e.target;
    var kind = el.dataset && el.dataset.change;
    if (kind === 'pay' && state.checkout) { state.checkout.method = el.value; haptic('select'); }
    if (kind === 'plan') haptic('select');
    if (kind === 'haptics') {
      state.settings.haptics = el.checked;
      save('settings');
      haptic('light');
      toast(el.checked ? 'Вибрация включена' : 'Вибрация выключена');
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && state.sheet) closeSheet();
    if (e.key === 'Enter' && e.target.id === 'promoInput') { e.preventDefault(); applyPromo(); e.target.blur(); }
  });

  /* =========================================================
     12. ЗАПУСК
     ========================================================= */
  document.querySelectorAll('[data-icon]').forEach(function (el) { el.innerHTML = icon(el.dataset.icon); });
  document.querySelectorAll('[data-stat="products"]').forEach(function (el) { el.textContent = PRODUCTS.length; });
  $('#topAvatar').innerHTML = avatarHtml();
  renderProducts(true);
  renderCart();
  renderProfile();
  renderBadge();
  updateBack();
  loadCloud();

  // Диплинки: t.me/FYS_shop_bot?startapp=cart | profile | p_<id товара>
  var startParam = inTg && tg.initDataUnsafe ? tg.initDataUnsafe.start_param : '';
  if (startParam === 'cart' || startParam === 'profile') go(startParam);
  else if (startParam && startParam.indexOf('p_') === 0) openProduct(startParam.slice(2));
})();
