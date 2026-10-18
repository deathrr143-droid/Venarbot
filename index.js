'use strict';

// ===== إجبار الشبكة على استخدام IPv4 =====
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const { Telegraf, Markup } = require('telegraf');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  delay,
} = require('@whiskeysockets/baileys');
const P = require('pino');
const fs = require('fs');
const path = require('path');

// ===== الإعدادات =====
const TELEGRAM_TOKEN = '8923729748:AAFRw3lry-p1K49tyULF-BYjfYeSsv1Qtuo';
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const DATA_FILE = path.join(__dirname, 'data.json');

const WHATSAPP_CHANNEL = 'https://whatsapp.com/channel/0029Vb9Mw8S7z4kp79ri823E';
const TELEGRAM_CHANNEL_LINK = 'https://t.me/+JUFIbGRQUZRlNDY0';

const TG_CHANNEL_ID = '-1004235981181'; 
const FORCE_SUBSCRIBE = true;

// ===== قراءة الصورة =====
const IMAGE_PATH = path.join(__dirname, 'image.jpg');
let IMAGE_BUFFER = null;

if (fs.existsSync(IMAGE_PATH)) {
  try {
    IMAGE_BUFFER = fs.readFileSync(IMAGE_PATH);
  } catch (e) {}
}

// ===== معالجة الأخطاء =====
process.on('uncaughtException', (e) => console.error('\n[خطأ]:', e?.message || e));
process.on('unhandledRejection', (r) => console.error('\n[وعد مرفوض]:', r?.message || r));

// ===== التخزين والجلسات =====
function loadData() { try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); } catch { return {}; } }
function saveData(d) { try { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); } catch {} }
const usersData = loadData();
const sessions = new Map();

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// ===== دالة تعديل الرسالة الحالية =====
async function editMenu(ctx, text, keyboard) {
  const isPhoto = ctx.callbackQuery?.message?.photo != null;
  try {
    if (isPhoto) {
      await ctx.editMessageCaption(text, { caption: text, parse_mode: 'HTML', ...keyboard });
    } else {
      await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
    }
  } catch (e) {}
}

// ===== نصوص القائمة =====
function getWelcomeText(ctx) {
  const id = ctx.from?.id?.toString();
  const s = sessions.get(id);
  const statusIcon = s?.status === 'connected' ? '🟢 Connected' : '🔴 Disconnected';
  return `✨ <b>Welcome to Venar Bot</b> ✨\n\n📊 <b>WhatsApp Status:</b> ${statusIcon}\n\n💡 <i>Explore the features and manage your WhatsApp connection easily through this interactive menu.</i>`;
}

// ===== إرسال رسالة الترحيب فقط (بدون أزرار) =====
async function sendWelcomeText(ctx) {
  const text = getWelcomeText(ctx);
  if (IMAGE_BUFFER) {
    try {
      await Promise.race([
        ctx.replyWithPhoto({ source: IMAGE_BUFFER, filename: 'image.jpg' }, { caption: text, parse_mode: 'HTML' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000))
      ]);
      return;
    } catch (e) {}
  }
  await ctx.reply(text, { parse_mode: 'HTML' }).catch(() => {});
}

// ===== إرسال القائمة (مع الأزرار) =====
async function sendMainMenu(ctx) {
  const text = getWelcomeText(ctx);
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('➕ ربط واتساب', 'menu_link')],
    [Markup.button.callback('🏠 الرئيسية', 'menu_main')],
    [Markup.button.callback('📊 الحالة', 'menu_status'), Markup.button.callback('👥 المتصلون', 'menu_active')],
    [Markup.button.callback('🩺 صحة النظام', 'menu_health'), Markup.button.callback('❓ مساعدة', 'menu_help')],
    [Markup.button.callback('🔌 إلغاء الربط', 'menu_logout')],
    [Markup.button.url('📢 قناة واتساب', WHATSAPP_CHANNEL), Markup.button.url('📢 قناة تليجرام', TELEGRAM_CHANNEL_LINK)]
  ]);

  if (IMAGE_BUFFER) {
    try {
      await Promise.race([
        ctx.replyWithPhoto({ source: IMAGE_BUFFER, filename: 'image.jpg' }, { caption: text, parse_mode: 'HTML', ...keyboard }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000))
      ]);
      return; 
    } catch (err) {}
  }
  await ctx.reply(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
}

// ===== معالجة رسائل الواتساب =====
async function handleWhatsAppMessages(sock, telegramId, { messages, type }) {
  if (type !== 'notify') return;
  const msg = messages[0];
  if (!msg?.message) return;
  
  const remoteJid = msg.key.remoteJid;
  let text = '';
  if (msg.message.conversation) text = msg.message.conversation;
  else if (msg.message.extendedTextMessage) text = msg.message.extendedTextMessage.text || '';
  else if (msg.message.imageMessage) text = msg.message.imageMessage.caption || '';

  if (text) console.log(`\n📩 رسالة واردة: "${text}"`);
  if (!text?.startsWith('.')) return;

  const command = text.slice(1).trim().split(/\s+/)[0].toLowerCase();
  const reply = (t) => sock.sendMessage(remoteJid, { text: t }, { quoted: msg }).catch(() => {});

  if (['menu', 'اوامر'].includes(command)) {
    reply(`✨ *VENAR BOT* ✨\n\n📋 *الأوامر:*\n\n🔗 .link\n📊 .status\n🏓 .ping`);
  } else if (command === 'ping') {
    reply('🏓 Pong!');
  } else if (command === 'status') {
    const u = usersData[telegramId] || {};
    reply(`📊 *الحالة:* متصل ✅\n📞 الرقم: ${u.phone ? '+' + u.phone : 'غير معروف'}`);
  }
}

// ===== واتساب =====
async function connectWhatsApp(telegramId, phoneNumber, bot) {
  const sessionDir = path.join(SESSIONS_DIR, 'user_' + telegramId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  const sock = makeWASocket({
    auth: state,
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,
    browser: Browsers.macOS('Chrome'),
    syncFullHistory: false,
    markOnlineOnConnect: true,
  });

  sessions.set(telegramId, { sock, phone: phoneNumber, status: 'connecting', reconnectAttempts: 0 });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('messages.upsert', (update) => handleWhatsAppMessages(sock, telegramId, update));

  sock.ev.on('connection.update', async (u) => {
    const s = sessions.get(telegramId);
    if (!s) return;

    if (u.qr && !sock.authState.creds.registered && phoneNumber) {
      try {
        await delay(500);
        const code = await sock.requestPairingCode(phoneNumber);
        const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
        await bot.telegram.sendMessage(telegramId, `🔑 <b>كود الربط:</b>\n\n<code>${formatted}</code>`, { parse_mode: 'HTML' }).catch(()=>{});
      } catch (e) {}
    }

    if (u.connection === 'open' && s.status !== 'connected') {
      s.status = 'connected';
      s.reconnectAttempts = 0;
      console.log('\n✅ تم الاتصال بالواتساب بنجاح!');
      usersData[telegramId] = usersData[telegramId] || {};
      usersData[telegramId].phone = phoneNumber;
      usersData[telegramId].registered = true;
      saveData(usersData);
      await bot.telegram.sendMessage(telegramId, `✅ <b>تم ربط واتساب بنجاح!</b>`, { parse_mode: 'HTML' }).catch(() => {});
    }

    if (u.connection === 'close') {
      s.status = 'disconnected';
      console.log('\n⚠️ انقطع الاتصال بالواتساب، جاري إعادة المحاولة...');
      const code = u.lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut || code === 401 || code === 403) {
        sessions.delete(telegramId);
        if (usersData[telegramId]) { usersData[telegramId].registered = false; saveData(usersData); }
        return;
      }
      s.reconnectAttempts++;
      if (s.reconnectAttempts > 10) { sessions.delete(telegramId); return; }
      setTimeout(() => connectWhatsApp(telegramId, phoneNumber, bot).catch(() => {}), 3000);
    }
  });
  return sock;
}

// ===== بوت تيليجرام =====
const bot = new Telegraf(TELEGRAM_TOKEN);

bot.catch((err, ctx) => {
  console.error(`\n[خطأ في البوت]: ${err.message}`);
});

// ===== فحص الاشتراك =====
async function checkSubscription(ctx) {
  if (!FORCE_SUBSCRIBE) return true;
  try {
    const member = await ctx.telegram.getChatMember(TG_CHANNEL_ID, ctx.from.id);
    const isSubscribed = ['creator', 'administrator', 'member'].includes(member.status);
    if (!isSubscribed) console.log(`\n👤 مستخدم غير مشترك حاول الاستخدام: ${ctx.from.id}`);
    return isSubscribed;
  } catch (e) {
    console.error(`\n❌ فشل فحص الاشتراك: ${e.message}`);
    return false;
  }
}

async function sendForceSub(ctx) {
  console.log(`\n🔒 إرسال طلب اشتراك للمستخدم: ${ctx.from.id}`);
  return ctx.reply(
    `⚠️ <b>عذراً عزيزي، يجب عليك الاشتراك في قناة البوت أولاً لتتمكن من الاستخدام.</b>\n\n📢 <b>اشترك في القناة ثم اضغط على زر (تحقق من الاشتراك) 👇</b>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.url('📢 اشترك في القناة الآن', TELEGRAM_CHANNEL_LINK)],
        [Markup.button.callback('✅ تحقق من الاشتراك', 'check_sub')]
      ])
    }
  );
}

// ===== أوامر البدء =====
bot.start(async (ctx) => {
  if (!(await checkSubscription(ctx))) return sendForceSub(ctx);
  return sendWelcomeText(ctx); // يرسل الترحيب فقط بدون قائمة
});

bot.command('menu', async (ctx) => {
  if (!(await checkSubscription(ctx))) return sendForceSub(ctx);
  return sendMainMenu(ctx); // يرسل القائمة عند كتابة /menu فقط
});

// ===== زر التحقق =====
bot.action('check_sub', async (ctx) => {
  const subscribed = await checkSubscription(ctx);
  if (subscribed) {
    await ctx.answerCbQuery('✅ Verified successfully!').catch(() => {});
    await ctx.deleteMessage().catch(() => {});
    return sendWelcomeText(ctx); // يرسل الترحيب فقط بعد التحقق
  } else {
    await ctx.answerCbQuery('❌ You have not subscribed yet, or the bot is not an admin in the channel.', { show_alert: true }).catch(() => {});
  }
});

// ===== الحماية (Middleware) =====
bot.use(async (ctx, next) => {
  if (ctx.callbackQuery?.data === 'check_sub') return next();
  if (ctx.message?.text?.startsWith('/start') || ctx.message?.text?.startsWith('/menu')) return next();
  
  if (!(await checkSubscription(ctx))) return sendForceSub(ctx);
  return next();
});

// ===== أزرار القائمة (تعديل الرسالة الحالية) =====
bot.action('menu_main', async (ctx) => { 
  await ctx.answerCbQuery().catch(() => {}); 
  const text = getWelcomeText(ctx);
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('➕ ربط واتساب', 'menu_link')],
    [Markup.button.callback('🏠 الرئيسية', 'menu_main')],
    [Markup.button.callback('📊 الحالة', 'menu_status'), Markup.button.callback('👥 المتصلون', 'menu_active')],
    [Markup.button.callback('🩺 صحة النظام', 'menu_health'), Markup.button.callback('❓ مساعدة', 'menu_help')],
    [Markup.button.callback('🔌 إلغاء الربط', 'menu_logout')],
    [Markup.button.url('📢 قناة واتساب', WHATSAPP_CHANNEL), Markup.button.url('📢 قناة تليجرام', TELEGRAM_CHANNEL_LINK)]
  ]);
  editMenu(ctx, text, keyboard);
});

bot.action('menu_link', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {}); 
  const text = `📱 <b>الاستخدام:</b>\n<code>/link 967700000000</code>\n\nأدخل الرقم بصيغة دولية بدون +`;
  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🔙 رجوع للقائمة الرئيسية', 'menu_main')]]);
  editMenu(ctx, text, keyboard);
});

bot.action('menu_logout', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {}); 
  const id = ctx.from.id.toString(); const s = sessions.get(id);
  let text = '';
  if (!s) {
    text = '⚠️ لا يوجد حساب مربوط.';
  } else {
    try {
      await s.sock.logout().catch(() => {}); try { s.sock.end(undefined); } catch {}
      sessions.delete(id);
      const dir = path.join(SESSIONS_DIR, 'user_' + id);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      if (usersData[id]) { usersData[id].registered = false; saveData(usersData); }
      text = '🔌 <b>تم إلغاء ربط واتساب بنجاح.</b>';
    } catch { text = '❌ حدث خطأ أثناء إلغاء الربط.'; }
  }
  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🔙 رجوع للقائمة الرئيسية', 'menu_main')]]);
  editMenu(ctx, text, keyboard);
});

bot.action('menu_status', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const id = ctx.from.id.toString(); const s = sessions.get(id); const u = usersData[id] || {};
  const text = `📊 <b>حالة حسابك</b>\n\n📱 واتساب: ${s?.status === 'connected' ? '🟢 متصل' : '🔴 غير متصل'}\n📞 الرقم: ${u.phone ? '+' + u.phone : 'غير مربوط'}`;
  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🔙 رجوع للقائمة الرئيسية', 'menu_main')]]);
  editMenu(ctx, text, keyboard);
});

bot.action('menu_active', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  let n = 0; for (const s of sessions.values()) if (s.status === 'connected') n++;
  const text = `👥 <b>المتصلون حالياً:</b> <code>${n}</code>`;
  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🔙 رجوع للقائمة الرئيسية', 'menu_main')]]);
  editMenu(ctx, text, keyboard);
});

bot.action('menu_health', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const m = process.memoryUsage();
  const text = `🩺 <b>صحة النظام</b>\n\n🧠 الذاكرة: ${(m.heapUsed / 1024 / 1024).toFixed(2)} MB\n⏱️ مدة التشغيل: ${Math.floor(process.uptime())} ثانية`;
  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🔙 رجوع للقائمة الرئيسية', 'menu_main')]]);
  editMenu(ctx, text, keyboard);
});

// ===== قسم المساعدة =====
bot.action('menu_help', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const text = `❓ <b>قائمة المساعدة</b>\n\nاختر الأمر الذي تريد شرحه من الأزرار أدناه 👇`;
  const helpKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔗 شرح الربط', 'help_link'), Markup.button.callback('🔌 شرح إلغاء الربط', 'help_logout')],
    [Markup.button.callback('📊 شرح الحالة', 'help_status'), Markup.button.callback('👥 شرح المتصلين', 'help_active')],
    [Markup.button.callback('🩺 شرح صحة النظام', 'help_health')],
    [Markup.button.callback('🔙 رجوع للقائمة الرئيسية', 'menu_main')]
  ]);
  editMenu(ctx, text, helpKeyboard);
});

bot.action('help_link', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const text = `🔗 <b>شرح أمر الربط:</b>\n\nيقوم هذا الأمر بربط حسابك في واتساب بالبوت.\n\n<b>الطريقة:</b> أرسل <code>/link رقمك</code> مع رمز الدولة بدون +.`;
  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🔙 رجوع للمساعدة', 'menu_help')]]);
  editMenu(ctx, text, keyboard);
});
bot.action('help_logout', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const text = `🔌 <b>شرح إلغاء الربط:</b>\n\nيقوم بفصل جلسة الواتساب الحالية وحذفها من البوت لحماية حسابك.`;
  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🔙 رجوع للمساعدة', 'menu_help')]]);
  editMenu(ctx, text, keyboard);
});
bot.action('help_status', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const text = `📊 <b>شرح الحالة:</b>\n\nيعرض لك حالة الاتصال الحالية وما إذا كان واتساب متصلاً أم لا، مع رقم الهاتف.`;
  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🔙 رجوع للمساعدة', 'menu_help')]]);
  editMenu(ctx, text, keyboard);
});
bot.action('help_active', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const text = `👥 <b>شرح المتصلين:</b>\n\nيعرض عدد الحسابات النشطة والمتصلة بالبوت في الوقت الحالي.`;
  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🔙 رجوع للمساعدة', 'menu_help')]]);
  editMenu(ctx, text, keyboard);
});
bot.action('help_health', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const text = `🩺 <b>شرح صحة النظام:</b>\n\nيعرض لك كمية الذاكرة المستهلكة وكم مضى من الوقت على تشغيل البوت، لمعرفة استقرار السيرفر.`;
  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🔙 رجوع للمساعدة', 'menu_help')]]);
  editMenu(ctx, text, keyboard);
});

// ===== الأوامر النصية =====
bot.command('link', async (ctx) => {
  const p = ctx.message.text.split(' ')[1];
  const phone = p ? p.replace(/[^0-9]/g, '') : '';
  if (!phone) return ctx.reply('📱 <b>الاستخدام:</b>\n<code>/link 967700000000</code>', { parse_mode: 'HTML' });
  const id = ctx.from.id.toString();
  if (sessions.has(id) && sessions.get(id).status === 'connected') return ctx.reply('✅ الحساب مربوط بالفعل.');
  await ctx.reply('⏳ جاري الاتصال...');
  try { await connectWhatsApp(id, phone, bot); } catch (e) { await ctx.reply('❌ فشل الاتصال.'); }
});

bot.command('logout', async (ctx) => {
  const id = ctx.from.id.toString(); const s = sessions.get(id);
  if (!s) return ctx.reply('⚠️ لا يوجد حساب مربوط.');
  try {
    await s.sock.logout().catch(() => {}); try { s.sock.end(undefined); } catch {}
    sessions.delete(id);
    const dir = path.join(SESSIONS_DIR, 'user_' + id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    if (usersData[id]) { usersData[id].registered = false; saveData(usersData); }
    await ctx.reply('🔌 <b>تم إلغاء الربط.</b>', { parse_mode: 'HTML' });
  } catch { await ctx.reply('❌ خطأ.'); }
});

bot.command('status', (ctx) => {
  const id = ctx.from.id.toString(); const s = sessions.get(id); const u = usersData[id] || {};
  const text = `📊 <b>الحالة:</b> ${s?.status === 'connected' ? '🟢 متصل' : '🔴 غير متصل'}\n📞 الرقم: ${u.phone ? '+' + u.phone : 'غير مربوط'}`;
  ctx.reply(text, { parse_mode: 'HTML' });
});

bot.command('active', (ctx) => {
  let n = 0; for (const s of sessions.values()) if (s.status === 'connected') n++;
  ctx.reply(`👥 <b>المتصلون:</b> <code>${n}</code>`, { parse_mode: 'HTML' });
});

bot.command('health', (ctx) => {
  const m = process.memoryUsage();
  ctx.reply(`🩺 <b>صحة النظام</b>\n\n🧠 الذاكرة: ${(m.heapUsed / 1024 / 1024).toFixed(2)} MB\n⏱️ مدة التشغيل: ${Math.floor(process.uptime())} ثانية`, { parse_mode: 'HTML' });
});

// ===== الإقلاع =====
(async () => {
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => {});
    await bot.launch({ dropPendingUpdates: true });
    console.log('\n✅ البوت يعمل الآن بسرعة فائقة! والتصميم الجديد جاهز.');
  } catch (err) {
    console.error('\n❌ فشل التشغيل:', err.message);
    if (err.message.includes('409')) console.log('⚠️ البوت مفتوح في جهاز آخر! يجب إغلاقه.');
  }
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
