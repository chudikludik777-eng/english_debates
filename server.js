/**
 * Oxus Debate League server
 *
 * Serves the website, stores applications and handles the Telegram webhook.
 * It uses only Node.js built-in modules, so `npm install` is not required.
 */
const http = require("node:http");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { mkdir, readFile, writeFile } = require("node:fs/promises");

const ROOT_DIR = __dirname;

// Loads local settings without needing any external package such as dotenv.
function loadEnvironment() {
  try {
    const lines = readFileSync(path.join(ROOT_DIR, ".env"), "utf8").split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const separator = line.indexOf("=");
      if (separator < 1) continue;
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
      if (!process.env[key]) process.env[key] = value;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

loadEnvironment();

const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, "data");
const APPLICATIONS_FILE = path.join(DATA_DIR, "applications.json");
const PORT = Number(process.env.PORT || 4173);
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || "";
const TELEGRAM_ADMIN_USER_IDS = new Set(
  (process.env.TELEGRAM_ADMIN_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";
const TELEGRAM_USE_POLLING = process.env.TELEGRAM_USE_POLLING !== "false";
const TOURNAMENT_START = new Date("2026-11-29T09:00:00.000Z");
let remindersRunning = false;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};
const PUBLIC_FILES = new Set(["index.html", "styles.css", "app.js"]);

async function readApplications() {
  try {
    return JSON.parse(await readFile(APPLICATIONS_FILE, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeApplications(applications) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(APPLICATIONS_FILE, JSON.stringify(applications, null, 2), "utf8");
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function getRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 20_000) reject(new Error("Request body is too large."));
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function validApplication(data) {
  const countries = ["Кыргызстан", "Казахстан", "Узбекистан", "Таджикистан", "Другая страна ЦА"];
  return (
    data &&
    typeof data.name === "string" && data.name.trim().length >= 2 && data.name.trim().length <= 100 &&
    countries.includes(data.country) &&
    Number.isInteger(Number(data.age)) && Number(data.age) >= 12 && Number(data.age) <= 19 &&
    typeof data.school === "string" && data.school.trim().length >= 2 && data.school.trim().length <= 160 &&
    typeof data.team === "string" && data.team.length <= 100 && data.consent === "on"
  );
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function telegram(method, payload) {
  if (!TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is missing.");
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!result.ok) throw new Error(result.description || "Telegram API request failed.");
  return result.result;
}

async function sendStartMessage(message, application) {
  await telegram("sendMessage", {
    chat_id: message.chat.id,
    text: "Заявка найдена ✦\n\nОстался один шаг: нажми кнопку ниже и поделись контактом. Telegram передаст его прямо из твоего аккаунта — так организаторы смогут быть уверены, что заявка настоящая.",
    reply_markup: {
      keyboard: [[{ text: "📱 Поделиться контактом", request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  });
}

function organiserCard(application) {
  const user = application.telegram;
  const profile = `<a href="tg://user?id=${user.userId}">${escapeHtml(user.displayName)}</a>`;
  return [
    "<b>✦ NEW ODL APPLICATION</b>",
    "",
    `<b>Участник:</b> ${escapeHtml(application.name)}`,
    `<b>Telegram:</b> ${profile}`,
    `<b>Контакт:</b> ${escapeHtml(application.phone)}`,
    `<b>Страна:</b> ${escapeHtml(application.country)}`,
    `<b>Возраст:</b> ${escapeHtml(application.age)}`,
    `<b>Школа / город:</b> ${escapeHtml(application.school)}`,
    `<b>Команда:</b> ${escapeHtml(application.team)}`,
    "",
    `<code>${escapeHtml(application.id)}</code>`,
  ].join("\n");
}

function organiserActions(applicationId) {
  return {
    inline_keyboard: [[
      { text: "Принять заявку", callback_data: `accept_application:${applicationId}` },
      { text: "Отклонить заявку", callback_data: `reject_application:${applicationId}` },
    ]],
  };
}

async function notifyOrganisers(application) {
  if (!TELEGRAM_ADMIN_CHAT_ID) {
    console.warn("Application confirmed, but TELEGRAM_ADMIN_CHAT_ID is not set.");
    return false;
  }
  try {
    await telegram("sendMessage", {
      chat_id: TELEGRAM_ADMIN_CHAT_ID,
      text: organiserCard(application),
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: organiserActions(application.id),
    });
    return true;
  } catch (error) {
    // A wrong group ID must not prevent the participant from receiving confirmation.
    console.error("Could not notify organisers:", error.message);
    return false;
  }
}

async function notifyPendingApplications() {
  const applications = await readApplications();
  let changed = false;

  for (const application of applications) {
    if (application.status !== "confirmed" || application.organiserNotified === true) continue;
    application.organiserNotified = await notifyOrganisers(application);
    changed = true;
  }

  if (changed) await writeApplications(applications);
}

async function sendParticipantMenu(chatId, text = "Выбери нужный раздел:") {
  await telegram("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Моя заявка", callback_data: "application" },
          { text: "Правила", callback_data: "rules" },
        ],
        [
          { text: "Расписание", callback_data: "schedule" },
          { text: "Помощь", callback_data: "help" },
        ],
      ],
    },
  });
}

async function sendAdminMenu(chatId) {
  await telegram("sendMessage", {
    chat_id: chatId,
    text: "Панель организатора",
    reply_markup: {
      inline_keyboard: [[{ text: "Заявки и статистика", callback_data: "admin_applications" }]],
    },
  });
}

async function handleAdminMenu(callbackQuery) {
  if (callbackQuery.data !== "admin_applications") return false;
  if (!TELEGRAM_ADMIN_USER_IDS.has(String(callbackQuery.from.id))) {
    await telegram("answerCallbackQuery", { callback_query_id: callbackQuery.id, text: "Нет доступа" });
    return true;
  }

  await telegram("answerCallbackQuery", { callback_query_id: callbackQuery.id });
  const applications = await readApplications();
  const counts = applications.reduce((result, application) => {
    result[application.status] = (result[application.status] || 0) + 1;
    return result;
  }, {});
  const rows = applications.slice(-20).reverse().map((application) =>
    `${application.name} — ${application.status}${application.team === "Нет, ищу команду" ? " — без команды" : ""}`
  );
  await telegram("sendMessage", {
    chat_id: callbackQuery.message.chat.id,
    text: [
      "АДМИН-ПАНЕЛЬ",
      "",
      `Всего заявок: ${applications.length}`,
      `Подтверждены: ${counts.confirmed || 0}`,
      `Приняты: ${counts.accepted || 0}`,
      `Без команды: ${applications.filter((application) => application.team === "Нет, ищу команду").length}`,
      "",
      rows.length ? rows.join("\n") : "Заявок пока нет.",
    ].join("\n"),
  });
  return true;
}

async function handleParticipantMenu(callbackQuery) {
  const chatId = callbackQuery.message?.chat.id;
  if (!chatId) return;

  await telegram("answerCallbackQuery", { callback_query_id: callbackQuery.id });
  const applications = await readApplications();
  let text;

  if (callbackQuery.data === "application") {
    const application = [...applications].reverse().find(
      (item) => item.telegram?.userId === callbackQuery.from.id
    );
    text = application
      ? [
          "МОЯ ЗАЯВКА",
          "",
          `Имя: ${application.name}`,
          `Школа: ${application.school}`,
          `Команда: ${application.team}`,
          `Статус: ${application.status}`,
          "Дата турнира: 29 ноября 2026 года",
        ].join("\n")
      : "Заявка не найдена. Сначала подай заявку на сайте ODL.";
  } else if (callbackQuery.data === "rules") {
    text = [
      "ПРАВИЛА ИНФОРМАЦИЯ О ТУРНИРЕ",
      "",
      "Турнир проходит онлайн на английском языке.",
      "Дата: 29 ноября 2026 года.",
      "Начало: 15:00 по Бишкеку.",
      "Длительность: 4 часа или больше.",
      "Участие бесплатное.",
      "Участник должен соблюдать уважительное поведение и указания организаторов.",
    ].join("\n");
  } else if (callbackQuery.data === "schedule") {
    text = [
      "РАСПИСАНИЕ",
      "",
      "29 ноября 2026 года",
      "Начало: 15:00 по Бишкеку",
      "Платформа: Google Meet",
      "Длительность: 4 часа или больше",
      "Подробное расписание раундов будет опубликовано позже.",
    ].join("\n");
  } else if (callbackQuery.data === "help") {
    text = "По вопросам напиши организатору: @ilnmh";
  } else {
    return;
  }

  await sendParticipantMenu(chatId, text);
}

async function handleOrganiserDecision(callbackQuery) {
  const match = callbackQuery.data?.match(/^(accept|reject)_application:([a-zA-Z0-9-]+)$/);
  if (!match) return false;

  await telegram("answerCallbackQuery", { callback_query_id: callbackQuery.id });
  if (!TELEGRAM_ADMIN_USER_IDS.has(String(callbackQuery.from.id))) {
    await telegram("sendMessage", {
      chat_id: callbackQuery.message.chat.id,
      text: "У тебя нет доступа к управлению заявками.",
    });
    return true;
  }

  const applications = await readApplications();
  const application = applications.find((item) => item.id === match[2]);
  if (!application) {
    await telegram("sendMessage", { chat_id: callbackQuery.message.chat.id, text: "Заявка не найдена." });
    return true;
  }

  if (application.status !== "confirmed") {
    await telegram("sendMessage", {
      chat_id: callbackQuery.message.chat.id,
      text: `Заявка уже обработана. Текущий статус: ${application.status}`,
    });
    return true;
  }

  const accepted = match[1] === "accept";
  application.status = accepted ? "accepted" : "rejected";
  application.reviewedAt = new Date().toISOString();
  application.reviewedBy = callbackQuery.from.id;
  await writeApplications(applications);

  await telegram("editMessageReplyMarkup", {
    chat_id: callbackQuery.message.chat.id,
    message_id: callbackQuery.message.message_id,
    reply_markup: { inline_keyboard: [] },
  });
  await telegram("sendMessage", {
    chat_id: application.telegram.userId,
    text: accepted
      ? "Твоя заявка принята! Мы пришлём расписание и ссылку на Google Meet в Telegram."
      : "Твоя заявка отклонена. Если хочешь уточнить причину, напиши организатору: @ilnmh",
  });
  await telegram("sendMessage", {
    chat_id: callbackQuery.message.chat.id,
    text: `Готово: заявка ${accepted ? "принята" : "отклонена"}.`,
  });
  return true;
}

async function handleTelegramUpdate(update) {
  if (update.callback_query) {
    if (await handleAdminMenu(update.callback_query)) return;
    if (await handleOrganiserDecision(update.callback_query)) return;
    await handleParticipantMenu(update.callback_query);
    return;
  }

  const message = update.message;
  if (!message || !message.from) return;

  const text = message.text || "";
  if (/^\/id(?:@\w+)?$/.test(text)) {
    await telegram("sendMessage", {
      chat_id: message.chat.id,
      text: `ID этого чата: ${message.chat.id}`,
    });
    return;
  }

  if (message.chat?.type !== "private") return;

  const applications = await readApplications();
  const startMatch = text.match(/^\/start(?:@\w+)?\s+odl_([a-zA-Z0-9-]+)$/);

  if (startMatch) {
    const application = applications.find((item) => item.id === startMatch[1]);
    if (!application) {
      await telegram("sendMessage", { chat_id: message.chat.id, text: "Не нашёл эту заявку. Вернись на сайт ODL и отправь форму ещё раз." });
      return;
    }
    application.status = "awaiting_contact";
    application.telegram = {
      userId: message.from.id,
      username: message.from.username || "",
      displayName: [message.from.first_name, message.from.last_name].filter(Boolean).join(" ") || "Telegram user",
    };
    application.updatedAt = new Date().toISOString();
    await writeApplications(applications);
    await sendStartMessage(message, application);
    return;
  }

  // Lets someone recover the contact button if they opened the bot before it was online.
  if (/^\/start(?:@\w+)?$/.test(text)) {
    const pendingApplication = applications.find(
      (item) => item.status === "awaiting_contact" && item.telegram?.userId === message.from.id
    );
    if (pendingApplication) {
      await sendStartMessage(message, pendingApplication);
    } else {
      const confirmedApplication = applications.find(
        (item) => item.status === "confirmed" && item.telegram?.userId === message.from.id
      );
      if (confirmedApplication) {
        await sendParticipantMenu(message.chat.id);
      } else {
        await telegram("sendMessage", {
          chat_id: message.chat.id,
          text: "Чтобы начать регистрацию, вернись на сайт Oxus Debate League и нажми «Продолжить в Telegram» после заполнения формы.",
        });
      }
      if (TELEGRAM_ADMIN_USER_IDS.has(String(message.from.id))) {
        await sendAdminMenu(message.chat.id);
      }
    }
    return;
  }

  if (message.contact) {
    const application = applications.find(
      (item) => item.status === "awaiting_contact" && item.telegram?.userId === message.from.id
    );
    if (!application) {
      await telegram("sendMessage", { chat_id: message.chat.id, text: "Сначала открой ссылку из формы регистрации на сайте ODL." });
      return;
    }
    if (message.contact.user_id !== message.from.id) {
      await telegram("sendMessage", { chat_id: message.chat.id, text: "Пожалуйста, отправь контакт именно из своего Telegram-аккаунта." });
      return;
    }
    application.phone = message.contact.phone_number;
    application.status = "confirmed";
    application.confirmedAt = new Date().toISOString();
    await writeApplications(applications);
    application.organiserNotified = await notifyOrganisers(application);
    await writeApplications(applications);
    await telegram("sendMessage", {
      chat_id: message.chat.id,
      text: "Готово — твоя заявка подтверждена! ✦\n\nМы пришлём расписание, правила и все новости прямо сюда. До встречи на Oxus Debate League.",
      reply_markup: { remove_keyboard: true },
    });
    await sendParticipantMenu(message.chat.id);
    if (TELEGRAM_ADMIN_USER_IDS.has(String(message.from.id))) {
      await sendAdminMenu(message.chat.id);
    }
  }
}

async function sendScheduledReminders() {
  if (remindersRunning) return;
  const now = Date.now();
  const reminders = [
    { key: "reminder7Sent", at: TOURNAMENT_START.getTime() - 7 * 24 * 60 * 60 * 1000, text: "Напоминание: турнир начнётся через 7 дней — 29 ноября в 15:00 по Бишкеку." },
    { key: "reminder3Sent", at: TOURNAMENT_START.getTime() - 3 * 24 * 60 * 60 * 1000, text: "Напоминание: турнир начнётся через 3 дня — 29 ноября в 15:00 по Бишкеку." },
  ];
  remindersRunning = true;
  try {
    const applications = await readApplications();
    const due = reminders.find((reminder) =>
      now >= reminder.at && now < TOURNAMENT_START.getTime() &&
      applications.some((application) =>
        application.telegram?.userId &&
        ["confirmed", "accepted"].includes(application.status) &&
        !application[reminder.key]
      )
    );
    if (!due) return;

    for (const application of applications) {
      if (
        !application.telegram?.userId ||
        !["confirmed", "accepted"].includes(application.status) ||
        application[due.key]
      ) continue;
      try {
        await telegram("sendMessage", { chat_id: application.telegram.userId, text: due.text });
        application[due.key] = true;
      } catch (error) {
        console.error(`Could not send ${due.key} to ${application.id}:`, error.message);
      }
    }
    await writeApplications(applications);
  } finally {
    remindersRunning = false;
  }
}

async function startTelegramPolling() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_USE_POLLING) return;

  let offset = 0;
  try {
    // Polling makes the bot work immediately on a laptop — no public HTTPS URL required.
    await telegram("deleteWebhook", { drop_pending_updates: false });
    console.log("Telegram bot connected in local polling mode.");
    if (TELEGRAM_ADMIN_CHAT_ID) {
      try {
        const chat = await telegram("getChat", { chat_id: TELEGRAM_ADMIN_CHAT_ID });
        console.log(`Telegram organiser chat found: ${chat.title || chat.username || chat.id}`);
        await notifyPendingApplications();
      } catch (error) {
        console.error(`Telegram organiser chat is unavailable (${TELEGRAM_ADMIN_CHAT_ID}): ${error.message}`);
      }
    }
  } catch (error) {
    console.error("Could not connect Telegram bot:", error.message);
  }

  while (true) {
    try {
      const updates = await telegram("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message", "callback_query"],
      });
      for (const update of updates) {
        offset = update.update_id + 1;
        await handleTelegramUpdate(update);
      }
    } catch (error) {
      console.error("Telegram polling error. Retrying in 5 seconds:", error.message);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

async function serveStatic(response, pathname) {
  const relativePath = pathname === "/" ? "index.html" : path.basename(pathname);
  const filePath = path.join(ROOT_DIR, relativePath);
  try {
    const extension = path.extname(filePath);
    if (!PUBLIC_FILES.has(relativePath) || !MIME_TYPES[extension]) throw new Error("Not found");
    const file = await readFile(filePath);
    response.writeHead(200, { "Content-Type": MIME_TYPES[extension] });
    response.end(file);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  try {
    if (request.method === "POST" && url.pathname === "/api/applications") {
      const data = JSON.parse(await getRequestBody(request));
      if (!validApplication(data)) {
        sendJson(response, 400, { error: "Проверьте заполненные поля." });
        return;
      }
      const applications = await readApplications();
      const application = {
        id: randomUUID().replaceAll("-", ""),
        name: data.name.trim(), country: data.country, age: Number(data.age), school: data.school.trim(), team: data.team,
        status: "created", createdAt: new Date().toISOString(),
      };
      applications.push(application);
      await writeApplications(applications);
      sendJson(response, 201, { applicationId: application.id });
      return;
    }

    if (request.method === "POST" && url.pathname === "/telegram-webhook") {
      const secret = request.headers["x-telegram-bot-api-secret-token"];
      if (TELEGRAM_WEBHOOK_SECRET && secret !== TELEGRAM_WEBHOOK_SECRET) {
        sendJson(response, 401, { error: "Unauthorized" });
        return;
      }
      if (!TELEGRAM_BOT_TOKEN) {
        sendJson(response, 500, { error: "Telegram bot is not configured." });
        return;
      }
      const update = JSON.parse(await getRequestBody(request));
      await handleTelegramUpdate(update);
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET") {
      await serveStatic(response, url.pathname);
      return;
    }
    sendJson(response, 405, { error: "Method not allowed" });
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: "Internal server error" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Oxus Debate League is running at http://localhost:${PORT}`);
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_USE_POLLING) {
    startTelegramPolling();
    setInterval(() => {
      sendScheduledReminders().catch((error) => console.error("Reminder scheduler error:", error.message));
    }, 60_000);
  } else if (!TELEGRAM_BOT_TOKEN) {
    console.warn("Telegram bot is not configured. Add TELEGRAM_BOT_TOKEN to .env.");
  }
});
