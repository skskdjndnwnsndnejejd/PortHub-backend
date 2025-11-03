const tg = window.Telegram.WebApp;
tg.expand();

const tabs = document.querySelectorAll('.bottom-bar button');
const tabViews = document.querySelectorAll('.tab');
const balanceEl = document.getElementById('balance');
const addLotBtn = document.getElementById('add-lot');
const modal = document.getElementById('create-modal');
const cancelBtn = document.getElementById('cancel-btn');
const createBtn = document.getElementById('create-btn');

tabs.forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.getAttribute('data-tab');
    tabViews.forEach(t => t.classList.remove('active'));
    document.getElementById(tab).classList.add('active');
  });
});

addLotBtn.addEventListener('click', () => modal.classList.remove('hidden'));
cancelBtn.addEventListener('click', () => modal.classList.add('hidden'));

createBtn.addEventListener('click', async () => {
  const type = document.getElementById('item-type').value;
  const title = document.getElementById('title').value;
  const image = document.getElementById('image').value;
  const price = parseFloat(document.getElementById('price').value);

  if (!price || !title) {
    alert("Введите все поля!");
    return;
  }

  const user = tg.initDataUnsafe.user;
  const tg_id = user?.id;

  const resp = await fetch("/create_lot", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ tg_id, type, title, image_url: image, price })
  });

  const data = await resp.json();
  if (data.success) {
    alert("✅ Лот создан!");
    modal.classList.add('hidden');
  } else {
    alert("Ошибка: " + (data.error || "неизвестная"));
  }
});

// можно добавить автообновление баланса из API
async function loadBalance() {
  const user = tg.initDataUnsafe.user;
  if (!user) return;
  const res = await fetch(`/balance/${user.id}`);
  if (res.ok) {
    const data = await res.json();
    balanceEl.textContent = `${Number(data.balance || 0).toFixed(2)} TON+`;
  }
}

loadBalance();
