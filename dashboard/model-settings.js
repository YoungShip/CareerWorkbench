'use strict';
(() => {
  const $ = (id) => document.getElementById(id),
    dialog = $('model-settings-dialog');
  let settings = null,
    drafts = {},
    provider = '',
    busy = false;
  function message(text, error = false) {
    $('model-settings-status').textContent = text;
    $('model-settings-status').classList.toggle('error', error);
  }
  function setBusy(value) {
    busy = value;
    $('model-settings-fields').disabled = value || !settings;
    for (const id of ['model-settings-save', 'model-settings-test'])
      $(id).disabled = value || !settings;
    dialog.querySelectorAll('[data-model-close]').forEach((button) => {
      button.disabled = value;
    });
  }
  function remember() {
    if (provider)
      drafts[provider] = {
        base_url: $('model-base-url').value,
        model: $('model-id').value,
        api_key: $('model-api-key').value,
      };
  }
  function displayProvider() {
    provider = $('model-provider').value;
    const item = settings.providers[provider],
      draft = drafts[provider];
    $('model-base-url').value = draft.base_url;
    $('model-id').value = draft.model;
    $('model-api-key').value = draft.api_key;
    $('model-api-key').placeholder = item.has_api_key ? '已保存；留空保留原密钥' : '填写 API 密钥';
    $('model-key-status').textContent =
      item.key_source === 'environment'
        ? '当前使用环境变量 ' + item.key_env + '，它会优先于这里保存的密钥。'
        : item.has_api_key
          ? '密钥已保存在本机，留空即可保留；填写新值会替换。'
          : '尚未保存密钥。';
  }
  function display(result) {
    settings = result;
    drafts = Object.fromEntries(
      Object.entries(result.providers).map(([name, item]) => [
        name,
        {
          base_url: item.base_url,
          model: item.model,
          api_key: '',
        },
      ])
    );
    $('model-provider').value = result.active;
    displayProvider();
  }
  async function request(route, payload) {
    const response = await fetch(route, {
      cache: 'no-store',
      ...(payload
        ? {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }
        : {}),
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || '操作失败，请稍后重试。');
    return result;
  }
  $('model-settings-open').onclick = async () => {
    dialog.showModal();
    settings = null;
    setBusy(true);
    message('正在读取模型配置…');
    try {
      display(await request('/api/model-settings'));
      message('修改后点击保存；测试连接可先验证当前填写的配置。');
    } catch (error) {
      message('读取失败：' + error.message, true);
    } finally {
      setBusy(false);
    }
  };
  $('model-provider').onchange = () => {
    remember();
    displayProvider();
    message('保存后将使用所选服务。');
  };
  async function action(test) {
    if (busy || !settings || !$('model-settings-form').reportValidity()) return;
    remember();
    const payload = { expected_revision: settings.revision, provider, ...drafts[provider] };
    setBusy(true);
    message(test ? '正在测试连接，最多等待 15 秒…' : '正在保存配置…');
    try {
      const result = await request('/api/model-settings' + (test ? '/test' : ''), payload);
      if (test)
        message(
          '连接测试通过，用时 ' + (result.elapsed_ms / 1000).toFixed(1) + ' 秒。测试不会保存修改。'
        );
      else {
        display(result);
        message('配置已保存。新启动的匹配任务将使用此配置。');
      }
    } catch (error) {
      message(error.message, true);
    } finally {
      setBusy(false);
    }
  }
  $('model-settings-form').onsubmit = (event) => {
    event.preventDefault();
    action(false);
  };
  $('model-settings-test').onclick = () => action(true);
  dialog.querySelectorAll('[data-model-close]').forEach((button) => {
    button.onclick = () => dialog.close();
  });
  dialog.addEventListener('cancel', (event) => {
    if (busy) event.preventDefault();
  });
  dialog.addEventListener('close', () => {
    $('model-settings-form').reset();
    settings = null;
    drafts = {};
    provider = '';
  });
})();
