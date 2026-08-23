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

const DATA_DIR = path.join(ROOT_DIR, "data");
const APPLICATIONS_FILE = path.join(DATA_DIR, "applications.json");
const PORT = Number(process.env.PORT || 4173);
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || "";
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";
const TELEGRAM_USE_POLLING = process.env.TELEGRAM_USE_POLLING !== "false";

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

async function handleTelegramUpdate(update) {
  const message = update.message;
  if (!message || !message.from || message.chat?.type !== "private") return;

  const applications = await readApplications();
  const text = message.text || "";
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
      await telegram("sendMessage", {
        chat_id: message.chat.id,
        text: "Чтобы начать регистрацию, вернись на сайт Oxus Debate League и нажми «Продолжить в Telegram» после заполнения формы.",
      });
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
        allowed_updates: ["message"],
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
  } else if (!TELEGRAM_BOT_TOKEN) {
    console.warn("Telegram bot is not configured. Add TELEGRAM_BOT_TOKEN to .env.");
  }
});
