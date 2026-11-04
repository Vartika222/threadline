/** THREADLINE — the page strict focus shows instead of an off-category site. */
const params = new URLSearchParams(location.search);
const blockedUrl = params.get('url');

async function refresh() {
  const { focus } = await chrome.runtime.sendMessage({ type: 'GET_FOCUS' });
  if (!focus) {
    location.replace(blockedUrl);
    return;
  }
  const minutes = Math.max(1, Math.ceil((focus.endsAt - Date.now()) / 60000));
  document.getElementById('heading').textContent = `Back to ${focus.category}`;
  document.getElementById('detail').textContent =
    `${new URL(blockedUrl).hostname} is in ${params.get('category')}. ${minutes} min of focus left.`;
}

document.getElementById('back').onclick = () => chrome.runtime.sendMessage({ type: 'FOCUS_GO_BACK' });
document.getElementById('allow').onclick = async () => {
  await chrome.runtime.sendMessage({ type: 'FOCUS_ALLOW', url: blockedUrl });
  location.replace(blockedUrl);
};
document.getElementById('end').onclick = async () => {
  await chrome.runtime.sendMessage({ type: 'END_FOCUS' });
  location.replace(blockedUrl);
};

refresh();
