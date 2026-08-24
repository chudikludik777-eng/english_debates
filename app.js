/*
  OXUS DEBATE LEAGUE — configuration
  1. Replace the bot username below with the one created in @BotFather (without @).
  2. Add a server endpoint later to save form data before the user goes to Telegram.
     The endpoint should return JSON: { applicationId: "odl_123" }.
*/
const ODL_CONFIG = {
  botUsername: "chort11111bot",
  registrationEndpoint: "/api/applications",
  instagramUrl: "https://www.instagram.com/oxus.debate",
};

const form = document.querySelector("#application-form");
const errorBox = document.querySelector("#form-error");
const modal = document.querySelector("#success-modal");
const telegramLink = document.querySelector("#telegram-link");
const closeModal = document.querySelector(".modal-close");
const instagramLink = document.querySelector("#instagram-link");

instagramLink.href = ODL_CONFIG.instagramUrl;

function buildTelegramUrl(applicationId = "website") {
  const bot = ODL_CONFIG.botUsername.trim().replace(/^@/, "");
  if (!bot || bot === "YOUR_ODL_BOT") return "https://t.me/BotFather";
  return `https://t.me/${encodeURIComponent(bot)}?start=odl_${encodeURIComponent(applicationId)}`;
}

function openSuccessModal(url) {
  telegramLink.href = url;
  modal.classList.add("active");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
}

function hideSuccessModal() {
  modal.classList.remove("active");
  modal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
}

async function saveApplication(data) {
  if (!ODL_CONFIG.registrationEndpoint || window.location.protocol === "file:") {
    // Visual demo mode. For a production launch, provide a secure backend endpoint.
    return { applicationId: `demo_${Date.now().toString(36)}` };
  }

  const response = await fetch(ODL_CONFIG.registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!response.ok) throw new Error("Не удалось сохранить заявку.");
  return response.json();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorBox.textContent = "";

  if (!form.checkValidity()) {
    errorBox.textContent = "Пожалуйста, заполни все обязательные поля.";
    form.reportValidity();
    return;
  }

  const submit = form.querySelector("button[type='submit']");
  const fields = Object.fromEntries(new FormData(form).entries());
  submit.disabled = true;
  submit.innerHTML = "Сохраняем заявку…";

  try {
    const result = await saveApplication(fields);
    openSuccessModal(buildTelegramUrl(result.applicationId));
    form.reset();
  } catch (error) {
    errorBox.textContent = error.message || "Что-то пошло не так. Попробуй ещё раз.";
  } finally {
    submit.disabled = false;
    submit.innerHTML = "Продолжить в Telegram <span>→</span>";
  }
});

closeModal.addEventListener("click", hideSuccessModal);
modal.addEventListener("click", (event) => {
  if (event.target === modal) hideSuccessModal();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideSuccessModal();
});

const observer = new IntersectionObserver(
  (entries) => entries.forEach((entry) => entry.isIntersecting && entry.target.classList.add("visible")),
  { threshold: 0.12 }
);
document.querySelectorAll(".reveal").forEach((element) => observer.observe(element));
